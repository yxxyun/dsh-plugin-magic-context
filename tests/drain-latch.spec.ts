import { describe, expect, it } from 'vitest'
import {
  EMERGENCY_DRAIN_EXIT_MARGIN,
  EMERGENCY_DRAIN_FAILURE_BACKOFF_MS,
  EMERGENCY_DRAIN_FALLBACK_EXIT_PERCENTAGE,
  EMERGENCY_DRAIN_MAX_LATCH_MS,
  RELEASED_DRAIN_LATCH,
  drainFailureBackoffActive,
  emergencyDrainExitThreshold,
  forcedDrainAdmission,
  resolvedEmergencyDrainLatch,
} from '../src/core/drain-latch.ts'

describe('emergencyDrainExitThreshold', () => {
  it('sits a full margin below the execute threshold', () => {
    expect(EMERGENCY_DRAIN_EXIT_MARGIN).toBe(10)
    expect(emergencyDrainExitThreshold(65)).toBe(55)
    expect(emergencyDrainExitThreshold(50)).toBe(40)
  })

  it('falls back to 55 when the threshold is unknown or zero', () => {
    expect(EMERGENCY_DRAIN_FALLBACK_EXIT_PERCENTAGE).toBe(55)
    expect(emergencyDrainExitThreshold(0)).toBe(55)
    expect(emergencyDrainExitThreshold(Number.NaN)).toBe(55)
  })

  it('never goes negative', () => {
    expect(emergencyDrainExitThreshold(4)).toBe(0)
  })
})

describe('resolvedEmergencyDrainLatch — engage, hold, release', () => {
  const now = 1_000_000
  const force = 85
  const execute = 65

  it('engages at the force band', () => {
    expect(resolvedEmergencyDrainLatch(RELEASED_DRAIN_LATCH, 85, force, execute, now)).toBe(now)
    expect(resolvedEmergencyDrainLatch(RELEASED_DRAIN_LATCH, 92, force, execute, now)).toBe(now)
  })

  it('keeps the original engagement time on a later reading', () => {
    const engaged = { activeSince: now - 5_000, failureAt: 0 }
    expect(resolvedEmergencyDrainLatch(engaged, 88, force, execute, now)).toBe(now - 5_000)
  })

  it('holds inside the band between the exit threshold and the force band', () => {
    const engaged = { activeSince: now - 5_000, failureAt: 0 }
    // 60 is above execute-10 (55) and below force (85): stay latched.
    expect(resolvedEmergencyDrainLatch(engaged, 60, force, execute, now)).toBe(now - 5_000)
  })

  it('releases once usage drops below execute - margin', () => {
    const engaged = { activeSince: now - 5_000, failureAt: 0 }
    expect(resolvedEmergencyDrainLatch(engaged, 54, force, execute, now)).toBe(0)
    expect(resolvedEmergencyDrainLatch(engaged, 20, force, execute, now)).toBe(0)
  })

  it('does not release exactly at execute - margin (would re-enter immediately)', () => {
    const engaged = { activeSince: now - 5_000, failureAt: 0 }
    expect(resolvedEmergencyDrainLatch(engaged, 55, force, execute, now)).toBe(now - 5_000)
  })

  it('expires after the 30 minute backstop even if usage never comes down', () => {
    expect(EMERGENCY_DRAIN_MAX_LATCH_MS).toBe(30 * 60 * 1000)
    // A clock large enough that the stale engagement stays a positive epoch.
    const late = EMERGENCY_DRAIN_MAX_LATCH_MS * 2
    const engaged = { activeSince: late - EMERGENCY_DRAIN_MAX_LATCH_MS - 1, failureAt: 0 }
    expect(resolvedEmergencyDrainLatch(engaged, 80, force, execute, late)).toBe(0)
  })

  it('re-engages at the force band even while the old latch was expiring', () => {
    const late = EMERGENCY_DRAIN_MAX_LATCH_MS * 2
    const stale = { activeSince: late - EMERGENCY_DRAIN_MAX_LATCH_MS - 1, failureAt: 0 }
    // The force-band branch wins before the expiry branch is consulted, and it
    // preserves the original engagement time rather than restamping it.
    expect(resolvedEmergencyDrainLatch(stale, 85, force, execute, late)).toBe(stale.activeSince)
  })

  it('leaves a released latch released', () => {
    expect(resolvedEmergencyDrainLatch(RELEASED_DRAIN_LATCH, 40, force, execute, now)).toBe(0)
  })
})

