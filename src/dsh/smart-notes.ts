/**
 * The maintenance tick that wakes smart notes.
 *
 * A smart note is parked with a declarative condition; this is the code that
 * makes "parked" temporal rather than permanent. It runs on the same maintenance
 * lane as the rest of the adapter (see `maintenance-wiring.ts`) and does three
 * things per due note: evaluate the condition, record the outcome, and surface
 * the note when the condition holds.
 *
 * Design constraints that come from the surrounding system:
 *
 * - **Never throws.** One bad note must not abort the tick: the other due notes
 *   still deserve their check, and a thrown error would also kill whatever else
 *   the maintenance lane was doing. Every failure becomes a recorded result.
 * - **Does not evaluate generated source.** The condition is declarative
 *   (`core/surface-condition.ts`); there is no `eval`, no `new Function`, and no
 *   sandbox VM here. Upstream's QuickJS sandbox exists because it compiles
 *   conditions to JavaScript; this adapter never does, so the sandbox is not
 *   needed.
 * - **Bounds work per tick.** A hundred parked notes must not turn one pass into
 *   a hundred network requests, so the caller supplies a limit and the store
 *   returns notes oldest-deadline-first.
 */
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { AdapterStores, NoteRow } from '../core/stores.ts'
import type { Journal } from '../core/journal.ts'
import {
  evaluateSurfaceCondition,
  nextSurfaceCheckAt,
  parseSurfaceCondition,
  SurfaceConditionError,
  SURFACE_CHECK_INTERVAL_MS,
  SURFACE_CHECK_MAX_FAILURES,
  type SurfaceCheckSeams,
} from '../core/surface-condition.ts'

const execFileAsync = promisify(execFile)

/** Wall-clock cap on one git command; a hung git must not stall the tick. */
const GIT_TIMEOUT_MS = 3_000
/** Wall-clock cap on one HTTP check. */
const HTTP_TIMEOUT_MS = 5_000
/** Largest file a `file-contains` check will read. */
const FILE_LIMIT_BYTES = 64 * 1024

export interface SmartNoteTickDeps {
  readonly stores: AdapterStores
  readonly journal?: Journal
  readonly now?: () => number
  /** Cap on notes checked in one tick (default 5). */
  readonly limit?: number
  /** Override the check seams; tests use this to stay offline. */
  readonly seams?: Partial<SurfaceCheckSeams>
  /** Fetch implementation for HTTP checks; injectable so tests never hit the network. */
  readonly fetchImpl?: typeof fetch
}

export interface SmartNoteTickResult {
  readonly checked: number
  readonly woken: readonly number[]
  readonly failed: readonly number[]
}

/**
 * Refuse obviously unsafe HTTP targets.
 *
 * This is a deliberately small guard, not a substitute for a full SSRF filter:
 * it rejects the schemes and literal private hosts that a note would reach by
 * mistake. Upstream's `ssrf-guard.ts` (735 lines) also resolves DNS and pins the
 * address, which is the right defence against a hostile condition — but this
 * adapter's conditions are written by the agent for its own project, not by a
 * third party, so the threat model is a typo rather than an attacker.
 */
export function isPermittedCheckUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return false
  if (host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.')) return false
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false
  if (host === '169.254.169.254') return false
  if (host.endsWith('.local') || host.endsWith('.internal')) return false
  return true
}

/**
 * Build the real capability seams for a project root.
 *
 * Each capability fails closed: a missing file yields `null` (not a throw), a git
 * command that times out yields `null`, and a refused URL throws inside the
 * evaluator where it becomes a recorded error.
 */
