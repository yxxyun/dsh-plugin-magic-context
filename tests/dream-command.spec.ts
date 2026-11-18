/**
 * `/ctx-dream [task]` (upstream `executeDreaming`, command-handler.ts:370).
 *
 * The point of the command is the FORCE: a task on a 30-minute cron is otherwise
 * unreachable on demand. These cases pin that, plus the two refusals upstream
 * keeps — an unknown task name, and a project with no schedules at all.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureDreamSchedules, runDueDreamTasks } from '../src/core/dream-runner.ts'
import { CANONICAL_DREAM_TASKS } from '../src/core/dream-registry.ts'
import { openStores } from '../src/core/stores.ts'

const PROJECT = 'test-project'

async function withStore<T>(fn: (stores: ReturnType<typeof openStores>) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mc-dream-cmd-'))
  const stores = openStores(dir)
  try {
    return await fn(stores)
  } finally {
    stores.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
  }
}

const noLease = {
  acquire: () => ({ holderId: 'test', ownerPid: 1, expiresAt: Date.now() + 60_000 }),
  renew: () => true,
  release: () => {},
  blocker: () => null,
} as never

describe('forced dream runs', () => {
  it('runs a task whose cron is not due', async () => {
    await withStore(async (stores) => {
      ensureDreamSchedules(stores, PROJECT, Date.now())
      // Nothing is due yet: the schedules were just seeded.
      expect(await runDueDreamTasks({ stores, lease: noLease, handlers: {} })).toEqual([])

      let ran = false
      const task = CANONICAL_DREAM_TASKS[0]
      const outcomes = await runDueDreamTasks(
        {
          stores,
          lease: noLease,
          handlers: { [task]: async () => { ran = true; return { status: 'ok' } } },
        },
        { force: { projectPath: PROJECT, task } },
      )
      expect(ran).toBe(true)
      expect(outcomes.map(outcome => outcome.task)).toEqual([task])
    })
  })

  it('runs every enabled task when no task is named', async () => {
    await withStore(async (stores) => {
      ensureDreamSchedules(stores, PROJECT, Date.now())
      const seen: string[] = []
      const handlers = Object.fromEntries(
        CANONICAL_DREAM_TASKS.map(task => [task, async () => { seen.push(task); return { status: 'ok' } }]),
      )
      const outcomes = await runDueDreamTasks(
        { stores, lease: noLease, handlers: handlers as never },
        { force: { projectPath: PROJECT } },
      )
      expect(seen.length).toBeGreaterThan(0)
      expect(outcomes.length).toBe(seen.length)
    })
  })

  it('reports a task with no handler as skipped, not as success', async () => {
    await withStore(async (stores) => {
      ensureDreamSchedules(stores, PROJECT, Date.now())
      const task = CANONICAL_DREAM_TASKS[0]
      const outcomes = await runDueDreamTasks(
        { stores, lease: noLease, handlers: {} },
        { force: { projectPath: PROJECT, task } },
      )
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]?.status).toBe('skipped')
      expect(outcomes[0]?.skippedReason).toBe('no-handler')
    })
  })

  it('forcing an unknown project yields nothing rather than throwing', async () => {
    await withStore(async (stores) => {
      const outcomes = await runDueDreamTasks(
        { stores, lease: noLease, handlers: {} },
        { force: { projectPath: 'never-seeded' } },
      )
      expect(outcomes).toEqual([])
    })
  })
})
