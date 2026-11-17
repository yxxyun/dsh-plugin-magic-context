/**
 * The background-task runner: decide what is due, run it under a lease, record
 * what happened, and advance the clock.
 *
 * This module owns the three rules that make a scheduler safe to leave running:
 *
 * 1. **The lease comes before the work.** Two processes sharing one database
 *    (a remounted plugin, a second window) must not both run `curate` on the
 *    same project. The lease is taken first and released in `finally`, so a
 *    throwing task cannot strand it.
 * 2. **A failed run does not write its effects.** A task reports `failed` and
 *    the runner records the failure; nothing else in the task's name is written.
 *    Backoff then applies so a broken task stops burning a completion every
 *    minute.
 * 3. **The clock advances in the same transaction as the run row.** Otherwise a
 *    crash between the two leaves a task that ran but is still due, which fires
 *    it again on the next tick.
 *
 * The runner deliberately knows nothing about what a task does — handlers are
 * injected. That keeps the scheduling logic testable against fake handlers and
 * lets phase 2..5 add tasks without touching this file.
 */

import type { AdapterStores, DreamRunStatus } from './stores.ts'
import type { DreamLease } from './dream-lease.ts'
import {
  CANONICAL_DREAM_TASKS,
  DEFAULT_DREAM_SCHEDULES,
  DREAM_TASK_CAPABILITIES,
  leaseKeyFor,
  type DreamTaskName,
} from './dream-registry.ts'
import { nextDueAtMs, parseCron } from './cron.ts'

/** What a task is handed when it runs. */
export interface DreamTaskContext {
  readonly projectPath: string
  /** Epoch ms the run started. Tasks must use this, not `Date.now()`, so a
   *  test can pin the clock and the run row agrees with the work. */
  readonly now: number
  /** Prompt-token ceiling for this run, from the registry. */
  readonly tokenBudget: number
  /** Optional diagnostic sink; routes to the journal in production. */
  readonly log: (message: string) => void
}

/** What a task reports back. */
export interface DreamTaskResult {
  /**
   * `skipped` is not a failure: the task looked and found nothing to do. It
   * resets backoff the same way `ok` does, because the code path worked.
   */
  readonly status: Extract<DreamRunStatus, 'ok' | 'skipped' | 'failed'>
  readonly itemsProcessed?: number
  readonly itemsChanged?: number
  readonly tokensUsed?: number
  /** One line a user can read in the dashboard. */
  readonly summary?: string
  readonly error?: string
  /**
   * A skip whose CAUSE is environmental rather than "nothing to do": the LLM
   * route is not known yet in this process, or the project root has not been
   * registered yet. Both resolve themselves on the next conversation step, so
   * consuming a whole cron period for them is wrong — measured on this machine
   * (2026-11-17): a remount at 12:21 left `verify` and `index-commits` skipped
   * at 12:31 / 12:46 for exactly these reasons, and each skip pushed the task a
   * full day out (`verify` → 11-18, `index-commits` → 11-18) although both would
   * have run fine an hour later. Set this and the next attempt is
   * `min(nextCron, now + retryInMs)`.
   */
  readonly retryInMs?: number
}

export type DreamTaskHandler = (context: DreamTaskContext) => Promise<DreamTaskResult>

export interface DreamRunnerDeps {
  readonly stores: AdapterStores
  readonly lease: DreamLease
  /** Handlers by task. A task with no handler is reported as `skipped`. */
  readonly handlers: Partial<Record<DreamTaskName, DreamTaskHandler>>
  readonly now?: () => number
  readonly log?: (message: string, data?: Record<string, unknown>) => void
}

export interface DreamRunOutcome {
  readonly projectPath: string
  readonly task: DreamTaskName
  readonly status: DreamRunStatus
  /** Why the task did not run, when it did not: `no-handler` | `lease-held`. */
  readonly skippedReason?: 'no-handler' | 'lease-held'
  readonly nextDueAt?: number
  readonly consecutiveFailures: number
  readonly itemsProcessed: number
  readonly itemsChanged: number
  readonly tokensUsed: number
  readonly error?: string
}

/** First retry delay after a failure. */
const BACKOFF_BASE_MS = 5 * 60 * 1000
/** Ceiling for the retry delay, so backoff never exceeds a few hours. */
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000
/**
 * How many consecutive failures before the runner stops retrying until the next
 * natural cron slot. Below this the short backoff applies; above it, hammering a
 * broken task adds load without adding information.
 */
const BACKOFF_MAX_ATTEMPTS = 8

/**
 * Delay before the next attempt after `failures` consecutive failures.
 *
 * Exponential from 5 minutes, capped at 6 hours — and after
 * {@link BACKOFF_MAX_ATTEMPTS} the caller falls back to the cron slot instead.
 */
