import { describe, expect, it } from 'vitest'
import {
  POST_DROP_TARGET_RATIO,
  dropsSuffice,
  postDropTargetPercentage,
  projectedPostDropPercentage,
  reclaimEffectivelyEmpty,
} from '../src/core/drop-projection.ts'

describe('projectedPostDropPercentage', () => {
  it('projects the usage after landing the drops', () => {
    expect(projectedPostDropPercentage({
      pressureTokens: 160_000,
      droppableTokens: 30_000,
      windowTokens: 262_144,
    })).toBeCloseTo((130_000 / 262_144) * 100, 6)
  })

  it('returns null without a window — never 0', () => {
    expect(projectedPostDropPercentage({ pressureTokens: 1, droppableTokens: 1, windowTokens: undefined })).toBeNull()
    expect(projectedPostDropPercentage({ pressureTokens: 1, droppableTokens: 1, windowTokens: 0 })).toBeNull()
    expect(projectedPostDropPercentage({ pressureTokens: 1, droppableTokens: 1, windowTokens: Number.NaN })).toBeNull()
  })

  it('never projects below zero when drops exceed pressure', () => {
    expect(projectedPostDropPercentage({
      pressureTokens: 10_000,
      droppableTokens: 50_000,
      windowTokens: 100_000,
    })).toBe(0)
  })

  it('treats negative inputs as zero', () => {
    expect(projectedPostDropPercentage({
      pressureTokens: -5,
      droppableTokens: -5,
      windowTokens: 100_000,
    })).toBe(0)
  })
})

describe('postDropTargetPercentage', () => {
  it('is 75% of the execute threshold', () => {
    expect(POST_DROP_TARGET_RATIO).toBe(0.75)
    expect(postDropTargetPercentage(60)).toBeCloseTo(45, 6)
    expect(postDropTargetPercentage(55)).toBeCloseTo(41.25, 6)
  })

  it('falls back to 65 for a non-finite threshold', () => {
    expect(postDropTargetPercentage(Number.NaN)).toBeCloseTo(48.75, 6)
  })
})

describe('dropsSuffice', () => {
  const windowTokens = 262_144

  it('reports true when drops reach the target', () => {
    // 60% at 262144 = 157,286 tok. Dropping 60k lands at ~37%.
    expect(dropsSuffice({
      pressureTokens: Math.round(windowTokens * 0.6),
      droppableTokens: 60_000,
      windowTokens,
      executeThresholdPercentage: 60,
    })).toBe(true)
  })

  it('reports false when drops cannot reach the target', () => {
    // 60% pressure, only 1k droppable: still ~59.6% versus a 45% target.
    expect(dropsSuffice({
      pressureTokens: Math.round(windowTokens * 0.6),
      droppableTokens: 1_000,
      windowTokens,
      executeThresholdPercentage: 60,
    })).toBe(false)
  })

  it('returns null when the window is unknown', () => {
    expect(dropsSuffice({
      pressureTokens: 1,
      droppableTokens: 1,
      windowTokens: undefined,
      executeThresholdPercentage: 60,
    })).toBeNull()
  })
})

describe('reclaimEffectivelyEmpty — the starvation test', () => {
  it('is true for a pass that reclaimed nothing', () => {
    expect(reclaimEffectivelyEmpty(0, 1_310)).toBe(true)
  })

  it('is false for a pass that reclaimed a real amount', () => {
    expect(reclaimEffectivelyEmpty(19_263, 1_310)).toBe(false)
  })

  it('uses the floor as the boundary, exclusive', () => {
    expect(reclaimEffectivelyEmpty(1_309, 1_310)).toBe(true)
    expect(reclaimEffectivelyEmpty(1_310, 1_310)).toBe(false)
  })

  it('floors the threshold at 1 so a zero floor cannot report everything empty', () => {
    expect(reclaimEffectivelyEmpty(0, 0)).toBe(true)
    expect(reclaimEffectivelyEmpty(1, 0)).toBe(false)
  })

  it('treats a non-finite droppable amount as nothing', () => {
    expect(reclaimEffectivelyEmpty(Number.NaN, 1_310)).toBe(true)
  })
})

describe('the measured RCC ORC sequence', () => {
  // 2026-11-17, window 262144: 44 execute passes, 43 reclaiming 0 tokens.
  const windowTokens = 262_144
  const starvedFloor = Math.round(windowTokens * 0.005)

  it('classifies all 43 empty passes as starved and the one real pass as not', () => {
    const reclaims = [19_263, ...Array.from({ length: 43 }, () => 0)]
    const starved = reclaims.map(r => reclaimEffectivelyEmpty(r, starvedFloor))
    expect(starved.filter(Boolean)).toHaveLength(43)
    expect(starved[0]).toBe(false)
  })

  it('shows that drops alone never reached the target at 55%', () => {
    // 55.3% with nothing droppable left: the projection is the pressure itself.
    const pressure = Math.round(windowTokens * 0.553)
    expect(dropsSuffice({
      pressureTokens: pressure,
      droppableTokens: 0,
      windowTokens,
      executeThresholdPercentage: 55,
    })).toBe(false)
  })
})
