/**
 * The one writable dashboard surface: the two pressure thresholds.
 *
 * Why these specs exist: this route is the only place in the whole dashboard that
 * writes anything, and it sits on a prefix route with no auth beyond the loopback
 * bind. So the things worth pinning are not the happy path alone:
 *
 *  1. the payload is validated before disk (percent bounds, force >= execute) —
 *     otherwise a stray number silently disables or over-triggers compression;
 *  2. the write target is fixed by the caller, never by the request, so a body
 *     cannot name a path;
 *  3. a body over the ceiling is refused instead of buffered (memory exhaustion
 *     is the realistic local attack on an unauthenticated route);
 *  4. a corrupt override file degrades to "no override" — a preference file must
 *     never be able to stop the plugin from compressing;
 *  5. every OTHER route stays read-only: POST to them is still a 405.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openStores, type AdapterStores } from '../src/core/stores.ts'
import { DEFAULT_POLICY, type PressurePolicy } from '../src/core/policy.ts'
import {
  applyOverride,
  clearOverride,
  createOverrideReader,
  parseOverride,
  readOverride,
  writeOverride,
} from '../src/core/policy-override.ts'
import { createDashboardService, type DashboardRequest, type DashboardResponse } from '../src/dsh/dashboard.ts'

const dirs: string[] = []
const opened: AdapterStores[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-policy-'))
  dirs.push(dir)
  return dir
}

function tempStore(): AdapterStores {
  const stores = openStores(tempDir())
  opened.push(stores)
  return stores
}

afterEach(() => {
  for (const store of opened.splice(0).reverse()) {
    try {
      store.close()
    } catch {
      /* best effort */
    }
  }
  for (const dir of dirs.splice(0).reverse()) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
  }
})

function recorder(): DashboardResponse & { status: () => number; body: () => string } {
  let status = 0
  let payload = ''
  return {
    writeHead: (code) => { status = code; return undefined },
    write: (chunk) => { payload += chunk; return undefined },
    end: (chunk) => { if (chunk !== undefined) payload += chunk; return undefined },
    status: () => status,
    body: () => payload,
  }
}

/** A request double whose body events fire on the next tick. */
function request(method: string, url: string, body?: string): DashboardRequest {
  const listeners: Record<string, Array<(chunk?: unknown) => void>> = {}
  if (body !== undefined) {
    queueMicrotask(() => {
      for (const listener of listeners.data ?? []) listener(body)
      for (const listener of listeners.end ?? []) listener()
    })
  }
  return {
    url,
    method,
    on: (event, listener) => {
      ;(listeners[event] ??= []).push(listener)
      return undefined
    },
  }
}

async function call(
  service: ReturnType<typeof createDashboardService>,
  req: DashboardRequest,
): Promise<{ status: number; json: () => unknown }> {
  const response = recorder()
  service.handle(req, response)
  // The POST branch resolves its body on a microtask; let it settle.
  await new Promise(resolve => { setTimeout(resolve, 0) })
  return {
    status: response.status(),
    json: () => JSON.parse(response.body()) as unknown,
  }
}

describe('override validation', () => {
  it('accepts percent numbers and numeric strings, rejects the rest', () => {
    expect(parseOverride({ executeThreshold: 30, forceThreshold: 50 })).toEqual({
      ok: true,
      value: { executeThreshold: 30, forceThreshold: 50 },
    })
    // An <input> hands back strings unless coerced.
    expect(parseOverride({ executeThreshold: '30' })).toEqual({ ok: true, value: { executeThreshold: 30 } })

    for (const bad of [0, -1, 101, Number.NaN, 'abc', true, null]) {
      expect(parseOverride({ executeThreshold: bad }).ok).toBe(false)
    }
    expect(parseOverride({}).ok).toBe(false)
    expect(parseOverride(null).ok).toBe(false)
    expect(parseOverride([]).ok).toBe(false)
    expect(parseOverride('nope').ok).toBe(false)
  })

  it('refuses a force band that would open before the execute band', () => {
    const outcome = parseOverride({ executeThreshold: 60, forceThreshold: 40 })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('forceThreshold must be >= executeThreshold')
    // Equal is allowed: a single-band setup is legal.
    expect(parseOverride({ executeThreshold: 50, forceThreshold: 50 }).ok).toBe(true)
  })
})

