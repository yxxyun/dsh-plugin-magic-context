/**
 * The m[0] memory pool digest.
 *
 * `memoriesChanged` (management-pass) compares this digest and forces a HARD
 * baseline rebuild when it differs — a rebuild that costs a full prompt re-read.
 * So the digest must change exactly when m[0] would have changed.
 *
 * Defect measured 2026-11-26: the digest hashed `id:updated_at`, and `updated_at`
 * moves on ANY write, including columns that never reach the prompt
 * (`verification_status`, `classified_at`, `seen_count`, `scope`). 469 of 974
 * active rows had `updated_at` moved since 11-23, and six `memories-digest`
 * rebuilds re-read 2,337,877 tokens for content that had not changed.
 *
 * Upstream never had the exposure: m0 identity is `rendered_memory_ids` +
 * `memory_revision` (`m0_compose.rs:70`, `transform.rs:3972`), never a timestamp.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { memoryPoolDigest } from '../src/core/memory-bridge.ts'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
})

describe('memoryPoolDigest', () => {
  it('is stable across an identical pool', () => {
    const lines = ['#1 [CONSTRAINTS] never commit secrets', '#2 [NAMING] ctx_reduce, not mark']
    expect(memoryPoolDigest(lines)).toBe(memoryPoolDigest([...lines]))
  })

  it('changes when a rendered line changes', () => {
    const before = memoryPoolDigest(['#1 [CONSTRAINTS] never commit secrets'])
    const after = memoryPoolDigest(['#1 [CONSTRAINTS] never commit any secret'])
    expect(after).not.toBe(before)
  })

  it('changes when the set changes, and respects order', () => {
    const one = memoryPoolDigest(['A'])
    const two = memoryPoolDigest(['A', 'B'])
    const swapped = memoryPoolDigest(['B', 'A'])
    expect(two).not.toBe(one)
    // Render order is part of the bytes, so it is part of the identity: the same
    // rows in a different order put different text on the wire.
    expect(swapped).not.toBe(two)
  })
})

/**
 * The regression itself, against a real `memories.db`: a metadata-only write
 * must not move the digest. This is the shape verify / classify / promote
 * produce — they UPDATE columns the renderer never reads.
 */
describe('a metadata-only memory write does not bust m[0]', () => {
  function makeDb(): { path: string; close: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'mc-pool-digest-'))
    tempDirs.push(dir)
    const path = join(dir, 'memories.db')
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        normalized_hash TEXT,
        importance INTEGER NOT NULL DEFAULT 50,
        scope TEXT NOT NULL DEFAULT 'project',
        shareable INTEGER NOT NULL DEFAULT 0,
        source_session_id TEXT,
        source_type TEXT NOT NULL DEFAULT 'agent',
        seen_count INTEGER NOT NULL DEFAULT 1,
        retrieval_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER,
        created_at INTEGER,
        updated_at INTEGER,
        last_seen_at INTEGER,
        last_retrieved_at INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        expires_at INTEGER,
        verification_status TEXT,
        verified_at INTEGER,
        classified_at INTEGER,
        superseded_by_memory_id INTEGER,
        merged_from TEXT,
        metadata_json TEXT,
        mural_cue TEXT,
        mural_cue_hash TEXT,
        mural_cue_at INTEGER,
        mural_cue_rejection_count INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO memories(id, project_path, category, content, importance, project_path, created_at, updated_at, status)
      VALUES (1, 'git:demo', 'CONSTRAINTS', 'never commit secrets', 90, 'git:demo', 1, 1000, 'active');
    `)
    return { path, close: () => db.close() }
  }

  /** The rendered line for one row, as the recall lane would render it. */
  function render(path: string, id: number): string {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const row = db.prepare('SELECT id, category, content FROM memories WHERE id = ?').get(id) as
        { id: number; category: string; content: string }
      return `#${String(row.id)} [${row.category}] ${row.content}`
    } finally {
      db.close()
    }
  }

  it('leaves the digest unchanged when only updated_at moves', () => {
    const { path, close } = makeDb()
    try {
      const before = memoryPoolDigest([render(path, 1)])
      const db = new DatabaseSync(path)
      try {
        // Exactly what verify/classify do: touch bookkeeping columns, not content.
        db.prepare("UPDATE memories SET updated_at = 2000, verification_status = 'verified', verified_at = 2000, classified_at = 2000, seen_count = seen_count + 1 WHERE id = 1").run()
      } finally {
        db.close()
      }
      const after = memoryPoolDigest([render(path, 1)])
      expect(after).toBe(before)
    } finally {
      close()
    }
  })

  it('moves the digest when the content itself is edited', () => {
    const { path, close } = makeDb()
    try {
      const before = memoryPoolDigest([render(path, 1)])
      const db = new DatabaseSync(path)
      try {
        db.prepare("UPDATE memories SET content = 'never commit any secret', updated_at = 2000 WHERE id = 1").run()
      } finally {
        db.close()
      }
      const after = memoryPoolDigest([render(path, 1)])
      expect(after).not.toBe(before)
    } finally {
      close()
    }
  })
})
