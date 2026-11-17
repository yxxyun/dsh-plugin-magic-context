/**
 * `verify`: check memories against the files they name.
 *
 * ## Why this is a second verify and not a replacement
 *
 * `maintenance.ts` already verifies — from the text alone, and its prompt says so:
 * *"you have no file access."* That is the right trade for a sweep that runs
 * every 30 minutes over every project: it is cheap, it catches contradictions
 * and obvious staleness, and it needs nothing but the row.
 *
 * What it structurally cannot catch is the case this task exists for. A memory
 * saying "`director.py:707` gates the aspect ratio" is not checkable by
 * plausibility — the file either still has that line or it does not. 179 of the
 * 493 live memories in the largest project cite files, 345 references in total,
 * and the most-cited name appears 54 times. That is a large, specific,
 * machine-checkable surface sitting outside the sweep's reach.
 *
 * So this task takes the rows that cite files, reads them, and asks the model to
 * judge with the evidence in front of it. Rows with no file reference are left
 * to the maintenance sweep, which is already good at them. The two lanes do not
 * compete: this one's pool is defined by "has a reference", the other's by
 * "is unverified", and the intersection is verified here and skipped there by the
 * per-row skip memory.
 *
 * ## Verdicts are applied HOST-side, and only four ways
 *
 * The model returns one verdict per memory; the host applies it through the
 * contract actions that already exist (`markVerified`, `updateMemory`,
 * `archiveMemory`, `recordVerifySkip`). No new write kind, no content rewritten
 * without the mutation log. A verdict naming a row that was not sent is dropped,
 * so a confused model cannot touch state it was never shown.
 */

import type { Journal } from './journal.ts'
import { LlmDeadlineError, withDeadline } from './llm-deadline.ts'
import { memoryContentHash, type MemoryRecord, type MemoryWriter } from './memory-write.ts'
import type { LlmSeamMessage } from './types.ts'
import { buildFileIndex, extractFileReferences, gatherEvidence, renderEvidence, type FileEvidence } from './memory-evidence.ts'

export interface VerifyLlm {
  stream(options: {
    readonly provider: string
    readonly model: string
    readonly messages: readonly LlmSeamMessage[]
    readonly maxTokens: number
    readonly sessionId: string
    readonly purpose: 'compaction'
    readonly signal?: AbortSignal
  }): AsyncIterable<unknown>
}

export interface VerifyDeps {
  readonly writer?: MemoryWriter
  readonly identity?: string
  /** Absolute project root the evidence index is built from. */
  readonly projectRoot?: string
  /**
   * Additional trees to search, for the common case where work in one project
   * touches another repository.
   *
   * Searched AFTER the project root, and only to answer "does this file exist
   * somewhere I can see". A filename found in two of these roots stays
   * AMBIGUOUS — two repos with a `lib/guard.ts` is not evidence of anything, and
   * picking one would turn a coincidence into a verdict.
   */
  readonly extraRoots?: readonly string[]
  readonly llm?: VerifyLlm
  readonly route?: { readonly provider: string; readonly model: string }
  readonly sessionId: string
  readonly journal: Journal
  readonly now?: () => number
  readonly batchSize?: number
  readonly timeoutMs?: number
}

export interface VerifyOutcome {
  /** Rows citing at least one file (the pool, before batching). */
  readonly pool: number
  readonly scanned: number
  readonly verified: number
  readonly updated: number
  readonly archived: number
  readonly skipped: number
  readonly tokensUsed: number
  /** References resolved to an existing file, for the journal's evidence line. */
  readonly referencesFound: number
  readonly referencesMissing: number
  readonly referencesAmbiguous: number
  /** Cited lines that no longer exist in a file that DOES exist — a stronger
   *  staleness signal than `missing`, because the file moved on rather than away. */
  readonly referencesUnreadable: number
  readonly reason?: 'writer-unavailable' | 'read-only' | 'no-route' | 'no-project-root' | 'empty-pool' | 'llm-failed' | 'parse-failed'
}

