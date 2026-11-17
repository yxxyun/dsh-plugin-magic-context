/**
 * Post-drop projection — the decision upstream makes before it decides whether
 * the expensive path is worth it.
 *
 * Ported in spirit from `hooks/magic-context/compartment-trigger.ts`
 * (mc-upstream a1ca346), where `estimateProjectedPostDropPercentage` answers one
 * question: *if this pass lands every drop it may land, does that alone bring
 * usage under the target?* If yes, the historian is redundant and is skipped
 * ("historian redundancy skip"); if no, only summarisation can help.
 *
 * This adapter had the two halves but never the projection, so a pass whose
 * drops were already exhausted still reported "work to do" and fired again on
 * the next step. Measured on the RCC ORC session 2026-11-17: 44 execute passes,
 * 40 of them with zero reclaim. The projection is what turns those into a single
 * escalation.
 *
 * Pure and total: no clock, no database, no I/O.
 */

/** Upstream `POST_DROP_TARGET_RATIO`: the target is 75% of the execute threshold. */
export const POST_DROP_TARGET_RATIO = 0.75

/**
 * Usage percent after landing `droppableTokens` of reclaim against `windowTokens`.
 * Returns null when the window is unknown, which callers must read as "cannot
 * project" — never as "no pressure".
 */
export function projectedPostDropPercentage(args: {
  readonly pressureTokens: number
  readonly droppableTokens: number
  readonly windowTokens: number | undefined
}): number | null {
  const { windowTokens } = args
  if (windowTokens === undefined || !Number.isFinite(windowTokens) || windowTokens <= 0) return null
  const pressure = Number.isFinite(args.pressureTokens) ? Math.max(0, args.pressureTokens) : 0
  const droppable = Number.isFinite(args.droppableTokens) ? Math.max(0, args.droppableTokens) : 0
  return (Math.max(0, pressure - droppable) / windowTokens) * 100
}

/** Upstream target: drops are "enough" when they land at or below this percentage. */
export function postDropTargetPercentage(executeThresholdPercentage: number): number {
  const threshold = Number.isFinite(executeThresholdPercentage) ? executeThresholdPercentage : 65
  return threshold * POST_DROP_TARGET_RATIO
}

/**
 * Would landing every available drop bring usage to the post-drop target?
 *
 * `true`  → drops suffice; do not pay for a historian this pass.
 * `false` → drops cannot reach the target; summarisation is the only lever left.
 * `null`  → cannot project (no window yet); the caller keeps its old behaviour.
 */
export function dropsSuffice(args: {
  readonly pressureTokens: number
  readonly droppableTokens: number
  readonly windowTokens: number | undefined
  readonly executeThresholdPercentage: number
}): boolean | null {
  const projected = projectedPostDropPercentage(args)
  if (projected === null) return null
  return projected <= postDropTargetPercentage(args.executeThresholdPercentage)
}

/**
 * The escalation question this adapter needs: with drops exhausted, is
 * summarisation the only remaining lever?
 *
 * Distinct from `dropsSuffice` because a pass can be "not sufficient" yet still
 * have real work queued. This reports whether the *available* reclaim is
 * effectively nothing, which is what makes an execute band pointless.
 */
export function reclaimEffectivelyEmpty(
  droppableTokens: number,
  floorTokens = 1,
): boolean {
  const droppable = Number.isFinite(droppableTokens) ? droppableTokens : 0
  return droppable < Math.max(1, floorTokens)
}
