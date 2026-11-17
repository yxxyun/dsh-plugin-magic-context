/**
 * `verify`: checking memories against the files they cite.
 *
 * The claims worth testing are about the pool and about refusal:
 *
 * - The pool is "unverified AND cites a file". A row with no reference belongs to
 *   the maintenance sweep, and counting it here would make the run look like it
 *   skipped work it was never asked to do.
 * - Evidence that is AMBIGUOUS never becomes a verdict. The task must not turn a
 *   filename collision into a confident judgement.
 * - A failed call or bad manifest applies nothing — same rule as classify, and
 *   for a stronger reason: a wrong `archive` verdict deletes a fact.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseVerdicts, runVerifyTick, type VerifyLlm } from '../src/core/verify-memories.ts'
import { openMemoryWriter, memoryContentHash, type MemoryWriter } from '../src/core/memory-write.ts'
import type { Journal } from '../src/core/journal.ts'
import { buildVerifyHandler } from '../src/dsh/dream-handlers.ts'
import { DEFAULT_DREAM_CONFIG } from '../src/dsh/dream-config.ts'

const NOW = 1_800_000_000_000
const IDENTITY = 'dir:verify-test'
const ROUTE = { provider: 'test', model: 'test-model' }

let dir: string
let projectRoot: string
let writer: MemoryWriter
const reported: Array<{ level: string; kind: string; summary: string; data?: Record<string, unknown> }> = []

const journal = {
  enabled: true,
  record: (level: string, kind: string, summary: string, data?: Record<string, unknown>) => {
    reported.push({ level, kind, summary, ...data === undefined ? {} : { data } })
  },
  info: (kind: string, summary: string, data?: Record<string, unknown>) => {
    reported.push({ level: 'info', kind, summary, ...data === undefined ? {} : { data } })
  },
  warn: (kind: string, summary: string, data?: Record<string, unknown>) => {
    reported.push({ level: 'warn', kind, summary, ...data === undefined ? {} : { data } })
  },
  error: (kind: string, summary: string, data?: Record<string, unknown>) => {
    reported.push({ level: 'error', kind, summary, ...data === undefined ? {} : { data } })
  },
  tail: () => [],
  byKind: () => [],
} as unknown as Journal

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mc-verify-'))
  projectRoot = join(dir, 'project')
  mkdirSync(projectRoot, { recursive: true })
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
  verification?: 'unverified' | 'verified'
  metadata?: string | null
}): void {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(join(dir, 'memories.db'))
  db.prepare(
    `INSERT INTO memories(
       id, project_path, category, content, normalized_hash, importance, scope, shareable,
       source_type, seen_count, retrieval_count, first_seen_at, created_at, updated_at,
       last_seen_at, status, verification_status, verified_at, metadata_json
     ) VALUES(?, ?, 'CONSTRAINTS', ?, ?, 50, 'project', 0, 'historian', 1, 0, ?, ?, ?, ?, 'active', ?, NULL, ?)`,
  ).run(
    input.id, IDENTITY, input.content, `hash-${String(input.id)}`,
    NOW - 1000, NOW - 1000, NOW - 1000, NOW - 1000,
    input.verification ?? 'unverified',
    input.metadata ?? null,
  )
  db.close()
}

function makeFile(relativePath: string, lines: number): void {
  const absolute = join(projectRoot, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, Array.from({ length: lines }, (_, i) => `L${String(i + 1)}`).join('\n'), 'utf8')
}

function stateOf(id: number): { status: string; verification: string | null; content: string } | undefined {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(join(dir, 'memories.db'), { readOnly: true })
  try {
    const row = db.prepare('SELECT status, verification_status, content FROM memories WHERE id = ?').get(id) as
      | { status: string; verification_status: string | null; content: string }
      | undefined
    return row === undefined ? undefined : { status: row.status, verification: row.verification_status, content: row.content }
  } finally {
    db.close()
  }
}

/** Records the prompt and answers with whatever the test hands back. */
function fakeLlm(answer: (prompt: string) => string | { fail: 'error' }): { llm: VerifyLlm; prompts: string[] } {
  const prompts: string[] = []
  const llm: VerifyLlm = {
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
        yield { type: 'usage', usage: { inputTokens: 400, outputTokens: 80 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return { llm, prompts }
}

const baseDeps = () => ({
  writer, identity: IDENTITY, projectRoot, route: ROUTE, sessionId: 'mc-dreamer',
  journal, now: () => NOW,
})

describe('parseVerdicts', () => {
  it('reads a manifest', () => {
    expect(parseVerdicts('{"verdicts":[{"id":1,"verdict":"verified"}]}'))
      .toEqual([{ id: 1, verdict: 'verified' }])
  })

  it('keeps content and reason when present', () => {
    expect(parseVerdicts('{"verdicts":[{"id":2,"verdict":"stale","content":"new text"},{"id":3,"verdict":"wrong","reason":"gone"}]}'))
      .toEqual([{ id: 2, verdict: 'stale', content: 'new text' }, { id: 3, verdict: 'wrong', reason: 'gone' }])
  })

  it('salvages a truncated array', () => {
    expect(parseVerdicts('{"verdicts":[{"id":1,"verdict":"verified"},{"id":2,"verdi'))
      .toEqual([{ id: 1, verdict: 'verified' }])
  })

  it('drops malformed entries', () => {
    expect(parseVerdicts('{"verdicts":[{"verdict":"verified"},{"id":"3","verdict":"verified"},{"id":4}]}')).toEqual([])
  })

  it('returns nothing for prose', () => {
    expect(parseVerdicts('no verdicts here')).toEqual([])
  })
})

describe('runVerifyTick — the pool', () => {
  it('takes every unverified row, with or without file references', async () => {
    // This lane used to take only rows citing a file, leaving the rest to the
    // 30-minute maintenance sweep — two lanes on one pool, and the sweep always
    // won. Upstream has a single `verify`, so the task now owns all of it: a row
    // without references simply arrives with no evidence block.
    makeFile('director.py', 10)
    insertMemory({ id: 1, content: 'director.py:5 gates the ratio' })
    insertMemory({ id: 2, content: 'a fact with no file reference at all' })
    insertMemory({ id: 3, content: 'director.py is verified already', verification: 'verified' })

    const { llm, prompts } = fakeLlm(() => '{"verdicts":[{"id":1,"verdict":"verified"},{"id":2,"verdict":"verified"}]}')
    const outcome = await runVerifyTick({ ...baseDeps(), llm })
    expect(outcome.scanned).toBe(2)
    expect(prompts[0]).toContain('- id 1')
    expect(prompts[0]).toContain('- id 2')
    // An already-verified row is not the task's business.
    expect(prompts[0]).not.toContain('- id 3')
    // id 2 has no evidence block; id 1 does.
    expect(prompts[0]).toContain('FOUND at director.py')
  })

  it('reports empty-pool only when nothing is unverified', async () => {
    insertMemory({ id: 1, content: 'no references here', verification: 'verified' })
    const { llm } = fakeLlm(() => '{"verdicts":[]}')
    const outcome = await runVerifyTick({ ...baseDeps(), llm })
    expect(outcome.reason).toBe('empty-pool')
  })

  it('refuses to archive a row that cites no file', async () => {
    // With no evidence there is nothing that could contradict the claim, so the
    // only safe verdicts are verified/skip. A model that says "wrong" is
    // overruled mechanically, not by trusting the prompt.
    insertMemory({ id: 1, content: 'a general fact with no file reference' })
    const { llm } = fakeLlm(() => '{"verdicts":[{"id":1,"verdict":"wrong","reason":"cannot confirm"}]}')
    const outcome = await runVerifyTick({ ...baseDeps(), llm })
    expect(outcome.archived).toBe(0)
    expect(outcome.skipped).toBe(1)
    expect(stateOf(1)?.status).toBe('active')
  })

  it('steps over a remembered skip', async () => {
    makeFile('a.py', 5)
    // The sweep already decided this text cannot be judged; the skip is keyed by
    // the current content hash.
    insertMemory({
      id: 1, content: 'a.py:2 might be right',
      metadata: JSON.stringify({ verify_skip: { hash: memoryContentHash('a.py:2 might be right'), at: NOW } }),
    })
    const { llm } = fakeLlm(() => '{"verdicts":[{"id":1,"verdict":"verified"}]}')
    const outcome = await runVerifyTick({ ...baseDeps(), llm })
    expect(outcome.reason).toBe('empty-pool')
  })

  it('reports no-project-root instead of reading nothing', async () => {
    insertMemory({ id: 1, content: 'a.py:2' })
    const { llm } = fakeLlm(() => '{"verdicts":[]}')
    const outcome = await runVerifyTick({ ...baseDeps(), llm, projectRoot: undefined })
    // Without a root every reference would read as missing, which is a verdict
    // assembled from a missing measurement.
    expect(outcome.reason).toBe('no-project-root')
  })
})

describe('runVerifyTick — evidence reaches the prompt', () => {
  it('carries the cited lines', async () => {
    makeFile('director.py', 10)
    insertMemory({ id: 1, content: 'director.py:7 is the gate' })
    const { llm, prompts } = fakeLlm(() => '{"verdicts":[{"id":1,"verdict":"verified"}]}')
    const outcome = await runVerifyTick({ ...baseDeps(), llm })
    expect(prompts[0]).toContain('FOUND at director.py')
    expect(prompts[0]).toContain('7: L7')
    expect(outcome.referencesFound).toBe(1)
    expect(outcome.referencesMissing).toBe(0)
  })

  it('reports a vanished file as missing evidence', async () => {
    insertMemory({ id: 1, content: 'ghost.py:3 defines it' })
    const { llm, prompts } = fakeLlm(() => '{"verdicts":[{"id":1,"verdict":"stale","content":"rewritten"}]}')
    const outcome = await runVerifyTick({ ...baseDeps(), llm })
    expect(prompts[0]).toContain('NOT FOUND')
    expect(outcome.referencesMissing).toBe(1)
  })

  it('does not pick between duplicate filenames', async () => {
    makeFile('x/a.py', 3)
    makeFile('y/a.py', 3)
    insertMemory({ id: 1, content: 'a.py:1 is the entry point' })
    const { llm, prompts } = fakeLlm(() => '{"verdicts":[{"id":1,"verdict":"skip"}]}')
    const outcome = await runVerifyTick({ ...baseDeps(), llm })
    expect(prompts[0]).toContain('AMBIGUOUS')
    expect(outcome.referencesAmbiguous).toBe(1)
    // The ambiguity is reported, not resolved into a confident verdict.
    expect(stateOf(1)?.verification).toBe('unverified')
  })
})

describe('runVerifyTick — extra roots (work touching a sibling repo)', () => {
  /** A second tree, standing in for the other repository a memory describes. */
  let sibling: string

  beforeEach(() => {
    sibling = join(dir, 'sibling')
    mkdirSync(sibling, { recursive: true })
  })

  const makeInSibling = (relativePath: string, lines: number): void => {
    const absolute = join(sibling, relativePath)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, Array.from({ length: lines }, (_, i) => `S${String(i + 1)}`).join('\n'), 'utf8')
  }

  it('finds a cited file in an extra root', async () => {
    // This is the ordinary case: the memory was written in one project and names
    // a file that lives in another.
    makeInSibling('lib/guard.ts', 40)
    insertMemory({ id: 1, content: 'lib/guard.ts:12 refuses unsafe shares' })
    const { llm, prompts } = fakeLlm(() => '{"verdicts":[{"id":1,"verdict":"verified"}]}')
    const outcome = await runVerifyTick({ ...baseDeps(), llm, extraRoots: [sibling] })
    expect(prompts[0]).toContain('FOUND at lib/guard.ts')
    expect(prompts[0]).toContain('12: S12')
    expect(outcome.referencesFound).toBe(1)
    expect(outcome.referencesMissing).toBe(0)
    expect(outcome.verified).toBe(1)
  })

  it('reports missing only when no root has it', async () => {
    insertMemory({ id: 1, content: 'lib/absent.ts:3 defines it' })
    const { llm, prompts } = fakeLlm(() => '{"verdicts":[{"id":1,"verdict":"skip"}]}')
    const outcome = await runVerifyTick({ ...baseDeps(), llm, extraRoots: [sibling] })
    expect(prompts[0]).toContain('NOT FOUND')
    expect(outcome.referencesMissing).toBe(1)
  })

  it('stays ambiguous when two roots both have the name', async () => {
    // A `guard.ts` in two repositories is a coincidence, not evidence. Resolving
    // it either way would turn that coincidence into a verdict.
    makeFile('guard.ts', 10)
    makeInSibling('guard.ts', 10)
    insertMemory({ id: 1, content: 'guard.ts:2 is the entry point' })
    const { llm, prompts } = fakeLlm(() => '{"verdicts":[{"id":1,"verdict":"skip"}]}')
    const outcome = await runVerifyTick({ ...baseDeps(), llm, extraRoots: [sibling] })
    expect(prompts[0]).toContain('AMBIGUOUS')
    expect(outcome.referencesAmbiguous).toBe(1)
  })

  it('prefers nothing when the project root alone has it', async () => {
    makeFile('guard.ts', 10)
    insertMemory({ id: 1, content: 'guard.ts:4 is the gate' })
    const { llm, prompts } = fakeLlm(() => '{"verdicts":[{"id":1,"verdict":"verified"}]}')
    const outcome = await runVerifyTick({ ...baseDeps(), llm, extraRoots: [sibling] })
    expect(prompts[0]).toContain('FOUND at guard.ts')
    expect(outcome.referencesFound).toBe(1)
  })

  it('still refuses an archive that rests only on absence, across roots', async () => {
    // The extra roots do not weaken the guard: three missing references in every
    // visible tree is still not grounds for an irreversible archive.
    insertMemory({ id: 1, content: 'lib/a.ts:1, lib/b.ts:2 and lib/c.ts:3 are gone' })
    const { llm } = fakeLlm(() => '{"verdicts":[{"id":1,"verdict":"wrong","reason":"none of these exist"}]}')
    const outcome = await runVerifyTick({ ...baseDeps(), llm, extraRoots: [sibling] })
    expect(outcome.archived).toBe(0)
    expect(outcome.skipped).toBe(1)
    expect(stateOf(1)?.status).toBe('active')
  })
})

describe('runVerifyTick — applying verdicts', () => {
  it('marks a verified row', async () => {
    makeFile('a.py', 5)
    insertMemory({ id: 1, content: 'a.py:2 is right' })
    const { llm } = fakeLlm(() => '{"verdicts":[{"id":1,"verdict":"verified"}]}')
    const outcome = await runVerifyTick({ ...baseDeps(), llm })
    expect(outcome.verified).toBe(1)
    expect(stateOf(1)?.verification).toBe('verified')
  })

  it('rewrites a stale row through the contract action', async () => {
    makeFile('a.py', 5)
    insertMemory({ id: 1, content: 'a.py:2 is wrong now' })
    const { llm } = fakeLlm(() => '{"verdicts":[{"id":1,"verdict":"stale","content":"a.py:3 is the gate"}]}')
    const outcome = await runVerifyTick({ ...baseDeps(), llm })
    expect(outcome.updated).toBe(1)
    expect(stateOf(1)?.content).toBe('a.py:3 is the gate')
  })

  it('downgrades an absence-only archive to a skip', async () => {
    // The memory cites files that do not exist here — which is also what a
    // memory describing a SIBLING repository looks like. Archiving on that is
    // irreversible, so the host refuses regardless of how sure the model was.
    insertMemory({ id: 1, content: 'the guard lives in src/core/guard.ts:12 and calls allow()' })
    const { llm, prompts } = fakeLlm(() => '{"verdicts":[{"id":1,"verdict":"wrong","reason":"file does not exist"}]}')
    const outcome = await runVerifyTick({ ...baseDeps(), llm })
    expect(prompts[0]).toContain('NOT FOUND')
    expect(outcome.archived).toBe(0)
    expect(outcome.skipped).toBe(1)
    expect(stateOf(1)?.status).toBe('active')
    expect(stateOf(1)?.verification).toBe('unverified')
  })

  it('still archives when the evidence actively contradicts', async () => {
    // A file that EXISTS but whose cited line is past the end is contradiction,
    // not absence — that one may be archived.
    makeFile('short.py', 3)
    insertMemory({ id: 1, content: 'short.py:900 defines the entry point' })
    const { llm } = fakeLlm(() => '{"verdicts":[{"id":1,"verdict":"wrong","reason":"line 900 is past the end"}]}')
    const outcome = await runVerifyTick({ ...baseDeps(), llm })
    expect(outcome.archived).toBe(1)
    expect(stateOf(1)?.status).toBe('archived')
  })

  it('archives a wrong row', async () => {
    makeFile('a.py', 5)
    insertMemory({ id: 1, content: 'a.py:99 does not exist' })
    const { llm } = fakeLlm(() => '{"verdicts":[{"id":1,"verdict":"wrong","reason":"line is past the end"}]}')
    const outcome = await runVerifyTick({ ...baseDeps(), llm })
    expect(outcome.archived).toBe(1)
    expect(stateOf(1)?.status).toBe('archived')
  })

  it('remembers a skip so the next run does not re-ask', async () => {
    makeFile('a.py', 5)
    insertMemory({ id: 1, content: 'a.py:2 depends on judgement' })
    const { llm } = fakeLlm(() => '{"verdicts":[{"id":1,"verdict":"skip"}]}')
    await runVerifyTick({ ...baseDeps(), llm })
    expect(stateOf(1)?.verification).toBe('unverified')
    // Second run: the skip is remembered against the unchanged content.
    const second = await runVerifyTick({ ...baseDeps(), llm })
    expect(second.reason).toBe('empty-pool')
  })

  it('drops a verdict for a row that was never sent', async () => {
    makeFile('a.py', 5)
    insertMemory({ id: 1, content: 'a.py:2 is right' })
    insertMemory({ id: 2, content: 'no reference, never sent', verification: 'verified' })
    const { llm } = fakeLlm(() => '{"verdicts":[{"id":1,"verdict":"verified"},{"id":2,"verdict":"wrong","reason":"x"}]}')
    const outcome = await runVerifyTick({ ...baseDeps(), llm })
    expect(outcome.archived).toBe(0)
    expect(stateOf(2)?.status).toBe('active')
  })
})

describe('runVerifyTick — write nothing on failure', () => {
  it('applies nothing when the call fails', async () => {
    makeFile('a.py', 5)
    insertMemory({ id: 1, content: 'a.py:2 is right' })
    const { llm } = fakeLlm(() => ({ fail: 'error' }))
    const outcome = await runVerifyTick({ ...baseDeps(), llm })
    expect(outcome.reason).toBe('llm-failed')
    expect(stateOf(1)?.verification).toBe('unverified')
    expect(stateOf(1)?.status).toBe('active')
  })

  it('applies nothing when the manifest is unparsable', async () => {
    makeFile('a.py', 5)
    insertMemory({ id: 1, content: 'a.py:2 is right' })
    const { llm } = fakeLlm(() => 'I decline.')
    const outcome = await runVerifyTick({ ...baseDeps(), llm })
    expect(outcome.reason).toBe('parse-failed')
    expect(stateOf(1)?.verification).toBe('unverified')
  })
})

describe('buildVerifyHandler', () => {
  const context = { projectPath: IDENTITY, now: NOW, tokenBudget: 200_000, log: () => {} }

  it('skips when the project has no registered directory', async () => {
    const { llm } = fakeLlm(() => '{"verdicts":[]}')
    const handler = buildVerifyHandler({
      verify: { writer, llm, route: () => ROUTE, journal, sessionId: 'mc-dreamer', projectRootOf: () => undefined },
    })
    const result = await handler(context)
    expect(result.status).toBe('skipped')
    expect(result.tokensUsed).toBe(0)
  })

  it('reads the live config at run time, not at mount', async () => {
    // The whole point of the `config` getter: a settings edit applies to the
    // NEXT run. A handler that captured `extraRoots` at construction would keep
    // reporting the file as missing forever.
    const sibling = join(dir, 'late-root')
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, 'late.ts'), 'L1\nL2\n', 'utf8')
    insertMemory({ id: 1, content: 'late.ts:2 is the marker' })

    let roots: string[] = []
    // Each run gets its own row: the first would otherwise be remembered as a
    // skip (correctly) and the second run would find an empty pool instead of
    // exercising the new roots.
    const { llm } = fakeLlm(() => '{"verdicts":[{"id":1,"verdict":"verified"}]}')
    const handler = buildVerifyHandler({
      verify: {
        writer, llm, route: () => ROUTE, journal, sessionId: 'mc-dreamer',
        projectRootOf: () => projectRoot,
        config: () => ({ ...DEFAULT_DREAM_CONFIG, verifyExtraRoots: roots }),
      },
    })

    const first = await handler(context)
    expect(first.summary).toContain('0 refs found')

    // The edit happens after the handler was built.
    roots = [sibling]
    insertMemory({ id: 2, content: 'late.ts:2 is the marker (second row)' })
    const second = await handler(context)
    expect(second.summary).toContain('1 refs found')
  })

  it('reports ok with counts on a successful run', async () => {
    makeFile('a.py', 5)
    insertMemory({ id: 1, content: 'a.py:2 is right' })
    const { llm } = fakeLlm(() => '{"verdicts":[{"id":1,"verdict":"verified"}]}')
    const handler = buildVerifyHandler({
      verify: { writer, llm, route: () => ROUTE, journal, sessionId: 'mc-dreamer', projectRootOf: () => projectRoot },
    })
    const result = await handler(context)
    expect(result.status).toBe('ok')
    expect(result.itemsChanged).toBe(1)
    expect(result.summary).toContain('1 verified')
  })

  it('fails when the model call failed', async () => {
    makeFile('a.py', 5)
    insertMemory({ id: 1, content: 'a.py:2 is right' })
    const { llm } = fakeLlm(() => ({ fail: 'error' }))
    const handler = buildVerifyHandler({
      verify: { writer, llm, route: () => ROUTE, journal, sessionId: 'mc-dreamer', projectRootOf: () => projectRoot },
    })
    const result = await handler(context)
    expect(result.status).toBe('failed')
    expect(result.error).toBe('llm-failed')
  })
})