const DEFAULT_BATCH = 8
/**
 * Output ceiling for one verify call.
 *
 * 16384, not 8192. Measured 2026-11-17 on this machine: four consecutive runs
 * ended `nothing applied: llm-failed` with `tokensUsed: 24188` — input ~16k plus
 * a fully spent 8192 output budget — and zero text deltas. That is the same
 * failure `profile-review` had at 8192 (fixed the same way, and it now returns
 * 5,691 output tokens on a 12-candidate batch): a reasoning model that spends
 * the whole budget thinking emits nothing, so the lane retries forever and the
 * pool never drains.
 *
 * This lane asks for more per candidate than review does — a verdict AND a
 * rewritten `content` for every `stale` row, over up to 16 candidates with file
 * evidence attached — so it needs the larger ceiling, not merely review's.
 */
const VERIFY_MAX_TOKENS = 16_384
/**
 * Wall-clock ceiling for one verify call.
 *
 * 300s, not 120s. Measured 2026-11-17, the run right after the output ceiling
 * went 8192 → 16384: `deadline no terminal event within 120000ms`, `tokensUsed 0`
 * — the stream never even reached its `finish` chunk, so not one usage report
 * arrived. A reasoning model that now has 16,384 tokens to spend spends them:
 * at this lane's generation rate two minutes is roughly 8-10k tokens, so the
 * deadline cut the reply before it could finish. The two ceilings have to move
 * together — raising the output budget alone just moved the failure from
 * "no text deltas" to "deadline".
 *
 * Still under the 5-minute dream tick, so a slow run cannot stack up behind the
 * next one (and the lease would refuse it anyway).
 */
const VERIFY_TIMEOUT_MS = 300_000
/** How many unverified rows to examine when looking for ones that cite files. */
const SCAN = 200
const CONTENT_PREVIEW = 700

const VERIFY_INSTRUCTION = [
  'You are auditing project memories for a coding agent. Each memory may cite files; where it does, the actual filesystem evidence is given below it.',
  'For each memory return one verdict:',
  '- "verified": still accurate. If the evidence shows the cited file and lines, this means the fact still matches them.',
  '- "stale": outdated or partly wrong. Provide the corrected "content" (same style, self-contained, no hedging).',
  '- "wrong": plain incorrect or actively harmful. Provide a short "reason".',
  '- "skip": cannot judge from what you were given.',
  'Use the evidence as fact about the filesystem — it was read moments ago. Do not claim a file exists or lacks something the evidence does not say.',
  'A cited file that is NOT FOUND is evidence, not a verdict. A fact can stay true after its file is renamed, and a memory can legitimately describe a DIFFERENT repository than the one you are looking at — the project root given above is the only tree searched.',
  'A row with NO "Filesystem evidence" block cites no file at all. Judge it from its text alone: "verified" when the claim is a general statement you can accept, "skip" when the text does not let you tell, and never "wrong" — with no evidence there is nothing that could contradict it.',
  'HARD RULE: when EVERY cited reference is NOT FOUND, you must not answer "wrong". Answer "skip" if the claim is plausible on its own terms, or "stale" with corrected content if you can see from the text that the fact itself has changed. An archive is irreversible from here and a mistaken one deletes a fact nobody can find again.',
  'Answer "wrong" only when the evidence actively CONTRADICTS the memory — a cited file exists but its content says something else, or the cited line is past the end of a file that does exist.',
  'An AMBIGUOUS reference (several files share the name) means the memory is imprecise, not wrong. Prefer "skip" or "stale" with a corrected path only if the memory itself makes the right file clear.',
  'Reply with ONLY a JSON object: {"verdicts":[{"id":<number>,"verdict":"verified"|"stale"|"wrong"|"skip","content"?:"...","reason"?:"..."}]}',
].join('\n')

interface Verdict {
  id: number
  verdict: string
  content?: string
  reason?: string
}

