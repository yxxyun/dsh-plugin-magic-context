/**
 * Phase 1 acceptance run against a COPY of the live database.
 *
 * Not a unit test: this exercises the real v12 → v13 migration, seeds schedules
 * for a real project identity, and runs `promote-primers` against the real
 * memory store. The copy exists so a failure here cannot damage the live data —
 * the same script pointed at the live directory is the upgrade itself.
 *
 * Run: node --experimental-strip-types scripts/dream-phase1-check.mts
 */
import { DatabaseSync } from 'node:sqlite'
import { openStores } from '../src/core/stores.ts'
import { PRIMER_DDL } from '../src/core/primer-store.ts'
import { promotePrimerClusters } from '../src/core/primer-search.ts'
import { ensureDreamSchedules, runDueDreamTasks, computeNextDue } from '../src/core/dream-runner.ts'
import { buildPromotePrimersHandler } from '../src/dsh/dream-handlers.ts'

const VERIFY_DIR = 'C:/tmp/dream-verify'
const DATA_DIR = VERIFY_DIR

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

// ── 1. Open the copy: this is the v12 → v13 migration ────────────────────────
section('1. openStores on the v12 copy (runs the v13 migration)')
const before = new DatabaseSync(`${DATA_DIR}/dsh-magic-context.db`, { readOnly: true })
const beforeVersion = (before.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value
const beforeTables = (before.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
  .map(row => row.name)
before.close()
console.log(`before: version=${beforeVersion} tables=${String(beforeTables.length)} dream_schedule=${String(beforeTables.includes('dream_schedule'))}`)

const stores = openStores(DATA_DIR)
const afterVersion = ((): string => {
  const probe = new DatabaseSync(`${DATA_DIR}/dsh-magic-context.db`, { readOnly: true })
  try {
    return (probe.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value
  } finally {
    probe.close()
  }
})()
const afterTables = ((): string[] => {
  const probe = new DatabaseSync(`${DATA_DIR}/dsh-magic-context.db`, { readOnly: true })
  try {
    return (probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name)
  } finally {
    probe.close()
  }
})()
console.log(`after:  version=${afterVersion} tables=${String(afterTables.length)}`)
console.log(`new tables: ${afterTables.filter(name => !beforeTables.includes(name)).join(', ')}`)

// ── 2. Seed schedules for the project the live database actually serves ──────
section('2. ensureDreamSchedules (real project identity)')
const memoryDb = new DatabaseSync(`${DATA_DIR}/memories.db`)
const projects = (memoryDb.prepare(
  'SELECT project_path, COUNT(*) AS n FROM memories GROUP BY project_path ORDER BY n DESC LIMIT 5',
).all() as Array<{ project_path: string; n: number }>)
console.log(`projects in the memory store: ${projects.map(p => `${p.project_identity}(${String(p.n)})`).join(', ') || '(none)'}`)

const project = projects[0]?.project_path ?? "dir:unknown"
const now = Date.now()
const seeded = ensureDreamSchedules(stores, project, now)
console.log(`project=${project}`)
console.log(`seeded: ${seeded.seeded.join(', ') || '(none — already present)'}`)
const rows = stores.listDreamSchedules(project)
console.log(`rows now: ${String(rows.length)}`)
for (const row of rows) {
  const due = row.nextDueAt === undefined ? 'never' : new Date(row.nextDueAt).toISOString()
  console.log(`  ${row.task.padEnd(20)} cron=${row.cron.padEnd(14)} nextDue=${due}`)
}

// ── 3. Run promote-primers through the scheduler, on real data ───────────────
section('3. runDueDreamTasks — promote-primers on the real memory store')
memoryDb.exec(PRIMER_DDL)
const handler = buildPromotePrimersHandler({
  promotePrimers: ({ projectPath }) => {
    try {
      return promotePrimerClusters(memoryDb, projectPath)
    } catch {
      return undefined
    }
  },
})

// Force the task due now so this run does not depend on the seeded cron slot.
const promoteRow = stores.getDreamSchedule(project, 'promote-primers')
if (promoteRow !== undefined) {
  stores.upsertDreamSchedule({ ...promoteRow, nextDueAt: now - 1, updatedAt: now })
}

const outcomes = await runDueDreamTasks({
  stores,
  lease: stores.dreamLease(),
  handlers: { 'promote-primers': handler },
  now: () => now,
  log: (message, data) => { console.log(`  log: ${message} ${data === undefined ? '' : JSON.stringify(data)}`) },
})
console.log(`outcomes: ${JSON.stringify(outcomes, null, 2)}`)

// ── 4. Inspect what was persisted ────────────────────────────────────────────
section('4. persisted state')
console.log('runs:', JSON.stringify(stores.listDreamRuns(project, 5), null, 2))
const afterSchedule = stores.getDreamSchedule(project, 'promote-primers')
console.log('promote-primers schedule:', JSON.stringify(afterSchedule, null, 2))
console.log('next due (recomputed from cron):', computeNextDue({
  cron: afterSchedule?.cron ?? '', now, status: 'ok', consecutiveFailures: 0,
})?.toString() ?? 'null')

// ── 5. Second tick must not re-run the same slot ─────────────────────────────
section('5. idempotence — a second tick at the same instant')
const second = await runDueDreamTasks({
  stores, lease: stores.dreamLease(), handlers: { 'promote-primers': handler }, now: () => now,
})
console.log(`second tick outcomes: ${String(second.length)} (0 = the clock advanced correctly)`)

const primerCountBefore = (memoryDb.prepare('SELECT COUNT(*) AS n FROM primers').get() as { n: number }).n
console.log(`primers before the synthetic run: ${String(primerCountBefore)}`)

// ── 6. The real work path: a question asked twice, a week apart ──────────────
// The live copy has no primer candidates (the lane only records a question when
// a turn asks one), so the run above proved the plumbing but not the payload.
// These two rows are the minimum a primer needs — distinct UTC days, span >= 7 —
// injected into the COPY so the promotion path itself is exercised.
section('6. promote-primers actually promotes (synthetic candidate pair)')
const DAY = 24 * 60 * 60 * 1000
const question = 'How does the dreamer scheduler decide what is due?'
const insertCandidate = memoryDb.prepare(
  'INSERT INTO primer_candidates(project_path, harness, session_id, question, normalized_question, '
    + 'source_message_time, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
)
insertCandidate.run(project, 'dsh', 's-dream-a', question, question.toLowerCase(), now - 8 * DAY, now - 8 * DAY)
insertCandidate.run(project, 'dsh', 's-dream-b', question, question.toLowerCase(), now - 1 * DAY, now - 1 * DAY)
console.log(`candidates for ${project}: ${String((memoryDb.prepare('SELECT COUNT(*) AS n FROM primer_candidates WHERE project_path = ?').get(project) as { n: number }).n)}`)

// Re-arm so this run happens at a known instant.
const rearm = stores.getDreamSchedule(project, 'promote-primers')
if (rearm !== undefined) stores.upsertDreamSchedule({ ...rearm, nextDueAt: now - 1, updatedAt: now })
const synthetic = await runDueDreamTasks({
  stores, lease: stores.dreamLease(), handlers: { 'promote-primers': handler }, now: () => now + 1,
})
console.log(`outcome: ${JSON.stringify(synthetic.map(o => ({ task: o.task, status: o.status, itemsProcessed: o.itemsProcessed, itemsChanged: o.itemsChanged })))}`)

const primers = memoryDb.prepare('SELECT id, question, total_support, status FROM primers WHERE project_path = ?').all(project) as Array<{
  id: number; question: string; total_support: number; status: string
}>
console.log(`primers now: ${JSON.stringify(primers, null, 2)}`)
console.log(`run history: ${JSON.stringify(stores.listDreamRuns(project, 3).map(r => ({ task: r.task, status: r.status, summary: r.summary })), null, 2)}`)

memoryDb.close()
stores.close()
console.log('\n=== phase 1 acceptance: complete ===')
