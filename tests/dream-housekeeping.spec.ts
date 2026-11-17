/**
 * The three lanes that moved off the fixed-interval sweep.
 *
 * They have no upstream task equivalent — upstream runs commit and vector
 * indexing from session hooks (`auto-embed`) and has no machine-domain staging —
 * but the SCHEDULER they now share does: one dream timer, one cron table. The
 * sweep is gone because two schedulers on one store raced for the same rows.
 *
 * Each handler here is a thin adapter over a core function, so what is worth
 * pinning is the adapter's contract: a missing seam or switch is `skipped` (not
 * `failed`), the live switch is read per run, and auto-staging fails CLOSED when
 * there is no route.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildAutoStageHandler,
  buildBackfillVectorsHandler,
  buildIndexCommitsHandler,
  buildPruneJournalHandler,
} from '../src/dsh/dream-handlers.ts'
import type { AdapterStores } from '../src/core/stores.ts'
import type { Journal } from '../src/core/journal.ts'

const NOW = 1_800_000_000_000
const context = { projectPath: 'dir:test', now: NOW, tokenBudget: 0, log: () => {} }
const stores = {} as AdapterStores
const reported: Array<{ kind: string; summary: string }> = []
const journal = {
  info: (kind: string, summary: string) => { reported.push({ kind, summary }) },
  warn: (kind: string, summary: string) => { reported.push({ kind, summary }) },
  error: (kind: string, summary: string) => { reported.push({ kind, summary }) },
} as unknown as Journal

beforeEach(() => { reported.length = 0 })

describe('auto-stage-global', () => {
  it('fails closed with no route', async () => {
    // A memory that stays at project level is recoverable; one staged into the
    // wrong domain is not obviously so.
    const handler = buildAutoStageHandler({
      housekeeping: { stores, journal, writer: { dbPath: '/tmp/x.db' }, llm: { stream: () => {} } },
    })
    const result = await handler(context)
    expect(result.status).toBe('skipped')
    expect(result.summary).toContain('no route')
  })

  it('skips when the switch is off', async () => {
    const handler = buildAutoStageHandler({
      housekeeping: {
        stores, journal, writer: { dbPath: '/tmp/x.db' }, llm: { stream: () => {} },
        route: () => ({ provider: 'p', model: 'm' }),
        autoStageEnabled: () => false,
      },
    })
    expect((await handler(context)).status).toBe('skipped')
  })

  it('skips without a corpus or llm seam', async () => {
    expect((await buildAutoStageHandler({ housekeeping: { stores, journal } })(context)).status).toBe('skipped')
    expect((await buildAutoStageHandler({})(context)).status).toBe('skipped')
  })
})

describe('backfill-vectors', () => {
  it('emits the memory sample before doing anything else', async () => {
    // The RSS series hangs off this lane because it is the closest survivor of
    // the old 30-minute sweep.
    await buildBackfillVectorsHandler({
      housekeeping: {
        stores, journal,
        vectorBackfill: async () => ({ created: 0, present: 0, skipped: 0, failed: 0, total: 0 }),
      },
    })(context)
    expect(reported.some(entry => entry.kind === 'memory-sample')).toBe(true)
  })

  it('reports created/present rather than pretending everything was new', async () => {
    const result = await buildBackfillVectorsHandler({
      housekeeping: {
        stores, journal,
        vectorBackfill: async () => ({ created: 2, present: 3, skipped: 1, failed: 0, total: 6 }),
      },
    })(context)
    expect(result.itemsChanged).toBe(2)
    expect(result.summary).toBe('created 2, present 3, 1 skipped, 0 failed (of 6)')
  })

  it('treats an unusable lane as skipped, not failed', async () => {
    // Retrying sooner cannot conjure an embedder or open a closed parity gate.
    const result = await buildBackfillVectorsHandler({
      housekeeping: { stores, journal, vectorBackfill: async () => undefined },
    })(context)
    expect(result.status).toBe('skipped')
  })

  it('respects the switch', async () => {
    const result = await buildBackfillVectorsHandler({
      housekeeping: {
        stores, journal,
        vectorBackfill: async () => ({ created: 1, present: 0, skipped: 0, failed: 0, total: 1 }),
        vectorBackfillEnabled: () => false,
      },
    })(context)
    expect(result.status).toBe('skipped')
    expect(reported.some(entry => entry.kind === 'memory-sample')).toBe(false)
  })
})

describe('index-commits', () => {
  const outcome = { read: 42, inserted: 3, updated: 1, embedded: 4 }

  it('needs a project root for the identity', async () => {
    const result = await buildIndexCommitsHandler({
      housekeeping: { stores, journal, indexCommits: async () => outcome },
    })(context)
    expect(result.status).toBe('skipped')
    expect(result.summary).toContain('no project root')
  })

  it('passes the root and reports the delta', async () => {
    let seen: string | undefined
    const result = await buildIndexCommitsHandler({
      housekeeping: {
        stores, journal,
        indexCommits: async (input) => { seen = input.projectPath; return outcome },
        projectRootOf: () => 'C:/repo',
      },
    })(context)
    expect(seen).toBe('C:/repo')
    expect(result.itemsChanged).toBe(4)
    expect(result.summary).toContain('read 42, +3 new, 1 amended, 4 embedded')
  })

  it('gives up on a stalled git read instead of holding the lease', async () => {
    // A wedged scheduler is worse than a commit index that lags one slot.
    const result = await buildIndexCommitsHandler({
      housekeeping: {
        stores, journal,
        indexCommits: () => new Promise(resolve => setTimeout(() => resolve(outcome), 60_000)),
        indexCommitsTimeoutMs: 50,
        projectRootOf: () => 'C:/repo',
      },
    })(context)
    expect(result.status).toBe('skipped')
    expect(result.summary).toContain('timed out')
})
})


// `prune-journal` exists because retention used to run only when the journal was
// OPENED (`live-journal.ts`), which for a long-lived process means "almost
// never": measured 2026-11-17, journal row data + indexes were 47% of the
// database. A daily task is the primitive this adapter already has.
describe('prune-journal', () => {
  it('prunes past the configured retention window', async () => {
    const cutoffs: number[] = []
    const handler = buildPruneJournalHandler({
      housekeeping: {
        stores,
        pruneJournal: (cutoff) => { cutoffs.push(cutoff); return 42 },
        journalRetentionDays: () => 30,
      },
    })
    const result = await handler(context)
    expect(result.status).toBe('ok')
    expect(result.itemsChanged).toBe(42)
    expect(cutoffs).toEqual([NOW - 30 * 24 * 60 * 60_000])
    expect(result.summary).toContain('pruned 42')
  })

  it('floors the window at one day so a stray zero cannot empty the table', async () => {
    const cutoffs: number[] = []
    const handler = buildPruneJournalHandler({
      housekeeping: {
        stores,
        pruneJournal: (cutoff) => { cutoffs.push(cutoff); return 0 },
        // The same floor `live-journal.ts` applies to a manual configuration.
        journalRetentionDays: () => 0,
      },
    })
    const result = await handler(context)
    expect(result.status).toBe('ok')
    expect(cutoffs).toEqual([NOW - 24 * 60 * 60_000])
    expect(result.summary).toContain('nothing past 1d retention')
  })

  it('reports a failed DELETE as failed rather than retrying sooner', async () => {
    const handler = buildPruneJournalHandler({
      housekeeping: {
        stores,
        pruneJournal: () => { throw new Error('database is locked') },
        journalRetentionDays: () => 30,
      },
    })
    const result = await handler(context)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('database is locked')
  })

  it('is skipped when the seam is absent', async () => {
    const handler = buildPruneJournalHandler({ housekeeping: { stores } })
    expect((await handler(context)).status).toBe('skipped')
  })
})
