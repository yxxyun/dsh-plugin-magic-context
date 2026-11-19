/**
 * Emergency fail-closed (upstream `evaluateEmergencyFailClosed`,
 * transform-postprocess-phase.ts:1901).
 *
 * The interesting cases are the ones where a naive rule would misbehave: a
 * CONSERVATIVE estimate must not refuse a request (that used to send nothing at
 * all), and a latch must be able to RELEASE once the session has recovered.
 */
import { describe, expect, it } from 'vitest'
import {
  DISARM_RATIO,
  EMERGENCY_BAND_PERCENTAGE,
  evaluateEmergencyFailClosed,
} from '../src/core/emergency-fail-closed.ts'

const base = {
  usagePercentage: 97,
  emergencyRecoveryArmed: false,
  emergencyRecoveryOrigin: null as 'provider_overflow' | 'proactive_model_shrink' | null,
  foldMaterializedThisPass: false,
}

describe('evaluateEmergencyFailClosed', () => {
  it('aborts when the final wire is refusal-grade over the limit', () => {
    const decision = evaluateEmergencyFailClosed({
      ...base,
      finalWireEstimate: { tokens: 300_000, trusted: true, refusalGrade: true, refusalTokens: 300_000 },
      providerProvenLimitTokens: 262_144,
    })
    expect(decision.shouldAbort).toBe(true)
    expect(decision.reason).toBe('refusal-grade-final-wire-over-limit')
    expect(decision.refusalMessage).toContain('262144')
  })

  it('tells the person to retry when history can still be summarized', () => {
    const decision = evaluateEmergencyFailClosed({
      ...base,
      usagePercentage: 99,
      historyRemains: true,
      finalWireEstimate: { tokens: 300_000, trusted: true, refusalGrade: true, refusalTokens: 300_000 },
      providerProvenLimitTokens: 262_144,
    })
    expect(decision.shouldAbort).toBe(true)
    expect(decision.refusalMessage).toContain('Send it again')
  })

  it('tells the person to change models when nothing is left to summarize', () => {
    // Omitting `historyRemains` reads as "none left": the safe reading, because
    // "send again" against a dead end wastes the person's attempt.
    const decision = evaluateEmergencyFailClosed({
      ...base,
      usagePercentage: 99,
      finalWireEstimate: { tokens: 300_000, trusted: true, refusalGrade: true, refusalTokens: 300_000 },
      providerProvenLimitTokens: 262_144,
    })
    expect(decision.shouldAbort).toBe(true)
    expect(decision.refusalMessage).toContain('Switch to a model with a larger window')
  })

  it('does not abort on a refusal-grade estimate that still fits', () => {
    const decision = evaluateEmergencyFailClosed({
      ...base,
      usagePercentage: 10,
      finalWireEstimate: { tokens: 100_000, trusted: true, refusalGrade: true },
      providerProvenLimitTokens: 262_144,
    })
    expect(decision.shouldAbort).toBe(false)
    expect(decision.reason).toBe('below-emergency-band')
  })

  it('disarms when a trusted measurement fits under the disarm ratio', () => {
    const decision = evaluateEmergencyFailClosed({
      ...base,
      emergencyRecoveryArmed: true,
      emergencyRecoveryOrigin: 'provider_overflow',
      finalWireEstimate: { tokens: 100_000, trusted: true },
      providerProvenLimitTokens: 262_144,
    })
    expect(decision.shouldAbort).toBe(false)
    expect(decision.reason).toBe('trusted-final-wire-disarm')
    expect(decision.disarm?.finalWireTokens).toBe(100_000)
  })

  it('does NOT disarm on an untrusted estimate', () => {
    const decision = evaluateEmergencyFailClosed({
      ...base,
      emergencyRecoveryArmed: true,
      emergencyRecoveryOrigin: 'provider_overflow',
      finalWireEstimate: { tokens: 100_000, trusted: false },
      providerProvenLimitTokens: 262_144,
    })
    expect(decision.reason).toBe('provider-overflow-abort')
  })

  it('does NOT disarm on an estimate above the ratio', () => {
    const decision = evaluateEmergencyFailClosed({
      ...base,
      emergencyRecoveryArmed: true,
      emergencyRecoveryOrigin: 'provider_overflow',
      finalWireEstimate: { tokens: 250_000, trusted: true },
      providerProvenLimitTokens: 262_144, // 250k > 0.8 × 262k
    })
    expect(decision.shouldAbort).toBe(true)
  })

  it('never aborts below the emergency band', () => {
    const decision = evaluateEmergencyFailClosed({
      ...base,
      usagePercentage: EMERGENCY_BAND_PERCENTAGE - 1,
      emergencyRecoveryArmed: true,
      emergencyRecoveryOrigin: 'provider_overflow',
    })
    expect(decision.shouldAbort).toBe(false)
    expect(decision.reason).toBe('below-emergency-band')
  })

  it('aborts at the band only when armed by a provider overflow', () => {
    expect(evaluateEmergencyFailClosed({
      ...base,
      emergencyRecoveryArmed: true,
      emergencyRecoveryOrigin: 'provider_overflow',
    }).shouldAbort).toBe(true)
    expect(evaluateEmergencyFailClosed({
      ...base,
      emergencyRecoveryArmed: true,
      emergencyRecoveryOrigin: 'proactive_model_shrink',
    }).shouldAbort).toBe(false)
    expect(evaluateEmergencyFailClosed({
      ...base,
      emergencyRecoveryArmed: false,
      emergencyRecoveryOrigin: 'provider_overflow',
    }).shouldAbort).toBe(false)
  })

  it('proceeds when this pass folded — the request now describes the wire', () => {
    const decision = evaluateEmergencyFailClosed({
      ...base,
      emergencyRecoveryArmed: true,
      emergencyRecoveryOrigin: 'provider_overflow',
      foldMaterializedThisPass: true,
    })
    expect(decision.shouldAbort).toBe(false)
    expect(decision.reason).toBe('proceed')
  })

  it('requires a proven limit — a catalog default may not disarm', () => {
    const decision = evaluateEmergencyFailClosed({
      ...base,
      emergencyRecoveryArmed: true,
      emergencyRecoveryOrigin: 'provider_overflow',
      finalWireEstimate: { tokens: 100, trusted: true },
    })
    expect(decision.shouldAbort).toBe(true)
  })

  it('uses the disarm ratio the constant promises', () => {
    const justUnder = Math.floor(262_144 * DISARM_RATIO) - 1
    const justOver = Math.ceil(262_144 * DISARM_RATIO) + 1
    expect(evaluateEmergencyFailClosed({
      ...base,
      emergencyRecoveryArmed: true,
      emergencyRecoveryOrigin: 'provider_overflow',
      finalWireEstimate: { tokens: justUnder, trusted: true },
      providerProvenLimitTokens: 262_144,
    }).reason).toBe('trusted-final-wire-disarm')
    expect(evaluateEmergencyFailClosed({
      ...base,
      emergencyRecoveryArmed: true,
      emergencyRecoveryOrigin: 'provider_overflow',
      finalWireEstimate: { tokens: justOver, trusted: true },
      providerProvenLimitTokens: 262_144,
    }).reason).toBe('provider-overflow-abort')
  })
})