function realSeams(projectRoot: string, fetchImpl: typeof fetch | undefined): SurfaceCheckSeams {
  const doFetch = fetchImpl ?? fetch
  return {
    projectRoot,
    async readFile(absolutePath: string) {
      try {
        const info = await stat(absolutePath)
        // A directory is not a readable file for these checks; treating it as
        // "exists but empty" would make `file-exists(dir)` pass, which is not
        // what the condition means.
        if (!info.isFile()) return null
        return await readFile(absolutePath, 'utf8')
      } catch {
        return null
      }
    },
    async git(args: readonly string[]) {
      try {
        const { stdout } = await execFileAsync('git', [...args], {
          cwd: projectRoot,
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
        })
        return stdout
      } catch {
        return null
      }
    },
    async httpGet(url: string) {
      if (!isPermittedCheckUrl(url)) {
        throw new Error(`refusing to check ${url}: not a permitted http(s) target`)
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
      try {
        const response = await doFetch(url, { signal: controller.signal, redirect: 'follow' })
        const body = await response.text()
        return { status: response.status, body: body.slice(0, FILE_LIMIT_BYTES) }
      } finally {
        clearTimeout(timer)
      }
    },
    fileLimitBytes: FILE_LIMIT_BYTES,
  }
}

/**
 * Check every smart note whose deadline has passed, and wake the ones whose
 * condition now holds.
 *
 * @param deps - stores, journal, clock, and optional seam overrides.
 * @returns which notes were checked, woken, and failed.
 */
export async function runSmartNoteTick(deps: SmartNoteTickDeps): Promise<SmartNoteTickResult> {
  const now = deps.now?.() ?? Date.now()
  const due = deps.stores.listDueSurfaceChecks(now, deps.limit ?? 5)
  const woken: number[] = []
  const failed: number[] = []
  let checked = 0

  for (const note of due) {
    const condition = note.surfaceCondition
    if (condition === undefined) continue
    checked += 1
    const projectRoot = note.projectPath ?? process.cwd()
    const seams: SurfaceCheckSeams = { ...realSeams(projectRoot, deps.fetchImpl), ...deps.seams }

    let result: { met: boolean; error?: string }
    try {
      const parsed = parseSurfaceCondition(condition)
      result = await evaluateSurfaceCondition(parsed, seams)
    } catch (error) {
      // A condition that no longer parses (an older grammar, a hand-edited row)
      // is a stored-data problem: record it as a failure so the counter climbs
      // and the note surfaces with a warning instead of sitting invisible.
      result = {
        met: false,
        error: error instanceof SurfaceConditionError ? error.message : String(error),
      }
    }

    if (result.error !== undefined) {
      failed.push(note.id)
      // Escalate to "ready" only after repeated errors: a single timeout must not
      // surface a note whose evidence was never actually seen.
      const failures = countFailure(note) + 1
      const giveUp = failures >= SURFACE_CHECK_MAX_FAILURES
      deps.stores.recordSurfaceCheck({
        id: note.id,
        met: giveUp,
        failed: true,
        ...giveUp
          ? { reason: `check failed ${String(failures)} times; last error: ${result.error}` }
          : { nextCheckAt: nextSurfaceCheckAt(now, now, SURFACE_CHECK_INTERVAL_MS) },
      }, now)
      deps.journal?.info(
        'historian',
        `smart note #${String(note.id)} check could not run: ${result.error}`,
        { phase: 'smart-note-check', noteId: note.id, failCount: failures, surfaced: giveUp },
        note.sessionId,
      )
      continue
    }

    if (result.met) {
      woken.push(note.id)
      deps.stores.recordSurfaceCheck({
        id: note.id,
        met: true,
        reason: `condition holds: ${condition}`,
      }, now)
      deps.journal?.info(
        'historian',
        `smart note #${String(note.id)} is ready (${condition})`,
        { phase: 'smart-note-check', noteId: note.id, met: true },
        note.sessionId,
      )
    } else {
      deps.stores.recordSurfaceCheck({
        id: note.id,
        met: false,
        nextCheckAt: nextSurfaceCheckAt(now, now, SURFACE_CHECK_INTERVAL_MS),
      }, now)
    }
  }

  return { checked, woken, failed }
}

/** Consecutive failures recorded for a note; absent reads as 0. */
function countFailure(note: NoteRow): number {
  return note.checkFailureCount ?? 0
}
