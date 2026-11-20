/**
 * The adapter's own SQLite stores, on `node:sqlite` (no native addons: the
 * DSH desktop host is an Electron RunAsNode process where ABI-compiled
 * modules are not portable; node:sqlite is built in on Node >= 22.19).
 *
 * Schema discipline mirrors Magic Context's storage layer: a version fence
 * that fails closed when the database is newer than this build knows, and a
 * forward-only migration chain. (The Phase 1+ plan of moving these rows into
 * the shared context.db was superseded 2026-10-13: the corpus became the
 * plugin's own memories.db, and this store stays the adapter's runtime side.)
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { Compartment, CompartmentDraft } from './compartments.ts'
import type { JournalEntry, JournalKind, JournalLevel } from './journal.ts'
import type { MemoryFact } from './memory-categories.ts'
import type { DomainKind } from './domains.ts'
import { parseShareCategories, serializeShareCategories } from './domains.ts'
import { computeWorkMetrics, toAssistantUsageRow, type WorkMetrics } from './work-metrics.ts'
import { openCompartmentLease, type CompartmentLease, type LeaseDatabase } from './compartment-lease.ts'
import { openDreamLease, type DreamLease, type DreamLeaseOptions } from './dream-lease.ts'
import type { TagRecord, TagTarget, UsageRecord } from './types.ts'

export const SCHEMA_VERSION = 19

/** The m[0]/m[1] baseline identity for one session. */
export interface BaselineState {
  readonly sessionId: string
  /** Bumped on every HARD rebuild (m[0] frozen again). */
  readonly epoch: number
  /** The surface node carrying the composed baseline, once one landed. */
  readonly nodeSeq?: number
  /** The routed provider/model the baseline was built for (route change ⇒ HARD). */
  readonly provider?: string
  readonly model?: string
  /** Timestamp of the last HARD rebuild; m[1] holds compartments newer than this. */
  readonly frozenAt: number
  /**
   * Renderer format stamp (upstream `compartmentRenderEpoch`). A baseline
   * composed by a different renderer must be folded once: its cached bytes came
   * from code that no longer exists, so comparing them against today's output
   * keeps reporting a difference that is not the session's.
   */
  readonly renderEpoch?: number
  /**
   * Highest compartment id frozen into m[0] (upstream `cachedM0MaxCompartmentSeq`).
   * The split is by SEQUENCE, not time: a timestamp boundary is ambiguous for two
   * compartments created in the same millisecond and inverts on a clock step back.
   */
  readonly maxCompartmentId?: number
  /**
   * Fingerprint of the system prompt this baseline was composed under
   * (upstream `systemPromptFingerprint`). A change forces a HARD fold.
   */
  readonly systemHash?: string
  /** Identity of the injected project-memory digest (change ⇒ HARD). */
  readonly memoriesDigest?: string
  /**
   * Magic Context's additive-memory watermark: memories with `id` above it are
   * rendered in m[1] (`<new-memories>`) instead of m[0], so a new memory never
   * rebuilds the cached prefix. Frozen at every HARD rebuild.
   */
  readonly maxMemoryId?: number
  /**
   * Magic Context's mutation-log watermark (its
   * `session_meta.cached_m0_max_memory_mutation_id`): the highest
   * `memory_mutation_log.id` folded into m[0]. Rows above it render in m[1]
   * `<memory-updates>`; a HARD rebuild advances it, so the deltas disappear
   * once they are baked into the frozen prefix (contract §5.3, §7.5).
   */
  readonly maxMemoryMutationId?: number
  /**
   * The project's `project_state.project_memory_epoch` identity (a fingerprint
   * over the project and its domain peers). A change means an external
   * writer moved the memory epoch, so the m[0] snapshot AND the mutation
   * cursor are invalid: the pass rebuilds hard and re-freezes both.
   */
  readonly projectEpochFingerprint?: string
  /**
   * Schema v8: the highest `user_memories.id` folded into m[0]. Profile rows
   * above it render in m[1] `<new-user-profile>` instead of forcing a HARD
   * rebuild — the same additive-watermark shape as `maxMemoryId`, but for the
   * profile table, which Magic Context versioned globally instead.
   */
  readonly profileWatermark?: number
  /**
   * Schema v8: the profile's m[0] content digest (ordered `id:updated_at` of
   * the active rows at or below `profileWatermark`). A change means a profile
   * row was rewritten or retired — which the adapter DOES treat as HARD,
   * unlike Magic Context, whose version bump deliberately never folded m[0]
   * and therefore kept injecting stale `<user-profile>` text indefinitely.
   */
  readonly profileM0Digest?: string
  readonly updatedAt: number
}

/**
 * One S(t) sidecar row: per-project, per-shared-memory usage the ADAPTER
 * tracks for its own decay scoring. The shared memory store is never written
 * for this (writer-contract discipline) — these columns exist only here.
 */
export interface MemoryStatRow {
  readonly projectIdentity: string
  readonly memoryId: number
  readonly hits: number
  readonly lastHitAt?: number
  readonly injections: number
  readonly lastInjectedAt?: number
  /** Adapter-local injection retirement; still searchable, just not injected. */
  readonly localArchived: boolean
  readonly updatedAt: number
}

/**
 * Schema v8: one global domain. `cap` is DERIVED from a token target (see
 * core/domains.ts `deriveDomainCap`) rather than picked, so budget pressure and
 * the admission limit can never disagree.
 */