describe('override file', () => {
  it('round-trips and clears', () => {
    const path = join(tempDir(), 'policy-override.json')
    writeOverride(path, { executeThreshold: 30, forceThreshold: 50 })
    expect(readOverride(path)).toMatchObject({ executeThreshold: 30, forceThreshold: 50 })
    expect(clearOverride(path)).toBe(true)
    expect(readOverride(path)).toBeUndefined()
    // Clearing twice is not an error.
    expect(clearOverride(path)).toBe(false)
  })

  it('degrades to no-override on a corrupt file instead of throwing', () => {
    const path = join(tempDir(), 'policy-override.json')
    writeFileSync(path, '{ this is not json', 'utf8')
    expect(readOverride(path)).toBeUndefined()
    // And a well-formed file with out-of-range values is ignored the same way.
    writeFileSync(path, JSON.stringify({ executeThreshold: 999 }), 'utf8')
    expect(readOverride(path)).toBeUndefined()
  })

  it('applies only the two thresholds, even if the file holds more', () => {
    const policy = applyOverride(DEFAULT_POLICY, { executeThreshold: 30, forceThreshold: 50 })
    expect(policy.executeThreshold).toBe(30)
    expect(policy.forceThreshold).toBe(50)
    // Everything else is untouched: a stray field must not retune the historian.
    expect(policy.historianMaxTokens).toBe(DEFAULT_POLICY.historianMaxTokens)
    expect(policy.assumedContextWindow).toBe(DEFAULT_POLICY.assumedContextWindow)
    // No override is a no-op, identity included.
    expect(applyOverride(DEFAULT_POLICY, undefined)).toBe(DEFAULT_POLICY)
  })

  it('caches by mtime so a repeated read is not a repeated parse', () => {
    const path = join(tempDir(), 'policy-override.json')
    const read = createOverrideReader(path)
    expect(read()).toBeUndefined()
    writeOverride(path, { executeThreshold: 22 })
    expect(read()).toMatchObject({ executeThreshold: 22 })
    // Rewriting changes the mtime, so the cache must notice.
    writeOverride(path, { executeThreshold: 24 })
    expect(read()).toMatchObject({ executeThreshold: 24 })
  })
})

