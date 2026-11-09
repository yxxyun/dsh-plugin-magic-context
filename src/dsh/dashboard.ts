/**
 * The read-only dashboard: one HTML page plus the JSON routes behind it.
 *
 * Why this exists at all: upstream Magic Context ships
 * `packages/dashboard` — a Tauri desktop app whose Rust half opens the SQLite
 * files directly. That shape does not transplant into DSH (a plugin cannot ship
 * a window, and the harness already owns a web server), but the *information* it
 * shows is exactly what this adapter's operator needs: which Sessions are
 * compacting, what the historian has digested, how much of the corpus is
 * verified, and what the journal has been doing. So the same data surface is
 * served from a route we own, as plain HTML + JSON, with no build step and no
 * new dependency — the same contract `src/client/index.js` keeps.
 *
 * Read-only by construction, with ONE exception: `POST /api/policy`.
 *
 * Every other route is a GET that calls only the store's `list*`/`get*` readers.
 * Upstream lets the dashboard write memories and edit config; doing that from a
 * page with no authentication (see below) would hand anyone on the loopback
 * interface a corpus editor, so the corpus editor is out of scope on purpose.
 *
 * The one write is deliberately the narrowest thing that is still useful: the two
 * pressure thresholds, and nothing else. It cannot name a file, cannot touch the
 * corpus, and its payload is validated by `parseOverride` (percent bounds, force
 * >= execute) before anything reaches disk. Rationale for having it at all: the
 * alternative is hand-editing `cordis.patch.yml` in the desktop profile, which is
 * Electron-exclusive and full of hand-written comments and js-tagged nodes — a
 * two-number preference should not require that surgery.
 *
 * Authentication: like `/mc-telemetry`, this route has none beyond the loopback
 * bind — the web server's own cookie gate sits in front of `/` and `/api`, and a
 * plugin prefix route is not behind it. The consequence is a hard rule this file
 * keeps: NO message content, NO memory content, NO file contents. Counts,
 * timestamps, kinds, identities, and compartment tier headers only. The journal
 * already stores no message text by construction; the corpus rows are never
 * serialized here.
 */
import type { AdapterStores, SessionSummaryRow } from '../core/stores.ts'
import { SCHEMA_VERSION } from '../core/stores.ts'
import type { Journal, JournalLevel } from '../core/journal.ts'
import type { MemoryWriter } from '../core/memory-write.ts'
import type { PressurePolicy } from '../core/policy.ts'
import {
  clearOverride,
  parseOverride,
  readOverride,
  writeOverride,
  type ThresholdOverride,
} from '../core/policy-override.ts'

/** The slice of the harness request/response we use (structural, no imports). */
export interface DashboardRequest {
  readonly url?: string
  readonly method?: string
  readonly headers?: Record<string, string | string[] | undefined>
  /** Body events, for the one POST route. Absent on a plain GET double. */
  on?(event: 'data' | 'end' | 'error', listener: (chunk?: unknown) => void): unknown
}
export interface DashboardResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown
  write?(chunk: string): unknown
  end(chunk?: string): unknown
  readonly writableEnded?: boolean
  on?(event: string, listener: () => void): unknown
}

export interface DashboardDeps {
  readonly stores: AdapterStores
  readonly journal?: Journal
  /**
   * The corpus writer, for the project list and the memory tallies. Optional:
   * an install whose `memories.db` is missing still gets the session half, and
   * the projects panel renders an explicit "corpus unavailable" instead of an
   * empty list that would read as "no memories".
   */
  readonly memoryWriter?: MemoryWriter
  /** Live adapter state for the header. */
  readonly meta: () => {
    readonly engine?: string
    readonly memory?: string
    readonly memoryWrite?: string
    readonly toolsMode?: string
  }
  readonly startedAt?: number
  readonly now?: () => number
  /** Session ids the process currently serves, newest first. */
  readonly liveSessions?: () => readonly string[]
  /**
   * The effective pressure policy (config + dashboard override), re-read per
   * call. Without it the page still renders; the policy panel says "unavailable"
   * rather than inventing numbers.
   */
  readonly policy?: () => PressurePolicy
  /**
   * The policy WITHOUT the dashboard override — i.e. what the config alone says.
   * The form needs both: `policy()` to show what is in force, this one so
   * "restore to configured" can name the target instead of guessing it.
   */
  readonly configuredPolicy?: () => PressurePolicy
  /**
   * Where the dashboard-editable override lives. `path` is also the write target,
   * so the route can only ever touch this one file.
   */
  readonly policyOverridePath?: string
}

export interface DashboardService {
  handle(req: DashboardRequest, res: DashboardResponse): void
  /** The JSON payloads, also used by the tests. */
  sessions(): Record<string, unknown>
  overview(): Record<string, unknown>
  session(sessionId: string): Record<string, unknown> | undefined
  journalTail(limit: number, sessionId?: string): Record<string, unknown>
  projects(): Record<string, unknown>
  /** The thresholds as they stand now, plus where the override sits. */
  policyState(): Record<string, unknown>
  /** The page itself (one string; cheap to rebuild, no template engine). */
  html(options?: { readonly embed?: boolean }): string
  close(): void
}

const DAY_MS = 24 * 60 * 60_000

/**
 * Normalize a `?session=` query value.
 * @param raw - the request URL's first `session` parameter.
 * @returns the Session id, or undefined for absent/empty.
 */
export function sessionOf(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined
  const value = raw.trim()
  return value === '' ? undefined : value
}

/**
 * Clamp a `?limit=` query value to a sane page size.
 * @param raw - the raw query parameter.
 * @param fallback - used when absent or unparsable.
 * @param max - the hard ceiling; a page that big is never useful and can be slow.
 */
