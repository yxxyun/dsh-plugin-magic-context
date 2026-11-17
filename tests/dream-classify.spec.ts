/**
 * `classify-memories`: the re-ranking task.
 *
 * The property under test is not "did it score something" — it is **what it
 * writes when something goes wrong**. A re-ranking task that half-applies a bad
 * manifest is worse than one that does nothing, because the bad scores are
 * indistinguishable from good ones afterwards and the previous ranking is gone.
 * So every failure path here asserts "nothing changed", not just "an error was
 * reported".
 *
 * The other half is the staleness window: the task exists because verification
 * scores a row once and never again, so the test that matters most is the one
 * proving a FRESHLY scored row is skipped while an old one is picked up.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseScores, runClassifyTick, type ClassifyLlm } from '../src/core/classify-memories.ts'
import { openMemoryWriter, type MemoryWriter } from '../src/core/memory-write.ts'
import { openJournal, type Journal } from '../src/core/journal.ts'
import { buildClassifyHandler } from '../src/dsh/dream-handlers.ts'

const NOW = 1_800_000_000_000
const STALE_AFTER = 14 * 24 * 60 * 60 * 1000

let dir: string
let writer: MemoryWriter
let journal: Journal
const IDENTITY = 'dir:classify-test'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mc-classify-'))
  // Schema FIRST: `openMemoryWriter` degrades to an unavailable writer when the
  // file is missing, and every method then returns empty — which would make the
  // "picks up a stale row" cases fail as if the SQL were wrong.
  seedCorpus()
  writer = openMemoryWriter({
    dbPath: join(dir, 'memories.db'),
    logger: { info: () => {}, warn: () => {} },
    now: () => NOW,
  })
  journal = openJournal({ db: undefined, enabled: true, logger: { info: () => {}, warn: () => {} } } as never)
})

afterEach(() => {
  try { writer.close() } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true })
})

/** Minimal corpus bootstrap: the writer refuses to open without `memories`. */
function seedCorpus(): void {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(join(dir, 'memories.db'))
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL, category TEXT NOT NULL, content TEXT NOT NULL,
      normalized_hash TEXT NOT NULL, importance INTEGER, scope TEXT, shareable INTEGER,
      source_session_id TEXT, source_type TEXT, seen_count INTEGER, retrieval_count INTEGER,
      first_seen_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL, last_retrieved_at INTEGER, status TEXT NOT NULL,
      expires_at INTEGER, verification_status TEXT, verified_at INTEGER,
      superseded_by_memory_id INTEGER, merged_from TEXT, metadata_json TEXT,
      classified_at INTEGER, mural_cue TEXT, mural_cue_hash TEXT, mural_cue_at INTEGER,
      mural_cue_rejection_count INTEGER
    );
    CREATE TABLE IF NOT EXISTS memory_mutation_log(
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_path TEXT NOT NULL,
      mutation_type TEXT NOT NULL, target_memory_id INTEGER, superseded_by_id INTEGER,
      category TEXT, new_content TEXT, queued_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_state(
      project_path TEXT PRIMARY KEY, project_memory_epoch INTEGER NOT NULL DEFAULT 0
    );
  `)
  db.close()
}

/** Insert one memory row directly: the writer has no "insert with a chosen
 *  classified_at" path, and the fixture needs to control exactly that column. */
function insertMemory(input: {
  id: number
  content: string
  importance?: number
  classifiedAt?: number | null
  verifiedAt?: number | null
}): void {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(join(dir, 'memories.db'))
  db.prepare(
    `INSERT INTO memories(
       id, project_path, category, content, normalized_hash, importance, scope, shareable,
       source_type, seen_count, retrieval_count, first_seen_at, created_at, updated_at,
       last_seen_at, status, verification_status, verified_at, classified_at
     ) VALUES(?, ?, 'CONSTRAINTS', ?, ?, ?, 'project', 0, 'historian', 1, 0, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).run(
    input.id,
    IDENTITY,
    input.content,
    `hash-${String(input.id)}`,
    input.importance ?? 50,
    NOW - 1000,
    NOW - 1000,
    NOW - 1000,
    NOW - 1000,
    input.verifiedAt === null ? 'unverified' : 'verified',
    input.verifiedAt ?? null,
    input.classifiedAt ?? null,
  )
  db.close()
}

/** Read back (importance, classified_at) for assertions. */
function readScores(): Map<number, { importance: number; classifiedAt: number | null }> {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(join(dir, 'memories.db'), { readOnly: true })
  try {
    const rows = db.prepare('SELECT id, importance, classified_at FROM memories').all() as Array<{
      id: number; importance: number; classified_at: number | null
    }>
    return new Map(rows.map(row => [Number(row.id), { importance: Number(row.importance), classifiedAt: row.classified_at }]))
  } finally {
    db.close()
  }
}

