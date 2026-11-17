/**
 * Phase 5 acceptance: the retrospective against the REAL journal.
 *
 * The unit tests show the ranking rules; this shows what the live journal
 * actually contains, which is the input the task will really face. If the
 * weighted signals come back empty, the task is decorative — so the first thing
 * to check is whether the last week of this installation produced any friction at
 * all, and what kind.
 *
 * Run: node --experimental-strip-types scripts/dream-phase5-check.mts
 */
import { openStores } from '../src/core/stores.ts'
import { collectFriction, runRetrospectiveTick, type RetrospectiveLlm, type FrictionSignal } from '../src/core/retrospective.ts'
import type { Journal } from '../src/core/journal.ts'

const DATA_DIR = 'C:/tmp/dream-verify'
const PROJECT = 'dir:addef9f024b0'
const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000

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

const stores = openStores(DATA_DIR)

// ── 1. What the journal holds ──────────────────────────────────────────────
section('1. the live journal')
const bounds = stores.journalBounds()
console.log(`rows: ${String(bounds.rows)}`)
if (bounds.oldest !== undefined && bounds.newest !== undefined) {
  console.log(`oldest: ${new Date(bounds.oldest).toISOString()}`)
  console.log(`newest: ${new Date(bounds.newest).toISOString()}`)
  console.log(`span: ${((bounds.newest - bounds.oldest) / DAY).toFixed(1)} days`)
}
const byKind = stores.journalByKind()
console.log(`kinds: ${String(byKind.length)}`)
for (const row of byKind.slice(0, 14)) {
  console.log(`  ${row.kind.padEnd(24)} ${row.level.padEnd(6)} ${String(row.count)}`)
}

// ── 2. Friction over the default window ────────────────────────────────────
section('2. friction in the last 7 days (default window)')
// Aggregate first: `listJournal` takes a LIMIT and orders newest-first, so using
// it as the window caps the window at N rows (measured here: 7-day and 30-day
// windows both came back with exactly 2,000 of 16,463 rows).
const counts7 = stores.journalByKind(NOW - 7 * DAY)
const total7 = counts7.reduce((sum, row) => sum + Number(row.count), 0)
console.log(`rows in window (aggregated): ${String(total7)}`)
const signals = collectFriction(counts7.map(row => ({
  kind: String(row.kind), level: String(row.level), summary: '', at: NOW,
})))
console.log(`weighted signals: ${String(signals.length)}`)
for (const signal of signals) {
  console.log(`  ${signal.kind}/${signal.level} × ${String(signal.count)} (weight ${String(signal.weight)}, total ${String(signal.count * signal.weight)})`)
  for (const sample of signal.samples.slice(0, 2)) console.log(`      ${sample.slice(0, 150)}`)
}

// ── 3. Widen the window if a week is quiet ────────────────────────────────
section('3. a 30-day window, in case the week was quiet')
const counts30 = stores.journalByKind(NOW - 30 * DAY)
const total30 = counts30.reduce((sum, row) => sum + Number(row.count), 0)
const wideSignals = collectFriction(counts30.map(row => ({
  kind: String(row.kind), level: String(row.level), summary: '', at: NOW,
})))
console.log(`rows in window: ${String(total30)}, signals: ${String(wideSignals.length)}`)
for (const signal of wideSignals.slice(0, 8)) {
  console.log(`  ${signal.kind}/${signal.level} × ${String(signal.count)} (weight ${String(signal.weight)})`)
}

// ── 4. The full task, with a stand-in that shows the prompt shape ─────────
section('4. runRetrospectiveTick with a stand-in model')
let promptText = ''
const llm: RetrospectiveLlm = {
  stream(options) {
    promptText = (options.messages[0] as { content: Array<{ text: string }> }).content[0]!.text
    const paragraphs = [
      'The dominant cost in this window was context pressure: the pass lane fired its force band repeatedly, which means the projected size crossed the hard threshold rather than merely the soft one.',
      'That pattern points at the threshold configuration rather than at any single turn — the soft band is being skipped, so compaction only happens once the window is already full.',
      'Consider lowering executeThreshold so the soft band gets a chance to act, and checking whether the historian budget is large enough to consume what the soft band frees.',
    ].join('\n\n')
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: paragraphs }
      yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 260 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}
const outcome = await runRetrospectiveTick({
  stores, identity: PROJECT, llm, route: { provider: 'stand-in', model: 'explainer' },
  journal, sessionId: 'mc-dreamer', now: () => NOW, windowMs: 30 * DAY,
})
console.log(`rows=${String(outcome.rows)} signals=${String(outcome.signals)} tokens=${String(outcome.tokensUsed)}`)
console.log(`reason=${String(outcome.reason)} noteId=${String(outcome.noteId)}`)
// The samples are filled by a per-kind read inside the task, so the prompt is the
// place to prove they arrived: a signal with an empty sample list would render
// as a bare count and the model would have nothing to explain.
const signalsAt = promptText.indexOf('Signals:')
console.log(`prompt signals block:\n${promptText.slice(signalsAt, signalsAt + 900)}`)
if (outcome.noteId !== undefined) {
  const note = stores.getNote(outcome.noteId)
  console.log(`note stored: ${note?.content.slice(0, 200).replace(/\n/g, ' ')}…`)
  // Retire it so a re-run of this script does not accumulate notes.
  stores.retireNotes([outcome.noteId], 'delete', NOW)
  console.log('note retired after inspection')
}

// ── 5. A quiet window costs nothing ────────────────────────────────────────
section('5. a window with no friction pays nothing')
const frictionKinds = ['force-path', 'emergency-reclaim', 'wire-repair', 'project-drift', 'config-drift', 'drop-retired', 'compartment-recomp']
const quiet = counts7.filter(row => !frictionKinds.includes(String(row.kind)) && String(row.level) !== 'error')
console.log(`non-friction kinds in the window: ${String(quiet.length)}`)
const quietOutcome = await runRetrospectiveTick({
  stores, identity: PROJECT, llm, route: { provider: 'stand-in', model: 'explainer' },
  journal, sessionId: 'mc-dreamer', now: () => NOW,
  // A one-millisecond window will contain nothing.
  windowMs: 1,
})
console.log(`reason=${String(quietOutcome.reason)} tokens=${String(quietOutcome.tokensUsed)} (0 = the model was never called)`)

stores.close()
console.log('\n=== phase 5 acceptance: complete ===')
void (null as unknown as FrictionSignal)
