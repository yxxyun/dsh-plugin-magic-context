/**
 * Protected-tail token target — ported from upstream
 * `hooks/magic-context/protected-tail-boundary.ts:266`
 * (`deriveProtectedTailTokenTarget`, mc-upstream a1ca346).
 *
 * Upstream decides how much of the tail to PROTECT (never compress) from the
 * window and the live pressure, not from a fixed message count:
 *
 *     usable  = contextLimit x executeThreshold
 *     rawN    = usable x ALPHA x (1 - usage/100)
 *     floorN  = clamp(usable x FLOOR_RATIO, FLOOR_MIN, FLOOR_MAX)
 *     ceilingN= min(ABS_CAP, usable x MAX_USABLE_RATIO, usable - headroom)
 *     N       = clamp(rawN, min(floorN, ceilingN), ceilingN)
 *
 * The shape of it: the more pressure, the smaller the protected tail (rawN falls
 * as usage rises), but never below a floor that keeps the recent conversation
 * legible and never above a ceiling that would make compression pointless.
 *
 * The local adapter used a fixed node count (`historianProtectedNodes`), so the
 * same session protected 8 messages at 20% pressure and 8 messages at 90% — the
 * opposite of what the pressure reading is for.
 *
 * Pure and total: no clock, no I/O.
 */

const ALPHA = 0.3
const FLOOR_RATIO = 0.08
const FLOOR_MIN = 2_000
const FLOOR_MAX = 12_000
const ABS_CAP = 96_000
const MAX_USABLE_RATIO = 0.4
const RESERVED_HEADROOM_MIN = 1_000
const RESERVED_HEADROOM_RATIO = 0.02

export interface ProtectedTailTokenTarget {
  readonly usable: number
  readonly rawN: number
  readonly floorN: number
  readonly ceilingN: number
  readonly effectiveFloor: number
  readonly N: number
  readonly headroom: number
  readonly triggerBudget: number
  readonly reserve: number
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

export function deriveProtectedTailTokenTarget(args: {
  readonly contextLimit: number
  readonly executeThresholdPercentage: number
  readonly usagePercentage: number
  readonly triggerBudget?: number
}): ProtectedTailTokenTarget {
  const safeContextLimit =
    Number.isFinite(args.contextLimit) && args.contextLimit > 0 ? args.contextLimit : 128_000
  const safeThreshold = Number.isFinite(args.executeThresholdPercentage)
    ? Math.max(0, args.executeThresholdPercentage)
    : 65
  const usable = Math.max(1, Math.round((safeContextLimit * safeThreshold) / 100))
  const usage = clampPercentage(args.usagePercentage)
  // Upstream derives the trigger budget from the same usable window; the caller
  // may pass its own so the two never disagree.
  const triggerBudget = args.triggerBudget
    ?? Math.max(5_000, Math.min(50_000, Math.round(usable * 0.05)))
  const reserve = Math.max(RESERVED_HEADROOM_MIN, Math.round(usable * RESERVED_HEADROOM_RATIO))
  const rawN = Math.round(usable * ALPHA * (1 - usage / 100))
  const floorN = Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, Math.round(usable * FLOOR_RATIO)))
  const headroom = Math.min(triggerBudget + reserve, Math.floor(usable * 0.5))
  const ceilingN = Math.max(
    1,
    Math.min(ABS_CAP, Math.floor(usable * MAX_USABLE_RATIO), usable - headroom),
  )
  const effectiveFloor = Math.min(floorN, ceilingN)
  const N = Math.min(ceilingN, Math.max(effectiveFloor, rawN))
  return { usable, rawN, floorN, ceilingN, effectiveFloor, N, headroom, triggerBudget, reserve }
}

/**
 * Walk back from the tail accumulating tokens until `targetTokens` is covered,
 * and return how many nodes that is (at least 1).
 *
 * Upstream protects by ORDINAL (it can cut mid-message because it owns the raw
 * chunk reader). This adapter protects by node boundary, so the token target is
 * honoured approximately: the first node that would overshoot ends the window.
 */
export function protectedNodeCount(
  nodeTokens: readonly number[],
  targetTokens: number,
  minimum: number,
): number {
  if (nodeTokens.length === 0) return 0
  const target = Number.isFinite(targetTokens) ? Math.max(0, targetTokens) : 0
  const floor = Math.max(0, Math.min(minimum, nodeTokens.length))
  let acc = 0
  let count = 0
  for (let index = nodeTokens.length - 1; index >= 0; index -= 1) {
    acc += nodeTokens[index] ?? 0
    count += 1
    // Stop once the target is covered — the node that crosses it is included,
    // because a node cannot be split. The floor is a hard minimum.
    if (count >= floor && acc >= target) break
  }
  return Math.max(count, Math.min(floor, nodeTokens.length))
}