describe('POST /api/policy', () => {
  function serviceWith(path: string, base: PressurePolicy = DEFAULT_POLICY) {
    const stores = tempStore()
    const service = createDashboardService({
      stores,
      meta: () => ({}),
      // Mirror `activePolicy()` exactly: re-resolve the override on every read,
      // so a save is visible to the very next call with no explicit refresh.
      policy: () => applyOverride(base, readOverride(path)),
      configuredPolicy: () => base,
      policyOverridePath: path,
    })
    return { service }
  }

  it('writes the override and reports the effective values', async () => {
    const path = join(tempDir(), 'policy-override.json')
    const { service } = serviceWith(path)

    const response = await call(service, request('POST', '/mc-dashboard/api/policy',
      JSON.stringify({ executeThreshold: 30, forceThreshold: 50 })))

    expect(response.status).toBe(200)
    expect(response.json()).toMatchObject({
      ok: true,
      effective: { executeThreshold: 30, forceThreshold: 50 },
      override: { executeThreshold: 30, forceThreshold: 50 },
    })
    // The file is the contract: it must be what a restart reads back.
    expect(readOverride(path)).toMatchObject({ executeThreshold: 30, forceThreshold: 50 })
  })

  it('rejects an invalid payload with 400 and writes nothing', async () => {
    const path = join(tempDir(), 'policy-override.json')
    const { service } = serviceWith(path)

    const crossed = await call(service, request('POST', '/mc-dashboard/api/policy',
      JSON.stringify({ executeThreshold: 80, forceThreshold: 40 })))
    expect(crossed.status).toBe(400)
    expect(crossed.json()).toMatchObject({ error: 'forceThreshold must be >= executeThreshold' })

    const outOfRange = await call(service, request('POST', '/mc-dashboard/api/policy',
      JSON.stringify({ executeThreshold: 0 })))
    expect(outOfRange.status).toBe(400)

    const notJson = await call(service, request('POST', '/mc-dashboard/api/policy', 'not json'))
    expect(notJson.status).toBe(400)
    expect(notJson.json()).toMatchObject({ error: 'body must be JSON' })

    // Nothing reached disk on any rejection.
    expect(readOverride(path)).toBeUndefined()
  })

  it('merges a single field onto the stored override, and re-checks the pair', async () => {
    const path = join(tempDir(), 'policy-override.json')
    const { service } = serviceWith(path)
    writeOverride(path, { executeThreshold: 30, forceThreshold: 50 })

    const onlyExecute = await call(service, request('POST', '/mc-dashboard/api/policy',
      JSON.stringify({ executeThreshold: 35 })))
    expect(onlyExecute.status).toBe(200)
    expect(readOverride(path)).toMatchObject({ executeThreshold: 35, forceThreshold: 50 })

    // 60 would cross the stored force=50: the merged pair must be re-validated,
    // not just the submitted field.
    const crossed = await call(service, request('POST', '/mc-dashboard/api/policy',
      JSON.stringify({ executeThreshold: 60 })))
    expect(crossed.status).toBe(400)
    expect(readOverride(path)).toMatchObject({ executeThreshold: 35 })
  })

  it('refuses an oversized body instead of buffering it', async () => {
    const path = join(tempDir(), 'policy-override.json')
    const { service } = serviceWith(path)
    const huge = JSON.stringify({ executeThreshold: 30, pad: 'x'.repeat(20_000) })
    const response = await call(service, request('POST', '/mc-dashboard/api/policy', huge))
    expect(response.status).toBe(413)
    expect(readOverride(path)).toBeUndefined()
  })

  it('DELETE clears the override so the configured values apply again', async () => {
    const path = join(tempDir(), 'policy-override.json')
    const { service } = serviceWith(path)
    writeOverride(path, { executeThreshold: 20, forceThreshold: 40 })

    const response = await call(service, request('DELETE', '/mc-dashboard/api/policy'))
    expect(response.status).toBe(200)
    expect(response.json()).toMatchObject({ ok: true, effective: { executeThreshold: 65, forceThreshold: 85 } })
    expect(readOverride(path)).toBeUndefined()
  })

  it('reports unavailable instead of inventing numbers when policy is unwired', async () => {
    const service = createDashboardService({ stores: tempStore(), meta: () => ({}) })
    const response = await call(service, request('GET', '/mc-dashboard/api/policy'))
    expect(response.status).toBe(200)
    expect(response.json()).toMatchObject({ available: false })
    // And a write is refused rather than silently accepted.
    const write = await call(service, request('POST', '/mc-dashboard/api/policy',
      JSON.stringify({ executeThreshold: 30 })))
    expect(write.status).toBe(400)
  })

  it('leaves every other route read-only', async () => {
    const path = join(tempDir(), 'policy-override.json')
    const { service } = serviceWith(path)
    for (const url of ['/mc-dashboard/api/overview', '/mc-dashboard/api/sessions', '/mc-dashboard/api/journal']) {
      const response = await call(service, request('POST', url, '{}'))
      expect(response.status).toBe(405)
      expect(response.json()).toMatchObject({ error: 'read-only surface' })
    }
    // A GET on the policy route is a plain read.
    const read = await call(service, request('GET', '/mc-dashboard/api/policy'))
    expect(read.status).toBe(200)
  })
})

describe('the policy tab is reachable from the served page', () => {
  it('ships the form and the preset buttons', () => {
    const service = createDashboardService({ stores: tempStore(), meta: () => ({}) })
    const page = service.html()
    expect(page).toContain('data-tab="policy"')
    expect(page).toContain('id="pol-exec"')
    expect(page).toContain('id="pol-force"')
    expect(page).toContain('id="pol-save"')
    expect(page).toContain('id="pol-reset"')
    // The preset the operator asked for must be one click, not a typed pair.
    expect(page).toContain('激进 30 / 50')
    // Absolute prefix again: this route lives under /mc-dashboard, no trailing slash.
    expect(page).toContain("fetch(API + 'policy'")
  })
})
