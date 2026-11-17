/**
 * `curate`: consolidation, and the two things it must never do.
 *
 * 1. **Never write in a dry run.** The dry run is the default and the only safe
 *    state; a task that "reports but also writes" is worse than no dry run.
 * 2. **Never let the model past the gate.** A confident merge verdict on a
 *    directive, or onto a successor that does not exist, must be refused and
 *    counted — not applied because the model sounded sure.
 *
 * Pair selection gets its own block because the failure it prevents is subtle:
 * a three-row near-duplicate cluster would otherwise offer (A,B) and (B,C), and
 * merging A into B then archiving B against C leaves A's fact on a dead row.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  parseDecisions,
  runCurateTick,
  selectCandidatePairs,
  type CurateLlm,
  type CurateVectorRow,
} from '../src/core/curate-memories.ts'
import { openMemoryWriter, type MemoryWriter } from '../src/core/memory-write.ts'
import type { Journal } from '../src/core/journal.ts'
import { buildCurateHandler } from '../src/dsh/dream-handlers.ts'

const NOW = 1_800_000_000_000
const IDENTITY = 'dir:curate-test'
const MODEL = 'test-embed'
const ROUTE = { provider: 'test', model: 'test-model' }

let dir: string
let writer: MemoryWriter
const reported: Array<{ level: string; kind: string; summary: string }> = []

const journal = {
  enabled: true,
  record: (level: string, kind: string, summary: string) => { reported.push({ level, kind, summary }) },
  info: (kind: string, summary: string) => { reported.push({ level: 'info', kind, summary }) },
  warn: (kind: string, summary: string) => { reported.push({ level: 'warn', kind, summary }) },
  error: (kind: string, summary: string) => { reported.push({ level: 'error', kind, summary }) },
  tail: () => [],
  byKind: () => [],
} as unknown as Journal

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mc-curate-'))
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

/** Insert a memory plus a 2-D vector, so similarity is trivially controllable. */
function insertMemory(input: {
  id: number
  content: string
  category?: string
  /** Angle in radians: equal angles → similarity 1. */
  angle: number
}): void {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(join(dir, 'memories.db'))
  db.prepare(
    `INSERT INTO memories(
       id, project_path, category, content, normalized_hash, importance, scope, shareable,
       source_type, seen_count, retrieval_count, first_seen_at, created_at, updated_at,
       last_seen_at, status, verification_status, verified_at
     ) VALUES(?, ?, ?, ?, ?, 60, 'project', 0, 'historian', 1, 0, ?, ?, ?, ?, 'active', 'verified', ?)`,
  ).run(
    input.id, IDENTITY, input.category ?? 'ARCHITECTURE', input.content,
    `hash-${String(input.id)}`, NOW - 1000, NOW - 1000, NOW - 1000, NOW - 1000, NOW - 1000,
  )
  const vector = new Float32Array([Math.cos(input.angle), Math.sin(input.angle)])
  db.prepare('INSERT INTO memory_embeddings(memory_id, embedding, model_id) VALUES(?, ?, ?)')
    .run(input.id, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), MODEL)
  db.close()
}

function stateOf(id: number): { status: string; content: string; supersededBy: number | null } | undefined {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(join(dir, 'memories.db'), { readOnly: true })
  try {
    const row = db.prepare('SELECT status, content, superseded_by_memory_id AS s FROM memories WHERE id = ?')
      .get(id) as { status: string; content: string; s: number | null } | undefined
    return row === undefined ? undefined : { status: row.status, content: row.content, supersededBy: row.s }
  } finally {
    db.close()
  }
}

function vectorRow(input: { id: number; content: string; category?: string; angle: number }): CurateVectorRow {
  return {
    id: input.id,
    category: input.category ?? 'ARCHITECTURE',
    content: input.content,
    importance: 60,
    seenCount: 1,
    createdAt: NOW - 1000,
    embedding: new Float32Array([Math.cos(input.angle), Math.sin(input.angle)]),
  }
}

