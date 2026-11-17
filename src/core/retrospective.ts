/**
 * `retrospective`: read the adapter's own journal and say what went wrong.
 *
 * ## Why the journal and not the session archive
 *
 * The obvious source is a session search, and it is the wrong one here. The host
 * index is queried ONE session at a time (`searchEvents({ sessionId })`), so a
 * retrospective over "the last week of this project" would need a session list, a
 * query per session, and a merge — and what came back would be raw conversation,
 * most of it irrelevant to how the adapter behaved.
 *
 * The journal is already the right shape: it is the adapter's own record, it is
 * cross-session by construction, and every row carries a `kind`, a `level` and a
 * JSON payload. The five signals below are the ones that mean "something cost the
 * user something" — a forced compaction, an emergency reclaim, a repair, a
 * failed background task, an error. Reading those is a `GROUP BY`, not a model
 * call, and the model only has to explain what the counts already show.
 *
 * ## It writes a report, never a memory
 *
 * The task's registry entry sets `mutatesMemories: false`, and this module keeps
 * that promise: its only write is one `notes` row (a pending intention the agent
 * can read with `ctx_search`). A retrospective that quietly edited memories would
 * be a curator with no gate — the opposite of what the four safety rules exist
 * for.
 */

import type { Journal } from './journal.ts'
import type { AdapterStores } from './stores.ts'
import { LlmDeadlineError, withDeadline } from './llm-deadline.ts'
import type { LlmSeamMessage } from './types.ts'

