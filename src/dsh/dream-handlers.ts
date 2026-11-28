/**
 * Handlers for the background tasks this build can actually finish.
 *
 * Two shapes live here, and the difference is what a host without a tool loop
 * can and cannot do:
 *
 * - `promote-primers` — pure database work. No model, no budget, no prompt.
 * - `classify-memories` — one no-tool completion plus host-side apply. The host
 *   reads the rows and writes the scores; the model only judges.
 *
 * Phases 3..5 add their handlers here. The runner never learns what a task does:
 * it hands over a project, a clock and a token ceiling, and reads back a verdict.
 */

import type { DreamTaskHandler, DreamTaskResult } from '../core/dream-runner.ts'

/**
 * An environmental skip (no LLM route yet, project root not registered yet)
 * retries on this cadence instead of waiting out the task's whole cron period.
 * Both conditions are resolved by the next conversation step, so a five-minute
 * retry is the difference between "ran an hour late" and "lost a day" —
 * measured 2026-11-17: a remount left verify and index-commits skipped, and each
 * skip pushed them to the next day.
 */
const PRECONDITION_RETRY_MS = 5 * 60_000
import { runClassifyTick, type ClassifyLlm } from '../core/classify-memories.ts'
import { runVerifyTick, type VerifyLlm } from '../core/verify-memories.ts'
import { runCurateTick, type CurateLlm } from '../core/curate-memories.ts'
import { archiveExpiredMemories } from '../core/expire-memories.ts'
import { runSmartNoteTick } from './smart-notes.ts'
import type { ProfileWriter } from '../core/profile-write.ts'
import { PROFILE_REVIEW_META_KEY, runProfileReview, type ProfileReviewLlm } from '../core/profile-review.ts'
import { autoStageGlobalCandidates, type AutoStageLlm } from '../core/global-autostage.ts'
import type { VectorBackfillOutcome } from '../core/vector-backfill.ts'
import { memorySample } from '../core/maintenance.ts'
import { runRetrospectiveTick, type RetrospectiveLlm } from '../core/retrospective.ts'
import type { AdapterStores } from '../core/stores.ts'
import { DEFAULT_DREAM_CONFIG, type DreamRuntimeConfig } from './dream-config.ts'
import type { Journal } from '../core/journal.ts'
import type { MemoryWriter } from '../core/memory-write.ts'

/**
 * The primer promotion entry point, as the memory lane already exposes it.
 *
 * Typed structurally rather than by importing the lane, so this module stays
 * testable without a database: a test passes a fake that records its calls.
 * `undefined` return means the memory store could not be opened, which is a
 * skip — not a failure — because the next tick retries.
 */
export type PromotePrimers = (input: {
  readonly projectPath: string
}) => { readonly created: readonly number[]; readonly refreshed: readonly number[] } | undefined

/** Everything `classify-memories` needs, all of it optional so a host without a
 *  model route simply skips the task instead of failing it. */
export interface ClassifyHandlerDeps {
  readonly writer?: MemoryWriter
  readonly llm?: ClassifyLlm
  /**
   * The route to use, resolved PER RUN rather than captured at mount.
   *
   * The background lane follows the main conversation's latest route, and that
   * changes during the process's life (model switch, provider failover). A
   * captured route would pin the task to whatever was configured at boot — which
   * is how a "nightly" task silently stops working after a model change.
   */
  readonly route?: () => { readonly provider: string; readonly model: string } | undefined
  readonly journal?: Journal
  /** Stamped on the LLM request; there is no live session behind a dream run. */
  readonly sessionId?: string
  /** A score older than this is re-ranked. */
  readonly staleAfterMs?: number
  readonly batchSize?: number
  /**
   * Live tunables, resolved PER RUN.
   *
   * Preferred over the fixed fields above, which exist for tests. A settings
   * commit mutates the volatile reference without remounting the fiber, so a
   * value read at mount would ignore the edit until the next restart.
   */
  readonly config?: () => DreamRuntimeConfig
}

export interface VerifyHandlerDeps {
  readonly writer?: MemoryWriter
  readonly llm?: VerifyLlm
  readonly route?: () => { readonly provider: string; readonly model: string } | undefined
  readonly journal?: Journal
  readonly sessionId?: string
  /**
   * The project's directory on disk, for the file-evidence index.
   *
   * Resolved per run from the identity, because the identity is a hash: a task
   * that reads files must be handed the path that produced it, and only the
   * pre-step ever holds both. Undefined means "this identity was registered
   * without a root", which is a skip — the task cannot read anything.
   */
  readonly projectRootOf?: (identity: string) => string | undefined
  readonly batchSize?: number
  /** Additional trees to search for cited files (see `config.dream.verifyExtraRoots`). */
  readonly extraRoots?: readonly string[]
  /** Live tunables, resolved per run — see `ClassifyHandlerDeps.config`. */
  readonly config?: () => DreamRuntimeConfig
}

