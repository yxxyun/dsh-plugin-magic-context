/**
 * The management pass — everything the adapter does inside the execute band,
 * in one place, in Magic Context's order:
 *
 *   1. land queued ctx_reduce marks as `[dropped §N§]` placeholders;
 *   2. publish historian compartments as `[compacted §C<n>§]` range
 *      replacements (the digest itself travels in the baseline node);
 *   3. force reclaim when pressure reaches the force band;
 *   4. refresh the m[0]/m[1] baseline node — but ONLY when its rendered
 *      content actually changed (a no-op pass must not bust the cache);
 *   5. fire the historian out of band (it writes a store row; nothing on the
 *      wire changes because of it).
 *
 * All surface work happens here and only here: the execute band is the one
 * bust permission, and every step above is a durable mutation that spends it.
 */
import {
  compactedPlaceholder,
  estimateTokens,
  findBaselineRange,
  renderBaseline,
  renderMemoryUpdates,
  stripBaseline,
  type Compartment,
  type MemoryUpdateLine,
} from '../core/compartments.ts'
import type { Journal } from '../core/journal.ts'
import type { MemoryFact } from '../core/memory-categories.ts'
import { renderMemoryLine, type MemoryRow, type ProfileRecallResult } from '../core/memory-bridge.ts'
import type { PassDecision, PressurePolicy } from '../core/policy.ts'
import type { AdapterStores, BaselineState } from '../core/stores.ts'
import { errText } from '../core/types.ts'
import { effectiveForceThreshold } from '../core/escalation-bands.ts'
import { DRAIN_FAILURE_BACKOFF_MS, reserveDrain, selectPerRunCap } from '../core/drain-budget.ts'
import { resolvedEmergencyDrainLatch } from '../core/drain-latch.ts'
import { dropsSuffice } from '../core/drop-projection.ts'
import { landPendingDrops, type LandedDrops } from './drop-landing.ts'
import { historianTriggerBudget, selectHistorianRange } from './historian.ts'
import { historianFailureCount, shouldNoticeHistorianFailures } from './historian.ts'
import {
  buildHistorianFailureNotice,
  HISTORIAN_PERSISTENT_FAILURE_THRESHOLD,
} from '../core/user-facing-codes.ts'
import { appendMagicContextEntry } from './session-notice.ts'
import { reclaimForEmergency } from './emergency.ts'
import { runHistorian, type HistorianDeps, type HistorianLlm } from './historian.ts'
import type { CompartmentLease } from '../core/compartment-lease.ts'
import {
  dropPlaceholderContent,
  enumerateSurfaceNodes,
  enumerateSurfaceToolResults,
  magicContextSource,
  pairingClosedWindow,
  replaceSurfaceRange,
  replaceToolResultContent,
  syntheticNodeId,
  wireStrandedResults,
  type ContentBlock,
  type Session,
  type SessionSeq,
  type SurfaceNode,
} from './seams.ts'

/**
 * Runs whose rejection has already been journalled. `runHistorian` hands the
 * SAME promise back to every pass that asks while it is in flight, so a bare
 * `.catch()` per pass writes one terminal row per pass — the 2026-11-18 RCC
 * session turned 21 failures into 60 rows that way.
 */
const loggedHistorianRuns = new WeakSet<Promise<unknown>>()

export interface ManagementPassLogger {
  info(message: string): void
  warn(message: string): void
}

export interface ManagementPassInput {
  readonly session: Session
  readonly sessionId: string
  readonly stores: AdapterStores
  readonly policy: PressurePolicy
  readonly logger: ManagementPassLogger
  readonly pass: Extract<PassDecision, { kind: 'execute' }>
  readonly pressure: number | undefined
  /**
   * The reading behind `pressure` predates a change to the injected surface (a
   * compartment was stored, or the baseline was refreshed). It is still the best
   * size signal the decision has — the host reports nothing newer — but it must
   * not drive a SECOND forced reclaim: the wire it measured no longer exists, so
   * dropping again spends content the agent may still need.
   *
   * Upstream MC fixed the same class in v0.49.49 (`usagePredatesHistoryChange`);
   * our version only guards the force band — the deadlock half of that fix does
   * not apply, because the adapter never refuses to send.
   */
  readonly pressureStale?: boolean
  /** Route + window facts for the historian's auxiliary call. */
  readonly route?: { provider: string; model: string }
  readonly contextWindow?: number
  /** The historian model's own context window (chunk sizing), when known. */
  readonly historianContextWindow?: number
  /**
   * A historian run is already in flight for this session. Nothing will publish
   * on this pass, so the baseline refresh waits for the digest instead of paying
   * for a second rewrite of the same prefix 20–30 s early.
   */
  readonly historianBusy?: boolean
  /** The historian's seam; omitted disables historian firing (tests, hosts). */
  readonly historian?: { readonly llm: HistorianLlm; readonly now?: () => number; readonly route?: { provider: string; model: string } }
  /** Validation-period activity journal (optional). */
  readonly journal?: Journal
  /** Project memories to inject (already rendered, in MC render order). */
  readonly memories?: {
    readonly digest: string
    readonly lines: readonly string[]
    /** Memories written after the m[0] watermark → rendered in m[1]. */
    readonly newLines?: readonly string[]
    /** Ids of {@link newLines}, so `<memory-updates>` cannot duplicate them. */
    readonly newMemoryIds?: readonly number[]
    /**
     * Ids actually rendered in the m[0] baseline this pass (recall rows).
     * `<memory-updates>` announces only mutations whose target is one of
     * them — MC inject-compartments.ts:2843-2848 — so a budget-truncated
     * row never earns a phantom `<updated>`/`<removed>` pointer.
     */
    readonly baselineIds?: readonly number[]
    /**
     * A1: every currently-visible memory id (pre-budget) — MC's
     * `eligibleMemoryIds`. Supplied, `<memory-updates>` collects forced rows
     * (a superseded replacement, a visibility flip) up to
     * MAX_FORCED_MEMORIES_PER_DELTA and they render in `<new-memories>`
     * regardless of the delta budget.
     */
    readonly eligibleIds?: readonly number[]
    /** Visible rows themselves, for rendering the forced lines. */
    readonly eligibleRows?: readonly MemoryRow[]
    /** The watermark to freeze when this pass performs a HARD rebuild. */
    readonly maxMemoryId?: number
  }
  /**
   * The non-additive change lane: Magic Context's `memory_mutation_log` delta
   * (read through `MemoryBridge.mutations`). Rendered as `<memory-updates>` in
   * the m[1] region; a HARD rebuild freezes the cursor and swallows the delta
   * into m[0], exactly like `maxMemoryId`.
   */
  readonly memoryUpdates?: {
    readonly updates: readonly MemoryUpdateLine[]
    /** `MAX(mutation id)` now — frozen as the cursor on a HARD rebuild. */
    readonly cursor?: number
    /** Epoch fingerprint; a change forces the HARD rebuild + cursor reset. */
    readonly projectEpochFingerprint?: string
  }
  /**
   * WP8: the user profile (`user_memories`, read through
   * `MemoryBridge.profileRecall`). It is the one global lane with no activation
   * rule, so it renders in m[0] above the project memories — and, unlike Magic
   * Context, a rewrite or a dismissal of a rendered row DOES fold m[0]: serving
   * a stale profile block forever is worse than one rebuild.
   */
  readonly profile?: ProfileRecallResult
  /** Historian fact promotion into the shared memory store (optional). */
  readonly memoryPromote?: (input: {
    readonly identity: string
    readonly facts: readonly MemoryFact[]
    readonly sessionId: string
  }) => {
    readonly inserted: ReadonlyArray<{ id: number; category: string }>
    readonly seenAgain: ReadonlyArray<{ id: number }>
    readonly skipped: ReadonlyArray<{ category: string; reason: string }>
  }
  /** The project identity facts belong to (required for promotion). */
  readonly memoryIdentity?: string
  /**
   * WP5: the `user` domain's candidate sink, handed to the historian. Present
   * only when the lane is switched on (`memory.global.user.collect`, default
   * off); the historian calls it after the compartment is durable and swallows
   * its failures, so a candidate problem can never cost a digest.
   */
  readonly profileCollect?: (input: {
    readonly sessionId: string
    readonly observations: readonly string[]
    readonly compartmentStart: number | null
    readonly compartmentEnd: number | null
  }) => { readonly inserted: number; readonly skipped: number } | void
  /**
   * Cross-process lease on compartment state, handed to the historian. The
   * in-process `inFlight` guard cannot see a second process (HMR remount, or
   * another session sharing this database), so a lost race would let two passes
   * publish compartments against the same baseline.
   */
  readonly lease?: CompartmentLease
  readonly now?: () => number
}