export interface RetrospectiveLlm {
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

/** One thing that went wrong, as counted from the journal. */
export interface FrictionSignal {
  readonly kind: string
  readonly level: string
  /** Per-occurrence cost, 1..3 — what the ranking weighs `count` by. */
  readonly weight: number
  readonly count: number
  /** Up to a few recent summaries, so the model sees wording not just counts. */
  readonly samples: readonly string[]
  readonly lastAt: number
}

export interface RetrospectiveDeps {
  readonly stores?: AdapterStores
  readonly identity?: string
  readonly llm?: RetrospectiveLlm
  readonly route?: { readonly provider: string; readonly model: string }
  readonly journal: Journal
  readonly sessionId: string
  readonly now?: () => number
  /** How far back to read. */
  readonly windowMs?: number
  readonly timeoutMs?: number
  /** Write the note. Default true; false reports without persisting. */
  readonly writeNote?: boolean
}

export interface RetrospectiveOutcome {
  /** Journal rows in the window. */
  readonly rows: number
  readonly signals: number
  /** The generated summary, when the call succeeded. */
  readonly summary?: string
  readonly noteId?: number
  readonly tokensUsed: number
  readonly reason?: 'stores-unavailable' | 'no-route' | 'empty-window' | 'no-friction' | 'llm-failed'
}

/**
 * Kinds that mean a cost was paid, with the weight each carries in the prompt.
 *
 * `error` is any level=error row, which is why it is matched by level rather
 * than by kind. The rest are specific kinds whose presence is itself the signal:
 * a forced compaction means the context got away from us, an emergency reclaim
 * means it got away badly.
 */
const FRICTION_KINDS: Readonly<Record<string, number>> = {
  'force-path': 3,
  'emergency-reclaim': 3,
  'wire-repair': 2,
  'project-drift': 2,
  'config-drift': 2,
  'drop-retired': 1,
  'compartment-recomp': 1,
}

/** Dreamer kinds whose FAILED runs are friction. */
const DREAM_KINDS: ReadonlySet<string> = new Set(['dream-run', 'dream-classify', 'dream-verify', 'dream-curate'])

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const RETRO_MAX_TOKENS = 4096
const RETRO_TIMEOUT_MS = 90_000
const SAMPLE_LIMIT = 4
const MAX_SIGNALS = 12

const RETRO_INSTRUCTION = [
  'You are writing a short retrospective for a coding-agent session store over the past week.',
  'You are given counted friction signals taken from the adapter journal: things that cost the user time or context.',
  'Write three short paragraphs, no headings, plain prose:',
  '1. What actually went wrong, in the order of how much it cost. Be concrete about the mechanism — if forced compactions dominate, say the context grew faster than the threshold and the force band fired.',
  '2. What the pattern suggests about the setup rather than about one incident.',
  '3. One or two specific things to change, phrased as actions someone could take this week.',
  'Do not invent numbers beyond the ones given. Do not praise anything. If the signals are trivial, say so in one sentence and stop.',
].join('\n')

/**
 * Count friction out of journal rows.
 *
 * Exported because it is the part worth testing without a model: the weighting,
 * the sample bound and the "failed dream run counts, a skipped one does not"
 * rule are all decisions, and they should be checkable.
 */
export function collectFriction(
  rows: ReadonlyArray<{ kind: string; level: string; summary: string; at: number; data?: Record<string, unknown> }>,
): FrictionSignal[] {
  const byKey = new Map<string, { weight: number; count: number; samples: string[]; lastAt: number }>()
  for (const row of rows) {
    const isError = row.level === 'error'
    const isFailedDream = DREAM_KINDS.has(row.kind) && row.level === 'warn'
    const weight = isError ? 3 : isFailedDream ? 2 : (FRICTION_KINDS[row.kind] ?? 0)
    if (weight === 0) continue
    const key = `${row.kind}:${row.level}`
    const entry = byKey.get(key) ?? { weight, count: 0, samples: [], lastAt: 0 }
    entry.count += 1
    entry.lastAt = Math.max(entry.lastAt, row.at)
    if (entry.samples.length < SAMPLE_LIMIT) entry.samples.push(row.summary)
    byKey.set(key, entry)
  }

  return [...byKey.entries()]
    .map(([key, entry]) => {
      const [kind, level] = key.split(':')
      return {
        kind: kind ?? '',
        level: level ?? '',
        weight: entry.weight,
        count: entry.count,
        samples: entry.samples,
        lastAt: entry.lastAt,
      } satisfies FrictionSignal
    })
    // Two ranks, in this order, and the second one is not decoration.
    //
    // `count * weight` is "how much this kind cost in total". It ties constantly:
    // three retired drops and one forced compaction both score 3. When that
    // happens the SEVERITY has to decide, because "the context blew up once" is
    // the thing worth reading about and "three queue retirements" is housekeeping.
    // Sorting ties by insertion order instead would let the cheaper kind win on
    // nothing but arrival sequence — and the result is truncated to
    // MAX_SIGNALS, so losing the tie means losing the signal.
    .sort((left, right) => {
      const totalDelta = right.count * right.weight - left.count * left.weight
      if (totalDelta !== 0) return totalDelta
      const severityDelta = right.weight - left.weight
      if (severityDelta !== 0) return severityDelta
      return right.lastAt - left.lastAt
    })
    .slice(0, MAX_SIGNALS)
}

function renderSignals(signals: readonly FrictionSignal[], windowDays: number): string {
  const lines = [`Window: last ${String(windowDays)} days.`, '']
  for (const signal of signals) {
    lines.push(`- ${signal.kind} (${signal.level}) × ${String(signal.count)}, last at ${new Date(signal.lastAt).toISOString()}`)
    for (const sample of signal.samples) lines.push(`    ${sample.slice(0, 240)}`)
  }
  return lines.join('\n')
}

async function collectText(
  deps: RetrospectiveDeps,
  prompt: string,
): Promise<{ ok: true; text: string; tokensUsed: number } | { ok: false; why: string; tokensUsed: number }> {
  const budgetMs = deps.timeoutMs ?? RETRO_TIMEOUT_MS
  try {
    return await withDeadline(async (signal) => {
      const byIndex = new Map<number, string>()
      let tokensUsed = 0
      const chunks = deps.llm!.stream({
        provider: deps.route!.provider,
        model: deps.route!.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: RETRO_MAX_TOKENS,
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
            return { ok: false as const, why: `stream finished (${reason.kind})${detail === undefined ? '' : `: ${detail}`}`, tokensUsed }
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
 * One retrospective. Never throws.
 *
 * The note it writes is a plain `session` note scoped to the project, which is
 * what `ctx_search` surfaces and `ctx_note` can retire — the same lifetime as any
 * other pending intention, because that is exactly what "here is what to fix"
 * is.
 */
export async function runRetrospectiveTick(deps: RetrospectiveDeps): Promise<RetrospectiveOutcome> {
  const now = (deps.now ?? Date.now)()
  const stop = (reason: RetrospectiveOutcome['reason'], extra: Partial<RetrospectiveOutcome> = {}): RetrospectiveOutcome =>
    ({ rows: 0, signals: 0, tokensUsed: 0, ...extra, reason })
  if (deps.stores === undefined) return stop('stores-unavailable')
  if (deps.llm === undefined || deps.route === undefined) return stop('no-route')

  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS
  const since = now - windowMs
  // Counting and sampling are separate reads on purpose.
  //
  // `listJournal` takes a LIMIT and orders newest-first, so using it as the
  // window silently caps the window at N rows: measured on this installation,
  // a 7-day window and a 30-day window both returned exactly 2,000 rows out of
  // 16,463, and the friction count collapsed to whatever happened to be in the
  // newest slice. `journalByKind` aggregates in SQL, so the counts are the real
  // ones; the samples are then pulled per kind with a small limit, which is the
  // only place a cap is harmless.
  const counts = deps.stores.journalByKind(since)
  const totalRows = counts.reduce((sum, row) => sum + Number(row.count), 0)
  if (totalRows === 0) {
    deps.journal.info('dream-retro', 'retrospective: the journal is empty in this window', { since })
    return stop('empty-window')
  }

  const signals = collectFriction(
    counts.map(row => ({ kind: String(row.kind), level: String(row.level), summary: '', at: now })),
  ).map((signal) => {
    // Fill the samples from a narrow per-kind read. Bounded and ordered
    // newest-first, which is what a sample is for.
    const sampleRows = deps.stores!.listJournal({
      since,
      kinds: [signal.kind as never],
      levels: [signal.level as never],
      limit: SAMPLE_LIMIT,
    })
    return {
      ...signal,
      lastAt: sampleRows[0]?.at ?? now,
      samples: sampleRows.map(row => row.summary),
    } satisfies FrictionSignal
  })

  if (signals.length === 0) {
    // Nothing cost anything. Reporting that IS the retrospective; paying a model
    // to say "nothing happened" is how a nightly task becomes noise.
    deps.journal.info('dream-retro', 'retrospective: no friction in this window', { rows: totalRows })
    return { rows: totalRows, signals: 0, tokensUsed: 0, reason: 'no-friction' }
  }

  const windowDays = Math.round(windowMs / 86_400_000)
  const prompt = `${RETRO_INSTRUCTION}\n\nSignals:\n${renderSignals(signals, windowDays)}`
  const call = await collectText(deps, prompt)
  if (!call.ok) {
    deps.journal.warn('dream-retro', `retrospective: call failed, no note written: ${call.why}`, {
      rows: totalRows, signals: signals.length, tokensUsed: call.tokensUsed,
    })
    return { rows: totalRows, signals: signals.length, tokensUsed: call.tokensUsed, reason: 'llm-failed' }
  }

  let noteId: number | undefined
  if (deps.writeNote !== false) {
    try {
      const note = deps.stores.createNote({
        content: call.text.trim(),
        type: 'session',
        ...deps.identity === undefined ? {} : { projectPath: deps.identity },
      }, now)
      noteId = note.id
    } catch (error) {
      // A failed note write does not invalidate the analysis: report the summary
      // and let the caller decide. Journaling it keeps the failure visible.
      deps.journal.warn('dream-retro', `retrospective: could not store the note: ${String(error)}`, { rows: totalRows })
    }
  }

  deps.journal.info(
    'dream-retro',
    `retrospective: wrote ${noteId === undefined ? 'no note' : `note #${String(noteId)}`} from ${String(signals.length)} signals`,
    {
      rows: totalRows, signals: signals.length,
      ...noteId === undefined ? {} : { noteId },
      tokensUsed: call.tokensUsed,
    },
  )
  return {
    rows: totalRows,
    signals: signals.length,
    summary: call.text.trim(),
    ...noteId === undefined ? {} : { noteId },
    tokensUsed: call.tokensUsed,
  }
}