export interface CurateHandlerDeps {
  readonly writer?: MemoryWriter
  readonly llm?: CurateLlm
  readonly route?: () => { readonly provider: string; readonly model: string } | undefined
  readonly journal?: Journal
  readonly sessionId?: string
  /**
   * The embedding space to compare in, resolved PER RUN.
   *
   * The dominant space changes when the corpus is re-embedded (a backfill under
   * a new model), and a captured id would silently compare nothing afterwards —
   * `listVectors` returns rows for the id it is given, so a stale id reads as an
   * empty pool rather than as an error.
   */
  readonly embeddingSpace?: () => string | undefined
  /** Default true. Only an explicit false lets the task write. */
  readonly dryRun?: boolean
  readonly similarityFloor?: number
  readonly maxPairs?: number
  /** Live tunables, resolved per run — see `ClassifyHandlerDeps.config`. */
  readonly config?: () => DreamRuntimeConfig
}

export interface RetrospectiveHandlerDeps {
  readonly stores?: AdapterStores
  readonly llm?: RetrospectiveLlm
  readonly route?: () => { readonly provider: string; readonly model: string } | undefined
  readonly journal?: Journal
  readonly sessionId?: string
  readonly windowMs?: number
  /** Default true. False reports the summary without persisting a note. */
  readonly writeNote?: boolean
  /** Live tunables, resolved per run — see `ClassifyHandlerDeps.config`. */
  readonly config?: () => DreamRuntimeConfig
}

export interface DreamHandlerDeps {
  readonly promotePrimers?: PromotePrimers
  readonly classify?: ClassifyHandlerDeps
  readonly verify?: VerifyHandlerDeps
  readonly curate?: CurateHandlerDeps
  readonly retrospective?: RetrospectiveHandlerDeps
  /** Smart-note evaluation (host-only: a note carries a declarative condition). */
  readonly smartNotes?: SmartNotesHandlerDeps
  /** User-memory promotion review (upstream's `review-user-memories`). */
  readonly reviewUserMemories?: ReviewUserMemoriesHandlerDeps
  /**
   * The three lanes with no upstream task equivalent, moved off the fixed-interval
   * sweep: machine-domain auto-staging, vector backfill, and the commit index.
   *
   * Upstream runs the last two from session hooks (auto-embed) and has no
   * auto-staging at all; this adapter has no equivalent hook points, so they
   * become tasks rather than a second scheduler.
   */
  readonly housekeeping?: HousekeepingHandlerDeps
}

export interface HousekeepingHandlerDeps {
  readonly stores: AdapterStores
  readonly journal?: Journal
  readonly writer?: { readonly dbPath: string }
  readonly llm?: { readonly stream: unknown }
  readonly route?: () => { readonly provider: string; readonly model: string } | undefined
  readonly autoStageEnabled?: () => boolean
  readonly vectorBackfill?: (limit: number, journal: Journal) => Promise<VectorBackfillOutcome | undefined>
  readonly vectorBackfillEnabled?: () => boolean
  readonly vectorBackfillLimit?: () => number
  readonly indexCommits?: (input: {
    readonly projectPath: string
    readonly readLimit: number
    readonly embedLimit: number
  }) => Promise<{ read: number; inserted: number; updated: number; embedded: number; failure?: string } | undefined>
  readonly indexCommitsEnabled?: () => boolean
  /** Wall-clock budget for one `git log` read (default 20s); injectable for tests. */
  readonly indexCommitsTimeoutMs?: number
  readonly projectRootOf?: (identity: string) => string | undefined
  /**
   * `auto-stage-global`: where a gated candidate is published.
   *
   * Present → staging publishes immediately (upstream's shape: no approval
   * card). Absent → candidates stay pending, the old behaviour.
   */
  readonly domainWriter?: {
    publishDomainMemory(input: {
      readonly identity: string
      readonly category: string
      readonly content: string
      readonly importance?: number
    }): { readonly ok: true; readonly id: number; readonly created: boolean; readonly revived?: boolean }
      | { readonly ok: false; readonly detail: string }
    countDomainMemories(identity: string): number
  }
  /** `prune-journal`: the store call that does the DELETE. */
  readonly pruneJournal?: (cutoff: number) => number
  /** `prune-journal`: retention window in days, live-read from config. */
  readonly journalRetentionDays?: () => number
}

export interface ReviewUserMemoriesHandlerDeps {
  readonly profileWriter?: ProfileWriter
  readonly stores: AdapterStores
  readonly journal?: Journal
  readonly llm?: ProfileReviewLlm
  readonly route?: () => { readonly provider: string; readonly model: string } | undefined
  /** Candidates per call; see `PROFILE_REVIEW_BATCH` for why the default is small. */
  readonly config?: () => DreamRuntimeConfig
}

export interface SmartNotesHandlerDeps {
  readonly stores: Parameters<typeof runSmartNoteTick>[0]['stores']
  /** A build without a journal still evaluates notes; it just cannot report. */
  readonly journal?: Journal
}