export interface DomainRow {
  readonly domainId: string
  readonly kind: DomainKind
  readonly enabled: boolean
  readonly budgetTokens: number
  readonly cap: number
  /**
   * The category allowlist for the domain's shared rows, in the contract's
   * fail-closed convention: a malformed value or an unknown category shares
   * NOTHING (only a missing column falls back to `["CONSTRAINTS"]`). Empty
   * array = share no foreign categories at all.
   */
  readonly shareCategories: readonly string[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** Schema v8: which project identities activate a domain. */
export interface DomainMemberRow {
  readonly domainId: string
  readonly identity: string
  readonly addedAt: number
}

/** Schema v8: a cross-project candidate for `org` / `machine`. */
export interface GlobalCandidateRow {
  readonly id: number
  readonly domainId: string
  readonly content: string
  readonly normalizedHash: string
  readonly firstIdentity: string
  readonly sessionId?: string
  readonly compartmentStart?: number
  readonly compartmentEnd?: number
  /** Distinct project identities that independently observed this candidate. */
  readonly distinctIdentities: number
  readonly observationCount: number
  /** v9: the category it will be published under; absent for scan-detected rows. */
  readonly category?: string
  /** v9: the project memory a human promotion came from. */
  readonly sourceMemoryId?: number
  /**
   * v10: the LLM classification that routed this candidate into its domain
   * (`project` rows are never staged, so an absent value here means the row
   * predates classification — a human promotion or an older auto-stage).
   */
  readonly suggestedDomain?: 'machine' | 'org'
  /** v10: the classifier's one-line reason, carried into the review card. */
  readonly suggestionReason?: string
  readonly state: 'pending' | 'approved' | 'rejected' | 'expired'
  readonly createdAt: number
  readonly updatedAt: number
}

/** Schema v8: one independent observation behind a global candidate. */
export interface CandidateObservationRow {
  readonly candidateId: number
  readonly identity: string
  readonly sessionId: string
  readonly compartmentStart?: number
  readonly compartmentEnd?: number
  readonly observations: number
  readonly firstSeenAt: number
  readonly lastSeenAt: number
}

/**
 * Schema v8: the directive-shaped confirmation queue. A candidate that reads
 * like an instruction ("always do X") may not enter the profile until the human
 * answers the question — the blast radius of a hallucinated behavioural rule is
 * every session on the machine, not just a stale note.
 */
export interface ProfileConfirmationRow {
  readonly id: number
  /** The `user_memory_candidates.id` in the SHARED store (no FK by design). */
  readonly contractCandidateId: number
  readonly question: string
  readonly content: string
  readonly state: 'pending' | 'approved' | 'rejected'
  readonly createdAt: number
  readonly decidedAt?: number
}

/**
 * Schema v11: one pending intention (`ctx_note`).
 *
 * Not a memory: a note is work the session means to return to, so it carries a
 * status that expires by human dismissal rather than a category, a TTL and a
 * promote lane. Keeping the two apart is the whole point — a stale note must be
 * allowed to rot silently, which a memory may never do.
 */
export interface NoteRow {
  readonly id: number
  /** `session` today; `smart` reserved for a future externally-checked lane. */
  readonly type: 'session' | 'smart'
  readonly status: 'active' | 'pending' | 'ready' | 'dismissed'
  readonly content: string
  readonly sessionId?: string
  readonly projectPath?: string
  readonly surfaceCondition?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly readyAt?: number
  readonly readyReason?: string
  /** Message ordinal the note was written at, when the session could provide one. */
  readonly anchorOrdinal?: number
  /**
   * Consecutive smart-note checks that ERRORED. A false condition does not count
   * — it is progress, and resets the counter — so this only climbs when the check
   * itself is broken (bad URL, unreadable file).
   */
  readonly checkFailureCount?: number
}

/**
 * One project's cadence for one background task (v13).
 *
 * `nextDueAt` is the only field the scheduler actually polls, and it is stored
 * rather than derived so a restart cannot re-fire a run that already happened.
 * `undefined` (NULL in the row) means "never": an empty cron, or an expression
 * naming an impossible instant such as Feb 31. Those rows are skipped, not
 * retried every tick.
 */
export interface DreamScheduleRow {
  readonly projectPath: string
  readonly task: string
  /** 5-field cron in local time; `''` means never. */
  readonly cron: string
  readonly nextDueAt?: number
  readonly lastRunAt?: number
  /** `ok` | `failed` | `skipped` — the last completed run, not the current one. */
  readonly lastStatus?: DreamRunStatus
  readonly lastError?: string
  /**
   * Consecutive failed runs. Drives backoff, so a task whose code is broken
   * stops being retried every minute; reset to 0 by any completed run.
   */
  readonly consecutiveFailures: number
  readonly enabled: boolean
  readonly updatedAt: number
}

export type DreamRunStatus = 'running' | 'ok' | 'failed' | 'skipped'

/** One completed (or in-flight) background-task run. */
export interface DreamRunRow {
  readonly id: number
  readonly projectPath: string
  readonly task: string
  readonly startedAt: number
  readonly finishedAt?: number
  readonly status: DreamRunStatus
  readonly itemsProcessed: number
  readonly itemsChanged: number
  readonly tokensUsed: number
  readonly summary?: string
  readonly error?: string
}

/** One row of the dashboard's session list (see `AdapterStores.listSessions`).
 *
 * `latestPressure`/`latestTokens` come from the newest `context-pressure` or
 * `pass` journal row of that Session — the two kinds that carry a reading. They
 * are optional because a Session that never ran a pass has neither.
 */
export interface SessionSummaryRow {
  readonly sessionId: string
  readonly journalRows: number
  readonly usageRows: number
  readonly compartments: number
  readonly landedCompartments: number
  readonly tags: number
  readonly pendingDrops: number
  readonly notes: number
  readonly firstAt?: number
  readonly lastAt?: number
  readonly latestPressure?: number
  readonly latestTokens?: number
  readonly latestContextWindow?: number
}

export interface AdapterStores {
  readonly dbPath: string
  /** Fails closed (returns null) when the persisted version is ahead. */
  allocateTag(sessionId: string, target: TagTarget, now: number): number
  getTag(sessionId: string, target: TagTarget): number | undefined
  listTags(sessionId: string): TagRecord[]
  recordUsage(record: UsageRecord): void
  listUsage(sessionId: string): UsageRecord[]
  /**
   * Usage rows across every session since `since`.
   *
   * Exists for the dashboard's cache accounting: the per-session reader answers
   * "how is THIS conversation doing", the window reader answers "how are we
   * doing overall", and the two must not be derived from each other (a session
   * that never reported would silently remove itself from a global average).
   */
  listUsageSince(since: number): UsageRecord[]
  /** Newest usage row by seq, or undefined before the first response. */
  latestUsage(sessionId: string): UsageRecord | undefined
  /**
   * Work metrics for a session: `newWorkTokens` (context growth) against
   * `totalInputTokens` (what the context had to hold at its peak per phase).
   *
   * The distinction drives compaction: re-reading a stable prefix grows
   * `totalInputTokens` without producing work, which is the case where a
   * rebuild costs more than it saves. Derived from `usage_records` by
   * `core/work-metrics.ts`.
   */
  workMetrics(sessionId: string): WorkMetrics
  /**
   * Cross-process lease on compartment state. Opened on first call and reused,
   * so the holder id stays stable for this process's lifetime — a lease this
   * process already owns is renewed rather than fought over.
   */
  compartmentLease(options?: { log?: (sessionId: string, message: string) => void }): CompartmentLease
  /**
   * Newest timestamp at which something changed the INJECTED surface for this
   * session — a compartment landing, or the m[0] baseline being refreshed.
   *
   * Used for one thing: a usage reading recorded before this instant describes a
   * prompt that no longer exists. It is still the best size signal the pass
   * decision has, but the force band must not reclaim against it (reclaim is
   * irreversible, and it would drop against a larger wire). Upstream MC fixed
   * the same class in v0.49.49 (`usagePredatesHistoryChange`).
   *
   * The drop lane is deliberately NOT included: a landed drop is the agent's own
   * `ctx_reduce` mark, and treating it as a surface change here would exempt the
   * pass that just landed it from ever reclaiming again.
   */
  latestHistoryChangeAt(sessionId: string): number | undefined
  /**
   * Drain accounting for one session: the rolling budget window and the
   * emergency latch. Mirrors upstream mc-upstream a1ca346's per-session
   * `protectedTailDrain*` / `emergencyDrainActive` / `historianDrainFailureAt`.
   *
   * A missing row is the neutral state (no window, no latch, no failure), never
   * an error: a session that has never drained has no accounting to report.
   */
  getDrainState(sessionId: string): DrainStateRow
  /** Persist drain accounting. Upsert — one row per session, last writer wins. */
  putDrainState(sessionId: string, state: DrainStateRow): void
  queueDrop(sessionId: string, tagNumber: number, now: number): void
  /** Pending (not yet landed) drop tag numbers, oldest first. */
  listPendingDrops(sessionId: string): number[]
  markDropLanded(sessionId: string, tagNumber: number, landedEventSeq: number): void
  /**
   * Retire a queued drop whose target no longer exists on the surface (the
   * message was compacted into a compartment, or the tag row was pruned by
   * retention). Until this existed such a row sat pending forever: every
   * execute pass retried a tag that could never reappear, and the dashboard's
   * "待落地回收" only ever grew.
   *
   * Stored as `landed_event_seq = -1` — the pending query is
   * `landed_event_seq IS NULL`, so a retired row leaves the queue without a
   * schema change, and `queueDrop`'s upsert still re-queues it if that tag
   * ever comes back.
   */
  retireDrop(sessionId: string, tagNumber: number): void
  /** Store one validated historian digest for a covered span. */
  allocateCompartment(
    sessionId: string,
    draft: CompartmentDraft,
    covered: { startSeq: number; endSeq: number; seqs: readonly number[]; tokens: number },
    baselineEpoch: number,
    now: number,
  ): Compartment
  listCompartments(sessionId: string): Compartment[]
  /** Compartments whose reclaim placeholder has not landed yet. */
  listUnlandedCompartments(sessionId: string): Compartment[]
  markCompartmentLanded(sessionId: string, compartmentId: number, landedEventSeq: number): void
  /**
   * Terminal publish refusal (schema v7): the compartment KEEPS its
   * covered-seq claims (the span IS digested — it just does not pay for its
   * render), but it is never published and never retried.
   */
  markCompartmentRejected(sessionId: string, compartmentId: number, reason: string): void
  /**
   * Retire a drifted draft (schema v7): unlike a rejection the covered-seq
   * claims are RELEASED, so the next historian run re-digests the span
   * including the nodes that entered it after drafting.
   */
  supersedeCompartment(sessionId: string, compartmentId: number, reason: string): void
  /**
   * Replace a stored compartment's DIGEST (tiers, importance, facts, events)
   * while keeping its identity, coverage and landed placeholder. The recomp lane
   * re-digests history that already left the surface, so no row may be re-added:
   * only the text the model sees changes.
   */
  replaceCompartmentDraft(sessionId: string, compartmentId: number, draft: CompartmentDraft): void
  /** Every surface seq already digested by a compartment (historian eligibility). */
  coveredSeqs(sessionId: string): Set<number>
  baselineState(sessionId: string): BaselineState | undefined
  saveBaselineState(state: BaselineState): void
  /** Free-form diagnostics written by the composition root (observable facts). */
  setMeta(key: string, value: string): void
  getMeta(key: string): string | undefined
  /** Append one activity-journal entry (the validation-period audit trail). */
  appendJournal(entry: JournalEntry): void
  /** Newest-first journal query; every filter is optional. */
  listJournal(filter?: {
    since?: number
    until?: number
    sessionId?: string
    kinds?: readonly JournalKind[]
    levels?: readonly JournalLevel[]
    limit?: number
  }): JournalEntry[]
  /**
   * Kind/level counts since a timestamp (journal rollups).
   * @param since - count entries at or after this time; every entry when omitted.
   * @param sessionId - restrict the rollup to one Session; every Session when omitted.
   */
  journalByKind(since?: number, sessionId?: string): Array<{ kind: string; level: JournalLevel; count: number }>
  /**
   * Sum one numeric field across a kind's journal rows in a window.
   *
   * `journalByKind` answers "how many events", which is the wrong unit for a
   * lane whose records are batched: one `drop-landed` row can carry 165 tags, so
   * counting rows shows 1 and hides the whole reclaim. This reads the batched
   * payload instead. Rows whose JSON is malformed are skipped rather than
   * failing the rollup.
   *
   * @param kind - journal kind to aggregate.
   * @param field - numeric field inside each row's `data` object.
   * @param since - only rows at or after this time; every row when omitted.
   * @param sessionId - restrict to one Session; every Session when omitted.
   */
  journalSumField(kind: string, field: string, since?: number, sessionId?: string): number
  /** Delete entries older than the cutoff; returns the number removed. */
  pruneJournal(before: number): number
  /**
   * Delete §N§ registry rows older than the cutoff; returns the number removed.
   * The tags table only ever grows (one row per tagged target), so this is its
   * retention valve. Registry rows that old belong to compacted spans, and
   * `tag_counters` is never touched — numbers stay monotonic per session, so a
   * re-tag of a pruned target simply allocates the next fresh number.
   */
  pruneTags(before: number): number
  /** S(t) sidecar: record one search hit or recall injection (upsert + bump). */
  recordMemoryEvent(projectIdentity: string, memoryId: number, kind: 'hit' | 'injection', now: number): void
  /** S(t) sidecar rows for one identity, narrowed to `memoryIds` when given. */
  listMemoryStats(projectIdentity: string, memoryIds?: readonly number[]): MemoryStatRow[]
  /** Delete sidecar rows whose memory id is no longer known; returns rows removed. */
  pruneMemoryStats(projectIdentity: string, keepIds: readonly number[]): number
  /** Row count plus the oldest/newest timestamps. */
  journalBounds(): { rows: number; oldest?: number; newest?: number }
  /**
   * The dashboard's session list: every Session this store has ever seen, with
   * the facts a browser needs to pick one (rows, span, last activity, whether
   * it is compacting right now). Read-only and aggregate-only.
   *
   * A Session is "known" if ANY of the per-session tables mentions it — journal,
   * usage, compartments, tags, notes. Counting only the journal would hide a
   * Session whose first pass never logged, and counting only `usage_records`
   * would hide one that never completed a turn.
   */
  listSessions(limit?: number): SessionSummaryRow[]

  // ---- schema v8: global domains ------------------------------------------
  /**
   * Insert or update a domain definition. `cap` is DERIVED by the caller
   * (core/domains.ts), never passed in from a UI, so the admission limit and
   * the token budget cannot drift apart.
   */
  upsertDomain(domain: { domainId: string; kind: DomainKind; enabled: boolean; budgetTokens: number; cap: number; shareCategories: readonly string[] }, now: number): void
  listDomains(): DomainRow[]
  getDomain(domainId: string): DomainRow | undefined
  setDomainEnabled(domainId: string, enabled: boolean, now: number): void
  addDomainMember(domainId: string, identity: string, now: number): void
  removeDomainMember(domainId: string, identity: string): void
  /** All members, or one domain's members. */
  listDomainMembers(domainId?: string): DomainMemberRow[]
  /**
   * The identities this project activates, resolved from the adapter's own
   * store. Callers MUST use this result both for the recall predicate AND for
   * the visibility watermark: a watermark computed over a wider set silently
   * swallows later visible rows (the phantom `<new-memories>` failure).
   */
  activeDomainIdentities(identity: string): Array<{ domainId: string; kind: DomainKind; identity: string }>
  /** Upsert by (domainId, normalizedHash), refreshing content and weight. */
  upsertGlobalCandidate(
    candidate: {
      domainId: string
      content: string
      normalizedHash: string
      firstIdentity: string
      sessionId?: string
      compartmentStart?: number
      compartmentEnd?: number
      category?: string
      sourceMemoryId?: number
      /** v10: the LLM classification that routed this candidate (optional — human promotions carry none). */
      suggestedDomain?: 'machine' | 'org'
      suggestionReason?: string
    },
    now: number,
  ): GlobalCandidateRow
  getGlobalCandidate(id: number): GlobalCandidateRow | undefined
  listGlobalCandidates(filter?: { domainId?: string; state?: GlobalCandidateRow['state'] }): GlobalCandidateRow[]
  setGlobalCandidateState(id: number, state: GlobalCandidateRow['state'], now: number): void
  /** One independent observation; the (candidate, identity, session) triple collapses. */
  recordCandidateObservation(
    observation: {
      candidateId: number
      identity: string
      sessionId: string
      compartmentStart?: number
      compartmentEnd?: number
    },
    now: number,
  ): void
  listCandidateObservations(candidateId: number): CandidateObservationRow[]
  /** Queue a directive-shaped candidate until a human answers the question. */
  enqueueProfileConfirmation(
    input: { contractCandidateId: number; question: string; content: string },
    now: number,
  ): ProfileConfirmationRow
  listProfileConfirmations(state?: ProfileConfirmationRow['state']): ProfileConfirmationRow[]
  decideProfileConfirmation(id: number, state: 'approved' | 'rejected', now: number): void
  /** v11: store one pending intention; the returned row carries the new id. */
  createNote(
    input: {
      content: string
      sessionId?: string
      projectPath?: string
      anchorOrdinal?: number
      type?: NoteRow['type']
      /**
       * Declarative surface condition (`core/surface-condition.ts`). A note that
       * carries one is a SMART note: it stays parked until a maintenance tick
       * evaluates the condition and finds it holds, then becomes `ready`.
       * Validated by the caller — the store records what it is given.
       */
      surfaceCondition?: string
      /** Next scheduled check, epoch ms. Required for a smart note to be polled. */
      nextCheckAt?: number
    },
    now: number,
  ): NoteRow
  getNote(id: number): NoteRow | undefined
  /**
   * Notes for the read view: this session's active rows first (newest first),
   * then any smart rows that became ready. `filter: 'all'` also returns
   * dismissed rows, which is what the agent needs to prove a dismissal landed.
   */
  listNotes(filter: {
    sessionId?: string
    projectPath?: string
    status?: NoteRow['status'] | 'open'
    limit?: number
    /** Rows to skip after ordering, for paging a long note queue. */
    offset?: number
  }): NoteRow[]
  /** Rewrite one note's content; `undefined` when the id does not exist. */
  updateNote(id: number, content: string, now: number): NoteRow | undefined
  /** Retire notes: `dismissed` keeps them readable, `delete` removes the row. */
  retireNotes(ids: readonly number[], mode: 'dismiss' | 'delete', now: number): number
  /** Age out dismissed rows (maintenance tick). */
  pruneNotes(before: number): number
  /**
   * Smart notes whose check is due, oldest deadline first.
   *
   * Only `pending` rows carrying a condition are returned: a note that already
   * surfaced (`ready`) or was retired must not be re-checked, and a plain note
   * has nothing to check.
   */
  listDueSurfaceChecks(now: number, limit?: number): NoteRow[]
  /**
   * Record one check outcome.
   *
   * - `met` → the note becomes `ready` and carries the reason it woke, which is
   *   what the agent sees when it surfaces.
   * - not met → the row stays `pending` with its next deadline moved forward.
   *
   * A failure count is tracked separately from a plain "not met" so a note whose
   * check keeps erroring (bad URL, deleted file) can be surfaced with a warning
   * instead of parking forever in silence.
   */
  recordSurfaceCheck(input: {
    id: number
    met: boolean
    /** Why it woke, or why the check failed. */
    reason?: string
    /** Next deadline when it did not wake. */
    nextCheckAt?: number
    /** Whether this outcome was an error rather than a false condition. */
    failed?: boolean
  }, now: number): NoteRow | undefined
  // ── Background tasks (v13) ───────────────────────────────────────────────
  /**
   * One project's schedule row for one task, or undefined before it is seeded.
   *
   * The runner reads this instead of computing a due instant from the clock:
   * a restart must not re-fire a task that already ran, so the next due instant
   * is state, not a derivation.
   */
  getDreamSchedule(projectPath: string, task: string): DreamScheduleRow | undefined
  /** Every schedule row for one project, in canonical task order. */
  listDreamSchedules(projectPath: string): DreamScheduleRow[]
  /**
   * Every project the scheduler knows about, derived from its own rows.
   *
   * Used at mount to warm the identity→root map from persisted values: a task
   * that reads files (index-commits, verify) must not wait for a
   * conversation step just to learn where a project lives, and a remount is
   * exactly when that step has not happened yet in the new process.
   */
  listDreamProjects(): string[]
  /**
   * Create or replace a schedule row. `nextDueAt: null` means "never fires" —
   * either the cron is empty or it names an instant that cannot occur.
   */
  upsertDreamSchedule(row: DreamScheduleRow): void
  /**
   * Tasks whose `next_due_at` has passed, oldest first, across every project.
   *
   * `enabled = 0` and `next_due_at IS NULL` rows are excluded here rather than
   * by the caller: a task nobody enabled is not due, and it must not appear in
   * a backlog count either.
   */
  listDueDreamTasks(now: number, limit?: number): DreamScheduleRow[]
  /**
   * Record the outcome of a run and advance the schedule.
   *
   * `nextDueAt` is computed by the caller (it owns the cron expression) but
   * written here in the same statement as the run row, so a crash between the
   * two cannot leave a task "ran but still due".
   */
  recordDreamRun(input: {
    projectPath: string
    task: string
    startedAt: number
    finishedAt: number
    /** `skipped` means the task chose to do nothing — not an error. */
    status: DreamRunStatus
    itemsProcessed?: number
    itemsChanged?: number
    tokensUsed?: number
    summary?: string
    error?: string
    /** Next due instant, or null when the task will not run again. */
    nextDueAt: number | null
    /** Consecutive-failure count to store (0 resets the backoff). */
    consecutiveFailures: number
  }): void
  /** Most recent runs for one project, newest first — the dashboard's history. */
  listDreamRuns(projectPath: string, limit?: number): DreamRunRow[]
  /**
   * Cross-process lease on a background-task domain, opened on first call and
   * reused so the holder id stays stable for this process's lifetime.
   *
   * Separate from `compartmentLease()` on purpose: that one is keyed by session
   * and lives for one pass, this one is keyed by project + lease domain and
   * guards a run that can be much longer.
   */
  dreamLease(options?: Omit<DreamLeaseOptions, 'db'>): DreamLease
  close(): void
  /**
   * True once `close()` ran. A remounted adapter (hmr reload) closes the old
   * composition's stores while a stale engine or in-flight caller may still
   * hold the old object — the flag lets those callers no-op instead of dying
   * on `database is not open`.
   */
  readonly closed: boolean
}

export function defaultDataDir(): string {
  return join(homedir(), '.local', 'share', 'cortexkit', 'magic-context-dsh-poc')
}

interface Migration {
  readonly version: number
  readonly up: (db: DatabaseSync) => void
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE meta(
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE tags(
          session_id TEXT NOT NULL,
          target_kind TEXT NOT NULL,
          target_id TEXT NOT NULL,
          tag_number INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(session_id, target_kind, target_id)
        );
        CREATE TABLE tag_counters(
          session_id TEXT PRIMARY KEY,
          next_tag INTEGER NOT NULL
        );
        CREATE TABLE usage_records(
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          turn INTEGER NOT NULL,
          step INTEGER NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cache_read_tokens INTEGER,
          cache_write_tokens INTEGER,
          recorded_at INTEGER NOT NULL,
          PRIMARY KEY(session_id, seq)
        );
      `)
    },
  },
  {
    // v2: the agent-facing drop queue (ctx_reduce marks, the execute band
    // lands) — Magic Context's pending_ops vocabulary on the DSH adapter.
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE pending_drops(
          session_id TEXT NOT NULL,
          tag_number INTEGER NOT NULL,
          queued_at INTEGER NOT NULL,
          landed_event_seq INTEGER,
          PRIMARY KEY(session_id, tag_number)
        );
      `)
    },
  },
  {
    // v3: the historian's compartments and the m[0]/m[1] baseline identity.
    // A compartment is a durable digest of a covered surface span; it lands
    // as a `[compacted §C<n>§]` placeholder on the next execute band, and its
    // text is injected through the composed baseline node.
    version: 3,
    up: (db) => {
      db.exec(`
        CREATE TABLE compartments(
          session_id TEXT NOT NULL,
          compartment_id INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          covered_start_seq INTEGER NOT NULL,
          covered_end_seq INTEGER NOT NULL,
          covered_seqs TEXT NOT NULL,
          covered_tokens INTEGER NOT NULL,
          importance INTEGER NOT NULL,
          tier_p1 TEXT NOT NULL,
          tier_p2 TEXT NOT NULL,
          tier_p3 TEXT NOT NULL,
          tier_p4 TEXT NOT NULL,
          facts TEXT NOT NULL,
          events TEXT NOT NULL,
          baseline_epoch INTEGER NOT NULL,
          landed_event_seq INTEGER,
          PRIMARY KEY(session_id, compartment_id)
        );
        CREATE TABLE compartment_counters(
          session_id TEXT PRIMARY KEY,
          next_compartment INTEGER NOT NULL
        );
        CREATE TABLE baseline_state(
          session_id TEXT PRIMARY KEY,
          epoch INTEGER NOT NULL,
          node_seq INTEGER,
          provider TEXT,
          model TEXT,
          frozen_at INTEGER NOT NULL,
          memories_digest TEXT,
          updated_at INTEGER NOT NULL
        );
      `)
    },
  },
  {
    // v4: the activity journal — the validation-period audit trail. The
    // harness logger is not persisted by the Desktop app, so decisions and
    // outcomes get their own append-only table (see core/journal.ts).
    version: 4,
    up: (db) => {
      db.exec(`
        CREATE TABLE journal(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          level TEXT NOT NULL,
          kind TEXT NOT NULL,
          session_id TEXT,
          summary TEXT NOT NULL,
          data TEXT
        );
        CREATE INDEX journal_at ON journal(at);
        CREATE INDEX journal_kind ON journal(kind);
        CREATE INDEX journal_session ON journal(session_id, at);
      `)
    },
  },
  {
    // v5: the additive-memory watermark (Magic Context's `maxMemoryId`), so a
    // newly written memory surfaces in m[1] `<new-memories>` instead of
    // changing the recall digest and forcing a HARD rebuild of m[0].
    version: 5,
    up: (db) => {
      db.exec('ALTER TABLE baseline_state ADD COLUMN max_memory_id INTEGER')
    },
  },
  {
    // v6: the m[1] *mutation* delta lane. `max_memory_mutation_id` is Magic
    // Context's `cached_m0_max_memory_mutation_id` (watermark into the shared
    // `memory_mutation_log`); `project_epoch_fingerprint` is the
    // `project_state.project_memory_epoch` identity the baseline was built
    // against. Both are additive columns: an existing v5 database is upgraded
    // in place, and rows written before this version simply have NULL there
    // (the pass folds them once, see management-pass.ts).
    version: 6,
    up: (db) => {
      db.exec(`
        ALTER TABLE baseline_state ADD COLUMN max_memory_mutation_id INTEGER;
        ALTER TABLE baseline_state ADD COLUMN project_epoch_fingerprint TEXT;
      `)
    },
  },
  {
    // v7: the fusion additions (borrowed from mon3stera/dsh-magic-context
    // @0.1.0, audited 2026-10-09; see docs/ for the fusion plan).
    //  - compartments.landed_reason: a TERMINAL non-publish outcome.
    //    `not-shrinkable`: the publish guard proved the digest does not pay
    //    for its own baseline render. `superseded-entrants`: substantive
    //    nodes entered the positional range after drafting. A reasoned row
    //    is never published and never retried (listUnlandedCompartments
    //    excludes it), ending the old rejected-draft-retried-forever shape.
    //  - compartments.superseded: retires a drifted draft AND RELEASES its
    //    covered-seq claims, so the next historian run re-digests the whole
    //    span (originals plus the entrants) instead of leaking it.
    //    NOTE (2026-10-16): the publish guard that called these two was
    //    RETIRED (0 hits in its whole window); the column and both store APIs
    //    remain for schema-v7 compatibility, historical rows and tests.
    //  - memory_stats: the S(t) scoring sidecar. Hits/injections for rows of
    //    the SHARED memory store are tracked HERE, adapter-local — the
    //    shared store is never written for scoring (writer-contract
    //    discipline: only the bridge's contract actions touch it).
    version: 7,
    up: (db) => {
      db.exec(`
        ALTER TABLE compartments ADD COLUMN landed_reason TEXT;
        ALTER TABLE compartments ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE memory_stats(
          project_identity TEXT NOT NULL,
          memory_id INTEGER NOT NULL,
          hits INTEGER NOT NULL DEFAULT 0,
          last_hit_at INTEGER,
          injections INTEGER NOT NULL DEFAULT 0,
          last_injected_at INTEGER,
          local_archived INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(project_identity, memory_id)
        );
        CREATE INDEX memory_stats_archived ON memory_stats(project_identity, local_archived);
      `)
    },
  },
  {
    // v8: the global-domain substrate (docs/dsh-plugin-execution-plan-2026-10-09.md,
    // WP1). Magic Context, its dashboard and every other host are being removed,
    // so the adapter becomes the sole owner of: which global domains exist, which
    // project identities activate them, the cross-project candidate pool for
    // org/machine, and the confirmation queue that directive-shaped profile
    // candidates must pass through. All of it lives HERE (the adapter's own
    // store) — the own corpus (memories.db) deliberately carries none of it.
    //
    //  - domains: one row per global domain. `cap` is DERIVED from a token
    //    target by the caller, so the admission limit and the budget cannot
    //    drift apart.
    //  - domain_members: the activation rule (the only sharing membership
    //    since the 2026-10-13 corpus cutover).
    //  - global_candidates / global_candidate_observations: the cross-project
    //    recurrence gate — a fact promoted to a global domain must have been
    //    observed independently by at least two DIFFERENT project identities.
    //  - profile_confirmations: the human gate for directive-shaped content.
    //    Unconfirmed entries never enter the injected pool.
    //  - baseline_state.profile_watermark / profile_m0_digest: the additive
    //    watermark and the m[0] content digest for the profile, so a new
    //    profile row rides the m[1] delta while a rewritten or retired one
    //    forces a HARD rebuild (deliberately unlike Magic Context, which kept
    //    serving a stale m[0] profile block).
    version: 8,
    up: (db) => {
      db.exec(`
        CREATE TABLE domains(
          domain_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK(kind IN ('user','org','machine')),
          enabled INTEGER NOT NULL DEFAULT 0,
          budget_tokens INTEGER NOT NULL,
          cap INTEGER NOT NULL,
          share_categories TEXT NOT NULL DEFAULT '["CONSTRAINTS"]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE domain_members(
          domain_id TEXT NOT NULL REFERENCES domains(domain_id) ON DELETE CASCADE,
          identity TEXT NOT NULL,
          added_at INTEGER NOT NULL,
          PRIMARY KEY(domain_id, identity)
        );
        CREATE INDEX domain_members_identity ON domain_members(identity);
        CREATE TABLE global_candidates(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          domain_id TEXT NOT NULL,
          content TEXT NOT NULL,
          normalized_hash TEXT NOT NULL,
          first_identity TEXT NOT NULL,
          session_id TEXT,
          compartment_start INTEGER,
          compartment_end INTEGER,
          distinct_identities INTEGER NOT NULL DEFAULT 1,
          observation_count INTEGER NOT NULL DEFAULT 1,
          state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected','expired')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX global_candidates_domain_hash ON global_candidates(domain_id, normalized_hash);
        CREATE INDEX global_candidates_state ON global_candidates(domain_id, state);
        CREATE TABLE global_candidate_observations(
          candidate_id INTEGER NOT NULL REFERENCES global_candidates(id) ON DELETE CASCADE,
          identity TEXT NOT NULL,
          session_id TEXT NOT NULL,
          compartment_start INTEGER,
          compartment_end INTEGER,
          observations INTEGER NOT NULL DEFAULT 1,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          PRIMARY KEY(candidate_id, identity, session_id)
        );
        CREATE INDEX global_observations_identity ON global_candidate_observations(identity);
        CREATE TABLE profile_confirmations(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contract_candidate_id INTEGER NOT NULL,
          question TEXT NOT NULL,
          content TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected')),
          created_at INTEGER NOT NULL,
          decided_at INTEGER
        );
        CREATE INDEX profile_confirmations_state ON profile_confirmations(state);
        ALTER TABLE baseline_state ADD COLUMN profile_watermark INTEGER;
        ALTER TABLE baseline_state ADD COLUMN profile_m0_digest TEXT;
      `)
    },
  },
  {
    // v9: what a global candidate will be published AS.
    //
    // v8 stored a candidate's content and hash but not its category, because the
    // only intended source was the historian's recurrence scan. Naming the
    // category up front matters for two reasons: the category decides whether
    // the row will be visible at all once published (per-domain allowlist), and
    // `source_memory_id` keeps the provenance so a reviewer can see which
    // project memory a candidate came from. Both are nullable: a candidate
    // created by the recurrence scan has no single source memory, and a human
    // promotion always has one.
    version: 9,
    up: (db) => {
      db.exec(`
        ALTER TABLE global_candidates ADD COLUMN category TEXT;
        ALTER TABLE global_candidates ADD COLUMN source_memory_id INTEGER;
      `)
    },
  },
  {
    // v10: the LLM domain classification that routes an auto-staged candidate
    // into machine or org — and, when classification fails, leaves the memory
    // at PROJECT level (nothing staged). `suggested_domain` and
    // `suggestion_reason` ride the candidate row so the review card can show
    // the classifier's verdict and the operator can overrule it (the card's
    // "publish to another domain" option). Both nullable: a human promotion or
    // a pre-v10 auto-stage has no suggestion.
    version: 10,
    up: (db) => {
      db.exec(`
        ALTER TABLE global_candidates ADD COLUMN suggested_domain TEXT;
        ALTER TABLE global_candidates ADD COLUMN suggestion_reason TEXT;
      `)
    },
  },
  {
    // v11: pending intentions (`ctx_note`).
    //
    // Magic Context's notes vocabulary, narrowed to the shape DSH can honor:
    // the upstream table carries the whole dreamer machinery (compiled_*,
    // check_status, surface_condition, anchor_block_id) because an external
    // checker polls it on a schedule. DSH has no cron and no out-of-band
    // checker, so smart notes would be a table nobody ever advances — this
    // version stores the half that pays for itself: a queue of "come back to
    // this" items with a status, an anchor message and a dismissal path, which
    // ctx_search can surface and ctx_note can retire.
    //
    // `type` is kept even though only 'session' is written today: the column is
    // what a future smart-note lane would filter on, and adding it later would
    // mean a second migration over the same rows for no gain. `status` mirrors
    // upstream's active|pending|ready|dismissed; only active/dismissed are
    // reachable without a checker, and the machine reads no meaning from the
    // others — they are just non-active.
    version: 11,
    up: (db) => {
      db.exec(`
        CREATE TABLE notes(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL DEFAULT 'session',
          status TEXT NOT NULL DEFAULT 'active',
          content TEXT NOT NULL,
          session_id TEXT,
          project_path TEXT,
          surface_condition TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          ready_at INTEGER,
          ready_reason TEXT,
          anchor_ordinal INTEGER
        );
        CREATE INDEX idx_notes_session_status ON notes(session_id, status);
        CREATE INDEX idx_notes_project_status ON notes(project_path, status);
        CREATE INDEX idx_notes_type_status ON notes(type, status);
      `)
    },
  },
  {
    version: 12,
    up: (db) => {
      // Smart notes: `surface_condition` and `ready_at` already exist from v11,
      // so the only new state is how many consecutive checks ERRORED. A plain
      // "condition is false" is progress and resets it; an error increments it,
      // so a note whose check is broken can be surfaced with a warning rather
      // than parking silently forever.
      db.exec('ALTER TABLE notes ADD COLUMN check_failure_count INTEGER NOT NULL DEFAULT 0')
    },
  },
  {
    // v13: background-task scheduling (`dream_schedule` + `dream_runs`).
    //
    // Nothing in this adapter ran on a clock before: every write was triggered
    // by a turn the user started. A scheduler needs two things that have to
    // survive a restart, because the whole point is running while nobody is
    // watching — the next due instant per task, and a record of what the last
    // run did. A restart must not re-fire a task it already ran today, so the
    // due instant is persisted rather than computed from process start.
    //
    // `project_path` is in the primary key: one machine holds many projects and
    // each keeps its own cadence. `next_due_at` is NULL for `''` (never) and for
    // an expression that can never fire (Feb 31) — the scheduler skips those
    // instead of retrying every tick.
    //
    // `consecutive_failures` drives backoff: a task that keeps failing must stop
    // being retried every minute, and the count is also what the dashboard shows
    // to explain why a task went quiet.
    version: 13,
    up: (db) => {
      // `IF NOT EXISTS` throughout: a real upgrade never re-runs a migration
      // (the `meta.schema_version` guard prevents it), but the migration is also
      // the schema definition that tooling and downgrade fixtures replay, and a
      // replayed `CREATE TABLE` must not abort the whole chain.
      db.exec(`
        CREATE TABLE IF NOT EXISTS dream_schedule(
          project_path TEXT NOT NULL,
          task TEXT NOT NULL,
          cron TEXT NOT NULL,
          next_due_at INTEGER,
          last_run_at INTEGER,
          last_status TEXT,
          last_error TEXT,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 1,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(project_path, task)
        );
        CREATE INDEX IF NOT EXISTS idx_dream_schedule_due ON dream_schedule(next_due_at);
        CREATE TABLE IF NOT EXISTS dream_runs(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_path TEXT NOT NULL,
          task TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          status TEXT NOT NULL CHECK(status IN ('running','ok','failed','skipped')),
          items_processed INTEGER NOT NULL DEFAULT 0,
          items_changed INTEGER NOT NULL DEFAULT 0,
          tokens_used INTEGER NOT NULL DEFAULT 0,
          summary TEXT,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_dream_runs_project_task ON dream_runs(project_path, task, started_at DESC);
      `)
    },
  },
  {
    // v14: NO SCHEMA CHANGE. Kept as a numbered placeholder.
    //
    // It was written to add `reviewed_at` to `user_memory_candidates`, and that
    // was a mistake worth recording: this migration runs against the ADAPTER
    // store (journal, compartments, dream_*), while the candidates table lives in
    // the upstream MEMORY store — a different file that this adapter reads but
    // never migrates. The ALTER found no table, the guard returned quietly, and
    // the version still advanced, so the change looked applied and never was.
    //
    // The queue-advance problem it was meant to solve is handled instead by a
    // cursor in the adapter's `meta` table (`profile:review:cursor`), which needs
    // no column and no cooperation from the upstream schema.
    version: 14,
    up: () => {
      /* no-op by design — see above */
    },
  },
  {
    // v15: per-session drain accounting — the rolling budget window and the
    // emergency latch. Both are derived from upstream mc-upstream a1ca346
    // (`protectedTailDrainWindowStartedAt` / `protectedTailDrainTokens` /
    // `emergencyDrainActive` / `historianDrainFailureAt`), which store them in
    // its `session_meta` table; this adapter keeps one row per session here.
    //
    // Why it must be persisted rather than held in memory: the budget is a
    // 10-minute window and the latch a 30-minute backstop. Both outlive a
    // process restart far more often than not, and an in-memory latch would
    // silently re-admit the drain exactly when the irreducible floor is what
    // keeps pressure high.
    //
    // `IF NOT EXISTS` matches v13: a migration chain replayed against a database
    // that was rewound by hand (the schema tests do exactly this) must not abort
    // on a table an earlier pass already created.
    version: 15,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS drain_state(
          session_id TEXT PRIMARY KEY,
          window_started_at INTEGER NOT NULL DEFAULT 0,
          spent_tokens INTEGER NOT NULL DEFAULT 0,
          latch_active_since INTEGER NOT NULL DEFAULT 0,
          failure_at INTEGER NOT NULL DEFAULT 0
        );
      `)
    },
  },
  {
    // v16: renderer format stamp for the composed baseline. Upstream gates a HARD
    // rebuild on `compartmentRenderEpoch` (inject-compartments.ts:1816): when the
    // renderer's output changes, a baseline composed by the old one must be
    // folded once. Without the stamp, changing how tiers are chosen (the decay
    // curve) left every existing baseline rendering at the old tiers forever —
    // the cached bytes still matched the cached bytes.
    //
    // `IF NOT EXISTS` is not available for ADD COLUMN in SQLite before 3.35 and
    // the guard here is the migration version itself; the schema tests rewind and
    // replay the chain, which walks each version exactly once.
    version: 16,
    up: (db) => {
      const columns = db.prepare('PRAGMA table_info(baseline_state)').all() as Array<{ name: string }>
      if (columns.some(column => column.name === 'render_epoch')) return
      db.exec('ALTER TABLE baseline_state ADD COLUMN render_epoch INTEGER NOT NULL DEFAULT 0')
    },
  },
  {
    // v17: the m[0] boundary is a compartment SEQUENCE, not a timestamp.
    //
    // Upstream marks it with `cachedM0MaxCompartmentSeq` (inject-compartments.ts:972)
    // and this adapter used `createdAt <= frozenAt`. Timestamps make the split
    // ambiguous exactly where it matters: two compartments created in the same
    // millisecond land on either side depending on iteration order, and a clock
    // step backwards moves compartments out of m[0] on the next render — a silent
    // rewrite of the frozen prefix, which is the one thing m[0] must not do.
    version: 17,
    up: (db) => {
      const columns = db.prepare('PRAGMA table_info(baseline_state)').all() as Array<{ name: string }>
      if (columns.some(column => column.name === 'max_compartment_id')) return
      db.exec('ALTER TABLE baseline_state ADD COLUMN max_compartment_id INTEGER NOT NULL DEFAULT 0')
    },
  },
  {
    // v18: the system-prompt fingerprint the m[0] baseline was composed under.
    //
    // Upstream keys a HARD fold on it (`system-prompt-hash.ts:739`): the system
    // prompt precedes every message, so when it changes the provider rewrites its
    // cache from that point onward no matter what the messages pass does — which
    // makes folding the baseline on the same turn free. Without the stamp the
    // adapter kept serving a prefix the provider had already invalidated.
    version: 18,
    up: (db) => {
      const columns = db.prepare('PRAGMA table_info(baseline_state)').all() as Array<{ name: string }>
      if (columns.some(column => column.name === 'system_hash')) return
      db.exec('ALTER TABLE baseline_state ADD COLUMN system_hash TEXT')
    },
  },
  {
    // v19: emergency arming, per session.
    //
    // Upstream keeps `needsEmergencyRecovery` + `emergencyRecoveryOrigin` beside
    // the detected limit (storage-meta-persisted.ts:2138). The pairing matters:
    // the emergency fail-closed gate refuses a request only when the session is
    // armed BY A PROVIDER OVERFLOW, so an origin-less flag may not abort. The
    // limit itself lives in `meta` keyed by provider+model, which also gives the
    // model-match rule for free — a limit detected on one model says nothing
    // about another.
    version: 19,
    up: (db) => {
      const columns = db.prepare('PRAGMA table_info(drain_state)').all() as Array<{ name: string }>
      if (columns.some(column => column.name === 'overflow_armed_at')) return
      db.exec(
        'ALTER TABLE drain_state ADD COLUMN overflow_armed_at INTEGER NOT NULL DEFAULT 0',
      )
      db.exec('ALTER TABLE drain_state ADD COLUMN overflow_origin TEXT')
    },
  },
]

/**
 * Per-session drain accounting (schema v15). Mirrors the four columns upstream
 * mc-upstream a1ca346 keeps in `session_meta`.
 *
 * All four are epoch ms or token counts; 0 always means "unset" so a missing
 * row and a cleared row are indistinguishable, which is what lets the latch and
 * the window be reset by writing zeros.
 */
export interface DrainStateRow {
  /** Epoch ms the rolling drain budget window opened; 0 = none. */
  readonly windowStartedAt: number
  /** Tokens reclaimed inside the current window. */
  readonly spentTokens: number
  /** Epoch ms the emergency latch engaged; 0 = released. */
  readonly latchActiveSince: number
  /** Epoch ms of the last failed drain run; 0 = none. */
  readonly failureAt: number
  /**
   * Epoch ms the session was armed for emergency recovery; 0 = unarmed.
   * Upstream `needsEmergencyRecovery` (storage-meta-persisted.ts:2142).
   */
  readonly overflowArmedAt?: number
  /**
   * Why it was armed. The fail-closed gate refuses a request only when the arming
   * came from a `provider_overflow` — an untyped (legacy) flag may not abort.
   */
  readonly overflowOrigin?: 'provider_overflow' | 'proactive_model_shrink'
}

export const EMPTY_DRAIN_STATE: DrainStateRow = {
  overflowArmedAt: 0,
  windowStartedAt: 0,
  spentTokens: 0,
  latchActiveSince: 0,
  failureAt: 0,
}

export class StoreAheadOfAdapterError extends Error {
  // Declared explicitly rather than as constructor parameter properties: the
  // scripts in scripts/ load this module with plain Node (type stripping), and
  // parameter properties are not erasable syntax. Keeping the class erasable
  // lets migration tooling reuse the real store instead of re-implementing its
  // SQL — one source of truth for the adapter schema.
  readonly dbVersion: number
  readonly adapterVersion: number

  constructor(dbVersion: number, adapterVersion: number) {
    super(
      `magic-context dsh adapter: store schema v${dbVersion} is newer than this build supports (v${adapterVersion}); `
        + 'update the adapter (or roll it back together with its database) before continuing',
    )
    this.name = 'StoreAheadOfAdapterError'
    this.dbVersion = dbVersion
    this.adapterVersion = adapterVersion
  }
}

function targetKey(target: TagTarget): { kind: string; id: string } {
  return target.kind === 'user-message'
    ? { kind: 'user-message', id: target.messageId }
    : { kind: 'tool-result', id: target.callId }
}

export function openStores(dataDir: string): AdapterStores {
  const dbPath = join(dataDir, 'dsh-magic-context.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  // Without a busy timeout every concurrent writer fails instantly with
  // SQLITE_BUSY instead of waiting. Two writers are real here: the host can
  // remount the plugin under HMR while an in-flight pass still holds the handle,
  // and a second agent session on the same machine shares this database. WAL
  // permits the concurrent readers either way; this is what makes the writers
  // queue instead of erroring. Same 5s ceiling SQLite recommends for desktop
  // workloads — long enough to ride out a pass, short enough not to hang a turn.
  db.exec('PRAGMA busy_timeout = 5000')
  let closed = false

  let persisted = 0
  const hasMetaTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()
  if (hasMetaTable !== undefined) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined
    persisted = row === undefined ? 0 : Number(row.value)
    if (!Number.isInteger(persisted) || persisted < 0) {
      db.close()
      throw new Error(`magic-context dsh adapter: invalid persisted schema version ${String(row?.value)}`)
    }
  }
  if (persisted > SCHEMA_VERSION) {
    db.close()
    throw new StoreAheadOfAdapterError(persisted, SCHEMA_VERSION)
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= persisted) continue
    db.exec('BEGIN')
    try {
      migration.up(db)
      db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('schema_version', String(migration.version))
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      db.close()
      throw error
    }
  }

  const allocateTag = (sessionId: string, target: TagTarget, now: number): number => {
    const { kind, id } = targetKey(target)
    const existing = db
      .prepare('SELECT tag_number FROM tags WHERE session_id = ? AND target_kind = ? AND target_id = ?')
      .get(sessionId, kind, id) as { tag_number: number } | undefined
    if (existing !== undefined) return existing.tag_number
    const insert = db.prepare(
      'INSERT INTO tags(session_id, target_kind, target_id, tag_number, created_at) VALUES(?, ?, ?, ?, ?)',
    )
    const bump = db.prepare(
      'INSERT INTO tag_counters(session_id, next_tag) VALUES(?, 2) ON CONFLICT(session_id) DO UPDATE SET next_tag = next_tag + 1 RETURNING next_tag - 1',
    )
    db.exec('BEGIN')
    try {
      const allocated = bump.get(sessionId) as { 'next_tag - 1': number } | undefined
      const tagNumber = allocated === undefined ? 1 : allocated['next_tag - 1']
      insert.run(sessionId, kind, id, tagNumber, now)
      db.exec('COMMIT')
      return tagNumber
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const getTag = (sessionId: string, target: TagTarget): number | undefined => {
    const { kind, id } = targetKey(target)
    const row = db
      .prepare('SELECT tag_number FROM tags WHERE session_id = ? AND target_kind = ? AND target_id = ?')
      .get(sessionId, kind, id) as { tag_number: number } | undefined
    return row?.tag_number
  }

  const usageColumns = 'session_id, seq, turn, step, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, recorded_at'
  const recordUsage = (record: UsageRecord): void => {
    db.exec('BEGIN')
    try {
      db.prepare(
        `INSERT OR IGNORE INTO usage_records(${usageColumns}) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.sessionId,
        record.seq,
        record.turn,
        record.step,
        record.provider,
        record.model,
        record.inputTokens ?? null,
        record.outputTokens ?? null,
        record.cacheReadTokens ?? null,
        record.cacheWriteTokens ?? null,
        record.recordedAt,
      )
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const listUsageSince = (since: number): UsageRecord[] =>
    (db.prepare(`SELECT * FROM usage_records WHERE recorded_at > ? ORDER BY recorded_at`).all(since) as Array<{
      session_id: string; seq: number; turn: number; step: number; provider: string; model: string
      input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null
      recorded_at: number
    }>).map(row => ({
      sessionId: row.session_id,
      seq: row.seq,
      turn: row.turn,
      step: row.step,
      provider: row.provider,
      model: row.model,
      inputTokens: row.input_tokens ?? undefined,
      outputTokens: row.output_tokens ?? undefined,
      cacheReadTokens: row.cache_read_tokens ?? undefined,
      cacheWriteTokens: row.cache_write_tokens ?? undefined,
      recordedAt: row.recorded_at,
    }))

