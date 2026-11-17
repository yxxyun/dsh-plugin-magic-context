/**
 * Work metrics — growth versus peak context.
 *
 * The two numbers answer different questions and the compaction engine needs the
 * distinction: `totalInputTokens` is what the context had to hold at its worst
 * within each phase, `newWorkTokens` is how much the conversation actually grew.
 * A session re-reading a stable prefix raises the first without the second.
 *
 * Pinned here:
 *  - prompt = input + cache.read + cache.write (the whole context, not just
 *    the uncached slice);
 *  - a shrinking prompt is a compaction: it opens a new phase and contributes 0
 *    to growth, never a negative number;
 *  - the phase peak does not count a post-drop row of a later phase that never
 *    recovered above zero;
 *  - the incremental carry produces exactly what a cold fold produces.
 */
import { describe, expect, it } from 'vitest'
import {
  computeWorkMetrics,
  computeWorkMetricsIncremental,
  emptyWorkMetricsCarry,
  toAssistantUsageRow,
  type AssistantUsageRow,
} from '../src/core/work-metrics.ts'

/** Build a row from the three token columns, the way `usage_records` stores them. */
function row(seq: number, input: number, cacheRead: number, output: number, cacheWrite = 0): AssistantUsageRow {
  return toAssistantUsageRow({
    seq,
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
  })
}

describe('toAssistantUsageRow', () => {
  it('treats prompt as input + cache.read + cache.write', () => {
    const mapped = toAssistantUsageRow({
      seq: 1,
      inputTokens: 100,
      cacheReadTokens: 900,
      cacheWriteTokens: 50,
      outputTokens: 7,
    })
    expect(mapped.prompt).toBe(1_050)
    expect(mapped.output).toBe(7)
  })

  it('treats absent columns as zero rather than unknown', () => {
    const mapped = toAssistantUsageRow({ seq: 1 })
    expect(mapped.prompt).toBe(0)
    expect(mapped.output).toBe(0)
  })
})

describe('computeWorkMetrics', () => {
  it('returns zeros for an empty session', () => {
    expect(computeWorkMetrics([])).toEqual({ newWorkTokens: 0, totalInputTokens: 0 })
  })

  it('counts growth as the sum of positive prompt deltas plus the last output', () => {
    // 100 → 200 → 300: deltas 100 + 100 + 100 (first row against 0), last output 5.
    const metrics = computeWorkMetrics([
      row(1, 0, 100, 3),
      row(2, 0, 200, 4),
      row(3, 0, 300, 5),
    ])
    expect(metrics.newWorkTokens).toBe(100 + 100 + 100 + 5)
    // One phase, peak 300.
    expect(metrics.totalInputTokens).toBe(300)
  })

  it('treats a shrinking prompt as a new phase with no growth', () => {
    // 1000 → 300 is a compaction: delta 0, and the phase peak restarts.
    const metrics = computeWorkMetrics([
      row(1, 0, 1_000, 1),
      row(2, 0, 300, 2),
      row(3, 0, 500, 3),
    ])
    // deltas: 1000, 0, 200; plus last output 3.
    expect(metrics.newWorkTokens).toBe(1_000 + 200 + 3)
    // phase peaks: 1000 (closed) + 500 (open) = 1500.
    expect(metrics.totalInputTokens).toBe(1_500)
  })

  it('does not let a single phase peak count twice across a drop', () => {
    const metrics = computeWorkMetrics([
      row(1, 0, 800, 0),
      row(2, 0, 800, 0),
      row(3, 0, 100, 0),
      row(4, 0, 100, 0),
    ])
    // totalInput counts peak 800 + peak 100, not every step.
    expect(metrics.totalInputTokens).toBe(900)
  })

  it('falls back to a flat prompt when everything is identical', () => {
    const metrics = computeWorkMetrics([row(1, 0, 500, 1), row(2, 0, 500, 1), row(3, 0, 500, 1)])
    // Only the first row grows (500 against 0); the rest contribute 0.
    expect(metrics.newWorkTokens).toBe(500 + 1)
    expect(metrics.totalInputTokens).toBe(500)
  })
})

describe('computeWorkMetricsIncremental', () => {
  const rows = [
    row(1, 0, 100, 3),
    row(2, 0, 400, 4),
    row(3, 0, 150, 5), // compaction, new phase
    row(4, 0, 600, 6),
    row(5, 0, 700, 7),
  ]

  it('matches the cold fold no matter how the rows are split', () => {
    const cold = computeWorkMetrics(rows)
    for (const split of [1, 2, 3, 4]) {
      const carry = emptyWorkMetricsCarry()
      computeWorkMetricsIncremental(rows.slice(0, split), carry)
      const { metrics } = computeWorkMetricsIncremental(rows, carry)
      expect(metrics).toEqual(cold)
    }
  })

  it('is idempotent when called again with no new rows', () => {
    const carry = emptyWorkMetricsCarry()
    const first = computeWorkMetricsIncremental(rows, carry).metrics
    const second = computeWorkMetricsIncremental(rows, carry).metrics
    expect(second).toEqual(first)
  })

  it('does not commit the newest row into the carry', () => {
    // The watermark must stop at the second-to-last row so a still-streaming
    // final step can be re-read rather than frozen at a partial value.
    const carry = emptyWorkMetricsCarry()
    computeWorkMetricsIncremental(rows, carry)
    expect(carry.lastSeq).toBe(rows[rows.length - 2]!.seq)
  })

  it('picks up a finalised last row on the next call', () => {
    const carry = emptyWorkMetricsCarry()
    computeWorkMetricsIncremental(rows, carry)
    // The last step's usage was partial (output 7 → 70 once it finished).
    const updated = [...rows.slice(0, -1), row(5, 0, 700, 70)]
    const { metrics } = computeWorkMetricsIncremental(updated, carry)
    expect(metrics).toEqual(computeWorkMetrics(updated))
  })
})