export function limitOf(raw: string | null | undefined, fallback: number, max: number): number {
  if (raw === null || raw === undefined) return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(value, max)
}

export function createDashboardService(deps: DashboardDeps): DashboardService {
  const now = deps.now ?? Date.now

  const safe = <T>(read: () => T, fallback: T): T => {
    try {
      return read()
    } catch {
      /* a locked or missing table must degrade, not 500 */
      return fallback
    }
  }

  /** 24h window start, resolved per call so a long-lived service stays correct. */
  const since24h = (): number => now() - DAY_MS

  const rollup = (): Record<string, number> => {
    const since = now() - DAY_MS
    const counts: Record<string, number> = {}
    let errors = 0
    for (const row of safe(() => deps.stores.journalByKind(since), [])) {
      counts[row.kind] = (counts[row.kind] ?? 0) + row.count
      if (row.level === 'error') errors += row.count
    }
    return { ...counts, errors }
  }

  const sessions = (): Record<string, unknown> => {
    const rows: readonly SessionSummaryRow[] = safe(() => deps.stores.listSessions(500), [])
    const live = new Set(safe(() => deps.liveSessions?.() ?? [], []))
    return {
      generatedAt: now(),
      schemaVersion: SCHEMA_VERSION,
      dbPath: safe(() => deps.stores.dbPath, ''),
      sessions: rows.map(row => ({ ...row, live: live.has(row.sessionId) })),
    }
  }

  const overview = (): Record<string, unknown> => {
    const rows = safe(() => deps.stores.listSessions(500), [])
    const bounds = safe(() => deps.stores.journalBounds(), { rows: 0 })
    const projects = safe(() => deps.memoryWriter?.listProjects(500) ?? [], [])
    const corpus = safe(() => deps.memoryWriter?.status, undefined)
    // Computed once: the rollup walks every journal row of the window.
    const rollup24h = rollup()
    return {
      generatedAt: now(),
      adapter: {
        schemaVersion: SCHEMA_VERSION,
        uptimeMs: deps.startedAt === undefined ? undefined : now() - deps.startedAt,
        ...deps.meta(),
      },
      store: {
        dbPath: safe(() => deps.stores.dbPath, ''),
        corpusPath: safe(() => deps.memoryWriter?.dbPath, undefined),
        journalRows: bounds.rows,
        journalOldest: bounds.oldest,
        journalNewest: bounds.newest,
        corpus: corpus === undefined ? undefined : {
          ok: corpus.ok,
          ...corpus.detail === undefined ? {} : { detail: corpus.detail },
          ...corpus.corpusVersion === undefined ? {} : { corpusVersion: corpus.corpusVersion },
        },
      },
      totals: {
        sessions: rows.length,
        liveSessions: safe(() => deps.liveSessions?.() ?? [], []).length,
        compartments: rows.reduce((sum, row) => sum + row.compartments, 0),
        landedCompartments: rows.reduce((sum, row) => sum + row.landedCompartments, 0),
        pendingDrops: rows.reduce((sum, row) => sum + row.pendingDrops, 0),
        notes: rows.reduce((sum, row) => sum + row.notes, 0),
        projects: projects.length,
        memories: projects.reduce((sum, row) => sum + row.memories, 0),
        activeMemories: projects.reduce((sum, row) => sum + row.active, 0),
        unverifiedMemories: projects.reduce((sum, row) => sum + row.unverified, 0),
      },
      rollup24h: rollup24h,
      // The reclaim lane's real yield. `rollup24h['drop-landed']` counts ROWS,
      // and one row batches every queued stamp of a pass (measured 2026-11-09:
      // 165 tags in a single row), so the count reads as "1" and the lane looks
      // idle. Serve the batched payload too: tags actually landed and their
      // token estimate.
      reclaim24h: {
        rows: rollup24h['drop-landed'] ?? 0,
        tags: safe(() => deps.stores.journalSumField('drop-landed', 'count', since24h()), 0),
        estTokens: safe(() => deps.stores.journalSumField('drop-landed', 'estTokens', since24h()), 0),
      },
    }
  }

  const session = (sessionId: string): Record<string, unknown> | undefined => {
    const row = safe(() => deps.stores.listSessions(500), []).find(entry => entry.sessionId === sessionId)
    if (row === undefined) return undefined
    const compartments = safe(() => deps.stores.listCompartments(sessionId), [])
    const tags = safe(() => deps.stores.listTags(sessionId), [])
    const pendingDrops = safe(() => deps.stores.listPendingDrops(sessionId), [])
    const notes = safe(() => deps.stores.listNotes({ sessionId, limit: 100 }), [])
    return {
      generatedAt: now(),
      session: row,
      // Tier headers only: the bodies are the digests themselves, which is
      // exactly the content this route must not serve. `tier+p1` is the
      // one-line header the historian writes, so it is safe and it is the part
      // that tells an operator what the compartment is about.
      compartments: compartments.map(entry => ({
        compartmentId: entry.compartmentId,
        createdAt: entry.createdAt,
        coveredStartSeq: entry.coveredStartSeq,
        coveredEndSeq: entry.coveredEndSeq,
        coveredNodes: entry.coveredSeqs.length,
        coveredTokens: entry.coveredTokens,
        importance: entry.importance,
        header: entry.tiers.p1,
        facts: entry.facts.length,
        events: entry.events.length,
        baselineEpoch: entry.baselineEpoch,
        landed: entry.landedEventSeq !== undefined,
        ...entry.landedReason === undefined ? {} : { landedReason: entry.landedReason },
      })),
      tags: tags.map(entry => ({
        tagNumber: entry.tagNumber,
        targetKind: entry.target.kind,
        createdAt: entry.createdAt,
      })),
      pendingDrops,
      notes: notes.map(note => ({
        id: note.id,
        status: note.status,
        // Notes ARE content (`ctx_note` writes prose). The list route serves the
        // first line only, truncated: enough to identify the note, not enough to
        // be a content leak.
        preview: firstLine(note.content),
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      })),
    }
  }

  const journalTail = (limit: number, sessionId?: string): Record<string, unknown> => {
    const rows = safe(() => deps.stores.listJournal({
      limit,
      ...sessionId === undefined ? {} : { sessionId },
    }), [])
    return {
      generatedAt: now(),
      entries: rows.map(entry => ({
        at: entry.at,
        level: entry.level as JournalLevel,
        kind: entry.kind,
        summary: entry.summary,
        ...entry.sessionId === undefined ? {} : { sessionId: entry.sessionId },
        ...entry.data === undefined ? {} : { data: entry.data },
      })),
    }
  }

  const projects = (): Record<string, unknown> => {
    const writer = deps.memoryWriter
    if (writer === undefined) {
      return { generatedAt: now(), available: false, projects: [] }
    }
    const rows = safe(() => writer.listProjects(500), [])
    return {
      generatedAt: now(),
      available: true,
      dbPath: safe(() => writer.dbPath, ''),
      projects: rows,
    }
  }

  /**
   * The thresholds an operator may tune, and what is currently in force.
   *
   * `override` is the file's content (undefined = the configured values are in
   * force); `effective` is what the next pass will actually use, which is what
   * the form has to show — a stale override the operator forgot about must be
   * visible rather than silently winning.
   */
  const policyState = (): Record<string, unknown> => {
    const path = deps.policyOverridePath
    const effective = safe(() => deps.policy?.(), undefined)
    if (effective === undefined) {
      return { generatedAt: now(), available: false }
    }
    const configured = safe(() => deps.configuredPolicy?.() ?? deps.policy?.(), effective)
    const override = path === undefined ? undefined : safe(() => readOverride(path), undefined)
    return {
      generatedAt: now(),
      available: true,
      overridePath: path,
      effective: {
        executeThreshold: effective.executeThreshold,
        forceThreshold: effective.forceThreshold,
      },
      override: override === undefined
        ? undefined
        : {
          ...override.executeThreshold === undefined ? {} : { executeThreshold: override.executeThreshold },
          ...override.forceThreshold === undefined ? {} : { forceThreshold: override.forceThreshold },
        },
      configured: {
        // What the config alone says, so "restore to configured" can name the
        // target. Reading `policy()` here would echo the override back and make
        // the form claim the override IS the configured value.
        executeThreshold: configured?.executeThreshold,
        forceThreshold: configured?.forceThreshold,
      },
    }
  }

  /** Apply a validated override. Returns the state payload, or an error string. */
  const applyPolicyOverride = (raw: unknown): { ok: true } | { ok: false; error: string } => {
    const path = deps.policyOverridePath
    if (path === undefined) return { ok: false, error: 'policy override is not wired on this install' }
    const parsed = parseOverride(raw)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    // Merge onto whatever is already stored: the form may submit one field.
    const current = safe(() => readOverride(path), undefined) ?? {}
    const merged: ThresholdOverride = {
      ...current,
      ...parsed.value,
    }
    // Re-validate the merged pair: two individually valid values can still cross.
    const checked = parseOverride(merged)
    if (!checked.ok) return { ok: false, error: checked.error }
    try {
      writeOverride(path, checked.value)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'write failed' }
    }
  }

  const sendJson = (res: DashboardResponse, status: number, payload: unknown): void => {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(Buffer.byteLength(body)),
    })
    res.end(body)
  }

  const sendHtml = (res: DashboardResponse, body: string): void => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(Buffer.byteLength(body)),
      // The page is self-contained (inline style + script, no fetch to a third
      // origin), so the strictest policy that still allows inline works.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
  }

  /**
   * Read a request body with a hard ceiling.
   *
   * The cap is not politeness: this route has no auth beyond the loopback bind,
   * so an unbounded read is a memory-exhaustion lever for any local process. 8 KiB
   * is several orders of magnitude above the two numbers this route accepts.
   */
  const MAX_BODY_BYTES = 8 * 1024
  const readBody = (req: DashboardRequest): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      if (req.on === undefined) {
        resolve('')
        return
      }
      let size = 0
      const chunks: string[] = []
      req.on('data', (chunk) => {
        const text = typeof chunk === 'string' ? chunk : String(chunk)
        size += Buffer.byteLength(text)
        if (size > MAX_BODY_BYTES) {
          reject(new Error(`body exceeds ${String(MAX_BODY_BYTES)} bytes`))
          return
        }
        chunks.push(text)
      })
      req.on('end', () => { resolve(chunks.join('')) })
      req.on('error', () => { reject(new Error('body read failed')) })
    })

  return {
    sessions,
    overview,
    session,
    journalTail,
    projects,
    policyState,
    html: () => PAGE,
    close: () => undefined,
    handle: (req, res) => {
      const requestUrl = new URL(req.url ?? '/', 'http://dashboard.invalid')
      const base = '/mc-dashboard'
      const path = requestUrl.pathname.startsWith(base)
        ? requestUrl.pathname.slice(base.length) || '/'
        : requestUrl.pathname
      // The ONE write route. Everything else stays a read; the method check below
      // is deliberately after this branch so a POST to any other path is still a
      // 405 rather than falling through to a reader.
      if (path === '/api/policy') {
        if (req.method === 'DELETE') {
          const target = deps.policyOverridePath
          if (target === undefined) {
            sendJson(res, 400, { error: 'policy override is not wired on this install' })
            return
          }
          safe(() => clearOverride(target), false)
          sendJson(res, 200, { ok: true, ...policyState() })
          return
        }
        if (req.method === 'POST') {
          void readBody(req).then((body) => {
            let parsed: unknown
            try {
              parsed = body.trim() === '' ? {} : JSON.parse(body)
            } catch {
              sendJson(res, 400, { error: 'body must be JSON' })
              return
            }
            const outcome = applyPolicyOverride(parsed)
            if (!outcome.ok) {
              sendJson(res, 400, { error: outcome.error })
              return
            }
            sendJson(res, 200, { ok: true, ...policyState() })
          }).catch((error: unknown) => {
            sendJson(res, 413, { error: error instanceof Error ? error.message : 'body rejected' })
          })
          return
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          sendJson(res, 200, policyState())
          return
        }
        sendJson(res, 405, { error: 'method not allowed', allow: ['GET', 'HEAD', 'POST', 'DELETE'] })
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'read-only surface', allow: ['GET', 'HEAD'] })
        return
      }
      const sessionId = sessionOf(requestUrl.searchParams.get('session'))
      if (path === '/' || path === '' || path === '/index.html') {
        // `?embed=1` is the shell's iframe: the page keeps its own header, but
        // drops the outer padding it does not need inside a panel.
        sendHtml(res, requestUrl.searchParams.get('embed') === '1' ? EMBED_PAGE : PAGE)
        return
      }
      if (path === '/api/overview') {
        sendJson(res, 200, overview())
        return
      }
      if (path === '/api/sessions') {
        sendJson(res, 200, sessions())
        return
      }
      if (path === '/api/projects') {
        sendJson(res, 200, projects())
        return
      }
      if (path === '/api/journal') {
        sendJson(res, 200, journalTail(
          limitOf(requestUrl.searchParams.get('limit'), 200, 2_000),
          sessionId,
        ))
        return
      }
      if (path === '/api/session') {
        if (sessionId === undefined) {
          sendJson(res, 400, { error: 'session parameter required' })
          return
        }
        const payload = session(sessionId)
        if (payload === undefined) {
          sendJson(res, 404, { error: 'unknown session', sessionId })
          return
        }
        sendJson(res, 200, payload)
        return
      }
      sendJson(res, 404, {
        error: 'unknown dashboard route',
        routes: ['/', '/api/overview', '/api/sessions', '/api/projects', '/api/journal', '/api/session?session=<id>'],
      })
    },
  }
}