export interface ManagementPassResult {
  readonly landedDrops: readonly number[]
  /**
   * Queued drops retired because their target left the surface (compacted away
   * or never mapped). They are NOT reclaim: the text was already folded into a
   * compartment, so counting them as landed tokens would inflate the proof.
   */
  readonly retiredDrops: readonly number[]
  readonly published: readonly number[]
  readonly forceDropped: number
  /** Stranded tool/results swept off the wire this pass (the iron-rule repair). */
  readonly wireRepaired: number
  readonly baselineUpdated: boolean
  /**
   * A historian run was REQUESTED this pass (fire-and-forget), not that one
   * started: the promise is detached, so a crash between the request and the
   * first chunk leaves this true and `historian` journal rows absent. Named
   * `historianStarted` until 2026-11-10, which read as the stronger claim and
   * made "5 requests / 0 runs" look like a bug in the wrong place. Reports
   * accept both spellings.
   */
  readonly historianRequested: boolean
  /**
   * Net reclaim proof: the estimate of the whole current surface before and
   * after this pass. Without it a review can only show that reclaim ACTIONS
   * happened, never that the prompt actually got smaller.
   */
  readonly tokensBefore: number
  readonly tokensAfter: number
  /** Facts newly written to project memory during this pass's publishes. */
  readonly factsPromoted: number
  /** Facts that deduplicated against existing rows (seen_count bumped). */
  readonly factsSeenAgain: number
}

/** Estimated tokens of every current surface node (shared with the emergency
 * lane in index.ts — the #731 fit guard needs the whole-surface estimate). */
export function surfaceTokens(session: Session): number {
  return enumerateSurfaceNodes(session).reduce((total, node) => total + (node.hasText ? estimateTokens(node.text) : 0), 0)
}

/** The baseline block currently carried by a node, when it has one. */
function baselineBlockOf(text: string): string | undefined {
  const range = findBaselineRange(text)
  return range === undefined ? undefined : text.slice(range.start, range.end)
}

/** Compose the baseline block ahead of the node's own (baseline-free) content. */
function composeBaselineContent(node: SurfaceNode, block: string): ContentBlock[] {
  const stripped = stripBaseline(node.text)
  const content: ContentBlock[] = [{ type: 'text', text: block }]
  if (stripped.length > 0) content.push({ type: 'text', text: stripped })
  return content
}

/** Split stored compartments into the frozen m[0] set and the m[1] delta. */
/**
 * The m[0] compartment boundary to persist (upstream `cachedM0MaxCompartmentSeq`).
 * 0 when m[0] holds nothing, which the loader reads back as "no boundary" and the
 * split then falls back to the frozen timestamp.
 */
function highestCompartmentId(compartments: readonly Compartment[]): number {
  let highest = 0
  for (const compartment of compartments) {
    if (compartment.compartmentId > highest) highest = compartment.compartmentId
  }
  return highest
}

export function splitBaselineSets(
  compartments: readonly Compartment[],
  state: BaselineState | undefined,
): { baseline: Compartment[]; delta: Compartment[] } {
  if (state === undefined) return { baseline: [...compartments], delta: [] }
  // Sequence boundary (upstream `cachedM0MaxCompartmentSeq`), not a timestamp.
  // A time boundary is ambiguous for two compartments created in the same
  // millisecond and inverts on a clock step backwards — which silently rewrites
  // the frozen prefix, the one thing m[0] must never do. Rows written before
  // v17 carry no sequence, so they fall back to the frozen timestamp once.
  const boundary = state.maxCompartmentId
  const inBaseline = boundary === undefined
    ? (compartment: Compartment): boolean => compartment.createdAt <= state.frozenAt
    : (compartment: Compartment): boolean => compartment.compartmentId <= boundary
  return {
    baseline: compartments.filter(inBaseline),
    delta: compartments.filter(compartment => !inBaseline(compartment)),
  }
}

/**
 * Publish unlanded compartments: replace each covered span with one
 * `[compacted §C<n>§]` node citing the originals. A compartment whose covered
 * nodes are already shadowed is marked landed with seq 0 ("nothing to
 * replace") so the pass does not retry forever.
 */
/** The subset of the pass input the publish lane actually reads. */
type PublishCompartmentsInput = Pick<
  ManagementPassInput,
  'session' | 'sessionId' | 'stores' | 'policy' | 'journal' | 'now' | 'memoryPromote' | 'memoryIdentity'
>

