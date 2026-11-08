/**
 * Manual checkpoints — the compaction primitives that do NOT need the
 * `ctx.compaction` service.
 *
 * Why this file exists (2026-11-08): upstream Magic Context ships
 * `/ctx-wrapup [messages_to_keep]` as a first-class command, but this adapter
 * could only reach the same code through `registerMagicCompactionEngine`,
 * which is off by default because mounting it takes over `ctx.compaction` and
 * therefore fights the host's own `compaction-basic`. A user asking to "wrap
 * up before continuing" has no reason to also adopt Magic Context as their
 * compaction engine — those are two separate decisions, and bundling them made
 * the useful half unreachable.
 *
 * So the span picker and the checkpoint writer live here, free of the service
 * name, and both callers share them: the engine (`compaction-engine.ts`, for
 * `compactNow`) and the command (`wrapup.ts`, for `/ctx-wrapup`).
 */
import { randomUUID } from 'node:crypto'
import { compactedPlaceholder, estimateTokens, type CompartmentDraft } from '../core/compartments.ts'
import type { Journal } from '../core/journal.ts'
import type { PressurePolicy } from '../core/policy.ts'
import type { AdapterStores } from '../core/stores.ts'
import { callHistorian, type HistorianLlm } from './historian.ts'
import {
  compactCheckpointSource,
  enumerateSurfaceNodes,
  replaceSurfaceRange,
  syntheticNodeId,
  type ContentBlock,
  type Session,
  type SurfaceNode,
} from './seams.ts'

/** Everything a manual checkpoint needs. No `ctx.compaction` service involved. */
export interface ManualCompactionDeps {
  readonly stores: AdapterStores
  /** The pressure policy, or a LIVE resolver (the composition passes one). */
  readonly policy: PressurePolicy | (() => PressurePolicy)
  readonly logger: { info(message: string): void; warn(message: string): void }
  readonly journal?: Journal
  readonly llm?: HistorianLlm
  /** Static generation route (tests / stand-alone constructions). */
  readonly route?: { provider: string; model: string }
  /** Live generation route; `undefined` means "follow the session route". */
  readonly activeRoute?: () => { provider: string; model: string } | undefined
  readonly timeoutMs?: number
  readonly now?: () => number
}

/** What a written checkpoint covered. */
export interface ManualCheckpointResult {
  readonly compactionId: string
  readonly sourceCommandId?: string
  readonly startSeq: number
  readonly summarySeq: number
  readonly endSeq: number
  readonly summary: ContentBlock[]
  readonly shadowedRange: { readonly start: number; readonly end: number }
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount: number
  readonly importance: number
  readonly nodes: number
}

/** The digest text a checkpoint carries inline (the transcript keeps its placeholder). */
function digestText(draft: CompartmentDraft): string {
  const lines = [draft.tiers.p1]
  if (draft.facts.length > 0) {
    lines.push(`facts: ${draft.facts.map(fact =>
      fact.category.length === 0 ? fact.content : `[${fact.category}] ${fact.content}`).join(' | ')}`)
  }
  if (draft.events.length > 0) lines.push(`events: ${draft.events.join(' | ')}`)
  return lines.join('\n')
}

/** Resolve the live policy at the use point (snapshot fallback). */
function policyOf(deps: ManualCompactionDeps): PressurePolicy {
  return typeof deps.policy === 'function' ? deps.policy() : deps.policy
}

/**
 * The manual span: the same eligibility rules as the automatic historian,
 * without the token gate.
 *
 * `keep` overrides how many of the newest surface nodes stay untouched
 * (`/ctx-wrapup <n>`); without it the policy's `historianProtectedNodes` wins,
 * which is what `/compact` semantics expect.
 * @param nodes - the current surface, oldest first.
 * @param stores - for the covered-seq set and the baseline node seq.
 * @param sessionId - whose coverage to honour.
 * @param policy - protection window and minimum span size.
 * @param keep - override for the protected tail count.
 * @returns the nodes to digest, or `[]` when nothing eligible remains.
 */
