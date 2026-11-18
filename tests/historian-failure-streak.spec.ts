/**
 * The consecutive-failure counter and its "speak up once" gate
 * (upstream `HISTORIAN_PERSISTENT_FAILURE_THRESHOLD` + the notice dedupe).
 *
 * The gate matters as much as the counter: a permanently broken history model
 * would otherwise repaint the conversation on every turn, which is how a useful
 * warning becomes noise the user learns to skip.
 */
import { describe, expect, it } from 'vitest'
import type { AdapterStores } from '../src/core/stores.ts'
import {
  clearHistorianFailures,
  historianFailureCount,
  recordHistorianFailure,
  shouldNoticeHistorianFailures,
} from '../src/dsh/historian.ts'

function metaStores(): AdapterStores {
  const meta = new Map<string, string>()
  return {
    getMeta: (key: string) => meta.get(key),
    setMeta: (key: string, value: string) => { meta.set(key, value) },
  } as unknown as AdapterStores
}

const SESSION = 'mc-failure-streak'
const THRESHOLD = 3

describe('historian failure streak', () => {
  it('starts at zero and increments on each failure', () => {
    const stores = metaStores()
    expect(historianFailureCount(stores, SESSION)).toBe(0)
    expect(recordHistorianFailure(stores, SESSION)).toBe(1)
    expect(recordHistorianFailure(stores, SESSION)).toBe(2)
    expect(historianFailureCount(stores, SESSION)).toBe(2)
  })

  it('clears on a successful publish', () => {
    const stores = metaStores()
    recordHistorianFailure(stores, SESSION)
    recordHistorianFailure(stores, SESSION)
    clearHistorianFailures(stores, SESSION)
    expect(historianFailureCount(stores, SESSION)).toBe(0)
  })

  it('treats an unreadable store as zero rather than throwing', () => {
    const broken = { getMeta: () => { throw new Error('boom') } } as unknown as AdapterStores
    expect(historianFailureCount(broken, SESSION)).toBe(0)
  })
})

describe('shouldNoticeHistorianFailures', () => {
  it('stays quiet below the threshold', () => {
    const stores = metaStores()
    expect(shouldNoticeHistorianFailures(stores, SESSION, 1, THRESHOLD)).toBe(false)
    expect(shouldNoticeHistorianFailures(stores, SESSION, 2, THRESHOLD)).toBe(false)
  })

  it('speaks once at the threshold', () => {
    const stores = metaStores()
    expect(shouldNoticeHistorianFailures(stores, SESSION, 3, THRESHOLD)).toBe(true)
    // Same count again: already warned, stay quiet.
    expect(shouldNoticeHistorianFailures(stores, SESSION, 3, THRESHOLD)).toBe(false)
    expect(shouldNoticeHistorianFailures(stores, SESSION, 4, THRESHOLD)).toBe(false)
  })

  it('speaks again when the streak materially doubles', () => {
    const stores = metaStores()
    expect(shouldNoticeHistorianFailures(stores, SESSION, 3, THRESHOLD)).toBe(true)
    expect(shouldNoticeHistorianFailures(stores, SESSION, 6, THRESHOLD)).toBe(true)
    expect(shouldNoticeHistorianFailures(stores, SESSION, 7, THRESHOLD)).toBe(false)
  })

  it('lets a fresh streak speak after a success clears the marker', () => {
    const stores = metaStores()
    expect(shouldNoticeHistorianFailures(stores, SESSION, 3, THRESHOLD)).toBe(true)
    clearHistorianFailures(stores, SESSION)
    expect(shouldNoticeHistorianFailures(stores, SESSION, 3, THRESHOLD)).toBe(true)
  })
})
