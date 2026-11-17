/**
 * The sharing gate wired into the two places a memory can become shared.
 *
 * `shareable-guard.spec.ts` proves the judgement; this proves the wiring, which is
 * where a correct judgement can still be bypassed:
 *
 *  - `classify` is now the AUTOMATIC path (upstream's model: a model decides,
 *    not a human reading a card), so the guard has to sit between the model's
 *    answer and the write;
 *  - `publish` is the manual path and gets the same screen, as the last line
 *    before a row enters the shared store.
 *
 * The case that matters most is the one the live corpus produced: a memory whose
 * text names a local endpoint and whose model answer says "a teammate would want
 * this". Both are individually reasonable and the combination is a leak.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openMemoryWriter, type MemoryWriter } from '../src/core/memory-write.ts'
import { runClassifyTick, type ClassifyLlm } from '../src/core/classify-memories.ts'
import type { Journal } from '../src/core/journal.ts'

const NOW = 1_800_000_000_000
const IDENTITY = 'dir:share-test'
const ROUTE = { provider: 'test', model: 'test-model' }
const DAY = 24 * 60 * 60 * 1000

let dir: string
let writer: MemoryWriter
const reported: Array<{ kind: string; summary: string; data?: Record<string, unknown> }> = []

const journal = {
  enabled: true,
  record: (level: string, kind: string, summary: string, data?: Record<string, unknown>) => {
    reported.push({ kind, summary, ...data === undefined ? {} : { data } })
  },
  info: (kind: string, summary: string, data?: Record<string, unknown>) => {
    reported.push({ kind, summary, ...data === undefined ? {} : { data } })
  },
  warn: (kind: string, summary: string, data?: Record<string, unknown>) => {
    reported.push({ kind, summary, ...data === undefined ? {} : { data } })
  },
  error: (kind: string, summary: string, data?: Record<string, unknown>) => {
    reported.push({ kind, summary, ...data === undefined ? {} : { data } })
  },
  tail: () => [],
  byKind: () => [],
} as unknown as Journal

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mc-share-'))
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

function insertMemory(input: {
  id: number
  content: string
  category?: string
  classifiedAt?: number | null
  shareable?: number
  scope?: string
}): void {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(join(dir, 'memories.db'))
  db.prepare(
    `INSERT INTO memories(
       id, project_path, category, content, normalized_hash, importance, scope, shareable,
       source_type, seen_count, retrieval_count, first_seen_at, created_at, updated_at,
       last_seen_at, status, verification_status, verified_at, classified_at
     ) VALUES(?, ?, ?, ?, ?, 50, ?, ?, 'historian', 1, 0, ?, ?, ?, ?, 'active', 'verified', ?, ?)`,
  ).run(
    input.id, IDENTITY, input.category ?? 'ARCHITECTURE', input.content,
    `hash-${String(input.id)}`, input.scope ?? 'project', input.shareable ?? 0,
    NOW - 1000, NOW - 1000, NOW - 1000, NOW - 1000, NOW - 1000,
    input.classifiedAt === undefined ? null : input.classifiedAt,
  )
  db.close()
}

function stateOf(id: number): { shareable: number; scope: string | null; importance: number } | undefined {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(join(dir, 'memories.db'), { readOnly: true })
  try {
    const row = db.prepare('SELECT shareable, scope, importance FROM memories WHERE id = ?').get(id) as
      | { shareable: number; scope: string | null; importance: number }
      | undefined
    return row === undefined
      ? undefined
      : { shareable: Number(row.shareable), scope: row.scope, importance: Number(row.importance) }
  } finally {
    db.close()
  }
}

function fakeLlm(answer: string): ClassifyLlm {
  return {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: answer }
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

const baseDeps = () => ({
  writer, identity: IDENTITY, route: ROUTE, sessionId: 'mc-dreamer',
  journal, now: () => NOW, staleAfterMs: 14 * DAY,
})

describe('classify writes the sharing verdict', () => {
  it('shares a clean architectural fact the model marked shareable', async () => {
    insertMemory({ id: 1, content: 'The scheduler tick is five minutes and takes a lease before writing.' })
    const outcome = await runClassifyTick({
      ...baseDeps(),
      llm: fakeLlm('{"scores":[{"id":1,"importance":70,"scope":"ecosystem","shareable":true}]}'),
    })
    expect(outcome.scored).toBe(1)
    expect(outcome.shared).toBe(1)
    expect(outcome.blockedByGuard).toBe(0)
    // This is the upstream behaviour: a model judgement, applied immediately,
    // with no card in between.
    expect(stateOf(1)?.shareable).toBe(1)
    expect(stateOf(1)?.scope).toBe('ecosystem')
  })

  it('refuses to share a memory that names a local endpoint', async () => {
    // Verbatim shape from live memory #590, which is shared today.
    insertMemory({
      id: 1,
      content: '不再需要 127.0.0.1:3067 代理，改走 hf-mirror.com 镜像站。',
    })
    const outcome = await runClassifyTick({
      ...baseDeps(),
      llm: fakeLlm('{"scores":[{"id":1,"importance":60,"scope":"universe","shareable":true}]}'),
    })
    // The model said yes; the guard said no, and the guard wins.
    expect(outcome.blockedByGuard).toBe(1)
    expect(outcome.shared).toBe(0)
    expect(stateOf(1)?.shareable).toBe(0)
    // The audience is reset with it: a row marked universe but not shareable
    // renders for nobody and reads as "already handled".
    expect(stateOf(1)?.scope).toBe('project')
  })

  it('refuses to share a memory carrying a credential', async () => {
    insertMemory({
      id: 1,
      content: 'API key sk-strata-fa8dd7d3a6c8b7d8f6f61acba7546fce for the local provider.',
    })
    const outcome = await runClassifyTick({
      ...baseDeps(),
      llm: fakeLlm('{"scores":[{"id":1,"importance":80,"shareable":true}]}'),
    })
    expect(outcome.blockedByGuard).toBe(1)
    expect(stateOf(1)?.shareable).toBe(0)
  })

  it('records the block in the journal with the reason', async () => {
    insertMemory({ id: 1, content: 'config lives at C:\\Users\\yxx\\app\\settings.json' })
    await runClassifyTick({
      ...baseDeps(),
      llm: fakeLlm('{"scores":[{"id":1,"importance":60,"shareable":true}]}'),
    })
    const row = reported.filter(entry => entry.kind === 'dream-classify').pop()
    expect(row?.data?.blockedByGuard).toBe(1)
    expect(JSON.stringify(row?.data?.blockedReasons)).toContain('local-trace')
  })

  it('leaves a memory private when the model says shareable false', async () => {
    insertMemory({ id: 1, content: 'A perfectly clean fact nobody needs to share.' })
    const outcome = await runClassifyTick({
      ...baseDeps(),
      llm: fakeLlm('{"scores":[{"id":1,"importance":50,"scope":"project","shareable":false}]}'),
    })
    expect(outcome.shared).toBe(0)
    expect(stateOf(1)?.shareable).toBe(0)
    expect(stateOf(1)?.importance).toBe(50)
  })

  it('still banks importance when the model omits scope and shareable', async () => {
    insertMemory({ id: 1, content: 'An unshared fact.' })
    const outcome = await runClassifyTick({
      ...baseDeps(),
      llm: fakeLlm('{"scores":[{"id":1,"importance":77}]}'),
    })
    expect(outcome.scored).toBe(1)
    // Absent sharing fields must not be read as "share it".
    expect(stateOf(1)?.shareable).toBe(0)
    expect(stateOf(1)?.importance).toBe(77)
  })

  it('withdraws a share when a later re-score says private', async () => {
    // Upstream has no human approval step in this lane: `setMemoryClassification`
    // (storage-memory.ts:1134+) writes whichever of importance/scope/shareable
    // actually changed, so a re-score CAN take a share away. This adapter used to
    // refuse that via `AND shareable = 0` on CLASSIFY_SHARING — its own addition,
    // removed 2026-11-17 (code analysis P1-9, standing rule: follow upstream).
    //
    // A pre-existing share is not evidence of a past human decision here: the
    // row was shared by an earlier classify verdict, and the pool has since
    // changed. Leaving it shared would mean the newest verdict never applied.
    insertMemory({
      id: 1, content: 'A fact already published to the machine domain.',
      shareable: 1, scope: 'universe', classifiedAt: NOW - 30 * DAY,
    })
    const outcome = await runClassifyTick({
      ...baseDeps(),
      llm: fakeLlm('{"scores":[{"id":1,"importance":95,"scope":"project","shareable":false}]}'),
    })
    expect(stateOf(1)?.importance).toBe(95)
    expect(stateOf(1)?.shareable).toBe(0)
    expect(stateOf(1)?.scope).toBe('project')
    expect(outcome.scored).toBe(1)
  })

  it('still promotes a private row when the verdict says shareable', async () => {
    // The other direction, to prove the withdrawal above is not "always private".
    insertMemory({
      id: 1, content: 'Sourdough starter needs feeding every twelve hours.',
      shareable: 0, classifiedAt: NOW - 30 * DAY,
    })
    await runClassifyTick({
      ...baseDeps(),
      llm: fakeLlm('{"scores":[{"id":1,"importance":70,"scope":"universe","shareable":true}]}'),
    })
    expect(stateOf(1)?.shareable).toBe(1)
    expect(stateOf(1)?.scope).toBe('universe')
  })
})

describe('publish refuses unsafe material as the last line', () => {
  it('rejects a local endpoint', () => {
    const result = writer.publishDomainMemory({
      identity: 'dir:global:machine',
      category: 'CONSTRAINTS',
      content: 'Set the proxy to 127.0.0.1:3067 before pulling models.',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('shareable-check-failed')
    expect(result.detail).toContain('local-trace')
  })

  it('rejects a credential', () => {
    const result = writer.publishDomainMemory({
      identity: 'dir:global:machine',
      category: 'CONFIG_VALUES',
      content: 'The local provider key is sk-strata-abcdef123456789012345678.',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('shareable-check-failed')
  })

  it('accepts a clean fact', () => {
    const result = writer.publishDomainMemory({
      identity: 'dir:global:machine',
      category: 'CONSTRAINTS',
      content: 'Background tasks take a lease before writing, so two processes never run one task.',
    })
    expect(result.ok).toBe(true)
  })
})