/** Two weeks: long enough that a normal project's ranking stays stable, short
 *  enough that a pool which doubled gets re-ranked within a month. */
export const DEFAULT_CLASSIFY_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000

/**
 * `promote-primers`: cluster recurring questions into primers.
 *
 * The work is idempotent — running it twice on the same data refreshes the same
 * primers rather than creating duplicates — which is exactly why it is the task
 * that runs on a default schedule while the others ship disabled.
 */
export function buildPromotePrimersHandler(deps: DreamHandlerDeps): DreamTaskHandler {
  return async (context): Promise<DreamTaskResult> => {
    const promote = deps.promotePrimers
    if (promote === undefined) {
      return {
        status: 'skipped',
        summary: 'the memory store is not available in this build',
      }
    }
    const outcome = promote({ projectPath: context.projectPath })
    if (outcome === undefined) {
      return {
        status: 'skipped',
        summary: 'the memory store could not be opened; retrying on the next tick',
      }
    }
    const changed = outcome.created.length + outcome.refreshed.length
    // `itemsProcessed` counts TARGETS (primers touched), `itemsChanged` counts
    // the subset that mutated state. They differ when a cluster was already
    // eligible and only its support moved — worth seeing separately in a
    // dashboard, and the distinction is free here.
    return {
      status: 'ok',
      itemsProcessed: changed,
      itemsChanged: outcome.created.length,
      tokensUsed: 0,
      summary: outcome.created.length === 0 && outcome.refreshed.length === 0
        ? 'no question recurred often enough to become a primer'
        : `created ${String(outcome.created.length)}, refreshed ${String(outcome.refreshed.length)}`,
    }
  }
}

/**
 * `classify-memories`: re-rank the importance of memories whose score went stale.
 *
 * The task reports `skipped` — never `failed` — when a precondition is missing
 * (no route, no writer, read-only corpus). Those are this host's configuration,
 * not a bug in the run, and marking them failed would drive the failure backoff
 * for a condition that cannot improve by retrying sooner.
 */
export function buildClassifyHandler(deps: DreamHandlerDeps): DreamTaskHandler {
  return async (context): Promise<DreamTaskResult> => {
    // Every early return states its zero cost explicitly rather than omitting
    // the fields. The runner treats a 0 budget as a real ceiling (any reported
    // token fails the run), so "spent nothing" must be a declaration, not an
    // absence the runner has to infer.
    const skip = (summary: string, retryInMs?: number): DreamTaskResult => ({
      status: 'skipped',
      itemsProcessed: 0,
      itemsChanged: 0,
      tokensUsed: 0,
      summary,
      ...retryInMs === undefined ? {} : { retryInMs },
    })
    const classify = deps.classify
    if (classify === undefined || classify.writer === undefined || classify.llm === undefined) {
      return skip('the memory writer or llm seam is unavailable in this build')
    }
    if (classify.journal === undefined) {
      return skip('no journal to report a classify run through')
    }
    const route = classify.route?.()
    if (route === undefined) {
      // No route means no model to ask, and no session to inherit one from.
      return skip('no llm route is known yet (no conversation has run in this process)', PRECONDITION_RETRY_MS)
    }
    const cfg = classify.config?.()
    const outcome = await runClassifyTick({
      writer: classify.writer,
      identity: context.projectPath,
      llm: classify.llm,
      route,
      sessionId: classify.sessionId ?? 'mc-dreamer',
      journal: classify.journal,
      now: () => context.now,
      staleAfterMs: cfg?.classifyStaleAfterMs ?? classify.staleAfterMs ?? DEFAULT_CLASSIFY_STALE_AFTER_MS,
      ...(cfg?.classifyBatchSize ?? classify.batchSize) === undefined
        ? {}
        : { batchSize: (cfg?.classifyBatchSize ?? classify.batchSize) as number },
    })
    const summary = outcome.reason === undefined
      ? `scored ${String(outcome.scored)} of ${String(outcome.scanned)} (${String(outcome.stale)} stale)`
      : `no scores banked: ${outcome.reason}`
    return {
      status: outcome.reason === 'llm-failed' || outcome.reason === 'parse-failed' ? 'failed' : 'ok',
      itemsProcessed: outcome.scanned,
      itemsChanged: outcome.scored,
      tokensUsed: outcome.tokensUsed,
      summary,
      ...outcome.reason === 'llm-failed' || outcome.reason === 'parse-failed'
        ? { error: outcome.reason }
        : {},
    }
  }
}

/**
 * `verify`: check memories against the files they cite.
 *
 * Distinct from the maintenance sweep's verify, which judges from text alone:
 * this one reads the files first and reports `skipped` — not `failed` — when it
 * cannot (no route, no project root). A missing root is a registration gap, and
 * retrying it sooner does not close it.
 */
