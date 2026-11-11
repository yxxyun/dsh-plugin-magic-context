/**
 * The compaction seam — Magic Context's answer to DSH's `ctx.compaction`.
 *
 * DSH's built-in engine summarizes a span into a checkpoint when pressure
 * rises. Magic Context's promise is the opposite: the transform never makes a
 * model call, reclaim is deterministic (drops + compartment publishing), and
 * the historian's digest is written out of band. This engine therefore
 *
 *  - `compactIfNeeded` (the pressure path): runs the adapter's management
 *    pass and returns null — no checkpoint is written, because the reclaim
 *    lanes and the historian own pressure handling;
 *  - `compactNow` / `compactRegion` (the MANUAL path, `/compact`): a user
 *    explicitly asked, so the engine writes a real checkpoint — it summarizes
 *    the span with the historian and appends the documented protocol
 *    (`compaction/start` → `compaction/summary` → the replacing
 *    `user/message` → `compaction/end`), which is the one place a summary
 *    legitimately enters the surface.
 *
 * The engine class is built from an INJECTED base class: the adapter's
 * runtime keeps zero static @deepseek-ai imports, and the in-tree glue (or a
 * dynamic import in a proper package install) supplies the seam class.
 */
import type { Context } from '@deepseek-ai/cordis'
import { estimateTokens, type CompartmentDraft } from '../core/compartments.ts'
import type { Journal } from '../core/journal.ts'
import type { PressurePolicy } from '../core/policy.ts'
import type { AdapterStores } from '../core/stores.ts'
import { errText } from '../core/types.ts'
import { callHistorian, historianInFlight, type HistorianLlm } from './historian.ts'
import {
  pickManualSpan,
  writeManualCheckpoint,
  type ManualCheckpointResult,
} from './manual-compaction.ts'
import { runManagementPass } from './management-pass.ts'
import {
  enumerateSurfaceNodes,
  type ContentBlock,
  type Session,
  type SurfaceNode,
} from './seams.ts'

export interface CompactionEngineDeps {
  /** The CompactionEngine base class (injected or dynamically imported). */
  readonly base: unknown
  readonly stores: AdapterStores
  readonly policy: PressurePolicy
  /**
   * Live policy resolver: when present, every engine method re-resolves the
   * policy at its use point, so a settings-form threshold edit reaches the
   * engine path without a remount (volatile commits never remount — the
   * "dead option" audit, 2026-10-10). Absent falls back to the snapshot
   * {@link policy}, which is what tests and stand-alone constructions pass.
   */
  readonly activePolicy?: () => PressurePolicy
  readonly logger: { info(message: string): void; warn(message: string): void }
  readonly llm?: HistorianLlm
  /**
   * Static generation route (tests / stand-alone constructions). Live
   * compositions pass {@link activeRoute} instead: the generation pin is a
   * settings-form field, and a report opened before a remount must not keep
   * the mount-time value.
   */
  readonly route?: { provider: string; model: string }
  /**
   * Live generation route: the out-of-band historian and `/compact` summaries.
   * `undefined` means "follow the session route" (the historian falls back to
   * the request's own route when no pin is set).
   */
  readonly activeRoute?: () => { provider: string; model: string } | undefined
  /** Validation-period activity journal (optional). */
  readonly journal?: Journal
  /**
   * True once the composition that created this engine has been disposed
   * (hmr reload, remount). A stale engine instance can keep receiving host
   * calls after its stores were closed — those calls must no-op, never throw:
   * an error escaping `compactIfNeeded` lands in the middle of a host step
   * and interrupts the session (measured live as `database is not open`).
   */
  readonly isDisposed?: () => boolean
}

/**
 * What {@link registerMagicCompactionEngine} hands back: the mounted fiber.
 * `dispose()` unmounts the engine from `ctx.compaction`, which is what lets
 * the composition follow a runtime `registerCompactionEngine` toggle off.
 */
export interface EngineHandle {
  readonly dispose: () => Promise<void>
}

/** A structurally complete `CompactionResult` (the seam's result shape). */
type CheckpointResult = ManualCheckpointResult

/** Map an explicit surface span (first/last node seqs, either order) to nodes. */
function regionNodes(nodes: readonly SurfaceNode[], start: number, end: number): SurfaceNode[] {
  const first = nodes.findIndex(node => node.seq === start)
  const last = nodes.findIndex(node => node.seq === end)
  if (first === -1 || last === -1) return []
  const [from, to] = first <= last ? [first, last] : [last, first]
  return nodes.slice(from, to + 1)
}

/**
 * Create and mount the adapter's CompactionEngine. Awaiting the returned
 * promise settles once the service is provided (or rejects when another
 * engine already owns `ctx.compaction`). The returned handle's `dispose()`
 * unmounts the engine, so the caller can follow a runtime toggle off.
 */
