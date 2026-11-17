/**
 * `review-user-memories` as a scheduled task.
 *
 * The block was previously the middle of the maintenance sweep, with a stored
 * timestamp throttling it to once a day "because DSH has no daily scheduler to
 * hang MC's review cadence on". That sentence stopped being true when the dream
 * runner landed, so the work moved into a task with a real cron.
 *
 * What must not change in the move: the candidate TTL still runs
 * UNCONDITIONALLY, before and regardless of the model. A profile with no route
 * must still bound its candidate pool — that is the invariant the old sweep
 * carried and this test carries forward.
 */
import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { buildReviewUserMemoriesHandler } from '../src/dsh/dream-handlers.ts'
import { PROFILE_CANDIDATE_TTL_MS, PROFILE_REVIEW_META_KEY } from '../src/core/profile-review.ts'
import { openProfileWriter } from '../src/core/profile-write.ts'
import type { AdapterStores } from '../src/core/stores.ts'
import type { Journal } from '../src/core/journal.ts'
import { makeMemoryDb } from './helpers/memory-db.ts'

const NOW = 1_800_000_000_000
const DAY = 86_400_000
const dirs: string[] = []
const reported: Array<{ kind: string; summary: string }> = []

const journal = {
  info: (kind: string, summary: string) => { reported.push({ kind, summary }) },
  warn: (kind: string, summary: string) => { reported.push({ kind, summary }) },
  error: (kind: string, summary: string) => { reported.push({ kind, summary }) },
} as unknown as Journal

/** Only the meta surface is consulted by the handler. */
function fakeStores(meta: Map<string, string> = new Map()): AdapterStores {
  return {
    getMeta: (key: string) => meta.get(key),
    setMeta: (key: string, value: string) => { meta.set(key, value) },
  } as unknown as AdapterStores
}

/**
 * A store with the profile tables migrated.
 *
 * `openProfileWriter` refuses a path that does not exist and returns a no-op
 * writer when the schema is missing — it expects the store's own migration to
 * have created the tables. `makeMemoryDb({ profile: true })` is that migration.
 */
function makeWriter() {
  const { path, dir } = makeMemoryDb({ prefix: 'mc-review-task-', profile: true })
  dirs.push(dir)
  return openProfileWriter({
    dbPath: path,
    logger: { info: () => {}, warn: () => {} },
    now: () => NOW,
  })
}

/**
 * Insert a candidate and pin its age.
 *
 * `recordCandidates` stamps `created_at` from the writer's own clock, so the age
 * has to be set afterwards — the TTL is exactly what this test is about, and
 * back-dating is the only way to exercise it without waiting.
 */
function seedCandidate(
  writer: ReturnType<typeof openProfileWriter>,
  input: { content: string; createdAt: number; sessionId?: string },
): void {
  writer.recordCandidates({ sessionId: input.sessionId ?? 'session-1', observations: [input.content] })
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(writer.dbPath)
  try {
    db.prepare('UPDATE user_memory_candidates SET created_at = ? WHERE content = ?')
      .run(input.createdAt, input.content)
  } finally {
    db.close()
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  reported.length = 0
})

