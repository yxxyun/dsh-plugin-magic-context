/**
 * The maintenance tick's schedule (the adapter's slice of MC's dreamer): TTL
 * expiry always runs when the writer is writable; LLM verification uses the
 * main conversation's latest route, unless an explicit
 * `maintenance.verifyProvider/verifyModel` pin overrides it (the rollback
 * lever). A tick has no session of its own, so "latest" is last-seen-wins
 * across concurrent sessions — enough for a lane whose only requirement is "a
 * route the user currently trusts". A route observed quota-exhausted inside
 * the hold skips the LLM steps with one info line instead of joining the main
 * conversation's failure noise. The sweep covers the configured project plus
 * every identity this process resolved for a session (see
 * {@link PreStepProjects}). Fail-open end to end: a broken tick journals and
 * waits for the next one.
 *
 * Moved verbatim out of index.ts. The interval starts only AFTER the boot
 * catch-up run: with both timers armed at mount they fire together at 60s and
 * sweep twice (measured: two identical maintenance rows per boot, and two llm
 * calls for the same batch).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AdapterStores } from '../core/stores.ts'
import type { Journal } from '../core/journal.ts'
import { memorySample } from '../core/maintenance.ts'
import { PROFILE_REVIEW_META_KEY, runProfileReview, type ProfileReviewLlm, type ProfileReviewOutcome } from '../core/profile-review.ts'
import type { VectorBackfillOutcome } from '../core/vector-backfill.ts'
import { quotaSkipSince, resolveMaintenanceRoute, ROUTE_QUOTA_HOLD_MS, RouteHealth, type RouteChoice } from '../core/route-health.ts'

/** WP11 default batch: how many vectors one maintenance tick may add. */
export const VECTOR_BACKFILL_DEFAULT_LIMIT = 24

/**
 * WP11 gate. Default TRUE since 2026-10-12: the memory write path never embeds,
 * so with the lane off every NEW memory stayed vector-less forever and Chinese
 * semantic recall (the only channel with real recall on this corpus — FTS with
 * unicode61 hits ~18%) silently decayed as rows accumulated. The vectors land
 * in the machine's own single-writer store, bounded by
 * `vectorBackfillLimit` per tick and gated by the shared-space parity check
 * (a closed gate aborts the whole batch). Set the key to `false` to keep the
 * shared store free of writes.
 */
export function vectorBackfillEnabled(memory: MagicContextDshConfig['memory']): boolean {
  return liveBoolean(memory?.vectorBackfill, true)
}
/** Live maintenance tickers keyed by adapter DB path — a same-DB remount replaces its predecessor (see wireMaintenance). */
const maintenanceTickers = new Map<string, () => void>()
import type { MemoryWriter } from '../core/memory-write.ts'
import type { ProfileWriter } from '../core/profile-write.ts'
import { errText } from '../core/types.ts'
import { autoStageGlobalCandidates, type AutoStageLlm } from '../core/global-autostage.ts'
import { runSmartNoteTick } from './smart-notes.ts'
import type { HistorianLlm } from './historian.ts'
import type { MagicContextDshConfig } from './config.ts'
import type { PreStepProjects } from './pre-step.ts'
import { liveBoolean, liveNumber, liveString } from './volatile.ts'
/** Newest maintenance tally, surfaced by the telemetry panel (dreamer KPI). */
export interface MaintenanceLast {
  at: number
  expired: number
  verified: number
  updated: number
  archived: number
}

export interface MaintenanceWiring {
  /** Getter, not a copy — the panel polls the newest tally. */
  maintenanceLast: () => MaintenanceLast | undefined
}

export function wireMaintenance(input: {
  ctx: Context
  config: MagicContextDshConfig
  stores: AdapterStores
  journal: Journal | undefined
  llm: HistorianLlm | undefined
  writer: MemoryWriter | undefined
  profileWriter: ProfileWriter | undefined
  /** WP11: the lane's backfill closure; absent when the lane is unusable. */
  vectorBackfill?: (limit: number, journal: Journal) => Promise<VectorBackfillOutcome | undefined>
  /** Volatile per-provider quota observations, fed from `agent/request-error`. */
  routeHealth: RouteHealth
  /** The main conversation's latest route; the tick follows it when unpinned. */
  lastSessionRoute: () => RouteChoice | undefined
  /**
   * The working directory of the most recent session, for lanes that need a
   * filesystem location rather than an identity (git commit indexing). Absent =
   * no commit indexing, which is the honest answer when no session has run.
   */
  lastSessionCwd?: () => string | undefined
  /** Git commit indexing closure; absent when the corpus is unavailable. */
  indexCommits?: (input: {
    readonly projectPath: string
    readonly embedLimit?: number
    readonly readLimit?: number
  }) => Promise<import('../core/git-commit-indexer.ts').IndexCommitsResult | undefined>
  /**
   * Cluster recurring questions and promote the ones worth a primer. Pure SQLite
   * work over already-observed candidates, so it is cheap enough for the tick.
   */
  promotePrimers?: (input: {
    readonly projectPath: string
  }) => { readonly created: readonly number[]; readonly refreshed: readonly number[] } | undefined
  projects: PreStepProjects
  /** The adapter-level disposer list (timers ride it). */
  disposers: Array<() => void>
  /** The compaction engine sets this when the adapter is disposed. */
  isDisposed: () => boolean
}): MaintenanceWiring {
  const { ctx, config, stores, journal, llm, writer, profileWriter, vectorBackfill, routeHealth, lastSessionRoute, lastSessionCwd, indexCommits, promotePrimers, projects, disposers, isDisposed } = input
  const { seenIdentities } = projects
  let maintenanceBusy = false
  let maintenanceBusySince: number | undefined
  /**
   * The fixed-interval sweep is GONE.
   *
   * Everything it did was a memory-lifecycle step that upstream keeps as a dream
   * task: TTL expiry (`curate`), verification (`verify`), profile review
   * (`review-user-memories`), smart notes (`evaluate-smart-notes`). The last three
   * items it still owned — machine-domain auto-staging, vector backfill, commit
   * indexing — are tasks too now (`auto-stage-global`, `backfill-vectors`,
   * `index-commits`).
   *
   * Two schedulers on one store was the actual defect: a 30-minute unconditional
   * sweep always beat the daily tasks to the same unverified pool, so the
   * evidence-backed lane reported `pool 0` no matter how it was scheduled.
   *
   * `maintenanceLast` is still exposed for the panel, but it now reads the newest
   * `maintenance` row the tasks write instead of a timer this module owns.
   */
  const maintenanceLast = (): MaintenanceLast | undefined => {
    const rows = journal?.tail(200) ?? []
    // `dream-run` rather than `maintenance`: nothing writes a `maintenance` row
    // any more (the sweep is gone), so looking for one would report "never ran"
    // forever. A dream run IS the background work now, so the newest one is both
    // the honest timestamp and the one a reader means by "last maintenance".
    //
    // The per-step counters stay 0: a `dream-run` row carries its own
    // itemsProcessed/itemsChanged, and the panel reads those from its own
    // endpoint. Reporting them here would be a second, differently-rounded copy.
    for (let k = rows.length - 1; k >= 0; k -= 1) {
      const row = rows[k]
      if (row?.kind !== 'dream-run') continue
      return { at: row.at, expired: 0, verified: 0, updated: 0, archived: 0 }
    }
    return undefined
  }
  /**
   * No ticker is installed. The dream runner is the only scheduler: every step
   * this module used to perform now runs as a task, and a second interval on the
   * same store was the defect (see above).
   */
  disposers.push(() => {})
  return { maintenanceLast }
}