export function backoffMs(failures: number): number {
  if (failures <= 0) return 0
  if (failures >= BACKOFF_MAX_ATTEMPTS) return BACKOFF_MAX_MS
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1))
}

/**
 * Seed any missing schedule rows for one project from the registry defaults.
 *
 * Idempotent, and it never overwrites an existing row: a user who changed a
 * cron must not have it reset on the next boot. A newly added task (phase 2..5)
 * therefore appears on its own the first time this runs.
 */
export function ensureDreamSchedules(
  stores: AdapterStores,
  projectPath: string,
  now: number,
): { seeded: DreamTaskName[]; existing: DreamTaskName[] } {
  const seeded: DreamTaskName[] = []
  const existing: DreamTaskName[] = []
  for (const task of CANONICAL_DREAM_TASKS) {
    if (stores.getDreamSchedule(projectPath, task) !== undefined) {
      existing.push(task)
      continue
    }
    const cron = DEFAULT_DREAM_SCHEDULES[task]
    stores.upsertDreamSchedule({
      projectPath,
      task,
      cron,
      // `''` and an impossible expression both yield null here, which the schema
      // documents as "never" — the runner skips those rows entirely.
      ...(nextDueAtMs(cron, now) === null ? {} : { nextDueAt: nextDueAtMs(cron, now) as number }),
      consecutiveFailures: 0,
      enabled: true,
      updatedAt: now,
    })
    seeded.push(task)
  }
  return { seeded, existing }
}

/**
 * Compute the next due instant after a run.
 *
 * Success → the next natural cron slot.
 * Skipped → the next natural cron slot, UNLESS the skip named a cause that
 * resolves itself (no LLM route yet, project root not registered yet). Those
 * carry `retryInMs` and get `min(cron slot, now + retry)`, because burning a
 * whole day on a condition that clears in minutes is how a remount silently
 * lost `verify` and `index-commits` for a day (measured 2026-11-17).
 * Failure → the earlier of (cron slot, exponential backoff), so a transient
 * failure retries soon while a persistent one settles back onto the cron
 * cadence after {@link BACKOFF_MAX_ATTEMPTS}.
 */
export function computeNextDue(input: {
  cron: string
  now: number
  /** The slot that was just satisfied — excluded so a DST repeated minute does not re-fire. */
  consumedScheduledAt?: number
  status: DreamRunStatus
  consecutiveFailures: number
  /** Set by a skip whose cause is environmental; see `DreamTaskResult.retryInMs`. */
  retryInMs?: number
}): number | null {
  const cronNext = nextDueAtMs(input.cron, input.now, input.consumedScheduledAt)
  if (input.status !== 'failed' && input.status !== 'skipped') return cronNext
  // An environmental skip keeps the task warm: `min(cronNext, now + retry)`.
  // It never delays a task past its own cron, so a profile that stays in this
  // state just retries cheaply instead of silently losing a day.
  if (input.status === 'skipped' && input.retryInMs !== undefined) {
    const retryAt = input.now + Math.max(1_000, input.retryInMs)
    return cronNext === null ? retryAt : Math.min(cronNext, retryAt)
  }
  if (input.status !== 'failed') return cronNext
  const retryAt = input.now + backoffMs(input.consecutiveFailures)
  if (cronNext === null) return retryAt
  return Math.min(cronNext, retryAt)
}

/**
 * Run every task that is due, oldest due instant first.
 *
 * Sequential on purpose: tasks share one database and the memory lease serialises
 * the ones that matter, so concurrency would only add write contention to the
 * same rows.
 */
