/**
 * Canonical background-task registry for this adapter.
 *
 * Upstream (`dreamer/task-registry.ts`, 366 lines) declares 12 tasks across three
 * transports and leans on an agent that can call tools between model turns. This
 * adapter has no such agent: `inject` is `['tools', 'llm']`, `agents.get(id)` only
 * retrieves an existing agent, and `HistorianLlm.stream()` is a one-way completion
 * with no tool loop. So the task set and the transports are trimmed to what this
 * host can actually finish.
 *
 * The substitution, where upstream needs a tool loop:
 *
 *   upstream: model calls read tools, decides, then calls ctx_memory
 *   here:     host collects evidence, model judges once, host applies the verdict
 *
 * That is `host-evidence` below. It is not a downgrade for this adapter — the
 * adapter already reads files, git and SQLite in-process (`smart-notes.ts` does
 * exactly this), and doing the retrieval host-side makes every run auditable:
 * the evidence that produced a verdict is a row, not a lost tool transcript.
 *
 * Pure module: no DB imports, so config validation can name tasks without
 * pulling runtime code.
 */

export const CANONICAL_DREAM_TASKS = [
  // `promote-primers` leads: it is the only task with no model dependency, so it
  // is the one that proves the scheduler works before any completion is wired in.
  'promote-primers',
  'classify-memories',
  'verify',
  'curate',
  'retrospective',
  // Host-only: a smart note's check is a DECLARATIVE condition evaluated against
  // files/git/http, not an LLM compilation (upstream compiles through a sandbox;
  // this adapter never ported that). Upstream runs it as its own scheduled task
  // (`evaluate-smart-notes`) rather than inside a fixed-interval sweep — a note
  // carries its own `next_check_at`, so the sweep's cadence was an accident of
  // where the code happened to live.
  'evaluate-smart-notes',
  // Upstream's `review-user-memories`: expire stale user-memory candidates,
  // then ask the model which survivors are worth promoting. Its decay lives
  // INSIDE this task upstream, so keeping it here preserves that property —
  // turning the task off bounds the candidate pool by TTL regardless.
  'review-user-memories',
  // The three below have NO upstream task equivalent: upstream runs vector and
  // commit indexing from session hooks (auto-embed) and has no machine-domain
  // auto-staging at all. They are tasks here because this adapter has no
  // equivalent hook points, and because the alternative — a fixed-interval
  // sweep — is the design that kept racing the dream tasks for the same rows.
  'auto-stage-global',
  'backfill-vectors',
  'index-commits',
  // Also no upstream equivalent: upstream logs to a file with a 32 MB cap
  // (`shared/logger.ts`), so it has nothing like the `journal` table to prune.
  // This row exists because `journal` IS a table here and it is 47% of the
  // database (6.2 MB of 13.2 MB, 17,507 rows over 10 days — measured
  // 2026-11-17). Retention used to run only when the journal was OPENED, which
  // for a long-lived process means "almost never".
  'prune-journal',
] as const

export type DreamTaskName = (typeof CANONICAL_DREAM_TASKS)[number]

/**
 * How a task reaches its result — this is the field that decides whether the
 * scheduler can run it at all.
 *
 * - `host-only`: no model call. Pure database work in this process.
 * - `single-shot`: one no-tool completion whose entire answer is returned text.
 * - `host-evidence`: the host gathers evidence (files, git, SQLite) and hands it
 *   to one no-tool completion that returns a verdict; the host applies it.
 *   This is what replaces upstream's `tool-loop`.
 */
export type DreamTaskTransport = 'host-only' | 'single-shot' | 'host-evidence'

export interface DreamTaskCapability {
  transport: DreamTaskTransport
  /**
   * What the model is asked for, as one clause a user can read. Absent on
   * `host-only` tasks, which never call a model.
   */
  modelRole?: string
  /** Whether a run mutates stored memories (drives the lease domain). */
  mutatesMemories: boolean
  /**
   * Prompt-token ceiling for one run. Upstream's tool-loop budgets are in the
   * millions because the prompt is re-sent per tool turn; a single completion
   * needs far less, and an unbounded background completion is how a scheduler
   * becomes a surprise bill.
   */
  tokenBudget: number
}