/** Parse the verdict manifest, salvaging a truncated array like the sweep does. */
export function parseVerdicts(text: string): Verdict[] {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  const slice = text.slice(start, end + 1)
  let parsed: unknown
  try {
    parsed = JSON.parse(slice)
  } catch {
    const arrayStart = slice.indexOf('[')
    if (arrayStart < 0) return []
    const inner = slice.slice(arrayStart + 1)
    const salvaged: unknown[] = []
    let depth = 0
    let objectStart = -1
    let inString = false
    let escaped = false
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i] as string
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') {
        if (depth === 0) objectStart = i
        depth += 1
      } else if (ch === '}') {
        depth -= 1
        if (depth === 0 && objectStart >= 0) {
          try {
            salvaged.push(JSON.parse(inner.slice(objectStart, i + 1)))
          } catch {
            /* drop an incomplete tail */
          }
          objectStart = -1
        }
      }
    }
    parsed = { verdicts: salvaged }
  }
  const verdicts = (parsed as { verdicts?: unknown }).verdicts
  if (!Array.isArray(verdicts)) return []
  const out: Verdict[] = []
  for (const item of verdicts) {
    const row = item as { id?: unknown; verdict?: unknown; content?: unknown; reason?: unknown }
    if (typeof row.id !== 'number' || !Number.isInteger(row.id) || row.id <= 0) continue
    if (typeof row.verdict !== 'string') continue
    out.push({
      id: row.id,
      verdict: row.verdict,
      ...typeof row.content === 'string' && row.content.trim().length > 0 ? { content: row.content.trim() } : {},
      ...typeof row.reason === 'string' && row.reason.trim().length > 0 ? { reason: row.reason.trim() } : {},
    })
  }
  return out
}

function renderRow(row: MemoryRecord, evidenceBlock: string): string {
  const content = row.content.length > CONTENT_PREVIEW ? row.content.slice(0, CONTENT_PREVIEW) + '…' : row.content
  return `- id ${String(row.id)} [${row.category}]: ${content.replace(/\s+/g, ' ')}${evidenceBlock}`
}

