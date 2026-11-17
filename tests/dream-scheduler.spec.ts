/**
 * The scheduler's safety rules, exercised against a real SQLite database.
 *
 * The three rules under test are the ones whose failure is silent:
 *
 *  1. **Lease before work.** A second holder must not run the task, and the row
 *     must stay due so the retry happens without bookkeeping. If a run were
 *     recorded here, the task would be pushed to its next slot and the work
 *     would simply never happen.
 *  2. **Failure writes no effects.** A failed handler must leave the memory
 *     state alone and only add a run row. This is checked by asserting the store
 *     is unchanged apart from the run history.
 *  3. **The clock advances with the run row.** `recordDreamRun` does both in one
 *     transaction, so a crash cannot leave "ran but still due".
 *
 * Backoff gets its own block because it is the rule that decides how hard a
 * broken task hammers the machine.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openStores, type AdapterStores } from '../src/core/stores.ts'
import type { DreamLease } from '../src/core/dream-lease.ts'
import {
  backoffMs,
  computeNextDue,
  ensureDreamSchedules,
  runDueDreamTasks,
  type DreamTaskHandler,
} from '../src/core/dream-runner.ts'
import { DEFAULT_DREAM_SCHEDULES, leaseKeyFor } from '../src/core/dream-registry.ts'

const PROJECT = '/tmp/dreamer-project'

let dir: string
let stores: AdapterStores
let lease: DreamLease

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mc-dream-'))
  stores = openStores(dir)
  lease = stores.dreamLease()
})

afterEach(() => {
  try { stores.close() } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true })
})

describe('dream_schedule storage', () => {
  it('lists every project the scheduler serves, for the mount-time root warm-up', () => {
    // The map that maps an identity back to a directory dies with the process;
    // this query is how a remount learns which identities to warm from metas.
    stores.upsertDreamSchedule({ projectPath: '/a', task: 'verify', cron: '0 4 * * *', nextDueAt: 1, consecutiveFailures: 0, enabled: true, updatedAt: 1 })
    stores.upsertDreamSchedule({ projectPath: '/a', task: 'curate', cron: '0 4 * * *', nextDueAt: 1, consecutiveFailures: 0, enabled: true, updatedAt: 1 })
    stores.upsertDreamSchedule({ projectPath: '/b', task: 'verify', cron: '0 4 * * *', nextDueAt: 1, consecutiveFailures: 0, enabled: true, updatedAt: 1 })
    expect(stores.listDreamProjects()).toEqual(['/a', '/b'])
  })

  it('round-trips a row', () => {
    stores.upsertDreamSchedule({
      projectPath: PROJECT,
      task: 'promote-primers',
      cron: '17 4 * * *',
      nextDueAt: 1_000,
      consecutiveFailures: 0,
      enabled: true,
      updatedAt: 500,
    })
    const row = stores.getDreamSchedule(PROJECT, 'promote-primers')
    expect(row).toBeDefined()
    expect(row?.cron).toBe('17 4 * * *')
    expect(row?.nextDueAt).toBe(1_000)
    expect(row?.enabled).toBe(true)
  })

  it('stores "never" as an absent nextDueAt', () => {
    stores.upsertDreamSchedule({
      projectPath: PROJECT,
      task: 'verify',
      cron: '',
      consecutiveFailures: 0,
      enabled: true,
      updatedAt: 1,
    })
    expect(stores.getDreamSchedule(PROJECT, 'verify')?.nextDueAt).toBeUndefined()
  })

  it('upsert replaces rather than appends', () => {
    const base = {
      projectPath: PROJECT, task: 'verify', cron: '', consecutiveFailures: 0,
      enabled: true, updatedAt: 1,
    } as const
    stores.upsertDreamSchedule({ ...base, nextDueAt: 10 })
    stores.upsertDreamSchedule({ ...base, cron: '0 4 * * *', nextDueAt: 20 })
    const rows = stores.listDreamSchedules(PROJECT)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.cron).toBe('0 4 * * *')
    expect(rows[0]?.nextDueAt).toBe(20)
  })

  it('lists only enabled rows that are actually due', () => {
    const base = { projectPath: PROJECT, cron: '0 4 * * *', consecutiveFailures: 0, updatedAt: 1 }
    stores.upsertDreamSchedule({ ...base, task: 'verify', nextDueAt: 100, enabled: true })
    stores.upsertDreamSchedule({ ...base, task: 'curate', nextDueAt: 100, enabled: false })
    stores.upsertDreamSchedule({ ...base, task: 'retrospective', nextDueAt: 9_999, enabled: true })
    // No nextDueAt ⇒ never: enabled but never due.
    stores.upsertDreamSchedule({ ...base, task: 'classify-memories', enabled: true })

    const due = stores.listDueDreamTasks(500)
    expect(due.map(row => row.task)).toEqual(['verify'])
  })

  it('orders due rows by due instant', () => {
    const base = { projectPath: PROJECT, cron: '0 4 * * *', consecutiveFailures: 0, enabled: true, updatedAt: 1 }
    stores.upsertDreamSchedule({ ...base, task: 'verify', nextDueAt: 300 })
    stores.upsertDreamSchedule({ ...base, task: 'curate', nextDueAt: 100 })
    expect(stores.listDueDreamTasks(500).map(row => row.task)).toEqual(['curate', 'verify'])
  })
})

describe('recordDreamRun', () => {
  it('writes the run row and advances the clock together', () => {
    stores.upsertDreamSchedule({
      projectPath: PROJECT, task: 'promote-primers', cron: '17 4 * * *',
      nextDueAt: 100, consecutiveFailures: 2, enabled: true, updatedAt: 1,
    })
    stores.recordDreamRun({
      projectPath: PROJECT,
      task: 'promote-primers',
      startedAt: 200,
      finishedAt: 250,
      status: 'ok',
      itemsProcessed: 3,
      itemsChanged: 1,
      tokensUsed: 0,
      summary: 'created 1',
      nextDueAt: 5_000,
      consecutiveFailures: 0,
    })
    const schedule = stores.getDreamSchedule(PROJECT, 'promote-primers')
    // Success resets the failure counter and moves the clock in one write.
    expect(schedule?.nextDueAt).toBe(5_000)
    expect(schedule?.consecutiveFailures).toBe(0)
    expect(schedule?.lastStatus).toBe('ok')
    expect(schedule?.lastRunAt).toBe(250)

    const runs = stores.listDreamRuns(PROJECT)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.status).toBe('ok')
    expect(runs[0]?.itemsProcessed).toBe(3)
    expect(runs[0]?.summary).toBe('created 1')
  })
})

describe('ensureDreamSchedules', () => {
  it('seeds every canonical task once', () => {
    const first = ensureDreamSchedules(stores, PROJECT, 1_000)
    expect(first.seeded.length).toBeGreaterThan(0)
    expect(stores.listDreamSchedules(PROJECT)).toHaveLength(first.seeded.length)

    const second = ensureDreamSchedules(stores, PROJECT, 2_000)
    expect(second.seeded).toHaveLength(0)
    expect(stores.listDreamSchedules(PROJECT)).toHaveLength(first.seeded.length)
  })

  it('does not overwrite a cron the user changed', () => {
    ensureDreamSchedules(stores, PROJECT, 1_000)
    const before = stores.getDreamSchedule(PROJECT, 'promote-primers')
    stores.upsertDreamSchedule({
      ...before!,
      cron: '0 9 * * *',
      updatedAt: 3_000,
    })
    ensureDreamSchedules(stores, PROJECT, 4_000)
    expect(stores.getDreamSchedule(PROJECT, 'promote-primers')?.cron).toBe('0 9 * * *')
  })

  it('turns an empty cron into "never due", not into "due now"', () => {
    // Which task ships with an empty cron is a policy decision that moves
    // (curate got a schedule on 2026-11-17). This test is about the MECHANISM:
    // an empty cron must yield no due instant, so the runner skips the row
    // instead of firing it on the next tick.
    ensureDreamSchedules(stores, PROJECT, 1_000)
    stores.upsertDreamSchedule({
      projectPath: PROJECT, task: 'curate', cron: '',
      consecutiveFailures: 0, enabled: true, updatedAt: 2_000,
    })
    expect(stores.getDreamSchedule(PROJECT, 'curate')?.nextDueAt).toBeUndefined()
    // And the runner agrees: it is not in the due list.
    expect(stores.listDueDreamTasks(9_999_999).map(row => row.task)).not.toContain('curate')
  })

  it('gives every canonical task a schedule that actually fires', () => {
    // The other half: a task whose default cron cannot be parsed or cannot occur
    // would be silently dead. Every default must yield a real instant.
    ensureDreamSchedules(stores, PROJECT, 1_000)
    for (const task of Object.keys(DEFAULT_DREAM_SCHEDULES) as Array<keyof typeof DEFAULT_DREAM_SCHEDULES>) {
      const row = stores.getDreamSchedule(PROJECT, task)
      expect(row, task).toBeDefined()
      if (row?.cron === '') continue
      expect(row?.nextDueAt, `${task} cron=${row?.cron}`).toBeTypeOf('number')
    }
  })
})

describe('runDueDreamTasks', () => {
  /** Seed one task as due at `nextDueAt` and return the handler's call recorder. */
  const arm = (task: string, nextDueAt: number, cron = '17 4 * * *') => {
    stores.upsertDreamSchedule({
      projectPath: PROJECT, task, cron, nextDueAt, consecutiveFailures: 0, enabled: true, updatedAt: 1,
    })
  }

  it('an environmental skip retries in minutes, not at the next cron slot', async () => {
    const NOW = new Date(2026, 0, 15, 10, 0, 0).getTime()
    arm('verify', NOW - 1_000)
    const handler: DreamTaskHandler = async () => ({
      status: 'skipped', summary: 'no llm route is known yet (no conversation has run in this process)',
      itemsProcessed: 0, itemsChanged: 0, tokensUsed: 0, retryInMs: 5 * 60_000,
    })
    const outcomes = await runDueDreamTasks({
      stores, lease, handlers: { verify: handler }, now: () => NOW,
    })
    expect(outcomes[0]?.status).toBe('skipped')
    // The run row still exists (history is honest), but the clock retries soon:
    // before this rule the skip advanced the task to tomorrow 04:17.
    expect(stores.getDreamSchedule(PROJECT, 'verify')?.nextDueAt).toBe(NOW + 5 * 60_000)
  })

  it('runs a due task and records the outcome', async () => {
    arm('promote-primers', 500)
    const calls: string[] = []
    const handler: DreamTaskHandler = async (context) => {
      calls.push(context.projectPath)
      return { status: 'ok', itemsProcessed: 2, itemsChanged: 2, tokensUsed: 0, summary: 'done' }
    }
    const outcomes = await runDueDreamTasks({
      stores, lease, handlers: { 'promote-primers': handler }, now: () => 1_000,
    })
    expect(calls).toEqual([PROJECT])
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]?.status).toBe('ok')
    expect(stores.listDreamRuns(PROJECT)[0]?.status).toBe('ok')
    // The clock moved off the consumed slot.
    expect(stores.getDreamSchedule(PROJECT, 'promote-primers')?.nextDueAt).toBeGreaterThan(1_000)
  })

  it('releases the lease even when the handler throws', async () => {
    arm('promote-primers', 500)
    const outcomes = await runDueDreamTasks({
      stores,
      lease,
      handlers: { 'promote-primers': async () => { throw new Error('boom') } },
      now: () => 1_000,
    })
    expect(outcomes[0]?.status).toBe('failed')
    expect(outcomes[0]?.error).toBe('boom')
    // A stranded lease would silently stop the task forever; assert it is free.
    expect(lease.heldBy(leaseKeyFor('promote-primers', PROJECT))).toBe(false)
    expect(lease.blocker(leaseKeyFor('promote-primers', PROJECT))).toBeNull()
  })

  it('does not run a task another holder has leased', async () => {
    arm('promote-primers', 500)
    // A second `openStores` on the SAME database file is the real shape of the
    // hazard — a remounted plugin or a second window — not a second object in
    // one process, which the in-process guard would already cover.
    const other = openStores(dir)
    const otherHolder = other.dreamLease({ holderId: 'other-process' })
    otherHolder.acquire(leaseKeyFor('promote-primers', PROJECT))
    try {
      let ran = false
      const outcomes = await runDueDreamTasks({
        stores,
        lease,
        handlers: { 'promote-primers': async () => { ran = true; return { status: 'ok' } } },
        now: () => 1_000,
      })
      expect(ran).toBe(false)
      expect(outcomes[0]?.status).toBe('skipped')
      expect(outcomes[0]?.skippedReason).toBe('lease-held')
      // Crucially the row is still due: no run row, clock untouched.
      expect(stores.listDreamRuns(PROJECT)).toHaveLength(0)
      expect(stores.getDreamSchedule(PROJECT, 'promote-primers')?.nextDueAt).toBe(500)
    } finally {
      other.close()
    }
  })

  it('records a task with no handler as skipped, not failed', async () => {
    arm('curate', 500)
    const outcomes = await runDueDreamTasks({ stores, lease, handlers: {}, now: () => 1_000 })
    expect(outcomes[0]?.status).toBe('skipped')
    expect(outcomes[0]?.skippedReason).toBe('no-handler')
    // Skipped is a completed code path: the clock advances so the loop does not
    // retry a task that cannot run in this build.
    expect(stores.getDreamSchedule(PROJECT, 'curate')?.nextDueAt).toBeGreaterThan(1_000)
  })

  it('fails a run that overspends its token budget', async () => {
    arm('promote-primers', 500)
    // promote-primers has a 0 budget (no model call); any tokens are a bug.
    const outcomes = await runDueDreamTasks({
      stores,
      lease,
      handlers: {
        'promote-primers': async () => ({ status: 'ok', tokensUsed: 1_000, summary: 'over' }),
      },
      now: () => 1_000,
    })
    expect(outcomes[0]?.status).toBe('failed')
    expect(outcomes[0]?.error).toContain('token budget exceeded')
  })

  it('counts consecutive failures so backoff can escalate', async () => {
    arm('promote-primers', 500)
    const failing: DreamTaskHandler = async () => ({ status: 'failed', error: 'nope' })
    await runDueDreamTasks({ stores, lease, handlers: { 'promote-primers': failing }, now: () => 1_000 })
    expect(stores.getDreamSchedule(PROJECT, 'promote-primers')?.consecutiveFailures).toBe(1)

    // Re-arm at the instant the runner just scheduled and fail again.
    const scheduled = stores.getDreamSchedule(PROJECT, 'promote-primers')?.nextDueAt as number
    stores.upsertDreamSchedule({
      ...stores.getDreamSchedule(PROJECT, 'promote-primers')!,
      nextDueAt: scheduled,
    })
    await runDueDreamTasks({
      stores, lease, handlers: { 'promote-primers': failing }, now: () => scheduled,
    })
    expect(stores.getDreamSchedule(PROJECT, 'promote-primers')?.consecutiveFailures).toBe(2)
  })

  it('ignores a row naming a task this build does not know', async () => {
    // Simulates a downgrade: the row survives from a newer build.
    stores.upsertDreamSchedule({
      projectPath: PROJECT, task: 'retired-task', cron: '0 4 * * *',
      nextDueAt: 500, consecutiveFailures: 0, enabled: true, updatedAt: 1,
    })
    const outcomes = await runDueDreamTasks({ stores, lease, handlers: {}, now: () => 1_000 })
    expect(outcomes).toHaveLength(0)
    // Left untouched rather than advanced or deleted.
    expect(stores.getDreamSchedule(PROJECT, 'retired-task')?.nextDueAt).toBe(500)
  })
})

