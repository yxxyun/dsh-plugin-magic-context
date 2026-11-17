/**
 * `classify-memories`: re-score the importance of memories whose score went stale.
 *
 * ## Why this is not the verification sweep
 *
 * `maintenance.ts` already asks the model to score an `importance` alongside each
 * verify verdict, so it is tempting to call classification done. It is not:
 * verification only ever looks at `verification_status = 'unverified'`, and
 * verifying a row removes it from that pool permanently. So every row the sweep
 * has ever touched keeps the score it got **on the day it was judged**, forever.
 *
 * That score is not a fact about the memory — it is a RANK inside a pool. A
 * memory scored when the project held 40 rows was competing with 39 others; the
 * same memory in a 400-row pool is competing with 399, and "the 12th most
 * important thing here" means something entirely different. Nothing re-ranks it,
 * so m[0] (which reads importance to decide what stays in context under budget)
 * keeps rendering a ranking of a pool that no longer exists.
 *
 * This module is that re-rank. It is a **pure transform**, like upstream's
 * reworked classify task: one prompt, one JSON manifest, host-side batch apply.
 * No tools, no per-memory round trips, and no content changes — a score is not
 * an edit, so the mutation log, the §4.5 clears and `updated_at` all stay out of
 * it.
 *
 * ## What it deliberately does NOT do
 *
 * Upstream's classify also rewrites `scope` and `shareable`. This adapter keeps
 * those out: `classifyMemories` (the only writer here) banks importance plus the
 * `classified_at` stamp, and the sharing decision belongs to the human publish
 * gate, not to a nightly model call that could quietly widen visibility.
 */

import type { Journal } from './journal.ts'
import { LlmDeadlineError, withDeadline } from './llm-deadline.ts'
import type { MemoryRecord, MemoryWriter } from './memory-write.ts'
import type { LlmSeamMessage } from './types.ts'
import { assessShareability } from './shareable-guard.ts'

