/**
 * `curate`: consolidate memories that say the same thing.
 *
 * ## Why a vector is the only signal that works here
 *
 * Duplicate *text* never reaches this task: `UNIQUE(project_path, category,
 * normalized_hash)` refuses the second insert, so anything hash-equal was already
 * deduped at write time. What accumulates instead is the same FACT said
 * differently — "the scheduler tick is five minutes" and "background tasks are
 * polled every 5 min" are one memory wearing two coats, and only a vector sees
 * that. So the candidate pool is "rows that carry an embedding in the dominant
 * space", and a project with no vectors reports "nothing to compare" rather than
 * silently falling back to string matching that cannot find anything.
 *
 * ## Dry run is the default, and that is the point
 *
 * Merging is the one dreamer task whose mistake is unrecoverable by the task
 * itself: an archived source row stays archived, and the merged replacement is a
 * new piece of text nobody reviewed. `dryRun: true` runs the whole pipeline —
 * pair selection, model call, safety gate — and returns the decisions without
 * writing. The apply path exists, but a caller has to ask for it by name, and the
 * registry ships `curate` with an empty cron so nothing turns it on by accident.
 *
 * ## Three layers of refusal, in this order
 *
 * 1. **Similarity floor** — below it, no pair is even offered to the model.
 * 2. **The safety gate** (`curate-safety.ts`) — four structural refusals that do
 *    not care how confident the model was.
 * 3. **Host-side application** — the merge goes through `mergeMemory` (the
 *    contract action), so the mutation log, sharing restore and counters all stay
 *    in the loop. Nothing here writes SQL directly.
 */

import type { Journal } from './journal.ts'
import { LlmDeadlineError, withDeadline } from './llm-deadline.ts'
import { memoryContentHash, type MemoryRecord, type MemoryWriter } from './memory-write.ts'
import type { LlmSeamMessage } from './types.ts'
import { cosineScore } from './chunk-store.ts'
import {
  assessCurateMutationSafety,
  type CurateCandidateRow,
  type CurateRefusal,
} from './curate-safety.ts'

