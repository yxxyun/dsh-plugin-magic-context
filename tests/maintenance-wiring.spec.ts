/**
 * The one gate left in the sweep's old module: whether the vector lane runs.
 *
 * The sweep itself is gone — its steps became dream tasks (`curate` for TTL,
 * `verify`, `review-user-memories`, `evaluate-smart-notes`, plus the three
 * housekeeping tasks), because two schedulers on one store raced for the same
 * rows and the fixed-interval one always won.
 *
 * `vectorBackfillEnabled` stayed behind because it is still read by the
 * `backfill-vectors` handler, and because the default is a policy decision worth
 * pinning: ON for a config that never mentions the key.
 */
import { describe, expect, it } from 'vitest'
import { newestDreamRunAt, vectorBackfillEnabled } from '../src/dsh/maintenance-wiring.ts'
import type { JournalEntry } from '../src/core/journal.ts'

describe('vectorBackfill default (WP11 gate)', () => {
  it('is ON for a config that never mentions it — a fresh install backfills', () => {
    expect(vectorBackfillEnabled(undefined)).toBe(true)
    expect(vectorBackfillEnabled({})).toBe(true)
  })

  it('stays operator-off-able with an explicit false', () => {
    expect(vectorBackfillEnabled({ vectorBackfill: false })).toBe(false)
    expect(vectorBackfillEnabled({ vectorBackfill: true })).toBe(true)
  })
})


// `journal.tail` is `ORDER BY id DESC LIMIT n` — newest first. The panel's
// "last maintenance" walked that array backwards, so it reported the OLDEST
// dream-run the window still held: a timestamp up to 200 rows stale that read as
// "the sweeper stopped" (code analysis 2026-11-17, P0-4).
describe('newestDreamRunAt', () => {
  const entry = (id: number, kind: JournalEntry['kind']): JournalEntry => ({
    at: id, level: 'info', kind, summary: `row ${String(id)}`,
  })

  it('takes the first dream-run in a newest-first window, not the last', () => {
    // Newest first, exactly as the store returns them.
    const rows = [entry(9, 'dream-run'), entry(8, 'pass'), entry(7, 'dream-run'), entry(1, 'dream-run')]
    expect(newestDreamRunAt(rows)).toBe(9)
  })

  it('skips other kinds until it finds one', () => {
    const rows = [entry(9, 'pass'), entry(8, 'context-pressure'), entry(6, 'dream-run')]
    expect(newestDreamRunAt(rows)).toBe(6)
  })

  it('reports nothing when the window holds no dream run', () => {
    expect(newestDreamRunAt([entry(3, 'pass'), entry(2, 'boot')])).toBeUndefined()
    expect(newestDreamRunAt([])).toBeUndefined()
  })
})
