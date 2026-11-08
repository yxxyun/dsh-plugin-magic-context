/**
 * The read-only dashboard: `/mc-dashboard` and its JSON routes.
 *
 * Why this file exists: the surface was added to close a real gap — upstream
 * Magic Context ships `packages/dashboard` (a Tauri app), and the DSH port had
 * nothing. The route is a plugin-owned prefix on the harness web server, so the
 * things worth pinning are not the HTML but the contract around it:
 *
 *  1. every route is a GET; a POST is refused, because this surface must never
 *     become a second write path into the corpus;
 *  2. `?session=` scoping and `?limit=` clamping actually apply (an unbounded
 *     limit is a denial-of-service on the operator's own machine);
 *  3. an unknown session is a 404, not an empty 200 that reads like "no data";
 *  4. the session detail lists compartment HEADERS only — the tier bodies are
 *     the digests themselves, and this route has no auth beyond the loopback
 *     bind, so serving them would be a content leak;
 *  5. with no corpus writer attached the projects route says `available:false`
 *     instead of an empty list, which would read as "no memories";
 *  6. the aggregate queries (`listSessions`, `listProjects`) return the counts
 *     the page renders, and a Session known only to one table still appears.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openStores, type AdapterStores } from '../src/core/stores.ts'
import {
  createDashboardService,
  limitOf,
  sessionOf,
  type DashboardRequest,
  type DashboardResponse,
} from '../src/dsh/dashboard.ts'

const dirs: string[] = []
const opened: AdapterStores[] = []

function tempStore(): AdapterStores {
  const dir = mkdtempSync(join(tmpdir(), 'mc-dashboard-'))
  dirs.push(dir)
  const stores = openStores(dir)
  opened.push(stores)
  return stores
}

afterEach(() => {
  for (const store of opened.splice(0).reverse()) {
    try {
      store.close()
    } catch {
      /* best effort: a failed assertion must not mask the real error */
    }
  }
  for (const dir of dirs.splice(0).reverse()) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
  }
})

/** A response double that records what the handler wrote. */
function recorder(): DashboardResponse & { status: () => number; body: () => string; headers: () => Record<string, string> } {
  let status = 0
  let payload = ''
  let headers: Record<string, string> = {}
  return {
    writeHead: (code, next) => {
      status = code
      headers = next ?? {}
      return undefined
    },
    write: (chunk) => {
      payload += chunk
      return undefined
    },
    end: (chunk) => {
      if (chunk !== undefined) payload += chunk
      return undefined
    },
    status: () => status,
    body: () => payload,
    headers: () => headers,
  }
}

function call(
  service: ReturnType<typeof createDashboardService>,
  url: string,
  method = 'GET',
): { status: number; json: () => unknown; text: string; headers: Record<string, string> } {
  const request: DashboardRequest = { url, method }
  const response = recorder()
  service.handle(request, response)
  return {
    status: response.status(),
    json: () => JSON.parse(response.body()) as unknown,
    text: response.body(),
    headers: response.headers(),
  }
}

function seed(stores: AdapterStores, sessionId: string): void {
  stores.appendJournal({ at: 1_000, level: 'info', kind: 'boot', sessionId, summary: 'boot' } as never)
  stores.appendJournal({
    at: 2_000,
    level: 'info',
    kind: 'context-pressure',
    sessionId,
    summary: 'pressure',
    data: { projectedTokens: 300_000, contextWindow: 1_000_000 },
  } as never)
  stores.appendJournal({ at: 3_000, level: 'error', kind: 'pass', sessionId, summary: 'boom' } as never)
}

describe('dashboard query helpers', () => {
  it('normalizes ?session= and clamps ?limit=', () => {
    expect(sessionOf(undefined)).toBeUndefined()
    expect(sessionOf('  ')).toBeUndefined()
    expect(sessionOf(' abc ')).toBe('abc')

    expect(limitOf(undefined, 200, 2_000)).toBe(200)
    expect(limitOf('50', 200, 2_000)).toBe(50)
    expect(limitOf('99999', 200, 2_000)).toBe(2_000)
    expect(limitOf('-5', 200, 2_000)).toBe(200)
    expect(limitOf('nope', 200, 2_000)).toBe(200)
  })
})