export const DREAM_TASK_CAPABILITIES: Record<DreamTaskName, DreamTaskCapability> = {
  'promote-primers': {
    transport: 'host-only',
    mutatesMemories: true,
    // Cluster promotion walks memory rows pairwise; no model tokens at all.
    tokenBudget: 0,
  },
  'classify-memories': {
    transport: 'single-shot',
    modelRole: 'assign each memory one of the existing categories',
    mutatesMemories: true,
    tokenBudget: 120_000,
  },
  verify: {
    transport: 'host-evidence',
    modelRole: 'decide whether each memory still matches the code it names',
    mutatesMemories: true,
    tokenBudget: 200_000,
  },
  curate: {
    transport: 'host-evidence',
    modelRole: 'decide which memory clusters to merge, archive or keep',
    mutatesMemories: true,
    tokenBudget: 150_000,
  },
  retrospective: {
    transport: 'host-evidence',
    modelRole: 'summarise friction found in the session archive',
    // A retrospective writes a report; it never edits an existing memory.
    mutatesMemories: false,
    tokenBudget: 80_000,
  },
  'evaluate-smart-notes': {
    transport: 'host-only',
    // A note's condition is a stored declarative predicate, so evaluation is
    // file/git/http work in this process. Waking a note is a status change, not
    // a memory mutation, so it does not need the memory lease.
    mutatesMemories: false,
    tokenBudget: 0,
  },
  'review-user-memories': {
    transport: 'single-shot',
    modelRole: 'decide which parked user-memory candidates are worth promoting',
    // Promotion writes a user memory; the TTL sweep in front of it does not need
    // the model at all.
    mutatesMemories: true,
    tokenBudget: 60_000,
  },
  'auto-stage-global': {
    transport: 'single-shot',
    modelRole: 'classify which project memories recur across projects and belong in the machine domain',
    // Staging copies a row into the machine domain; the local row stays.
    mutatesMemories: true,
    tokenBudget: 40_000,
  },
  'backfill-vectors': {
    transport: 'host-only',
    // Embedding is the memory lane's own model, not the conversation's: this task
    // makes no chat completion and spends no chat tokens.
    mutatesMemories: false,
    tokenBudget: 0,
  },
  'prune-journal': {
    transport: 'host-only',
    // A DELETE past the retention line. No model, no memory mutation (the
    // journal is the adapter's own log, not the memory corpus), so it needs no
    // lease domain beyond the scheduler's own.
    mutatesMemories: false,
    tokenBudget: 0,
  },
  'index-commits': {
    transport: 'host-only',
    mutatesMemories: false,
    tokenBudget: 0,
  },
}

/** Tasks that need a model call, in canonical order. */
export function modelDreamTasks(): DreamTaskName[] {
  return CANONICAL_DREAM_TASKS.filter((task) => DREAM_TASK_CAPABILITIES[task].transport !== 'host-only')
}

/** Tasks that mutate memory state. Only these need the memory lease. */
export function memoryMutatingDreamTasks(): DreamTaskName[] {
  return CANONICAL_DREAM_TASKS.filter((task) => DREAM_TASK_CAPABILITIES[task].mutatesMemories)
}

/**
 * Lease domains. Two tasks in the same domain never run concurrently; tasks in
 * different domains may. Kept as three domains rather than one global lock so a
 * long `verify` does not block a cheap `classify`.
 */
export type DreamLeaseKind = 'memory'

export function leaseKindFor(task: DreamTaskName): DreamLeaseKind {
  // Every task in this adapter that mutates state touches the memory tables, so
  // there is exactly one writing domain today. The function exists so a future
  // docs task can claim a second domain without changing call sites.
  void task
  return 'memory'
}

/**
 * Lease key: per project, per domain — one project's verify must not block
 * another project's curate.
 */
export function leaseKeyFor(task: DreamTaskName, projectIdentity: string): string {
  return `dream:${leaseKindFor(task)}:${projectIdentity}`
}

export function isCanonicalDreamTask(value: string): value is DreamTaskName {
  return (CANONICAL_DREAM_TASKS as readonly string[]).includes(value)
}

/** Canonical order, for stable iteration and deterministic test output. */
export function compareTaskOrder(a: DreamTaskName, b: DreamTaskName): number {
  return CANONICAL_DREAM_TASKS.indexOf(a) - CANONICAL_DREAM_TASKS.indexOf(b)
}

/**
 * Default schedule per task, as 5-field cron in LOCAL time.
 *
 * `''` means "never run automatically" — the task stays available for a manual
 * run but the scheduler skips it. Defaults are deliberately conservative:
 * `verify` and `curate` change stored state, so they start off and the user
 * opts in.
 */
export const DEFAULT_DREAM_SCHEDULES: Record<DreamTaskName, string> = {
  // Cheap, idempotent, and the fastest way to see the scheduler alive.
  'promote-primers': '17 4 * * *',
  'classify-memories': '37 4 * * *',
  // On by default, but its pool is naturally tiny: `verify` only takes rows that
  // are unverified AND cite a file, and the maintenance sweep removes a row from
  // the unverified set as soon as it judges it. A batch of 8 out of that pool is
  // a few memories a night, not a rewrite of the corpus.
  verify: '27 */2 * * *',
  // Saturday 03:37, ahead of the weekday batch and well clear of the Sunday
  // retrospective. It runs on a schedule now, but `curateDryRun` still defaults
  // to true — the schedule decides when a report is produced, and the config
  // decides whether anything is written.
  curate: '37 3 * * 6',
  retrospective: '52 4 * * 0',
  // Every two hours. A note carries its own `next_check_at`, so this is only
  // the resolution at which the scheduler asks "is anything due" — too fine
  // wastes ticks, too coarse delays a wake the note itself asked for.
  'evaluate-smart-notes': '7 */2 * * *',
  // Daily, after the memory batch and before verify: a promoted user memory
  // is a fact about the person, so it should be in place before the day's
  // verification pass reasons about the corpus.
  'review-user-memories': '47 4 * * *',
  // Hourly, off the :00 mark so it never collides with the daily batch.
  'auto-stage-global': '17 * * * *',
  // Every 30 minutes: this is the cadence the old sweep ran at, and the memory
  // sample that hangs off it is meant to be a continuous series.
  'backfill-vectors': '*/30 * * * *',
  // Every two hours; a commit index that lags by one slot is harmless.
  'index-commits': '43 */2 * * *',
  // Daily at 05:07, after the whole overnight batch: pruning first would drop
  // the rows those tasks just wrote. Half an hour before the next day's work.
  'prune-journal': '7 5 * * *',
}
