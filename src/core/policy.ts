/**
 * Pressure policy and pass decisions — the DSH spelling of Magic Context's
 * scheduler (execute/defer) and escalation bands. Pure logic over the
 * neutral stores; no DSH imports.
 *
 * Discipline note (load-bearing): landing a durable drop is a priced cache
 * bust in DSH exactly like a wire rewrite is in OpenCode. The execute band is
 * the permission under which queued drops land; below it the adapter defers.
 * Two things open it — pressure at the threshold, and an idle gap past
 * {@link PressurePolicy.ttlMs} (MC's `ttl_execute_fired`). The idle band is
 * safe only because a pass that finds nothing to reclaim renders BYTE-IDENTICAL
 * content (`compartments.ts` is clock-free, `refreshBaseline` compares bytes
 * before writing), so an idle pass on a still-live provider cache costs
 * nothing. Do not re-introduce a clock into the renderer.
 */
import type { UsageRecord } from './types.ts'

export interface PressurePolicy {
  /** Usage percent at or above which a pass may mutate (MC execute threshold). */
  readonly executeThreshold: number
  /**
   * Absolute-tokens variant of {@link executeThreshold} (MC
   * `execute_threshold_tokens`, CONFIGURATION.md:296). When > 0 it OVERRIDES
   * the percentage for the current window: the effective threshold is
   * `tokens / window × 100`, clamped to {@link MAX_EXECUTE_THRESHOLD_PERCENTAGE}.
   *
   * This is the knob a large window needs. On a 1M-token route "30%" means
   * "compact at 300k", which keeps a long session inside the band for its whole
   * life; `executeThresholdTokens: 600000` says the same thing in the unit the
   * decision is actually about. `0` = disabled (percentage governs).
   */
  readonly executeThresholdTokens: number
  /** Usage percent at or above which automatic reclaim runs (MC force band). */
  readonly forceThreshold: number
  /**
   * Window assumed when the routed model discloses none, for the pressure
   * decision and everything that reports it. Without a denominator every pass
   * defers 'no-window' and the execute band never opens, so a route that
   * publishes no window must still be scheduled against something.
   * Scheduling only: emergency reclaim keeps the disclosed window
   * (dsh/emergency.ts), and the historian trigger budget keeps its own
   * {@link historianAssumedWindow}.
   */
  readonly assumedContextWindow: number
  /**
   * Idle gap after which a pass may run (MC scheduler `ttl_execute_fired`,
   * `scheduler.ts:116-119`). A PERMISSION, not a rebuild reason: the pass may
   * land queued drops or publish an already-digested compartment, and if it
   * finds nothing it re-renders byte-identical bytes and the provider cache is
   * untouched (MC's `transform-decision-log` case "a byte-identical expired
   * Rust resend").
   *
   * `0` = never (MC's `cache_ttl: "never"`, #245). DeepSeek-class routes keep
   * their prefix for hours, so a small value mostly wastes nothing but buys
   * nothing either; raise it if a route's cache really does die fast.
   */
  readonly ttlMs: number
  /** Newest tool-result tags the reclaim never touches (MC protected tail, count-based MVP). */
  readonly protectedToolResults: number
  /** Newest surface nodes the historian never digests (MC's protected tail). */
  readonly historianProtectedNodes: number
  /** Minimum nodes in an eligible span before a historian call is considered. */
  readonly historianMinNodes: number
  /**
   * Wall-clock budget for one historian run (including its repair attempt).
   * A provider that never settles must not leave the run unaccounted: the
   * historian journals a terminal `failed` when this budget is spent.
   */
  readonly historianTimeoutMs: number
  /** Generation cap for the historian's auxiliary call (the historian floors it at 8192). */
  readonly historianMaxTokens: number
  /** Upper bound the historian may escalate to when a run truncates at the token cap. */
  readonly historianMaxTokensCeiling: number
  /** Window assumed when the routed model discloses none (trigger budget math). */
  readonly historianAssumedWindow: number
  /** Trigger-budget floor in tokens (Magic Context's 5k; tests lower it). */
  readonly historianMinBudgetTokens: number
  /** Soft token cap for the m[0] baseline rendering (MC's memory/compartment budget). */
  readonly baselineTokens: number
  /** Project-memory recall cap (MC's DEFAULT_MEMORY_BUDGET_TOKENS is 8000). */
  readonly memoryBudgetTokens: number
  /** Maximum project memories recalled into the baseline. */
  readonly memoryLimit: number
  /**
   * How long the provider-overflow path may wait on an in-flight historian
   * before falling back to emergency reclaim (0 = never wait — the shipped
   * default; flip after the force-path observation window).
   */
  readonly forceWaitReadyMs: number
}