describe('dashboard routes', () => {
  it('serves the page as HTML with a no-sniff content type', () => {
    const service = createDashboardService({ stores: tempStore(), meta: () => ({}) })
    const page = call(service, '/mc-dashboard')
    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toContain('text/html')
    expect(page.headers['x-content-type-options']).toBe('nosniff')
    expect(page.text).toContain('Magic Context')
    // The page must not ship a mutation affordance: read-only by construction.
    expect(page.text).not.toMatch(/method:\s*['"]POST/i)
  })

  it('refuses non-GET methods instead of falling through to a read', () => {
    const service = createDashboardService({ stores: tempStore(), meta: () => ({}) })
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = call(service, '/mc-dashboard/api/overview', method)
      expect(response.status).toBe(405)
      expect(response.json()).toMatchObject({ error: 'read-only surface' })
    }
  })

  it('answers 404 for an unknown dashboard path with the route list', () => {
    const service = createDashboardService({ stores: tempStore(), meta: () => ({}) })
    const response = call(service, '/mc-dashboard/api/nope')
    expect(response.status).toBe(404)
    expect(response.json()).toMatchObject({ error: 'unknown dashboard route' })
  })
})

describe('dashboard data', () => {
  it('counts a seeded Session and reads its newest pressure from the journal', () => {
    const stores = tempStore()
    seed(stores, 'sess-a')
    const service = createDashboardService({
      stores,
      meta: () => ({}),
      liveSessions: () => ['sess-a'],
      now: () => 10_000,
    })

    const payload = call(service, '/mc-dashboard/api/sessions').json() as {
      sessions: Array<Record<string, unknown>>
    }
    expect(payload.sessions).toHaveLength(1)
    const row = payload.sessions[0]
    expect(row.sessionId).toBe('sess-a')
    expect(row.journalRows).toBe(3)
    expect(row.live).toBe(true)
    // 300k of a 1M window, read off the `context-pressure` row's data.
    expect(row.latestPressure).toBeCloseTo(30, 5)
    expect(row.latestTokens).toBe(300_000)
    expect(row.latestContextWindow).toBe(1_000_000)
  })

  it('reports a Session that only one table knows about', () => {
    const stores = tempStore()
    // No journal row at all: the Session is known from `usage_records` alone.
    stores.recordUsage({
      sessionId: 'sess-usage-only',
      seq: 1,
      turn: 1,
      step: 1,
      provider: 'p',
      model: 'm',
      inputTokens: 10,
      recorded_at: 5_000,
      recordedAt: 5_000,
    } as never)
    const service = createDashboardService({ stores, meta: () => ({}) })
    const payload = call(service, '/mc-dashboard/api/sessions').json() as {
      sessions: Array<Record<string, unknown>>
    }
    const row = payload.sessions.find(entry => entry.sessionId === 'sess-usage-only')
    expect(row).toBeDefined()
    expect(row?.usageRows).toBe(1)
    expect(row?.journalRows).toBe(0)
  })

  it('rolls up 24h journal kinds and error levels for the overview', () => {
    const stores = tempStore()
    seed(stores, 'sess-b')
    const service = createDashboardService({
      stores,
      meta: () => ({ engine: 'magic', toolsMode: 'full' }),
      now: () => 10_000,
    })
    const payload = call(service, '/mc-dashboard/api/overview').json() as Record<string, never>
    expect(payload).toMatchObject({
      adapter: { engine: 'magic', toolsMode: 'full' },
      rollup24h: { boot: 1, 'context-pressure': 1, pass: 1, errors: 1 },
    })
    expect((payload as unknown as { totals: { sessions: number } }).totals.sessions).toBe(1)
  })

  it('scopes the journal tail by session and clamps the limit', () => {
    const stores = tempStore()
    seed(stores, 'sess-a')
    seed(stores, 'sess-b')
    const service = createDashboardService({ stores, meta: () => ({}) })

    const scoped = call(service, '/mc-dashboard/api/journal?session=sess-a&limit=2').json() as {
      entries: Array<Record<string, unknown>>
    }
    expect(scoped.entries).toHaveLength(2)
    expect(scoped.entries.every(entry => entry.sessionId === 'sess-a')).toBe(true)

    const all = call(service, '/mc-dashboard/api/journal?limit=100').json() as {
      entries: Array<Record<string, unknown>>
    }
    expect(all.entries).toHaveLength(6)
  })

  it('answers 404 for an unknown session and 400 without one', () => {
    const stores = tempStore()
    seed(stores, 'sess-a')
    const service = createDashboardService({ stores, meta: () => ({}) })

    expect(call(service, '/mc-dashboard/api/session').status).toBe(400)
    expect(call(service, '/mc-dashboard/api/session?session=ghost').status).toBe(404)
    expect(call(service, '/mc-dashboard/api/session?session=sess-a').status).toBe(200)
  })

  it('serves compartment headers but never the tier bodies', () => {
    const stores = tempStore()
    seed(stores, 'sess-a')
    stores.allocateCompartment('sess-a', {
      tiers: {
        p1: 'HEADER-ONE-LINE',
        p2: 'BODY-TIER-P2-SECRET',
        p3: 'BODY-TIER-P3-SECRET',
        p4: 'BODY-TIER-P4-SECRET',
      },
      importance: 3,
      facts: [],
      events: ['an event'],
    } as never, { startSeq: 1, endSeq: 3, seqs: [1, 2, 3], tokens: 900 }, 0, 9_000)
    const service = createDashboardService({ stores, meta: () => ({}) })

    const text = call(service, '/mc-dashboard/api/session?session=sess-a').text
    expect(text).toContain('HEADER-ONE-LINE')
    // The bodies are the digest content; this route has no auth beyond loopback.
    expect(text).not.toContain('BODY-TIER-P2-SECRET')
    expect(text).not.toContain('BODY-TIER-P3-SECRET')
    expect(text).not.toContain('BODY-TIER-P4-SECRET')
  })

  it('says the corpus is unavailable instead of showing an empty project list', () => {
    const service = createDashboardService({ stores: tempStore(), meta: () => ({}) })
    const payload = call(service, '/mc-dashboard/api/projects').json() as Record<string, unknown>
    expect(payload).toMatchObject({ available: false, projects: [] })
  })

  it('serves an embedded variant that keeps one document but tightens the margins', () => {
    const service = createDashboardService({ stores: tempStore(), meta: () => ({}) })
    const plain = call(service, '/mc-dashboard')
    const embedded = call(service, '/mc-dashboard?embed=1')
    expect(embedded.status).toBe(200)
    // Derived from the same source: both keep the four tabs and the shell id.
    for (const marker of ['ov-cards', 'sess-body', 'proj-body', 'log-body']) {
      expect(plain.text).toContain(marker)
      expect(embedded.text).toContain(marker)
    }
    // The embed only changes the outer breathing room the panel already supplies.
    expect(plain.text).toContain('padding: 18px 20px 60px')
    expect(embedded.text).toContain('padding: 10px 12px 40px')
    expect(embedded.text).not.toContain('padding: 18px 20px 60px')
    expect(embedded.text.length).toBeLessThan(plain.text.length)
  })

  it('never fetches an unprefixed relative path (that resolves to the shell and 401s)', () => {
    const service = createDashboardService({ stores: tempStore(), meta: () => ({}) })
    for (const url of ['/mc-dashboard', '/mc-dashboard?embed=1']) {
      const text = call(service, url).text
      // The page lives at `/mc-dashboard` with NO trailing slash, so a relative
      // `api/overview` resolves against the parent and becomes `/api/overview` —
      // the shell's own route, behind its cookie gate. That is exactly how the
      // in-shell panel rendered blank: every request came back 401.
      // Only the fetch/open sites matter: `getJson('api/...')` or a bare
      // `window.open('api/...')`. Route names in prose are harmless.
      expect(text).not.toMatch(/getJson\(\s*['"]api\//)
      expect(text).not.toMatch(/window\.open\(\s*['"]api\//)
      expect(text).toContain("var API = '/mc-dashboard/api/'")
      for (const route of ['overview', 'sessions', 'projects', 'journal?limit=400', 'session?session=']) {
        expect(text).toContain(route)
      }
    }
  })
})