export function buildVerifyHandler(deps: DreamHandlerDeps): DreamTaskHandler {
  return async (context): Promise<DreamTaskResult> => {
    const skip = (summary: string, retryInMs?: number): DreamTaskResult => ({
      status: 'skipped',
      itemsProcessed: 0,
      itemsChanged: 0,
      tokensUsed: 0,
      summary,
      ...retryInMs === undefined ? {} : { retryInMs },
    })
    const verify = deps.verify
    if (verify === undefined || verify.writer === undefined || verify.llm === undefined) {
      return skip('the memory writer or llm seam is unavailable in this build')
    }
    if (verify.journal === undefined) return skip('no journal to report a verify run through')
    const route = verify.route?.()
    if (route === undefined) return skip('no llm route is known yet (no conversation has run in this process)', PRECONDITION_RETRY_MS)
    const projectRoot = verify.projectRootOf?.(context.projectPath)
    if (projectRoot === undefined) {
      // Without a directory there is no index, and without an index every
      // reference would read as missing — a verdict assembled from a missing
      // measurement is worse than no verdict.
      return skip('no directory is registered for this project, so files cannot be read', PRECONDITION_RETRY_MS)
    }
    const cfg = verify.config?.()
    const verifyBatch = cfg?.verifyBatchSize ?? verify.batchSize
    // Live roots win: the whole point of the getter is that a settings edit
    // applies to the NEXT run. An explicitly empty live list means "search only
    // the project root", so it must not fall back to the fixed field.
    const verifyRoots = cfg === undefined ? verify.extraRoots : cfg.verifyExtraRoots
    const outcome = await runVerifyTick({
      writer: verify.writer,
      identity: context.projectPath,
      projectRoot,
      llm: verify.llm,
      route,
      sessionId: verify.sessionId ?? 'mc-dreamer',
      journal: verify.journal,
      now: () => context.now,
      ...(verifyBatch ?? 0) === 0 ? {} : { batchSize: verifyBatch as number },
      ...(verifyRoots === undefined || verifyRoots.length === 0 ? {} : { extraRoots: verifyRoots }),
    })
    const failed = outcome.reason === 'llm-failed' || outcome.reason === 'parse-failed'
    const changed = outcome.verified + outcome.updated + outcome.archived + outcome.skipped
    return {
      status: failed ? 'failed' : 'ok',
      itemsProcessed: outcome.scanned,
      itemsChanged: changed,
      tokensUsed: outcome.tokensUsed,
      summary: outcome.reason === undefined
        ? `${String(outcome.verified)} verified, ${String(outcome.updated)} rewritten, `
          + `${String(outcome.archived)} archived, ${String(outcome.skipped)} skipped `
          + `(${String(outcome.referencesFound)} refs found, ${String(outcome.referencesMissing)} missing, `
          + `${String(outcome.referencesUnreadable)} cited lines gone)`
        : `nothing applied: ${outcome.reason}`,
      ...failed ? { error: outcome.reason } : {},
    }
  }
}

/**
 * `curate`: consolidate memories that say the same thing.
 *
 * Dry run unless the config explicitly says otherwise. The task is `skipped`
 * when it cannot start (no space, no route), `failed` only when a call it made
 * came back broken — the same split as the other model-backed tasks.
 */
