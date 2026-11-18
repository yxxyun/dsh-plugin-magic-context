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

function refusalMessageFor(
  estimate: FinalWireEstimate | undefined,
  limit: number | undefined,
  protectedTokens: number | undefined,
): string | undefined {
  if (estimate === undefined || estimate.refusalGrade !== true) return undefined
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return undefined
  const tokens = estimate.refusalTokens ?? estimate.tokens
  if (!Number.isFinite(tokens) || tokens <= limit) return undefined
  const protectedNote = protectedTokens === undefined
    ? ''
    : ` (${String(protectedTokens)} of it is the protected tail, which cannot be reclaimed)`
  return `Magic Context: the request would exceed the context window — about ${String(Math.round(tokens))} `
    + `tokens against a proven limit of ${String(limit)}${protectedNote}. Nothing more can be reclaimed; `
    + 'the request is refused instead of sending it to fail.'
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
