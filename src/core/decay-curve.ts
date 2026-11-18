/**
 * Decay curve — ported verbatim from upstream
 * `hooks/magic-context/decay-curve.ts` (mc-upstream a1ca346).
 *
 * Each compartment renders at exactly one paraphrase tier per pass, chosen from
 * its age, its importance and how much room the history budget has. Upstream
 * models that as a continuous curve with a physical reading:
 *
 *     F = 2^((importance - 50) / 25)   importance 75 doubles the half-life
 *     H = (24 x F) / pressure          half-life in compartments at importance 50
 *     z = age / H                      normalized age
 *     tier = z < 0.201 ? P1 : z < 0.729 ? P2 : z < 1.322 ? P3 : z < 2.587 ? P4 : archived
 *
 * The Z boundaries are the geometric means of adjacent measured tier costs
 * (322/109/35/20/5 tokens) in log-cost space, not hand-picked numbers.
 *
 * The local adapter had a two-step approximation instead: `importance >= 80`
 * shifts one tier denser, `<= 20` one tier sparser, everything else linear in
 * age. That has no notion of budget pressure at all, so a tight history budget
 * could not relax the curve — the one thing the pressure term exists for.
 *
 * Pure and total: no clock, no I/O.
 */

/** Half-life (in compartments) for importance 50 at pressure 1. */
export const H50 = 24
/** Importance points needed to double the half-life (75 → 2x, 100 → 4x). */
export const D = 25
/** Max extra half-lives of P4 protection from full anchor overlap. */
export const G = 2

/** P1->P2, P2->P3, P3->P4, P4->archive: geometric means of adjacent tier costs. */
export const Z1 = 0.201
export const Z2 = 0.729
export const Z3 = 1.322
export const Z4 = 2.587

/** Pressure floor: prevents div-by-zero and caps relaxation at 10x. */
export const P_FLOOR = 0.1

/** Per-tier average token cost, indexed by tier number (1..5). Index 0 unused. */
export const TIER_COST = [0, 322, 109, 35, 20, 5] as const

export type Tier = 1 | 2 | 3 | 4 | 5

function halfLife(importance: number, budgetPressure: number): number {
  const imp = Math.max(1, Math.min(100, importance))
  const p = Math.max(budgetPressure, P_FLOOR)
  const F = 2 ** ((imp - 50) / D)
  return (H50 * F) / p
}

/**
 * Which paraphrase tier a compartment renders at, ignoring archive protection.
 * @param compartmentIndex 1-based position from newest (1 = newest).
 * @param importance 1..100 (historian-emitted decay rate).
 * @param budgetPressure 0.10..inf (computed once per pass via computeBudgetPressure).
 */
export function tier(compartmentIndex: number, importance: number, budgetPressure: number): Tier {
  const age = Math.max(compartmentIndex, 1) - 1
  const z = age / halfLife(importance, budgetPressure)
  if (z < Z1) return 1
  if (z < Z2) return 2
  if (z < Z3) return 3
  if (z < Z4) return 4
  return 5
}

/**
 * Whether a compartment should be archived (P5, not rendered). Anchor overlap
 * extends P4 protection by up to G half-lives; with `anchorOverlap = 0` this
 * reduces to `z >= Z4`.
 */
export function shouldArchive(
  compartmentIndex: number,
  importance: number,
  budgetPressure: number,
  anchorOverlap = 0,
): boolean {
  const age = Math.max(compartmentIndex, 1) - 1
  const z = age / halfLife(importance, budgetPressure)
  const o = Math.max(0, Math.min(1, anchorOverlap))
  return z >= Z4 + G * o
}

/** Final rendered tier: base tier, or archived when the archive predicate fires. */
export function renderedTier(
  compartmentIndex: number,
  importance: number,
  budgetPressure: number,
  anchorOverlap = 0,
): Tier {
  if (shouldArchive(compartmentIndex, importance, budgetPressure, anchorOverlap)) return 5
  return Math.min(tier(compartmentIndex, importance, budgetPressure), 4) as Tier
}

/**
 * Compute budget pressure for a render pass in one forward pass.
 *
 * Because `H` scales as 1/p, the count of compartments in each tier scales as
 * 1/p too, so the natural cost at pressure 1 divided by the budget IS the
 * pressure that brings the render down to budget.
 */
export function computeBudgetPressure(
  compartments: ReadonlyArray<{ index: number; importance: number }>,
  historyBudget: number,
): number {
  if (historyBudget <= 0) return 1
  let naturalCost = 0
  for (const compartment of compartments) {
    const natural = tier(compartment.index, compartment.importance, 1.0)
    // Archived compartments render as nothing, so they must not create phantom
    // pressure from bytes that will never appear in the prompt.
    naturalCost += natural >= 5 ? 0 : TIER_COST[natural]
  }
  if (naturalCost <= 0) return 1
  return Math.max(naturalCost / historyBudget, P_FLOOR)
}
