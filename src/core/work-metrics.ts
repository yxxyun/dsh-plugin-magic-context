/**
 * Work metrics — how much *new* work a session has produced, versus how much
 * input it consumed in total. Ported from upstream `work-metrics.ts`.
 *
 * Why two numbers: a compaction decision needs to know whether the context is
 * growing because the conversation is doing new work, or because it is
 * re-reading the same prefix. `totalInputTokens` counts the latter;
 * `newWorkTokens` counts only the growth.
 *
 * Upstream derives both from OpenCode's `message` table with `json_extract` and
 * window functions. The DSH adapter already stores the same numbers in typed
 * columns (`usage_records.input_tokens`, `.output_tokens`, `.cache_read_tokens`,
 * `.cache_write_tokens`), so the SQL here is a plain scan — no JSON, no window
 * functions, no equivalence oracle needed.
 *
 * The semantics carried over verbatim, because compaction depends on them:
 *
 *  - **prompt** of a step = input + cache.read + cache.write. That is the whole
 *    context the provider had to look at, not just the uncached part.
 *  - **delta** of a step = max(0, prompt − previous prompt). A shrinking prompt
 *    is a compaction, not negative work.
 *  - **phase** = the stretch between two prompt drops. A drop means the context
 *    was rebuilt, so the peaks either side of it belong to different phases.
 *  - **totalInputTokens** = Σ phase peaks. Summing every step would count the
 *    same prefix once per step; the peak is what the context actually had to
 *    hold at its worst within each phase.
 *  - **newWorkTokens** = Σ deltas + the last step's output. Output is the work
 *    the model produced and is read back on the next step, so it belongs to the
 *    growth; only the final step's output is not already inside a later prompt.
 */

/** The two counters, in tokens. */
export interface WorkMetrics {
  readonly newWorkTokens: number
  readonly totalInputTokens: number
}

/** One assistant step's usage, as folded by {@link foldWorkMetricsRows}. */
export interface AssistantUsageRow {
  /** Ordering key: `usage_records.seq` (the store's append order). */
  readonly seq: number
  /** input + cache.read + cache.write. */
  readonly prompt: number
  readonly output: number
}

interface FoldState {
  prevPrompt: number
  /** Max qualifying prompt in the current (open) phase. */
  phasePeak: number
  /** Whether the current phase has at least one qualifying row. */
  phaseHasQualifying: boolean
  /** Summed peaks of already-closed qualifying phases. */
  closedPhaseSum: number
  lastOutput: number
  seen: boolean
}

/**
 * Resumable accumulator. Folding is a strictly left-to-right accumulation, so a
 * watermark makes the metric incremental: nothing before it can ever change.
 */
export interface WorkMetricsCarry {
  readonly state: FoldState
  /** Σ max(0, prompt − prevPrompt) across every folded row. */
  newWorkSum: number
  /** Watermark: the last folded row's `seq`, or -1 on a fresh carry. */
  lastSeq: number
}

export function emptyWorkMetricsCarry(): WorkMetricsCarry {
  return {
    state: {
      prevPrompt: 0,
      phasePeak: 0,
      phaseHasQualifying: false,
      closedPhaseSum: 0,
      lastOutput: 0,
      seen: false,
    },
    newWorkSum: 0,
    lastSeq: -1,
  }
}

function cloneCarry(carry: WorkMetricsCarry): WorkMetricsCarry {
  return { state: { ...carry.state }, newWorkSum: carry.newWorkSum, lastSeq: carry.lastSeq }
}

/**
 * Fold rows (which MUST be in ascending `seq` and strictly newer than the
 * carry's watermark) into the carry, mutating and returning it.
 *
 * @param rows - assistant usage rows, ascending by `seq`.
 * @param carry - accumulator; mutated in place.
 * @returns the same carry, extended.
 */
