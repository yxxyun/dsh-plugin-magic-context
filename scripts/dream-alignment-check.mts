/**
 * One-command verification of the upstream-alignment objective.
 *
 * Run after a DSH restart. Every check prints a verdict and the evidence behind
 * it, so "did it land?" is one command instead of four ad-hoc queries:
 *
 *   node --experimental-strip-types scripts/dream-alignment-check.mts
 *
 * Checks:
 *   1. the loaded build is the built one (lib mtime vs the newest boot row)
 *   2. dream_schedule holds every canonical task (a missing row means the task
 *      will simply never run, with no error)
 *   3. no fixed-interval sweep is installed (no `maintenance` tick rows after
 *      boot, and only one background setInterval in the artifact)
 *   4. the tasks that were moved actually ran, with their own journal kinds
 *   5. the RSS series continues (it now hangs off `backfill-vectors`)
 */

import { DatabaseSync } from 'node:sqlite'
import { readFileSync, statSync } from 'node:fs'

const STORE = 'C:/Users/yxx/.local/share/cortexkit/magic-context-dsh-poc/dsh-magic-context.db'
const LIB = 'C:/data/code/dsh-plugin-magic-context/lib/index.js'
const REGISTRY = 'C:/data/code/dsh-plugin-magic-context/src/core/dream-registry.ts'

const EXPECTED_TASKS = [
  'promote-primers',
  'classify-memories',
  'verify',
  'curate',
  'retrospective',
  'evaluate-smart-notes',
  'review-user-memories',
  'auto-stage-global',
  'backfill-vectors',
  'index-commits',
]