function fakeLlm(answer: (prompt: string) => string | { fail: 'error' }): { llm: CurateLlm; prompts: string[] } {
  const prompts: string[] = []
  const llm: CurateLlm = {
    stream(options) {
      const text = (options.messages[0] as { content: Array<{ text: string }> }).content[0]!.text
      prompts.push(text)
      const reply = answer(text)
      return (async function* () {
        if (typeof reply !== 'string') {
          yield { type: 'finish', reason: { kind: reply.fail, failure: { message: 'stand-in' } } }
          return
        }
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'usage', usage: { inputTokens: 300, outputTokens: 60 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return { llm, prompts }
}

const baseDeps = () => ({
  writer, identity: IDENTITY, route: ROUTE, modelId: MODEL,
  sessionId: 'mc-dreamer', journal, now: () => NOW,
})

describe('selectCandidatePairs', () => {
  it('pairs rows above the floor', () => {
    const rows = [
      vectorRow({ id: 1, content: 'a', angle: 0 }),
      vectorRow({ id: 2, content: 'b', angle: 0.05 }),
      vectorRow({ id: 3, content: 'c', angle: 1.4 }),
    ]
    const pairs = selectCandidatePairs(rows, 0.9, 10)
    expect(pairs).toHaveLength(1)
    expect([pairs[0]?.a.id, pairs[0]?.b.id].sort()).toEqual([1, 2])
  })

  it('never pairs across categories', () => {
    const rows = [
      vectorRow({ id: 1, content: 'a', angle: 0, category: 'ARCHITECTURE' }),
      vectorRow({ id: 2, content: 'b', angle: 0, category: 'CONSTRAINTS' }),
    ]
    expect(selectCandidatePairs(rows, 0.9, 10)).toEqual([])
  })

  it('lets each row join at most one pair', () => {
    // Three near-identical rows: without the used-set this yields (1,2) and
    // (2,3), and merging 1→2 then 3→2 would leave 1's fact in a dead row.
    const rows = [
      vectorRow({ id: 1, content: 'a', angle: 0 }),
      vectorRow({ id: 2, content: 'b', angle: 0.01 }),
      vectorRow({ id: 3, content: 'c', angle: 0.02 }),
    ]
    const pairs = selectCandidatePairs(rows, 0.9, 10)
    expect(pairs).toHaveLength(1)
    const ids = pairs.flatMap(pair => [pair.a.id, pair.b.id])
    expect(new Set(ids).size).toBe(2)
  })

  it('prefers the strongest pair first', () => {
    const rows = [
      vectorRow({ id: 1, content: 'a', angle: 0 }),
      vectorRow({ id: 2, content: 'b', angle: 0.30 }),
      vectorRow({ id: 3, content: 'c', angle: 0.31 }),
    ]
    // (2,3) are closer than (1,2), so they win the single slot.
    const pairs = selectCandidatePairs(rows, 0.9, 1)
    expect([pairs[0]?.a.id, pairs[0]?.b.id].sort()).toEqual([2, 3])
  })

  it('skips vectors of different widths', () => {
    const a = vectorRow({ id: 1, content: 'a', angle: 0 })
    const b = { ...vectorRow({ id: 2, content: 'b', angle: 0 }), embedding: new Float32Array([1, 0, 0]) }
    expect(selectCandidatePairs([a, b], 0.5, 10)).toEqual([])
  })
})

describe('parseDecisions', () => {
  it('reads a manifest', () => {
    expect(parseDecisions('{"decisions":[{"archiveId":1,"keepId":2,"action":"merge","content":"x"}]}'))
      .toEqual([{ archiveId: 1, keepId: 2, action: 'merge', content: 'x' }])
  })

  it('salvages a truncated array', () => {
    expect(parseDecisions('{"decisions":[{"archiveId":1,"keepId":2,"action":"keep"},{"archiveId":3,'))
      .toEqual([{ archiveId: 1, keepId: 2, action: 'keep' }])
  })

  it('rejects an unknown action', () => {
    expect(parseDecisions('{"decisions":[{"archiveId":1,"keepId":2,"action":"delete"}]}')).toEqual([])
  })

  it('rejects missing ids', () => {
    expect(parseDecisions('{"decisions":[{"keepId":2,"action":"merge"}]}')).toEqual([])
  })
})

describe('runCurateTick — dry run is the default', () => {
  it('decides without writing when dryRun is unspecified', async () => {
    insertMemory({ id: 1, content: 'the scheduler tick is five minutes', angle: 0 })
    insertMemory({ id: 2, content: 'background tasks poll every five minutes', angle: 0.05 })
    const { llm } = fakeLlm(() => '{"decisions":[{"archiveId":1,"keepId":2,"action":"merge","content":"The scheduler tick is five minutes (background tasks poll every five minutes)."}]}')
    const outcome = await runCurateTick({ ...baseDeps(), llm })
    expect(outcome.dryRun).toBe(true)
    expect(outcome.merged).toBe(1)
    // Nothing changed on disk.
    expect(stateOf(1)?.status).toBe('active')
    expect(stateOf(1)?.content).toBe('the scheduler tick is five minutes')
    expect(stateOf(1)?.supersededBy).toBeNull()
  })

  it('applies the merge when dryRun is false', async () => {
    insertMemory({ id: 1, content: 'the scheduler tick is five minutes', angle: 0 })
    insertMemory({ id: 2, content: 'background tasks poll every five minutes', angle: 0.05 })
    const { llm } = fakeLlm(() => '{"decisions":[{"archiveId":1,"keepId":2,"action":"merge","content":"The scheduler tick is five minutes, and background tasks poll every five minutes."}]}')
    const outcome = await runCurateTick({ ...baseDeps(), llm, dryRun: false })
    expect(outcome.merged).toBe(1)
    // Source archived and superseded by the target; target carries the merged text.
    expect(stateOf(1)?.status).toBe('archived')
    expect(stateOf(1)?.supersededBy).toBe(2)
    expect(stateOf(2)?.content).toContain('poll every five minutes')
  })

  it('applies an archive when dryRun is false', async () => {
    insertMemory({ id: 1, content: 'the tick is five minutes', angle: 0 })
    insertMemory({ id: 2, content: 'the tick is five minutes long', angle: 0.04 })
    const { llm } = fakeLlm(() => '{"decisions":[{"archiveId":1,"keepId":2,"action":"archive","reason":"obsolete"}]}')
    const outcome = await runCurateTick({ ...baseDeps(), llm, dryRun: false })
    expect(outcome.archived).toBe(1)
    expect(stateOf(1)?.status).toBe('archived')
    expect(stateOf(1)?.supersededBy).toBe(2)
    // An archive keeps the target's text untouched.
    expect(stateOf(2)?.content).toBe('the tick is five minutes long')
  })
})

describe('runCurateTick — the gate holds', () => {
  it('refuses to merge a directive even when the model says so', async () => {
    insertMemory({ id: 1, content: 'Never push without approval', category: 'PROJECT_RULES', angle: 0 })
    insertMemory({ id: 2, content: 'Never push to main without approval', category: 'PROJECT_RULES', angle: 0.03 })
    const { llm } = fakeLlm(() => '{"decisions":[{"archiveId":1,"keepId":2,"action":"merge","content":"Never push without approval, especially to main."}]}')
    const outcome = await runCurateTick({ ...baseDeps(), llm, dryRun: false })
    expect(outcome.refused).toBe(1)
    expect(outcome.merged).toBe(0)
    expect(outcome.decisions[0]?.refusal?.reason).toBe('directive-shaped-project-rule')
    expect(stateOf(1)?.status).toBe('active')
  })

  it('refuses a merge whose text loses most of the original', async () => {
    insertMemory({ id: 1, content: 'The scheduler tick is five minutes and runs sequentially under a lease.', angle: 0 })
    insertMemory({ id: 2, content: 'Ticks take the memory lease first.', angle: 0.02 })
    const { llm } = fakeLlm(() => '{"decisions":[{"archiveId":1,"keepId":2,"action":"merge","content":"Tick 5m."}]}')
    const outcome = await runCurateTick({ ...baseDeps(), llm, dryRun: false })
    expect(outcome.refused).toBe(1)
    expect(outcome.decisions[0]?.refusal?.reason).toBe('content-loss')
    expect(stateOf(1)?.status).toBe('active')
  })

  it('drops a decision naming ids that were never offered', async () => {
    insertMemory({ id: 1, content: 'a fact one', angle: 0 })
    insertMemory({ id: 2, content: 'a fact two', angle: 0.02 })
    const { llm } = fakeLlm(() => '{"decisions":[{"archiveId":1,"keepId":99,"action":"archive"}]}')
    const outcome = await runCurateTick({ ...baseDeps(), llm, dryRun: false })
    expect(outcome.archived).toBe(0)
    expect(outcome.decisions[0]?.refusalReason).toBe('verdict-for-unoffered-pair')
    expect(stateOf(1)?.status).toBe('active')
  })

  it('records a merge verdict with no content as refused, not as a silent no-op', async () => {
    insertMemory({ id: 1, content: 'a fact about the tick', angle: 0 })
    insertMemory({ id: 2, content: 'another fact about the tick', angle: 0.03 })
    const { llm } = fakeLlm(() => '{"decisions":[{"archiveId":1,"keepId":2,"action":"merge"}]}')
    const outcome = await runCurateTick({ ...baseDeps(), llm, dryRun: false })
    expect(outcome.merged).toBe(0)
    // The gate catches it first and for a better reason: zero replacement
    // characters is the extreme case of content loss, so the refusal names the
    // real problem rather than reporting a write that never got attempted.
    expect(outcome.decisions[0]?.refusal?.reason).toBe('content-loss')
    expect(outcome.decisions[0]?.refusal?.replacementChars).toBe(0)
    expect(stateOf(1)?.status).toBe('active')
  })
})

describe('runCurateTick — write nothing on failure', () => {
  it('applies nothing when the call fails', async () => {
    insertMemory({ id: 1, content: 'a fact one', angle: 0 })
    insertMemory({ id: 2, content: 'a fact two', angle: 0.02 })
    const { llm } = fakeLlm(() => ({ fail: 'error' }))
    const outcome = await runCurateTick({ ...baseDeps(), llm, dryRun: false })
    expect(outcome.reason).toBe('llm-failed')
    expect(stateOf(1)?.status).toBe('active')
    expect(stateOf(2)?.status).toBe('active')
  })

  it('applies nothing when the manifest is unparsable', async () => {
    insertMemory({ id: 1, content: 'a fact one', angle: 0 })
    insertMemory({ id: 2, content: 'a fact two', angle: 0.02 })
    const { llm } = fakeLlm(() => 'no thanks')
    const outcome = await runCurateTick({ ...baseDeps(), llm, dryRun: false })
    expect(outcome.reason).toBe('parse-failed')
    expect(stateOf(1)?.status).toBe('active')
  })

  it('reports no-embedding-space rather than comparing nothing', async () => {
    insertMemory({ id: 1, content: 'a fact one', angle: 0 })
    const { llm } = fakeLlm(() => '{"decisions":[]}')
    const outcome = await runCurateTick({ ...baseDeps(), llm, modelId: undefined })
    expect(outcome.reason).toBe('no-embedding-space')
  })

  it('reports no-candidates when nothing is similar enough', async () => {
    insertMemory({ id: 1, content: 'a fact one', angle: 0 })
    insertMemory({ id: 2, content: 'unrelated', angle: 1.4 })
    const { llm } = fakeLlm(() => '{"decisions":[]}')
    const outcome = await runCurateTick({ ...baseDeps(), llm })
    expect(outcome.reason).toBe('no-candidates')
  })
})

describe('runCurateTick — remembered skips', () => {
  it('does not re-ask a pair the model declined', async () => {
    insertMemory({ id: 1, content: 'a fact one', angle: 0 })
    insertMemory({ id: 2, content: 'a fact two', angle: 0.02 })
    const { llm } = fakeLlm(() => '{"decisions":[{"archiveId":1,"keepId":2,"action":"skip"}]}')
    // Explicit apply mode: remembering a skip is itself a write, and a dry run
    // must not perform it (see the sibling test below).
    const first = await runCurateTick({ ...baseDeps(), dryRun: false, llm })
    expect(first.skipped).toBe(1)

    const second = await runCurateTick({ ...baseDeps(), dryRun: false, llm })
    // Both sides remembered, so the pair is gone from the candidate set.
    expect(second.reason).toBe('no-candidates')
  })

  it('a dry run does not remember the skip it declined', async () => {
    // The skip hash is the only thing that changes the next round's candidate
    // set, so writing it under `dryRun` made a "returns the decisions without
    // writing" mode mutate through a side door (code analysis 2026-11-17, P1-8).
    insertMemory({ id: 1, content: 'a fact one', angle: 0 })
    insertMemory({ id: 2, content: 'a fact two', angle: 0.02 })
    const { llm } = fakeLlm(() => '{"decisions":[{"archiveId":1,"keepId":2,"action":"skip"}]}')
    const first = await runCurateTick({ ...baseDeps(), dryRun: true, llm })
    expect(first.skipped).toBe(1)
    expect(first.dryRun).toBe(true)

    // Nothing was written, so the same pair is offered again.
    const second = await runCurateTick({ ...baseDeps(), dryRun: true, llm })
    expect(second.reason).not.toBe('no-candidates')
    expect(second.skipped).toBe(1)
  })
})

describe('buildCurateHandler', () => {
  const context = { projectPath: IDENTITY, now: NOW, tokenBudget: 150_000, log: () => {} }

  it('skips when no embedding space is available', async () => {
    const { llm } = fakeLlm(() => '{"decisions":[]}')
    const handler = buildCurateHandler({
      curate: { writer, llm, route: () => ROUTE, journal, sessionId: 'mc-dreamer', embeddingSpace: () => undefined },
    })
    const result = await handler(context)
    expect(result.status).toBe('skipped')
  })

  it('reports 0 changed in a dry run even when it decided something', async () => {
    insertMemory({ id: 1, content: 'the scheduler tick is five minutes', angle: 0 })
    insertMemory({ id: 2, content: 'background tasks poll every five minutes', angle: 0.05 })
    const { llm } = fakeLlm(() => '{"decisions":[{"archiveId":1,"keepId":2,"action":"merge","content":"The scheduler tick is five minutes; background tasks poll every five minutes."}]}')
    const handler = buildCurateHandler({
      curate: { writer, llm, route: () => ROUTE, journal, sessionId: 'mc-dreamer', embeddingSpace: () => MODEL },
    })
    const result = await handler(context)
    expect(result.status).toBe('ok')
    // A dashboard reading only itemsChanged must not show writes that did not happen.
    expect(result.itemsChanged).toBe(0)
    expect(result.summary).toContain('dry run')
  })
})
