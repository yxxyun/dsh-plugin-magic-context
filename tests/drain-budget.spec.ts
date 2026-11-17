import { describe, expect, it } from 'vitest'
import {
  DRAIN_WINDOW_MS,
  EMPTY_DRAIN_WINDOW,
  chargeDrain,
  drainAdmission,
  protectedTailWindowBudget,
  selectPerRunCap,
} from '../src/core/drain-budget.ts'

describe('selectPerRunCap — upstream 2N/3N/4N floors with ratio caps', () => {
  it('floors the non-emergency cap at 2x the protected node count', () => {
    // usable is tiny, so the floor wins.
    expect(selectPerRunCap(50, 10, 8)).toBe(16)
  })

  it('uses the 25% ratio when it exceeds the floor', () => {
    expect(selectPerRunCap(50, 100_000, 8)).toBe(25_000)
  })

  it('caps the ratio at 100k in the normal tier', () => {
    expect(selectPerRunCap(50, 10_000_000, 8)).toBe(100_000)
  })

  it('raises the floor to 3N and the ratio to 35% in the 80 tier', () => {
    expect(selectPerRunCap(80, 10, 8)).toBe(24)
    expect(selectPerRunCap(80, 100_000, 8)).toBe(35_000)
    expect(selectPerRunCap(80, 10_000_000, 8)).toBe(150_000)
  })

  it('raises the floor to 4N and the ratio to 50% in the 95 tier', () => {
    expect(selectPerRunCap(95, 10, 8)).toBe(32)
    expect(selectPerRunCap(95, 100_000, 8)).toBe(50_000)
    expect(selectPerRunCap(95, 10_000_000, 8)).toBe(250_000)
  })

  it('treats a non-positive node count as the 8 default', () => {
    expect(selectPerRunCap(50, 10, 0)).toBe(16)
  })
})

describe('protectedTailWindowBudget — three usage tiers', () => {
  it('uses the 20% ratio below 80', () => {
    expect(protectedTailWindowBudget(50, 100_000, 1_000)).toBe(20_000)
  })

  it('uses the 35% ratio from 80 to 94', () => {
    expect(protectedTailWindowBudget(80, 100_000, 1_000)).toBe(35_000)
    expect(protectedTailWindowBudget(94, 100_000, 1_000)).toBe(35_000)
  })

  it('uses the 50% ratio at or above 95', () => {
    expect(protectedTailWindowBudget(95, 100_000, 1_000)).toBe(50_000)
  })

  it('floors the budget at the per-run cap when the ratio is smaller', () => {
    expect(protectedTailWindowBudget(50, 1_000, 5_000)).toBe(5_000)
  })

  it('applies the 500k / 750k / 1M caps', () => {
    expect(protectedTailWindowBudget(50, 10_000_000, 1_000)).toBe(500_000)
    expect(protectedTailWindowBudget(80, 10_000_000, 1_000)).toBe(750_000)
    expect(protectedTailWindowBudget(95, 10_000_000, 1_000)).toBe(1_000_000)
  })
})

describe('drainAdmission — a hold, not a stop', () => {
  const now = 1_000_000
  const base = { usagePercentage: 55, usable: 100_000, perRunCap: 25_000, now }

  it('admits when there is no window yet', () => {
    expect(drainAdmission({ ...base, state: EMPTY_DRAIN_WINDOW })).toBeNull()
  })

  it('admits while the window still has budget', () => {
    const state = { windowStartedAt: now - 1_000, spentTokens: 5_000 }
    expect(drainAdmission({ ...base, state })).toBeNull()
  })

  it('holds once the window budget is spent', () => {
    // Budget at 55% with usable 100k and cap 25k is max(25k, 0.2*100k) = 25k.
    const state = { windowStartedAt: now - 1_000, spentTokens: 25_000 }
    const admission = drainAdmission({ ...base, state })
    expect(admission).not.toBeNull()
    expect(admission?.skip).toBe(true)
    expect(admission?.reason).toBe('budget-spent')
    expect(admission?.spentTokens).toBe(25_000)
    expect(admission?.limitTokens).toBe(25_000)
    expect(admission?.resetsAt).toBe(now - 1_000 + DRAIN_WINDOW_MS)
  })

  it('admits again once the window has rolled over', () => {
    const state = { windowStartedAt: now - DRAIN_WINDOW_MS - 1, spentTokens: 999_999 }
    expect(drainAdmission({ ...base, state })).toBeNull()
  })

  it('admits when the window start is in the future (clock moved backwards)', () => {
    const state = { windowStartedAt: now + 60_000, spentTokens: 999_999 }
    expect(drainAdmission({ ...base, state })).toBeNull()
  })
})

describe('chargeDrain — measures work, not attempts', () => {
  const now = 1_000_000

  it('opens a window on the first charge', () => {
    expect(chargeDrain(EMPTY_DRAIN_WINDOW, 4_000, now)).toEqual({
      windowStartedAt: now,
      spentTokens: 4_000,
    })
  })

  it('charges nothing for a pass that reclaimed nothing', () => {
    const opened = chargeDrain(EMPTY_DRAIN_WINDOW, 4_000, now)
    const after = chargeDrain(opened, 0, now + 1_000)
    expect(after.spentTokens).toBe(4_000)
    expect(after.windowStartedAt).toBe(now)
  })

  it('accumulates inside a live window', () => {
    const first = chargeDrain(EMPTY_DRAIN_WINDOW, 4_000, now)
    const second = chargeDrain(first, 6_000, now + 1_000)
    expect(second).toEqual({ windowStartedAt: now, spentTokens: 10_000 })
  })

  it('rolls the window over instead of accumulating across it', () => {
    const first = chargeDrain(EMPTY_DRAIN_WINDOW, 90_000, now)
    const later = now + DRAIN_WINDOW_MS
    expect(chargeDrain(first, 5_000, later)).toEqual({ windowStartedAt: later, spentTokens: 5_000 })
  })

  it('ignores a negative or non-finite reclaim', () => {
    const first = chargeDrain(EMPTY_DRAIN_WINDOW, 4_000, now)
    expect(chargeDrain(first, -1_000, now + 1).spentTokens).toBe(4_000)
    expect(chargeDrain(first, Number.NaN, now + 1).spentTokens).toBe(4_000)
  })
})

describe('budget behaviour under the measured 262144 window', () => {
  it('allows roughly one meaningful drain per 10 minutes, then holds', () => {
    // 55% of 262144 ≈ 144k usable; cap ≈ 36k; window budget ≈ 28.8k.
    const usable = Math.round(262_144 * 0.55)
    const cap = selectPerRunCap(55, usable, 8)
    const budget = protectedTailWindowBudget(55, usable, cap)
    const now = 1_000_000
    const spent = chargeDrain(EMPTY_DRAIN_WINDOW, 19_263, now)
    expect(drainAdmission({ state: spent, usagePercentage: 55, usable, perRunCap: cap, now: now + 1 })).toBeNull()
    const drained = chargeDrain(spent, budget, now + 2)
    const held = drainAdmission({ state: drained, usagePercentage: 55, usable, perRunCap: cap, now: now + 3 })
    expect(held?.skip).toBe(true)
  })
})
