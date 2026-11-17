/**
 * `ctx_note` read paging and filtering (upstream parity).
 *
 * The queue this tool manages is exactly the one that grows in a long session,
 * and before this the read view was hard-wired to `status: 'open'` with a fixed
 * limit — so dismissed notes were unreachable and anything past the first page
 * was invisible with no way to ask for it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openStores, type AdapterStores } from '../src/core/stores.ts'

let dir: string
let stores: AdapterStores

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mc-notes-'))
  stores = openStores(join(dir, 'test.db'))
})

afterEach(() => {
  try { stores.close() } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true })
})

const SESSION = 'session-1'

/** Create `n` notes with distinct titles, oldest first. */
function seed(n: number): void {
  for (let i = 1; i <= n; i++) {
    stores.createNote({ content: `note ${String(i)}`, sessionId: SESSION }, 1_000 + i)
  }
}

describe('listNotes paging', () => {
  it('pages with limit and offset without overlap', () => {
    seed(5)
    const first = stores.listNotes({ sessionId: SESSION, limit: 2, offset: 0 })
    const second = stores.listNotes({ sessionId: SESSION, limit: 2, offset: 2 })
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
    // Newest first, so the second page continues with older ids.
    const firstIds = new Set(first.map(row => row.id))
    for (const row of second) expect(firstIds.has(row.id)).toBe(false)
  })

  it('returns an empty page past the end instead of wrapping', () => {
    seed(3)
    expect(stores.listNotes({ sessionId: SESSION, limit: 5, offset: 99 })).toEqual([])
  })

  it('keeps the default page size when limit is absent', () => {
    seed(30)
    // The read view's default; a long queue must not dump every row.
    expect(stores.listNotes({ sessionId: SESSION })).toHaveLength(25)
  })
})

describe('listNotes status filter', () => {
  it('hides dismissed rows from the default open view', () => {
    seed(3)
    const all = stores.listNotes({ sessionId: SESSION })
    stores.retireNotes([all[0]!.id], 'dismiss', 9_999)
    const open = stores.listNotes({ sessionId: SESSION, status: 'open' })
    expect(open.map(row => row.id)).not.toContain(all[0]!.id)
  })

  it('exposes dismissed rows when asked explicitly', () => {
    seed(2)
    const all = stores.listNotes({ sessionId: SESSION })
    stores.retireNotes([all[0]!.id], 'dismiss', 9_999)
    const dismissed = stores.listNotes({ sessionId: SESSION, status: 'dismissed' })
    expect(dismissed.map(row => row.id)).toContain(all[0]!.id)
  })

  it('includes dismissed rows when no status is given', () => {
    // That is what `filter:"all"` maps to: no WHERE clause at all.
    seed(2)
    const all = stores.listNotes({ sessionId: SESSION })
    stores.retireNotes([all[0]!.id], 'dismiss', 9_999)
    expect(stores.listNotes({ sessionId: SESSION })).toHaveLength(2)
  })
})