/** A stream that yields the given text as one delta, then finishes. */
function fakeLlm(text: string, options: { fail?: 'error' | 'aborted' } = {}): ClassifyLlm {
  return {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', index: 0, text }
        if (options.fail !== undefined) {
          yield { type: 'finish', reason: { kind: options.fail, failure: { message: 'provider said no' } } }
          return
        }
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

const ROUTE = { provider: 'test', model: 'test-model' }

describe('parseScores', () => {
  it('reads a well-formed manifest', () => {
    expect(parseScores('{"scores":[{"id":1,"importance":80},{"id":2,"importance":30}]}'))
      .toEqual([{ id: 1, importance: 80 }, { id: 2, importance: 30 }])
  })

  it('tolerates prose around the object', () => {
    expect(parseScores('Here you go:\n{"scores":[{"id":7,"importance":55}]}\nDone.'))
      .toEqual([{ id: 7, importance: 55 }])
  })

  it('salvages a truncated array', () => {
    // The closing brace never arrives: a reasoning model hit max-tokens.
    const text = '{"scores":[{"id":1,"importance":80},{"id":2,"importance":70},{"id":3,"impor'
    expect(parseScores(text)).toEqual([{ id: 1, importance: 80 }, { id: 2, importance: 70 }])
  })

  it('clamps out-of-band scores', () => {
    expect(parseScores('{"scores":[{"id":1,"importance":999},{"id":2,"importance":-5}]}'))
      .toEqual([{ id: 1, importance: 100 }, { id: 2, importance: 1 }])
  })

  it('drops entries without a usable id or score', () => {
    expect(parseScores('{"scores":[{"id":"1","importance":80},{"id":2},{"id":3,"importance":null},{"id":4,"importance":60}]}'))
      .toEqual([{ id: 4, importance: 60 }])
  })

  it('returns nothing for unparsable text', () => {
    expect(parseScores('I cannot help with that.')).toEqual([])
    expect(parseScores('')).toEqual([])
  })
})

describe('runClassifyTick — the staleness window', () => {
  it('picks up a row that was never scored', async () => {
    insertMemory({ id: 1, content: 'a fact that was never ranked', classifiedAt: null })
    const outcome = await runClassifyTick({
      writer, identity: IDENTITY, llm: fakeLlm('{"scores":[{"id":1,"importance":72}]}'),
      route: ROUTE, sessionId: 'test', journal, now: () => NOW, staleAfterMs: STALE_AFTER,
    })
    expect(outcome.scored).toBe(1)
    expect(readScores().get(1)).toEqual({ importance: 72, classifiedAt: NOW })
  })

  it('picks up a row scored longer ago than the window', async () => {
    insertMemory({ id: 1, content: 'an old score', importance: 50, classifiedAt: NOW - STALE_AFTER - 1 })
    const outcome = await runClassifyTick({
      writer, identity: IDENTITY, llm: fakeLlm('{"scores":[{"id":1,"importance":88}]}'),
      route: ROUTE, sessionId: 'test', journal, now: () => NOW, staleAfterMs: STALE_AFTER,
    })
    expect(outcome.scored).toBe(1)
    expect(readScores().get(1)?.importance).toBe(88)
  })

  it('leaves a freshly scored row alone', async () => {
    // This is the whole reason the task exists separately from verification:
    // a row verified (and scored) yesterday must not be re-ranked today.
    insertMemory({ id: 1, content: 'scored yesterday', importance: 50, classifiedAt: NOW - 86_400_000 })
    const outcome = await runClassifyTick({
      writer, identity: IDENTITY, llm: fakeLlm('{"scores":[{"id":1,"importance":99}]}'),
      route: ROUTE, sessionId: 'test', journal, now: () => NOW, staleAfterMs: STALE_AFTER,
    })
    expect(outcome.reason).toBe('empty-pool')
    expect(outcome.scored).toBe(0)
    expect(readScores().get(1)?.importance).toBe(50)
  })
})

describe('runClassifyTick — write nothing on failure', () => {
  it('reports no-route and touches nothing', async () => {
    insertMemory({ id: 1, content: 'x', classifiedAt: null })
    const outcome = await runClassifyTick({
      writer, identity: IDENTITY, journal, sessionId: 'test', now: () => NOW, staleAfterMs: STALE_AFTER,
    })
    expect(outcome.reason).toBe('no-route')
    expect(readScores().get(1)?.classifiedAt).toBeNull()
  })

  it('reports llm-failed and keeps the previous scores', async () => {
    insertMemory({ id: 1, content: 'x', importance: 61, classifiedAt: null })
    const outcome = await runClassifyTick({
      writer, identity: IDENTITY, llm: fakeLlm('', { fail: 'error' }),
      route: ROUTE, sessionId: 'test', journal, now: () => NOW, staleAfterMs: STALE_AFTER,
    })
    expect(outcome.reason).toBe('llm-failed')
    expect(outcome.scored).toBe(0)
    // The row is untouched: same score, still unscored, so the next run retries.
    expect(readScores().get(1)).toEqual({ importance: 61, classifiedAt: null })
  })

  it('reports parse-failed and keeps the previous scores', async () => {
    insertMemory({ id: 1, content: 'x', importance: 61, classifiedAt: null })
    const outcome = await runClassifyTick({
      writer, identity: IDENTITY, llm: fakeLlm('I would rather not.'),
      route: ROUTE, sessionId: 'test', journal, now: () => NOW, staleAfterMs: STALE_AFTER,
    })
    expect(outcome.reason).toBe('parse-failed')
    expect(readScores().get(1)).toEqual({ importance: 61, classifiedAt: null })
  })

  it('ignores ids the model invented', async () => {
    insertMemory({ id: 1, content: 'sent', classifiedAt: null })
    insertMemory({ id: 2, content: 'not sent, outside the batch', classifiedAt: NOW })
    const outcome = await runClassifyTick({
      writer, identity: IDENTITY,
      // id 2 was never in the prompt, so a score for it must be dropped rather
      // than written: the model was not shown that content.
      llm: fakeLlm('{"scores":[{"id":1,"importance":70},{"id":2,"importance":5}]}'),
      route: ROUTE, sessionId: 'test', journal, now: () => NOW, staleAfterMs: STALE_AFTER,
    })
    expect(outcome.scored).toBe(1)
    expect(readScores().get(1)?.importance).toBe(70)
    expect(readScores().get(2)?.importance).toBe(50)
  })

  it('reports the token cost it actually spent', async () => {
    insertMemory({ id: 1, content: 'x', classifiedAt: null })
    const outcome = await runClassifyTick({
      writer, identity: IDENTITY, llm: fakeLlm('{"scores":[{"id":1,"importance":70}]}'),
      route: ROUTE, sessionId: 'test', journal, now: () => NOW, staleAfterMs: STALE_AFTER,
    })
    // The fake reports 100 in + 20 out.
    expect(outcome.tokensUsed).toBe(120)
  })
})

describe('buildClassifyHandler', () => {
  /** The handler as the runner would build it. */
  const handler = (overrides: {
    llm?: ClassifyLlm
    route?: () => { provider: string; model: string } | undefined
  } = {}) => buildClassifyHandler({
    classify: {
      writer,
      llm: overrides.llm ?? fakeLlm('{"scores":[{"id":1,"importance":70}]}'),
      route: overrides.route ?? (() => ROUTE),
      journal,
      sessionId: 'mc-dreamer',
      staleAfterMs: STALE_AFTER,
    },
  })

  const context = { projectPath: IDENTITY, now: NOW, tokenBudget: 120_000, log: () => {} }

  it('skips — not fails — when no route is known yet', async () => {
    insertMemory({ id: 1, content: 'x', classifiedAt: null })
    const result = await handler({ route: () => undefined })(context)
    // A missing route is this host's configuration, not a broken run: reporting
    // failed would drive the retry backoff for a condition a retry cannot fix.
    expect(result.status).toBe('skipped')
    expect(result.tokensUsed).toBe(0)
  })

  it('fails when the model call itself failed', async () => {
    insertMemory({ id: 1, content: 'x', classifiedAt: null })
    const result = await handler({ llm: fakeLlm('', { fail: 'error' }) })(context)
    expect(result.status).toBe('failed')
    expect(result.error).toBe('llm-failed')
  })

  it('reports ok with the counts on success', async () => {
    insertMemory({ id: 1, content: 'x', classifiedAt: null })
    const result = await handler()(context)
    expect(result.status).toBe('ok')
    expect(result.itemsChanged).toBe(1)
    expect(result.tokensUsed).toBe(120)
    expect(result.summary).toContain('scored 1 of 1')
  })

  it('reports ok when the pool is already fresh', async () => {
    insertMemory({ id: 1, content: 'x', classifiedAt: NOW })
    const result = await handler()(context)
    // Nothing to do is a completed run, not an error.
    expect(result.status).toBe('ok')
    expect(result.itemsChanged).toBe(0)
  })
})
