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
import { vectorBackfillEnabled } from '../src/dsh/maintenance-wiring.ts'

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