function publishCompartments(input: PublishCompartmentsInput): {
  ids: number[]
  factsPromoted: number
  factsSeenAgain: number
} {
  const published: number[] = []
  let factsPromoted = 0
  let factsSeenAgain = 0
  const baselineNodeSeq = input.stores.baselineState(input.sessionId)?.nodeSeq
  for (const compartment of input.stores.listUnlandedCompartments(input.sessionId)) {
    const covered = new Set(compartment.coveredSeqs)
    // The host shadows every node in the POSITIONAL range between the two
    // endpoints, not the subset the compartment covered
    // (`host: packages/core/session/src/surface.ts:433`, asserted at `:363`).
    // Citing only the covered subset threw on the first node that had entered
    // the range since the compartment was drafted, and that threw the whole
    // pass — every pass, so nothing ever landed. Enumerate the live surface here
    // (the snapshot at the call site predates the previous replacement) and cite
    // the whole range.
    const live = enumerateSurfaceNodes(input.session)
    const positions: number[] = []
    live.forEach((node, index) => {
      if (covered.has(node.seq)) positions.push(index)
    })
    if (positions.length === 0 || (baselineNodeSeq !== undefined && covered.has(baselineNodeSeq))) {
      input.stores.markCompartmentLanded(input.sessionId, compartment.compartmentId, 0)
      continue
    }
    const rawFirst = positions[0] as number
    const rawLast = positions[positions.length - 1] as number
    // Drop placeholders re-sequence a result to the surface tail while its
    // tool_use stays inside the covered span; a range that cuts between them
    // strands the result and the next provider request fails validation
    // (live 2026-10-09). Widen to tool-pairing closure before cutting.
    const span = pairingClosedWindow(live, rawFirst, rawLast)
    const range = live.slice(span.first, span.last + 1)
    // m[0] is frozen at the head of the surface: folding it into a compartment
    // would leave the next refresh rewriting an unrelated `user` node as the
    // baseline. Defer instead; the guard clears once the surface moves on.
    if (baselineNodeSeq !== undefined && range.some(node => node.seq === baselineNodeSeq)) {
      input.journal?.warn(
        'compartment-published',
        `compartment §C${String(compartment.compartmentId)}§ deferred: its range now contains the m[0] baseline node`,
        {
          compartmentId: compartment.compartmentId,
          reason: 'baseline-in-range',
          nodes: range.length,
        },
        input.sessionId,
      )
      continue
    }
    // NOTE (2026-10-16): the fusion-v7 publish guard stood here (observe /
    // enforce over drift + no-gain verdicts). RETIRED by user decision: across
    // its whole observation window (2026-10-09 commit 96337e00b → 2026-10-16)
    // the journal recorded 0 `compartment-guard` hits against 58 clean
    // `compartment-published` rows, so even `enforce` would never have acted —
    // zero benefit, one more way to hold up a publish. The positional range +
    // pairing closure above remains the whole landing discipline.
    const first = range[0] as SurfaceNode
    const last = range[range.length - 1] as SurfaceNode
    // A host validator refusal here (2026-10-08 live incident: the pre-fix
    // shadow list missed range entrants, 69 journal errors across 2 sessions —
    // the same poisoned draft threw on EVERY pass) must be terminal for THIS
    // draft, never a retry loop, and must never starve the drafts behind it:
    // retire it as rejected (covered claims stay claimed, no re-digest flood;
    // the span stays on the wire, honestly) and let the loop move on.
    let landedSeq: SessionSeq
    try {
      landedSeq = replaceSurfaceRange(
        input.session,
        first.seq,
        last.seq,
        [{ type: 'text', text: compactedPlaceholder(compartment.compartmentId) }],
        range.map(node => node.seq),
        syntheticNodeId(`mc-compacted-${String(compartment.compartmentId)}`),
        magicContextSource(
          `Magic Context · compartment §C${String(compartment.compartmentId)}§ replaced ${String(range.length)} node(s) on the wire`,
        ),
      )
    } catch (error) {
      input.stores.markCompartmentRejected(input.sessionId, compartment.compartmentId, 'replace-failed')
      input.journal?.error(
        'compartment-published',
        `compartment §C${String(compartment.compartmentId)}§ replace refused; retired as rejected (span stays on the wire)`,
        {
          compartmentId: compartment.compartmentId,
          reason: 'replace-failed',
          nodes: range.length,
          error: errText(error),
        },
        input.sessionId,
      )
      continue
    }
    input.stores.markCompartmentLanded(input.sessionId, compartment.compartmentId, landedSeq)
    published.push(compartment.compartmentId)
    input.journal?.info(
      'compartment-published',
      `compartment §C${String(compartment.compartmentId)}§ replaced ${String(range.length)} nodes on the wire`,
      {
        compartmentId: compartment.compartmentId,
        nodes: range.length,
        coveredTokens: compartment.coveredTokens,
        estTokensReclaimed: range.reduce((total, node) => total + estimateTokens(node.text), 0),
        nodeSeq: landedSeq,
        importance: compartment.importance,
        ...((span.first !== rawFirst || span.last !== rawLast)
          ? { pairingClosure: { rawFirst, rawLast, first: span.first, last: span.last } }
          : {}),
      },
      input.sessionId,
    )
    // Magic Context promotes the compartment's facts in the same publish step
    // (`compartment-runner-incremental.ts:1077`). Ours is not one SQLite
    // transaction (the compartment store and the memory store are different
    // databases and different owners), so a failure is journaled and the facts
    // stay durably in the compartment row for a later retry — reclaim must not
    // stall on a memory problem.
    if (input.memoryPromote !== undefined && input.memoryIdentity !== undefined && compartment.facts.length > 0) {
      try {
        const outcome = input.memoryPromote({
          identity: input.memoryIdentity,
          facts: compartment.facts,
          sessionId: input.sessionId,
        })
        factsPromoted += outcome.inserted.length
        factsSeenAgain += outcome.seenAgain.length
        input.journal?.info(
          'memory-promote',
          `promoted ${String(outcome.inserted.length)} fact(s) into project memory`
            + `${outcome.seenAgain.length > 0 ? `, ${String(outcome.seenAgain.length)} already known` : ''}`,
          {
            compartmentId: compartment.compartmentId,
            identity: input.memoryIdentity,
            inserted: outcome.inserted.map(row => ({ id: row.id, category: row.category })),
            seenAgain: outcome.seenAgain.map(row => row.id),
            skipped: outcome.skipped,
          },
          input.sessionId,
        )
      } catch (error) {
        const detail = errText(error)
        input.journal?.error('error', `memory promotion failed: ${detail}`, {
          scope: 'memory-promote',
          detail,
          compartmentId: compartment.compartmentId,
        }, input.sessionId)
      }
    }
  }
  return { ids: published, factsPromoted, factsSeenAgain }
}

/**
 * Publish ready compartments OUTSIDE a management pass — the provider-overflow
 * path (index.ts `agent/request-error`) lands the bank before it drops tool
 * results: one replacement reclaims a whole digested span, an emergency drop
 * only individual tool results, and the request has already failed once, so
 * the bust cannot lose more than the failed retry did.
 *
 * The request-error lane is a forced execute band in everything but name —
 * the same exception family as the wire-repair iron rule (the provider
 * rejected the wire as-is). Same surface discipline as the pass's publish
 * lane (pairing closure, m[0]-baseline defer). NO baseline refresh and NO
 * fact promotion here: both belong to the next execute pass, the facts stay
 * durable in the compartment row, and the promotion retry is idempotent
 * (seen-again dedup).
 */
export function publishReadyCompartments(
  input: Pick<ManagementPassInput, 'session' | 'sessionId' | 'stores' | 'policy' | 'journal' | 'now'>,
): { ids: number[] } {
  return { ids: publishCompartments(input).ids }
}

/**
 * Refresh the baseline node: the first current `user` node carries the
 * m[0]/m[1] block ahead of its own content. Returns whether the surface
 * changed. A HARD rebuild (no state yet, route change, memory-digest change)
 * freezes m[0] again and empties the delta; otherwise the delta grows.
 */
/**
 * Renderer format stamp for the composed baseline (upstream
 * `compartmentRenderEpoch`). Bump this whenever a change to the renderer would
 * produce different bytes for the SAME inputs — tier selection, block layout,
 * header format. Every existing baseline then folds once, instead of surviving
 * as a mismatch nobody can see.
 */
export const BASELINE_RENDER_EPOCH = 4

/** Upstream `RECENT_TOOL_SKELETON_WINDOW` (apply-operations.ts:53). */
const RECENT_TOOL_SKELETON_WINDOW = 20
/** Upstream `SKELETON_REAL_INPUT_MAX_BYTES` (tool-input-size.ts:17). */
const SKELETON_REAL_INPUT_MAX_BYTES = 1_024