export function buildCurateHandler(deps: DreamHandlerDeps): DreamTaskHandler {
  return async (context): Promise<DreamTaskResult> => {
    const skip = (summary: string, retryInMs?: number): DreamTaskResult => ({
      status: 'skipped',
      itemsProcessed: 0,
      itemsChanged: 0,
      tokensUsed: 0,
      summary,
      ...retryInMs === undefined ? {} : { retryInMs },
    })
    const curate = deps.curate
    if (curate === undefined || curate.writer === undefined) {
      return skip('the memory writer is unavailable in this build')
    }
    // TTL expiry runs FIRST, inside this task and its lease, exactly where
    // upstream puts it ("Curate owns the TTL lifecycle transition"). An expired
    // row and a merged-away row are the same write — archive through the contract
    // action with a reason — so they belong to one lane holding one lease rather
    // than to a fixed-interval tick racing this one.
    //
    // It runs BEFORE the model checks on purpose: expiry needs no route, no
    // prompt and no tokens. Gating it behind `llm` meant a profile with no route
    // never expired anything, which is how rows outlive their TTL forever.
    const expiry = archiveExpiredMemories(curate.writer, context.projectPath, context.now)
    if (expiry.archived > 0) {
      curate.journal?.info('dream-curate', `curate: archived ${String(expiry.archived)} expired memories (ttl)`, {
        candidates: expiry.candidates,
        archived: expiry.archived,
      })
    }
    if (curate.llm === undefined || curate.journal === undefined) {
      // Consolidation needs the model; expiry already happened. Reporting the
      // work that DID run is more honest than a bare skip.
      return {
        status: 'ok',
        itemsProcessed: expiry.candidates,
        itemsChanged: expiry.archived,
        tokensUsed: 0,
        summary: expiry.archived === 0
          ? 'consolidation unavailable (no llm seam); nothing had expired'
          : `consolidation unavailable (no llm seam); ${String(expiry.archived)} expired by TTL`,
      }
    }
    const route = curate.route?.()
    if (route === undefined) return skip('no llm route is known yet (no conversation has run in this process)', PRECONDITION_RETRY_MS)
    const modelId = curate.embeddingSpace?.()
    if (modelId === undefined) {
      // No shared embedding space means no pair can be scored; falling back to
      // text matching would find nothing (dedup already refused exact matches).
      return skip('no embedding space is available, so no pair can be compared')
    }
    const cfg = curate.config?.()
    // `dryRun` stays true unless something explicitly said otherwise, and the
    // live value is consulted first: a settings edit that turns writing ON must
    // take effect on the next run, and one that turns it OFF must take effect
    // immediately — the reverse (a stale snapshot keeping writes enabled) is the
    // failure that matters.
    const dryRun = cfg === undefined ? curate.dryRun !== false : cfg.curateDryRun
    const outcome = await runCurateTick({
      writer: curate.writer,
      identity: context.projectPath,
      llm: curate.llm,
      route,
      modelId,
      sessionId: curate.sessionId ?? 'mc-dreamer',
      journal: curate.journal,
      now: () => context.now,
      dryRun,
      ...(cfg?.curateSimilarityFloor ?? curate.similarityFloor) === undefined
        ? {}
        : { similarityFloor: (cfg?.curateSimilarityFloor ?? curate.similarityFloor) as number },
      ...(cfg?.curateMaxPairs ?? curate.maxPairs) === undefined
        ? {}
        : { maxPairs: (cfg?.curateMaxPairs ?? curate.maxPairs) as number },
    })
    const failed = outcome.reason === 'llm-failed' || outcome.reason === 'parse-failed'
    // Expiry is not a dry run: a lapsed TTL is not a judgement call, and upstream
    // archives it regardless of what the merge pass decides. Counted separately
    // so the dashboard does not attribute it to consolidation.
    const changed = outcome.merged + outcome.archived + expiry.archived
    const mode = outcome.dryRun ? 'dry run' : 'applied'
    return {
      status: failed ? 'failed' : 'ok',
      itemsProcessed: outcome.asked,
      // In a dry run nothing was written, so `itemsChanged` reports 0 while the
      // summary still names what WOULD change: a dashboard reading only the
      // counter must not show writes that never happened.
      itemsChanged: outcome.dryRun ? 0 : changed,
      tokensUsed: outcome.tokensUsed,
      summary: outcome.reason === undefined
        ? `${mode}: ${String(outcome.merged)} merge, ${String(outcome.archived)} archive, `
          + `${String(outcome.kept)} keep, ${String(outcome.skipped)} skip, ${String(outcome.refused)} refused `
          + `(${String(outcome.candidates)} candidate pairs)`
          + (expiry.archived === 0 ? '' : `; ${String(expiry.archived)} expired by TTL`)
        : `nothing decided: ${outcome.reason}`,
      ...failed ? { error: outcome.reason } : {},
    }
  }
}

/**
 * `retrospective`: explain the week's friction and leave a note.
 *
 * Never `failed` for missing preconditions (no route, no stores): those are this
 * host's configuration. A quiet window is `ok` with zero changes — that IS the
 * finding, and paying a model to say so would be the task inventing work.
 */
export function buildRetrospectiveHandler(deps: DreamHandlerDeps): DreamTaskHandler {
  return async (context): Promise<DreamTaskResult> => {
    const skip = (summary: string, retryInMs?: number): DreamTaskResult => ({
      status: 'skipped',
      itemsProcessed: 0,
      itemsChanged: 0,
      tokensUsed: 0,
      summary,
      ...retryInMs === undefined ? {} : { retryInMs },
    })
    const retro = deps.retrospective
    if (retro === undefined || retro.stores === undefined || retro.llm === undefined) {
      return skip('the adapter store or llm seam is unavailable in this build')
    }
    if (retro.journal === undefined) return skip('no journal to report a retrospective through')
    const route = retro.route?.()
    if (route === undefined) return skip('no llm route is known yet (no conversation has run in this process)', PRECONDITION_RETRY_MS)
    const cfg = retro.config?.()
    const outcome = await runRetrospectiveTick({
      stores: retro.stores,
      identity: context.projectPath,
      llm: retro.llm,
      route,
      sessionId: retro.sessionId ?? 'mc-dreamer',
      journal: retro.journal,
      now: () => context.now,
      ...(cfg?.retrospectiveWindowMs ?? retro.windowMs) === undefined
        ? {}
        : { windowMs: (cfg?.retrospectiveWindowMs ?? retro.windowMs) as number },
      ...retro.writeNote === undefined ? {} : { writeNote: retro.writeNote },
    })
    const failed = outcome.reason === 'llm-failed'
    return {
      status: failed ? 'failed' : 'ok',
      itemsProcessed: outcome.signals,
      itemsChanged: outcome.noteId === undefined ? 0 : 1,
      tokensUsed: outcome.tokensUsed,
      summary: outcome.reason === undefined
        ? `${String(outcome.signals)} friction signals over ${String(outcome.rows)} journal rows; `
          + (outcome.noteId === undefined ? 'no note written' : `note #${String(outcome.noteId)}`)
        : outcome.reason === 'no-friction'
          ? `nothing went wrong in ${String(outcome.rows)} journal rows`
          : `no retrospective: ${outcome.reason}`,
      ...failed ? { error: outcome.reason } : {},
    }
  }
}