describe('review-user-memories handler', () => {
  it('expires stale candidates even with no model route', async () => {
    const writer = makeWriter()
    try {
      seedCandidate(writer, { content: 'uses pnpm everywhere', createdAt: NOW - PROFILE_CANDIDATE_TTL_MS - DAY })
      seedCandidate(writer, { content: 'prefers tabs', createdAt: NOW - 1000 })
      const handler = buildReviewUserMemoriesHandler({
        reviewUserMemories: { profileWriter: writer, stores: fakeStores(), journal },
      })
      const result = await handler({ projectPath: 'dir:test', now: NOW, tokenBudget: 0, log: () => {} })
      expect(result.status).toBe('ok')
      // The stale candidate is gone; the fresh one survives for a later pass.
      expect(writer.listCandidates(10)).toHaveLength(1)
      expect(result.summary).toContain('expired 1')
      // No route means no promotion attempt — and crucially no failure.
      expect(result.summary).toContain('no promotion pass')
    } finally {
      writer.close()
    }
  })

  it('skips when there is no profile writer', async () => {
    const handler = buildReviewUserMemoriesHandler({
      reviewUserMemories: { stores: fakeStores(), journal },
    })
    const result = await handler({ projectPath: 'dir:test', now: NOW, tokenBudget: 0, log: () => {} })
    expect(result.status).toBe('skipped')
  })

  it('skips when there is no journal', async () => {
    const writer = makeWriter()
    try {
      const handler = buildReviewUserMemoriesHandler({
        reviewUserMemories: { profileWriter: writer, stores: fakeStores() },
      })
      expect((await handler({ projectPath: 'dir:test', now: NOW, tokenBudget: 0, log: () => {} })).status)
        .toBe('skipped')
    } finally {
      writer.close()
    }
  })

  it('reports how many candidates the model actually judged', async () => {
    // "promoted 0" alone is ambiguous: it reads the same whether the model looked
    // at twelve and kept all twelve, or never called out. Measured 2026-11-17 on a
    // real run where the only way to tell was the absence of a warn line.
    const writer = makeWriter()
    try {
      // Two sessions: a review pass refuses to judge a single-session batch at all
      // (PROFILE_REVIEW_MIN_SESSIONS), which is a different skip from "nothing worth
      // promoting".
      seedCandidate(writer, { content: 'a fact worth keeping', createdAt: NOW - 1000, sessionId: 'session-a' })
      seedCandidate(writer, { content: 'another fact', createdAt: NOW - 1000, sessionId: 'session-b' })
      seedCandidate(writer, { content: 'a third', createdAt: NOW - 1000, sessionId: 'session-b' })
      const llm = {
        stream: async function* () {
          yield { type: 'text-delta', index: 0, text: '{"promote":[],"reject":[]}' }
        },
      }
      const handler = buildReviewUserMemoriesHandler({
        reviewUserMemories: {
          profileWriter: writer, stores: fakeStores(), journal, llm,
          route: () => ({ provider: 'p', model: 'm' }),
        },
      })
      const result = await handler({ projectPath: 'dir:test', now: NOW, tokenBudget: 0, log: () => {} })
      expect(result.status).toBe('ok')
      expect(result.summary).toContain('kept 3')
      expect(result.itemsProcessed).toBe(3)
      // Nothing was rejected, so nothing was consumed either.
      expect(result.summary).toContain('consumed 0')
    } finally {
      writer.close()
    }
  })

  it('stamps the rows it judged so the queue advances', async () => {
    // The defect this covers: a "keep" verdict does not consume the candidate, so
    // ordering by `created_at` alone offered the same 12 rows on every run and the
    // 129 behind them were unreachable. `reviewed_at` is what lets the next pass
    // move on.
    const writer = makeWriter()
    try {
      // Three, not two: PROFILE_REVIEW_THRESHOLD is 3, and a two-row batch returns
      // `too-few` before the model is ever called.
      seedCandidate(writer, { content: 'kept fact one', createdAt: NOW - 3000, sessionId: 'a' })
      seedCandidate(writer, { content: 'kept fact two', createdAt: NOW - 2000, sessionId: 'b' })
      seedCandidate(writer, { content: 'kept fact three', createdAt: NOW - 1000, sessionId: 'b' })
      const llm = {
        stream: async function* () {
          yield { type: 'text-delta', index: 0, text: '{"promote":[],"reject":[]}' }
        },
      }
      const handler = buildReviewUserMemoriesHandler({
        reviewUserMemories: {
          profileWriter: writer, stores: fakeStores(), journal, llm,
          route: () => ({ provider: 'p', model: 'm' }),
        },
      })
      await handler({ projectPath: 'dir:test', now: NOW, tokenBudget: 0, log: () => {} })

      // Read through the writer itself: a second connection would need to see
      // through whatever transaction discipline the writer uses, and what matters
      // here is the row as the next pass will read it.
      const rows = writer.listCandidates(10)
      expect(rows).toHaveLength(3)
      // Still present (a keep is not consumption) but stamped.
      expect(rows.every(row => row.reviewedAt === NOW)).toBe(true)
    } finally {
      writer.close()
    }
  })

  it('does not stamp the throttle when no call was attempted', async () => {
    // A FAILED or skipped call must be retried on the next run rather than
    // silenced for a day by its own error.
    const writer = makeWriter()
    const meta = new Map<string, string>()
    try {
      const handler = buildReviewUserMemoriesHandler({
        reviewUserMemories: { profileWriter: writer, stores: fakeStores(meta), journal },
      })
      await handler({ projectPath: 'dir:test', now: NOW, tokenBudget: 0, log: () => {} })
      expect(meta.get(PROFILE_REVIEW_META_KEY)).toBeUndefined()
    } finally {
      writer.close()
    }
  })
})
