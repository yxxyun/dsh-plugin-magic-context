/**
 * An expired provider cache is NOT a rebuild reason (MC v0.49.44 alignment).
 *
 * Background: `decidePass` used to open the execute band on idle alone —
 * `now - latest.recordedAt > ttlMs` → `cache-ttl-expired`. The reasoning was
 * "the cache is already dead, so rewriting the prefix is free". Two costs were
 * left out of that ledger:
 *
 *  1. On prefix-bound thinking models, resending the same bytes keeps the
 *     signed thinking blocks valid; a rebuild invalidates them.
 *  2. A rebuild at 15% pressure discards context the agent still needs, long
 *     before the window is full.
 *
 * Measured on the local store before the change: 122 TTL-driven execute passes
 * at a median 14.9% pressure (min 4.2%, max 29.7%). That is not a free moment,
 * that is rewriting a prefix while 85% of the window is free.
 *
 * These tests pin the removal so it cannot drift back silently. The `ttlMs`
 * field survives as a diagnostic, so the policy is still passed with it set.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY, decidePass } from '../src/core/policy.ts'
import type { UsageRecord } from '../src/core/types.ts'

/** A usage reading recorded `idleMs` before `now`. */
function usageIdleFor(idleMs: number, now: number): UsageRecord {
  return {
    sessionId: 'mc-ttl-session',
    seq: 1,
    turn: 1,
    step: 1,
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    inputTokens: 1_000,
    outputTokens: 100,
    cacheReadTokens: 9_000,
    recordedAt: now - idleMs,
  } as UsageRecord
}

describe('an expired cache defers instead of rebuilding', () => {
  it('反例: idle far past the TTL at low pressure still defers below-threshold', () => {
    const now = 1_000_000_000
    // 30 minutes idle — six times DEFAULT_POLICY.ttlMs.
    const latest = usageIdleFor(30 * 60_000, now)
    const pass = decidePass({ latest, pressure: 15, now, policy: DEFAULT_POLICY })
    expect(pass).toEqual({ kind: 'defer', reason: 'below-threshold' })
  })

  it('the decision is byte-identical across every idle age — the clock is not read', () => {
    const now = 1_000_000_000
    const ages = [0, 1, 60_000, 299_999, 300_001, 3_600_000, 86_400_000]
    const decisions = ages.map((age) =>
      decidePass({ latest: usageIdleFor(age, now), pressure: 20, now, policy: DEFAULT_POLICY }),
    )
    for (const decision of decisions) {
      expect(decision).toEqual({ kind: 'defer', reason: 'below-threshold' })
    }
    // Every one is the same value, not merely the same kind.
    expect(new Set(decisions.map((d) => `${d.kind}:${d.reason}`)).size).toBe(1)
  })

  it('正例: at or above the execute threshold it still executes, idle or not', () => {
    const now = 1_000_000_000
    const latest = usageIdleFor(30 * 60_000, now)
    const pass = decidePass({
      latest,
      pressure: DEFAULT_POLICY.executeThreshold,
      now,
      policy: DEFAULT_POLICY,
    })
    expect(pass).toEqual({ kind: 'execute', reason: 'execute-threshold' })
  })

  it('正例: a wire defect outranks both the threshold and any idle age', () => {
    const now = 1_000_000_000
    const pass = decidePass({
      latest: usageIdleFor(86_400_000, now),
      pressure: 1,
      now,
      policy: DEFAULT_POLICY,
      wireDefects: 1,
    })
    expect(pass).toEqual({ kind: 'execute', reason: 'wire-repair' })
  })

  it('the no-usage and no-window deferrals are unchanged', () => {
    expect(decidePass({ latest: undefined, pressure: undefined, now: 0, policy: DEFAULT_POLICY }))
      .toEqual({ kind: 'defer', reason: 'no-usage' })
    expect(decidePass({
      latest: usageIdleFor(0, 1_000),
      pressure: undefined,
      now: 1_000,
      policy: DEFAULT_POLICY,
    })).toEqual({ kind: 'defer', reason: 'no-window' })
  })

  it('the clock is optional — omitting it changes no decision', () => {
    const now = 1_000_000_000
    const latest = usageIdleFor(3_600_000, now)
    const withClock = decidePass({ latest, pressure: 10, now, policy: DEFAULT_POLICY })
    const withoutClock = decidePass({ latest, pressure: 10, policy: DEFAULT_POLICY })
    expect(withoutClock).toEqual(withClock)
  })

  it('ttlMs survives in the policy as a diagnostic, so /ctx-status can still report it', () => {
    expect(DEFAULT_POLICY.ttlMs).toBe(300_000)
  })
})
