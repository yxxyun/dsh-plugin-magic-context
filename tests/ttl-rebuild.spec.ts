/**
 * The idle-TTL rebuild (policy.ttlRebuild, restored 2026-11-11 on request).
 *
 * History: 2026-11-10 (`6d9d748`) removed the TTL-triggered execute to follow MC
 * v0.49.44. The original adapter upstream audited that decision against MC
 * v0.49.50 (adapter v0.11.2) and kept its own TTL branch, because the two costs
 * that justified MC's removal do not exist in DSH: there is no signed-thinking
 * prefix to invalidate and no m[0] tier fold to trigger early. What remains is
 * the one thing MC gets from a manual flush command and DSH does not: a free
 * bust — the moment the provider cache is already gone is the cheapest moment to
 * re-render m[0], land queued drops and fold m[1].
 *
 * These cases pin the switch, not the band: the band (`cache-ttl-idle`) exists
 * either way, and only `ttlRebuild` decides whether that pass also folds m[0].
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_POLICY } from '../src/core/policy.ts'
import { openStores, type AdapterStores } from '../src/core/stores.ts'
import type { Journal } from '../src/core/journal.ts'
import { runManagementPass } from '../src/dsh/management-pass.ts'

const T0 = 1_700_000_000_000
const SESSION = 'mc-ttl-rebuild'
const DIGEST = 'digest-1'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
})

function openStore(): AdapterStores {
  const dir = mkdtempSync(join(tmpdir(), 'mc-ttl-'))
  tempDirs.push(dir)
  return openStores(dir)
}

/** A surface with one ordinary user node — the baseline rides it. */
function surfaceSession() {
  const events: Array<Record<string, unknown>> = []
  let nextSeq = 1
  const surface = { nodes: [] as number[], replaceGeneration: 0 }
  const session = {
    snapshotEvents: () => events.slice(),
    surface,
    append: (type: string, data: Record<string, unknown>, options?: Record<string, unknown>) => {
      const seq = nextSeq++
      events.push({ seq, type, data })
      const op = (options as { surfaceOp?: { op: string; startSeq: number; endSeq: number } } | undefined)?.surfaceOp
      if (op?.op === 'replace') {
        surface.nodes = surface.nodes.filter(node => node < op.startSeq || node > op.endSeq)
        surface.replaceGeneration += 1
      }
      surface.nodes.push(seq)
      return { seq }
    },
  }
  // The host types a user turn as 'user/message'; enumerateSurfaceNodes maps
  // that type to the 'user' role, and the baseline rides the first such node.
  session.append('user/message', { turn: 1, message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } })
  return session as unknown as Parameters<typeof runManagementPass>[0]['session']
}

interface Recorded { readonly level: string; readonly kind: string; readonly summary: string; readonly data: unknown }

function recordingJournal(entries: Recorded[]): Journal {
  const record = (level: string) => (kind: string, summary: string, data?: unknown): void => {
    entries.push({ level, kind, summary, data })
  }
  return { info: record('info'), warn: record('warn'), error: record('error') } as unknown as Journal
}

const silentLogger = { info: () => {}, warn: () => {} }

/** A previous baseline at epoch 1 plus one new memory row waiting in m[1]. */
function seedBaseline(stores: AdapterStores): void {
  stores.saveBaselineState({
    sessionId: SESSION,
    epoch: 1,
    frozenAt: T0,
    memoriesDigest: DIGEST,
    updatedAt: T0,
  })
}

function run(stores: AdapterStores, ttlRebuild: boolean, entries: Recorded[], now: number) {
  return runManagementPass({
    session: surfaceSession(),
    sessionId: SESSION,
    stores,
    policy: { ...DEFAULT_POLICY, ttlRebuild },
    logger: silentLogger,
    pass: { kind: 'execute', reason: 'cache-ttl-idle' },
    pressure: 20,
    now: () => now,
    memories: { digest: DIGEST, lines: ['- rule A'], newLines: ['- rule B'], newMemoryIds: [2] },
    journal: recordingJournal(entries),
  })
}

describe('policy.ttlRebuild', () => {
  it('is on by default, so an idle pass folds m[0]', () => {
    expect(DEFAULT_POLICY.ttlRebuild).toBe(true)
  })

  it('an idle pass advances the baseline epoch (a HARD fold)', () => {
    const stores = openStore()
    const entries: Recorded[] = []
    try {
      seedBaseline(stores)
      run(stores, true, entries, T0 + 10 * 60_000)
      expect(stores.baselineState(SESSION)?.epoch).toBe(2)
      expect(stores.baselineState(SESSION)?.frozenAt).toBe(T0 + 10 * 60_000)
    } finally {
      stores.close()
    }
  })

  it('with the switch off the idle pass keeps the epoch and only refreshes bytes softly', () => {
    const stores = openStore()
    const entries: Recorded[] = []
    try {
      seedBaseline(stores)
      run(stores, false, entries, T0 + 10 * 60_000)
      const state = stores.baselineState(SESSION)
      expect(state?.epoch).toBe(1)
      // A SOFT pass must never move the frozen point: it is what m[1] is frozen
      // against, and moving it would fold the delta for free every tick.
      expect(state?.frozenAt).toBe(T0)
    } finally {
      stores.close()
    }
  })

  it('does not touch a pass that is not the idle band', () => {
    const stores = openStore()
    const entries: Recorded[] = []
    try {
      seedBaseline(stores)
      runManagementPass({
        session: surfaceSession(),
        sessionId: SESSION,
        stores,
        policy: { ...DEFAULT_POLICY, ttlRebuild: true },
        logger: silentLogger,
        pass: { kind: 'execute', reason: 'execute-threshold' },
        pressure: 66,
        now: () => T0 + 10 * 60_000,
        memories: { digest: DIGEST, lines: ['- rule A'], newLines: ['- rule B'], newMemoryIds: [2] },
        journal: recordingJournal(entries),
      })
      expect(stores.baselineState(SESSION)?.epoch).toBe(1)
    } finally {
      stores.close()
    }
  })
})