export function pickManualSpan(
  nodes: readonly SurfaceNode[],
  stores: AdapterStores,
  sessionId: string,
  policy: PressurePolicy,
  keep?: number,
): SurfaceNode[] {
  const covered = stores.coveredSeqs(sessionId)
  const baselineNodeSeq = stores.baselineState(sessionId)?.nodeSeq
  const skippable = (node: SurfaceNode): boolean =>
    node.role === 'system'
    || node.seq === baselineNodeSeq
    || covered.has(node.seq)
    || node.isPlaceholder
    || /^\[(?:dropped|compacted|checkpoint) §/.test(node.text.trim().slice(0, 24))
    || !node.hasText
  let start = 0
  while (start < nodes.length && skippable(nodes[start] as SurfaceNode)) start += 1
  if (start >= nodes.length) return []
  const protect = Math.max(0, keep ?? policy.historianProtectedNodes)
  let cut = Math.max(start, nodes.length - protect)
  while (cut > start && (nodes[cut] as SurfaceNode | undefined)?.role === 'tool') cut -= 1
  const slice = nodes.slice(start, cut)
  return slice.length >= Math.max(2, policy.historianMinNodes) ? slice : []
}

/**
 * Summarize a span and write the checkpoint protocol
 * (`compaction/start` → `compaction/summary` → surface replacement →
 * `compaction/end`).
 *
 * The shadow-price protocol is copied verbatim from the engine's own writer:
 * the replacement is appended synchronously right after its metering event,
 * and the checkpoint's `source` is `compact-checkpoint` so the Chat client can
 * correlate the card to it.
 * @param deps - stores-free seams (policy, llm, route, journal).
 * @param input - the session and the span to digest.
 * @returns what the checkpoint covered.
 */
export async function writeManualCheckpoint(
  deps: ManualCompactionDeps,
  input: {
    readonly session: Session
    readonly nodes: readonly SurfaceNode[]
    readonly sourceCommandId?: string
    readonly signal?: AbortSignal
  },
): Promise<ManualCheckpointResult> {
  if (deps.llm === undefined) throw new Error('no LLM seam available for a manual compaction')
  const policy = policyOf(deps)
  const sessionId = input.session.id
  const generationRoute = deps.activeRoute?.() ?? deps.route
  const systemSeq = enumerateSurfaceNodes(input.session).find(node => node.role === 'system')?.seq
  const draft = await callHistorian(
    {
      policy,
      llm: deps.llm,
      logger: deps.logger,
      ...deps.journal === undefined ? {} : { journal: deps.journal },
      ...deps.now === undefined ? {} : { now: deps.now },
      ...deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs },
      ...generationRoute === undefined ? {} : { route: generationRoute },
    },
    {
      sessionId,
      session: input.session,
      nodes: input.nodes,
      trigger: 'manual',
      ...generationRoute === undefined ? {} : { route: generationRoute },
      ...input.signal === undefined ? {} : { signal: input.signal },
      ...systemSeq === undefined ? {} : { systemSeq },
    },
  )
  const compactionId = `mc-${randomUUID()}`
  const summary: ContentBlock[] = [{
    type: 'text',
    text: `${compactedPlaceholder(0).replace('§C0§', '§checkpoint§')}\n${digestText(draft)}`,
  }]
  const shadowedSeqs = input.nodes.map(node => node.seq)
  const first = input.nodes[0] as SurfaceNode
  const last = input.nodes[input.nodes.length - 1] as SurfaceNode
  const shadowedTokenCount = input.nodes.reduce((total, node) => total + estimateTokens(node.text), 0)
  // `Session.append` accepts an options argument only for *surface* event
  // types; `compaction/*` are not among them, so these appends take two.
  const startEvent = input.session.append('compaction/start', {
    compactionId,
    ...input.sourceCommandId === undefined ? {} : { sourceCommandId: input.sourceCommandId },
    turn: null,
  } as never)
  const summaryEvent = input.session.append('compaction/summary', {
    compactionId,
    ...input.sourceCommandId === undefined ? {} : { sourceCommandId: input.sourceCommandId },
    summary,
    shadowedRange: { start: first.seq, end: last.seq },
    shadowedSeqs,
    shadowedTokenCount,
    provider: generationRoute?.provider ?? 'unknown',
    model: generationRoute?.model ?? 'unknown',
    maxTokens: policy.historianMaxTokens,
    rawOutput: summary,
    llmStreamCall: true,
  } as never)
  replaceSurfaceRange(
    input.session,
    first.seq,
    last.seq,
    summary,
    shadowedSeqs,
    syntheticNodeId('mc-checkpoint'),
    compactCheckpointSource(compactionId, input.sourceCommandId),
  )
  const endEvent = input.session.append('compaction/end', {
    compactionId,
    ...input.sourceCommandId === undefined ? {} : { sourceCommandId: input.sourceCommandId },
    turn: null,
  } as never)
  deps.logger.info(
    `magic-context compaction: checkpoint over ${String(input.nodes.length)} nodes `
      + `(~${String(shadowedTokenCount)} tokens, importance ${String(draft.importance)})`,
  )
  deps.journal?.info('engine', `manual checkpoint over ${String(input.nodes.length)} nodes (~${String(shadowedTokenCount)} tokens)`, {
    action: 'checkpoint',
    compactionId,
    sourceCommandId: input.sourceCommandId,
    nodes: input.nodes.length,
    shadowedTokenCount,
    importance: draft.importance,
    startSeq: startEvent.seq,
    endSeq: endEvent.seq,
  }, sessionId)
  return {
    compactionId,
    ...input.sourceCommandId === undefined ? {} : { sourceCommandId: input.sourceCommandId },
    summary,
    shadowedRange: { start: first.seq, end: last.seq },
    startSeq: startEvent.seq,
    summarySeq: summaryEvent.seq,
    endSeq: endEvent.seq,
    shadowedSeqs,
    shadowedTokenCount,
    importance: draft.importance,
    nodes: input.nodes.length,
  }
}
