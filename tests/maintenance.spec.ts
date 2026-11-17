/**
 * What is left of the maintenance tick.
 *
 * Expiry and verification both moved OUT: TTL is the `curate` task and
 * verification is the `verify` task, both scheduled by the dream runner, exactly
 * as upstream keeps them. The tests for those behaviours live in
 * `expire-memories.spec.ts` and `dream-verify.spec.ts`.
 *
 * What remains here is the live-memory sample the panel reads, and the assertion
 * that the sweep no longer touches expiry — the guard against moving it back.
 */
import { DatabaseSync } from 'node:sqlite'
import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { openMemoryWriter } from '../src/core/memory-write.ts'
import { memorySample } from '../src/core/maintenance.ts'
import { makeMemoryDb } from './helpers/memory-db'

const T0 = 1_700_000_000_000
const DAY_MS = 24 * 60 * 60 * 1000
const OWN = 'git:own-project'
const OTHER = 'git:other-project'
const silentLogger = { info: () => {}, warn: () => {} }

describe('memorySample (the tick live-memory sentinel)', () => {
  it('reports the four figures in MB, rounded to 0.1', () => {
    const sample = memorySample({
      rss: 734_003_200,
      heapUsed: 123_456_789,
      heapTotal: 250_000_000,
      external: 10_485_760,
    })
    expect(sample).toEqual({ rssMb: 700, heapUsedMb: 117.7, heapTotalMb: 238.4, externalMb: 10 })
  })
})

const tempDirs: string[] = []

function createDb(schemaVersion = 95): string {
  const { path, dir } = makeMemoryDb({
    prefix: 'mc-maintenance-', schemaVersion, mutationLog: true, projectState: true,
  })
  tempDirs.push(dir)
  return path
}

interface SeedRow {
  readonly category: string
  readonly content: string
  readonly project?: string
  readonly expiresAt?: number | null
  readonly status?: string
  readonly verificationStatus?: string
}