/** The first non-empty line of a note, clipped: an identifier, not a library. */
function firstLine(content: string): string {
  const line = content.split('\n').map(part => part.trim()).find(part => part !== '') ?? ''
  return line.length <= 120 ? line : `${line.slice(0, 119)}…`
}

/**
 * The page.
 *
 * One string, no build, no framework: it renders the four tabs an operator
 * actually opens (overview, sessions, one session, projects) and polls the JSON
 * routes. Everything is escaped before it reaches `innerHTML` — the numbers and
 * identities here are store-controlled, but a Session id or a project path is
 * host input and must not become markup.
 */
const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Magic Context · Dashboard</title>
<style>
  :root {
    color-scheme: dark light;
    --bg: #14161a; --panel: #1c1f26; --line: #2b3038;
    --fg: #e6e8ec; --dim: #98a0ae; --accent: #6ea8fe;
    --ok: #4ec9a5; --warn: #e0b341; --bad: #e06c75;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f7f9; --panel: #fff; --line: #e2e5ea;
      --fg: #1d2026; --dim: #5c6472; --accent: #2f6fe4;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 13px/1.55 ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  header {
    position: sticky; top: 0; z-index: 2; background: var(--bg);
    border-bottom: 1px solid var(--line); padding: 12px 20px;
    display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap;
  }
  h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .2px; }
  nav { display: flex; gap: 4px; margin-left: auto; }
  nav button {
    background: none; border: 1px solid transparent; color: var(--dim);
    padding: 4px 10px; border-radius: 6px; cursor: pointer; font: inherit;
  }
  nav button[aria-current="page"] { color: var(--fg); border-color: var(--line); background: var(--panel); }
  nav button:hover { color: var(--fg); }
  main { padding: 18px 20px 60px; max-width: 1180px; }
  section { display: none; }
  section.active { display: block; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; margin-bottom: 18px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 11px 13px; }
  .card .k { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: .4px; }
  .card .v { font-size: 20px; font-variant-numeric: tabular-nums; margin-top: 2px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .5px; color: var(--dim);
       margin: 22px 0 8px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; background: var(--panel);
          border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: var(--dim); font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  td.num { font-variant-numeric: tabular-nums; text-align: right; }
  tbody tr.row { cursor: pointer; }
  tbody tr.row:hover { background: #ffffff08; }
  .mono { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12px; }
  .dim { color: var(--dim); }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; border: 1px solid var(--line); }
  .pill.live { color: var(--ok); border-color: #4ec9a555; }
  .pill.err { color: var(--bad); border-color: #e06c7555; }
  .bar { height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; min-width: 60px; }
  .bar > i { display: block; height: 100%; background: var(--accent); }
  .bar.warn > i { background: var(--warn); }
  .bar.bad > i { background: var(--bad); }
  .log { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
         max-height: 62vh; overflow: auto; }
  .log div { padding: 4px 10px; border-bottom: 1px solid var(--line); display: flex; gap: 9px; }
  .log div:last-child { border-bottom: none; }
  .log .t { color: var(--dim); flex: 0 0 auto; font-variant-numeric: tabular-nums; }
  .log .k { flex: 0 0 148px; color: var(--accent); }
  .log .s { flex: 1 1 auto; overflow-wrap: anywhere; }
  .log .err .s { color: var(--bad); }
  .empty { color: var(--dim); padding: 16px; text-align: center; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
  .toolbar input[type=search] {
    background: var(--panel); border: 1px solid var(--line); color: var(--fg);
    border-radius: 6px; padding: 5px 9px; font: inherit; min-width: 220px;
  }
  a { color: var(--accent); }
  footer { color: var(--dim); font-size: 11px; padding: 0 20px 24px; max-width: 1180px; }
</style>
</head>
<body>
<header>
  <h1>Magic Context</h1>
  <span class="dim" id="stamp"></span>
  <nav>
    <button data-tab="overview" aria-current="page">概览</button>
    <button data-tab="sessions">会话</button>
    <button data-tab="projects">项目记忆</button>
    <button data-tab="policy">策略</button>
    <button data-tab="journal">日志</button>
  </nav>
</header>
<main>
  <section id="overview" class="active">
    <div class="grid" id="ov-cards"></div>
    <h2>24 小时活动</h2>
    <div class="grid" id="ov-rollup"></div>
    <h2>适配器</h2>
    <table><tbody id="ov-adapter"></tbody></table>
  </section>

  <section id="sessions">
    <div class="toolbar">
      <input type="search" id="sess-filter" placeholder="按 session id 过滤…">
      <span class="dim" id="sess-count"></span>
    </div>
    <table>
      <thead><tr>
        <th>会话</th><th>状态</th><th class="num">压力</th><th class="num">快照</th>
        <th class="num">日志</th><th class="num">用量</th><th class="num">待落地</th><th class="num">笔记</th><th>最后活动</th>
      </tr></thead>
      <tbody id="sess-body"></tbody>
    </table>
  </section>

  <section id="projects">
    <div class="grid" id="proj-cards"></div>
    <table>
      <thead><tr>
        <th>项目标识</th><th class="num">总计</th><th class="num">生效</th><th class="num">已归档</th>
        <th class="num">已验证</th><th class="num">待验证</th><th class="num">类别</th><th>最后更新</th>
      </tr></thead>
      <tbody id="proj-body"></tbody>
    </table>
  </section>

  <section id="policy">
    <div class="grid" id="pol-cards"></div>
    <h2>压力阈值</h2>
    <p class="dim" style="margin:0 0 10px">
      达到「压缩」百分比时，管理轮开始重写上下文（压缩 + 落地排队的 reduce）；
      达到「强制」百分比时，不再等待，直接应急回收最旧、最低优先级的工具输出。
      强制值必须 ≥ 压缩值。保存后下一次管理轮即刻生效，无需重启。
    </p>
    <div class="toolbar" style="gap:10px;align-items:flex-end;flex-wrap:wrap">
      <label style="display:flex;flex-direction:column;gap:4px">
        <span class="dim">压缩 executeThreshold (%)</span>
        <input type="number" id="pol-exec" min="1" max="100" step="1" style="width:110px">
      </label>
      <label style="display:flex;flex-direction:column;gap:4px">
        <span class="dim">强制 forceThreshold (%)</span>
        <input type="number" id="pol-force" min="1" max="100" step="1" style="width:110px">
      </label>
      <button id="pol-save">保存</button>
      <button id="pol-reset">恢复配置值</button>
      <span id="pol-msg" class="dim"></span>
    </div>
    <h2>快捷预设</h2>
    <div class="toolbar" style="gap:8px;flex-wrap:wrap" id="pol-presets"></div>
    <h2>生效来源</h2>
    <table><tbody id="pol-detail"></tbody></table>
  </section>

  <section id="journal">
    <div class="toolbar">
      <input type="search" id="log-filter" placeholder="按 kind / summary 过滤…">
      <span class="dim" id="log-count"></span>
    </div>
    <div class="log" id="log-body"></div>
  </section>
</main>
<footer>只读面板 · 数据来自本机 magic-context 双库 · 不含任何消息或记忆正文</footer>
<script>
(function () {
  'use strict'
  // ── helpers ──────────────────────────────────────────────────────────────
  var esc = function (value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    })
  }
  var num = function (value) {
    if (value == null) return '—'
    if (typeof value !== 'number') return esc(value)
    return value.toLocaleString('en-US')
  }
  // Compact token counts: 12.4k / 1.2M. The rollup cards have a fixed width and
  // raw six-digit numbers wrap.
  var kfmt = function (value) {
    if (typeof value !== 'number' || !isFinite(value)) return '—'
    if (value >= 1e6) return (value / 1e6).toFixed(1).replace(/\\.0$/, '') + 'M'
    if (value >= 1e3) return (value / 1e3).toFixed(1).replace(/\\.0$/, '') + 'k'
    return String(Math.round(value))
  }
  var ago = function (at) {
    if (typeof at !== 'number') return '—'
    var d = Date.now() - at
    if (d < 0) d = 0
    var s = Math.round(d / 1000)
    if (s < 60) return s + 's'
    if (s < 3600) return Math.round(s / 60) + 'm'
    if (s < 86400) return Math.round(s / 3600) + 'h'
    return Math.round(s / 86400) + 'd'
  }
  var clock = function (at) {
    if (typeof at !== 'number') return '—'
    var d = new Date(at)
    return d.toLocaleString('zh-CN', { hour12: false })
  }
  var bar = function (pct) {
    if (typeof pct !== 'number' || !isFinite(pct)) return '<span class="dim">—</span>'
    var v = Math.max(0, Math.min(100, pct))
    var cls = v >= 85 ? 'bar bad' : v >= 65 ? 'bar warn' : 'bar'
    return '<div style="display:flex;gap:7px;align-items:center;justify-content:flex-end">'
      + '<div class="' + cls + '" style="width:64px"><i style="width:' + v.toFixed(1) + '%"></i></div>'
      + '<span class="mono" style="min-width:44px">' + v.toFixed(1) + '%</span></div>'
  }
  var card = function (label, value, extra) {
    return '<div class="card"><div class="k">' + esc(label) + '</div>'
      + '<div class="v">' + value + '</div>'
      + (extra ? '<div class="dim" style="font-size:11px">' + extra + '</div>' : '')
      + '</div>'
  }
  var getJson = function (url) {
    return fetch(url, { headers: { accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error(url + ' → ' + r.status)
      return r.json()
    })
  }
  var write = function (id, html) {
    var node = document.getElementById(id)
    if (node) node.innerHTML = html
  }

  // ── state ────────────────────────────────────────────────────────────────
  var state = { tab: 'overview', sessions: [], journal: [], loaded: {} }

  // ── overview ─────────────────────────────────────────────────────────────
  function renderOverview(data) {
    var t = data.totals || {}
    write('ov-cards',
      card('会话', num(t.sessions), '在线 ' + num(t.liveSessions)) +
      card('压缩快照', num(t.compartments), '已落地 ' + num(t.landedCompartments)) +
      card('待落地回收', num(t.pendingDrops)) +
      card('笔记', num(t.notes)) +
      card('项目', num(t.projects)) +
      card('记忆', num(t.memories), '生效 ' + num(t.activeMemories) + ' · 待验证 ' + num(t.unverifiedMemories)))

    var roll = data.rollup24h || {}
    var order = ['pass', 'compartment-published', 'drop-landed', 'emergency-reclaim',
                 'memory-promote', 'memory-recall', 'context-pressure', 'errors']
    var labels = {
      'pass': '管理轮', 'compartment-published': '快照发布', 'drop-landed': '回收落地',
      'emergency-reclaim': '应急回收', 'memory-promote': '记忆写入', 'memory-recall': '记忆召回',
      'context-pressure': '压力读数', 'errors': '错误'
    }
    write('ov-rollup', order.map(function (key) {
      // The reclaim lane reports its yield, not its row count: a single row can
      // batch every stamp of a pass, so "1" both hides and misstates the work.
      if (key === 'drop-landed') {
        var rec = data.reclaim24h || {}
        return card(labels[key], num(rec.tags || 0),
          (rec.estTokens ? '≈' + kfmt(rec.estTokens) + ' tokens · ' : '') + num(rec.rows || 0) + ' 次落地')
      }
      return card(labels[key] || key, num(roll[key] || 0))
    }).join(''))

    var a = data.adapter || {}
    var s = data.store || {}
    var rows = [
      ['Schema 版本', num(a.schemaVersion)],
      ['进程运行', typeof a.uptimeMs === 'number' ? ago(Date.now() - a.uptimeMs) : '—'],
      ['压缩引擎', esc(a.engine || '—')],
      ['记忆桥', esc(a.memory || '—')],
      ['记忆写入', esc(a.memoryWrite || '—')],
      ['工具模式', esc(a.toolsMode || '—')],
      ['适配器库', '<span class="mono">' + esc(s.dbPath || '—') + '</span>'],
      ['语料库', '<span class="mono">' + esc(s.corpusPath || '（不可用）') + '</span>'],
      ['日志行数', num(s.journalRows)],
      ['日志时间跨度', clock(s.journalOldest) + ' → ' + clock(s.journalNewest)],
      ['语料状态', s.corpus ? (s.corpus.ok ? '<span class="pill live">ok</span>' : '<span class="pill err">' + esc(s.corpus.detail || 'unavailable') + '</span>') : '—']
    ]
    write('ov-adapter', rows.map(function (row) {
      return '<tr><td class="dim" style="width:170px">' + row[0] + '</td><td class="mono">' + row[1] + '</td></tr>'
    }).join(''))
    write('stamp', '更新于 ' + new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour12: false }))
  }

  // ── sessions ─────────────────────────────────────────────────────────────
  function renderSessions() {
    var filter = (document.getElementById('sess-filter').value || '').trim().toLowerCase()
    var rows = state.sessions.filter(function (row) {
      return filter === '' || row.sessionId.toLowerCase().indexOf(filter) !== -1
    })
    write('sess-count', rows.length + ' / ' + state.sessions.length + ' 个会话')
    if (rows.length === 0) {
      write('sess-body', '<tr><td colspan="9" class="empty">没有会话</td></tr>')
      return
    }
    write('sess-body', rows.map(function (row) {
      return '<tr class="row" data-session="' + esc(row.sessionId) + '">'
        + '<td class="mono">' + esc(row.sessionId) + '</td>'
        + '<td>' + (row.live ? '<span class="pill live">在线</span>' : '<span class="dim">历史</span>') + '</td>'
        + '<td class="num">' + bar(row.latestPressure) + '</td>'
        + '<td class="num">' + num(row.landedCompartments) + ' / ' + num(row.compartments) + '</td>'
        + '<td class="num">' + num(row.journalRows) + '</td>'
        + '<td class="num">' + num(row.usageRows) + '</td>'
        + '<td class="num">' + num(row.pendingDrops) + '</td>'
        + '<td class="num">' + num(row.notes) + '</td>'
        + '<td><span title="' + esc(clock(row.lastAt)) + '">' + ago(row.lastAt) + ' 前</span></td>'
        + '</tr>'
    }).join(''))
  }

  // ── projects ─────────────────────────────────────────────────────────────
  function renderProjects(data) {
    if (!data.available) {
      write('proj-cards', '<div class="card"><div class="k">语料库</div><div class="v" style="font-size:14px">不可用</div>'
        + '<div class="dim" style="font-size:11px">memories.db 未挂载，记忆面板无数据</div></div>')
      write('proj-body', '<tr><td colspan="8" class="empty">语料库不可用</td></tr>')
      return
    }
    var rows = data.projects || []
    var total = rows.reduce(function (s, r) { return s + r.memories }, 0)
    var active = rows.reduce(function (s, r) { return s + r.active }, 0)
    var pending = rows.reduce(function (s, r) { return s + r.unverified }, 0)
    write('proj-cards',
      card('项目', num(rows.length)) + card('记忆总计', num(total)) +
      card('生效', num(active)) + card('待验证', num(pending)))
    if (rows.length === 0) {
      write('proj-body', '<tr><td colspan="8" class="empty">语料库为空</td></tr>')
      return
    }
    write('proj-body', rows.map(function (row) {
      return '<tr>'
        + '<td class="mono">' + esc(row.identity) + '</td>'
        + '<td class="num">' + num(row.memories) + '</td>'
        + '<td class="num">' + num(row.active) + '</td>'
        + '<td class="num">' + num(row.archived) + '</td>'
        + '<td class="num">' + num(row.verified) + '</td>'
        + '<td class="num">' + num(row.unverified) + '</td>'
        + '<td class="num">' + num(row.categories) + '</td>'
        + '<td><span title="' + esc(clock(row.lastUpdatedAt)) + '">' + ago(row.lastUpdatedAt) + ' 前</span></td>'
        + '</tr>'
    }).join(''))
  }

  // ── journal ──────────────────────────────────────────────────────────────
  function renderJournal() {
    var filter = (document.getElementById('log-filter').value || '').trim().toLowerCase()
    var rows = state.journal.filter(function (row) {
      if (filter === '') return true
      return (row.kind + ' ' + row.summary).toLowerCase().indexOf(filter) !== -1
    })
    write('log-count', rows.length + ' / ' + state.journal.length + ' 条')
    if (rows.length === 0) {
      write('log-body', '<div class="empty">没有日志</div>')
      return
    }
    write('log-body', rows.map(function (row) {
      return '<div class="' + (row.level === 'error' ? 'err' : '') + '">'
        + '<span class="t">' + esc(clock(row.at)) + '</span>'
        + '<span class="k">' + esc(row.kind) + '</span>'
        + '<span class="s">' + esc(row.summary) + '</span>'
        + '</div>'
    }).join(''))
  }

  // ── loaders ──────────────────────────────────────────────────────────────
  // Absolute, prefixed paths — not a bare relative one. The page is served at
  // /mc-dashboard (no trailing slash), so a relative "api/overview" resolves
  // against the parent and becomes /api/overview: the shell's own route, which
  // answers 401 behind its cookie gate. That is exactly how the panel went blank.
  var API = '/mc-dashboard/api/'
  function loadOverview() { return getJson(API + 'overview').then(renderOverview) }
  function loadSessions() {
    return getJson(API + 'sessions').then(function (data) {
      state.sessions = data.sessions || []
      renderSessions()
    })
  }
  function loadProjects() { return getJson(API + 'projects').then(renderProjects) }
  function loadJournal() {
    return getJson(API + 'journal?limit=400').then(function (data) {
      state.journal = (data.entries || []).slice().reverse()
      renderJournal()
    })
  }

  function refresh() {
    var job = state.tab === 'overview' ? loadOverview()
      : state.tab === 'sessions' ? loadSessions()
      : state.tab === 'projects' ? loadProjects()
      : state.tab === 'policy' ? loadPolicy()
      : loadJournal()
    job.catch(function (error) {
      write('stamp', '读取失败：' + esc(error.message))
    })
  }

  // ── policy (the one editable surface) ────────────────────────────────────
  // Presets are the shapes an operator actually wants: the shipped defaults, the
  // aggressive pair this install has been running, and a conservative pair for
  // long sessions where a cache bust is expensive.
  var PRESETS = [
    { label: '保守 65 / 85（默认）', exec: 65, force: 85 },
    { label: '激进 30 / 50', exec: 30, force: 50 },
    { label: '更激进 20 / 40', exec: 20, force: 40 },
    { label: '宽松 80 / 95', exec: 80, force: 95 }
  ]

  function polMsg(text, bad) {
    var node = document.getElementById('pol-msg')
    if (!node) return
    node.textContent = text
    node.style.color = bad ? 'var(--bad, #e5484d)' : ''
  }

  function renderPolicy(data) {
    if (!data || data.available === false) {
      write('pol-cards', card('策略', '不可用', '未接上 policy 读取'))
      write('pol-detail', '')
      return
    }
    var eff = data.effective || {}
    var ov = data.override || {}
    write('pol-cards',
      card('压缩阈值', num(eff.executeThreshold) + '%',
        ov.executeThreshold === undefined ? '来自配置' : '来自仪表板覆盖') +
      card('强制阈值', num(eff.forceThreshold) + '%',
        ov.forceThreshold === undefined ? '来自配置' : '来自仪表板覆盖') +
      card('覆盖状态', data.override ? '已覆盖' : '无覆盖',
        data.override ? '点「恢复配置值」撤销' : '配置值原样生效'))

    // Fill the form only when the operator is not mid-edit: overwriting a
    // half-typed number on the 5s poll would fight the user.
    var exec = document.getElementById('pol-exec')
    var force = document.getElementById('pol-force')
    var active = document.activeElement
    if (exec && active !== exec) exec.value = eff.executeThreshold == null ? '' : eff.executeThreshold
    if (force && active !== force) force.value = eff.forceThreshold == null ? '' : eff.forceThreshold

    var rows = [
      ['生效值', num(eff.executeThreshold) + '% / ' + num(eff.forceThreshold) + '%'],
      ['覆盖文件', data.overridePath ? esc(data.overridePath) : '—'],
      ['覆盖内容', data.override
        ? 'execute=' + num(ov.executeThreshold) + ' force=' + num(ov.forceThreshold)
        : '（无，使用配置值）'],
      ['说明', '保存后下一次管理轮生效；ctx_reduce 的落地仍绑定在压缩轮上（KV cache 取舍）。']
    ]
    write('pol-detail', rows.map(function (row) {
      return '<tr><th>' + esc(row[0]) + '</th><td>' + row[1] + '</td></tr>'
    }).join(''))
  }

  function loadPolicy() {
    return getJson(API + 'policy').then(renderPolicy)
  }

  function savePolicy(body) {
    return fetch(API + 'policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (payload) {
        if (!r.ok) throw new Error(payload.error || ('HTTP ' + r.status))
        return payload
      })
    }).then(function (payload) {
      renderPolicy(payload)
      polMsg('已保存，下一次管理轮生效')
      return payload
    }).catch(function (error) {
      polMsg('保存失败：' + error.message, true)
      throw error
    })
  }

  function resetPolicy() {
    return fetch(API + 'policy', { method: 'DELETE', headers: { accept: 'application/json' } })
      .then(function (r) { return r.json() })
      .then(function (payload) {
        renderPolicy(payload)
        polMsg('已恢复为配置值')
      })
      .catch(function (error) { polMsg('恢复失败：' + error.message, true) })
  }

  // ── wiring ───────────────────────────────────────────────────────────────
  var tabs = Array.prototype.slice.call(document.querySelectorAll('nav button'))
  tabs.forEach(function (button) {
    button.addEventListener('click', function () {
      var tab = button.getAttribute('data-tab')
      state.tab = tab
      tabs.forEach(function (other) {
        if (other === button) other.setAttribute('aria-current', 'page')
        else other.removeAttribute('aria-current')
      })
      Array.prototype.slice.call(document.querySelectorAll('section')).forEach(function (section) {
        section.classList.toggle('active', section.id === tab)
      })
      refresh()
    })
  })

  var sessFilter = document.getElementById('sess-filter')
  if (sessFilter) sessFilter.addEventListener('input', renderSessions)
  var logFilter = document.getElementById('log-filter')
  if (logFilter) logFilter.addEventListener('input', renderJournal)

  var polSave = document.getElementById('pol-save')
  if (polSave) polSave.addEventListener('click', function () {
    var exec = document.getElementById('pol-exec')
    var force = document.getElementById('pol-force')
    var body = {}
    if (exec && exec.value !== '') body.executeThreshold = Number(exec.value)
    if (force && force.value !== '') body.forceThreshold = Number(force.value)
    if (body.executeThreshold === undefined && body.forceThreshold === undefined) {
      polMsg('先填一个数值', true)
      return
    }
    // Client-side pre-check for the pair rule, so the common mistake gets an
    // instant message instead of a round-trip.
    if (body.executeThreshold !== undefined && body.forceThreshold !== undefined
      && body.forceThreshold < body.executeThreshold) {
      polMsg('强制阈值必须 ≥ 压缩阈值', true)
      return
    }
    polSave.disabled = true
    savePolicy(body).catch(function () {}).then(function () { polSave.disabled = false })
  })
  var polReset = document.getElementById('pol-reset')
  if (polReset) polReset.addEventListener('click', function () {
    polReset.disabled = true
    resetPolicy().then(function () { polReset.disabled = false })
  })
  var polPresets = document.getElementById('pol-presets')
  if (polPresets) {
    PRESETS.forEach(function (preset) {
      var button = document.createElement('button')
      button.textContent = preset.label
      button.addEventListener('click', function () {
        savePolicy({ executeThreshold: preset.exec, forceThreshold: preset.force }).catch(function () {})
      })
      polPresets.appendChild(button)
    })
  }

  document.getElementById('sess-body').addEventListener('click', function (event) {
    var row = event.target.closest('tr[data-session]')
    if (!row) return
    var id = row.getAttribute('data-session')
    // The session detail is a JSON read; opening it in a new tab keeps this page
    // stateless and gives a URL an operator can paste into a bug report.
    window.open(API + 'session?session=' + encodeURIComponent(id), '_blank', 'noopener')
  })

  refresh()
  setInterval(function () { if (state.tab === 'overview' || state.tab === 'sessions') refresh() }, 5000)
})()
</script>
</body>
</html>
`

export { PAGE as DASHBOARD_PAGE }

/**
 * The same document, tuned for the in-shell iframe (`?embed=1`).
 *
 * Derived from {@link PAGE} rather than kept as a second copy: there is exactly
 * one document, and embedding only changes the outer breathing room (the panel
 * already supplies the shell's margins). Keeping two literals in sync by hand is
 * how a page starts disagreeing with itself.
 */
const EMBED_PAGE = PAGE.replace(
  'main { padding: 18px 20px 60px; max-width: 1180px; }',
  'main { padding: 10px 12px 40px; max-width: none; }',
).replace(
  'header {\n    position: sticky; top: 0; z-index: 2; background: var(--bg);\n    border-bottom: 1px solid var(--line); padding: 12px 20px;',
  'header {\n    position: sticky; top: 0; z-index: 2; background: var(--bg);\n    border-bottom: 1px solid var(--line); padding: 8px 12px;',
).replace(
  'footer { color: var(--dim); font-size: 11px; padding: 0 20px 24px; max-width: 1180px; }',
  'footer { color: var(--dim); font-size: 11px; padding: 0 12px 16px; max-width: none; }',
)

export { EMBED_PAGE as DASHBOARD_EMBED_PAGE }
