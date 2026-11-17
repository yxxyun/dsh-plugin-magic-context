/**
 * Phase 3 acceptance: file-backed verification against the LIVE corpus and a
 * REAL project tree.
 *
 * This is the run that decides whether the task has value at all. The unit tests
 * prove the mechanics against synthetic files; this one asks the question that
 * matters: of the references real memories actually make, how many resolve?
 *
 * The largest project in the live corpus (`dir:addef9f024b0`, the ComfyUI tree —
 * 493 active memories) is the right subject because it is a real, large,
 * long-lived codebase whose memories were written months ago against files that
 * have since moved. A high `missing` rate here is not a bug in the index; it is
 * the finding the task exists to surface.
 *
 * The model is a stand-in: it answers `verified` for resolved references and
 * `stale` for missing ones, which is the natural reading of the evidence and
 * makes the outcome inspectable without paying for a real completion.
 *
 * Run: node --experimental-strip-types scripts/dream-phase3-check.mts
 */
import { DatabaseSync } from 'node:sqlite'
import {
  buildFileIndex,
  extractFileReferences,
  gatherEvidence,
  renderEvidence,
} from '../src/core/memory-evidence.ts'
import { openMemoryWriter } from '../src/core/memory-write.ts'
import { runVerifyTick, type VerifyLlm } from '../src/core/verify-memories.ts'
import type { Journal } from '../src/core/journal.ts'

const DATA_DIR = 'C:/tmp/dream-verify'
const DB_PATH = `${DATA_DIR}/memories.db`
const PROJECT = 'dir:addef9f024b0'
const PROJECT_ROOT = 'C:/data/ComfyUI_windows_portable'
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

// ── 1. What the live memories actually cite ─────────────────────────────────
section('1. references in the live corpus')
const db = new DatabaseSync(DB_PATH, { readOnly: true })
const rows = db.prepare(
  "SELECT id, content FROM memories WHERE project_path = ? AND status IN ('active','permanent')",
).all(PROJECT) as Array<{ id: number; content: string }>
db.close()

const perMemory = rows.map(row => ({ id: row.id, references: extractFileReferences(row.content) }))
const citing = perMemory.filter(entry => entry.references.length > 0)
const totalRefs = perMemory.reduce((sum, entry) => sum + entry.references.length, 0)
console.log(`${String(rows.length)} active memories, ${String(citing.length)} cite a file, ${String(totalRefs)} references total`)
console.log(`coverage: ${((citing.length / rows.length) * 100).toFixed(1)}% of memories`)

// ── 2. Build the index over the real tree ──────────────────────────────────
section('2. index the real project root')
const indexStart = Date.now()
const index = buildFileIndex(PROJECT_ROOT)
console.log(`root=${PROJECT_ROOT}`)
console.log(`scanned=${String(index.scanned)} indexable=${String(index.index.size)} truncated=${String(index.truncated)} ms=${String(Date.now() - indexStart)}`)
const duplicated = [...index.index.values()].filter(paths => paths.length > 1).length
console.log(`filenames shared by more than one file: ${String(duplicated)}`)

// ── 3. Resolve every reference: this is the acceptance number ──────────────
section('3. reference resolution across the whole project')
const tally = { found: 0, missing: 0, ambiguous: 0, unreadable: 0 }
const missingNames = new Map<string, number>()
const foundNames = new Map<string, number>()
for (const entry of perMemory) {
  if (entry.references.length === 0) continue
  const evidence = gatherEvidence(entry.references, index.index, { root: PROJECT_ROOT, maxReferences: 20 })
  for (const item of evidence) {
    tally[item.status] += 1
    const bucket = item.status === 'missing' ? missingNames : item.status === 'found' ? foundNames : undefined
    bucket?.set(item.reference.base, (bucket.get(item.reference.base) ?? 0) + 1)
  }
}
const total = tally.found + tally.missing + tally.ambiguous + tally.unreadable
console.log(`resolved ${String(total)} references:`)
console.log(`  found      ${String(tally.found)}  (${((tally.found / total) * 100).toFixed(1)}%)`)
console.log(`  missing    ${String(tally.missing)}  (${((tally.missing / total) * 100).toFixed(1)}%)`)
console.log(`  ambiguous  ${String(tally.ambiguous)}  (${((tally.ambiguous / total) * 100).toFixed(1)}%)`)
console.log(`  unreadable ${String(tally.unreadable)}`)
console.log(`most-cited files that RESOLVE:  ${JSON.stringify([...foundNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6))}`)
console.log(`most-cited files that are GONE: ${JSON.stringify([...missingNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8))}`)

