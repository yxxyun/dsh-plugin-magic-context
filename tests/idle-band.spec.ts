/**
 * The idle gap is an EXECUTE PERMISSION, never a rebuild reason.
 *
 * History, because both halves of this file exist for a reason:
 *
 *  - v0.49.30 shipped the idle band (`now - latest.recordedAt > ttlMs` →
 *    execute), which was re-read upstream (`scheduler.ts:116-119`,
 *    `crates/mc-module/src/scheduler.rs:513-556`) and still is at v0.49.48.
 *  - v0.49.44 removed it, because passes at idle were rewriting the prefix:
 *    122 TTL-driven passes at a median 14.9% pressure, i.e. "rebuilding while
 *    85% of the window was still free". The removal treated the symptom: the
 *    renderer at the time read a live clock (`§Cn§ [… 12m ago]` plus a
 *    wall-clock tier ladder), so EVERY pass rewrote the first user node no
 *    matter why it ran.
 *  - 2026-11-10 restored the band on top of a clock-free renderer: a pass that
 *    finds nothing to reclaim now renders byte-identical bytes and the
 *    `refreshBaseline` guard writes nothing at all. See
 *    `tests/baseline-clock-freeze.spec.ts`, which pins that half.
 *
 * So: idle opens the band (asserted here), and an empty band writes nothing
 * (asserted there). Upstream does the same and names the case "a byte-identical
 * expired Rust resend" (transform-decision-log.test.ts:67).
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_POLICY,
  decidePass,
  idleMsOf,
  withTokenThreshold,
  type PressurePolicy,
} from '../src/core/policy.ts'
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

const NOW = 1_000_000_000

describe('the idle band opens the execute pass', () => {
  it('idle past the TTL at low pressure executes, and says why', () => {
    // Six times DEFAULT_POLICY.ttlMs.
    const pass = decidePass({
      latest: usageIdleFor(30 * 60_000, NOW),
      pressure: 15,
      now: NOW,
      policy: DEFAULT_POLICY,
    })
    expect(pass).toEqual({ kind: 'execute', reason: 'cache-ttl-idle' })
  })

  it('inside the TTL it still defers', () => {
    const pass = decidePass({
      latest: usageIdleFor(DEFAULT_POLICY.ttlMs - 1, NOW),
      pressure: 15,
      now: NOW,
      policy: DEFAULT_POLICY,
    })
    expect(pass).toEqual({ kind: 'defer', reason: 'below-threshold' })
  })

  it('ttlMs 0 turns the band off (MC cache_ttl "never", #245)', () => {
    const policy: PressurePolicy = { ...DEFAULT_POLICY, ttlMs: 0 }
    const pass = decidePass({
      latest: usageIdleFor(30 * 24 * 60 * 60_000, NOW),
      pressure: 15,
      now: NOW,
      policy,
    })
    expect(pass).toEqual({ kind: 'defer', reason: 'below-threshold' })
  })

  it('without a clock the band cannot fire', () => {
    const pass = decidePass({ latest: usageIdleFor(30 * 60_000, NOW), pressure: 15, policy: DEFAULT_POLICY })
    expect(pass).toEqual({ kind: 'defer', reason: 'below-threshold' })
    expect(idleMsOf(usageIdleFor(5_000, NOW), undefined)).toBeUndefined()
  })

  it('precedence: wire repair, then usage, then pressure, then idle', () => {
    const stale = usageIdleFor(30 * 60_000, NOW)
    expect(decidePass({ latest: stale, pressure: 15, now: NOW, policy: DEFAULT_POLICY, wireDefects: 1 }))
      .toEqual({ kind: 'execute', reason: 'wire-repair' })
    expect(decidePass({ latest: undefined, pressure: 15, now: NOW, policy: DEFAULT_POLICY }))
      .toEqual({ kind: 'defer', reason: 'no-usage' })
    expect(decidePass({ latest: stale, pressure: undefined, now: NOW, policy: DEFAULT_POLICY }))
      .toEqual({ kind: 'defer', reason: 'no-window' })
    // Pressure still reports itself rather than the idle band, so the journal
    // keeps telling the operator which permission was actually used.
    expect(decidePass({ latest: stale, pressure: 99, now: NOW, policy: DEFAULT_POLICY }))
      .toEqual({ kind: 'execute', reason: 'execute-threshold' })
  })
})

describe('executeThresholdTokens overrides the percentage for the window', () => {
  it('600k of a 1M window is 60%', () => {
    const policy = withTokenThreshold({ ...DEFAULT_POLICY, executeThresholdTokens: 600_000 }, 1_000_000)
    expect(policy.executeThreshold).toBeCloseTo(60, 5)
  })

  it('is clamped to 90% of the window (MAX_EXECUTE_THRESHOLD_PERCENTAGE)', () => {
    // 2M tokens on a 1M window is 200%; upstream clamps rather than trusting it.
    const loose: PressurePolicy = { ...DEFAULT_POLICY, executeThreshold: 95, executeThresholdTokens: 2_000_000 }
    expect(withTokenThreshold(loose, 1_000_000).executeThreshold).toBe(90)
  })

  it('raises the threshold too, so a large window can hold its band', () => {
    // 450k of 1M = 45% against a configured 30%: this is the case the override
    // exists for. Before 2026-11-11 the adapter returned the policy unchanged
    // here ("the stricter of the two always wins"), which made the upstream
    // escape hatch unusable on a 1M window — where 30% = 300k and a long
    // session sits above it, so every second pass was an execute.
    const base: PressurePolicy = { ...DEFAULT_POLICY, executeThreshold: 30, executeThresholdTokens: 450_000 }
    expect(withTokenThreshold(base, 1_000_000).executeThreshold).toBeCloseTo(45, 5)
  })

  it('a token value that resolves to the configured percentage is a no-op', () => {
    const same: PressurePolicy = { ...DEFAULT_POLICY, executeThreshold: 30, executeThresholdTokens: 300_000 }
    expect(withTokenThreshold(same, 1_000_000)).toBe(same)
  })

  it('0 or an unknown window leaves the policy untouched', () => {
    expect(withTokenThreshold(DEFAULT_POLICY, 1_000_000)).toBe(DEFAULT_POLICY)
    const withTokens = { ...DEFAULT_POLICY, executeThresholdTokens: 100_000 }
    expect(withTokenThreshold(withTokens, undefined)).toBe(withTokens)
    expect(withTokenThreshold(withTokens, 0)).toBe(withTokens)
  })

  it('the resolved threshold is what decidePass compares against', () => {
    const policy = withTokenThreshold({ ...DEFAULT_POLICY, executeThreshold: 65, executeThresholdTokens: 400_000 }, 1_000_000)
    expect(policy.executeThreshold).toBeCloseTo(40, 5)
    const latest = usageIdleFor(0, NOW)
    expect(decidePass({ latest, pressure: 39, now: NOW, policy })).toEqual({ kind: 'defer', reason: 'below-threshold' })
    expect(decidePass({ latest, pressure: 41, now: NOW, policy })).toEqual({ kind: 'execute', reason: 'execute-threshold' })
  })
})