export function foldWorkMetricsRows(
  rows: readonly AssistantUsageRow[],
  carry: WorkMetricsCarry,
): WorkMetricsCarry {
  const st = carry.state
  for (const row of rows) {
    const cur = row.prompt
    const prev = st.prevPrompt

    carry.newWorkSum += Math.max(0, cur - prev)

    // A drop closes the current phase and opens the next; the dropping row
    // belongs to the NEW phase (upstream's inclusive cumulative phase_id).
    if (st.seen && cur < prev) {
      if (st.phaseHasQualifying) st.closedPhaseSum += st.phasePeak
      st.phasePeak = 0
      st.phaseHasQualifying = false
    }

    // A row qualifies for the phase peak unless it is a post-drop row of a
    // later phase that never recovered. Upstream: `prevPrompt > 0 OR phase_id = 0`.
    const qualifies = prev > 0 || !st.seen
    if (qualifies) {
      if (cur > st.phasePeak) st.phasePeak = cur
      st.phaseHasQualifying = true
    }

    st.lastOutput = row.output
    st.prevPrompt = cur
    st.seen = true
    carry.lastSeq = row.seq
  }
  return carry
}

/** Current metric value implied by the carry (cheap; no DB access). */
export function metricsFromCarry(carry: WorkMetricsCarry): WorkMetrics {
  const st = carry.state
  const totalInput = st.closedPhaseSum + (st.phaseHasQualifying ? st.phasePeak : 0)
  return {
    newWorkTokens: Math.max(0, Math.floor(carry.newWorkSum + (st.seen ? st.lastOutput : 0))),
    totalInputTokens: Math.max(0, Math.floor(totalInput)),
  }
}

/**
 * Compute both metrics for a whole session from its usage rows.
 *
 * Cold-start form: folds the entire list once. Callers that poll should hold a
 * {@link WorkMetricsCarry} and use {@link computeWorkMetricsIncremental}.
 *
 * @param rows - usage rows ascending by `seq`.
 */
export function computeWorkMetrics(rows: readonly AssistantUsageRow[]): WorkMetrics {
  return metricsFromCarry(foldWorkMetricsRows([...rows], emptyWorkMetricsCarry()))
}

/**
 * Map a usage record to the fold's input. Absent cache columns are zero, and a
 * missing `output_tokens` is zero — a step that recorded no output produced no
 * work, which is the honest reading rather than an unknown.
 */
export function toAssistantUsageRow(record: {
  readonly seq: number
  readonly inputTokens?: number | undefined
  readonly outputTokens?: number | undefined
  readonly cacheReadTokens?: number | undefined
  readonly cacheWriteTokens?: number | undefined
}): AssistantUsageRow {
  return {
    seq: record.seq,
    prompt: (record.inputTokens ?? 0) + (record.cacheReadTokens ?? 0) + (record.cacheWriteTokens ?? 0),
    output: record.outputTokens ?? 0,
  }
}

/**
 * Extend `carry` with rows newer than its watermark and return the metrics.
 *
 * The most recent row is deliberately NOT committed into the carry: a step's
 * usage is recorded when the step starts and can be finalised later, so freezing
 * it would persist a partial value. The watermark advances only through the
 * second-to-last row; the last row is re-folded each call into a throwaway clone
 * for the returned value. That keeps the result identical to a full re-scan
 * while the newest step may still be streaming.
 *
 * @param rows - usage rows ascending by `seq`, from the whole session.
 * @param carry - durable accumulator; mutated with all but the newest row.
 * @returns the carry and the metrics for the whole session.
 */
export function computeWorkMetricsIncremental(
  rows: readonly AssistantUsageRow[],
  carry: WorkMetricsCarry,
): { carry: WorkMetricsCarry; metrics: WorkMetrics } {
  const fresh = rows.filter(row => row.seq > carry.lastSeq)
  if (fresh.length === 0) return { carry, metrics: metricsFromCarry(carry) }

  if (fresh.length > 1) foldWorkMetricsRows(fresh.slice(0, -1), carry)
  const view = foldWorkMetricsRows([fresh[fresh.length - 1] as AssistantUsageRow], cloneCarry(carry))
  return { carry, metrics: metricsFromCarry(view) }
}