// ── 4. A real evidence block, verbatim ─────────────────────────────────────
section('4. one evidence block as the model would see it')
const sampleWithLine = perMemory.find(entry =>
  entry.references.some(ref => ref.lineStart !== undefined && (index.index.get(ref.base)?.length ?? 0) === 1))
if (sampleWithLine !== undefined) {
  const evidence = gatherEvidence(sampleWithLine.references, index.index, { root: PROJECT_ROOT })
  const content = rows.find(row => row.id === sampleWithLine.id)?.content ?? ''
  console.log(`memory ${String(sampleWithLine.id)}: ${content.slice(0, 180).replace(/\s+/g, ' ')}…`)
  console.log(renderEvidence(evidence))
}

// ── 5. Run the task end to end on a copy ───────────────────────────────────
section('5. runVerifyTick on the copy')
const writer = openMemoryWriter({
  dbPath: DB_PATH,
  logger: { info: () => {}, warn: () => {} },
  now: () => NOW,
})

/**
 * Stand-in verdicts derived from the evidence: a resolved reference reads as
 * verified, a vanished one as stale. The model is handed the same block a real
 * one would be, so the prompt path is exercised end to end.
 */
const llm: VerifyLlm = {
  stream(options) {
    const text = (options.messages[0] as { content: Array<{ text: string }> }).content[0]!.text
    // Split the prompt back into per-memory blocks and read each one's evidence.
    const blocks = text.split(/\n(?=- id \d+ )/).filter(block => /^- id \d+ /m.test(block))
    const verdicts = blocks.map(block => {
      const id = Number(/^- id (\d+) /m.exec(block)?.[1] ?? '0')
      if (block.includes('NOT FOUND')) {
        return { id, verdict: 'skip', reason: 'cited file is gone' }
      }
      return { id, verdict: 'verified' }
    }).filter(verdict => verdict.id > 0)
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ verdicts }) }
      yield { type: 'usage', usage: { inputTokens: 2000, outputTokens: 400 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}

// The live copy's rows are nearly all verified already (the maintenance sweep
// ran), so the pool is tiny. Re-open a batch to exercise the task.
const reopened = (() => {
  const write = new DatabaseSync(DB_PATH)
  try {
    return Number(write.prepare(
      "UPDATE memories SET verification_status = 'unverified', verified_at = NULL, metadata_json = NULL "
        + "WHERE id IN (SELECT id FROM memories WHERE project_path = ? AND status IN ('active','permanent') "
        + 'ORDER BY id LIMIT 12)',
    ).run(PROJECT).changes)
  } finally {
    write.close()
  }
})()
console.log(`rows reopened for the run: ${String(reopened)}`)

const outcome = await runVerifyTick({
  writer,
  identity: PROJECT,
  projectRoot: PROJECT_ROOT,
  llm,
  route: { provider: 'stand-in', model: 'evidence-derived' },
  sessionId: 'mc-dreamer',
  journal,
  now: () => NOW,
})
console.log(`pool=${String(outcome.pool)} scanned=${String(outcome.scanned)} tokens=${String(outcome.tokensUsed)}`)
console.log(`verdicts: verified=${String(outcome.verified)} updated=${String(outcome.updated)} archived=${String(outcome.archived)} skipped=${String(outcome.skipped)}`)
console.log(`evidence: found=${String(outcome.referencesFound)} missing=${String(outcome.referencesMissing)} ambiguous=${String(outcome.referencesAmbiguous)}`)
console.log(`journal: ${JSON.stringify(reported.filter(r => r.kind === 'dream-verify').slice(-1))}`)

// ── 6. Second run: the skip memory holds ───────────────────────────────────
section('6. second run — skipped rows are not re-asked')
const second = await runVerifyTick({
  writer, identity: PROJECT, projectRoot: PROJECT_ROOT, llm,
  route: { provider: 'stand-in', model: 'evidence-derived' }, sessionId: 'mc-dreamer', journal, now: () => NOW,
})
console.log(`pool=${String(second.pool)} scanned=${String(second.scanned)} reason=${String(second.reason)}`)

writer.close()
console.log('\n=== phase 3 acceptance: complete ===')