function refreshBaseline(
  input: ManagementPassInput,
  nodes: readonly SurfaceNode[],
): boolean {
  const now = input.now?.() ?? Date.now()
  const compartments = input.stores.listCompartments(input.sessionId)
  const memories = input.memories
  const profile = input.profile
  const updates = input.memoryUpdates
  const previous = input.stores.baselineState(input.sessionId)
  const routeChanged = previous !== undefined
    && (previous.provider !== input.route?.provider || previous.model !== input.route?.model)
  // Upstream `compartmentRenderEpoch`: a baseline written by a DIFFERENT renderer
  // must be folded once. Without this, changing how tiers are chosen (the decay
  // curve) left every existing baseline rendering at the old tiers forever,
  // because the cached bytes still matched the cached bytes.
  const renderEpochChanged = previous !== undefined
    && (previous.renderEpoch ?? 0) !== BASELINE_RENDER_EPOCH
  const memoriesChanged = previous !== undefined
    && previous.memoriesDigest !== undefined
    && memories !== undefined
    && previous.memoriesDigest !== memories.digest
  // The external-writer signal: Magic Context bumps
  // `project_state.project_memory_epoch` when an external edit (or a domain
  // /identity change) invalidates a running session's snapshot. Both the m[0]
  // pool AND the mutation cursor were built against the old epoch, so this is
  // a HARD rebuild — reusing the old cursor would render a misaligned delta.
  const epochChanged = previous !== undefined
    && previous.projectEpochFingerprint !== undefined
    && updates?.projectEpochFingerprint !== undefined
    && previous.projectEpochFingerprint !== updates.projectEpochFingerprint
  // One-time upgrade fold: a baseline written before the cursor column existed
  // cannot order its delta, so the first pass that actually has pending change
  // rows folds them into m[0] and stamps the cursor instead of rendering a
  // delta read from zero.
  const cursorUpgrade = previous !== undefined
    && previous.maxMemoryMutationId === undefined
    && updates !== undefined
    && updates.updates.length > 0
  // WP8: the profile's fold trigger. An entry ABOVE the frozen watermark is an
  // addition and rides m[1] without touching the prefix. A row AT or below it
  // being rewritten or dismissed changes the digest — and here, unlike Magic
  // Context whose version bump deliberately never folded m[0], the stale block
  // is rebuilt: a profile the agent keeps reading after it was retracted is
  // worse than one cache bust. The `''` sentinel recorded by an emptying fold
  // keeps a switched-off profile from rebuilding on every later pass.
  const profileChanged = previous !== undefined && (
    profile === undefined
      ? previous.profileM0Digest !== undefined && previous.profileM0Digest !== ''
      : previous.profileM0Digest === undefined
        ? true
        : previous.profileM0Digest !== profile.digest
  )
  // The idle-TTL rebuild (policy.ttlRebuild): the band fired because `ttlMs`
  // elapsed, i.e. the provider cache is already gone, so re-rendering here
  // costs nothing that is not already lost and folds m[1] back into m[0] for
  // the requests that follow. Off ⇒ the pass only lands queued work.
  const ttlFold = input.policy.ttlRebuild === true && input.pass.reason === 'cache-ttl-idle'
  const hard = ttlFold || previous === undefined || routeChanged || memoriesChanged || epochChanged || cursorUpgrade || profileChanged || renderEpochChanged  // Freeze targets for a HARD fold. Falling back to the previous values keeps a
  // pass that has no mutation lane (bridge unavailable) from rewinding them.
  const frozenCursor = updates?.cursor ?? previous?.maxMemoryMutationId
  const frozenEpochFingerprint = updates?.projectEpochFingerprint ?? previous?.projectEpochFingerprint
  const state: BaselineState = hard
    ? {
      sessionId: input.sessionId,
      epoch: (previous?.epoch ?? 0) + 1,
      ...previous?.nodeSeq === undefined ? {} : { nodeSeq: previous.nodeSeq },
      ...input.route === undefined ? {} : { provider: input.route.provider, model: input.route.model },
      frozenAt: now,
      ...memories === undefined ? {} : { memoriesDigest: memories.digest },
      // The watermark moves only on a HARD rebuild: everything written since
      // the previous fold becomes part of the frozen m[0] pool here.
      ...memories?.maxMemoryId === undefined ? {} : { maxMemoryId: memories.maxMemoryId },
      // WP8: the profile freeze. The digest recorded is the FOLD digest (every
      // active row), because this fold renders the whole profile and the next
      // pass's pool is exactly that set — recording the pool digest here would
      // buy a second, useless rebuild.
      profileM0Digest: profile?.foldDigest ?? '',
      ...profile === undefined
        ? previous?.profileWatermark === undefined ? {} : { profileWatermark: previous.profileWatermark }
        : { profileWatermark: profile.currentMaxId },
      // Same rule for the mutation cursor (§7.5 step 4): folding m[0] bakes the
      // pending updates in, so the `<memory-updates>` block disappears.
      ...frozenCursor === undefined ? {} : { maxMemoryMutationId: frozenCursor },
      ...frozenEpochFingerprint === undefined ? {} : { projectEpochFingerprint: frozenEpochFingerprint },
      updatedAt: now,
    }
    : { ...(previous as BaselineState), updatedAt: now }

  const sets = hard
    ? { baseline: compartments, delta: [] as Compartment[] }
    : splitBaselineSets(compartments, previous)
  // A1 (MC inject-compartments.ts:2822-2869): collect the forced ids first,
  // render their lines from the eligible rows, and hand both to renderBaseline.
  const forcedRender = renderMemoryUpdates(hard ? [] : updates?.updates ?? [], {
    ...memories?.newMemoryIds === undefined ? {} : { renderedIds: new Set(memories.newMemoryIds) },
    ...memories?.baselineIds === undefined ? {} : { baselineIds: new Set(memories.baselineIds) },
    ...memories?.eligibleIds === undefined ? {} : { eligibleIds: new Set(memories.eligibleIds) },
  })
  const forcedRowsById = new Set((memories?.eligibleRows ?? []).map(row => row.id))
  const forcedMemoryLines = forcedRender.forcedMemoryIds
    .filter(id => forcedRowsById.has(id))
    .map(id => renderMemoryLine((memories?.eligibleRows ?? []).find(row => row.id === id)!))
  // WP8: a HARD fold swallows the profile delta (the whole profile becomes
  // m[0]); a soft pass renders the pool in m[0] and the new entries in m[1].
  const profilePoolLines = hard
    ? [...(profile?.lines ?? []), ...(profile?.newLines ?? [])]
    : profile?.lines ?? []
  const profileDeltaLines = hard ? [] : profile?.newLines ?? []
  // The renderer is clock-free by construction (`compartments.ts`: tiers and
  // headers are positional, never wall-clock — upstream `m0_compose.rs:1-9`,
  // "same inputs → same bytes … never read here from a live clock"), so this
  // call is byte-stable on its own. `frozenAt` still matters: it is what
  // `splitBaselineSets` freezes m[0] against, and a SOFT pass must not move it.
  const block = renderBaseline({
    now,
    baseline: sets.baseline,
    delta: sets.delta,
    memories: memories?.lines ?? [],
    ...profilePoolLines.length === 0 ? {} : { profileLines: profilePoolLines },
    ...profileDeltaLines.length === 0 ? {} : { newProfileLines: profileDeltaLines },
    ...memories?.newLines === undefined ? {} : { newMemories: memories.newLines },
    ...memories?.newMemoryIds === undefined ? {} : { newMemoryIds: memories.newMemoryIds },
    ...memories?.baselineIds === undefined ? {} : { baselineIds: memories.baselineIds },
    ...memories?.eligibleIds === undefined ? {} : { eligibleIds: memories.eligibleIds },
    ...(forcedMemoryLines.length > 0 ? { forcedMemoryLines } : {}),
    // A HARD fold swallows the delta: the changes are part of the rebuilt m[0].
    // Otherwise the pending (post-cursor) changes render in m[1].
    ...hard || updates === undefined ? {} : { memoryUpdates: updates.updates },
    budgetTokens: input.policy.baselineTokens,
  })
  if (block.length === 0) return false

  // The baseline rides the first ordinary user node — never a compaction
  // checkpoint (host or engine). Attaching it to a checkpoint let that
  // checkpoint's own text ride inside m[0] forever: every later refresh
  // re-emitted the foreign summary and rewrote the node, and the GUI lost the
  // card it correlates by `source.kind === 'compact-checkpoint'` + compactionId.
  const target = nodes.find(node =>
    node.role === 'user'
    && node.sourceKind !== 'compact-checkpoint'
    // A `[dropped §N§]` placeholder must not carry the baseline. Prepending the
    // block to it would stop the text matching PLACEHOLDER_PATTERN, so the node
    // would no longer read as a placeholder — and the drop lane, which keys on
    // exactly that, would try to drop it again (and count it as reclaimable)
    // every pass. Upstream (`isDroppedPlaceholder`, inject-compartments.ts:835)
    // refuses such a message for the same reason and falls back to synthesising
    // one; this platform can only replace or append, so the honest move is to
    // look further down the surface.
    && !node.isPlaceholder)
  if (target === undefined) {
    // No anchor: the history block has nowhere safe to live. Say so — a silent
    // `return false` here is indistinguishable from "the block was already
    // current", and the session would keep running without its history.
    input.journal?.warn(
      'baseline',
      'baseline not written: no non-placeholder user message to anchor it to',
      { mode: hard ? 'hard' : 'soft', epoch: state.epoch },
      input.sessionId,
    )
    return false
  }
  if (baselineBlockOf(target.text) === block) {
    // Byte-identical: no durable mutation, no priced bust (MC's defer pass).
    if (state.nodeSeq !== target.seq || state.updatedAt !== previous?.updatedAt) {
      input.stores.saveBaselineState({
        ...state,
        nodeSeq: target.seq,
        ...input.route === undefined ? {} : { provider: input.route.provider, model: input.route.model },
        ...memories === undefined ? {} : { memoriesDigest: memories.digest },
        renderEpoch: BASELINE_RENDER_EPOCH,
        maxCompartmentId: highestCompartmentId(sets.baseline),
      })
    }
    return false
  }
  const landedSeq = replaceSurfaceRange(
    input.session,
    target.seq,
    target.seq,
    composeBaselineContent(target, block),
    [target.seq],
    syntheticNodeId('mc-baseline'),
    magicContextSource(
      `Magic Context · baseline ${hard ? 'HARD rebuild' : 'soft refresh'} `
        + `(m[0] ${String(sets.baseline.length)} · m[1] ${String(sets.delta.length)} · ${String(memories?.lines.length ?? 0)} memories)`,
    ),
  )
  input.stores.saveBaselineState({
    ...state,
    nodeSeq: landedSeq,
    ...input.route === undefined ? {} : { provider: input.route.provider, model: input.route.model },
    ...memories === undefined ? {} : { memoriesDigest: memories.digest },
    renderEpoch: BASELINE_RENDER_EPOCH,
    maxCompartmentId: highestCompartmentId(sets.baseline),
  })
  input.journal?.info(
    'baseline',
    `baseline ${hard ? 'HARD rebuild' : 'soft refresh'} (epoch ${String(state.epoch)})`,
    {
      mode: hard ? 'hard' : 'soft',
      epoch: state.epoch,
      nodeSeq: landedSeq,
      compartments: { baseline: sets.baseline.length, delta: sets.delta.length },
      memories: { rows: memories?.lines.length ?? 0, digest: memories?.digest.slice(0, 12) },
      profile: {
        rows: profile?.lines.length ?? 0,
        newRows: hard ? 0 : profile?.newLines.length ?? 0,
        digest: profile?.digest.slice(0, 12),
        watermark: state.profileWatermark,
      },
      memoryUpdates: {
        pending: updates?.updates.length ?? 0,
        rendered: hard ? 0 : updates?.updates.length ?? 0,
        cursor: state.maxMemoryMutationId,
        epochFingerprint: state.projectEpochFingerprint,
      },
      bytes: block.length,
      estTokens: estimateTokens(block),
      ...memoriesChanged ? { reason: 'memory-digest-changed' } : {},
      ...profileChanged ? { reason: 'profile-digest-changed' } : {},
      ...routeChanged ? { reason: 'route-changed' } : {},
      ...epochChanged ? { reason: 'project-memory-epoch-changed' } : {},
      ...cursorUpgrade ? { reason: 'mutation-cursor-upgrade' } : {},
      ...previous === undefined ? { reason: 'first-baseline' } : {},
    },
    input.sessionId,
  )
  return true
}