async function collectText(
  deps: VerifyDeps,
  prompt: string,
): Promise<{ ok: true; text: string; tokensUsed: number } | { ok: false; why: string; tokensUsed: number }> {
  const budgetMs = deps.timeoutMs ?? VERIFY_TIMEOUT_MS
  try {
    return await withDeadline(async (signal) => {
      const byIndex = new Map<number, string>()
      let tokensUsed = 0
      let finishKind: string | undefined
      const chunks = deps.llm!.stream({
        provider: deps.route!.provider,
        model: deps.route!.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: VERIFY_MAX_TOKENS,
        sessionId: deps.sessionId,
        purpose: 'compaction',
        signal,
      })
      for await (const raw of chunks) {
        const chunk = raw as { type: string; index?: number; text?: string }
        if (chunk.type === 'text-delta' && typeof chunk.index === 'number' && typeof chunk.text === 'string') {
          byIndex.set(chunk.index, (byIndex.get(chunk.index) ?? '') + chunk.text)
        } else if (chunk.type === 'usage') {
          const reported = (raw as { usage?: Record<string, unknown> }).usage
          for (const value of Object.values(reported ?? {})) {
            if (typeof value === 'number') tokensUsed += value
          }
        } else if (chunk.type === 'finish') {
          const reason = (raw as { reason?: { kind?: string; failure?: { message?: string; code?: string } } }).reason
          finishKind = reason?.kind
          if (reason !== undefined && (reason.kind === 'error' || reason.kind === 'aborted')) {
            const detail = reason.failure?.message ?? reason.failure?.code
            return {
              ok: false as const,
              why: `stream finished (${reason.kind})${detail === undefined ? '' : `: ${detail}`}`,
              tokensUsed,
            }
          }
        }
      }
      const text = [...byIndex.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join('')
      if (text.length === 0) {
        // Naming the finish reason is the difference between "the model said
        // nothing" and "the stream ended before it could": `max-tokens` means
        // the ceiling cut it off mid-reasoning, `stop` with no deltas means an
        // empty reply. Without it the only visible symptom was a bare
        // "no text deltas" and the cause had to be inferred from `tokensUsed`.
        return {
          ok: false as const,
          why: `stream produced no text deltas`
            + (finishKind === undefined ? ' (stream never reported finish)' : ` (finish ${finishKind})`)
            + `, maxTokens ${String(VERIFY_MAX_TOKENS)}`,
          tokensUsed,
        }
      }
      return { ok: true as const, text, tokensUsed }
    }, budgetMs)
  } catch (error) {
    return {
      ok: false,
      why: error instanceof LlmDeadlineError ? `deadline ${error.message}` : error instanceof Error ? error.message : String(error),
      tokensUsed: 0,
    }
  }
}

/**
 * Resolve each reference across every root, preferring the project's own tree.
 *
 * The merge rule, and why it is not "first hit wins":
 *
 *  - exactly one root finds it  → `found`, with that root's relative path;
 *  - no root finds it           → `missing` (the real answer — the file is gone
 *                                 from everywhere this host can see);
 *  - two or more roots find it  → `ambiguous`, listing all of them. A `lib/guard.ts`
 *                                 in two repositories is a coincidence, not
 *                                 evidence; resolving it either way would turn
 *                                 that coincidence into a verdict.
 *
 * Order matters only for reporting: the project root's hit is the one a reader
 * expects to see, and it wins ties against extra roots for `found`-with-one-hit.
 */
function mergeAcrossRoots(
  references: ReturnType<typeof extractFileReferences>,
  indexes: ReadonlyArray<{ root: string; index: ReturnType<typeof buildFileIndex> }>,
): FileEvidence[] {
  if (indexes.length === 0) return []
  if (indexes.length === 1) {
    const only = indexes[0] as { root: string; index: ReturnType<typeof buildFileIndex> }
    return gatherEvidence(references, only.index.index, { root: only.root })
  }
  // Gather per root, then merge reference by reference (the arrays are aligned
  // because every call gets the same reference list and the same maxReferences).
  const perRoot = indexes.map(entry => gatherEvidence(references, entry.index.index, { root: entry.root }))
  const merged: FileEvidence[] = []
  const width = perRoot[0]?.length ?? 0
  for (let i = 0; i < width; i += 1) {
    const column = perRoot.map(rows => rows[i]).filter((row): row is FileEvidence => row !== undefined)
    const found = column.filter(row => row.status === 'found')
    if (found.length === 1) {
      merged.push(found[0] as FileEvidence)
      continue
    }
    if (found.length > 1) {
      merged.push({
        reference: (found[0] as FileEvidence).reference,
        status: 'ambiguous',
        candidates: found.map(row => row.path ?? '?').slice(0, 5),
      })
      continue
    }
    // No root found it: report missing, unless one root could at least open it.
    const unreadable = column.find(row => row.status === 'unreadable')
    if (unreadable !== undefined) {
      merged.push(unreadable)
      continue
    }
    const ambiguous = column.find(row => row.status === 'ambiguous')
    if (ambiguous !== undefined) {
      merged.push(ambiguous)
      continue
    }
    const first = column[0]
    if (first !== undefined) merged.push(first)
  }
  return merged
}

/**
 * One verify run. Never throws.
 *
 * The pool is "unverified rows that cite at least one file", scanned from the
 * writer's unverified window. A row with no reference is not this task's
 * business, and counting it as scanned would make the run look like it did less
 * than it did.
 */
export async function runVerifyTick(deps: VerifyDeps): Promise<VerifyOutcome> {
  const now = (deps.now ?? Date.now)()
  const writer = deps.writer
  const identity = deps.identity
  const base = { pool: 0, scanned: 0, verified: 0, updated: 0, archived: 0, skipped: 0, tokensUsed: 0, referencesFound: 0, referencesMissing: 0, referencesAmbiguous: 0, referencesUnreadable: 0 }
  const stop = (reason: VerifyOutcome['reason'], extra: Partial<VerifyOutcome> = {}): VerifyOutcome => ({ ...base, ...extra, reason })
  if (writer === undefined || identity === undefined || identity.length === 0) return stop('writer-unavailable')
  if (writer.status.readOnly === true) return stop('read-only')
  if (deps.llm === undefined || deps.route === undefined) return stop('no-route')
  if (deps.projectRoot === undefined || deps.projectRoot.length === 0) return stop('no-project-root')

  const window = writer.listMemories(identity, { now, limit: SCAN, unverifiedOnly: true })
  const skipHashes = window.length === 0 ? undefined : writer.verifySkipHashes(identity, window.map(row => row.id))
  const citing: Array<{ row: MemoryRecord; references: ReturnType<typeof extractFileReferences> }> = []
  for (const row of window) {
    // A remembered skip is stepped over: the sweep already established that the
    // text alone cannot decide, and adding evidence does not help when the
    // problem was the claim, not the file.
    if (skipHashes?.get(row.id) === memoryContentHash(row.content)) continue
    // EVERY unverified row is eligible, not only the ones citing a file.
    //
    // This task used to take only rows with file references, leaving the rest to
    // the maintenance sweep — two lanes reading one pool, and the 30-minute sweep
    // always won it. Upstream has a single `verify`, and so does this: rows
    // without references get a prompt that says so, and the absence-of-evidence
    // guard below already refuses to archive on nothing.
    citing.push({ row, references: extractFileReferences(row.content) })
    if (citing.length >= (deps.batchSize ?? DEFAULT_BATCH)) break
  }
  if (citing.length === 0) {
    deps.journal.info('dream-verify', 'verify: nothing unverified', { pool: window.length })
    return { ...base, pool: window.length, reason: 'empty-pool' }
  }

  // One index per root, built once. A root that truncates is reported: an index
  // that silently stops early makes absent files look like they never existed,
  // which is exactly the misreading this task is supposed to avoid.
  const roots = [deps.projectRoot, ...(deps.extraRoots ?? []).filter(root => root !== deps.projectRoot)]
  const indexes: Array<{ root: string; index: ReturnType<typeof buildFileIndex> }> = []
  for (const root of roots) {
    const built = buildFileIndex(root)
    if (built.truncated) {
      deps.journal.warn('dream-verify', `verify: index for ${root} hit its file ceiling; references beyond it read as missing`, {
        root,
        scanned: built.scanned,
      })
    }
    indexes.push({ root, index: built })
  }

  let referencesFound = 0
  let referencesMissing = 0
  let referencesAmbiguous = 0
  let referencesUnreadable = 0
  const blocks: string[] = []
  /**
   * Per-row evidence tally. Kept so the apply step can refuse an archive that
   * rests on nothing but absence — see the `wrong` branch below.
   */
  const evidenceByRow = new Map<number, { found: number; missing: number; ambiguous: number; unreadable: number }>()
  for (const entry of citing) {
    const evidence = mergeAcrossRoots(entry.references, indexes)
    let found = 0
    let missing = 0
    let ambiguous = 0
    let unreadable = 0
    for (const item of evidence) {
      if (item.status === 'found') {
        referencesFound += 1
        found += 1
      } else if (item.status === 'missing') {
        referencesMissing += 1
        missing += 1
      } else if (item.status === 'ambiguous') {
        referencesAmbiguous += 1
        ambiguous += 1
      } else {
        // UNREADABLE means the file EXISTS but the cited lines could not be read
        // (a line number past the end, a permission error). That is evidence —
        // the file is there and does not say what the memory claims — so it must
        // be counted apart from absence.
        referencesUnreadable += 1
        unreadable += 1
      }
    }
    evidenceByRow.set(entry.row.id, { found, missing, ambiguous, unreadable })
    blocks.push(renderRow(entry.row, renderEvidence(evidence)))
  }

  const prompt = VERIFY_INSTRUCTION
    + `\n\nProject identity: ${identity}`
    + `\nProject root: ${deps.projectRoot}`
    + `\nMemories (${String(citing.length)}):\n`
    + blocks.join('\n')
  const call = await collectText(deps, prompt)
  if (!call.ok) {
    deps.journal.warn('dream-verify', `verify: call failed, nothing applied: ${call.why}`, {
      candidates: citing.length,
      tokensUsed: call.tokensUsed,
    })
    return {
      ...base,
      scanned: citing.length,
      tokensUsed: call.tokensUsed,
      referencesFound,
      referencesMissing,
      referencesAmbiguous,
      referencesUnreadable,
      reason: 'llm-failed',
    }
  }

  const verdicts = parseVerdicts(call.text)
  if (verdicts.length === 0) {
    deps.journal.warn('dream-verify', 'verify: manifest unparsable, nothing applied', {
      candidates: citing.length,
      tokensUsed: call.tokensUsed,
    })
    return {
      ...base,
      scanned: citing.length,
      tokensUsed: call.tokensUsed,
      referencesFound,
      referencesMissing,
      referencesAmbiguous,
      referencesUnreadable,
      reason: 'parse-failed',
    }
  }

  const known = new Map(citing.map(entry => [entry.row.id, entry.row] as const))
  const verifiedIds: number[] = []
  let updated = 0
  let archived = 0
  let skipped = 0
  for (const verdict of verdicts) {
    const row = known.get(verdict.id)
    // A verdict for a row that was not sent is dropped: the model was not shown
    // that content, so it cannot have judged it.
    if (row === undefined) continue
    if (verdict.verdict === 'verified') {
      verifiedIds.push(row.id)
    } else if (verdict.verdict === 'stale' && verdict.content !== undefined) {
      const result = writer.updateMemory({ identity, id: row.id, content: verdict.content })
      if (result.ok) updated += 1
    } else if (verdict.verdict === 'wrong') {
      // An archive is irreversible from here, so absence of evidence is not
      // enough to justify one. If every reference the memory made was simply NOT
      // FOUND, the model is inferring staleness from a missing file — which also
      // happens when the memory describes a DIFFERENT repository than the one
      // searched. Measured 2026-11-17: this archived a correct memory whose three
      // cited files lived in a sibling repo.
      //
      // Downgrading to `skip` keeps the row (and remembers the skip against its
      // content hash), so an edit or a later run can still decide.
      // `tally` is undefined for a row that cites no file at all, and `missing
      // === 0` covers the same case: either way the model had no evidence to
      // contradict, so an archive would rest on nothing.
      // Absence means: no reference was FOUND and none was UNREADABLE. A row
      // citing no file at all, a row whose files are all missing, and a row whose
      // names are all ambiguous all qualify — in each case the model had nothing
      // to read, so an archive would rest on nothing.
      //
      // UNREADABLE is deliberately excluded from that set: a file that exists but
      // does not contain the cited lines IS a contradiction, and archiving on it
      // is the point of this task.
      const tally = evidenceByRow.get(row.id)
      const absenceOnly = tally === undefined || (tally.found === 0 && tally.unreadable === 0)
      if (absenceOnly) {
        skipped += 1
        writer.recordVerifySkip({
          identity, id: row.id, contentHash: memoryContentHash(row.content), at: now,
        })
        deps.journal.warn('dream-verify', `verify: downgraded an archive to skip for #${String(row.id)} (no evidence to contradict it)`, {
          id: row.id,
          modelReason: verdict.reason ?? null,
          missing: tally?.missing ?? 0,
        })
        continue
      }
      const result = writer.archiveMemory({ identity, id: row.id, reason: verdict.reason ?? 'verify-wrong' })
      if (result.ok) archived += 1
    } else {
      skipped += 1
      // Remember the skip against the CURRENT content hash, so an edit re-opens
      // the row instead of parking it forever.
      writer.recordVerifySkip({
        identity, id: row.id, contentHash: memoryContentHash(row.content), at: now,
      })
    }
  }
  const verified = verifiedIds.length > 0 ? writer.markVerified(identity, verifiedIds, now) : 0

  deps.journal.info(
    'dream-verify',
    `verify: ${String(verified)} verified, ${String(updated)} rewritten, ${String(archived)} archived, ${String(skipped)} skipped`,
    {
      scanned: citing.length,
      verified, updated, archived, skipped,
      referencesFound, referencesMissing, referencesAmbiguous, referencesUnreadable,
      tokensUsed: call.tokensUsed,
    },
  )
  return {
    pool: window.length,
    scanned: citing.length,
    verified,
    updated,
    archived,
    skipped,
    tokensUsed: call.tokensUsed,
    referencesFound,
    referencesMissing,
    referencesAmbiguous,
    referencesUnreadable,
  }
}