export interface ClassifyLlm {
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

export interface ClassifyDeps {
  readonly writer?: MemoryWriter
  /** Project identity to score (own rows only). */
  readonly identity?: string
  readonly llm?: ClassifyLlm
  /** Background work has no session to inherit a route from. */
  readonly route?: { readonly provider: string; readonly model: string }
  readonly sessionId: string
  readonly journal: Journal
  readonly now?: () => number
  /** A score older than this is stale enough to re-rank. */
  readonly staleAfterMs: number
  /** Rows per call. Small: the answer is one number per row, but the prompt
   *  carries full content, and a truncated call banks nothing. */
  readonly batchSize?: number
  /** Wall-clock budget for the call. */
  readonly timeoutMs?: number
}

export interface ClassifyOutcome {
  /** Rows whose score was stale (the pool size, before batching). */
  readonly stale: number
  /** Rows sent to the model this run. */
  readonly scanned: number
  /** Rows whose score was actually banked. */
  readonly scored: number
  /** Prompt + completion tokens, for the dreamer budget line. */
  readonly tokensUsed: number
  /** Rows the model wanted to share but the text made unsafe. */
  readonly blockedByGuard?: number
  /** Rows whose sharing verdict survived the guard. */
  readonly shared?: number
  /** Set when the run could not do its work; absent on success. */
  readonly reason?: 'writer-unavailable' | 'read-only' | 'no-route' | 'empty-pool' | 'llm-failed' | 'parse-failed'
}

const DEFAULT_BATCH = 16
/** Full content is what makes the score defensible; a truncated memory scores
 *  as a different fact. 600 chars is the compromise between fidelity and a
 *  prompt that fits a batch. */
const CONTENT_PREVIEW = 600
const CLASSIFY_MAX_TOKENS = 8192
const CLASSIFY_TIMEOUT_MS = 90_000
/** How far ahead to look for stale rows before batching. Same 8x shape as the
 *  verify sweep: the window must be wider than the batch so the batch is chosen
 *  by the ORDER BY (recurrence first), not by scan order. */
const SCAN_MULTIPLIER = 8

/**
 * The scoring contract, adapted from upstream's harness-validated guidance.
 *
 * The one thing kept verbatim in spirit is the anti-clustering instruction.
 * A model asked to "rate importance 1-100" returns 70 for nearly everything,
 * and a flat distribution is not a ranking — it makes m[0]'s budget decision
 * arbitrary while looking like it was made. So the prompt spends most of its
 * words forcing spread, and names the one hard floor that must not be smoothed
 * away.
 */
const CLASSIFY_INSTRUCTION = [
  'You are ranking project memories for a coding agent. Each memory is a durable fact the agent may need later.',
  'Assign each one an "importance" score from 1 to 100. The score decides what stays in context when the memory block is over budget, so it is only useful if it DISCRIMINATES.',
  'Blend two things: durability (will this still matter weeks from now, across sessions?) and operational impact (would missing it cause wrong code, wasted time, or a violated constraint?).',
  'Most memories are ordinary working facts and belong in the middle. Reserve the top band for the load-bearing handful. Truth is not importance: a true but obvious fact is not important.',
  'Anchors, not quotas — spread naturally within them:',
  '- 1-30 transient or now-obvious observations',
  '- 40-65 ordinary useful project facts',
  '- 70-100 load-bearing rules, architecture, constraints',
  'One hard floor: an operating rule whose violation causes an irreversible or public mistake (wrong identity, unapproved push, destructive command, leaked private content) scores at least 80. Judge by consequence-of-forgetting, not by how mundane the wording reads.',
  'If you find yourself putting most rows in one band, you have labelled them rather than ranked them. Differentiate.',
  '',
  '### Scope — who the fact is true for',
  '- "project": only meaningful inside this repository or product. Default when unsure.',
  '- "ecosystem": useful to sibling projects on the same stack, harness, provider or team.',
  '- "universe": broadly true outside this codebase — a protocol, platform or API fact.',
  '',
  '### Shareability — may another project read this?',
  'This is about EXPOSURE, not scope. Assume it will be read by a teammate on a DIFFERENT project who does not have your filesystem.',
  'Set "shareable": true for architecture, design rules, conventions, constraints and hard-won gotchas — the things you would tell a new teammate.',
  'Set "shareable": false when the fact is only true on THIS machine or only means something with local context. In particular:',
  '- it names an absolute path, a user home directory, a drive letter, or a local directory layout;',
  '- it names a local endpoint, port, loopback or private network address;',
  '- it contains a credential, token, key or password;',
  '- it describes one person\'s environment, install state or configuration file contents.',
  'A false answer costs nothing — the fact stays available to this project. A wrong true answer leaks this machine\'s layout to every other project. When in doubt, say false.',
  '',
  'You are given the memory text only; you have no file access. Judge from internal consistency and software-engineering plausibility.',
  'Reply with ONLY a JSON object: {"scores":[{"id":<number>,"importance":<number>,"scope":"project"|"ecosystem"|"universe","shareable":true|false}]}',
].join('\n')

function renderRow(row: MemoryRecord): string {
  const content = row.content.length > CONTENT_PREVIEW
    ? row.content.slice(0, CONTENT_PREVIEW) + '…'
    : row.content
  return `- id ${String(row.id)} [${row.category}] (previous score ${String(row.importance)}): `
    + content.replace(/\s+/g, ' ')
}

/**
 * Parse the score manifest, salvaging a truncated array.
 *
 * A reasoning model that hits max-tokens mid-array still leads with usable
 * entries, and discarding the whole call would just repeat the truncation next
 * run. Anything that fails to parse yields no scores at all — a guessed score is
 * worse than a stale one, because it is indistinguishable from a real judgement.
 */
export interface ParsedScore {
  id: number
  importance: number
  scope?: 'project' | 'ecosystem' | 'universe'
  shareable?: boolean
  /** Set by the host when the guard refused a `shareable: true` answer. */
  blocked?: boolean
}

const SCOPES = new Set(['project', 'ecosystem', 'universe'])

export function parseScores(text: string): ParsedScore[] {
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
    // Walk complete `{...}` objects, tracking string state so a brace inside a
    // memory's text cannot desynchronise the depth counter.
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
            /* an incomplete tail object is simply dropped */
          }
          objectStart = -1
        }
      }
    }
    parsed = { scores: salvaged }
  }

  const scores = (parsed as { scores?: unknown }).scores
  if (!Array.isArray(scores)) return []
  const out: ParsedScore[] = []
  for (const item of scores) {
    const row = item as { id?: unknown; importance?: unknown; scope?: unknown; shareable?: unknown }
    if (typeof row.id !== 'number' || !Number.isInteger(row.id) || row.id <= 0) continue
    if (typeof row.importance !== 'number' || !Number.isFinite(row.importance)) continue
    // Clamp here as well as in the writer: an out-of-band score must not enter
    // the manifest at all, so the count of applied rows stays honest.
    // A missing or malformed scope/shareable is simply absent — an unparsable
    // sharing judgement must not become a default `true`.
    out.push({
      id: row.id,
      importance: Math.min(100, Math.max(1, Math.round(row.importance))),
      ...typeof row.scope === 'string' && SCOPES.has(row.scope)
        ? { scope: row.scope as ParsedScore['scope'] }
        : {},
      ...typeof row.shareable === 'boolean' ? { shareable: row.shareable } : {},
    })
  }
  return out
}