/** Upper bound of wire repairs per pass, so a pathological surface cannot monopolize the bust. */
const WIRE_REPAIR_CAP = 16

/**
 * The iron-rule repair: sweep live `tool/result` nodes whose tool_use left
 * the wire. One of them 400s every strict-provider request — the only adapter
 * failure mode that can take the whole conversation down — so they are
 * replaced with a tiny user note no matter what else this pass does. The
 * original content stays recoverable in the event log (the replacement cites
 * it); only the wire copy goes.
 * @returns the number of results swept this pass.
 */
function repairWirePairing(input: ManagementPassInput): number {
  const stranded = wireStrandedResults(input.session)
  if (stranded.length === 0) return 0
  const sweep = stranded.slice(0, WIRE_REPAIR_CAP)
  for (const defect of sweep) {
    replaceSurfaceRange(
      input.session,
      defect.seq,
      defect.seq,
      [{ type: 'text', text: '[magic-context] removed a tool result whose call left the wire' }],
      [defect.seq],
      syntheticNodeId(`mc-wire-repair-${String(defect.seq)}`),
      magicContextSource(`Magic Context · wire repair · removed stranded tool result ${String(defect.seq)}`),
    )
  }
  input.journal?.warn(
    'wire-repair',
    `swept ${String(sweep.length)} stranded tool result(s) off the wire`,
    {
      swept: sweep.length,
      seqs: sweep.map(defect => defect.seq),
      callIds: sweep.map(defect => defect.callId),
      remaining: stranded.length - sweep.length,
    },
    input.sessionId,
  )
  return sweep.length
}

/**
 * Run the management pass. Every step is independently guarded: a failure in
 * one must not wedge the turn (MC per-turn fail-open), and the next pass
 * re-decides from durable state.
 */
