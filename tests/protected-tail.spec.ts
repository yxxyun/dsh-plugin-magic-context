/**
 * Protected-tail token target (upstream `deriveProtectedTailTokenTarget`,
 * protected-tail-boundary.ts:266). Each case mirrors an upstream branch, so a
 * divergence here is a divergence from the implementation this adapter claims to
 * follow — not a matter of taste.
 */
import { describe, expect, it } from 'vitest'
import { deriveProtectedTailTokenTarget, protectedNodeCount } from '../src/core/protected-tail.ts'

describe('deriveProtectedTailTokenTarget', () => {
  // 262144 x 50% = 131072 usable; ALPHA 0.3 -> rawN 39322 at 0% usage.
  const base = { contextLimit: 262_144, executeThresholdPercentage: 50 }

  it('shrinks the protected tail as pressure rises', () => {
    const low = deriveProtectedTailTokenTarget({ ...base, usagePercentage: 10 })
    const high = deriveProtectedTailTokenTarget({ ...base, usagePercentage: 80 })
    expect(low.rawN).toBeGreaterThan(high.rawN)
    expect(low.N).toBeGreaterThan(high.N)
  })

  it('never drops below the floor while pressure is extreme', () => {
    const extreme = deriveProtectedTailTokenTarget({ ...base, usagePercentage: 100 })
    // usable 131072 x FLOOR_RATIO 0.08 = 10486, inside [2000, 12000].
    expect(extreme.floorN).toBe(10_486)
    expect(extreme.N).toBe(extreme.effectiveFloor)
  })

  it('keeps the ceiling under the absolute cap and below 40% of usable', () => {
    const wide = deriveProtectedTailTokenTarget({
      contextLimit: 1_000_000,
      executeThresholdPercentage: 90,
      usagePercentage: 20,
    })
    expect(wide.ceilingN).toBeLessThanOrEqual(96_000)
    expect(wide.ceilingN).toBeLessThanOrEqual(Math.floor(wide.usable * 0.4))
  })

  it('reserves trigger budget plus headroom at the top of the window', () => {
    const target = deriveProtectedTailTokenTarget({ ...base, usagePercentage: 50 })
    // 131072 x 0.02 = 2621 > RESERVED_HEADROOM_MIN 1000.
    expect(target.reserve).toBe(2_621)
    expect(target.triggerBudget).toBe(6_554)
    expect(target.headroom).toBe(9_175)
  })

  it('falls back to sane numbers for a missing context limit', () => {
    const target = deriveProtectedTailTokenTarget({
      contextLimit: 0,
      executeThresholdPercentage: 65,
      usagePercentage: 0,
    })
    expect(target.usable).toBe(83_200) // 128000 x 0.65
    expect(target.N).toBeGreaterThan(0)
  })
})

describe('protectedNodeCount', () => {
  it('walks back until the token target is covered', () => {
    // Ten 1000-token nodes; a 3500 target needs four of them.
    const nodes = Array.from({ length: 10 }, () => 1_000)
    expect(protectedNodeCount(nodes, 3_500, 1)).toBe(4)
  })

  it('always keeps the minimum even when one node blows the target', () => {
    const nodes = Array.from({ length: 5 }, () => 50_000)
    expect(protectedNodeCount(nodes, 100, 3)).toBe(3)
  })

  it('protects everything when the target exceeds the surface', () => {
    const nodes = Array.from({ length: 6 }, () => 1_000)
    expect(protectedNodeCount(nodes, 999_999, 1)).toBe(6)
  })

  it('returns zero for an empty surface', () => {
    expect(protectedNodeCount([], 1_000, 3)).toBe(0)
  })
})