/** One LLM round trip, returning text or the reason there is none. */
async function collectText(
  deps: ClassifyDeps,
  userPrompt: string,
): Promise<{ ok: true; text: string; tokensUsed: number } | { ok: false; why: string; tokensUsed: number }> {
  const budgetMs = deps.timeoutMs ?? CLASSIFY_TIMEOUT_MS
  try {
    return await withDeadline(async (signal) => {
      const byIndex = new Map<number, string>()
      let tokensUsed = 0
      const chunks = deps.llm!.stream({
        provider: deps.route!.provider,
        model: deps.route!.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
        maxTokens: CLASSIFY_MAX_TOKENS,
        sessionId: deps.sessionId,
        // The host types `purpose` as a generic string (`GenerateOptions<Purpose
        // extends string>`), so any label is accepted. Kept as 'compaction' to
        // match every other auxiliary call this adapter makes — a distinct label
        // would be invisible to the host today and misleading in its logs.
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

/**
 * One classify run. Never throws — every failure is journaled and reported.
 *
 * The order of operations is the safety property: read, ask, parse, and only
 * then write. A failed call or an unparsable manifest writes NOTHING, so a bad
 * run costs a request and leaves the previous ranking intact — which is the
 * correct failure mode for a task whose whole job is re-ranking.
 */
export async function runClassifyTick(deps: ClassifyDeps): Promise<ClassifyOutcome> {
  const now = (deps.now ?? Date.now)()
  const writer = deps.writer
  const identity = deps.identity
  const empty = (reason: ClassifyOutcome['reason'], stale = 0): ClassifyOutcome => ({
    stale, scanned: 0, scored: 0, tokensUsed: 0, ...reason === undefined ? {} : { reason },
  })
  if (writer === undefined || identity === undefined || identity.length === 0) return empty('writer-unavailable')
  if (writer.status.readOnly === true) return empty('read-only')
  if (deps.llm === undefined || deps.route === undefined) return empty('no-route')

  const staleBefore = now - deps.staleAfterMs
  const scanLimit = (deps.batchSize ?? DEFAULT_BATCH) * SCAN_MULTIPLIER
  const window = writer.listMemories(identity, {
    now,
    limit: scanLimit,
    classificationStaleBefore: staleBefore,
  })
  if (window.length === 0) {
    deps.journal.info('dream-classify', 'classify: every score is fresh', { stale: 0 })
    return empty('empty-pool')
  }
  const candidates = window.slice(0, deps.batchSize ?? DEFAULT_BATCH)

  const prompt = CLASSIFY_INSTRUCTION
    + '\n\nProject identity: ' + identity
    + `\nMemories (${String(candidates.length)}):\n`
    + candidates.map(renderRow).join('\n')
  const call = await collectText(deps, prompt)
  if (!call.ok) {
    // Nothing is written. The rows keep their previous scores and stay in the
    // stale window, so the next run picks them up again.
    deps.journal.warn('dream-classify', `classify: call failed, nothing written: ${call.why}`, {
      candidates: candidates.length,
      stale: window.length,
      tokensUsed: call.tokensUsed,
    })
    return { stale: window.length, scanned: candidates.length, scored: 0, tokensUsed: call.tokensUsed, reason: 'llm-failed' }
  }

  const scores = parseScores(call.text)
  if (scores.length === 0) {
    deps.journal.warn('dream-classify', 'classify: manifest unparsable, nothing written', {
      candidates: candidates.length,
      tokensUsed: call.tokensUsed,
    })
    return { stale: window.length, scanned: candidates.length, scored: 0, tokensUsed: call.tokensUsed, reason: 'parse-failed' }
  }

  // Self-filter to the rows actually sent: a model that invents an id must not
  // be able to write outside the batch it was shown.
  const sent = new Map(candidates.map(row => [row.id, row] as const))
  const applicable = scores.filter(score => sent.has(score.id))

  // The gate, applied to every sharing verdict BEFORE it reaches the writer.
  //
  // The model's answer is a judgement about usefulness; the guard is a fact
  // about the text. A judgement that says "a teammate would want this" is
  // correct and still must not be written when the text carries `C:\Users\…`
  // or an API key — the teammate does not have those, and the row would leak
  // this machine's layout to every project on it.
  let blockedByGuard = 0
  const blockedReasons = new Map<string, number>()
  const entries: ParsedScore[] = applicable.map((score): ParsedScore => {
    if (score.shareable !== true) return score
    const verdict = assessShareability(sent.get(score.id)?.content ?? '')
    if (verdict.safe) return score
    blockedByGuard += 1
    const key = verdict.refusal ?? 'unscannable'
    blockedReasons.set(key, (blockedReasons.get(key) ?? 0) + 1)
    return { ...score, blocked: true }
  })

  const scored = entries.length === 0 ? 0 : writer.classifyMemories(identity, entries, now)
  deps.journal.info('dream-classify', `classify: scored ${String(scored)} of ${String(candidates.length)}`, {
    stale: window.length,
    scanned: candidates.length,
    scored,
    droppedIds: scores.length - applicable.length,
    // A non-zero count here is the safety net doing its job, and is the number
    // to watch: it means the model wanted to share something machine-local.
    blockedByGuard,
    ...blockedByGuard === 0 ? {} : { blockedReasons: Object.fromEntries(blockedReasons) },
    tokensUsed: call.tokensUsed,
  })
  return {
    stale: window.length,
    scanned: candidates.length,
    scored,
    tokensUsed: call.tokensUsed,
    blockedByGuard,
    shared: entries.filter(entry => entry.shareable === true && entry.blocked !== true).length,
  }
}