export interface CurateLlm {
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

/** What the vector reader gives us; mirrors `MemoryWriter.listVectors`. */
export interface CurateVectorRow {
  readonly id: number
  readonly category: string
  readonly content: string
  readonly importance: number
  readonly seenCount: number
  readonly createdAt: number
  readonly embedding: Float32Array
}

export interface CurateDeps {
  readonly writer?: MemoryWriter
  readonly identity?: string
  readonly llm?: CurateLlm
  readonly route?: { readonly provider: string; readonly model: string }
  /** Embedding space to compare in. Rows without a vector in it are invisible. */
  readonly modelId?: string
  readonly sessionId: string
  readonly journal: Journal
  readonly now?: () => number
  /** True = decide and report, write nothing. The safe default. */
  readonly dryRun?: boolean
  /** Cosine below which a pair is not even offered. */
  readonly similarityFloor?: number
  /** Pairs examined per run. */
  readonly maxPairs?: number
  readonly timeoutMs?: number
}

export type CurateAction = 'merge' | 'archive' | 'keep' | 'skip'

/** One pair the model was asked about, and what came of it. */
export interface CurateDecision {
  readonly archiveId: number
  readonly keepId: number
  readonly similarity: number
  readonly action: CurateAction
  /** Set when the model's action survived the gate and (if applying) ran. */
  readonly applied?: boolean
  readonly refusal?: CurateRefusal
  readonly refusalReason?: 'verdict-for-unoffered-pair' | 'write-refused'
  readonly detail?: string
  /** The merged text, present on `merge` decisions. */
  readonly content?: string
}

export interface CurateOutcome {
  /** Rows carrying a vector in the chosen space. */
  readonly pool: number
  /** Pairs above the floor, before batching. */
  readonly candidates: number
  readonly asked: number
  readonly merged: number
  readonly archived: number
  readonly kept: number
  readonly skipped: number
  readonly refused: number
  readonly tokensUsed: number
  readonly dryRun: boolean
  readonly decisions: readonly CurateDecision[]
  readonly reason?: 'writer-unavailable' | 'read-only' | 'no-route' | 'no-embedding-space' | 'empty-pool' | 'no-candidates' | 'llm-failed' | 'parse-failed'
}

const DEFAULT_FLOOR = 0.92
const DEFAULT_MAX_PAIRS = 6
const CURATE_MAX_TOKENS = 8192
const CURATE_TIMEOUT_MS = 120_000
/** Rows pulled from the vector table per run. Comparing every pair is O(n²), so
 *  the window is bounded before that cost is paid. */
const VECTOR_WINDOW = 400
const CONTENT_PREVIEW = 900

/**
 * 0.92 is a judgement, not a measurement: below ~0.90 a "pair" is usually two
 * memories about the same subsystem rather than the same fact, and offering
 * those to the model wastes calls and invites a wrong merge. The floor is a
 * parameter so a project with a different embedding model can move it.
 */

const CURATE_INSTRUCTION = [
  'You are consolidating a project memory store. Each item below is a PAIR of memories that are semantically very similar.',
  'Decide, for each pair, whether they are one fact recorded twice:',
  '- "merge": the same fact. Give the combined "content" — ONE self-contained sentence or short paragraph that keeps every distinct detail from both. If they disagree, keep the more specific claim and say nothing about the other.',
  '- "archive": one is obsolete and the other already covers it. Name which to archive via "archiveId" (one of the two ids).',
  '- "keep": they are related but distinct facts, both worth keeping. This is the common case — similarity is not identity.',
  '- "skip": cannot tell from the text alone.',
  'Rules:',
  'Never merge two rules that could both be violated independently — two prohibitions are two rules even when worded alike.',
  'Never merge across categories; if a pair looks cross-category, answer "keep".',
  'Prefer "keep" when the memories differ in a detail that would change behaviour: a file path, a number, a version, a command.',
  'Reply with ONLY a JSON object: {"decisions":[{"archiveId":<number>,"keepId":<number>,"action":"merge"|"archive"|"keep"|"skip","content"?:"...","reason"?:"..."}]}',
].join('\n')

export interface CandidatePair {
  readonly a: CurateVectorRow
  readonly b: CurateVectorRow
  readonly similarity: number
}

/**
 * Greedy best-first pairing within a category.
 *
 * Each row participates in at most one pair: a chain A≈B≈C where B is the hub
 * would otherwise offer `(A,B)` and `(B,C)` and let the model merge A into B and
 * then archive B, leaving A's fact on a row that no longer exists. Picking the
 * single strongest partner per row avoids that without needing a clustering
 * algorithm.
 */
export function selectCandidatePairs(rows: readonly CurateVectorRow[], floor: number, maxPairs: number): CandidatePair[] {
  const byCategory = new Map<string, CurateVectorRow[]>()
  for (const row of rows) {
    const bucket = byCategory.get(row.category)
    if (bucket === undefined) byCategory.set(row.category, [row])
    else bucket.push(row)
  }

  const pairs: CandidatePair[] = []
  for (const bucket of byCategory.values()) {
    if (bucket.length < 2) continue
    const scored: CandidatePair[] = []
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i] as CurateVectorRow
        const b = bucket[j] as CurateVectorRow
        // Different vector widths means different spaces; cosine across them is
        // meaningless rather than merely noisy.
        if (a.embedding.length !== b.embedding.length) continue
        const similarity = cosineScore(a.embedding, b.embedding)
        if (similarity < floor) continue
        scored.push({ a, b, similarity })
      }
    }
    scored.sort((left, right) =>
      right.similarity - left.similarity
      || (left.a.id - right.a.id)
      || (left.b.id - right.b.id))
    const used = new Set<number>()
    for (const pair of scored) {
      if (used.has(pair.a.id) || used.has(pair.b.id)) continue
      used.add(pair.a.id)
      used.add(pair.b.id)
      pairs.push(pair)
      if (pairs.length >= maxPairs) break
    }
    if (pairs.length >= maxPairs) break
  }
  return pairs
}

interface RawDecision {
  archiveId: number
  keepId: number
  action: CurateAction
  content?: string
  reason?: string
}

