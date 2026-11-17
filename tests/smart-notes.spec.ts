/**
 * The smart-note maintenance tick.
 *
 * What has to hold:
 *  - a parked note whose condition becomes true flips to `ready` and is then
 *    visible in the default read view;
 *  - a false condition keeps it parked and moves the deadline forward, without
 *    counting as a failure;
 *  - a check that ERRORS retries and only surfaces the note after repeated
 *    failures, because a single timeout is not evidence about the condition;
 *  - the tick never throws, so one bad note cannot abort the others.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openStores, type AdapterStores } from '../src/core/stores.ts'
import { nextSurfaceCheckAt, SURFACE_CHECK_INTERVAL_MS } from '../src/core/surface-condition.ts'
import { isPermittedCheckUrl, runSmartNoteTick } from '../src/dsh/smart-notes.ts'

let dir: string
let stores: AdapterStores
const ROOT = 'C:/work/project'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mc-smart-'))
  stores = openStores(join(dir, 'test.db'))
})

afterEach(() => {
  try { stores.close() } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true })
})

/** Park a smart note whose condition the seams will decide. */
function park(condition: string, now = 1_000): number {
  const row = stores.createNote({
    content: 'Watch the build output\nDetail line.',
    projectPath: ROOT,
    surfaceCondition: condition,
    nextCheckAt: nextSurfaceCheckAt(undefined, now),
  }, now)
  return row.id
}

describe('smart note lifecycle', () => {
  it('is created parked, not active', () => {
    const id = park('file-exists(dist/out.js)')
    const row = stores.getNote(id)
    expect(row?.type).toBe('smart')
    expect(row?.status).toBe('pending')
    expect(row?.surfaceCondition).toBe('file-exists(dist/out.js)')
  })

  it('does not appear in the default read view while parked', () => {
    park('file-exists(dist/out.js)')
    expect(stores.listNotes({ projectPath: ROOT, status: 'open' })).toEqual([])
    expect(stores.listNotes({ projectPath: ROOT, status: 'pending' })).toHaveLength(1)
  })

  it('becomes ready when the condition holds, and then shows in the open view', async () => {
    const id = park('file-exists(dist/out.js)')
    const now = nextSurfaceCheckAt(undefined, 1_000) + 1

    const result = await runSmartNoteTick({
      stores,
      now: () => now,
      seams: { readFile: async () => 'built' },
    })

    expect(result.checked).toBe(1)
    expect(result.woken).toEqual([id])
    const row = stores.getNote(id)
    expect(row?.status).toBe('ready')
    expect(row?.readyReason).toContain('condition holds')
    // The whole point of parking it: it is now visible without being asked for.
    expect(stores.listNotes({ projectPath: ROOT, status: 'open' }).map(note => note.id)).toEqual([id])
  })

  it('stays parked when the condition is false, and reschedules without failing', async () => {
    const id = park('file-exists(dist/out.js)')
    const now = nextSurfaceCheckAt(undefined, 1_000) + 1

    const result = await runSmartNoteTick({
      stores,
      now: () => now,
      seams: { readFile: async () => null },
    })

    expect(result.woken).toEqual([])
    expect(result.failed).toEqual([])
    const row = stores.getNote(id)
    expect(row?.status).toBe('pending')
    // A false condition is progress: the failure counter must stay at zero.
    expect(row?.checkFailureCount ?? 0).toBe(0)
    expect(row?.readyAt).toBe(now + SURFACE_CHECK_INTERVAL_MS)
  })

  it('skips a note whose deadline has not arrived', async () => {
    park('file-exists(dist/out.js)', 1_000)
    const result = await runSmartNoteTick({ stores, now: () => 2_000 })
    expect(result.checked).toBe(0)
  })
})

describe('error handling', () => {
  it('counts an errored check without waking the note', async () => {
    const id = park('file-exists(dist/out.js)')
    const now = nextSurfaceCheckAt(undefined, 1_000) + 1

    const result = await runSmartNoteTick({
      stores,
      now: () => now,
      seams: { readFile: async () => { throw new Error('EACCES') } },
    })

    expect(result.failed).toEqual([id])
    expect(result.woken).toEqual([])
    expect(stores.getNote(id)?.status).toBe('pending')
    expect(stores.getNote(id)?.checkFailureCount).toBe(1)
  })

  it('surfaces a note once its checks have failed repeatedly', async () => {
    const id = park('file-exists(dist/out.js)')
    let now = nextSurfaceCheckAt(undefined, 1_000) + 1

    // Five consecutive errored checks; the fifth surfaces it with a warning so it
    // cannot park invisibly forever.
    for (let attempt = 0; attempt < 5; attempt++) {
      await runSmartNoteTick({
        stores,
        now: () => now,
        seams: { readFile: async () => { throw new Error('EACCES') } },
      })
      now = (stores.getNote(id)?.readyAt ?? now) + 1
    }

    const row = stores.getNote(id)
    expect(row?.status).toBe('ready')
    expect(row?.readyReason).toContain('failed 5 times')
    expect(row?.readyReason).toContain('EACCES')
  })

  it('treats an unparseable stored condition as a failure rather than throwing', async () => {
    // Simulate a row written by an older grammar: the tick must record it, not die.
    const now = 2_000
    const row = stores.createNote({
      content: 'legacy',
      projectPath: ROOT,
      surfaceCondition: 'not-a-condition',
      nextCheckAt: 1_000,
    }, 1_000)

    const result = await runSmartNoteTick({ stores, now: () => now })
    expect(result.failed).toEqual([row.id])
    expect(stores.getNote(row.id)?.status).toBe('pending')
  })

  it('keeps checking the remaining notes after one of them fails', async () => {
    const first = park('file-exists(a.txt)', 1_000)
    const second = park('file-exists(b.txt)', 1_000)
    const now = nextSurfaceCheckAt(undefined, 1_000) + 1

    const result = await runSmartNoteTick({
      stores,
      now: () => now,
      seams: {
        readFile: async (path) => {
          if (path.endsWith('a.txt')) throw new Error('boom')
          return 'present'
        },
      },
    })

    expect(result.failed).toEqual([first])
    expect(result.woken).toEqual([second])
  })
})

describe('isPermittedCheckUrl', () => {
  it('permits a normal public https URL', () => {
    expect(isPermittedCheckUrl('https://api.github.com/repos/a/b')).toBe(true)
  })

  it('refuses loopback, private ranges, metadata and non-http schemes', () => {
    for (const url of [
      'http://localhost/x',
      'http://127.0.0.1/x',
      'http://127.5.5.5/x',
      'http://10.0.0.1/x',
      'http://192.168.1.1/x',
      'http://172.16.0.1/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://box.local/x',
      'file:///etc/passwd',
      'ftp://x.test/a',
      'not a url',
    ]) {
      expect(isPermittedCheckUrl(url), url).toBe(false)
    }
  })

  it('permits a public address just outside the private 172 range', () => {
    expect(isPermittedCheckUrl('http://172.32.0.1/x')).toBe(true)
  })
})