let failures = 0
const ok = (label: string, detail: string): void => {
  console.log(`  PASS  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}
const bad = (label: string, detail: string): void => {
  failures += 1
  console.log(`  FAIL  ${label} — ${detail}`)
}
const info = (label: string, detail: string): void => {
  console.log(`  ....  ${label} — ${detail}`)
}

const db = new DatabaseSync(STORE, { readOnly: true })

console.log('\n1. build freshness')
const libAt = statSync(LIB).mtimeMs
const boot = db.prepare("SELECT at FROM journal WHERE kind = 'boot' ORDER BY id DESC LIMIT 1").get() as { at: number } | undefined
if (boot === undefined) {
  info('no boot row', 'cannot compare')
} else {
  const lagMin = Math.round((boot.at - libAt) / 60_000)
  if (boot.at >= libAt) {
    ok('process started after the build', `boot ${String(lagMin)}m after lib mtime`)
  } else {
    bad('stale build loaded', `lib is ${String(-lagMin)}m NEWER than the running process — restart needed`)
  }
}

console.log('\n2. schedules cover every canonical task')
const rows = db.prepare('SELECT project_path, task, cron, next_due_at, last_status, consecutive_failures FROM dream_schedule').all() as Array<{
  project_path: string
  task: string
  cron: string
  next_due_at: number | null
  last_status: string | null
  consecutive_failures: number
}>
const projects = [...new Set(rows.map(row => row.project_path))]
if (rows.length === 0) {
  bad('no schedules at all', 'the runner never seeded — check the preStep wiring')
} else {
  for (const project of projects) {
    const mine = rows.filter(row => row.project_path === project)
    const missing = EXPECTED_TASKS.filter(task => !mine.some(row => row.task === task))
    if (missing.length === 0) ok(project, `${String(mine.length)} tasks scheduled`)
    else bad(project, `missing: ${missing.join(', ')}`)
    for (const row of mine) {
      const due = row.next_due_at === null ? 'never' : new Date(row.next_due_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      const fails = row.consecutive_failures > 0 ? ` fails=${String(row.consecutive_failures)}` : ''
      console.log(`        ${row.task.padEnd(21)} ${row.cron.padEnd(14)} due ${due.padEnd(20)} ${(row.last_status ?? '-').padEnd(8)}${fails}`)
    }
  }
}

console.log('\n3. the fixed-interval sweep is gone')
const afterBoot = boot?.at ?? 0
// The sweep wrote `kind='maintenance'` rows whose summary starts with
// "maintenance:". Other lanes used to borrow that kind for their own warnings
// (profile review did, until it was renamed), so the SUMMARY is the discriminator
// — matching on the kind alone reported those warnings as sweep activity.
const sweep = db.prepare(
  "SELECT COUNT(*) AS n FROM journal WHERE kind = 'maintenance' AND summary LIKE 'maintenance:%' AND at > ?",
).get(afterBoot) as { n: number }
if (sweep.n === 0) ok('no sweep rows since boot', 'the fixed-interval tick is not running')
else bad('sweep rows still appearing', `${String(sweep.n)} rows — the OLD build is still loaded`)
const artifactSrc = readFileSync('C:/data/code/dsh-plugin-magic-context/lib/index.js', 'utf8')
if (!artifactSrc.includes('runMaintenanceTick')) ok('the sweep is not even bundled', 'no runMaintenanceTick in lib')
else bad('sweep code still bundled', 'lib/index.js still references runMaintenanceTick')
const artifact = readFileSync(LIB, 'utf8')
const intervals = [...artifact.matchAll(/setInterval\(([^,]{0,40})/g)].map(match => match[1])
const background = intervals.filter(hit => !hit.includes('write(') && !hit.includes('()=>'))
if (background.length <= 1) ok('one background setInterval in the artifact', background.join(', ') || '(none)')
else bad('multiple background intervals', background.join(' | '))

console.log('\n4. the moved tasks own their journal kinds')
const kinds = ['dream-run', 'dream-classify', 'dream-verify', 'dream-curate', 'dream-retro']
for (const kind of kinds) {
  const row = db.prepare('SELECT COUNT(*) AS n, MAX(at) AS last FROM journal WHERE kind = ? AND at > ?').get(kind, afterBoot) as { n: number; last: number | null }
  if (row.n > 0) info(kind, `${String(row.n)} rows, last ${new Date(row.last ?? 0).toISOString()}`)
  else info(kind, 'none yet since boot (a daily cron may not have come due)')
}

console.log('\n4b. the review cursor advances (queue does not stall)')
try {
  const mem = new DatabaseSync('C:/Users/yxx/.local/share/cortexkit/magic-context-dsh-poc/memories.db', { readOnly: true })
  const total = (mem.prepare('SELECT COUNT(*) AS n FROM user_memory_candidates').get() as { n: number }).n
  mem.close()
  const cursorRow = db.prepare("SELECT value FROM meta WHERE key = 'profile:review:cursor'").get() as { value: string } | undefined
  const runs = db.prepare("SELECT COUNT(*) AS n FROM dream_runs WHERE task = 'review-user-memories' AND status = 'ok'").get() as { n: number }
  if (runs.n === 0) info('review has not run yet', `${String(total)} candidates waiting`)
  else if (cursorRow === undefined) info('no cursor yet', `${String(total)} candidates, ${String(runs.n)} successful run(s) — the first pass may have been throttled`)
  else info('cursor present', `${cursorRow.value} (pool ${String(total)})`)
} catch (error) {
  info('cursor check skipped', String(error).slice(0, 80))
}

console.log('\n5. the RSS series continues under backfill-vectors')
const sample = db.prepare("SELECT COUNT(*) AS n, MAX(at) AS last FROM journal WHERE kind = 'memory-sample' AND at > ?").get(afterBoot) as { n: number; last: number | null }
if (sample.n > 0) ok('memory-sample rows present', `${String(sample.n)} since boot`)
else info('no sample yet', 'backfill-vectors runs every 30 minutes; check again later')

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${String(failures)} CHECK(S) FAILED`}\n`)
db.close()
process.exitCode = failures === 0 ? 0 : 1