/** Every handler this build provides, keyed by registry task name. */
/**
 * `evaluate-smart-notes`: wake the notes whose declarative condition now holds.
 *
 * Host-only and cheap: the condition is a stored predicate (file-exists,
 * git-head, http-status, …), so evaluation is filesystem/git/http work in this
 * process with no prompt and no tokens. Upstream runs this as its own scheduled
 * task; here it used to be the last step of the maintenance sweep, which tied a
 * note's wake-up to a cadence it has no relationship with.
 *
 * A note that cannot be evaluated is counted as failed inside the tick and left
 * for the next run — the tick never throws.
 */
export function buildEvaluateSmartNotesHandler(deps: DreamHandlerDeps): DreamTaskHandler {
  return async (context): Promise<DreamTaskResult> => {
    const seam = deps.smartNotes
    if (seam === undefined) {
      return { status: 'skipped', summary: 'smart-note evaluation is not wired in this build' }
    }
    const outcome = await runSmartNoteTick({
      stores: seam.stores,
      journal: seam.journal,
      now: () => context.now,
      limit: 5,
    })
    return {
      status: 'ok',
      itemsProcessed: outcome.checked,
      itemsChanged: outcome.woken.length,
      tokensUsed: 0,
      summary: outcome.checked === 0
        ? 'no smart note was due'
        : `checked ${String(outcome.checked)}, woke ${String(outcome.woken.length)}`
          + (outcome.failed.length === 0 ? '' : `, failed ${String(outcome.failed.length)}`),
    }
  }
}

/**
 * `review-user-memories`: promote parked user-memory candidates.
 *
 * Upstream runs this as its own task, and the ordering inside matters: candidate
 * TTL expiry happens FIRST and unconditionally, so the pool stays bounded even
 * when there is no route, no model, or the call fails. Turning the task off does
 * not leak candidates — it just stops promoting them.
 *
 * Every model failure is `skipped`, not `failed`: a missing route is this host's
 * configuration, and driving the failure backoff would not fix it.
 */
export function buildReviewUserMemoriesHandler(deps: DreamHandlerDeps): DreamTaskHandler {
  return async (context): Promise<DreamTaskResult> => {
    const seam = deps.reviewUserMemories
    if (seam === undefined || seam.profileWriter === undefined || seam.journal === undefined) {
      return { status: 'skipped', summary: 'no profile writer or no journal in this build' }
    }
    const lastRaw = Number(seam.stores.getMeta(PROFILE_REVIEW_META_KEY) ?? '')
    const route = seam.route?.()
    const outcome = await runProfileReview({
      writer: seam.profileWriter,
      sessionId: 'mc-dreamer',
      journal: seam.journal,
      now: () => context.now,
      // Expiry is unconditional; the model halves are only offered when a route
      // exists, because `runProfileReview` needs both to attempt a call.
      ...seam.llm === undefined || route === undefined
        ? {}
        : { llm: seam.llm, route },
      ...Number.isFinite(lastRaw) && lastRaw > 0 ? { lastReviewAt: lastRaw } : {},
      ...seam.config === undefined
        ? {}
        : { batch: seam.config().profileReviewBatch, minSessions: seam.config().profileReviewMinSessions },
      stores: seam.stores,
    })
    // Stamped only when a call was ATTEMPTED, so a failure is retried rather than
    // silenced for a day by its own error.
    if (outcome.attempted === true) seam.stores.setMeta(PROFILE_REVIEW_META_KEY, String(context.now))
    const changed = outcome.promoted + outcome.consumed + outcome.expired
    return {
      status: 'ok',
      // Processed counts every candidate the model actually judged, so a run that
      // promoted nothing does not look identical to one that never called out.
      itemsProcessed: outcome.promoted + outcome.consumed + (outcome.kept ?? 0),
      itemsChanged: changed,
      tokensUsed: 0,
      summary: outcome.ran
        ? `promoted ${String(outcome.promoted)}, consumed ${String(outcome.consumed)}, `
          + `kept ${String(outcome.kept ?? 0)}, expired ${String(outcome.expired)}`
        : `expired ${String(outcome.expired)} candidates; no promotion pass`
          + (outcome.reason === undefined ? '' : ` (${outcome.reason})`),
    }
  }
}

