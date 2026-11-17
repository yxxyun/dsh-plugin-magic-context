/**
 * Escalation bands — ported from upstream
 * `packages/plugin/src/shared/escalation-bands.ts` (mc-upstream a1ca346).
 *
 * Upstream does not expose `forceThreshold` as an independently settable knob:
 * the force band is DERIVED from the execute threshold, floored at 85%. That
 * derivation is what keeps the dead zone between "start reclaiming" and "do the
 * expensive thing" from collapsing: with `execute = 65` the force band is 85
 * (20 points), and no configuration can push it lower.
 *
 * This adapter shipped `forceThreshold` as a free-standing percentage, so a
 * setting like `execute = 50, force = 60` was expressible — a 10-point dead zone
 * in which the execute band has nothing left to drop and fires on every step.
 * Measured 2026-11-17 on the RCC ORC session: 44 execute passes in 80 minutes,
 * 43 of them with `landed = retired = forceDropped = 0`.
 *
 * The fix keeps the field (an operator may want MORE headroom than upstream
 * derives) but redefines it as a FLOOR: the effective force band is
 * `max(derived, configured)`. A configured value below the derived one is
 * ignored, which is exactly upstream's behaviour.
 */

/** Highest execute threshold upstream will honour before clamping. */
export const MAX_EXECUTE_THRESHOLD = 90

/** The absolute wall: at or above this, emergency reclaim is unconditional. */
export const ABSOLUTE_EMERGENCY_PERCENTAGE = 95

export interface EscalationBands {
  /** Usage percent at which materialization (historian + compaction) fires. */
  readonly forceMaterializationPercentage: number
  /** Usage percent at which emergency reclaim fires regardless of anything else. */
  readonly emergencyPercentage: number
}

/**
 * Derive the escalation bands from the effective execute threshold.
 * Upstream: `forceMaterializationPercentage = Math.max(85, threshold + 2)`.
 */
export function escalationBands(effectiveThresholdPercentage: number): EscalationBands {
  const threshold = Number.isFinite(effectiveThresholdPercentage)
    ? Math.min(Math.max(0, effectiveThresholdPercentage), MAX_EXECUTE_THRESHOLD)
    : 65
  return {
    forceMaterializationPercentage: Math.max(85, threshold + 2),
    emergencyPercentage: ABSOLUTE_EMERGENCY_PERCENTAGE,
  }
}

/**
 * The force band actually in force for this policy.
 *
 * `policy.forceThreshold` may only RAISE the derived band, never lower it. A
 * configuration beneath the derivation is ignored rather than rejected, so an
 * operator's stale setting cannot resurrect the dead zone upstream designed away.
 */
export function effectiveForceThreshold(policy: {
  readonly executeThreshold: number
  readonly forceThreshold: number
}): number {
  const derived = escalationBands(policy.executeThreshold).forceMaterializationPercentage
  const configured = Number.isFinite(policy.forceThreshold) ? policy.forceThreshold : derived
  return Math.max(derived, configured)
}
