/**
 * Emergency reclaim — the DSH spelling of Magic Context's ≥95% emergency
 * band. Runs under the `agent/request-error` waterfall after a
 * CONTEXT_WINDOW_EXCEEDED failure: drop reclaimable tool-result nodes beyond
 * the protected window, worst-tier and oldest first, and let the caller retry
 * when the surface replacement generation advanced (the compaction-basic
 * recovery pattern: durable surface progress is the retry proof).
 *
 * P2-C1/C2 — the protection model moved from a fixed node count to MC's
 * token-quality scheme:
 *   - window: the newest tagged results are protected while their cumulative
 *     estimate fits `clamp(contextWindow × 5%, 8k, 64k)` tokens
 *     (selection.rs protection window, m0_compose side clamps);
 *   - count floor: the newest `policy.protectedToolResults` nodes stay
 *     protected even when one huge result alone exceeds the window;
 *   - tiers (emergency-drop.ts:54-55 / selection.rs:1185): T1 navigation
 *     (read/task/…) drops last, T2 edit-class drops next, T3 everything else
 *     drops first — oldest first within a tier.
 * Unknown context window → count-floor-only behavior (the pre-C1 semantics).
 *
 * #731 guard (upstream 7d393ae78 `preserve tool results when emergency
 * reclaim cannot fit`, selection.rs `floor_above_ceiling`): when the
 * whole-surface estimate MINUS every reclaimable node still exceeds the
 * context window, dropping cannot make the request fit — the fixed floor
 * (system prompt, user turns, protected results) alone busts it. The drop
 * lane then refuses to fire (`skipped: 'cannot-fit'`) and preserves the
 * results: destroying them would not prevent the overflow, only the work.
 * The estimate is chars/4 and under-counts wire extras (tool defs), so the
 * guard biases toward NOT skipping — the previous drop-everything behavior
 * stays reachable whenever the fit is even plausible.
 */
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { dropPlaceholderContent, replaceToolResultContent, type SurfaceToolNode } from './seams.ts'
import type { PressurePolicy } from '../core/policy.ts'
import { deriveProtectedTailTokenTarget } from '../core/protected-tail.ts'

export interface EmergencyReclaimResult {
  /** Nodes replaced with placeholders, tier order then oldest first. */
  readonly dropped: ReadonlyArray<{ seq: SessionSeq; tagNumber: number }>
  /** Nodes shielded by the protected window (newest first within the window). */
  readonly protectedCount: number
  /** The token estimate of the protected window, when a window applied. */
  readonly protectedTokens?: number
  /**
   * #731: the drop lane refused to fire because even dropping every
   * reclaimable node cannot fit the request into the window. Results are
   * preserved; the caller reports the overflow instead of retrying.
   */
  readonly skipped?: 'cannot-fit'
  /** With `skipped`: the surface estimate that would REMAIN after the refused drop. */
  readonly residualTokens?: number
}

/** MC emergency-drop.ts:54-55 — T1 keeps longest, T2 medium, T3 default. */
const T1_TOOLS = new Set(['read', 'todowrite', 'task'])
const T2_TOOLS = new Set(['edit', 'write', 'apply_patch', 'grep', 'glob'])

export type ToolTier = 1 | 2 | 3

/** MC normalizeToolName: lowercase; strip the `mcp_` provider prefix. */
export function normalizeToolName(toolName: string | null): string {
  const lowered = (toolName ?? '').toLowerCase().trim()
  return lowered.startsWith('mcp_') ? lowered.slice(4) : lowered
}

export function resolveToolTier(toolName: string | null): ToolTier {
  const name = normalizeToolName(toolName)
  if (T1_TOOLS.has(name)) return 1
  if (T2_TOOLS.has(name)) return 2
  return 3
}

/** clamp(contextWindow × 5%, 8k, 64k) — undefined when the window is unknown. */
/**
 * How many tokens at the tail are spared from an emergency reclaim.
 *
 * This used to be `min(64k, max(8k, context × 5%))` — a flat slice of the RAW
 * window with no notion of pressure — while `core/protected-tail.ts` already
 * carried upstream's derivation (`deriveProtectedTailTokenTarget`, from the USABLE
 * window and shrinking as the session fills). Two implementations of one rule,
 * and the reclaim lane was using the wrong one: a flat 5% protected a fraction of
 * the intended slice at low pressure and too much at high pressure, which is
 * precisely when holding the tail back is what fills the window.
 *
 * This now delegates, so there is one rule.
 */
export function protectionWindowTokens(
  contextWindow: number | undefined,
  options: {
    readonly executeThresholdPercentage?: number
    readonly usagePercentage?: number
  } = {},
): number | undefined {
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined
  }
  return deriveProtectedTailTokenTarget({
    contextLimit: contextWindow,
    executeThresholdPercentage: options.executeThresholdPercentage ?? 65,
    usagePercentage: options.usagePercentage ?? 0,
  }).N
}

/**
 * Token estimate for a text length already reduced to characters.
 *
 * The callers here only kept the LENGTH (the node's text is gone by the time a
 * drop decision is made), so this cannot classify characters. It therefore takes
 * the conservative direction: budget as if the text were CJK (1 token/char) is
 * wrong in the other direction, so it keeps 4 chars/token for the ASCII bulk and
 * relies on `estimateTokens` everywhere the text itself is available.
 */
function tokensFor(textLength: number): number {
  return Math.max(1, Math.ceil(textLength / 4))
}

