/**
 * Decay curve (upstream `decay-curve.ts`). These cases pin the properties the
 * curve is supposed to have, not just its arithmetic:
 *
 *   - more importance -> slower decay (longer half-life);
 *   - more budget pressure -> faster decay (the pressure term's whole purpose);
 *   - the tier boundaries are where the curve says they are;
 *   - archived compartments cost nothing in the pressure computation.
 */
import { describe, expect, it } from 'vitest'
import {
  computeBudgetPressure,
  H50,
  P_FLOOR,
  renderedTier,
  shouldArchive,
  tier,
  TIER_COST,
  Z1,
  Z2,
  Z3,
  Z4,
} from '../src/core/decay-curve.ts'

describe('tier curve', () => {
  it('renders the newest compartment at P1 regardless of importance', () => {
    expect(tier(1, 1, 1)).toBe(1)
    expect(tier(1, 100, 1)).toBe(1)
  })

  it('decays faster at lower importance', () => {
    // Same age, half the importance -> a denser tier.
    const low = tier(30, 20, 1)
    const high = tier(30, 90, 1)
    expect(low).toBeGreaterThan(high)
  })

  it('importance 75 doubles the half-life vs 50', () => {
    // At age H50 the (imp=50) compartment is at z=1 -> P3/P4 boundary area,
    // while imp=75 has z=0.5 -> still P2.
    expect(tier(H50, 50, 1)).toBe(3)
    expect(tier(H50, 75, 1)).toBe(2)
  })

  it('decays faster under higher budget pressure', () => {
    const relaxed = tier(20, 50, 1)
    const tight = tier(20, 50, 4)
    expect(tight).toBeGreaterThan(relaxed)
  })

  it('honours the pressure floor instead of dividing by zero', () => {
    // p is clamped to P_FLOOR, so pressure 0 behaves like 0.1 — relaxed.
    expect(tier(10, 50, 0)).toBe(tier(10, 50, P_FLOOR))
  })

  it('places the Z boundaries where the curve says', () => {
    // `tier(index)` uses age = index - 1, so the first index past a boundary is
    // ceil(Z * H) + 1: age = ceil(Z*H) >= Z*H.
    const h = H50 // importance 50, pressure 1
    expect(tier(Math.ceil(Z1 * h), 50, 1)).toBe(1)      // age just BELOW Z1
    expect(tier(Math.ceil(Z1 * h) + 1, 50, 1)).toBe(2)  // and just past it
    expect(tier(Math.ceil(Z2 * h) + 1, 50, 1)).toBe(3)
    expect(tier(Math.ceil(Z3 * h) + 1, 50, 1)).toBe(4)
  })

  it('treats importance out of range by clamping, not by trusting it', () => {
    expect(tier(5, 0, 1)).toBe(tier(5, 1, 1))
    expect(tier(5, 500, 1)).toBe(tier(5, 100, 1))
  })
})

describe('archive predicate', () => {
  it('archives only past Z4', () => {
    const h = H50
    expect(shouldArchive(Math.floor(Z4 * h), 50, 1)).toBe(false)
    expect(shouldArchive(Math.ceil(Z4 * h) + 1, 50, 1)).toBe(true)
  })

  it('anchor overlap extends P4 protection', () => {
    const h = H50
    const age = Math.ceil(Z4 * h) + 1
    expect(shouldArchive(age, 50, 1, 0)).toBe(true)
    expect(shouldArchive(age, 50, 1, 1)).toBe(false)
    // ...but only by G half-lives, so a much older one still archives.
    expect(shouldArchive(Math.ceil((Z4 + 3) * h) + 1, 50, 1, 1)).toBe(true)
  })

  it('renderedTier never reports an archived compartment as P1-P4', () => {
    expect(renderedTier(10_000, 1, 10)).toBe(5)
  })
})

describe('computeBudgetPressure', () => {
  it('is 1 for an empty or budget-less render', () => {
    expect(computeBudgetPressure([], 10_000)).toBe(1)
    expect(computeBudgetPressure([{ index: 1, importance: 50 }], 0)).toBe(1)
  })

  it('rises when the natural render would overshoot the budget', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ index: i + 1, importance: 50 }))
    const generous = computeBudgetPressure(many, 1_000_000)
    const tight = computeBudgetPressure(many, 400)
    expect(tight).toBeGreaterThan(generous)
  })

  it('does not charge phantom cost for archived compartments', () => {
    // All-archived input: natural cost 0 -> no pressure at all.
    const archived = Array.from({ length: 10 }, (_, i) => ({ index: 10_000 + i, importance: 1 }))
    expect(computeBudgetPressure(archived, 100)).toBe(1)
  })

  it('never reports less than the floor', () => {
    const one = [{ index: 1, importance: 100 }]
    expect(computeBudgetPressure(one, 1_000_000)).toBe(P_FLOOR)
  })

  it('charges the tier table the curve actually uses', () => {
    expect(TIER_COST[1]).toBe(322)
    expect(TIER_COST[4]).toBe(20)
    expect(TIER_COST[5]).toBe(5)
  })
})
