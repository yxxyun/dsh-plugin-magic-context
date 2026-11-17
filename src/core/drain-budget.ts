/**
 * Drain budget — ported from upstream
 * `packages/plugin/src/features/magic-context/storage-meta-persisted.ts`
 * (mc-upstream a1ca346), `protectedTailWindowBudget` +
 * `getProtectedTailDrainBudgetSkip`, and the per-run caps from
 * `hooks/magic-context/protected-tail-boundary.ts`.
 *
 * Why a budget at all: an execute band that can always run will always run. A
 * rolling window caps how much reclaim one session may perform per 10 minutes,
 * so a pass that cannot make progress costs nothing instead of firing on every
 * step. Upstream measured the same problem; this is its shape.
 *
 * Kept pure: the caller owns the clock and the persistence. `now` is always an
 * argument, never `Date.now()`.
 */

/** Rolling window over which drain tokens are accounted. */
export const DRAIN_WINDOW_MS = 10 * 60 * 1000

const NON_EMERGENCY_MAX_CAP = 250_000
const FORCE80_MAX_CAP = 500_000
const FORCE95_MAX_CAP = 750_000

/** Tokens one drain run may target. Upstream: 2N/3N/4N floored, ratio capped. */
export function selectPerRunCap(
  usagePercentage: number,
  usable: number,
  protectedNodes: number,
): number {
  const nodes = Number.isFinite(protectedNodes) && protectedNodes > 0 ? protectedNodes : 8
  const u = Number.isFinite(usable) && usable > 0 ? usable : 1
  if (usagePercentage >= 95)
    return Math.min(FORCE95_MAX_CAP, Math.max(4 * nodes, Math.min(Math.round(0.5 * u), 250_000)))
  if (usagePercentage >= 80)
    return Math.min(FORCE80_MAX_CAP, Math.max(3 * nodes, Math.min(Math.round(0.35 * u), 150_000)))
  return Math.min(NON_EMERGENCY_MAX_CAP, Math.max(2 * nodes, Math.min(Math.round(0.25 * u), 100_000)))
}

/**
 * Total tokens a session may reclaim inside one rolling window.
 * Upstream `protectedTailWindowBudget` verbatim: three usage tiers.
 */
export function protectedTailWindowBudget(
  usagePercentage: number,
  usable: number,
  perRunCap: number,
): number {
  const u = Number.isFinite(usable) && usable > 0 ? usable : 1
  const cap = Number.isFinite(perRunCap) && perRunCap > 0 ? perRunCap : 1
  if (usagePercentage >= 95) return Math.min(1_000_000, Math.max(4 * cap, Math.round(0.5 * u)))
  if (usagePercentage >= 80) return Math.min(750_000, Math.max(3 * cap, Math.round(0.35 * u)))
  return Math.min(500_000, Math.max(cap, Math.round(0.2 * u)))
}

/** Persisted per-session drain accounting (one row per session). */
export interface DrainWindowState {
  /** When the current window opened; 0 = no window yet. */
  readonly windowStartedAt: number
  /** Tokens reclaimed during the current window. */
  readonly spentTokens: number
}

export const EMPTY_DRAIN_WINDOW: DrainWindowState = { windowStartedAt: 0, spentTokens: 0 }

export interface DrainAdmission {
  /** True when this pass must NOT run its drop work. */
  readonly skip: boolean
  /** Why, for the journal. */
  readonly reason: 'window-active' | 'budget-spent'
  readonly spentTokens: number
  readonly limitTokens: number
  /** Epoch ms when the window resets (and the budget is fresh again). */
  readonly resetsAt: number
}

/**
 * Cheap admission check. Returns null when the pass may proceed.
 *
 * A spent budget is a HOLD, not a stop: nothing is charged here, and the caller
 * must not reset the window on a skip.
 */
export function drainAdmission(args: {
  readonly state: DrainWindowState
  readonly usagePercentage: number
  readonly usable: number
  readonly perRunCap: number
  readonly now: number
}): DrainAdmission | null {
  const { state, now } = args
  const startedAt = state.windowStartedAt
  // No window, or a window that has already rolled over: fresh budget.
  if (startedAt <= 0 || startedAt > now || now - startedAt >= DRAIN_WINDOW_MS) return null
  const limitTokens = protectedTailWindowBudget(args.usagePercentage, args.usable, args.perRunCap)
  if (state.spentTokens < limitTokens) return null
  return {
    skip: true,
    reason: 'budget-spent',
    spentTokens: state.spentTokens,
    limitTokens,
    resetsAt: startedAt + DRAIN_WINDOW_MS,
  }
}

/**
 * Charge a completed drain run. Opens a window when none is live, rolls over an
 * expired one, and accumulates otherwise. A run that reclaimed nothing is
 * charged nothing — the budget measures work, not attempts.
 */
export function chargeDrain(
  state: DrainWindowState,
  reclaimedTokens: number,
  now: number,
): DrainWindowState {
  const spent = Number.isFinite(reclaimedTokens) && reclaimedTokens > 0 ? Math.round(reclaimedTokens) : 0
  const live = state.windowStartedAt > 0 && state.windowStartedAt <= now
    && now - state.windowStartedAt < DRAIN_WINDOW_MS
  if (!live) return { windowStartedAt: now, spentTokens: spent }
  return { windowStartedAt: state.windowStartedAt, spentTokens: state.spentTokens + spent }
}
