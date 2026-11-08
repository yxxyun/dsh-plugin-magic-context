/**
 * `/ctx-wrapup [messages_to_keep]` — collapse the working history into a
 * checkpoint before moving on, on the user's terms.
 *
 * Why it exists (upstream `ctx-wrapup`): every other path into a summary in
 * this adapter is *reactive* — the historian fires when the window crosses 65%,
 * the emergency reclaim fires when the provider rejects the request. A user who
 * knows a task is finished ("we shipped it, now let's start the next thing")
 * had no way to say so, and the host's own `/compact` was the only manual
 * entry point — reachable only by mounting this adapter as the compaction
 * engine, which is a much bigger commitment than asking for one summary.
 *
 * So this command is deliberately independent of `registerCompactionEngine`:
 * it needs the historian's LLM seam and the store, nothing else. The span
 * picker is the same one `/compact` uses (`pickManualSpan`), so the two can
 * never disagree about what counts as eligible.
 *
 * Difference from upstream worth stating: upstream's wrapup also rewrites the
 * primer and refreshes `m[0]`. Here the checkpoint alone is enough — the next
 * pre-step pass notices the changed render and refreshes the baseline the way
 * it does for any other digest change.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Journal } from '../core/journal.ts'
import type { PressurePolicy } from '../core/policy.ts'
import type { AdapterStores } from '../core/stores.ts'
import type { HistorianLlm } from './historian.ts'
import { pickManualSpan, writeManualCheckpoint } from './manual-compaction.ts'
import { enumerateSurfaceNodes, type Session, type SurfaceNode } from './seams.ts'

export const WRAPUP_USAGE = 'Usage: /ctx-wrapup [messages_to_keep]'

/**
 * Parse the optional argument: a non-negative integer of recent surface nodes
 * to leave untouched. Absent means "use the policy's protected window".
 * @param raw - the invocation's raw input.
 * @returns the keep count (`undefined` = use the policy default), or the usage
 * line when the input is not understood.
 */
export function parseWrapupKeep(raw: string | undefined): number | undefined | string {
  const text = (raw ?? '').trim()
  if (text.length === 0) return undefined
  if (!/^\d+$/.test(text)) return WRAPUP_USAGE
  const keep = Number(text)
  return Number.isSafeInteger(keep) ? keep : WRAPUP_USAGE
}

export interface WrapupDeps {
  readonly stores: AdapterStores
  /** The pressure policy — a snapshot, or a LIVE resolver (the composition passes one). */
  readonly policy: PressurePolicy | (() => PressurePolicy)
  readonly logger: { info(message: string): void; warn(message: string): void }
  readonly journal?: Journal
  readonly llm?: HistorianLlm
  readonly route?: { provider: string; model: string }
  readonly activeRoute?: () => { provider: string; model: string } | undefined
  readonly timeoutMs?: number
  readonly now?: () => number
  /**
   * False when the historian is switched off. May be a LIVE resolver so the
   * gate follows the same volatile `historianEnabled` the pre-step band reads
   * (a mount-time boolean disagreed with the live gate after a settings
   * toggle — the same defect `/ctx-recomp` had).
   */
  readonly enabled?: boolean | (() => boolean)
}

/** Narrowed registration surface (keeps the package typecheck standalone). */
type CommandRegistrar = {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    handler: (invocation: {
      readonly agent: {
        readonly session: {
          readonly id: string
          snapshotEvents(): unknown[]
          surface: { nodes: readonly number[] }
        }
      }
      readonly rawInput?: string
      readonly signal?: AbortSignal
    }) => Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }>
  }): unknown
}

/**
 * Register `/ctx-wrapup` beside `/ctx-status`.
 * @param ctx - the adapter's context, carrying the `commands` service.
 * @param deps - stores, policy, logger and the historian's seams.
 */
export function registerCtxWrapupCommand(ctx: Context, deps: WrapupDeps): void {
  const commands = (ctx as unknown as { get(name: string): unknown }).get('commands') as
    | CommandRegistrar
    | undefined
  if (commands === undefined) {
    ctx.logger.warn('magic-context dsh adapter: commands service not mounted; /ctx-wrapup unavailable')
    return
  }
  const policyOf = (): PressurePolicy => typeof deps.policy === 'function' ? deps.policy() : deps.policy
  commands.register({
    name: 'ctx-wrapup',
    description: 'Magic Context: collapse the working history into a checkpoint before moving on.',
    input: { hint: '[messages_to_keep]' },
    handler: async (invocation) => {
      const enabled = typeof deps.enabled === 'function' ? deps.enabled() : deps.enabled
      if (deps.llm === undefined || enabled === false) {
        return {
          kind: 'error',
          text: 'Magic Context: the historian is not available for this adapter, so there is nothing to wrap up.',
        }
      }
      const parsed = parseWrapupKeep(invocation.rawInput)
      if (typeof parsed === 'string') return { kind: 'error', text: parsed }
      const session = invocation.agent.session as unknown as Session
      const policy = policyOf()
      const nodes: SurfaceNode[] = enumerateSurfaceNodes(session)
      const keep = parsed
      const span = pickManualSpan(nodes, deps.stores, invocation.agent.session.id, policy, keep)
      if (span.length === 0) {
        // Two different refusals deserve two different messages: "nothing is
        // eligible" (already compacted / only the baseline is left) must not
        // read like "your keep count ate the whole span".
        const floor = Math.max(2, policy.historianMinNodes)
        return {
          kind: 'success',
          text: keep === undefined
            ? `Magic Context: nothing to wrap up — no eligible span of at least ${String(floor)} node(s) is left.`
            : `Magic Context: nothing to wrap up — keeping the newest ${String(keep)} message(s) leaves no eligible span of at least ${String(floor)} node(s).`,
        }
      }
      try {
        const result = await writeManualCheckpoint(
          {
            stores: deps.stores,
            policy,
            logger: deps.logger,
            activeRoute: deps.activeRoute,
            ...deps.journal === undefined ? {} : { journal: deps.journal },
            ...deps.llm === undefined ? {} : { llm: deps.llm },
            ...deps.route === undefined ? {} : { route: deps.route },
            ...deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs },
            ...deps.now === undefined ? {} : { now: deps.now },
          },
          {
            session,
            nodes: span,
            sourceCommandId: 'ctx-wrapup',
            ...invocation.signal === undefined ? {} : { signal: invocation.signal },
          },
        )
        return {
          kind: 'success',
          text: [
            `Magic Context: wrapped up ${String(result.nodes)} message(s) (~${String(result.shadowedTokenCount)} tokens) `
              + `into §checkpoint§ ${result.compactionId}.`,
            `- covered seq ${String(result.shadowedSeqs[0])}–${String(result.shadowedSeqs[result.shadowedSeqs.length - 1])}, importance ${String(result.importance)}`,
            `- the digest is on the surface now; the originals stay in the log, so ctx_expand can still pull them back`,
            'The next pre-step pass re-renders the baseline from the new digest.',
          ].join('\n'),
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        deps.journal?.error('engine', `wrapup failed: ${reason}`, { action: 'wrapup-failed', reason }, invocation.agent.session.id)
        return { kind: 'error', text: `Magic Context: wrapup failed — ${reason}` }
      }
    },
  })
}
