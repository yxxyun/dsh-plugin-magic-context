/**
 * Emergency drain latch — ported from upstream
 * `packages/plugin/src/features/magic-context/storage-meta-persisted.ts`
 * (mc-upstream a1ca346): `resolvedEmergencyDrainLatch`,
 * `emergencyDrainExitThreshold`, and the four constants around them.
 *
 * The problem it solves is "irreducible floor": system prompt + tool schemas +
 * protected tail can keep usage above the force band forever, so a usage-driven
 * exit never fires and the drain re-enters on every pass. The latch engages at
 * the force band and only releases when usage drops a full margin BELOW the
 * execute threshold — exactly at the threshold it would immediately re-enter.
 *
 * A 30-minute backstop releases it even if the floor never comes down.
 *
 * Pure: `now` is an argument; persistence is the caller's job.
 */

/** Hard expiry: release the latch after this long regardless of usage. */
export const EMERGENCY_DRAIN_MAX_LATCH_MS = 30 * 60 * 1000

/**
 * The latch releases when usage falls this far BELOW the execute threshold.
 * Exiting exactly at the threshold would immediately re-enter the force band.
 */
export const EMERGENCY_DRAIN_EXIT_MARGIN = 10

/** After a failed drain, hold off this long before admitting another. */
export const EMERGENCY_DRAIN_FAILURE_BACKOFF_MS = 60_000

/** Exit threshold when the execute threshold is unknown/0. */
export const EMERGENCY_DRAIN_FALLBACK_EXIT_PERCENTAGE = 55

/** Persisted per-session latch state. */
export interface DrainLatchState {
  /** Epoch ms the latch engaged; 0 = released. */
  readonly activeSince: number
  /** Epoch ms of the last failed drain run; 0 = none. */
  readonly failureAt: number
}

export const RELEASED_DRAIN_LATCH: DrainLatchState = { activeSince: 0, failureAt: 0 }

/** Usage percent below which the latch clears. */
export function emergencyDrainExitThreshold(executeThresholdPercentage: number): number {
  if (!Number.isFinite(executeThresholdPercentage) || executeThresholdPercentage <= 0) {
    return EMERGENCY_DRAIN_FALLBACK_EXIT_PERCENTAGE
  }
  return Math.max(0, executeThresholdPercentage - EMERGENCY_DRAIN_EXIT_MARGIN)
}

/**
 * Resolve the latch: engage at/above the force band, release once usage has
 * fallen below `execute - margin`, or after the hard expiry.
 *
 * Returns the new `activeSince` (0 = released).
 */
export function resolvedEmergencyDrainLatch(
  state: DrainLatchState,
  usagePercentage: number,
  forceBandPercentage: number,
  executeThresholdPercentage: number,
  now: number,
): number {
  if (usagePercentage >= forceBandPercentage) {
    return state.activeSince > 0 ? state.activeSince : now
  }
  const expired = state.activeSince > 0 && now - state.activeSince > EMERGENCY_DRAIN_MAX_LATCH_MS
  if (usagePercentage < emergencyDrainExitThreshold(executeThresholdPercentage) || expired) return 0
  return state.activeSince
}

/** True while a prior failure is still inside its backoff window. */
export function drainFailureBackoffActive(state: DrainLatchState, now: number): boolean {
  return (
    state.failureAt > 0
    && state.failureAt <= now
    && now - state.failureAt < EMERGENCY_DRAIN_FAILURE_BACKOFF_MS
  )
}

/**
 * Admission for a forced drain run. Offsets the latch and the failure backoff:
 * a latched session that just failed must wait out the backoff before retrying.
 */
export function forcedDrainAdmission(args: {
  readonly state: DrainLatchState
  readonly usagePercentage: number
  readonly forceBandPercentage: number
  readonly executeThresholdPercentage: number
  readonly now: number
}): { readonly latchActiveSince: number; readonly backoff: boolean; readonly admit: boolean } {
  const latchActiveSince = resolvedEmergencyDrainLatch(
    args.state,
    args.usagePercentage,
    args.forceBandPercentage,
    args.executeThresholdPercentage,
    args.now,
  )
  const backoff = drainFailureBackoffActive(args.state, args.now)
  return {
    latchActiveSince,
    backoff,
    admit: !(latchActiveSince > 0 && backoff),
  }
}