export async function registerMagicCompactionEngine(
  ctx: Context,
  deps: CompactionEngineDeps,
): Promise<EngineHandle> {
  const base = deps.base as new (ctx: unknown, config?: unknown) => {
    compactIfNeeded(agent: unknown, trigger: unknown, signal: AbortSignal): Promise<CheckpointResult | null>
    compactNow(agent: unknown, signal: AbortSignal, sourceCommandId?: string): Promise<CheckpointResult | null>
    compactRegion(start: number, end: number, agent: unknown, signal?: AbortSignal): Promise<CheckpointResult>
  }
  /** The live policy at the use point (snapshot fallback: see deps). */
  const policyNow = (): PressurePolicy => deps.activePolicy?.() ?? deps.policy
  /** The live generation route at the use point (snapshot fallback: see deps). */
  const routeNow = (): { provider: string; model: string } | undefined => deps.activeRoute?.() ?? deps.route

  const sessionOf = (agent: unknown): Session => {
    const session = (agent as { session?: Session }).session
    if (session === undefined) throw new Error('compaction agent carries no session')
    return session
  }

  /**
   * The manual checkpoint. The writer lives in `manual-compaction.ts` so
   * `/ctx-wrapup` can reach it without mounting this engine — and therefore
   * without taking over `ctx.compaction`.
   */
  const writeCheckpoint = async (input: {
    readonly session: Session
    readonly nodes: readonly SurfaceNode[]
    readonly sourceCommandId?: string
    readonly signal?: AbortSignal
  }): Promise<CheckpointResult> =>
    writeManualCheckpoint(
      {
        stores: deps.stores,
        policy: policyNow,
        logger: deps.logger,
        activeRoute: routeNow,
        ...deps.journal === undefined ? {} : { journal: deps.journal },
        ...deps.llm === undefined ? {} : { llm: deps.llm },
      },
      input,
    )

  const EngineClass = class MagicContextCompactionEngine extends base {
    static inject: string[] = []

    constructor(engineCtx: unknown, config?: unknown) {
      super(engineCtx, config)
    }

    /** A stale engine (remounted composition) must no-op, never touch closed stores. */
    private usable(): boolean {
      return deps.stores.closed !== true && deps.isDisposed?.() !== true
    }

    /** The pressure path: reclaim, never a checkpoint (Magic Context's promise). */
    async compactIfNeeded(agent: unknown): Promise<CheckpointResult | null> {
      if (!this.usable()) return null
      const session = sessionOf(agent)
      const sessionId = session.id
      try {
        const generationRoute = routeNow()
        runManagementPass({
          session,
          sessionId,
          ...historianInFlight(sessionId) === undefined ? {} : { historianBusy: true },
          stores: deps.stores,
          policy: policyNow(),
          logger: deps.logger,
          pass: { kind: 'execute', reason: 'execute-threshold' },
          pressure: undefined,
          ...deps.llm === undefined ? {} : {
            historian: {
              llm: deps.llm,
              ...generationRoute === undefined ? {} : { route: generationRoute },
            },
          },
        })
      } catch (error) {
        // A failing pass must never escape into the host's step: warn, record,
        // and let the session continue (the next threshold still retries).
        const detail = errText(error)
        deps.logger.warn(`magic-context compaction: management pass failed (${detail}); session continues`)
        deps.journal?.warn('engine', `management pass failed: ${detail}`, {
          action: 'pass-failed',
          sessionId,
        }, sessionId)
      }
      return null
    }

    /** `/compact`: the user asked, so a real checkpoint is written. */
    async compactNow(agent: unknown, signal: AbortSignal, sourceCommandId?: string): Promise<CheckpointResult | null> {
      if (!this.usable()) return null
      const session = sessionOf(agent)
      const nodes = enumerateSurfaceNodes(session)
      const range = selectManualRange(nodes, deps.stores, session.id, policyNow())
      if (range.length === 0) return null
      return writeCheckpoint({
        session,
        nodes: range,
        ...sourceCommandId === undefined ? {} : { sourceCommandId },
        signal,
      })
    }

    async compactRegion(start: number, end: number, agent: unknown, signal?: AbortSignal): Promise<CheckpointResult> {
      if (!this.usable()) throw new Error('compaction engine is shutting down')
      const session = sessionOf(agent)
      const nodes = regionNodes(enumerateSurfaceNodes(session), start, end)
      if (nodes.length === 0) throw new Error('compaction region contains no current surface nodes')
      return writeCheckpoint({
        session,
        nodes,
        ...signal === undefined ? {} : { signal },
      })
    }
  }

  return await ctx.plugin(EngineClass, {})
}

/**
 * The manual range: the same eligibility rules, without the token gate.
 * Delegates to the shared picker so `/compact` and `/ctx-wrapup` can never
 * disagree about what is eligible.
 */
function selectManualRange(
  nodes: readonly SurfaceNode[],
  stores: AdapterStores,
  sessionId: string,
  policy: PressurePolicy,
): SurfaceNode[] {
  return pickManualSpan(nodes, stores, sessionId, policy)
}