  const listUsage = (sessionId: string): UsageRecord[] =>
    (db.prepare(`SELECT * FROM usage_records WHERE session_id = ? ORDER BY seq`).all(sessionId) as Array<{
      session_id: string; seq: number; turn: number; step: number; provider: string; model: string
      input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null
      recorded_at: number
    }>).map(row => ({
      sessionId: row.session_id,
      seq: row.seq,
      turn: row.turn,
      step: row.step,
      provider: row.provider,
      model: row.model,
      inputTokens: row.input_tokens ?? undefined,
      outputTokens: row.output_tokens ?? undefined,
      cacheReadTokens: row.cache_read_tokens ?? undefined,
      cacheWriteTokens: row.cache_write_tokens ?? undefined,
      recordedAt: row.recorded_at,
    }))

  const listTags = (sessionId: string): TagRecord[] =>
    (db.prepare('SELECT * FROM tags WHERE session_id = ? ORDER BY tag_number').all(sessionId) as Array<{
      session_id: string; target_kind: string; target_id: string; tag_number: number; created_at: number
    }>).map(row => ({
      sessionId: row.session_id,
      tagNumber: row.tag_number,
      target: row.target_kind === 'user-message'
        ? { kind: 'user-message', messageId: row.target_id }
        : { kind: 'tool-result', callId: row.target_id },
      createdAt: row.created_at,
    }))