/** `auto-stage-global`: promote memories that recur across projects into the machine domain. */
export function buildAutoStageHandler(deps: DreamHandlerDeps): DreamTaskHandler {
  return async (context): Promise<DreamTaskResult> => {
    const seam = deps.housekeeping
    if (seam === undefined || seam.writer === undefined || seam.llm === undefined) {
      return { status: 'skipped', summary: 'no memory corpus or no llm seam in this build' }
    }
    // Fail-closed: no route means NOTHING is staged. A memory that stays at
    // project level is recoverable; one staged into the wrong domain is not
    // obviously so.
    const route = seam.route?.()
    if (route === undefined) return { status: 'skipped', summary: 'no route to classify with', retryInMs: PRECONDITION_RETRY_MS }
    if (seam.autoStageEnabled !== undefined && !seam.autoStageEnabled()) {
      return { status: 'skipped', summary: 'auto-staging is switched off' }
    }
    const outcome = await autoStageGlobalCandidates({
      store: seam.stores,
      corpusDbPath: seam.writer.dbPath,
      // One tick per project; without this every tick scans the same pool.
      projectPath: context.projectPath,
      now: context.now,
      llm: seam.llm as unknown as AutoStageLlm,
      route,
      ...seam.domainWriter === undefined ? {} : { writer: seam.domainWriter },
    })
    const publishedCount = outcome.published.length
    const refusedCount = outcome.refused.length
    // WHY each row was refused, counted rather than dropped.
    //
    // Measured 2026-11-28: 319 runs, 2197 rows examined, 0 changed, and every
    // summary said only "nothing staged" — the reason satellite was computed and
    // thrown away. That is the same shape as the `hardReason` gap: the decision
    // happened, the number survived, the cause did not. Without it nobody could
    // tell "the pool is correctly empty" from "every row is being misjudged", and
    // the lane spent 2871 classifier calls to answer neither.
    const refusalCounts = new Map<string, number>()
    for (const item of outcome.skipped) {
      refusalCounts.set(item.reason, (refusalCounts.get(item.reason) ?? 0) + 1)
    }
    const reasons = [...refusalCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([reason, count]) => `${reason} ${String(count)}`)
      .join(', ')
    return {
      status: 'ok',
      itemsProcessed: outcome.staged.length + outcome.skipped.length,
      // Publishing is the change that matters: a staged candidate sitting in a
      // pool changes nothing visible until it lands. Counting only `staged`
      // made this lane look idle on a night when rows did reach the domain.
      itemsChanged: publishedCount,
      tokensUsed: 0,
      summary: outcome.staged.length === 0
        ? `nothing staged${outcome.reason === undefined ? '' : ` (${outcome.reason})`}`
          + (reasons === '' ? '' : ` — refused: ${reasons}`)
          // The gap between what the scan returned and what the loop accounted
          // for is rows nobody reached. Silent until now; measured 2026-11-28 a
          // project with seven candidates reported three examined.
          + (outcome.scanned > outcome.staged.length + outcome.skipped.length
            ? ` [scanned ${String(outcome.scanned)}, examined ${String(outcome.staged.length + outcome.skipped.length)}]`
            : '')
        : `staged ${String(outcome.staged.length)}, published ${String(publishedCount)}, `
          + `refused ${String(refusedCount)}, skipped ${String(outcome.skipped.length)}`
          + (reasons === '' ? '' : ` (${reasons})`)
          + (refusedCount === 0 ? '' : ` — refusals stay pending for review_global`),
    }
  }
}

/** `backfill-vectors`: fill the semantic index for memories that have no vector yet. */
export function buildBackfillVectorsHandler(deps: DreamHandlerDeps): DreamTaskHandler {
  return async (context): Promise<DreamTaskResult> => {
    const seam = deps.housekeeping
    if (seam === undefined || seam.vectorBackfill === undefined || seam.journal === undefined) {
      return { status: 'skipped', summary: 'the vector lane is not wired in this build' }
    }
    if (seam.vectorBackfillEnabled !== undefined && !seam.vectorBackfillEnabled()) {
      return { status: 'skipped', summary: 'vector backfill is switched off' }
    }
    // The RSS series lives here because this is the closest survivor of the old
    // 30-minute sweep: one sample per run keeps the trend across days readable.
    // Sampled only when the lane actually runs, so a switched-off profile does
    // not accrue rows that look like activity. Upstream MC 0.49.1 (#681) leaked
    // in exactly this shape — each completed pass keeping the previous one — and
    // a static audit found no such retention here, so the series is what would
    // make a future one visible.
    const sample = memorySample(process.memoryUsage())
    seam.journal.info(
      'memory-sample',
      `rss ${String(sample.rssMb)} MB · heap ${String(sample.heapUsedMb)}/${String(sample.heapTotalMb)} MB`,
      sample,
    )
    const limit = Math.max(1, Math.floor(seam.vectorBackfillLimit?.() ?? 24))
    const outcome = await seam.vectorBackfill(limit, seam.journal)
    if (outcome === undefined) {
      // Not a failure: the lane is unusable (no embedder, closed parity gate),
      // which retrying sooner cannot fix.
      return { status: 'skipped', summary: 'backfill lane unavailable (no embedder or no writable store)' }
    }
    return {
      status: 'ok',
      itemsProcessed: outcome.total,
      itemsChanged: outcome.created,
      tokensUsed: 0,
      summary: `created ${String(outcome.created)}, present ${String(outcome.present)}, `
        + `${String(outcome.skipped)} skipped, ${String(outcome.failed)} failed (of ${String(outcome.total)})`,
    }
  }
}