describe('drainFailureBackoffActive', () => {
  const now = 1_000_000

  it('is inactive with no recorded failure', () => {
    expect(drainFailureBackoffActive(RELEASED_DRAIN_LATCH, now)).toBe(false)
  })

  it('holds for 60 seconds after a failure', () => {
    expect(EMERGENCY_DRAIN_FAILURE_BACKOFF_MS).toBe(60_000)
    expect(drainFailureBackoffActive({ activeSince: now, failureAt: now - 1 }, now)).toBe(true)
    expect(drainFailureBackoffActive({ activeSince: now, failureAt: now - 59_999 }, now)).toBe(true)
  })

  it('expires after the backoff', () => {
    expect(drainFailureBackoffActive({ activeSince: now, failureAt: now - 60_000 }, now)).toBe(false)
  })

  it('ignores a failure timestamp from the future (clock moved backwards)', () => {
    expect(drainFailureBackoffActive({ activeSince: now, failureAt: now + 60_000 }, now)).toBe(false)
  })
})

describe('forcedDrainAdmission — latch plus backoff', () => {
  const now = 1_000_000
  const base = { usagePercentage: 88, forceBandPercentage: 85, executeThresholdPercentage: 65, now }

  it('admits when no latch is active', () => {
    const result = forcedDrainAdmission({ ...base, usagePercentage: 40, state: RELEASED_DRAIN_LATCH })
    expect(result.latchActiveSince).toBe(0)
    expect(result.admit).toBe(true)
  })

  it('admits a fresh latch that has not failed', () => {
    const result = forcedDrainAdmission({ ...base, state: RELEASED_DRAIN_LATCH })
    expect(result.latchActiveSince).toBe(now)
    expect(result.backoff).toBe(false)
    expect(result.admit).toBe(true)
  })

  it('refuses while a latched drain is inside its failure backoff', () => {
    const state = { activeSince: now - 10_000, failureAt: now - 5_000 }
    const result = forcedDrainAdmission({ ...base, state })
    expect(result.backoff).toBe(true)
    expect(result.admit).toBe(false)
  })

  it('admits again once the backoff expires without clearing the latch', () => {
    const state = { activeSince: now - 10_000, failureAt: now - EMERGENCY_DRAIN_FAILURE_BACKOFF_MS }
    const result = forcedDrainAdmission({ ...base, state })
    expect(result.latchActiveSince).toBe(now - 10_000)
    expect(result.admit).toBe(true)
  })
})

describe('the irreducible-floor scenario', () => {
  it('stops re-entering the drain while pressure refuses to fall', () => {
    const now = 1_000_000
    const force = 85
    const execute = 65
    let state = { activeSince: 0, failureAt: 0 }
    // Ten passes pinned at 86%: the first engages, the rest reuse it.
    const latches: number[] = []
    for (let i = 0; i < 10; i += 1) {
      const since = resolvedEmergencyDrainLatch(state, 86, force, execute, now + i * 1000)
      latches.push(since)
      state = { activeSince: since, failureAt: 0 }
    }
    expect(latches.slice(1).every(v => v === latches[0])).toBe(true)
    // And it still releases the moment the floor finally comes down.
    expect(resolvedEmergencyDrainLatch(state, 50, force, execute, now + 20_000)).toBe(0)
  })
})