  const latestUsage = (sessionId: string): UsageRecord | undefined => {
    const row = db.prepare(
      'SELECT * FROM usage_records WHERE session_id = ? ORDER BY seq DESC LIMIT 1',
    ).get(sessionId) as {
      session_id: string; seq: number; turn: number; step: number; provider: string; model: string
      input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null
      recorded_at: number
    } | undefined
    if (row === undefined) return undefined
    return {
      sessionId: row.session_id,
      seq: row.seq,
      turn: row.turn,
      step: row.step,
      provider: row.provider,
      model: row.model,
      inputTokens: row.input_tokens ?? undefined,
      outputTokens: row.output_tokens ?? undefined,
      cacheReadTokens: row.cache_read_tokens ?? undefined,
      cacheWriteTokens: row.cache_write_tokens ?? undefined,
      recordedAt: row.recorded_at,
    }
  }

  const workMetrics = (sessionId: string): WorkMetrics =>
    computeWorkMetrics(listUsage(sessionId).map(toAssistantUsageRow))

  /**
   * Cross-process lease, opened lazily on first use. Lazy because most
   * constructions (tests, drift checks) never touch it, and creating the table
   * is a write — opening eagerly would make every reader take a write lock.
   */
  let leaseInstance: CompartmentLease | undefined
  const compartmentLease = (options: { log?: (sessionId: string, message: string) => void } = {}): CompartmentLease => {
    leaseInstance ??= openCompartmentLease({ db: db as unknown as LeaseDatabase, ...options })
    return leaseInstance
  }

