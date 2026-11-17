/**
 * Every canonical task must have a capability, a schedule, and a handler.
 *
 * The failure this prevents is silent: a task name added to
 * `CANONICAL_DREAM_TASKS` without a handler means `buildDreamHandlers` returns a
 * map with no entry for it, the runner resolves no handler, and the task sits in
 * `dream_schedule` looking scheduled while never executing. Nothing throws and
 * nothing is logged as wrong.
 */
import { describe, expect, it } from 'vitest'
import {
  CANONICAL_DREAM_TASKS,
  DEFAULT_DREAM_SCHEDULES,
  DREAM_TASK_CAPABILITIES,
} from '../src/core/dream-registry.ts'
import { buildDreamHandlers } from '../src/dsh/dream-handlers.ts'

describe('the dream registry is complete', () => {
  it('every canonical task has a capability entry', () => {
    for (const task of CANONICAL_DREAM_TASKS) {
      expect(DREAM_TASK_CAPABILITIES[task], task).toBeDefined()
    }
  })

  it('every canonical task has a schedule entry', () => {
    for (const task of CANONICAL_DREAM_TASKS) {
      expect(Object.keys(DEFAULT_DREAM_SCHEDULES), task).toContain(task)
    }
  })

  it('every canonical task has a handler', () => {
    const handlers = buildDreamHandlers({})
    for (const task of CANONICAL_DREAM_TASKS) {
      expect(Object.keys(handlers), task).toContain(task)
    }
    // And no handler exists for a task that is not canonical.
    expect(Object.keys(handlers).sort()).toEqual([...CANONICAL_DREAM_TASKS].sort())
  })

  it('a handler built with no seams reports skipped rather than throwing', async () => {
    // The runners resolve handlers before any dependency is known; a missing
    // seam must degrade to `skipped` (this host's configuration) and never to a
    // throw, which would count as a failure and drive the backoff.
    const handlers = buildDreamHandlers({})
    const context = { projectPath: 'dir:test', now: 1, tokenBudget: 0, log: () => {} }
    for (const task of CANONICAL_DREAM_TASKS) {
      const result = await handlers[task]!(context)
      expect(result.status, task).toBe('skipped')
    }
  })
})
