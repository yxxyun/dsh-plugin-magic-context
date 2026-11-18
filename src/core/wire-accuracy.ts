/**
 * Estimate accuracy: how far the local chars/4 token estimate is from what the
 * provider actually billed.
 *
 * Why it matters: the emergency fail-closed gate may only DISARM on a trustworthy
 * wire measurement (`evaluateEmergencyFailClosed`'s `trusted` flag). The local
 * estimate is chars/4, which the code itself calls a guess — it ignores tool
 * definitions, image parts and the provider's own tokenizer. Until the ratio
 * between estimate and reality is known, no measurement can be trusted, so one
 * whole branch of the gate stays dark.
 *
 * This module turns accumulated samples into that ratio, so "trusted" becomes a
 * measured property instead of an argument. It is deliberately a separate,
 * pure step: the collection happens in the pass, the decision happens here.
 *
 * Upstream does not need this — it can count the final request's bytes exactly.
 * This adapter cannot, so it closes the gap statistically instead of pretending.
 */

export interface AccuracySample {
  /** What this adapter estimated for the surface, in tokens (chars/4). */
  readonly estimated: number
  /** What the provider reported actually billed for input. */
  readonly actual: number
}

export interface AccuracyReport {
  /** Samples that carried both numbers and were usable. */
  readonly samples: number
  /**
   * How much to multiply an estimate by to reach the truth. Median, not mean:
   * one huge request with an unusual provider counting must not move the factor
   * for every later decision.
   */
  readonly factor: number
  /** The 10th and 90th percentile factors — the honest spread. */
  readonly p10: number
  readonly p90: number
  /**
   * True when the spread is tight enough that `estimate x factor` is a usable
   * prediction. Requires at least {@link MIN_TRUSTED_SAMPLES} samples and a
   * p10..p90 band no wider than {@link MAX_TRUSTED_SPREAD}.
   */
  readonly trusted: boolean
  /** Why it is not trusted, when it is not. */
  readonly reason?: 'too-few-samples' | 'too-wide' | 'no-samples'
}

/** Below this many samples a median is a rumour. */
export const MIN_TRUSTED_SAMPLES = 30
/** A p90/p10 ratio wider than this means the estimate cannot be rescaled. */
export const MAX_TRUSTED_SPREAD = 1.35

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))
  return sorted[index] as number
}

/**
 * The factor a caller should apply to an estimate so it means what the provider
 * will bill. 1 when there is nothing to learn from.
 */
export function accuracyFactor(samples: readonly AccuracySample[]): number {
  return summarise(samples).factor
}

export function summarise(samples: readonly AccuracySample[]): AccuracyReport {
  const ratios: number[] = []
  for (const sample of samples) {
    if (!Number.isFinite(sample.estimated) || !Number.isFinite(sample.actual)) continue
    if (sample.estimated <= 0 || sample.actual <= 0) continue
    ratios.push(sample.actual / sample.estimated)
  }
  if (ratios.length === 0) {
    return { samples: 0, factor: 1, p10: 1, p90: 1, trusted: false, reason: 'no-samples' }
  }
  const sorted = [...ratios].sort((left, right) => left - right)
  const factor = percentile(sorted, 0.5)
  const p10 = percentile(sorted, 0.1)
  const p90 = percentile(sorted, 0.9)
  if (sorted.length < MIN_TRUSTED_SAMPLES) {
    return { samples: sorted.length, factor, p10, p90, trusted: false, reason: 'too-few-samples' }
  }
  if (p10 <= 0 || p90 / p10 > MAX_TRUSTED_SPREAD) {
    return { samples: sorted.length, factor, p10, p90, trusted: false, reason: 'too-wide' }
  }
  return { samples: sorted.length, factor, p10, p90, trusted: true }
}

/**
 * A wire estimate calibrated by the measured factor.
 *
 * `trusted` is only true when the samples justified it — passing an uncalibrated
 * number through with `trusted: true` would let a guess disarm the emergency
 * latch, which is exactly what the gate's rule forbids.
 */
export function calibratedWireEstimate(
  estimated: number,
  report: AccuracyReport,
): { readonly tokens: number; readonly trusted: boolean } {
  const tokens = Number.isFinite(estimated) && estimated > 0
    ? Math.round(estimated * report.factor)
    : 0
  return { tokens, trusted: report.trusted && tokens > 0 }
}

/**
 * Pair each pass's local estimate with the usage the provider reported for the
 * same session at the same moment.
 *
 * The estimate is recorded by the pass itself (`estSurfaceTokens`); the actual
 * number is `input_tokens + cache_read + cache_write`, which is also what
 * `pressurePercent` divides by.
 *
 * Direction matters: a pass runs and then the request it sized goes out, so the
 * matching usage row is the first one recorded AT OR AFTER the pass — not the
 * last one before it. Pairing backwards lines each estimate up with the previous
 * request's bill.
 *
 * Pure: the caller supplies both series, so this cannot silently read the wrong
 * store.
 */
/**
 * How long after a pass its request may be BILLED and still be the same request.
 *
 * A pass runs BEFORE the request and the usage row is written when the request
 * finishes, so the gap is the model's latency — measured at 124 and 137 seconds
 * on this host (2026-11-18). A 10-second window dropped most real pairs; the
 * structural guard is that no other pass may run in between (see the loop).
 */
export const PAIRING_WINDOW_MS = 300_000

export function pairEstimateSamples(
  passes: ReadonlyArray<{ readonly at: number; readonly estimated: number | undefined }>,
  usage: ReadonlyArray<{ readonly recordedAt: number; readonly inputTokens: number }>,
  windowMs = PAIRING_WINDOW_MS,
): AccuracySample[] {
  if (usage.length === 0) return []
  const sorted = [...usage].sort((left, right) => left.recordedAt - right.recordedAt)
  // The NEXT pass in time is the real upper bound: a `defer` or `reduce-nudge`
  // pass sends nothing, so a reading that arrives after another pass started
  // belongs to that one, not to this estimate.
  const ordered = [...passes].sort((left, right) => left.at - right.at)
  const samples: AccuracySample[] = []
  for (const [index, pass] of ordered.entries()) {
    if (pass.estimated === undefined || !Number.isFinite(pass.estimated) || pass.estimated <= 0) continue
    const nextPassAt = ordered[index + 1]?.at
    // First usage reading at or after the pass: the request it just sized.
    let picked: { recordedAt: number; inputTokens: number } | undefined
    for (const row of sorted) {
      if (row.recordedAt < pass.at) continue
      if (nextPassAt !== undefined && row.recordedAt >= nextPassAt) break
      picked = row
      break
    }
    if (picked === undefined) continue
    // A reading far after the pass belongs to a later request, whose estimate
    // this pass never produced.
    if (picked.recordedAt - pass.at > windowMs) continue
    if (!Number.isFinite(picked.inputTokens) || picked.inputTokens <= 0) continue
    samples.push({ estimated: pass.estimated, actual: picked.inputTokens })
  }
  return samples
}
