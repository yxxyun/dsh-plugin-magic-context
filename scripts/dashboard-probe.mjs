/**
 * Probe the dashboard service against the live adapter/corpus databases.
 *
 * Not a test: a one-shot read of the real store so the route's shape can be
 * checked against actual data instead of fixtures. Run from the plugin root
 * after `npm run build`.
 */
import { join } from 'node:path'
import { createDashboardService } from '../lib/dsh/dashboard.js'
import { openStores, defaultDataDir } from '../lib/core/stores.js'
import { openMemoryWriter } from '../lib/core/memory-write.js'

const DIR = defaultDataDir()
const CORPUS = join(DIR, 'memories.db')

const stores = openStores(DIR)
const writer = openMemoryWriter({ dbPath: CORPUS, logger: { info() {}, warn() {} } })
const svc = createDashboardService({
  stores,
  memoryWriter: writer,
  meta: () => ({
    engine: stores.getMeta('compaction_engine'),
    memory: stores.getMeta('memory_bridge'),
    toolsMode: 'full',
  }),
  liveSessions: () => [],
  startedAt: Date.now() - 3_600_000,
})

function hit(url) {
  let status = 0
  let body = ''
  svc.handle({ url, method: 'GET' }, {
    writeHead(code) { status = code },
    write(chunk) { body += chunk },
    end(chunk) { if (chunk) body += chunk },
  })
  return { status, body }
}

const ov = hit('/mc-dashboard/api/overview')
const o = JSON.parse(ov.body)
console.log('OVERVIEW', ov.status)
console.log('  totals:', JSON.stringify(o.totals))
console.log('  rollup:', JSON.stringify(o.rollup24h).slice(0, 320))
console.log('  store :', JSON.stringify(o.store).slice(0, 320))

const ss = JSON.parse(hit('/mc-dashboard/api/sessions').body)
console.log('\nSESSIONS', ss.sessions.length)
for (const s of ss.sessions.slice(0, 6)) {
  console.log(' ', String(s.sessionId).slice(0, 26).padEnd(28),
    'j=' + String(s.journalRows).padStart(4),
    'c=' + String(s.compartments).padStart(2),
    'landed=' + String(s.landedCompartments).padStart(2),
    'pressure=' + (s.latestPressure == null ? '—' : s.latestPressure.toFixed(1) + '%'),
    'last=' + (s.lastAt ? new Date(s.lastAt).toISOString().slice(5, 16) : '—'))
}

const pr = JSON.parse(hit('/mc-dashboard/api/projects').body)
console.log('\nPROJECTS available=' + pr.available, pr.projects.length)
for (const p of pr.projects.slice(0, 8)) {
  console.log(' ', String(p.identity).slice(0, 44).padEnd(46),
    'n=' + String(p.memories).padStart(4),
    'active=' + String(p.active).padStart(3),
    'unverified=' + String(p.unverified).padStart(3),
    'cats=' + p.categories)
}

const jl = JSON.parse(hit('/mc-dashboard/api/journal?limit=5').body)
console.log('\nJOURNAL', jl.entries.length, '| newest:', jl.entries[0]?.kind, '/', String(jl.entries[0]?.summary).slice(0, 60))

const page = hit('/mc-dashboard')
console.log('\nPAGE', page.status, 'bytes=' + page.body.length, 'shell=' + page.body.includes('ov-cards'))

const ghost = hit('/mc-dashboard/api/session?session=ghost')
console.log('GHOST session →', ghost.status)
const post = (() => {
  let status = 0
  svc.handle({ url: '/mc-dashboard/api/overview', method: 'POST' }, {
    writeHead(code) { status = code }, write() {}, end() {},
  })
  return status
})()
console.log('POST →', post)

stores.close()
writer.close()
