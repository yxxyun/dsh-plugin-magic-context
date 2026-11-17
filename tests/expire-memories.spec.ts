/**
 * TTL expiry, now owned by the `curate` task.
 *
 * Upstream's placement, quoted from its executor: *"Curate owns the TTL lifecycle
 * transition. It runs after the memory-domain lease heartbeat starts and uses the
 * same authority-specific archive path as curate's ctx_memory operations."* The
 * reason is structural — an expired row and a merged-away row are the same write
 * (archive with a reason, through the contract action, recorded in the mutation
 * log) — so they belong to one lane holding one lease.
 *
 * The tests that used to live in `maintenance.spec.ts` moved here: they were
 * asserting the SWEEP did this, and the sweep no longer does.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { archiveExpiredMemories, EXPIRE_BATCH } from '../src/core/expire-memories.ts'
import { openMemoryWriter, type MemoryWriter } from '../src/core/memory-write.ts'
import { buildCurateHandler } from '../src/dsh/dream-handlers.ts'
import { DEFAULT_DREAM_CONFIG } from '../src/dsh/dream-config.ts'
import type { Journal } from '../src/core/journal.ts'

const NOW = 1_800_000_000_000
const DAY = 86_400_000
const IDENTITY = 'dir:expire-test'
const OTHER = 'dir:someone-else'

let dir: string
let writer: MemoryWriter
const reported: Array<{ kind: string; summary: string }> = []

const journal = {
  enabled: true,
  record: (level: string, kind: string, summary: string) => { reported.push({ kind, summary }) },
  info: (kind: string, summary: string) => { reported.push({ kind, summary }) },
  warn: (kind: string, summary: string) => { reported.push({ kind, summary }) },
  error: (kind: string, summary: string) => { reported.push({ kind, summary }) },
  tail: () => [],
  byKind: () => [],
} as unknown as Journal

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mc-expire-'))
  seedSchema()
  writer = openMemoryWriter({
    dbPath: join(dir, 'memories.db'),
    logger: { info: () => {}, warn: () => {} },
    now: () => NOW,
  })
  reported.length = 0
})

afterEach(() => {
  try { writer.close() } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true })
})

function seedSchema(): void {
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
    CREATE TABLE IF NOT EXISTS memory_embeddings(
      memory_id INTEGER NOT NULL, embedding BLOB NOT NULL, model_id TEXT NOT NULL,
      PRIMARY KEY(memory_id, model_id)
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

function insertRow(input: {
  id: number
  content: string
  expiresAt?: number | null
  project?: string
}): void {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(join(dir, 'memories.db'))
  db.prepare(
    `INSERT INTO memories(
       id, project_path, category, content, normalized_hash, importance, scope, shareable,
       source_type, seen_count, retrieval_count, first_seen_at, created_at, updated_at,
       last_seen_at, status, verification_status, verified_at, expires_at
     ) VALUES(?, ?, 'KNOWN_ISSUES', ?, ?, 50, 'project', 0, 'historian', 1, 0, ?, ?, ?, ?, 'active', 'verified', ?, ?)`,
  ).run(
    input.id, input.project ?? IDENTITY, input.content, `hash-${String(input.id)}`,
    NOW - 1000, NOW - 1000, NOW - 1000, NOW - 1000, NOW - 1000,
    input.expiresAt === undefined ? null : input.expiresAt,
  )
  db.close()
}

function statusOf(id: number): string | undefined {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(join(dir, 'memories.db'), { readOnly: true })
  try {
    return (db.prepare('SELECT status FROM memories WHERE id = ?').get(id) as { status: string } | undefined)?.status
  } finally {
    db.close()
  }
}

function mutationCount(type: string): number {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(join(dir, 'memories.db'), { readOnly: true })
  try {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM memory_mutation_log WHERE mutation_type = ?').get(type) as { n: number }).n)
  } finally {
    db.close()
  }
}

describe('archiveExpiredMemories', () => {
  it('archives only the lapsed rows, through the contract action', () => {
    insertRow({ id: 1, content: 'stale issue', expiresAt: NOW - DAY })
    insertRow({ id: 2, content: 'fresh rule', expiresAt: NOW + 30 * DAY })
    insertRow({ id: 3, content: 'no ttl' })
    const outcome = archiveExpiredMemories(writer, IDENTITY, NOW)
    expect(outcome).toMatchObject({ candidates: 1, archived: 1 })
    expect(statusOf(1)).toBe('archived')
    expect(statusOf(2)).toBe('active')
    expect(statusOf(3)).toBe('active')
    // Expiry IS an archive: the mutation log must show it, or nothing can audit
    // why the memory disappeared.
    expect(mutationCount('archive')).toBe(1)
  })

  it('never touches another project', () => {
    insertRow({ id: 1, content: 'mine', expiresAt: NOW - DAY })
    insertRow({ id: 2, content: 'theirs', project: OTHER, expiresAt: NOW - DAY })
    const outcome = archiveExpiredMemories(writer, IDENTITY, NOW)
    expect(outcome.archived).toBe(1)
    expect(statusOf(2)).toBe('active')
  })

  it('is a no-op when nothing has lapsed', () => {
    insertRow({ id: 1, content: 'fresh', expiresAt: NOW + DAY })
    expect(archiveExpiredMemories(writer, IDENTITY, NOW)).toMatchObject({ candidates: 0, archived: 0 })
    expect(mutationCount('archive')).toBe(0)
  })

  it('reports writer-unavailable rather than throwing', () => {
    expect(archiveExpiredMemories(undefined, IDENTITY, NOW).reason).toBe('writer-unavailable')
    expect(archiveExpiredMemories(writer, undefined, NOW).reason).toBe('writer-unavailable')
  })

  it('bounds the batch', () => {
    // The cap comes from listExpired, which takes it as a parameter.
    for (let i = 1; i <= 5; i += 1) insertRow({ id: i, content: `row ${String(i)}`, expiresAt: NOW - DAY })
    const outcome = archiveExpiredMemories(writer, IDENTITY, NOW, 2)
    expect(outcome.candidates).toBe(2)
    expect(outcome.archived).toBe(2)
    expect(EXPIRE_BATCH).toBeGreaterThan(2)
  })
})

describe('the curate task runs expiry first', () => {
  it('archives lapsed rows even when consolidation finds nothing', async () => {
    // Upstream's shape: the TTL pass runs at the top of curate, then the merge
    // pass runs on whatever is left. A curate run that finds no candidate pairs
    // must still have expired what lapsed.
    insertRow({ id: 1, content: 'stale issue', expiresAt: NOW - DAY })
    const handler = buildCurateHandler({
      curate: {
        writer, journal, sessionId: 'mc-dreamer',
        route: () => ({ provider: 'test', model: 'test-model' }),
        embeddingSpace: () => 'test-model',
        config: () => DEFAULT_DREAM_CONFIG,
      },
    })
    const result = await handler({ projectPath: IDENTITY, now: NOW, tokenBudget: 150_000, log: () => {} })
    expect(statusOf(1)).toBe('archived')
    expect(result.summary).toContain('1 expired by TTL')
    // No LLM was ever asked anything: curate had no embedding rows to pair.
    expect(result.tokensUsed).toBe(0)
  })
})