  const latestHistoryChangeAt = (sessionId: string): number | undefined => {
    try {
      const row = db.prepare(
        'SELECT MAX(t) AS t FROM ('
          + 'SELECT MAX(created_at) AS t FROM compartments WHERE session_id = ?'
          + ' UNION ALL SELECT MAX(updated_at) AS t FROM baseline_state WHERE session_id = ?)',
      ).get(sessionId, sessionId) as { t?: number | null } | undefined
      const value = row?.t
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    } catch {
      // A freshness probe must never fail the turn that asked for it.
      return undefined
    }
  }

  const getDrainState = (sessionId: string): DrainStateRow => {
    try {
      const row = db.prepare(
        'SELECT window_started_at, spent_tokens, latch_active_since, failure_at, '
          + 'overflow_armed_at, overflow_origin FROM drain_state WHERE session_id = ?',
      ).get(sessionId) as
        | {
          window_started_at?: number
          spent_tokens?: number
          latch_active_since?: number
          failure_at?: number
          overflow_armed_at?: number
          overflow_origin?: string | null
        }
        | undefined
      if (row === undefined) return EMPTY_DRAIN_STATE
      return {
        windowStartedAt: typeof row.window_started_at === 'number' ? row.window_started_at : 0,
        spentTokens: typeof row.spent_tokens === 'number' ? row.spent_tokens : 0,
        latchActiveSince: typeof row.latch_active_since === 'number' ? row.latch_active_since : 0,
        failureAt: typeof row.failure_at === 'number' ? row.failure_at : 0,
        overflowArmedAt: typeof row.overflow_armed_at === 'number' ? row.overflow_armed_at : 0,
        ...row.overflow_origin === 'provider_overflow' || row.overflow_origin === 'proactive_model_shrink'
          ? { overflowOrigin: row.overflow_origin }
          : {},
      }
    } catch {
      // Accounting must never fail the turn that asked for it. A neutral state
      // admits the pass, which is the pre-latch behaviour.
      return EMPTY_DRAIN_STATE
    }
  }

  const putDrainState = (sessionId: string, state: DrainStateRow): void => {
    db.prepare(
      'INSERT INTO drain_state(session_id, window_started_at, spent_tokens, latch_active_since, failure_at, '
        + 'overflow_armed_at, overflow_origin) '
        + 'VALUES(?, ?, ?, ?, ?, ?, ?) '
        + 'ON CONFLICT(session_id) DO UPDATE SET window_started_at = excluded.window_started_at, '
        + 'spent_tokens = excluded.spent_tokens, latch_active_since = excluded.latch_active_since, '
        + 'failure_at = excluded.failure_at, overflow_armed_at = excluded.overflow_armed_at, '
        + 'overflow_origin = excluded.overflow_origin',
    ).run(
      sessionId,
      state.windowStartedAt,
      state.spentTokens,
      state.latchActiveSince,
      state.failureAt,
      state.overflowArmedAt ?? 0,
      state.overflowOrigin ?? null,
    )
  }

  const queueDrop = (sessionId: string, tagNumber: number, now: number): void => {    db.prepare(
      'INSERT INTO pending_drops(session_id, tag_number, queued_at) VALUES(?, ?, ?) '
        + 'ON CONFLICT(session_id, tag_number) DO UPDATE SET queued_at = excluded.queued_at '
        + 'WHERE landed_event_seq IS NOT NULL',
    ).run(sessionId, tagNumber, now)
  }

  const listPendingDrops = (sessionId: string): number[] =>
    (db.prepare(
      'SELECT tag_number FROM pending_drops WHERE session_id = ? AND landed_event_seq IS NULL ORDER BY queued_at, tag_number',
    ).all(sessionId) as Array<{ tag_number: number }>).map(row => row.tag_number)

  const markDropLanded = (sessionId: string, tagNumber: number, landedEventSeq: number): void => {
    db.prepare(
      'UPDATE pending_drops SET landed_event_seq = ? WHERE session_id = ? AND tag_number = ?',
    ).run(landedEventSeq, sessionId, tagNumber)
  }

  /** Sentinel for {@link retireDrop}: "left the queue without landing". */
  const DROP_RETIRED = -1

  const retireDrop = (sessionId: string, tagNumber: number): void => {
    db.prepare(
      'UPDATE pending_drops SET landed_event_seq = ? WHERE session_id = ? AND tag_number = ? AND landed_event_seq IS NULL',
    ).run(DROP_RETIRED, sessionId, tagNumber)
  }

  interface CompartmentRow {
    session_id: string; compartment_id: number; created_at: number
    covered_start_seq: number; covered_end_seq: number; covered_seqs: string
    covered_tokens: number; importance: number
    tier_p1: string; tier_p2: string; tier_p3: string; tier_p4: string
    facts: string; events: string; baseline_epoch: number; landed_event_seq: number | null
    landed_reason: string | null; superseded: number
  }

  const toCompartment = (row: CompartmentRow): Compartment => ({
    sessionId: row.session_id,
    compartmentId: row.compartment_id,
    createdAt: row.created_at,
    coveredStartSeq: row.covered_start_seq,
    coveredEndSeq: row.covered_end_seq,
    coveredSeqs: JSON.parse(row.covered_seqs) as number[],
    coveredTokens: row.covered_tokens,
    importance: row.importance,
    tiers: { p1: row.tier_p1, p2: row.tier_p2, p3: row.tier_p3, p4: row.tier_p4 },
    facts: JSON.parse(row.facts) as MemoryFact[],
    events: JSON.parse(row.events) as string[],
    baselineEpoch: row.baseline_epoch,
    ...row.landed_event_seq === null ? {} : { landedEventSeq: row.landed_event_seq },
    ...row.landed_reason === null ? {} : { landedReason: row.landed_reason },
  })