function seedRow(path: string, row: SeedRow): number {
  const db = new DatabaseSync(path)
  try {
    const result = db.prepare(
      `INSERT INTO memories(
         project_path, category, content, normalized_hash, importance, scope, shareable,
         source_session_id, source_type, seen_count, retrieval_count,
         first_seen_at, created_at, updated_at, last_seen_at,
         status, expires_at, verification_status
       ) VALUES(?, ?, ?, ?, 50, 'project', 0, NULL, 'historian', 1, 0, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.project ?? OWN,
      row.category,
      row.content,
      row.content.toLowerCase(),
      T0,
      T0,
      T0,
      T0,
      row.status ?? 'active',
      row.expiresAt ?? null,
      row.verificationStatus ?? 'unverified',
    )
    return Number(result.lastInsertRowid)
  } finally {
    db.close()
  }
}

interface RowSnapshot {
  readonly status: string
  readonly content: string
  readonly verifiedAt: number | null
  readonly verificationStatus: string
  readonly importance: number
  readonly classifiedAt: number | null
  readonly updatedAt: number
}

function rowSnapshot(path: string, id: number): RowSnapshot {
  const db = new DatabaseSync(path)
  try {
    const row = db.prepare(
      'SELECT status, content, verified_at, verification_status, importance, classified_at, updated_at FROM memories WHERE id = ?',
    ).get(id) as {
      status: string
      content: string
      verified_at: number | null
      verification_status: string
      importance: number
      classified_at: number | null
      updated_at: number
    }
    return {
      status: row.status,
      content: row.content,
      verifiedAt: row.verified_at,
      verificationStatus: row.verification_status,
      importance: row.importance,
      classifiedAt: row.classified_at,
      updatedAt: row.updated_at,
    }
  } finally {
    db.close()
  }
}

function mutationCount(path: string, type: string): number {
  const db = new DatabaseSync(path)
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM memory_mutation_log WHERE mutation_type = ?').get(type) as { n: number }
    return row.n
  } finally {
    db.close()
  }
}

function fakeJournal(): Journal & { readonly entries: JournalEntry[] } {
  const entries: JournalEntry[] = []
  const push = (level: JournalLevel, kind: JournalKind, summary: string, data?: Record<string, unknown>): void => {
    entries.push({ seq: entries.length + 1, at: T0, level, kind, sessionId: null, summary, data: data ?? {} })
  }
  return {
    entries,
    enabled: true,
    record: (level, kind, summary, data) => push(level, kind, summary, data),
    info: (kind, summary, data) => push('info', kind, summary, data),
    warn: (kind, summary, data) => push('warn', kind, summary, data),
    error: (kind, summary, data) => push('error', kind, summary, data),
    tail: () => entries,
    byKind: () => [],
  } as Journal & { readonly entries: JournalEntry[] }
}

/** One scripted answer for every call (or a thrown Error from the first
 * `next()`). The strict request-shape enforcement lives in helpers/llm-fake. */
const fakeLlm = (reply: string | Error): { stream(options: { messages: readonly { content: unknown }[] }): AsyncIterable<unknown> } =>
  scriptLlm([reply]).llm as { stream(options: { messages: readonly { content: unknown }[] }): AsyncIterable<unknown> }

const verdictReply = (verdicts: unknown): string => JSON.stringify({ verdicts })

const ROUTE = { provider: 'deepseek', model: 'test-model' }

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
    } catch {
      /* the OS temp sweep covers residue */
    }
  }
})

describe('classifyMemories — metadata-only scoring slice', () => {
  it('banks clamped importance + classified_at without touching updated_at or the mutation log', () => {
    const path = createDb()
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      const row = seedRow(path, { category: 'ARCHITECTURE', content: 'scored row' })
      const before = rowSnapshot(path, row)
      const applied = writer.classifyMemories(OWN, [
        { id: row, importance: 500 },
        { id: 404, importance: 50 }, // absent id — self-filters through ownership
      ], T0 + 1)
      expect(applied).toBe(1)
      const after = rowSnapshot(path, row)
      expect(after.importance).toBe(100) // clamped to MC's 1..100 band
      expect(after.classifiedAt).toBe(T0 + 1)
      expect(after.updatedAt).toBe(before.updatedAt) // metadata only
      expect(mutationCount(path, 'update')).toBe(0) // no mutation log for a score
    } finally {
      writer.close()
    }
  })

  it('skips archived rows and yields zero on a fenced writer', async () => {
    const path = createDb()
    const dead = seedRow(path, { category: 'ARCHITECTURE', content: 'archived row', status: 'archived' })
    const writer = openMemoryWriter({ dbPath: path, logger: silentLogger, now: () => T0 })
    try {
      expect(writer.classifyMemories(OWN, [{ id: dead, importance: 90 }], T0 + 1)).toBe(0)
      const fencedPath = createDb(96)
      const fencedWriter = openMemoryWriter({ dbPath: fencedPath, logger: silentLogger, now: () => T0 })
      try {
        const fenced = seedRow(fencedPath, { category: 'ARCHITECTURE', content: 'fenced row' })
        expect(fencedWriter.status.readOnly).toBe(true)
        expect(fencedWriter.classifyMemories(OWN, [{ id: fenced, importance: 90 }], T0 + 1)).toBe(0)
      } finally {
        fencedWriter.close()
      }
    } finally {
      writer.close()
    }
  })
})
/**
 * Two failures that used to be silent (2026-11-11, upstream adapter v0.11.2 /
 * MC v0.49.50 audit):
 *
 *  - a `skip` verdict left no trace, so the same rows were re-asked on every
 *    tick — with a pool of unverified rows that is a permanent loop that still
 *    pays for an LLM call each time;
 *  - an LLM stream that never settles hung the tick forever, which (before the
 *    schedule moved onto its own timer) also stopped every later tick.
 */