export function runManagementPass(input: ManagementPassInput): ManagementPassResult {
  const landedDrops: number[] = []
  /** Queued drops whose target left the surface — retired, never landed. */
  const retiredDrops: number[] = []
  let wireRepaired = 0
  const tokensBefore = surfaceTokens(input.session)
  const result: ManagementPassResult = {
    landedDrops,
    retiredDrops: [],
    published: [],
    forceDropped: 0,
    wireRepaired: 0,
    baselineUpdated: false,
    historianRequested: false,
    tokensBefore,
    tokensAfter: tokensBefore,
    factsPromoted: 0,
    factsSeenAgain: 0,
  }

  // 1. Queued ctx_reduce marks.
  let landed: LandedDrops = { landed: [], retired: [], skippedSmall: 0, reclaimedTokens: 0, alreadyLanded: [] }
  try {
    landed = landPendingDrops({
      session: input.session,
      sessionId: input.sessionId,
      stores: input.stores,
      policy: input.policy,
    })
    landedDrops.push(...landed.landed)
    retiredDrops.push(...landed.retired)
    // A store fault must reach the pass's terminal error row, exactly as it did
    // when this scan lived inline here.
    if (landed.error !== undefined) throw landed.error
    if (retiredDrops.length > 0) {
      input.journal?.info(
        'drop-retired',
        `retired ${String(retiredDrops.length)} drop(s) whose target left the surface: `
          + retiredDrops.map(tag => `§${String(tag)}§`).join(', '),
        { tags: retiredDrops, count: retiredDrops.length, reason: 'target-gone' },
        input.sessionId,
      )
    }
    if (landedDrops.length > 0) {
      input.journal?.info(
        'drop-landed',
        `landed ${String(landedDrops.length)} drop(s): ${landedDrops.map(tag => `§${String(tag)}§`).join(', ')}`,
        {
          tags: landedDrops,
          count: landedDrops.length,
          estTokens: landed.reclaimedTokens,
        },
        input.sessionId,
      )
    }

    // 1.5 Wire-pairing repair (the iron rule): sweep stranded results off the
    // wire before anything else reads the surface.
    wireRepaired = repairWirePairing(input)

    // 3. Force-band reclaim (before publishing, so a compartment range that
    //    lost its content to a drop still replaces the same nodes).
    let forceDropped = 0
    const forceBand = effectiveForceThreshold(input.policy)
    if (input.pressureStale === true && input.pressure !== undefined && input.pressure >= forceBand) {
      // The reading says "over the force band" but it was recorded before the
      // surface changed: reclaiming again would drop against a prompt that no
      // longer exists (upstream MC v0.49.49 half of issue 828). Reclaim is
      // irreversible, so it waits for a reading that describes the current wire.
      input.journal?.info(
        'emergency-reclaim',
        `force band: skipped — the ${input.pressure.toFixed(1)}% reading predates a surface change; no reclaim against a stale measurement`,
        {
          dropped: 0,
          reason: 'stale-reading',
          tier: 'skipped-stale-reading',
          pressure: input.pressure,
        },
        input.sessionId,
      )
    } else if (input.pressure !== undefined && input.pressure >= forceBand) {
      const generationBefore = input.session.surface.replaceGeneration
      // #731: pass the whole-surface estimate so the drop lane can refuse a
      // reclaim that cannot fit the request even at zero tool results.
      const reclaim = reclaimForEmergency(
        input.session,
        enumerateSurfaceToolResults(input.session, callId =>
          input.stores.getTag(input.sessionId, { kind: 'tool-result', callId })),
        input.policy,
        input.contextWindow,
        surfaceTokens(input.session),
      )
      forceDropped = reclaim.dropped.length
      if (forceDropped > 0) {
        input.journal?.warn(
          'emergency-reclaim',
          `force band: dropped ${String(forceDropped)} tool output(s) beyond the protected window`,
          {
            dropped: forceDropped,
            protected: reclaim.protectedCount,
            reason: 'force-threshold',
            pressure: input.pressure,
            generationBefore,
            generationAfter: input.session.surface.replaceGeneration,
          },
          input.sessionId,
        )
      } else if (reclaim.skipped === 'cannot-fit') {
        input.journal?.warn(
          'emergency-reclaim',
          `force band: reclaim skipped — dropping every reclaimable output still leaves ~${String(reclaim.residualTokens)} tokens against a ${String(input.contextWindow)}-token window (#731)`,
          {
            dropped: 0,
            protected: reclaim.protectedCount,
            reason: 'force-threshold',
            pressure: input.pressure,
            skipped: reclaim.skipped,
            residualTokens: reclaim.residualTokens,
            contextWindow: input.contextWindow,
            generationBefore,
            generationAfter: input.session.surface.replaceGeneration,
          },
          input.sessionId,
        )
      }
    }

    // 2 + 4: publish compartments, then refresh the baseline over the result.
    //
    // While a historian run is in flight, nothing publishes this pass, so the
    // only pending change is memory churn (promoted rows, queued updates). Those
    // used to be rendered immediately, which cost a second full-price rewrite
    // 20–30 s before the digest landed and rewrote the same prefix again
    // (measured 2026-11-11 12:08:58 + 12:09:26: 534 k tokens to reclaim 92 k).
    // Deferring the refresh until something actually publishes folds both into
    // one rewrite; the digest is bounded by `historianTimeoutMs`, so the
    // deferral cannot outlive it.
    const nodes = enumerateSurfaceNodes(input.session)
    const { ids: published, factsPromoted, factsSeenAgain } = publishCompartments(input)
    const afterPublish = published.length === 0 ? nodes : enumerateSurfaceNodes(input.session)
    const deferForHistorian = input.historianBusy === true && published.length === 0
    const baselineUpdated = deferForHistorian ? false : refreshBaseline(input, afterPublish)
    if (deferForHistorian) {
      input.journal?.info(
        'baseline',
        'baseline refresh deferred: historian in flight, nothing published yet (one rewrite instead of two)',
        { phase: 'deferred-historian-in-flight', pressure: input.pressure, trigger: input.pass.reason },
        input.sessionId,
      )
    }

    // 5. Fire the historian out of band; it only writes a store row.
    //
    // Admission is about WHO PAYS for the rewrite, not about pressure alone.
    // Publishing a compartment replaces the cached prefix, so the real cost of a
    // routine digest is one full-price step (~200–350 k) whenever the provider's
    // prompt cache is still alive. Measured 2026-11-11: every publish whose
    // previous step was 1–16 s old was followed by 0–14 % reuse, while every
    // publish preceded by 427–1703 s of idle was followed by 12–27 % — the cache
    // was already gone, so that rewrite was free.
    //
    // So the two free/paid windows decide:
    //   · idle band (`cache-ttl-idle`): it only fired because `ttlMs` elapsed,
    //     i.e. the cache has already expired — this is the CHEAPEST moment to
    //     rewrite, so a digest is exactly what should start here;
    //   · an active pass: the cache is alive, so a routine digest waits for the
    //     force band, where reclaiming is no longer optional.
    // (An earlier revision of this gate blocked idle digests instead — it read
    // the idle-gap cache loss as publish cost and pushed every digest into the
    // paid window. Reverted by measurement, not by taste.)
    let historianRequested = false
    // Charged only when a provider call is actually paid for: see `onStart` in
    // historian.ts. `historianRequested` stays for the release/return shape.
    let historianStarted = false
    // Tokens this pass reserved from the drain window (0 when nothing ran).
    let drainReserved = 0
    // The trigger decision is the historian's own (upstream `checkCompartmentTrigger`
    // runs the whole chain on every pass): force band, tail size, drain budget,
    // no-progress and the eligibility scan all live behind `runHistorian`. Keeping
    // a second gate here — "only escalate when the drops came up empty" — was a
    // local invention, and it fired the expensive lane for the wrong reason while
    // still holding it when the material was genuinely there.
    if (input.historian !== undefined) {
      // Upstream step 5 (`tail_size`) runs BEFORE the proactive floor on
      // purpose: enough narratable material fires a digest regardless of how low
      // the pressure is. Thresholds are upstream's, verbatim —
      // TAIL_SIZE_TRIGGER_MULTIPLIER = 3, MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE =
      // 6_000, MIN_PROACTIVE_TAIL_MESSAGE_COUNT = 12 — and `chunkHasMore` maps to
      // "the eligible span is larger than one chunk", which is the same signal
      // (there is more raw history than a single chunk read would take).
      const windowForTrigger = input.contextWindow ?? input.policy.assumedContextWindow
      // Trigger budget uses the USABLE window (context x executeThreshold), the
      // chunk budget uses the historian's own context. Two different bases, as
      // upstream keeps them (derive-budgets.ts).
      const chunkBudget = historianTriggerBudget(
        input.contextWindow,
        input.policy.historianAssumedWindow,
        input.policy.executeThreshold,
        input.policy.historianMinBudgetTokens,
      )
      // Advisory measurement: if any store seam is missing or throws, the pass
      // must not lose its drops over it. Fail-open in the PERMISSIVE direction —
      // an unmeasurable span is treated as "worth a look" and the historian's own
      // gates still decide.
      let eligibleTokens = 0
      let eligibleNodes = 0
      let chunkHasMore = true
      let tailSizeFire = true
      try {
        const eligible = selectHistorianRange({
          nodes: enumerateSurfaceNodes(input.session),
          covered: input.stores.coveredSeqs(input.sessionId),
          ...input.stores.baselineState(input.sessionId)?.nodeSeq === undefined
            ? {}
            : { baselineNodeSeq: input.stores.baselineState(input.sessionId)?.nodeSeq as never },
          protectedNodes: input.policy.historianProtectedNodes,
          minNodes: input.policy.historianMinNodes,
        })
        eligibleTokens = eligible?.tokens ?? 0
        eligibleNodes = eligible?.nodes.length ?? 0
        chunkHasMore = eligibleTokens > chunkBudget
        tailSizeFire = eligibleTokens >= chunkBudget * 3 || (chunkHasMore && eligibleTokens > 0)
      } catch {
        /* keep the permissive defaults above */
      }
      // Upstream constants, not configurable: MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE
      // (6_000) and MIN_PROACTIVE_TAIL_MESSAGE_COUNT (12). Making them yield to
      // `historianMinNodes` let a 3-node span through, and on a session that has
      // not configured its own historian route the run then borrowed the MAIN
      // model's adapter — consuming the test harness's scripted responses.
      const isMeaningful = chunkHasMore
        || eligibleTokens >= 6_000
        || eligibleNodes >= 12
      // Upstream step 6 (`proactive floor`): below `executeThreshold - 2` the
      // historian is not supposed to fire at all. The redundancy projection only
      // makes sense INSIDE the bands — evaluated at 18% it always says "drops are
      // enough", because at 18% everything is enough.
      const proactiveFloor = Math.max(0, input.policy.executeThreshold - 2)
      const idlePoke = input.pass.reason === 'cache-ttl-idle'
      const belowProactiveFloor = !idlePoke
        && input.pressure !== undefined
        && input.pressure < proactiveFloor
      // Upstream step 7 (`historian redundancy skip`): if landing this pass's
      // drops already brings usage under 75% of the execute threshold, the
      // summariser is redundant — a compartment would pay for a prefix rewrite
      // the drops just made unnecessary.
      const reclaimedThisPass = Math.max(0, tokensBefore - surfaceTokens(input.session))
      // The projection works in the SAME units as the trigger: the live pressure
      // reading, not the surface total. They diverge whenever the surface figure
      // and the measured pressure disagree (a fake or stale pressure in tests, a
      // window the provider reports differently), and using the surface total
      // made a force-band pass look like "drops are enough" because the fixture
      // surface was tiny.
      const windowForProjection = input.contextWindow ?? input.policy.assumedContextWindow
      const pressureTokens = input.pressure === undefined
        ? tokensBefore
        : Math.round((windowForProjection * input.pressure) / 100)
      // An unknown pressure must never block a digest (upstream's `usage` is
      // always present there; here it can be missing, and "we cannot measure"
      // is not "drops are enough").
      const dropsEnough = !idlePoke && input.pressure !== undefined && dropsSuffice({
        pressureTokens,
        droppableTokens: reclaimedThisPass,
        windowTokens: windowForProjection,
        executeThresholdPercentage: input.policy.executeThreshold,
      }) === true
      // The decision chain, in upstream's order (`checkCompartmentTrigger`).
      // The order matters: tail_size sits ABOVE the proactive floor so enough
      // material fires regardless of pressure, and the floor sits ABOVE the
      // redundancy projection so "drops are enough" is only ever asked inside
      // the bands.
      const forceBandHit = input.pressure !== undefined && input.pressure >= forceBand
      let skip: { phase: string; message: string; data: Record<string, unknown> } | null = null
      if (idlePoke) {
        // Platform difference: DSH's cache-ttl idle poke has no upstream twin.
        // The cache is already gone, so this is the cheapest moment to rewrite.
      } else if (forceBandHit) {
        if (dropsEnough) {
          skip = {
            phase: 'redundancy-skip',
            message: `drops reclaimed ${String(reclaimedThisPass)} tok, already under the `
              + `${String(Math.round(input.policy.executeThreshold * 0.75))}% target — no digest needed`,
            data: { reclaimedThisPass, pressure: input.pressure, band: 'force' },
          }
        }
      } else if (tailSizeFire) {
        // Enough narratable material, pressure irrelevant (upstream `tail_size`).
      } else if (belowProactiveFloor) {
        skip = {
          phase: 'below-proactive-floor',
          message: `${input.pressure?.toFixed(1) ?? '?'}% is below the ${String(proactiveFloor)}% proactive floor`,
          data: { pressure: input.pressure, proactiveFloor },
        }
      } else if (dropsEnough) {
        skip = {
          phase: 'redundancy-skip',
          message: `drops reclaimed ${String(reclaimedThisPass)} tok, already under the `
            + `${String(Math.round(input.policy.executeThreshold * 0.75))}% target — no digest needed`,
          data: { reclaimedThisPass, pressure: input.pressure, band: 'proactive' },
        }
      } else if (!isMeaningful) {
        skip = {
          phase: 'not-meaningful',
          message: `eligible head is below meaningfulness (${String(eligibleNodes)} nodes, `
            + `~${String(eligibleTokens)} tok)`,
          data: { eligibleNodes, eligibleTokens },
        }
      }
      if (skip !== null) {
        // TEMP: journal disabled for bisect
      } else {
      const deps: HistorianDeps = {
        stores: input.stores,
        policy: input.policy,
        llm: input.historian.llm,
        logger: input.logger,
        ...input.journal === undefined ? {} : { journal: input.journal },
        ...input.historian.route === undefined ? {} : { route: input.historian.route },
        ...input.historian.now === undefined ? {} : { now: input.historian.now },
        ...input.profileCollect === undefined ? {} : { profileCollect: input.profileCollect },
        ...input.lease === undefined ? {} : { lease: input.lease },
      }
      // One catch per RUN, not per pass. `runHistorian` reuses the in-flight
      // promise for a session, so attaching a handler on every pass multiplies
      // the terminal row: measured 2026-11-18 on the RCC ORC session, 21 failed
      // runs produced 60 `historian promise rejected` rows (2.86 per failure),
      // which reads like three times as much breakage as actually happened.
      // Reserve BEFORE the run (upstream `reserveProtectedTailDrainTokens`).
      // The earlier shape charged afterwards by what a pass reclaimed, which
      // made the limiter measure work already done — a pass that produced
      // nothing cost nothing, so the window never filled and a starving session
      // kept firing. A reservation sizes the run by what it will actually send
      // and either grants it or refuses to start.
      const reserveRun = (tokens: number): boolean => {
        try {
          const settled = input.historian?.now === undefined ? Date.now() : input.historian.now()
          const prior = input.stores.getDrainState(input.sessionId)
          const usable = Math.max(
            1,
            Math.round(
              ((input.contextWindow ?? input.policy.assumedContextWindow) * input.policy.executeThreshold) / 100,
            ),
          )
          const inFailureBackoff = prior.failureAt > 0
            && prior.failureAt <= settled
            && settled - prior.failureAt < DRAIN_FAILURE_BACKOFF_MS
          const result = reserveDrain({
            state: { windowStartedAt: prior.windowStartedAt, spentTokens: prior.spentTokens },
            requestedTokens: tokens,
            usagePercentage: input.pressure ?? 0,
            usable,
            perRunCap: selectPerRunCap(input.pressure ?? 0, usable, input.policy.protectedToolResults),
            // The latch is the emergency bypass: past the force band a spent
            // window must not be what strands the session.
            latchActive: (input.pressure ?? 0) >= forceBand,
            inFailureBackoff,
            now: settled,
          })
          if (!result.ok) {
            input.journal?.info(
              'drain',
              `historian held: drain window spent (${String(prior.spentTokens)}/${String(result.limitTokens)} tok); `
                + `next eligible in ${String(Math.max(0, Math.round((result.state.windowStartedAt + 10 * 60_000 - settled) / 1000)))}s`,
              {
                requestedTokens: tokens,
                spentTokens: prior.spentTokens,
                limitTokens: result.limitTokens,
                pressure: input.pressure,
                latchActive: (input.pressure ?? 0) >= forceBand,
                inFailureBackoff,
              },
              input.sessionId,
            )
            return false
          }
          input.stores.putDrainState(input.sessionId, {
            windowStartedAt: result.state.windowStartedAt,
            spentTokens: result.state.spentTokens,
            latchActiveSince: prior.latchActiveSince,
            failureAt: prior.failureAt,
          })
          drainReserved = result.reservedTokens
          return true
        } catch {
          // Accounting must never be the reason a run does not happen.
          return true
        }
      }
      const run = runHistorian(deps, {
        sessionId: input.sessionId,
        session: input.session,
        nodes: enumerateSurfaceNodes(input.session),
        ...input.stores.baselineState(input.sessionId)?.nodeSeq === undefined
          ? {}
          : { baselineNodeSeq: input.stores.baselineState(input.sessionId)?.nodeSeq as SessionSeq },
        ...input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow },
        ...input.route === undefined ? {} : { route: input.route },
        onStart: () => { historianStarted = true },
        reserveRun,
        ...input.pressure === undefined ? {} : { usagePercentage: input.pressure },
        ...input.historianContextWindow === undefined
          ? {}
          : { historianContextWindow: input.historianContextWindow },
      })
      // A reused run already carries its handler; a fresh one needs both (the
      // silent catch keeps an unhandled rejection from escaping).
      void (loggedHistorianRuns.has(run)
        ? run.catch(() => {})
        : loggedHistorianRuns.add(run) && run.catch((error: unknown) => {
          const why = errText(error)
          input.logger.warn(
            `magic-context historian failed (continuing): ${why}`,
          )
          // runHistorian journals its own terminal events; this row fires only
          // if the promise itself rejects — a bug in the guard plumbing. Better
          // a phase-less error row than a silent failure.
          input.journal?.error('error', `historian promise rejected: ${why}`, {
            scope: 'historian-unhandled',
            detail: why,
            errorName: error instanceof Error ? error.name : typeof error,
          }, input.sessionId)
          // Speak to the person, not just the journal (upstream
          // `buildHistorianFailureNotice`): once the streak hits the threshold the
          // setting is wrong, and "it will retry automatically" stops being true.
          // The RCC session failed 21 times over six hours without a word.
          const streak = historianFailureCount(input.stores, input.sessionId)
          if (shouldNoticeHistorianFailures(
            input.stores,
            input.sessionId,
            streak,
            HISTORIAN_PERSISTENT_FAILURE_THRESHOLD,
          )) {
            const notice = buildHistorianFailureNotice(streak)
            const appended = appendMagicContextEntry(input.session, notice, 'History compression failed')
            input.journal?.info('historian', `historian failure notice appended (streak ${String(streak)})`, {
              phase: 'failure-notice',
              streak,
              appended: appended.ok,
            }, input.sessionId)
          }
        }))
      historianRequested = true
      }
    }

    // Drain accounting (upstream a1ca346 `protectedTailDrain*` / `emergencyDrainActive`).
    // Charged with what this pass ACTUALLY reclaimed: a pass that landed nothing
    // costs nothing, so the budget measures work rather than attempts. The latch
    // is resolved from the same reading, which is what stops an irreducible floor
    // from re-entering the drain on every step.
    try {
      const settledNow = input.historian?.now === undefined ? Date.now() : input.historian.now()
      const prior = input.stores.getDrainState(input.sessionId)
      const reclaimed = Math.max(0, tokensBefore - surfaceTokens(input.session))
      // A historian run is charged its generation allowance on top of whatever
      // the drops reclaimed: it is the expensive half of the lane, and a pass
      // that emptied its drops but keeps re-summarising the same surface must
      // pay for the attempts, not just for their yield.
      // Scaled, not absolute: the allowance must mean the same thing on a 12-token
      // test window and a 262k production one. A flat 8192 against a 12-token
      // window spends the entire budget on the first digest and holds every
      // later pass, which is how this surfaced (phase2 boot uses a 12-token
      // adapter). 5% of the usable window, capped by the historian's own
      // generation allowance.
      const usableForCharge = Math.max(
        1,
        Math.round(
          ((input.contextWindow ?? input.policy.assumedContextWindow) * input.policy.executeThreshold) / 100,
        ),
      )
      const latchActiveSince = resolvedEmergencyDrainLatch(
        { activeSince: prior.latchActiveSince, failureAt: prior.failureAt },
        input.pressure ?? 0,
        forceBand,
        input.policy.executeThreshold,
        settledNow,
      )
      // `reserveRun` already persisted whatever this pass reserved; re-read so
      // the latch write does not overwrite it with the pre-reservation numbers.
      const afterReserve = input.stores.getDrainState(input.sessionId)
      input.stores.putDrainState(input.sessionId, {
        windowStartedAt: afterReserve.windowStartedAt,
        spentTokens: afterReserve.spentTokens,
        latchActiveSince,
        failureAt: prior.failureAt,
      })
      // Drops are not charged: upstream accounts only the historian's model
      // input, because that is the expensive half. A drop run that reclaims
      // nothing costs nothing and needs no limiter.
      if (drainReserved > 0) {
        input.journal?.info(
          'drain',
          `drain reserved ${String(drainReserved)} tok for the historian (window `
            + `${String(afterReserve.spentTokens)} tok since ${new Date(afterReserve.windowStartedAt).toISOString()})`,
          {
            reserved: drainReserved,
            windowSpent: afterReserve.spentTokens,
            windowStartedAt: afterReserve.windowStartedAt,
            latchActiveSince,
            pressure: input.pressure,
            trigger: input.pass.reason,
          },
          input.sessionId,
        )
      }
    } catch {
      // Accounting must never fail the pass that produced the work.
    }

    input.logger.info(
      `magic-context: execute pass (${input.pass.reason}) pressure=${input.pressure?.toFixed(1) ?? '?'}% `
        + `landed=[${landedDrops.map(tag => `§${String(tag)}§`).join(', ')}] `
        + `published=[${published.map(id => `§C${String(id)}§`).join(', ')}] `
        + `forceDropped=${String(forceDropped)} baseline=${baselineUpdated ? 'refreshed' : 'unchanged'} `
        + `tokens ${String(tokensBefore)}→${String(surfaceTokens(input.session))}`,
    )
    return {
      ...result,
      retiredDrops,
      published,
      forceDropped,
      wireRepaired,
      baselineUpdated,
      historianRequested,
      tokensAfter: surfaceTokens(input.session),
      factsPromoted,
      factsSeenAgain,
    }
  } catch (error) {
    // A failed management pass must never wedge the turn: log and continue
    // with the tagged messages (MC per-turn fail-open). The journal row is
    // what makes the failure diagnosable — the logger line alone is why a
    // run of silent failures could survive unnoticed (test-design audit P1-3).
    const why = errText(error)
    input.logger.warn(
      `magic-context: management pass failed (continuing): ${why}`,
    )
    input.journal?.error('error', `management pass failed: ${why}`, {
      scope: 'management-pass',
      detail: why,
      errorName: error instanceof Error ? error.name : typeof error,
      pressure: input.pressure,
      trigger: input.pass.reason,
    }, input.sessionId)
    // The drops scanned before the fault are real: report what actually
    // happened instead of the defaults, or a fail-open pass reads as "nothing
    // landed, nothing retired" while the wire shows the opposite.
    return { ...result, retiredDrops, landedDrops }
  }
}