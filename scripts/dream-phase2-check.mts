/**
 * Phase 2 acceptance: `classify-memories` against a COPY of the live corpus.
 *
 * Three things this proves that unit tests cannot:
 *
 *  1. The staleness window selects the right rows in the REAL pool — the live
 *     corpus has 894 active memories of which only a handful were never scored,
 *     because the verification sweep has been scoring as it verifies.
 *  2. Writing back really moves `importance` and stamps `classified_at` on rows
 *     that have been sitting in the corpus for weeks.
 *  3. A second run at the same instant picks a DIFFERENT set (or none), because
 *     the rows it just scored are no longer stale.
 *
 * The model is a stand-in that assigns a deterministic score from the row id. The
 * point here is the pipeline and the database, not prompt quality — a real model
 * is exercised separately, and a fake keeps this run reproducible.
 *
 * Run: node --experimental-strip-types scripts/dream-phase2-check.mts
 */
import { DatabaseSync } from 'node:sqlite'
import { openMemoryWriter } from '../src/core/memory-write.ts'
import { runClassifyTick, type ClassifyLlm } from '../src/core/classify-memories.ts'
import type { Journal } from '../src/core/journal.ts'
import { buildClassifyHandler } from '../src/dsh/dream-handlers.ts'

const DATA_DIR = 'C:/tmp/dream-verify'
const DB_PATH = `${DATA_DIR}/memories.db`
const PROJECT = 'dir:addef9f024b0'
const NOW = Date.now()
const STALE_AFTER = 14 * 24 * 60 * 60 * 1000

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

/** Journal stand-in: records what was reported, so the run can be audited. */
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

/**
 * Deterministic stand-in: spread scores across the whole 1..100 band using the
 * row id, which is exactly the discrimination the real prompt is asking for.
 * It records the ids it was shown so the test can prove the prompt contained
 * only in-window rows.
 */
const seenIds: number[][] = []
const fakeLlm: ClassifyLlm = {
  stream(options) {
    const text = (options.messages[0] as { content: Array<{ text: string }> }).content[0]!.text
    const ids = [...text.matchAll(/^- id (\d+) /gm)].map(match => Number(match[1]))
    seenIds.push(ids)
    const scores = ids.map(id => ({ id, importance: 5 + (id * 17) % 95 }))
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ scores }) }
      yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 300 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}

function snapshot(): Map<number, { importance: number; classifiedAt: number | null }> {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  try {
    const rows = db.prepare(
      "SELECT id, importance, classified_at FROM memories WHERE project_path = ? AND status IN ('active','permanent')",
    ).all(PROJECT) as Array<{ id: number; importance: number | null; classified_at: number | null }>
    return new Map(rows.map(row => [Number(row.id), {
      importance: Number(row.importance ?? 50),
      classifiedAt: row.classified_at,
    }]))
  } finally {
    db.close()
  }
}

function write(sql: string, ...params: unknown[]): number {
  const db = new DatabaseSync(DB_PATH)
  try {
    return Number(db.prepare(sql).run(...params).changes)
  } finally {
    db.close()
  }
}

// ── 1. The live corpus's classification state ───────────────────────────────
section('1. live corpus state')
const before = snapshot()
const neverScored = [...before.values()].filter(row => row.classifiedAt === null).length
const staleCutoff = NOW - STALE_AFTER
const staleNow = [...before.values()].filter(row => row.classifiedAt !== null && row.classifiedAt <= staleCutoff).length
console.log(`project ${PROJECT}: ${String(before.size)} active rows`)
console.log(`  never scored:      ${String(neverScored)}`)
console.log(`  scored >14d ago:   ${String(staleNow)}`)

const bands = (() => {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  try {
    return db.prepare(
      "SELECT CASE WHEN importance < 40 THEN '1-39' WHEN importance < 60 THEN '40-59' "
        + "WHEN importance < 80 THEN '60-79' ELSE '80-100' END AS band, COUNT(*) AS n "
        + "FROM memories WHERE project_path = ? AND status IN ('active','permanent') GROUP BY band ORDER BY band",
    ).all(PROJECT) as Array<{ band: string; n: number }>
  } finally {
    db.close()
  }
})()
console.log(`  current bands: ${bands.map(b => `${b.band}=${String(b.n)}`).join(' ')}`)

const writer = openMemoryWriter({
  dbPath: DB_PATH,
  logger: { info: () => {}, warn: () => {} },
  now: () => NOW,
})