/**
 * `prune-journal`: delete journal rows past the retention window.
 *
 * Why this is a task and not part of opening the journal: retention used to run
 * inside `openJournal`'s constructor (and again only when the configured value
 * changed, see `live-journal.ts`). A long-lived process opens the journal once,
 * so "prune at open" quietly becomes "prune never" — measured 2026-11-17, the
 * journal was 4.46 MB of row data plus 1.75 MB of indexes, 17,507 rows over ten
 * days, 47% of the whole database. A daily task is the scheduling primitive this
 * adapter already has; adding a second timer for it is the exact pattern the
 * maintenance sweep was deleted for.
 *
 * Kept AFTER the overnight batch (05:07) rather than at midnight: pruning first
 * would delete the rows the night's tasks are about to write.
 */
export function buildPruneJournalHandler(deps: DreamHandlerDeps): DreamTaskHandler {
  return async (context): Promise<DreamTaskResult> => {
    const seam = deps.housekeeping
    if (seam === undefined || seam.pruneJournal === undefined) {
      return { status: 'skipped', summary: 'journal pruning is not wired in this build' }
    }
    // Floored at one day, the same floor `live-journal.ts` applies to a manual
    // configuration: a stray zero must not be able to empty the table.
    const days = Math.max(1, Math.floor(seam.journalRetentionDays?.() ?? 30))
    const cutoff = context.now - days * 24 * 60 * 60_000
    let removed: number
    try {
      removed = seam.pruneJournal(cutoff)
    } catch (error) {
      // A failed prune is worth reporting but not worth retrying sooner: the
      // rows will still be there tomorrow, and the failure is probably SQLite
      // contention rather than anything the schedule can fix.
      return {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        summary: `journal prune failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    return {
      status: 'ok',
      itemsProcessed: removed,
      itemsChanged: removed,
      tokensUsed: 0,
      summary: removed === 0
        ? `nothing past ${String(days)}d retention`
        : `pruned ${String(removed)} journal rows older than ${String(days)}d`,
    }
  }
}

/** `index-commits`: read this project's git history into the search index. */
export function buildIndexCommitsHandler(deps: DreamHandlerDeps): DreamTaskHandler {
  return async (context): Promise<DreamTaskResult> => {
    const seam = deps.housekeeping
    if (seam === undefined || seam.indexCommits === undefined) {
      return { status: 'skipped', summary: 'commit indexing is not wired in this build' }
    }
    if (seam.indexCommitsEnabled !== undefined && !seam.indexCommitsEnabled()) {
      return { status: 'skipped', summary: 'commit indexing is switched off' }
    }
    const projectRoot = seam.projectRootOf?.(context.projectPath)
    if (projectRoot === undefined) {
      return { status: 'skipped', summary: 'no project root for this identity', retryInMs: PRECONDITION_RETRY_MS }
    }
    // A `git log` on a huge or network-mounted repo can stall for minutes, and a
    // stalled task holds the lease. A lagging commit index is harmless; a wedged
    // scheduler is not.
    const outcome = await Promise.race([
      seam.indexCommits({ projectPath: projectRoot, readLimit: 2_000, embedLimit: 64 }),
      new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), seam.indexCommitsTimeoutMs ?? 20_000)),
    ])
    if (outcome === undefined) return { status: 'skipped', summary: 'git read timed out' }
    return {
      status: 'ok',
      itemsProcessed: outcome.read,
      itemsChanged: outcome.inserted + outcome.updated,
      tokensUsed: 0,
      summary: `read ${String(outcome.read)}, +${String(outcome.inserted)} new, `
        + `${String(outcome.updated)} amended, ${String(outcome.embedded)} embedded`
        + (outcome.failure === undefined ? '' : ` (${outcome.failure})`),
    }
  }
}

export function buildDreamHandlers(deps: DreamHandlerDeps): Record<string, DreamTaskHandler> {
  return {
    'promote-primers': buildPromotePrimersHandler(deps),
    'classify-memories': buildClassifyHandler(deps),
    verify: buildVerifyHandler(deps),
    curate: buildCurateHandler(deps),
    retrospective: buildRetrospectiveHandler(deps),
    'evaluate-smart-notes': buildEvaluateSmartNotesHandler(deps),
    'review-user-memories': buildReviewUserMemoriesHandler(deps),
    'auto-stage-global': buildAutoStageHandler(deps),
    'backfill-vectors': buildBackfillVectorsHandler(deps),
    'index-commits': buildIndexCommitsHandler(deps),
    'prune-journal': buildPruneJournalHandler(deps),
  }
}