/** Parse the decision manifest, salvaging a truncated array. */
export function parseDecisions(text: string): RawDecision[] {
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
    parsed = { decisions: salvaged }
  }

  const decisions = (parsed as { decisions?: unknown }).decisions
  if (!Array.isArray(decisions)) return []
  const actions = new Set<CurateAction>(['merge', 'archive', 'keep', 'skip'])
  const out: RawDecision[] = []
  for (const item of decisions) {
    const row = item as { archiveId?: unknown; keepId?: unknown; action?: unknown; content?: unknown; reason?: unknown }
    if (typeof row.archiveId !== 'number' || !Number.isInteger(row.archiveId)) continue
    if (typeof row.keepId !== 'number' || !Number.isInteger(row.keepId)) continue
    if (typeof row.action !== 'string' || !actions.has(row.action as CurateAction)) continue
    out.push({
      archiveId: row.archiveId,
      keepId: row.keepId,
      action: row.action as CurateAction,
      ...typeof row.content === 'string' && row.content.trim().length > 0 ? { content: row.content.trim() } : {},
      ...typeof row.reason === 'string' && row.reason.trim().length > 0 ? { reason: row.reason.trim() } : {},
    })
  }
  return out
}

function renderPair(pair: CandidatePair, index: number): string {
  const clip = (text: string): string =>
    text.length > CONTENT_PREVIEW ? text.slice(0, CONTENT_PREVIEW) + '…' : text.replace(/\s+/g, ' ')
  return `\n#${String(index + 1)} similarity=${pair.similarity.toFixed(3)} category=${pair.a.category}`
    + `\n  [${String(pair.a.id)}] (importance ${String(pair.a.importance)}, seen ${String(pair.a.seenCount)}): ${clip(pair.a.content)}`
    + `\n  [${String(pair.b.id)}] (importance ${String(pair.b.importance)}, seen ${String(pair.b.seenCount)}): ${clip(pair.b.content)}`
}