describe('backoff', () => {
  it('is zero for a healthy task', () => {
    expect(backoffMs(0)).toBe(0)
  })

  it('doubles from five minutes', () => {
    expect(backoffMs(1)).toBe(5 * 60_000)
    expect(backoffMs(2)).toBe(10 * 60_000)
    expect(backoffMs(3)).toBe(20 * 60_000)
  })

  it('caps at six hours', () => {
    expect(backoffMs(20)).toBe(6 * 60 * 60_000)
  })

  it('retries sooner than the cron slot, never later', () => {
    const now = new Date(2026, 0, 15, 10, 0, 0).getTime()
    // A daily task that fails at 10:00: the cron slot is tomorrow, the backoff
    // is five minutes, so the retry is the backoff.
    const next = computeNextDue({
      cron: '17 4 * * *', now, status: 'failed', consecutiveFailures: 1,
    })
    expect(next).toBe(now + 5 * 60_000)
  })

  it('returns the cron slot after a success', () => {
    const now = new Date(2026, 0, 15, 10, 0, 0).getTime()
    const next = computeNextDue({
      cron: '17 4 * * *', now, status: 'ok', consecutiveFailures: 0,
    })
    expect(next).toBe(new Date(2026, 0, 16, 4, 17, 0).getTime())
  })

  it('keeps a precondition skip warm instead of burning a whole day', () => {
    const now = new Date(2026, 0, 15, 10, 0, 0).getTime()
    // Measured 2026-11-17: a remount left `verify` and `index-commits` skipped
    // because no route / no project root was known YET, and each skip advanced
    // them a full day. An environmental skip must retry, not reschedule.
    const next = computeNextDue({
      cron: '17 4 * * *', now, status: 'skipped', consecutiveFailures: 0, retryInMs: 5 * 60_000,
    })
    expect(next).toBe(now + 5 * 60_000)
  })

  it('a skip with nothing to retry still waits for its cron slot', () => {
    const now = new Date(2026, 0, 15, 10, 0, 0).getTime()
    const next = computeNextDue({ cron: '17 4 * * *', now, status: 'skipped', consecutiveFailures: 0 })
    expect(next).toBe(new Date(2026, 0, 16, 4, 17, 0).getTime())
  })

  it('never lets a precondition retry push past the cron slot', () => {
    const now = new Date(2026, 0, 15, 10, 0, 0).getTime()
    const next = computeNextDue({
      cron: '17 4 * * *', now, status: 'skipped', consecutiveFailures: 0, retryInMs: 40 * 24 * 60 * 60_000,
    })
    expect(next).toBe(new Date(2026, 0, 16, 4, 17, 0).getTime())
  })

  it('returns null when the schedule can never fire', () => {
    const now = new Date(2026, 0, 15, 10, 0, 0).getTime()
    expect(computeNextDue({ cron: '', now, status: 'ok', consecutiveFailures: 0 })).toBeNull()
  })
})
