/**
 * Phase 4 acceptance: `curate` in dry-run against the LIVE corpus.
 *
 * The question this answers is whether consolidation has anything to do at all,
 * and the live corpus says yes — with a twist worth recording:
 *
 *   493 memories, 5 pairs at or above the 0.92 floor:
 *     - four are the SAME render command written four ways (backslash vs slash
 *       paths, with and without the embedded python) — genuine duplicates;
 *     - one is DENSITY_MIN in two DIFFERENT numeric versions — a config that
 *       evolved, where merging would delete one of the two value sets.
 *
 * That split is exactly why the prompt asks for a decision rather than assuming
 * a high cosine means "merge", and why the dry run is the default: the same
 * similarity score covers "one fact twice" and "two versions of one fact".
 *
 * Run: node --experimental-strip-types scripts/dream-phase4-check.mts
 */
import { DatabaseSync } from 'node:sqlite'
import { openMemoryWriter } from '../src/core/memory-write.ts'
import { runCurateTick, selectCandidatePairs, type CurateLlm, type CurateVectorRow } from '../src/core/curate-memories.ts'
import type { Journal } from '../src/core/journal.ts'

const DB_PATH = 'C:/tmp/dream-verify/memories.db'
const PROJECT = 'dir:addef9f024b0'
const MODEL = 'embedding-provider:adc36d64c8cb774f10f8348390e75fea'
const NOW = Date.now()

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

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

const writer = openMemoryWriter({
  dbPath: DB_PATH,
  logger: { info: () => {}, warn: () => {} },
  now: () => NOW,
})

// ── 1. The pool and the floor ──────────────────────────────────────────────
section('1. the pool')
const rows = writer.listVectors(PROJECT, MODEL, 400)
console.log(`rows carrying a vector in the dominant space: ${String(rows.length)}`)
const categories = new Map<string, number>()
for (const row of rows) categories.set(row.category, (categories.get(row.category) ?? 0) + 1)
console.log(`by category: ${JSON.stringify([...categories.entries()].sort((a, b) => b[1] - a[1]))}`)

/**
 * A stand-in that follows the prompt's own rules, so the dry run exercises the
 * real decision shape:
 *  - if both texts carry DIFFERENT numbers, "keep" (two versions of a config are
 *    two facts, and merging deletes one version);
 *  - otherwise "merge", with the longer text as the merged body (which the
 *    content-loss gate will check).
 *
 * It also proves the gate runs on real content: a merge whose text is too short
 * against a long original must be refused, and the run reports it.
 */