async function collectText(
  deps: CurateDeps,
  prompt: string,
): Promise<{ ok: true; text: string; tokensUsed: number } | { ok: false; why: string; tokensUsed: number }> {
  const budgetMs = deps.timeoutMs ?? CURATE_TIMEOUT_MS
  try {
    return await withDeadline(async (signal) => {
      const byIndex = new Map<number, string>()
      let tokensUsed = 0
      const chunks = deps.llm!.stream({
        provider: deps.route!.provider,
        model: deps.route!.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: CURATE_MAX_TOKENS,
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
      if (text.length === 0) return { ok: false as const, why: 'stream produced no text deltas', tokensUsed }
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

/** Project a vector row into the safety gate's shape. */
function asGateRow(row: CurateVectorRow): CurateCandidateRow {
  return {
    id: row.id,
    category: row.category,
    content: row.content,
    status: 'active',
    supersededByMemoryId: null,
  }
}

/**
 * One curate run. Never throws.
 *
 * `dryRun` is threaded through the whole body rather than checked at the end:
 * the decision list must be identical in both modes, and the only difference is
 * whether the contract writes run.
 */
export async function runCurateTick(deps: CurateDeps): Promise<CurateOutcome> {
  const now = (deps.now ?? Date.now)()
  const dryRun = deps.dryRun !== false
  const writer = deps.writer
  const identity = deps.identity
  const base = {
    pool: 0, candidates: 0, asked: 0, merged: 0, archived: 0,
    kept: 0, skipped: 0, refused: 0, tokensUsed: 0, dryRun,
    decisions: [] as readonly CurateDecision[],
  }
  const stop = (reason: CurateOutcome['reason'], extra: Partial<CurateOutcome> = {}): CurateOutcome => ({ ...base, ...extra, reason })
  if (writer === undefined || identity === undefined || identity.length === 0) return stop('writer-unavailable')
  if (writer.status.readOnly === true) return stop('read-only')
  if (deps.llm === undefined || deps.route === undefined) return stop('no-route')
  const modelId = deps.modelId
  if (modelId === undefined || modelId.length === 0) {
    // Without a shared space there is nothing to compare: two vectors from
    // different models cannot be scored against each other at all.
    return stop('no-embedding-space')
  }

  const rows = writer.listVectors(identity, modelId, VECTOR_WINDOW)
  if (rows.length < 2) {
    deps.journal.info('dream-curate', 'curate: fewer than two embedded rows', { pool: rows.length })
    return stop('empty-pool', { pool: rows.length })
  }

  const floor = deps.similarityFloor ?? DEFAULT_FLOOR
  const pairs = selectCandidatePairs(rows, floor, deps.maxPairs ?? DEFAULT_MAX_PAIRS)
  if (pairs.length === 0) {
    deps.journal.info('dream-curate', 'curate: no pair is similar enough', {
      pool: rows.length,
      floor,
    })
    return stop('no-candidates', { pool: rows.length })
  }

  // Remembered skips: a pair the model already declined is not re-asked. Keyed
  // by content hash, so editing either side re-opens it.
  const ids = pairs.flatMap(pair => [pair.a.id, pair.b.id])
  const skipHashes = writer.curateSkipHashes(identity, ids)
  const byId = new Map(rows.map(row => [row.id, row] as const))
  const livePairs = pairs.filter(pair =>
    skipHashes.get(pair.a.id) !== memoryContentHash(pair.a.content)
    && skipHashes.get(pair.b.id) !== memoryContentHash(pair.b.content))
  if (livePairs.length === 0) {
    deps.journal.info('dream-curate', 'curate: every candidate pair is a remembered skip', {
      candidates: pairs.length,
    })
    return stop('no-candidates', { pool: rows.length, candidates: pairs.length })
  }

  const prompt = CURATE_INSTRUCTION
    + `\n\nProject identity: ${identity}`
    + `\nPairs (${String(livePairs.length)}):`
    + livePairs.map(renderPair).join('\n')
  const call = await collectText(deps, prompt)
  if (!call.ok) {
    deps.journal.warn('dream-curate', `curate: call failed, nothing applied: ${call.why}`, {
      candidates: livePairs.length,
      dryRun,
      tokensUsed: call.tokensUsed,
    })
    return {
      ...base,
      pool: rows.length,
      candidates: pairs.length,
      asked: livePairs.length,
      tokensUsed: call.tokensUsed,
      reason: 'llm-failed',
    }
  }

  const raw = parseDecisions(call.text)
  if (raw.length === 0) {
    deps.journal.warn('dream-curate', 'curate: manifest unparsable, nothing applied', {
      candidates: livePairs.length,
      tokensUsed: call.tokensUsed,
    })
    return {
      ...base,
      pool: rows.length,
      candidates: pairs.length,
      asked: livePairs.length,
      tokensUsed: call.tokensUsed,
      reason: 'parse-failed',
    }
  }

  // Every offered pair, so a decision naming ids that were never shown can be
  // dropped rather than acted on.
  const offered = new Set(livePairs.map(pair => `${String(pair.a.id)}:${String(pair.b.id)}`))
  const offeredPairOf = (decision: RawDecision): CandidatePair | undefined =>
    livePairs.find(pair =>
      (pair.a.id === decision.archiveId && pair.b.id === decision.keepId)
      || (pair.b.id === decision.archiveId && pair.a.id === decision.keepId))

  const decisions: CurateDecision[] = []
  let merged = 0
  let archived = 0
  let kept = 0
  let skipped = 0
  let refused = 0

  for (const decision of raw) {
    const pair = offeredPairOf(decision)
    if (pair === undefined || !offered.has(`${String(pair.a.id)}:${String(pair.b.id)}`)) {
      decisions.push({
        archiveId: decision.archiveId,
        keepId: decision.keepId,
        similarity: 0,
        action: decision.action,
        refusalReason: 'verdict-for-unoffered-pair',
      })
      continue
    }

    if (decision.action === 'keep') {
      kept += 1
      decisions.push({
        archiveId: decision.archiveId, keepId: decision.keepId,
        similarity: pair.similarity, action: 'keep',
        ...decision.reason === undefined ? {} : { detail: decision.reason },
      })
      continue
    }
    if (decision.action === 'skip') {
      skipped += 1
      // Remember the skip against BOTH sides: editing either one re-opens the
      // pair, which is the behaviour a content hash is for.
      for (const row of [pair.a, pair.b]) {
        writer.recordCurateSkip({ identity, id: row.id, contentHash: memoryContentHash(row.content), at: now })
      }
      decisions.push({
        archiveId: decision.archiveId, keepId: decision.keepId,
        similarity: pair.similarity, action: 'skip',
        ...decision.reason === undefined ? {} : { detail: decision.reason },
      })
      continue
    }

    // merge / archive both go through the gate.
    const sourceRow = byId.get(decision.archiveId)
    const targetRow = byId.get(decision.keepId)
    if (sourceRow === undefined || targetRow === undefined) {
      decisions.push({
        archiveId: decision.archiveId, keepId: decision.keepId,
        similarity: pair.similarity, action: decision.action,
        refusalReason: 'verdict-for-unoffered-pair',
      })
      continue
    }

    const gateRow = asGateRow(sourceRow)
    const refusal = assessCurateMutationSafety({
      memory: gateRow,
      verdict: decision.action === 'merge' ? 'merge' : 'archive',
      ...decision.reason === undefined ? {} : { reason: decision.reason },
      ...decision.content === undefined ? {} : { replacementContent: decision.content },
      successor: asGateRow(targetRow),
      now,
    })
    if (refusal !== null) {
      refused += 1
      deps.journal.warn('dream-curate', `curate: refused ${String(sourceRow.id)} → ${String(targetRow.id)}: ${refusal.reason}`, {
        archiveId: sourceRow.id,
        keepId: targetRow.id,
        reason: refusal.reason,
      })
      decisions.push({
        archiveId: sourceRow.id, keepId: targetRow.id,
        similarity: pair.similarity, action: decision.action, refusal,
      })
      continue
    }

    if (decision.action === 'merge') {
      // `merge` requires the combined text: the model is the only party that has
      // seen both, so an absent content is a malformed decision, not a merge of
      // the target's own text.
      if (decision.content === undefined) {
        refused += 1
        decisions.push({
          archiveId: sourceRow.id, keepId: targetRow.id,
          similarity: pair.similarity, action: 'merge',
          refusalReason: 'write-refused',
          detail: 'merge verdict carried no content',
        })
        continue
      }
      if (dryRun) {
        merged += 1
        decisions.push({
          archiveId: sourceRow.id, keepId: targetRow.id,
          similarity: pair.similarity, action: 'merge',
          content: decision.content, applied: false,
        })
        continue
      }
      const result = writer.mergeMemory({
        identity,
        targetId: targetRow.id,
        sourceIds: [sourceRow.id],
        content: decision.content,
      })
      if (!result.ok) {
        refused += 1
        decisions.push({
          archiveId: sourceRow.id, keepId: targetRow.id,
          similarity: pair.similarity, action: 'merge',
          refusalReason: 'write-refused', detail: result.detail,
        })
        continue
      }
      merged += 1
      decisions.push({
        archiveId: sourceRow.id, keepId: targetRow.id,
        similarity: pair.similarity, action: 'merge',
        content: decision.content, applied: true,
      })
      continue
    }

    // `archive`: fold the source into the target with supersede, keeping the
    // target's text. This is the "obsolete duplicate" case, and it is the one
    // that must never fire without a live successor — the gate already checked.
    if (dryRun) {
      archived += 1
      decisions.push({
        archiveId: sourceRow.id, keepId: targetRow.id,
        similarity: pair.similarity, action: 'archive', applied: false,
      })
      continue
    }
    const result = writer.archiveMemory({
      identity,
      id: sourceRow.id,
      reason: decision.reason ?? `curate:duplicate-of-${String(targetRow.id)}`,
      supersededBy: targetRow.id,
    })
    if (!result.ok) {
      refused += 1
      decisions.push({
        archiveId: sourceRow.id, keepId: targetRow.id,
        similarity: pair.similarity, action: 'archive',
        refusalReason: 'write-refused', detail: result.detail,
      })
      continue
    }
    archived += 1
    decisions.push({
      archiveId: sourceRow.id, keepId: targetRow.id,
      similarity: pair.similarity, action: 'archive', applied: true,
    })
  }

  deps.journal.info(
    'dream-curate',
    `curate${dryRun ? ' (dry run)' : ''}: ${String(merged)} merged, ${String(archived)} archived, `
      + `${String(kept)} kept, ${String(skipped)} skipped, ${String(refused)} refused`,
    {
      pool: rows.length, candidates: pairs.length, asked: livePairs.length,
      merged, archived, kept, skipped, refused,
      dryRun, tokensUsed: call.tokensUsed,
      decisions: decisions.length,
    },
  )

  return {
    pool: rows.length,
    candidates: pairs.length,
    asked: livePairs.length,
    merged, archived, kept, skipped, refused,
    tokensUsed: call.tokensUsed,
    dryRun,
    decisions,
  }
}

/** Discriminate a `MemoryRecord` into the vector row shape (for tests). */
export function asVectorRow(record: MemoryRecord, embedding: Float32Array): CurateVectorRow {
  return {
    id: record.id,
    category: record.category,
    content: record.content,
    importance: record.importance,
    seenCount: record.seenCount ?? 0,
    createdAt: record.createdAt,
    embedding,
  }
}