export const DEFAULT_POLICY: PressurePolicy = {
  executeThreshold: 65,
  executeThresholdTokens: 0,
  forceThreshold: 85,
  assumedContextWindow: 256_000,
  ttlMs: 5 * 60_000,
  protectedToolResults: 8,
  historianProtectedNodes: 8,
  historianMinNodes: 3,
  historianTimeoutMs: 120_000,
  historianMaxTokens: 8192,
  historianMaxTokensCeiling: 32_768,
  historianAssumedWindow: 128_000,
  historianMinBudgetTokens: 5_000,
  baselineTokens: 2000,
  memoryBudgetTokens: 8000,
  memoryLimit: 40,
  forceWaitReadyMs: 0,
}

/**
 * The request's total input tokens as the provider counts them against the
 * window: the DSH TokenUsage splits input into uncached input plus cache
 * read/write, so pressure must sum all three (MC's OpenCode usage figure is
 * already the total; this is the same quantity reassembled).
 */
export function totalInputTokens(usage: Pick<UsageRecord, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number {
  return (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/** Usage percent against the model's context window, or undefined when unknown. */
export function pressurePercent(
  latest: UsageRecord | undefined,
  contextWindow: number | undefined,
): number | undefined {
  if (latest === undefined || contextWindow === undefined || contextWindow <= 0) return undefined
  const total = totalInputTokens(latest)
  if (total <= 0) return 0
  return (total / contextWindow) * 100
}

/**
 * The denominator for pressure math: the window the routed model disclosed, or
 * {@link PressurePolicy.assumedContextWindow} when it disclosed none (also for
 * a placeholder 0 or a non-finite reading).
 *
 * Every pressure reader resolves through here, so one number governs the pass
 * decision, its journal row and `/ctx-status`. Callers that need the fact
 * itself — the DSH route window as disclosed — still read `contextWindow`.
 */
export function pressureWindowTokens(
  contextWindow: number | undefined,
  policy: PressurePolicy,
): number {
  return contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0
    ? contextWindow
    : policy.assumedContextWindow
}

export type PassDecision =
  // `cache-ttl-expired` (the v0.49.44..v0.49.48 spelling) is no longer
  // produced; the band is back as `cache-ttl-idle`. Historic journal rows still
  // carry the old string, so readers of stored data must keep tolerating it.
  | { readonly kind: 'execute'; readonly reason: 'execute-threshold' | 'wire-repair' | 'cache-ttl-idle' }
  | { readonly kind: 'defer'; readonly reason: 'no-usage' | 'no-window' | 'below-threshold' }

/**
 * One pass decision. Mirrors MC's scheduler (`scheduler.ts:116-119`): execute
 * at the threshold, or on an idle gap past `ttlMs`; otherwise defer.
 *
 * The idle branch is a PERMISSION, and it is only safe because a pass that
 * finds nothing to reclaim now re-renders byte-identical bytes: `compartments.ts`
 * derives tiers and headers from positions, never from a clock, and
 * `refreshBaseline` compares the rendered block against the one already on the
 * wire before writing. That is the upstream reading of the same trade
 * (`m0_compose.rs:1-9`, `transform.rs:4641` `hard_fold_loses_provider_cache`)
 * — "when the provider forgot the cache, folding costs nothing extra" — and it
 * is the reason the v0.49.44 removal (which existed to stop a byte-unstable
 * renderer from re-writing the prefix every minute) is no longer needed.
 *
 * Iron rule: the adapter must never leave the main wire unpairable. A
 * stranded `tool_result` 400s every strict-provider request, so any live
 * wire defect forces the execute band before pressure is even considered.
 */
export function decidePass(args: {
  latest: UsageRecord | undefined
  pressure: number | undefined
  /** Clock for the idle band. Omitted = the idle band cannot fire. */
  now?: number
  policy: PressurePolicy
  /** Live tool/results whose tool_use left the wire (see `wireStrandedResults`). */
  wireDefects?: number
}): PassDecision {
  if ((args.wireDefects ?? 0) > 0) return { kind: 'execute', reason: 'wire-repair' }
  if (args.latest === undefined) return { kind: 'defer', reason: 'no-usage' }
  if (args.pressure === undefined) return { kind: 'defer', reason: 'no-window' }
  if (args.pressure >= args.policy.executeThreshold) return { kind: 'execute', reason: 'execute-threshold' }
  const idle = idleMsOf(args.latest, args.now)
  if (idle !== undefined && args.policy.ttlMs > 0 && idle > args.policy.ttlMs) {
    return { kind: 'execute', reason: 'cache-ttl-idle' }
  }
  return { kind: 'defer', reason: 'below-threshold' }
}

/** Milliseconds since the last recorded response, or undefined without both clocks. */
export function idleMsOf(latest: UsageRecord | undefined, now: number | undefined): number | undefined {
  if (latest === undefined || now === undefined) return undefined
  const idle = now - latest.recordedAt
  return Number.isFinite(idle) ? Math.max(0, idle) : undefined
}

/** Upstream `MAX_EXECUTE_THRESHOLD_PERCENTAGE` (scheduler.rs:17). */
export const MAX_EXECUTE_THRESHOLD_PERCENTAGE = 90

/**
 * Resolve the effective execute threshold for one route's window.
 *
 * MC's `execute_threshold_tokens` (CONFIGURATION.md:296, `scheduler.rs:483-508`)
 * is an absolute per-model token count that OVERRIDES the percentage in both
 * directions; the only guard is the 90%-of-window clamp. This adapter took a
 * single number instead of MC's per-model map (documented divergence: one route
 * per session is the common case here) but also refused to let it *raise* the
 * threshold, so a stale token value could never delay compaction.
 *
 * That safety read was wrong for the case that needs the override most. On a
 * 1 M window, `executeThreshold: 30` is 300 k and a long session lives above it,
 * so every second pass is an execute: measured 2026-11-11, 21 execute passes in
 * four hours at an average pressure of 30.6 %, each one able to publish a
 * compartment that rewrites the whole cached prefix. The fix upstream ships for
 * exactly this (`execute_threshold_tokens` per model) was unreachable here
 * because 450 k of a 1 M window is 45 % ≥ 30 %, i.e. "not applied".
 *
 * So: override, both directions, clamped at 90 % — the same contract as
 * upstream, and the operator keeps their percentages untouched.
 */
export function withTokenThreshold(policy: PressurePolicy, windowTokens: number | undefined): PressurePolicy {
  const tokens = policy.executeThresholdTokens
  if (!(tokens > 0) || windowTokens === undefined || !(windowTokens > 0)) return policy
  const percent = Math.min(MAX_EXECUTE_THRESHOLD_PERCENTAGE, (tokens / windowTokens) * 100)
  if (percent === policy.executeThreshold) return policy
  return { ...policy, executeThreshold: percent }
}

/** Parse MC's drop-range grammar: "3-5,8,12-15" → ascending unique tag numbers. */
export function parseTagRanges(input: string): number[] {
  const tags = new Set<number>()
  for (const part of input.split(',')) {
    const token = part.trim()
    if (token.length === 0) continue
    const range = token.match(/^(\d+)-(\d+)$/)
    if (range !== null) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start > 10_000) continue
      for (let tag = start; tag <= end; tag++) tags.add(tag)
      continue
    }
    if (/^\d+$/.test(token)) {
      const tag = Number(token)
      if (tag >= 1) tags.add(tag)
    }
  }
  return [...tags].sort((a, b) => a - b)
}