export async function runDueDreamTasks(
  deps: DreamRunnerDeps,
  options: { limit?: number } = {},
): Promise<DreamRunOutcome[]> {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((): void => {})
  const due = deps.stores.listDueDreamTasks(now(), options.limit)
  const outcomes: DreamRunOutcome[] = []

  for (const schedule of due) {
    const task = schedule.task as DreamTaskName
    const projectPath = schedule.projectPath
    if (!(CANONICAL_DREAM_TASKS as readonly string[]).includes(task)) {
      // A row naming a task this build no longer knows (downgrade) must not wedge
      // the loop. Leave it alone; the next upsert replaces it if the code returns.
      log(`dream: skipping unknown task ${task}`, { projectPath })
      continue
    }

    const handler = deps.handlers[task]
    if (handler === undefined) {
      // Recorded rather than silently ignored: a task that exists in the registry
      // but has no implementation yet is a phase-ordering fact the dashboard
      // should show, not a mystery.
      const startedAt = now()
      const consecutive = schedule.consecutiveFailures
      const nextDueAt = computeNextDue({
        cron: schedule.cron,
        now: startedAt,
        ...schedule.nextDueAt === undefined ? {} : { consumedScheduledAt: schedule.nextDueAt },
        status: 'skipped',
        consecutiveFailures: consecutive,
      })
      deps.stores.recordDreamRun({
        projectPath,
        task,
        startedAt,
        finishedAt: startedAt,
        status: 'skipped',
        summary: 'no handler registered for this task in this build',
        nextDueAt,
        consecutiveFailures: consecutive,
      })
      outcomes.push({
        projectPath,
        task,
        status: 'skipped',
        skippedReason: 'no-handler',
        ...nextDueAt === null ? {} : { nextDueAt },
        consecutiveFailures: consecutive,
        itemsProcessed: 0,
        itemsChanged: 0,
        tokensUsed: 0,
      })
      continue
    }

    const capability = DREAM_TASK_CAPABILITIES[task]
    const leaseKey = leaseKeyFor(task, projectPath)
    const acquired = deps.lease.acquire(leaseKey)
    if (acquired === null) {
      // Another process owns this domain. The row stays due, so the next tick
      // retries without any bookkeeping — no counter, no error, no noise.
      const blocker = deps.lease.blocker(leaseKey)
      log(`dream: ${task} for ${projectPath} is leased elsewhere`, {
        ...blocker === null ? {} : { holderId: blocker.holderId, ownerPid: blocker.ownerPid },
      })
      outcomes.push({
        projectPath,
        task,
        status: 'skipped',
        skippedReason: 'lease-held',
        consecutiveFailures: schedule.consecutiveFailures,
        itemsProcessed: 0,
        itemsChanged: 0,
        tokensUsed: 0,
      })
      continue
    }

    const startedAt = now()
    let result: DreamTaskResult
    try {
      result = await handler({
        projectPath,
        now: startedAt,
        tokenBudget: capability.tokenBudget,
        log: (message: string) => log(`dream[${task}]: ${message}`, { projectPath }),
      })
    } catch (error) {
      // A throwing handler is a failure, not a crash of the scheduler: one broken
      // task must not stop the others or take the host down.
      result = {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      deps.lease.release(leaseKey)
    }

    const finishedAt = now()
    // Backoff counts only failures; `skipped` and `ok` both reset it because the
    // code path completed.
    const consecutiveFailures = result.status === 'failed' ? schedule.consecutiveFailures + 1 : 0
    const nextDueAt = computeNextDue({
      cron: schedule.cron,
      now: finishedAt,
      ...schedule.nextDueAt === undefined ? {} : { consumedScheduledAt: schedule.nextDueAt },
      status: result.status,
      consecutiveFailures,
      ...result.retryInMs === undefined ? {} : { retryInMs: result.retryInMs },
    })

    // Token ceiling enforcement. A handler that overspent is recorded as failed
    // *after* the fact: refusing the write mid-run would leave half-applied
    // memory state, which is worse than an over-budget run that is then stopped
    // from happening again by the failure backoff.
    //
    // A budget of 0 is a REAL ceiling, not "unchecked": a host-only task has no
    // completion to pay for, so any reported tokens are a bug in the handler and
    // must not pass silently as a healthy run.
    const tokensUsed = result.tokensUsed ?? 0
    const overBudget = tokensUsed > capability.tokenBudget
    const status: DreamRunStatus = overBudget ? 'failed' : result.status
    const error = overBudget
      ? `token budget exceeded: used ${String(tokensUsed)} of ${String(capability.tokenBudget)}`
      : result.error

    deps.stores.recordDreamRun({
      projectPath,
      task,
      startedAt,
      finishedAt,
      status,
      itemsProcessed: result.itemsProcessed ?? 0,
      itemsChanged: result.itemsChanged ?? 0,
      tokensUsed,
      ...result.summary === undefined ? {} : { summary: result.summary },
      ...error === undefined ? {} : { error },
      nextDueAt,
      consecutiveFailures: overBudget && result.status !== 'failed' ? consecutiveFailures + 1 : consecutiveFailures,
    })

    log(`dream: ${task} for ${projectPath} → ${status}`, {
      itemsProcessed: result.itemsProcessed ?? 0,
      itemsChanged: result.itemsChanged ?? 0,
      tokensUsed,
      ...(nextDueAt === null ? { nextDueAt: null } : { nextDueAt }),
    })

    outcomes.push({
      projectPath,
      task,
      status,
      ...nextDueAt === null ? {} : { nextDueAt },
      consecutiveFailures: overBudget && result.status !== 'failed' ? consecutiveFailures + 1 : consecutiveFailures,
      itemsProcessed: result.itemsProcessed ?? 0,
      itemsChanged: result.itemsChanged ?? 0,
      tokensUsed,
      ...error === undefined ? {} : { error },
    })
  }

  return outcomes
}

/** True when `cron` parses and names at least one reachable instant. */
export function isRunnableSchedule(cron: string): boolean {
  if (cron.trim().length === 0) return false
  if (!parseCron(cron).ok) return false
  return nextDueAtMs(cron, Date.now()) !== null
}
