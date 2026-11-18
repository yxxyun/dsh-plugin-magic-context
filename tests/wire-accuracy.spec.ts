/**
 * Estimate accuracy (`core/wire-accuracy.ts`).
 *
 * The case that matters is the negative one: `calibratedWireEstimate` must NOT
 * report `trusted: true` until the samples justified it. A calibrated-looking
 * number with a guess's pedigree would let the emergency latch disarm on
 * nothing — the exact thing the gate's rule exists to prevent.
 */
import { describe, expect, it } from 'vitest'
import {
  accuracyFactor,
  calibratedWireEstimate,
  MAX_TRUSTED_SPREAD,
  MIN_TRUSTED_SAMPLES,
  pairEstimateSamples,
  summarise,
  type AccuracySample,
} from '../src/core/wire-accuracy.ts'

const samples = (count: number, ratio: number): AccuracySample[] =>
  Array.from({ length: count }, () => ({ estimated: 1_000, actual: 1_000 * ratio }))

describe('summarise', () => {
  it('reports no-samples for an empty pool', () => {
    expect(summarise([])).toMatchObject({ samples: 0, factor: 1, trusted: false, reason: 'no-samples' })
  })

  it('ignores samples it cannot use', () => {
    const report = summarise([
      { estimated: 0, actual: 100 },
      { estimated: 100, actual: 0 },
      { estimated: Number.NaN, actual: 100 },
      { estimated: 1_000, actual: 1_200 },
    ])
    expect(report.samples).toBe(1)
  })

  it('computes the factor as actual over estimated', () => {
    expect(accuracyFactor(samples(5, 1.2))).toBeCloseTo(1.2, 5)
    expect(accuracyFactor(samples(5, 0.8))).toBeCloseTo(0.8, 5)
  })

  it('uses the median so one wild request cannot move the factor', () => {
    const pool: AccuracySample[] = [
      { estimated: 1_000, actual: 1_000 },
      { estimated: 1_000, actual: 1_010 },
      { estimated: 1_000, actual: 1_020 },
      { estimated: 1_000, actual: 1_030 },
      { estimated: 1_000, actual: 50_000 }, // a provider counting quirk
    ]
    expect(accuracyFactor(pool)).toBeLessThan(1.05)
  })

  it('refuses to trust too few samples', () => {
    const report = summarise(samples(MIN_TRUSTED_SAMPLES - 1, 1.1))
    expect(report.trusted).toBe(false)
    expect(report.reason).toBe('too-few-samples')
  })

  it('trusts a tight band with enough samples', () => {
    const report = summarise(samples(MIN_TRUSTED_SAMPLES, 1.1))
    expect(report.trusted).toBe(true)
    expect(report.reason).toBeUndefined()
  })

  it('refuses a wide band even with enough samples', () => {
    // Half the samples at 1.0, half at 2.0: p90/p10 = 2, far over the ceiling.
    const pool = [...samples(20, 1.0), ...samples(20, 2.0)]
    const report = summarise(pool)
    expect(report.samples).toBe(40)
    expect(report.trusted).toBe(false)
    expect(report.reason).toBe('too-wide')
    expect(report.p90 / report.p10).toBeGreaterThan(MAX_TRUSTED_SPREAD)
  })
})

describe('calibratedWireEstimate', () => {
  it('scales by the measured factor', () => {
    const report = summarise(samples(MIN_TRUSTED_SAMPLES, 1.25))
    expect(calibratedWireEstimate(10_000, report).tokens).toBe(12_500)
  })

  it('is NOT trusted while the report is not', () => {
    const untrusted = summarise(samples(3, 1.1))
    expect(calibratedWireEstimate(10_000, untrusted).trusted).toBe(false)
  })

  it('is trusted once the report is', () => {
    const trusted = summarise(samples(MIN_TRUSTED_SAMPLES, 1.1))
    expect(calibratedWireEstimate(10_000, trusted).trusted).toBe(true)
  })

  it('reports zero for a nonsense estimate without claiming trust', () => {
    const trusted = summarise(samples(MIN_TRUSTED_SAMPLES, 1.1))
    expect(calibratedWireEstimate(0, trusted)).toMatchObject({ tokens: 0, trusted: false })
    expect(calibratedWireEstimate(Number.NaN, trusted).trusted).toBe(false)
  })
})

describe('pairEstimateSamples', () => {
  const usage = [
    { recordedAt: 100, inputTokens: 1_000 },
    { recordedAt: 200, inputTokens: 1_200 },
    { recordedAt: 300, inputTokens: 1_400 },
  ]

  it('pairs a pass with the FIRST usage reading at or after it', () => {
    // A pass at 250 sized the request whose bill is recorded at 300.
    const samples = pairEstimateSamples([{ at: 250, estimated: 1_000 }], usage)
    expect(samples).toEqual([{ estimated: 1_000, actual: 1_400 }])
  })

  it('ignores a pass with no later usage at all (the request never landed)', () => {
    expect(pairEstimateSamples([{ at: 350, estimated: 1_000 }], usage)).toEqual([])
  })

  it('ignores a pass with no estimate', () => {
    expect(pairEstimateSamples([{ at: 250, estimated: undefined }], usage)).toEqual([])
  })

  it('ignores a zero or negative usage reading at the paired moment', () => {
    const withZero = [{ recordedAt: 200, inputTokens: 0 }]
    expect(pairEstimateSamples([{ at: 150, estimated: 1_000 }], withZero)).toEqual([])
  })

  it('returns nothing when there is no usage at all', () => {
    expect(pairEstimateSamples([{ at: 250, estimated: 1_000 }], [])).toEqual([])
  })

  it('produces one sample per pass, in pass order', () => {
    const samples = pairEstimateSamples(
      [{ at: 150, estimated: 800 }, { at: 250, estimated: 900 }],
      usage,
    )
    expect(samples).toHaveLength(2)
    expect(samples[0]?.actual).toBe(1_200)
    expect(samples[1]?.actual).toBe(1_400)
  })
})
