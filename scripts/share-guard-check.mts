/**
 * The sharing gate against the LIVE corpus.
 *
 * The question: if a model decided every memory was worth sharing (the most
 * permissive answer possible), what would actually reach other projects?
 *
 * That is the worst case for "automate instead of asking a human", so it is the
 * case worth measuring. The stand-in below answers `shareable: true` for
 * everything and the gate has to hold the line on its own.
 *
 * Run: node --experimental-strip-types scripts/share-guard-check.mts
 */
import { DatabaseSync } from 'node:sqlite'
import { openMemoryWriter } from '../src/core/memory-write.ts'
import { runClassifyTick, type ClassifyLlm } from '../src/core/classify-memories.ts'
import type { Journal } from '../src/core/journal.ts'

const DB_PATH = 'C:/tmp/dream-verify/memories.db'
const PROJECT = 'dir:addef9f024b0'
const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

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

const writer = openMemoryWriter({
  dbPath: DB_PATH,
  logger: { info: () => {}, warn: () => {} },
  now: () => NOW,
})

// ── 1. Reset the copy so every row is a fresh classification ───────────────
section('1. reset the copy to "never classified, private"')
const reset = (() => {
  const db = new DatabaseSync(DB_PATH)
  try {
    const active = db.prepare(
      "UPDATE memories SET classified_at = NULL, shareable = 0, scope = 'project' "
        + "WHERE project_path = ? AND status IN ('active','permanent')",
    ).run(PROJECT)
    // The four already-published rows keep their publication: the point is to
    // see what NEW sharing would happen, not to re-litigate the existing four.
    db.prepare("UPDATE memories SET shareable = 1, scope = 'universe' WHERE project_path LIKE 'dir:global:%'").run()
    return Number(active.changes)
  } finally {
    db.close()
  }
})()
console.log(`rows reset to private: ${String(reset)}`)

// ── 2. A maximally permissive model ────────────────────────────────────────
section('2. a stand-in that says "share everything"')
const permissive: ClassifyLlm = {
  stream(options) {
    const text = (options.messages[0] as { content: Array<{ text: string }> }).content[0]!.text
    const ids = [...text.matchAll(/^- id (\d+) /gm)].map(match => Number(match[1]))
    const scores = ids.map(id => ({ id, importance: 60, scope: 'universe', shareable: true }))
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ scores }) }
      yield { type: 'usage', usage: { inputTokens: 4000, outputTokens: 600 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}

// The batch is bounded; run several passes so the whole pool is exercised.
let totalScored = 0
let totalShared = 0
let totalBlocked = 0
const reasons = new Map<string, number>()
for (let pass = 0; pass < 8; pass += 1) {
  const outcome = await runClassifyTick({
    writer, identity: PROJECT, llm: permissive,
    route: { provider: 'stand-in', model: 'share-everything' },
    sessionId: 'mc-dreamer', journal, now: () => NOW, staleAfterMs: 14 * DAY,
    batchSize: 40,
  })
  if (outcome.reason !== undefined) {
    console.log(`pass ${String(pass + 1)}: stop (${outcome.reason})`)
    break
  }
  totalScored += outcome.scored
  totalShared += outcome.shared ?? 0
  totalBlocked += outcome.blockedByGuard ?? 0
  const last = reported.filter(entry => entry.kind === 'dream-classify').pop()
  const blockedReasons = last?.data?.blockedReasons as Record<string, number> | undefined
  for (const [key, value] of Object.entries(blockedReasons ?? {})) {
    reasons.set(key, (reasons.get(key) ?? 0) + Number(value))
  }
  console.log(`pass ${String(pass + 1)}: scored=${String(outcome.scored)} shared=${String(outcome.shared ?? 0)} blocked=${String(outcome.blockedByGuard ?? 0)}`)
}

// ── 3. What actually became visible ────────────────────────────────────────
section('3. result')
console.log(`scored:  ${String(totalScored)}`)
console.log(`shared:  ${String(totalShared)}`)
console.log(`blocked: ${String(totalBlocked)}  (${totalScored === 0 ? '0' : ((totalBlocked / (totalShared + totalBlocked)) * 100).toFixed(1)}% of the "share it" answers)`)
console.log(`by reason: ${JSON.stringify([...reasons.entries()].sort((a, b) => b[1] - a[1]))}`)

const db = new DatabaseSync(DB_PATH, { readOnly: true })
const sharedRows = db.prepare(
  `SELECT id, category, substr(content, 1, 100) AS head FROM memories
    WHERE project_path = ? AND shareable = 1 AND status IN ('active','permanent')`,
).all(PROJECT) as Array<{ id: number; category: string; head: string }>
db.close()
console.log(`\nrows now shared in this project: ${String(sharedRows.length)}`)
for (const row of sharedRows.slice(0, 6)) {
  console.log(`  #${row.id} [${row.category}] ${row.head.replace(/\s+/g, ' ')}`)
}

// ── 4. A published row is still protected from downgrade ───────────────────
section('4. the four published domain rows were not disturbed')
const check = new DatabaseSync(DB_PATH, { readOnly: true })
const domainRows = check.prepare(
  "SELECT id, shareable, scope FROM memories WHERE project_path LIKE 'dir:global:%'",
).all() as Array<{ id: number; shareable: number; scope: string }>
check.close()
console.log(`domain rows: ${String(domainRows.length)}, all still shareable=1: ${String(domainRows.every(row => Number(row.shareable) === 1))}`)

writer.close()
console.log('\n=== share guard acceptance: complete ===')