const llm: CurateLlm = {
  stream(options) {
    const text = (options.messages[0] as { content: Array<{ text: string }> }).content[0]!.text
    const blocks = text.split(/\n#\d+ similarity=/).slice(1)
    const decisions: Array<Record<string, unknown>> = []
    for (const block of blocks) {
      const ids = [...block.matchAll(/\[(\d+)\] \(importance/g)].map(match => Number(match[1]))
      if (ids.length < 2) continue
      const bodies = [...block.matchAll(/: (.*)$/gm)].map(match => match[1] ?? '')
      const numbers = (value: string): string => (value.match(/\d+/g) ?? []).join(',')
      const [first, second] = bodies
      if (first === undefined || second === undefined) continue
      const sameNumbers = numbers(first) === numbers(second)
      // The merged body must be NEW text, not a copy of one side: copying the
      // source verbatim reproduces its normalized hash, and `mergeMemory` then
      // refuses with a UNIQUE violation (correctly — it will not create a
      // duplicate row). A real model writes a combined sentence; the stand-in
      // concatenates, which is the same shape (longer, distinct, keeps both).
      decisions.push(sameNumbers
        ? { archiveId: ids[0], keepId: ids[1], action: 'merge', content: `${first} Also: ${second}` }
        : { archiveId: ids[1], keepId: ids[0], action: 'keep', reason: 'values differ' })
    }
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ decisions }) }
      yield { type: 'usage', usage: { inputTokens: 3000, outputTokens: 500 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}

// ── 2. Dry run at several floors ───────────────────────────────────────────
section('2. candidate pairs by floor (dry run, nothing written)')
const vectorRows: CurateVectorRow[] = rows.map(row => ({
  id: row.id, category: row.category, content: row.content,
  importance: row.importance, seenCount: row.seenCount, createdAt: row.createdAt,
  embedding: row.embedding,
}))
for (const floor of [0.95, 0.92, 0.88, 0.85]) {
  const pairs = selectCandidatePairs(vectorRows, floor, 6)
  console.log(`  floor ${floor.toFixed(2)}: ${String(pairs.length)} pairs selected`)
}

section('3. dry run at the shipped floor (0.92)')
const before = snapshot()
const outcome = await runCurateTick({
  writer, identity: PROJECT, llm, route: { provider: 'stand-in', model: 'rule-following' },
  modelId: MODEL, sessionId: 'mc-dreamer', journal, now: () => NOW,
})
console.log(`dryRun=${String(outcome.dryRun)} pool=${String(outcome.pool)} candidates=${String(outcome.candidates)} asked=${String(outcome.asked)}`)
console.log(`decisions: merge=${String(outcome.merged)} archive=${String(outcome.archived)} keep=${String(outcome.kept)} skip=${String(outcome.skipped)} refused=${String(outcome.refused)}`)
console.log(`tokens=${String(outcome.tokensUsed)}`)
for (const decision of outcome.decisions) {
  const label = decision.refusal === undefined
    ? decision.action
    : `${decision.action} REFUSED (${decision.refusal.reason})`
  console.log(`  ${String(decision.archiveId)} → ${String(decision.keepId)} sim=${decision.similarity.toFixed(4)}: ${label}`)
}
console.log(`journal: ${JSON.stringify(reported.filter(r => r.kind === 'dream-curate').slice(-1)[0]?.summary ?? '(none)')}`)

// ── 4. The dry run must have written nothing ───────────────────────────────
section('4. dry run left the corpus untouched')
const after = snapshot()
const drifted = [...before.entries()].filter(([id, row]) => {
  const now = after.get(id)
  return now === undefined || now.status !== row.status || now.content !== row.content
})
console.log(`rows changed by the dry run: ${String(drifted.length)} (must be 0)`)

// ── 5. The gate refuses a real long-form memory ────────────────────────────
section('5. the gate on real content')
// The trap answers "merge into 'short.'" for whatever pair it is actually shown.
// Reading the ids out of the prompt is what makes the refusal land on real
// content: the gate then compares 'short.' against a real memory's length.
const trapLlm: CurateLlm = {
  stream(options) {
    const text = (options.messages[0] as { content: Array<{ text: string }> }).content[0]!.text
    const pairs = [...text.matchAll(/\[ (\d+)\]/g)]
    void pairs
    const blocks = text.split(/\n#\d+ similarity=/).slice(1)
    const decisions: Array<Record<string, unknown>> = []
    for (const block of blocks) {
      const ids = [...block.matchAll(/\[(\d+)\] \(importance/g)].map(match => Number(match[1]))
      if (ids.length < 2) continue
      decisions.push({ archiveId: ids[0], keepId: ids[1], action: 'merge', content: 'short.' })
    }
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ decisions }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}
{
  const trapOutcome = await runCurateTick({
    writer, identity: PROJECT, llm: trapLlm, route: { provider: 'stand-in', model: 'short-answer' },
    modelId: MODEL, sessionId: 'mc-dreamer', journal, now: () => NOW,
    // The candidates are the real ones; only the ANSWER is degenerate.
    maxPairs: 4,
  })
  const refusals = trapOutcome.decisions.filter(decision => decision.refusal !== undefined)
  console.log(`asked=${String(trapOutcome.asked)} refusals=${String(refusals.length)}`)
  for (const refusal of refusals.slice(0, 3)) {
    console.log(`  ${String(refusal.archiveId)}: ${String(refusal.refusal?.reason)} `
      + `(${String(refusal.refusal?.originalChars)} → ${String(refusal.refusal?.replacementChars)} chars)`)
  }
}

// ── 6. Apply mode, on the copy only ────────────────────────────────────────
section('6. apply mode on the copy')
const applied = await runCurateTick({
  writer, identity: PROJECT, llm, route: { provider: 'stand-in', model: 'rule-following' },
  modelId: MODEL, sessionId: 'mc-dreamer', journal, now: () => NOW, dryRun: false,
})
console.log(`merged=${String(applied.merged)} archived=${String(applied.archived)} refused=${String(applied.refused)}`)
for (const decision of applied.decisions) {
  const label = decision.refusal === undefined
    ? `${decision.action}${decision.applied === true ? ' APPLIED' : ''}${decision.refusalReason === undefined ? '' : ` (${decision.refusalReason}${decision.detail === undefined ? '' : `: ${decision.detail}`})`}`
    : `${decision.action} REFUSED (${decision.refusal.reason})`
  console.log(`  ${String(decision.archiveId)} → ${String(decision.keepId)} sim=${decision.similarity.toFixed(4)}: ${label}`)
}
const afterApply = snapshot()
const changed = [...afterApply.entries()].filter(([id, row]) => {
  const old = before.get(id)
  return old !== undefined && (old.status !== row.status || row.content !== old.content)
})
console.log(`rows changed by apply: ${String(changed.length)}`)
for (const [id, row] of changed.slice(0, 4)) {
  console.log(`  ${String(id)}: ${before.get(id)?.status} → ${row.status}`)
}

writer.close()
console.log('\n=== phase 4 acceptance: complete ===')

/** id → {status, content}, for the before/after comparison. */
function snapshot(): Map<number, { status: string; content: string }> {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  try {
    const all = db.prepare(
      "SELECT id, status, content FROM memories WHERE project_path = ? AND status IN ('active','permanent','archived')",
    ).all(PROJECT) as Array<{ id: number; status: string; content: string }>
    return new Map(all.map(row => [Number(row.id), { status: String(row.status), content: String(row.content) }]))
  } finally {
    db.close()
  }
}