/**
 * Drop reclaimable tool results. A node is reclaimable when it carries an
 * adapter tag, is not already a placeholder, and sits outside the protected
 * window: the newest results whose cumulative estimate fits the token window,
 * plus at least the newest `policy.protectedToolResults` tagged nodes.
 */
/**
 * The token weight of the results a reclaim may NOT drop.
 *
 * These are the newest results inside the mass window plus the newest
 * `protectedToolResults` nodes — the same set `reclaimForEmergency` keeps. Its
 * only caller today is the fail-closed refusal decision, which needs it for a
 * different question: a request over the limit can still be saved by dropping
 * reclaimable output, so refusing is only justified when **this** number alone
 * already exceeds the limit (upstream `outgoingContextRefusal`,
 * `emergency-fail-closed.ts:71`).
 */
export function protectedToolTokens(
  nodes: readonly SurfaceToolNode[],
  policy: PressurePolicy,
  contextWindow?: number,
  usagePercentage?: number,
): number {
  const tagged = nodes.filter(node => node.tagNumber !== undefined && !node.isPlaceholder)
  const windowTokens = protectionWindowTokens(contextWindow, {
    executeThresholdPercentage: policy.executeThreshold,
    ...usagePercentage === undefined ? {} : { usagePercentage },
  })
  let total = 0
  let mass = 0
  for (let index = tagged.length - 1; index >= 0; index -= 1) {
    const node = tagged[index] as SurfaceToolNode
    const cost = tokensFor(node.textLength)
    const withinMassWindow = windowTokens !== undefined && mass + cost <= windowTokens
    const withinCountFloor = tagged.length - 1 - index < policy.protectedToolResults
    if (!withinMassWindow && !withinCountFloor) break
    total += cost
    if (withinMassWindow) mass += cost
  }
  return total
}

export function reclaimForEmergency(
  session: Session,
  nodes: readonly SurfaceToolNode[],
  policy: PressurePolicy,
  contextWindow?: number,
  /** #731: whole-surface token estimate (all nodes); without it the guard is off. */
  surfaceTokensEstimate?: number,
  /** Current usage, which the protected-tail target scales down against. */
  usagePercentage?: number,
): EmergencyReclaimResult {
  const tagged = nodes.filter(node => node.tagNumber !== undefined && !node.isPlaceholder)
  const windowTokens = protectionWindowTokens(contextWindow, {
    executeThresholdPercentage: policy.executeThreshold,
    ...usagePercentage === undefined ? {} : { usagePercentage },
  })

  // Which nodes survive. Two independent floors, and the WIDER one wins:
  //
  //  - mass window: newest results whose cumulative estimate fits windowTokens
  //    (upstream `mass_cutoff`);
  //  - count floor: the newest `policy.protectedToolResults` results
  //    (upstream's structural `newest3_cutoff`, exposed here as a policy knob).
  //
  // Upstream computes this as `cutoff = min(mass_cutoff, newest3_cutoff)` over
  // tag numbers, i.e. the more conservative of the two. Keeping them separate and
  // taking the union is the same rule for a surface where every row carries its
  // own tag, and it preserves the property the count floor exists for: a single
  // result larger than the whole window must not evict everything.
  const protectedSeqs = new Set<SessionSeq>()
  let protectedTokens = 0
  let mass = 0
  for (let index = tagged.length - 1; index >= 0; index -= 1) {
    const node = tagged[index] as SurfaceToolNode
    const cost = tokensFor(node.textLength)
    const withinMassWindow = windowTokens !== undefined && mass + cost <= windowTokens
    const withinCountFloor = tagged.length - 1 - index < policy.protectedToolResults
    if (!withinMassWindow && !withinCountFloor) break
    protectedSeqs.add(node.seq)
    protectedTokens += cost
    if (withinMassWindow) mass += cost
  }

  // Drop order: worst tier first, oldest first inside a tier.
  const reclaimable = tagged
    .filter(node => !protectedSeqs.has(node.seq))
    .sort((left, right) =>
      resolveToolTier(right.toolName ?? null) - resolveToolTier(left.toolName ?? null)
      || left.seq - right.seq)

  // #731: if everything reclaimable vanished and the request STILL would not
  // fit, the drop cannot fix the overflow — preserve the results (upstream:
  // `Rewriting tools cannot fix oversized fixed overhead`).
  if (contextWindow !== undefined && surfaceTokensEstimate !== undefined) {
    const reclaimableTokens = reclaimable.reduce(
      (total, node) => total + tokensFor(node.textLength), 0)
    const residualTokens = surfaceTokensEstimate - reclaimableTokens
    if (residualTokens > contextWindow) {
      return {
        dropped: [],
        protectedCount: tagged.length - reclaimable.length,
        ...windowTokens === undefined ? {} : { protectedTokens },
        skipped: 'cannot-fit',
        residualTokens,
      }
    }
  }

  const dropped: Array<{ seq: SessionSeq; tagNumber: number }> = []
  for (const node of reclaimable) {
    const tagNumber = node.tagNumber
    if (tagNumber === undefined) continue
    replaceToolResultContent(session, node.seq, dropPlaceholderContent(tagNumber))
    dropped.push({ seq: node.seq, tagNumber })
  }
  return {
    dropped,
    protectedCount: tagged.length - reclaimable.length,
    ...windowTokens === undefined ? {} : { protectedTokens },
  }
}