// ── 2. Run 1: the never-scored rows ─────────────────────────────────────────
section('2. run 1 — the never-scored rows')
const run1 = await runClassifyTick({
  writer,
  identity: PROJECT,
  llm: fakeLlm,
  route: { provider: 'stand-in', model: 'deterministic' },
  sessionId: 'mc-dreamer',
  journal,
  now: () => NOW,
  staleAfterMs: STALE_AFTER,
})
console.log(`stale pool=${String(run1.stale)} scanned=${String(run1.scanned)} scored=${String(run1.scored)} tokens=${String(run1.tokensUsed)}`)
console.log(`prompt carried ids: ${JSON.stringify(seenIds[0])}`)
console.log(`journal: ${JSON.stringify(reported.filter(r => r.kind === 'dream-classify').slice(-1))}`)

const after1 = snapshot()
const changed1 = [...after1.entries()].filter(([id, row]) => {
  const old = before.get(id)
  return old !== undefined && (old.importance !== row.importance || old.classifiedAt !== row.classifiedAt)
})
console.log(`rows changed: ${String(changed1.length)}`)
console.log(`sample: ${JSON.stringify(changed1.slice(0, 4).map(([id, row]) => ({
  id, from: before.get(id)?.importance, to: row.importance, stamped: row.classifiedAt,
})))}`)

// ── 3. Run 2 at the same instant: nothing left to do ────────────────────────
section('3. run 2 at the same instant — idempotent')
const run2 = await runClassifyTick({
  writer, identity: PROJECT, llm: fakeLlm, route: { provider: 'stand-in', model: 'deterministic' },
  sessionId: 'mc-dreamer', journal, now: () => NOW, staleAfterMs: STALE_AFTER,
})
console.log(`reason=${String(run2.reason)} scanned=${String(run2.scanned)} scored=${String(run2.scored)} tokens=${String(run2.tokensUsed)}`)

// ── 4. Age a slice of the corpus and prove the window reopens ───────────────
section('4. age 40 rows past the window — the task must pick them up again')
const aged = write(
  'UPDATE memories SET classified_at = ? WHERE id IN ('
    + "SELECT id FROM memories WHERE project_path = ? AND status IN ('active','permanent') "
    + 'ORDER BY id LIMIT 40)',
  NOW - STALE_AFTER - 86_400_000,
  PROJECT,
)
console.log(`rows aged out of the window: ${String(aged)}`)
const run3 = await runClassifyTick({
  writer, identity: PROJECT, llm: fakeLlm, route: { provider: 'stand-in', model: 'deterministic' },
  sessionId: 'mc-dreamer', journal, now: () => NOW, staleAfterMs: STALE_AFTER,
})
console.log(`stale pool=${String(run3.stale)} scanned=${String(run3.scanned)} scored=${String(run3.scored)}`)
console.log(`prompt carried ids: ${JSON.stringify(seenIds[seenIds.length - 1])}`)

// ── 5. Failure paths leave the corpus untouched ─────────────────────────────
section('5. a failing model writes nothing')
write(
  'UPDATE memories SET classified_at = NULL WHERE id IN ('
    + "SELECT id FROM memories WHERE project_path = ? AND status IN ('active','permanent') ORDER BY id LIMIT 5)",
  PROJECT,
)
const beforeFailure = snapshot()
const failingLlm: ClassifyLlm = {
  stream() {
    return (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'stand-in failure' } } }
    })()
  },
}
const run4 = await runClassifyTick({
  writer, identity: PROJECT, llm: failingLlm, route: { provider: 'stand-in', model: 'deterministic' },
  sessionId: 'mc-dreamer', journal, now: () => NOW, staleAfterMs: STALE_AFTER,
})
const afterFailure = snapshot()
const drifted = [...beforeFailure.entries()].filter(([id, row]) => {
  const now = afterFailure.get(id)
  return now === undefined || now.importance !== row.importance || now.classifiedAt !== row.classifiedAt
})
console.log(`reason=${String(run4.reason)} scored=${String(run4.scored)}`)
console.log(`rows drifted by a failed run: ${String(drifted.length)} (must be 0)`)

// ── 6. The handler the runner actually calls ────────────────────────────────
section('6. handler contract')
const handler = buildClassifyHandler({
  classify: {
    writer, llm: fakeLlm, route: () => ({ provider: 'stand-in', model: 'deterministic' }),
    journal, sessionId: 'mc-dreamer', staleAfterMs: STALE_AFTER,
  },
})
const context = { projectPath: PROJECT, now: NOW, tokenBudget: 120_000, log: () => {} }
console.log(`with a route:    ${JSON.stringify(await handler(context))}`)
const noRoute = buildClassifyHandler({
  classify: {
    writer, llm: fakeLlm, route: () => undefined,
    journal, sessionId: 'mc-dreamer', staleAfterMs: STALE_AFTER,
  },
})
console.log(`without a route: ${JSON.stringify(await noRoute(context))}`)

writer.close()
console.log('\n=== phase 2 acceptance: complete ===')
