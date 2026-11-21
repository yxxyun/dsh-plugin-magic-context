/**
 * Emergency fail-closed — ported from upstream `evaluateEmergencyFailClosed`
 * (transform-postprocess-phase.ts:1901).
 *
 * What this decides: at emergency pressure, whether to SEND the request at all,
 * or to refuse and surface the overflow instead of asking the provider and
 * burning a round trip on a 400.
 *
 * The rules, in the order upstream applies them:
 *
 *   1. A final wire that is REFUSAL-grade over the limit aborts regardless of
 *      arming or pressure — sending it cannot succeed.
 *   2. Arming plus trusted evidence that the wire now fits under 80% of the
 *      proven limit DISARMS: the session recovered, so the latch must not keep
 *      refusing on the strength of a measurement that no longer holds.
 *   3. Below 95% pressure nothing aborts.
 *   4. Otherwise abort only when armed BY A PROVIDER OVERFLOW and this pass did
 *      not fold. Without route-specific proof that the request does not fit, a
 *      conservative estimate is not enough to refuse — the previous behaviour of
 *      refusing on estimates is exactly what this replaces.
 *
 * Pure and total: no clock, no I/O, no throwing.
 */

export type EmergencyFailClosedReason =
  | 'below-emergency-band'
  | 'provider-overflow-abort'
  | 'proceed'
  | 'refusal-grade-final-wire-over-limit'
  | 'trusted-final-wire-disarm'

export interface EmergencyFailClosedDecision {
  readonly shouldAbort: boolean
  readonly reason: EmergencyFailClosedReason
  /** Trusted current-pass evidence that lets the caller clear its durable latch. */
  readonly disarm?: { readonly finalWireTokens: number; readonly provenLimitTokens: number }
  readonly refusalMessage?: string
}

export interface FinalWireEstimate {
  readonly tokens: number
  /** False means "a guess"; a guess may not abort and may not disarm. */
  readonly trusted: boolean
  readonly refusalGrade?: boolean
  readonly refusalTokens?: number
}

export interface EmergencyFailClosedInput {
  readonly usagePercentage: number
  readonly emergencyRecoveryArmed: boolean
  readonly emergencyRecoveryOrigin: 'provider_overflow' | 'proactive_model_shrink' | null
  readonly foldMaterializedThisPass: boolean
  /**
   * Whether uncompressed history remains for the historian to digest.
   *
   * Decides WHICH refusal notice applies, never whether to refuse: a request over
   * the proven limit cannot be sent either way. Omitted reads as "none left",
   * which is the safe reading — it tells the person to change models rather than
   * to retry a send that would fail again.
   */
  readonly historyRemains?: boolean
  readonly finalWireEstimate?: FinalWireEstimate
  /** A limit parsed from a provider overflow response, never a catalog default. */
  readonly providerProvenLimitTokens?: number
  readonly contextLimitTokens?: number
  readonly protectedToolTokens?: number
}

/** The pressure at which emergency rules start applying. */
export const EMERGENCY_BAND_PERCENTAGE = 95
/** Below this share of the proven limit, a trusted measurement disarms the latch. */
export const DISARM_RATIO = 0.8

/**
 * Two notices, because the two situations need different actions from the person
 * reading them.
 *
 * Upstream draws the same distinction (`dreamer`-adjacent `recovery-fit.ts`,
 * added after v0.49.41): a request the historian can still shrink deserves "send
 * again", while one it cannot deserves "this model will not fit this
 * conversation". A single message saying "refused, too long" is accurate in both
 * cases and useless in both.
 */
export const REFUSAL_NOTICE_RECOVERABLE =
  'Magic Context: this message would exceed the context window, and older history '
  + 'is still being summarized so it fits. Send it again to continue.'

export const REFUSAL_NOTICE_EXHAUSTED =
  'Magic Context: this conversation no longer fits the context window and there is '
  + 'no older history left to summarize. Switch to a model with a larger window to continue.'

/**
 * Whether a refusal is justified, and what to say.
 *
 * Two conditions, not one. A request over the limit can still be saved by
 * dropping reclaimable tool output, so "over the limit" alone is NOT proof it
 * cannot be sent. Only when the results that may NOT be dropped already exceed
 * the limit is the turn hopeless — upstream states the rule at
 * `emergency-fail-closed.ts:71`:
 *
 *   "Only protected results that cannot fit by themselves justify a new healthy
 *    refusal. Other pressure keeps the provider-overflow and fold behavior: a
 *    complete estimate ... is not a new reason to stop a turn whose protected
 *    results fit."
 *
 * Without the second condition this refuses turns that would have fit after a
 * reclaim — and since the calibrated estimate runs +17.6% above actual (p90
 * +19.4%), a bare `> limit` test refuses several percent of legal requests.
 */
function refusalMessageFor(
  estimate: FinalWireEstimate | undefined,
  limit: number | undefined,
  protectedTokens: number | undefined,
  historyRemains: boolean,
): string | undefined {
  if (estimate === undefined || estimate.refusalGrade !== true) return undefined
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return undefined
  const tokens = estimate.refusalTokens ?? estimate.tokens
  if (!Number.isFinite(tokens) || tokens <= limit) return undefined
  // The half that makes the refusal honest. An unmeasured protected tail proves
  // nothing, so the absence of the number keeps the turn alive.
  if (protectedTokens === undefined || !Number.isFinite(protectedTokens) || protectedTokens <= limit) return undefined
  const protectedNote = protectedTokens === undefined
    ? ''
    : ` (${String(protectedTokens)} of it is the protected tail, which cannot be reclaimed)`
  const detail = `about ${String(Math.round(tokens))} tokens against a proven limit of ${String(limit)}${protectedNote}`
  return historyRemains
    ? `${REFUSAL_NOTICE_RECOVERABLE} ${detail}.`
    : `${REFUSAL_NOTICE_EXHAUSTED} ${detail}.`
}

export function evaluateEmergencyFailClosed(
  input: EmergencyFailClosedInput,
): EmergencyFailClosedDecision {
  const estimate = input.finalWireEstimate
  const limit = input.providerProvenLimitTokens
  const refusalMessage = refusalMessageFor(
    estimate,
    input.contextLimitTokens ?? limit,
    input.protectedToolTokens,
    input.historyRemains === true,
  )
  if (refusalMessage !== undefined) {
    return { shouldAbort: true, reason: 'refusal-grade-final-wire-over-limit', refusalMessage }
  }
  if (
    input.emergencyRecoveryArmed
    && estimate?.trusted === true
    && Number.isFinite(estimate.tokens)
    && estimate.tokens > 0
    && typeof limit === 'number'
    && Number.isFinite(limit)
    && limit > 0
    && estimate.tokens < limit * DISARM_RATIO
  ) {
    return {
      shouldAbort: false,
      reason: 'trusted-final-wire-disarm',
      disarm: { finalWireTokens: estimate.tokens, provenLimitTokens: limit },
    }
  }
  if (input.usagePercentage < EMERGENCY_BAND_PERCENTAGE) {
    return { shouldAbort: false, reason: 'below-emergency-band' }
  }
  const shouldAbort =
    input.emergencyRecoveryArmed
    && input.emergencyRecoveryOrigin === 'provider_overflow'
    && !input.foldMaterializedThisPass
  return { shouldAbort, reason: shouldAbort ? 'provider-overflow-abort' : 'proceed' }
}
