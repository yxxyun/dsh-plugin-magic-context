/**
 * `evaluate-smart-notes` as a scheduled task.
 *
 * This used to be the last step of the maintenance sweep. Two things were wrong
 * with that placement, and both are why upstream keeps it as its own task:
 *
 *  - a note carries its own `next_check_at`, so the sweep's fixed 30-minute
 *    cadence had no relationship to when a note wanted to be checked;
 *  - it was the only step in the sweep that touches the network, so a slow HTTP
 *    check delayed everything scheduled after it.
 *
 * The handler is host-only: a condition is a stored declarative predicate, so a
 * run costs no tokens.
 */
import { describe, expect, it } from 'vitest'
import { buildEvaluateSmartNotesHandler } from '../src/dsh/dream-handlers.ts'
import type { AdapterStores } from '../src/core/stores.ts'

const NOW = 1_800_000_000_000

interface Note {
  id: number
  projectPath?: string
  surfaceCondition?: unknown
}

/** Only the surface-check surface of the store is used by the tick. */
function fakeStores(notes: Note[], woken: number[]): AdapterStores {
  return {
    listDueSurfaceChecks: () => notes.map(note => ({
      id: note.id,
      // Undefined lets the tick fall back to `process.cwd()` (the repo root),
      // which is where `package.json` actually lives for these conditions.
      projectPath: note.projectPath,
      surfaceCondition: note.surfaceCondition,
    })),
    recordSurfaceCheck: (input: { id: number; met: boolean }) => {
      if (input.met) woken.push(input.id)
    },
  } as unknown as AdapterStores
}

const context = { projectPath: 'dir:test', now: NOW, tokenBudget: 0, log: () => {} }

describe('evaluate-smart-notes handler', () => {
  it('wakes a note whose condition now holds', async () => {
    const woken: number[] = []
    const stores = fakeStores(
      [{ id: 1, surfaceCondition: 'file-contains(package.json, vitest)' }],
      woken,
    )
    const handler = buildEvaluateSmartNotesHandler({ smartNotes: { stores } })
    const result = await handler(context)
    expect(result.status).toBe('ok')
    expect(result.tokensUsed).toBe(0)
    expect(result.itemsProcessed).toBe(1)
    expect(result.summary).toContain('checked 1, woke 1')
  })

  it('reports a due note whose condition does not hold yet', async () => {
    const woken: number[] = []
    const stores = fakeStores(
      [{ id: 1, surfaceCondition: 'file-contains(package.json, zz-no-such-marker)' }],
      woken,
    )
    const handler = buildEvaluateSmartNotesHandler({ smartNotes: { stores } })
    const result = await handler(context)
    expect(result.status).toBe('ok')
    expect(result.itemsProcessed).toBe(1)
    expect(result.itemsChanged).toBe(0)
    expect(result.summary).toContain('checked 1, woke 0')
  })

  it('is a no-op when nothing is due', async () => {
    const stores = fakeStores([], [])
    const handler = buildEvaluateSmartNotesHandler({ smartNotes: { stores } })
    const result = await handler(context)
    expect(result.status).toBe('ok')
    expect(result.itemsProcessed).toBe(0)
    expect(result.summary).toBe('no smart note was due')
  })

  it('skips (never fails) when the seam is not wired', async () => {
    // A missing seam is this host's configuration, not a bug in the run —
    // `failed` would drive the failure backoff for a condition that retrying
    // cannot improve.
    const handler = buildEvaluateSmartNotesHandler({})
    const result = await handler(context)
    expect(result.status).toBe('skipped')
  })
})
