/**
 * Land the queued drops on the live surface — the operation behind both the
 * management pass and `/ctx-flush`.
 *
 * Upstream splits these the same way: the pass applies pending operations
 * (`applyPendingOperations`, apply-operations.ts:488) and `executeFlush`
 * (execute-flush.ts:10) exists so a user can force the queue to settle without
 * waiting for a band. Here both go through this one function so the two can
 * never disagree about what "dropped" means.
 *
 * Three outcomes per tag, and they are different:
 *
 *   landed   — the result was replaced by `[dropped §N§]`.
 *   retired  — the target left the surface (folded into a compartment, or the
 *              call id no longer maps to a tag). Retiring is what keeps a stale
 *              queue from growing forever.
 *   skipped  — a small result inside the newest-call window: upstream's
 *              protection (`planNewToolDrop`, apply-operations.ts:132). It stays
 *              QUEUED, so a later pass can still decide to take it.
 *
 * Pure in the sense that matters: every effect goes through `session` or
 * `stores`, both injected, and nothing here throws — a broken drop must not take
 * the pass (or the command) down with it.
 */
import type { Session } from '@deepseek-ai/dsh-session'
import type { PressurePolicy } from '../core/policy.ts'
import type { AdapterStores } from '../core/stores.ts'
import { estimateTokens } from '../core/compartments.ts'
import {
  dropPlaceholderContent,
  enumerateSurfaceNodes,
  enumerateSurfaceToolResults,
  replaceToolResultContent,
} from './seams.ts'

/** Upstream `RECENT_TOOL_SKELETON_WINDOW` (apply-operations.ts:53). */
export const RECENT_TOOL_SKELETON_WINDOW = 20
/** Upstream `SKELETON_REAL_INPUT_MAX_BYTES` (tool-input-size.ts:17). */
export const SKELETON_REAL_INPUT_MAX_BYTES = 1_024

export interface LandedDrops {
  readonly landed: readonly number[]
  readonly retired: readonly number[]
  readonly skippedSmall: number
  /** Tokens the landed placeholders replaced, estimated before any mutation. */
  readonly reclaimedTokens: number
  /** Drop tags that were already placeholders (a previous pass landed them). */
  readonly alreadyLanded: readonly number[]
  /**
   * The first failure, when the scan could not complete. Carried rather than
   * swallowed: the management pass turns it into a diagnosable error row (and
   * keeps whatever landed before it), while `/ctx-flush` reports it to the user.
   * A silent skip here is how a broken store hides for weeks.
   */
  readonly error?: unknown
}

export function landPendingDrops(input: {
  readonly session: Session
  readonly sessionId: string
  readonly stores: AdapterStores
  readonly policy: PressurePolicy
}): LandedDrops {
  const landed: number[] = []
  const retired: number[] = []
  const alreadyLanded: number[] = []
  let skippedSmall = 0
  let reclaimedTokens = 0
  try {
    const toolNodes = enumerateSurfaceToolResults(input.session, callId =>
      input.stores.getTag(input.sessionId, { kind: 'tool-result', callId }))
    // Capture the pre-drop text BEFORE any replacement: rebuilding this map after
    // the loop reads back the placeholder, so every drop estimates as 0 tokens
    // and the reclaim accounting shows nothing (measured 2026-11-09: one record,
    // 165 tags, estTokens 0).
    const textBySeq = new Map(enumerateSurfaceNodes(input.session).map(node => [node.seq, node.text]))
    // Newest RECENT_TOOL_SKELETON_WINDOW tool tags whose result is small enough
    // that dropping it costs more than it reclaims.
    const smallFloor = input.policy.dropSmallResultFloor > 0
      ? Math.min(input.policy.dropSmallResultFloor, SKELETON_REAL_INPUT_MAX_BYTES)
      : 0
    const recentSmallToolTags = new Set(
      smallFloor === 0
        ? []
        : [...toolNodes]
            .filter(candidate => candidate.tagNumber !== undefined)
            .sort((left, right) => (right.tagNumber ?? 0) - (left.tagNumber ?? 0))
            .slice(0, RECENT_TOOL_SKELETON_WINDOW)
            .filter(candidate => (textBySeq.get(candidate.seq)?.length ?? 0) <= smallFloor)
            .map(candidate => candidate.tagNumber as number),
    )
    for (const tag of input.stores.listPendingDrops(input.sessionId)) {
      const node = toolNodes.find(candidate => candidate.tagNumber === tag)
      if (node === undefined) {
        input.stores.retireDrop(input.sessionId, tag)
        retired.push(tag)
        continue
      }
      if (node.isPlaceholder) {
        input.stores.markDropLanded(input.sessionId, tag, node.seq)
        alreadyLanded.push(tag)
        continue
      }
      if (recentSmallToolTags.has(tag)) {
        skippedSmall += 1
        continue
      }
      const before = textBySeq.get(node.seq)
      const landedSeq = replaceToolResultContent(input.session, node.seq, dropPlaceholderContent(tag))
      input.stores.markDropLanded(input.sessionId, tag, landedSeq)
      landed.push(tag)
      if (before !== undefined) reclaimedTokens += estimateTokens(before)
    }
  } catch (error) {
    // Whatever landed before the failure stays landed; the queue keeps the rest.
    return { landed, retired, skippedSmall, reclaimedTokens, alreadyLanded, error }
  }
  return { landed, retired, skippedSmall, reclaimedTokens, alreadyLanded }
}
