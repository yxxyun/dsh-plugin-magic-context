import { describe, expect, it } from 'vitest'
import {
  ABSOLUTE_EMERGENCY_PERCENTAGE,
  MAX_EXECUTE_THRESHOLD,
  effectiveForceThreshold,
  escalationBands,
} from '../src/core/escalation-bands.ts'

describe('escalationBands — upstream derivation', () => {
  it('keeps the force band at 85 for every execute threshold up to 83', () => {
    for (const t of [0, 30, 50, 55, 60, 65, 70, 80, 83]) {
      expect(escalationBands(t).forceMaterializationPercentage).toBe(85)
    }
  })

  it('rises with the execute threshold once it passes 83', () => {
    expect(escalationBands(84).forceMaterializationPercentage).toBe(86)
    expect(escalationBands(88).forceMaterializationPercentage).toBe(90)
  })

  it('clamps the execute threshold at the 90 ceiling before deriving', () => {
    expect(MAX_EXECUTE_THRESHOLD).toBe(90)
    // 95 clamps to 90, then +2 = 92 — not 97.
    expect(escalationBands(95).forceMaterializationPercentage).toBe(92)
  })

  it('falls back to the 65 default for a non-finite threshold', () => {
    expect(escalationBands(Number.NaN).forceMaterializationPercentage).toBe(85)
  })

  it('always pins the emergency wall at 95 regardless of the execute threshold', () => {
    for (const t of [0, 50, 90, 200]) {
      expect(escalationBands(t).emergencyPercentage).toBe(ABSOLUTE_EMERGENCY_PERCENTAGE)
      expect(escalationBands(t).emergencyPercentage).toBe(95)
    }
  })
})

describe('effectiveForceThreshold — the configured value is a floor, never a ceiling', () => {
  it('ignores a configured force band below the derivation (the 50/60 dead zone)', () => {
    // This is the exact configuration that produced 43 empty passes in 80 minutes.
    expect(effectiveForceThreshold({ executeThreshold: 50, forceThreshold: 60 })).toBe(85)
  })

  it('ignores a configured value equal to nothing useful (0)', () => {
    expect(effectiveForceThreshold({ executeThreshold: 65, forceThreshold: 0 })).toBe(85)
  })

  it('honours a configured value that raises the band', () => {
    expect(effectiveForceThreshold({ executeThreshold: 65, forceThreshold: 92 })).toBe(92)
  })

  it('takes the derived band when the configured one equals it', () => {
    expect(effectiveForceThreshold({ executeThreshold: 65, forceThreshold: 85 })).toBe(85)
  })

  it('derives from the clamped threshold, not the raw one', () => {
    expect(effectiveForceThreshold({ executeThreshold: 95, forceThreshold: 80 })).toBe(92)
  })

  it('never returns a force band below the 85 floor for any sane execute threshold', () => {
    for (const t of [0, 10, 40, 55, 60, 70, 80, 90]) {
      expect(effectiveForceThreshold({ executeThreshold: t, forceThreshold: 50 })).toBeGreaterThanOrEqual(85)
    }
  })
})