  const allocateCompartment: AdapterStores['allocateCompartment'] = (
    sessionId,
    draft,
    covered,
    baselineEpoch,
    now,
  ) => {
    db.exec('BEGIN')
    try {
      const bumped = db.prepare(
        'INSERT INTO compartment_counters(session_id, next_compartment) VALUES(?, 2) '
          + 'ON CONFLICT(session_id) DO UPDATE SET next_compartment = next_compartment + 1 '
          + 'RETURNING next_compartment - 1',
      ).get(sessionId) as { 'next_compartment - 1': number } | undefined
      const compartmentId = bumped === undefined ? 1 : bumped['next_compartment - 1']
      db.prepare(
        'INSERT INTO compartments(session_id, compartment_id, created_at, covered_start_seq, covered_end_seq, '
          + 'covered_seqs, covered_tokens, importance, tier_p1, tier_p2, tier_p3, tier_p4, facts, events, baseline_epoch) '
          + 'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        sessionId,
        compartmentId,
        now,
        covered.startSeq,
        covered.endSeq,
        JSON.stringify([...covered.seqs]),
        covered.tokens,
        draft.importance,
        draft.tiers.p1,
        draft.tiers.p2,
        draft.tiers.p3,
        draft.tiers.p4,
        JSON.stringify([...draft.facts]),
        JSON.stringify([...draft.events]),
        baselineEpoch,
      )
      db.exec('COMMIT')
      return {
        sessionId,
        compartmentId,
        createdAt: now,
        coveredStartSeq: covered.startSeq,
        coveredEndSeq: covered.endSeq,
        coveredSeqs: [...covered.seqs],
        coveredTokens: covered.tokens,
        importance: draft.importance,
        tiers: draft.tiers,
        facts: [...draft.facts],
        events: [...draft.events],
        baselineEpoch,
      }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const listCompartments = (sessionId: string): Compartment[] =>
    (db.prepare('SELECT * FROM compartments WHERE session_id = ? ORDER BY compartment_id')
      .all(sessionId) as unknown as CompartmentRow[]).map(toCompartment)

  const listUnlandedCompartments = (sessionId: string): Compartment[] =>
    (db.prepare('SELECT * FROM compartments WHERE session_id = ? AND landed_event_seq IS NULL '
        + 'AND superseded = 0 AND landed_reason IS NULL ORDER BY compartment_id')
      .all(sessionId) as unknown as CompartmentRow[]).map(toCompartment)

  const markCompartmentLanded = (sessionId: string, compartmentId: number, landedEventSeq: number): void => {
    db.prepare(
      'UPDATE compartments SET landed_event_seq = ? WHERE session_id = ? AND compartment_id = ?',
    ).run(landedEventSeq, sessionId, compartmentId)
  }

  const markCompartmentRejected = (sessionId: string, compartmentId: number, reason: string): void => {
    db.prepare(
      'UPDATE compartments SET landed_reason = ? WHERE session_id = ? AND compartment_id = ? '
        + 'AND landed_event_seq IS NULL',
    ).run(reason, sessionId, compartmentId)
  }

  const supersedeCompartment = (sessionId: string, compartmentId: number, reason: string): void => {
    db.prepare(
      'UPDATE compartments SET superseded = 1, landed_reason = ? WHERE session_id = ? AND compartment_id = ?',
    ).run(reason, sessionId, compartmentId)
  }

  const replaceCompartmentDraft = (sessionId: string, compartmentId: number, draft: CompartmentDraft): void => {
    db.prepare(
      'UPDATE compartments SET importance = ?, tier_p1 = ?, tier_p2 = ?, tier_p3 = ?, tier_p4 = ?, facts = ?, events = ? '
        + 'WHERE session_id = ? AND compartment_id = ?',
    ).run(
      draft.importance,
      draft.tiers.p1,
      draft.tiers.p2,
      draft.tiers.p3,
      draft.tiers.p4,
      JSON.stringify([...draft.facts]),
      JSON.stringify([...draft.events]),
      sessionId,
      compartmentId,
    )
  }

  const coveredSeqs = (sessionId: string): Set<number> => {
    // Superseded drafts release their claims: their span (originals plus the
    // nodes that drifted in) goes back into the historian's eligibility pool.
    const rows = db.prepare('SELECT covered_seqs FROM compartments WHERE session_id = ? AND superseded = 0')
      .all(sessionId) as Array<{ covered_seqs: string }>
    const seqs = new Set<number>()
    for (const row of rows) {
      for (const seq of JSON.parse(row.covered_seqs) as number[]) seqs.add(seq)
    }
    return seqs
  }

  interface BaselineRow {
    session_id: string; epoch: number; node_seq: number | null
    provider: string | null; model: string | null; frozen_at: number
    memories_digest: string | null; max_memory_id: number | null
    max_memory_mutation_id: number | null; project_epoch_fingerprint: string | null
    profile_watermark: number | null; profile_m0_digest: string | null
    render_epoch: number | null
    max_compartment_id: number | null
    system_hash: string | null
    updated_at: number
  }

  const baselineState = (sessionId: string): BaselineState | undefined => {
    const row = db.prepare('SELECT * FROM baseline_state WHERE session_id = ?').get(sessionId) as
      | BaselineRow
      | undefined
    if (row === undefined) return undefined
    return {
      sessionId: row.session_id,
      epoch: row.epoch,
      ...row.node_seq === null ? {} : { nodeSeq: row.node_seq },
      ...row.provider === null ? {} : { provider: row.provider },
      ...row.model === null ? {} : { model: row.model },
      frozenAt: row.frozen_at,
      ...row.memories_digest === null ? {} : { memoriesDigest: row.memories_digest },
      ...row.max_memory_id === null ? {} : { maxMemoryId: row.max_memory_id },
      ...row.max_memory_mutation_id === null ? {} : { maxMemoryMutationId: row.max_memory_mutation_id },
      ...row.project_epoch_fingerprint === null ? {} : { projectEpochFingerprint: row.project_epoch_fingerprint },
      ...row.profile_watermark === null ? {} : { profileWatermark: row.profile_watermark },
      ...row.profile_m0_digest === null ? {} : { profileM0Digest: row.profile_m0_digest },
      ...row.render_epoch === null || row.render_epoch === 0 ? {} : { renderEpoch: row.render_epoch },
      ...row.max_compartment_id === null || row.max_compartment_id === 0
        ? {}
        : { maxCompartmentId: row.max_compartment_id },
      ...row.system_hash === null ? {} : { systemHash: row.system_hash },
      updatedAt: row.updated_at,
    }
  }

  const saveBaselineState = (state: BaselineState): void => {
    db.prepare(
      'INSERT INTO baseline_state(session_id, epoch, node_seq, provider, model, frozen_at, memories_digest, '
        + 'max_memory_id, max_memory_mutation_id, project_epoch_fingerprint, profile_watermark, profile_m0_digest, render_epoch, max_compartment_id, system_hash, updated_at) '
        + 'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
        + 'ON CONFLICT(session_id) DO UPDATE SET epoch = excluded.epoch, node_seq = excluded.node_seq, '
        + 'provider = excluded.provider, model = excluded.model, frozen_at = excluded.frozen_at, '
        + 'memories_digest = excluded.memories_digest, max_memory_id = excluded.max_memory_id, '
        + 'max_memory_mutation_id = excluded.max_memory_mutation_id, '
        + 'project_epoch_fingerprint = excluded.project_epoch_fingerprint, '
        + 'profile_watermark = excluded.profile_watermark, '
        + 'profile_m0_digest = excluded.profile_m0_digest, render_epoch = excluded.render_epoch, '
        + 'max_compartment_id = excluded.max_compartment_id, system_hash = excluded.system_hash, '
        + 'updated_at = excluded.updated_at',
    ).run(
      state.sessionId,
      state.epoch,
      state.nodeSeq ?? null,
      state.provider ?? null,
      state.model ?? null,
      state.frozenAt,
      state.memoriesDigest ?? null,
      state.maxMemoryId ?? null,
      state.maxMemoryMutationId ?? null,
      state.projectEpochFingerprint ?? null,
      state.profileWatermark ?? null,
      state.profileM0Digest ?? null,
      state.renderEpoch ?? 0,
      state.maxCompartmentId ?? 0,
      state.systemHash ?? null,
      state.updatedAt,
    )
  }

  // ---- schema v8: global domains ------------------------------------------
  //
  // `domain_id` IS the provider identity used in the shared store (for example
  // `dir:global:org`), so activation needs no second mapping: the row that says
  // "this domain exists" carries the exact `project_path` its memories live
  // under. The `kind` column is the closed three-value label used for
  // presentation, budgets and policy.

  interface DomainDbRow {
    domain_id: string; kind: string; enabled: number
    budget_tokens: number; cap: number; share_categories: string
    created_at: number; updated_at: number
  }

  const toDomain = (row: DomainDbRow): DomainRow => ({
    domainId: row.domain_id,
    kind: row.kind as DomainKind,
    enabled: row.enabled !== 0,
    budgetTokens: row.budget_tokens,
    cap: row.cap,
    shareCategories: parseShareCategories(row.share_categories),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })

  const upsertDomain = (
    domain: {
      domainId: string
      kind: DomainKind
      enabled: boolean
      budgetTokens: number
      cap: number
      shareCategories: readonly string[]
    },
    now: number,
  ): void => {
    // serializeShareCategories rejects an unknown category here, at the write,
    // rather than letting a row become permanently invisible later.
    const shareCategories = serializeShareCategories(domain.shareCategories)
    db.prepare(
      'INSERT INTO domains(domain_id, kind, enabled, budget_tokens, cap, share_categories, created_at, updated_at) '
        + 'VALUES(?, ?, ?, ?, ?, ?, ?, ?) '
        + 'ON CONFLICT(domain_id) DO UPDATE SET kind = excluded.kind, enabled = excluded.enabled, '
        + 'budget_tokens = excluded.budget_tokens, cap = excluded.cap, '
        + 'share_categories = excluded.share_categories, updated_at = excluded.updated_at',
    ).run(domain.domainId, domain.kind, domain.enabled ? 1 : 0, domain.budgetTokens, domain.cap, shareCategories, now, now)
  }

  const listDomains = (): DomainRow[] =>
    (db.prepare('SELECT * FROM domains ORDER BY kind, domain_id').all() as unknown as DomainDbRow[]).map(toDomain)

  const getDomain = (domainId: string): DomainRow | undefined => {
    const row = db.prepare('SELECT * FROM domains WHERE domain_id = ?').get(domainId) as DomainDbRow | undefined
    return row === undefined ? undefined : toDomain(row)
  }

  const setDomainEnabled = (domainId: string, enabled: boolean, now: number): void => {
    db.prepare('UPDATE domains SET enabled = ?, updated_at = ? WHERE domain_id = ?').run(enabled ? 1 : 0, now, domainId)
  }

  const addDomainMember = (domainId: string, identity: string, now: number): void => {
    db.prepare(
      'INSERT INTO domain_members(domain_id, identity, added_at) VALUES(?, ?, ?) '
        + 'ON CONFLICT(domain_id, identity) DO NOTHING',
    ).run(domainId, identity, now)
  }

  const removeDomainMember = (domainId: string, identity: string): void => {
    db.prepare('DELETE FROM domain_members WHERE domain_id = ? AND identity = ?').run(domainId, identity)
  }

  const listDomainMembers = (domainId?: string): DomainMemberRow[] => {
    const rows = (domainId === undefined
      ? db.prepare('SELECT * FROM domain_members ORDER BY domain_id, identity').all()
      : db.prepare('SELECT * FROM domain_members WHERE domain_id = ? ORDER BY identity').all(domainId)) as unknown as Array<{
      domain_id: string; identity: string; added_at: number
    }>
    return rows.map(row => ({ domainId: row.domain_id, identity: row.identity, addedAt: row.added_at }))
  }

  const activeDomainIdentities = (
    identity: string,
  ): Array<{ domainId: string; kind: DomainKind; identity: string }> => {
    const rows = db.prepare(
      'SELECT d.domain_id AS domain_id, d.kind AS kind FROM domain_members m '
        + 'JOIN domains d ON d.domain_id = m.domain_id '
        + 'WHERE m.identity = ? AND d.enabled = 1 ORDER BY d.kind, d.domain_id',
    ).all(identity) as unknown as Array<{ domain_id: string; kind: string }>
    return rows.map(row => ({ domainId: row.domain_id, kind: row.kind as DomainKind, identity: row.domain_id }))
  }

  interface GlobalCandidateDbRow {
    id: number; domain_id: string; content: string; normalized_hash: string; first_identity: string
    session_id: string | null; compartment_start: number | null; compartment_end: number | null
    distinct_identities: number; observation_count: number; state: string
    category: string | null; source_memory_id: number | null
    suggested_domain: string | null; suggestion_reason: string | null
    created_at: number; updated_at: number
  }

  const toGlobalCandidate = (row: GlobalCandidateDbRow): GlobalCandidateRow => ({
    id: row.id,
    domainId: row.domain_id,
    content: row.content,
    normalizedHash: row.normalized_hash,
    firstIdentity: row.first_identity,
    ...row.session_id === null ? {} : { sessionId: row.session_id },
    ...row.compartment_start === null ? {} : { compartmentStart: row.compartment_start },
    ...row.compartment_end === null ? {} : { compartmentEnd: row.compartment_end },
    distinctIdentities: row.distinct_identities,
    observationCount: row.observation_count,
    ...row.category === null ? {} : { category: row.category },
    ...row.source_memory_id === null ? {} : { sourceMemoryId: row.source_memory_id },
    ...row.suggested_domain === null ? {} : { suggestedDomain: row.suggested_domain as 'machine' | 'org' },
    ...row.suggestion_reason === null ? {} : { suggestionReason: row.suggestion_reason },
    state: row.state as GlobalCandidateRow['state'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })

  const getGlobalCandidateByHash = (domainId: string, normalizedHash: string): GlobalCandidateRow | undefined => {
    const row = db
      .prepare('SELECT * FROM global_candidates WHERE domain_id = ? AND normalized_hash = ?')
      .get(domainId, normalizedHash) as GlobalCandidateDbRow | undefined
    return row === undefined ? undefined : toGlobalCandidate(row)
  }

  /** Recompute the recurrence weight from the observation rows (never from a counter the caller passes). */
  const refreshCandidateWeight = (candidateId: number, now: number): void => {
    db.prepare(
      'UPDATE global_candidates SET '
        + 'distinct_identities = (SELECT COUNT(*) FROM global_candidate_observations WHERE candidate_id = ?), '
        + 'observation_count = (SELECT COALESCE(SUM(observations), 0) FROM global_candidate_observations WHERE candidate_id = ?), '
        + 'updated_at = ? WHERE id = ?',
    ).run(candidateId, candidateId, now, candidateId)
  }

  const upsertGlobalCandidate = (
    candidate: {
      domainId: string
      content: string
      normalizedHash: string
      firstIdentity: string
      sessionId?: string
      compartmentStart?: number
      compartmentEnd?: number
      category?: string
      sourceMemoryId?: number
      suggestedDomain?: 'machine' | 'org'
      suggestionReason?: string
    },
    now: number,
  ): GlobalCandidateRow => {
    db.prepare(
      'INSERT INTO global_candidates(domain_id, content, normalized_hash, first_identity, session_id, '
        + 'compartment_start, compartment_end, distinct_identities, observation_count, category, source_memory_id, '
        + 'suggested_domain, suggestion_reason, '
        + "state, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 'pending', ?, ?) "
        + 'ON CONFLICT(domain_id, normalized_hash) DO UPDATE SET content = excluded.content, '
        // A later sighting that does not carry the metadata must not erase it.
        + 'category = COALESCE(excluded.category, global_candidates.category), '
        + 'source_memory_id = COALESCE(excluded.source_memory_id, global_candidates.source_memory_id), '
        + 'suggested_domain = COALESCE(excluded.suggested_domain, global_candidates.suggested_domain), '
        + 'suggestion_reason = COALESCE(excluded.suggestion_reason, global_candidates.suggestion_reason), '
        + 'updated_at = excluded.updated_at, '
        + "state = CASE WHEN global_candidates.state = 'expired' THEN 'pending' ELSE global_candidates.state END",
    ).run(
      candidate.domainId,
      candidate.content,
      candidate.normalizedHash,
      candidate.firstIdentity,
      candidate.sessionId ?? null,
      candidate.compartmentStart ?? null,
      candidate.compartmentEnd ?? null,
      candidate.category ?? null,
      candidate.sourceMemoryId ?? null,
      candidate.suggestedDomain ?? null,
      candidate.suggestionReason ?? null,
      now,
      now,
    )
    const row = getGlobalCandidateByHash(candidate.domainId, candidate.normalizedHash)
    if (row === undefined) throw new Error('magic-context dsh adapter: global candidate upsert did not land')
    return row
  }

  const getGlobalCandidate = (id: number): GlobalCandidateRow | undefined => {
    const row = db.prepare('SELECT * FROM global_candidates WHERE id = ?').get(id) as
      | GlobalCandidateDbRow
      | undefined
    return row === undefined ? undefined : toGlobalCandidate(row)
  }

  const listGlobalCandidates = (
    filter?: { domainId?: string; state?: GlobalCandidateRow['state'] },
  ): GlobalCandidateRow[] => {
    const where: string[] = []
    const params: Array<string | number> = []
    if (filter?.domainId !== undefined) {
      where.push('domain_id = ?')
      params.push(filter.domainId)
    }
    if (filter?.state !== undefined) {
      where.push('state = ?')
      params.push(filter.state)
    }
    const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`
    const rows = db
      .prepare(`SELECT * FROM global_candidates${clause} ORDER BY updated_at DESC, id DESC`)
      .all(...params) as unknown as GlobalCandidateDbRow[]
    return rows.map(toGlobalCandidate)
  }

  const setGlobalCandidateState = (id: number, state: GlobalCandidateRow['state'], now: number): void => {
    db.prepare('UPDATE global_candidates SET state = ?, updated_at = ? WHERE id = ?').run(state, now, id)
  }

  const recordCandidateObservation = (
    observation: {
      candidateId: number
      identity: string
      sessionId: string
      compartmentStart?: number
      compartmentEnd?: number
    },
    now: number,
  ): void => {
    db.exec('BEGIN')
    try {
      db.prepare(
        'INSERT INTO global_candidate_observations(candidate_id, identity, session_id, compartment_start, '
          + 'compartment_end, observations, first_seen_at, last_seen_at) VALUES(?, ?, ?, ?, ?, 1, ?, ?) '
          + 'ON CONFLICT(candidate_id, identity, session_id) DO UPDATE SET observations = observations + 1, '
          + 'last_seen_at = excluded.last_seen_at',
      ).run(
        observation.candidateId,
        observation.identity,
        observation.sessionId,
        observation.compartmentStart ?? null,
        observation.compartmentEnd ?? null,
        now,
        now,
      )
      refreshCandidateWeight(observation.candidateId, now)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const listCandidateObservations = (candidateId: number): CandidateObservationRow[] =>
    (db.prepare(
      'SELECT * FROM global_candidate_observations WHERE candidate_id = ? ORDER BY identity, session_id',
    ).all(candidateId) as unknown as Array<{
      candidate_id: number; identity: string; session_id: string
      compartment_start: number | null; compartment_end: number | null
      observations: number; first_seen_at: number; last_seen_at: number
    }>).map(row => ({
      candidateId: row.candidate_id,
      identity: row.identity,
      sessionId: row.session_id,
      ...row.compartment_start === null ? {} : { compartmentStart: row.compartment_start },
      ...row.compartment_end === null ? {} : { compartmentEnd: row.compartment_end },
      observations: row.observations,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    }))

  interface ProfileConfirmationDbRow {
    id: number; contract_candidate_id: number; question: string; content: string
    state: string; created_at: number; decided_at: number | null
  }

  const toProfileConfirmation = (row: ProfileConfirmationDbRow): ProfileConfirmationRow => ({
    id: row.id,
    contractCandidateId: row.contract_candidate_id,
    question: row.question,
    content: row.content,
    state: row.state as ProfileConfirmationRow['state'],
    createdAt: row.created_at,
    ...row.decided_at === null ? {} : { decidedAt: row.decided_at },
  })

  const enqueueProfileConfirmation = (
    input: { contractCandidateId: number; question: string; content: string },
    now: number,
  ): ProfileConfirmationRow => {
    // Idempotent per pending candidate: a retried historian pass must not
    // produce a second question for the same observation.
    const existing = db.prepare(
      "SELECT * FROM profile_confirmations WHERE contract_candidate_id = ? AND state = 'pending'",
    ).get(input.contractCandidateId) as ProfileConfirmationDbRow | undefined
    if (existing !== undefined) return toProfileConfirmation(existing)
    const inserted = db.prepare(
      "INSERT INTO profile_confirmations(contract_candidate_id, question, content, state, created_at) "
        + "VALUES(?, ?, ?, 'pending', ?) RETURNING *",
    ).get(input.contractCandidateId, input.question, input.content, now) as unknown as ProfileConfirmationDbRow
    return toProfileConfirmation(inserted)
  }

  const listProfileConfirmations = (state?: ProfileConfirmationRow['state']): ProfileConfirmationRow[] => {
    const rows = (state === undefined
      ? db.prepare('SELECT * FROM profile_confirmations ORDER BY created_at, id').all()
      : db.prepare('SELECT * FROM profile_confirmations WHERE state = ? ORDER BY created_at, id').all(state)) as unknown as ProfileConfirmationDbRow[]
    return rows.map(toProfileConfirmation)
  }

  const decideProfileConfirmation = (id: number, state: 'approved' | 'rejected', now: number): void => {
    db.prepare('UPDATE profile_confirmations SET state = ?, decided_at = ? WHERE id = ?').run(state, now, id)
  }

  interface NoteDbRow {
    id: number; type: string; status: string; content: string
    session_id: string | null; project_path: string | null; surface_condition: string | null
    created_at: number; updated_at: number; ready_at: number | null
    ready_reason: string | null; anchor_ordinal: number | null
    /** v12: consecutive ERRORED checks (a false condition does not count). */
    check_failure_count: number
  }

  const toNote = (row: NoteDbRow): NoteRow => ({
    id: row.id,
    type: row.type as NoteRow['type'],
    status: row.status as NoteRow['status'],
    content: row.content,
    ...row.session_id === null ? {} : { sessionId: row.session_id },
    ...row.project_path === null ? {} : { projectPath: row.project_path },
    ...row.surface_condition === null ? {} : { surfaceCondition: row.surface_condition },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...row.ready_at === null ? {} : { readyAt: row.ready_at },
    ...row.ready_reason === null ? {} : { readyReason: row.ready_reason },
    ...row.anchor_ordinal === null ? {} : { anchorOrdinal: row.anchor_ordinal },
    ...row.check_failure_count === undefined || row.check_failure_count === null
      ? {}
      : { checkFailureCount: row.check_failure_count },
  })

  const createNote: AdapterStores['createNote'] = (input, now) => {
    const smart = input.surfaceCondition !== undefined
    const row = db.prepare(
      'INSERT INTO notes(type, status, content, session_id, project_path, created_at, updated_at, '
        + 'anchor_ordinal, surface_condition, ready_at) '
        + 'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
    ).get(
      // A smart note is a project-scoped row waiting on an external check; a
      // plain note is an active session intention. Keeping the type distinct
      // means `listNotes({status:'open'})` still shows only real intentions.
      input.type ?? (smart ? 'smart' : 'session'),
      // A smart note starts parked, not active: its content is not actionable
      // until the condition holds.
      smart ? 'pending' : 'active',
      input.content,
      input.sessionId ?? null,
      input.projectPath ?? null,
      now,
      now,
      input.anchorOrdinal ?? null,
      input.surfaceCondition ?? null,
      input.nextCheckAt ?? null,
    ) as unknown as NoteDbRow
    return toNote(row)
  }

  const getNote = (id: number): NoteRow | undefined => {
    const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteDbRow | undefined
    return row === undefined ? undefined : toNote(row)
  }

  const listNotes: AdapterStores['listNotes'] = (filter) => {
    const clauses: string[] = []
    const parameters: Array<string | number> = []
    if (filter.status === 'open') {
      // "Open" is the read view's default: everything still worth reading.
      //  - `active`  a plain note, still a live intention;
      //  - `ready`   a smart note whose condition came true — the whole reason it
      //              was parked, so it must not be hidden here;
      //  - `pending` is deliberately EXCLUDED: a parked note is not actionable
      //              yet, and listing it would spend attention on a reminder
      //              that cannot be acted on.
      clauses.push("status IN ('active', 'ready')")
    } else if (filter.status !== undefined) {
      clauses.push('status = ?')
      parameters.push(filter.status)
    }
    // Session scope and project scope are alternatives, not a conjunction: a
    // session's own notes belong to it, and a project's notes survive across
    // sessions of the same project, so either match is relevant.
    const scopes: string[] = []
    if (filter.sessionId !== undefined) {
      scopes.push('session_id = ?')
      parameters.push(filter.sessionId)
    }
    if (filter.projectPath !== undefined) {
      scopes.push('project_path = ?')
      parameters.push(filter.projectPath)
    }
    if (scopes.length > 0) clauses.push(`(${scopes.join(' OR ')})`)
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    const limit = filter.limit === undefined ? 25 : Math.max(1, Math.min(100, filter.limit))
    // OFFSET without a deterministic ORDER BY would page over a shifting window,
    // so the ordering above is part of this contract, not decoration.
    const offset = filter.offset === undefined ? 0 : Math.max(0, filter.offset)
    const rows = db.prepare(
      `SELECT * FROM notes${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).all(...parameters, limit, offset) as unknown as NoteDbRow[]
    return rows.map(toNote)
  }

  const updateNote: AdapterStores['updateNote'] = (id, content, now) => {
    const row = db.prepare(
      'UPDATE notes SET content = ?, updated_at = ? WHERE id = ? RETURNING *',
    ).get(content, now, id) as NoteDbRow | undefined
    return row === undefined ? undefined : toNote(row)
  }

  const retireNotes: AdapterStores['retireNotes'] = (ids, mode, now) => {
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(', ')
    const result = mode === 'dismiss'
      ? db.prepare(`UPDATE notes SET status = 'dismissed', updated_at = ? WHERE id IN (${placeholders})`).run(now, ...ids)
      : db.prepare(`DELETE FROM notes WHERE id IN (${placeholders})`).run(...ids)
    return Number(result.changes)
  }

  const listDueSurfaceChecks: AdapterStores['listDueSurfaceChecks'] = (now, limit) => {
    // `ready_at` doubles as the next-check deadline for a parked smart note:
    // the column is unused while the note is pending, and reusing it keeps the
    // schema at v11 (no migration for a feature that is purely additive).
    const rows = db.prepare(
      "SELECT * FROM notes WHERE status = 'pending' AND surface_condition IS NOT NULL "
        + 'AND (ready_at IS NULL OR ready_at <= ?) '
        + 'ORDER BY ready_at IS NULL DESC, ready_at ASC, id ASC LIMIT ?',
    ).all(now, Math.max(1, Math.min(100, limit ?? 25))) as unknown as NoteDbRow[]
    return rows.map(toNote)
  }

  const recordSurfaceCheck: AdapterStores['recordSurfaceCheck'] = (input, now) => {
    const existing = db.prepare('SELECT * FROM notes WHERE id = ?').get(input.id) as NoteDbRow | undefined
    if (existing === undefined) return undefined
    const failures = Number(existing.check_failure_count) || 0
    if (input.met) {
      const row = db.prepare(
        "UPDATE notes SET status = 'ready', ready_at = ?, ready_reason = ?, updated_at = ?, "
          + 'check_failure_count = 0 WHERE id = ? RETURNING *',
      ).get(now, input.reason ?? 'the condition holds', now, input.id) as unknown as NoteDbRow
      return toNote(row)
    }
    const row = db.prepare(
      'UPDATE notes SET updated_at = ?, ready_at = ?, check_failure_count = ? WHERE id = ? RETURNING *',
    ).get(
      now,
      input.nextCheckAt ?? now + 60_000,
      // A false condition is progress, not a failure: only an ERROR increments
      // the counter, so a note waiting on a genuinely false condition never
      // looks broken.
      input.failed === true ? failures + 1 : 0,
      input.id,
    ) as unknown as NoteDbRow
    return toNote(row)
  }

  const pruneNotes = (before: number): number => {
    const result = db.prepare("DELETE FROM notes WHERE status = 'dismissed' AND updated_at < ?").run(before)
    return Number(result.changes)
  }

  // ── Background tasks (v13) ─────────────────────────────────────────────────

  interface DreamScheduleDbRow {
    project_path: string; task: string; cron: string
    next_due_at: number | null; last_run_at: number | null
    last_status: string | null; last_error: string | null
    consecutive_failures: number; enabled: number; updated_at: number
  }

  interface DreamRunDbRow {
    id: number; project_path: string; task: string
    started_at: number; finished_at: number | null; status: string
    items_processed: number; items_changed: number; tokens_used: number
    summary: string | null; error: string | null
  }

  const toDreamSchedule = (row: DreamScheduleDbRow): DreamScheduleRow => ({
    projectPath: row.project_path,
    task: row.task,
    cron: row.cron,
    ...row.next_due_at === null ? {} : { nextDueAt: row.next_due_at },
    ...row.last_run_at === null ? {} : { lastRunAt: row.last_run_at },
    ...row.last_status === null ? {} : { lastStatus: row.last_status as DreamRunStatus },
    ...row.last_error === null ? {} : { lastError: row.last_error },
    consecutiveFailures: row.consecutive_failures,
    // Stored as 0/1 for SQLite's benefit; the interface stays boolean so no
    // caller has to remember which way the integer points.
    enabled: row.enabled !== 0,
    updatedAt: row.updated_at,
  })

  const toDreamRun = (row: DreamRunDbRow): DreamRunRow => ({
    id: row.id,
    projectPath: row.project_path,
    task: row.task,
    startedAt: row.started_at,
    ...row.finished_at === null ? {} : { finishedAt: row.finished_at },
    status: row.status as DreamRunStatus,
    itemsProcessed: row.items_processed,
    itemsChanged: row.items_changed,
    tokensUsed: row.tokens_used,
    ...row.summary === null ? {} : { summary: row.summary },
    ...row.error === null ? {} : { error: row.error },
  })

  const getDreamSchedule = (projectPath: string, task: string): DreamScheduleRow | undefined => {
    const row = db.prepare('SELECT * FROM dream_schedule WHERE project_path = ? AND task = ?')
      .get(projectPath, task) as DreamScheduleDbRow | undefined
    return row === undefined ? undefined : toDreamSchedule(row)
  }

  const listDreamSchedules = (projectPath: string): DreamScheduleRow[] =>
    (db.prepare('SELECT * FROM dream_schedule WHERE project_path = ? ORDER BY task')
      .all(projectPath) as unknown as DreamScheduleDbRow[]).map(toDreamSchedule)

  const listDreamProjects = (): string[] =>
    (db.prepare('SELECT DISTINCT project_path FROM dream_schedule ORDER BY project_path').all() as unknown as Array<{ project_path: string }>)
      .map(row => row.project_path)

  const upsertDreamSchedule = (row: DreamScheduleRow): void => {
    db.prepare(
      'INSERT INTO dream_schedule(project_path, task, cron, next_due_at, last_run_at, last_status, '
        + 'last_error, consecutive_failures, enabled, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
        + 'ON CONFLICT(project_path, task) DO UPDATE SET cron = excluded.cron, '
        + 'next_due_at = excluded.next_due_at, last_run_at = excluded.last_run_at, '
        + 'last_status = excluded.last_status, last_error = excluded.last_error, '
        + 'consecutive_failures = excluded.consecutive_failures, enabled = excluded.enabled, '
        + 'updated_at = excluded.updated_at',
    ).run(
      row.projectPath,
      row.task,
      row.cron,
      row.nextDueAt ?? null,
      row.lastRunAt ?? null,
      row.lastStatus ?? null,
      row.lastError ?? null,
      row.consecutiveFailures,
      row.enabled ? 1 : 0,
      row.updatedAt,
    )
  }

  const listDueDreamTasks = (now: number, limit?: number): DreamScheduleRow[] =>
    (db.prepare(
      'SELECT * FROM dream_schedule WHERE enabled = 1 AND next_due_at IS NOT NULL AND next_due_at <= ? '
        + 'ORDER BY next_due_at ASC, task ASC LIMIT ?',
    // No practical cap by default. Upstream's `planDueTasks`
    // (dreamer/task-scheduler.ts:258) collects EVERY due task for the project and
    // runs them; this table spans all projects, and the old default of 20 against
    // 65 rows meant the same short-interval tasks (auto-stage, every 90 s) always
    // occupied the window while `verify` (every 2 h) never got a slot — measured
    // 2026-11-19: verify last ran at 14:29, was due at 16:27, and 16:32 ran
    // auto-stage again. A caller that wants a bound can still pass `limit`.
    ).all(now, Math.max(1, Math.min(1_000, limit ?? 1_000))) as unknown as DreamScheduleDbRow[]).map(toDreamSchedule)

  const recordDreamRun: AdapterStores['recordDreamRun'] = (input) => {
    // Both writes in one transaction: a crash between them would leave a task
    // that ran but is still due, which is the double-fire this table exists to
    // prevent. The run row is the history; the schedule row is the clock.
    db.exec('BEGIN')
    try {
      db.prepare(
        'INSERT INTO dream_runs(project_path, task, started_at, finished_at, status, '
          + 'items_processed, items_changed, tokens_used, summary, error) '
          + 'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        input.projectPath,
        input.task,
        input.startedAt,
        input.finishedAt,
        input.status,
        input.itemsProcessed ?? 0,
        input.itemsChanged ?? 0,
        input.tokensUsed ?? 0,
        input.summary ?? null,
        input.error ?? null,
      )
      db.prepare(
        'UPDATE dream_schedule SET next_due_at = ?, last_run_at = ?, last_status = ?, last_error = ?, '
          + 'consecutive_failures = ?, updated_at = ? WHERE project_path = ? AND task = ?',
      ).run(
        input.nextDueAt,
        input.finishedAt,
        input.status,
        input.error ?? null,
        input.consecutiveFailures,
        input.finishedAt,
        input.projectPath,
        input.task,
      )
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const listDreamRuns = (projectPath: string, limit?: number): DreamRunRow[] =>
    (db.prepare('SELECT * FROM dream_runs WHERE project_path = ? ORDER BY started_at DESC, id DESC LIMIT ?')
      .all(projectPath, Math.max(1, Math.min(200, limit ?? 20))) as unknown as DreamRunDbRow[]).map(toDreamRun)

  /**
   * Dream lease, opened lazily on first use — same reasoning as the compartment
   * lease: creating the table is a write, so eager opening would make every
   * reader take a write lock.
   */
  let dreamLeaseInstance: DreamLease | undefined
  const dreamLease = (options: Omit<DreamLeaseOptions, 'db'> = {}): DreamLease => {
    dreamLeaseInstance ??= openDreamLease({ db: db as unknown as LeaseDatabase, ...options })
    return dreamLeaseInstance
  }

  /**
   * The dashboard's session list.
   *
   * One query over the union of the per-session tables rather than N queries per
   * Session: an install with a few hundred sessions must not walk each one. The
   * counters are `LEFT JOIN`ed subqueries because a Session missing from any one
   * table must still appear (that is the point of the union).
   */
  const listSessions = (limit?: number): SessionSummaryRow[] => {
    const rows = db.prepare(`
      WITH known(session_id) AS (
        SELECT session_id FROM journal WHERE session_id IS NOT NULL
        UNION SELECT session_id FROM usage_records
        UNION SELECT session_id FROM compartments
        UNION SELECT session_id FROM tags
        UNION SELECT session_id FROM notes WHERE session_id IS NOT NULL
      ),
      j AS (
        SELECT session_id, COUNT(*) AS rows, MIN(at) AS firstAt, MAX(at) AS lastAt
        FROM journal WHERE session_id IS NOT NULL GROUP BY session_id
      ),
      u AS (SELECT session_id, COUNT(*) AS rows FROM usage_records GROUP BY session_id),
      c AS (
        SELECT session_id, COUNT(*) AS all_rows,
               SUM(CASE WHEN landed_event_seq IS NOT NULL THEN 1 ELSE 0 END) AS landed
        FROM compartments GROUP BY session_id
      ),
      t AS (SELECT session_id, COUNT(*) AS rows FROM tags GROUP BY session_id),
      d AS (
        SELECT session_id, COUNT(*) AS rows FROM pending_drops
        WHERE landed_event_seq IS NULL GROUP BY session_id
      ),
      n AS (
        SELECT session_id, COUNT(*) AS rows FROM notes
        WHERE session_id IS NOT NULL AND status <> 'dismissed' GROUP BY session_id
      )
      SELECT k.session_id AS sessionId,
             COALESCE(j.rows, 0) AS journalRows,
             COALESCE(u.rows, 0) AS usageRows,
             COALESCE(c.all_rows, 0) AS compartments,
             COALESCE(c.landed, 0) AS landedCompartments,
             COALESCE(t.rows, 0) AS tags,
             COALESCE(d.rows, 0) AS pendingDrops,
             COALESCE(n.rows, 0) AS notes,
             j.firstAt AS firstAt,
             j.lastAt AS lastAt
      FROM known k
      LEFT JOIN j ON j.session_id = k.session_id
      LEFT JOIN u ON u.session_id = k.session_id
      LEFT JOIN c ON c.session_id = k.session_id
      LEFT JOIN t ON t.session_id = k.session_id
      LEFT JOIN d ON d.session_id = k.session_id
      LEFT JOIN n ON n.session_id = k.session_id
      ORDER BY COALESCE(j.lastAt, 0) DESC
      LIMIT ?
    `).all(limit ?? 200) as Array<Omit<SessionSummaryRow, 'latestPressure' | 'latestTokens' | 'latestContextWindow'> & {
      firstAt: number | null
      lastAt: number | null
    }>

    /**
     * The newest pressure reading per Session.
     *
     * Read separately and only for the Sessions the page shows: the correlated
     * form of this probe (`data` is JSON text) cannot use `journal_at` well, and
     * the scan is bounded by `journal_at` anyway.
     */
    const reading = db.prepare(
      `SELECT data FROM journal
       WHERE session_id = ? AND data IS NOT NULL AND kind IN ('context-pressure', 'pass')
       ORDER BY at DESC, id DESC LIMIT 12`,
    )

    return rows.map((row) => {
      const base: SessionSummaryRow = {
        sessionId: row.sessionId,
        journalRows: Number(row.journalRows),
        usageRows: Number(row.usageRows),
        compartments: Number(row.compartments),
        landedCompartments: Number(row.landedCompartments),
        tags: Number(row.tags),
        pendingDrops: Number(row.pendingDrops),
        notes: Number(row.notes),
        ...row.firstAt === null ? {} : { firstAt: row.firstAt },
        ...row.lastAt === null ? {} : { lastAt: row.lastAt },
      }
      let latestPressure: number | undefined
      let latestTokens: number | undefined
      let latestContextWindow: number | undefined
      try {
        for (const candidate of reading.all(row.sessionId) as Array<{ data: string }>) {
          let parsed: Record<string, unknown>
          try {
            parsed = JSON.parse(candidate.data) as Record<string, unknown>
          } catch {
            continue
          }
          if (latestContextWindow === undefined && typeof parsed.contextWindow === 'number') {
            latestContextWindow = parsed.contextWindow
          }
          if (latestTokens === undefined) {
            if (typeof parsed.projectedTokens === 'number') latestTokens = parsed.projectedTokens
            else if (typeof parsed.tokensBefore === 'number') latestTokens = parsed.tokensBefore
          }
          if (latestPressure === undefined) {
            if (typeof parsed.pressure === 'number') latestPressure = parsed.pressure
            else if (typeof latestTokens === 'number' && typeof latestContextWindow === 'number' && latestContextWindow > 0) {
              latestPressure = latestTokens / latestContextWindow * 100
            }
          }
          if (latestPressure !== undefined && latestTokens !== undefined && latestContextWindow !== undefined) break
        }
      } catch {
        /* a corrupted row must not hide the Session */
      }
      return {
        ...base,
        ...latestPressure === undefined ? {} : { latestPressure },
        ...latestTokens === undefined ? {} : { latestTokens },
        ...latestContextWindow === undefined ? {} : { latestContextWindow },
      }
    })
  }

  return {
    dbPath,
    upsertDomain,
    listDomains,
    getDomain,
    setDomainEnabled,
    addDomainMember,
    removeDomainMember,
    listDomainMembers,
    activeDomainIdentities,
    upsertGlobalCandidate,
    getGlobalCandidate,
    listGlobalCandidates,
    setGlobalCandidateState,
    recordCandidateObservation,
    listCandidateObservations,
    enqueueProfileConfirmation,
    listProfileConfirmations,
    decideProfileConfirmation,
    createNote,
    getNote,
    listNotes,
    updateNote,
    retireNotes,
    pruneNotes,
    getDreamSchedule,
    listDreamSchedules,
    listDreamProjects,
    upsertDreamSchedule,
    listDueDreamTasks,
    recordDreamRun,
    listDreamRuns,
    dreamLease,
    listDueSurfaceChecks,
    recordSurfaceCheck,
    listSessions,
    allocateTag,
    getTag,
    listTags,
    recordUsage,
    listUsage,
    listUsageSince,
    latestUsage,
    workMetrics,
    compartmentLease,
    latestHistoryChangeAt,
    getDrainState,
    putDrainState,
    queueDrop,
    listPendingDrops,
    markDropLanded,
    retireDrop,
    allocateCompartment,
    listCompartments,
    listUnlandedCompartments,
    markCompartmentLanded,
    markCompartmentRejected,
    supersedeCompartment,
    replaceCompartmentDraft,
    coveredSeqs,
    baselineState,
    saveBaselineState,
    setMeta: (key, value) => {
      db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value)
    },
    getMeta: (key) => {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
      return row?.value
    },
    appendJournal: (entry) => {
      db.prepare('INSERT INTO journal(at, level, kind, session_id, summary, data) VALUES(?, ?, ?, ?, ?, ?)')
        .run(
          entry.at,
          entry.level,
          entry.kind,
          entry.sessionId ?? null,
          entry.summary,
          entry.data === undefined ? null : JSON.stringify(entry.data),
        )
    },
    listJournal: (filter = {}) => {
      const clauses: string[] = []
      const parameters: Array<string | number> = []
      if (filter.since !== undefined) {
        clauses.push('at >= ?')
        parameters.push(filter.since)
      }
      if (filter.until !== undefined) {
        clauses.push('at <= ?')
        parameters.push(filter.until)
      }
      if (filter.sessionId !== undefined) {
        clauses.push('session_id = ?')
        parameters.push(filter.sessionId)
      }
      if (filter.kinds !== undefined && filter.kinds.length > 0) {
        clauses.push(`kind IN (${filter.kinds.map(() => '?').join(', ')})`)
        parameters.push(...filter.kinds)
      }
      if (filter.levels !== undefined && filter.levels.length > 0) {
        clauses.push(`level IN (${filter.levels.map(() => '?').join(', ')})`)
        parameters.push(...filter.levels)
      }
      const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
      const limit = filter.limit === undefined ? '' : ` LIMIT ${String(Math.max(1, Math.floor(filter.limit)))}`
      const rows = db.prepare(`SELECT * FROM journal${where} ORDER BY id DESC${limit}`)
        .all(...parameters) as Array<{
        at: number; level: string; kind: string; session_id: string | null; summary: string; data: string | null
      }>
      return rows.map((row) => {
        let data: Record<string, unknown> | undefined
        if (row.data !== null) {
          try {
            data = JSON.parse(row.data) as Record<string, unknown>
          } catch {
            data = { unparsable: true }
          }
        }
        return {
          at: row.at,
          level: row.level as JournalLevel,
          kind: row.kind as JournalKind,
          summary: row.summary,
          ...row.session_id === null ? {} : { sessionId: row.session_id },
          ...data === undefined ? {} : { data },
        }
      })
    },
    journalByKind: (since, sessionId) => {
      const clauses: string[] = []
      const parameters: Array<string | number> = []
      if (since !== undefined) {
        clauses.push('at >= ?')
        parameters.push(since)
      }
      if (sessionId !== undefined) {
        clauses.push('session_id = ?')
        parameters.push(sessionId)
      }
      const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
      return db.prepare(
        `SELECT kind, level, COUNT(*) AS count FROM journal${where} GROUP BY kind, level ORDER BY count DESC`,
      ).all(...parameters) as Array<{ kind: string; level: JournalLevel; count: number }>
    },
    journalSumField: (kind, field, since, sessionId) => {
      const clauses = ['kind = ?']
      const parameters: Array<string | number> = [kind]
      if (since !== undefined) {
        clauses.push('at >= ?')
        parameters.push(since)
      }
      if (sessionId !== undefined) {
        clauses.push('session_id = ?')
        parameters.push(sessionId)
      }
      const rows = db.prepare(
        `SELECT data FROM journal WHERE ${clauses.join(' AND ')}`,
      ).all(...parameters) as Array<{ data: string | null }>
      let total = 0
      for (const row of rows) {
        if (row.data === null || row.data === undefined) continue
        try {
          const parsed = JSON.parse(row.data) as Record<string, unknown>
          const value = parsed[field]
          if (typeof value === 'number' && Number.isFinite(value)) total += value
        } catch {
          /* one malformed payload must not void the whole sum */
        }
      }
      return total
    },
    pruneJournal: (before) => {
      const result = db.prepare('DELETE FROM journal WHERE at < ?').run(before)
      return Number(result.changes)
    },
    pruneTags: (before) => {
      const result = db.prepare('DELETE FROM tags WHERE created_at < ?').run(before)
      return Number(result.changes)
    },
    recordMemoryEvent: (projectIdentity, memoryId, kind, now) => {
      // Two statements on purpose: the upsert seeds the row, the bump applies
      // the one counter the event names. ≤ ~46 events per pass (memoryLimit +
      // search rows), so the extra prepare is noise next to correctness.
      db.prepare(
        'INSERT INTO memory_stats(project_identity, memory_id, updated_at) VALUES(?, ?, ?) '
          + 'ON CONFLICT(project_identity, memory_id) DO NOTHING',
      ).run(projectIdentity, memoryId, now)
      if (kind === 'hit') {
        db.prepare(
          'UPDATE memory_stats SET hits = hits + 1, last_hit_at = ?, updated_at = ? '
            + 'WHERE project_identity = ? AND memory_id = ?',
        ).run(now, now, projectIdentity, memoryId)
      } else {
        db.prepare(
          'UPDATE memory_stats SET injections = injections + 1, last_injected_at = ?, updated_at = ? '
            + 'WHERE project_identity = ? AND memory_id = ?',
        ).run(now, now, projectIdentity, memoryId)
      }
    },
    listMemoryStats: (projectIdentity, memoryIds) => {
      const toStat = (row: {
        project_identity: string; memory_id: number; hits: number; last_hit_at: number | null
        injections: number; last_injected_at: number | null; local_archived: number; updated_at: number
      }): MemoryStatRow => ({
        projectIdentity: row.project_identity,
        memoryId: row.memory_id,
        hits: row.hits,
        ...row.last_hit_at === null ? {} : { lastHitAt: row.last_hit_at },
        injections: row.injections,
        ...row.last_injected_at === null ? {} : { lastInjectedAt: row.last_injected_at },
        localArchived: row.local_archived !== 0,
        updatedAt: row.updated_at,
      })
      if (memoryIds !== undefined && memoryIds.length === 0) return []
      if (memoryIds === undefined) {
        return (db.prepare('SELECT * FROM memory_stats WHERE project_identity = ?')
          .all(projectIdentity) as Array<Parameters<typeof toStat>[0]>).map(toStat)
      }
      const out: MemoryStatRow[] = []
      // Chunked IN lists stay under SQLite's bound-parameter ceiling.
      for (let index = 0; index < memoryIds.length; index += 500) {
        const chunk = memoryIds.slice(index, index + 500)
        const placeholders = chunk.map(() => '?').join(', ')
        const rows = db.prepare(
          `SELECT * FROM memory_stats WHERE project_identity = ? AND memory_id IN (${placeholders})`,
        ).all(projectIdentity, ...chunk) as Array<Parameters<typeof toStat>[0]>
        out.push(...rows.map(toStat))
      }
      return out
    },
    // NOTE: no setter for `local_archived` any more — it had zero production
    // callers from birth (2026-10-10 TTL 排查定案), and S(t) retirement is
    // computed live at recall (memory-bridge pick) and live in the report
    // meter. The column + the read in pick() stay as a manual-retire hook.
    pruneMemoryStats: (projectIdentity, keepIds) => {
      // One statement: orphans are rows whose memory_id left the known pool.
      // keepIds is the project's whole visible pool (memoryLimit-bounded
      // rendering aside, pools stay in the hundreds — well under SQLite's
      // bound-parameter ceiling).
      if (keepIds.length === 0) {
        const result = db.prepare('DELETE FROM memory_stats WHERE project_identity = ?').run(projectIdentity)
        return Number(result.changes)
      }
      const placeholders = keepIds.map(() => '?').join(', ')
      const result = db.prepare(
        `DELETE FROM memory_stats WHERE project_identity = ? AND memory_id NOT IN (${placeholders})`,
      ).run(projectIdentity, ...keepIds)
      return Number(result.changes)
    },
    journalBounds: () => {
      const row = db.prepare('SELECT COUNT(*) AS rows, MIN(at) AS oldest, MAX(at) AS newest FROM journal')
        .get() as { rows: number; oldest: number | null; newest: number | null }
      return {
        rows: row.rows,
        ...row.oldest === null ? {} : { oldest: row.oldest },
        ...row.newest === null ? {} : { newest: row.newest },
      }
    },
    get closed() {
      return closed
    },
    close: () => {
      closed = true
      db.close()
    },
  }
}
