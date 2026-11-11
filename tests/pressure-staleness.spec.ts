/**
 * Pressure-reading staleness (2026-11-11, upstream adapter v0.11.2 / MC v0.49.50).
 *
 * A usage reading describes the prompt the provider actually served. Once the
 * injected surface changes — a compartment is stored, the m[0] baseline is
 * refreshed — that prompt no longer exists. The reading is still the only size
 * signal the pass decision has, so it keeps driving execute/defer; but it must
 * not drive a SECOND forced reclaim, because reclaim is irreversible and would
 * drop content against a measurement of a larger wire.
 *
 * Upstream MC fixed the same class in v0.49.49 (`usagePredatesHistoryChange`
 * ahead of `e5d4a6ca5`). The deadlock half of that fix does not apply here: the
 * adapter has no refusal path.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_POLICY } from '../src/core/policy.ts'
import { openStores, type AdapterStores, type UsageRecord } from '../src/core/stores.ts'
import type { Journal } from '../src/core/journal.ts'
import { runManagementPass } from '../src/dsh/management-pass.ts'

const T0 = 1_700_000_000_000
const SESSION = 'mc-stale-reading'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
  }
})

function openStore(): AdapterStores {
  const dir = mkdtempSync(join(tmpdir(), 'mc-stale-'))
  tempDirs.push(dir)
  return openStores(dir)
}

function usage(recordedAt: number): UsageRecord {
  return { sessionId: SESSION, seq: 1, turn: 1, step: 1, provider: 'mock', model: 'mock', inputTokens: 1000, recordedAt }
}

function saveBaseline(stores: AdapterStores, now: number): void {
  stores.saveBaselineState({ sessionId: SESSION, epoch: 1, frozenAt: now, updatedAt: now })
}

describe('latestHistoryChangeAt', () => {
  it('is undefined before anything changed the injected surface', () => {
    const stores = openStore()
    try {
      expect(stores.latestHistoryChangeAt(SESSION)).toBeUndefined()
    } finally {
      stores.close()
    }
  })

  it('reports the newest baseline refresh', () => {
    const stores = openStore()
    try {
      saveBaseline(stores, T0 + 500)
      expect(stores.latestHistoryChangeAt(SESSION)).toBe(T0 + 500)
      saveBaseline(stores, T0 + 900)
      expect(stores.latestHistoryChangeAt(SESSION)).toBe(T0 + 900)
    } finally {
      stores.close()
    }
  })

  it('is per-session', () => {
    const stores = openStore()
    try {
      saveBaseline(stores, T0 + 500)
      expect(stores.latestHistoryChangeAt('another-session')).toBeUndefined()
    } finally {
      stores.close()
    }
  })

  it('a reading recorded before the change is stale; after it is not', () => {
    // The pre-step comparison in one place: `historyChangedAt > latest.recordedAt`.
    const stores = openStore()
    try {
      const reading = usage(T0)
      saveBaseline(stores, T0 + 1)
      const historyChangedAt = stores.latestHistoryChangeAt(SESSION)
      expect(historyChangedAt !== undefined && historyChangedAt > reading.recordedAt).toBe(true)
      const fresh = usage(T0 + 2)
      expect(historyChangedAt !== undefined && historyChangedAt > fresh.recordedAt).toBe(false)
    } finally {
      stores.close()
    }
  })
})

interface Recorded {
  readonly level: string
  readonly kind: string
  readonly summary: string
  readonly data: unknown
}

function recordingJournal(entries: Recorded[]): Journal {
  const record = (level: string) => (kind: string, summary: string, data?: unknown): void => {
    entries.push({ level, kind, summary, data })
  }
  return { info: record('info'), warn: record('warn'), error: record('error') } as unknown as Journal
}

/** An empty surface: reclaim has nothing to drop, so only the DECISION is pinned. */
const emptySession = {
  snapshotEvents: () => [],
  surface: { nodes: [], replaceGeneration: 0 },
} as unknown as Parameters<typeof runManagementPass>[0]['session']

const silentLogger = { info: () => {}, warn: () => {} }

function pass(stores: AdapterStores, entries: Recorded[], extra: { pressureStale?: boolean }) {
  return runManagementPass({
    session: emptySession,
    sessionId: SESSION,
    stores,
    policy: DEFAULT_POLICY,
    logger: silentLogger,
    pass: { kind: 'execute', reason: 'execute-threshold' },
    // DEFAULT_POLICY.forceThreshold is 85: this reading is in the force band.
    pressure: 92.5,
    ...extra,
    journal: recordingJournal(entries),
  })
}

describe('the force band refuses a stale reading', () => {
  it('skips reclaim and journals why when the reading predates the surface change', () => {
    const stores = openStore()
    const entries: Recorded[] = []
    try {
      const result = pass(stores, entries, { pressureStale: true })
      const row = entries.find(entry => entry.kind === 'emergency-reclaim')
      expect(row?.data).toMatchObject({ tier: 'skipped-stale-reading', reason: 'stale-reading', dropped: 0, pressure: 92.5 })
      expect(row?.summary).toContain('predates a surface change')
      expect(result).toMatchObject({ forceDropped: 0 })
    } finally {
      stores.close()
    }
  })

  it('enters the reclaim lane exactly as before when the reading is current', () => {
    const stores = openStore()
    const entries: Recorded[] = []
    try {
      pass(stores, entries, {})
      // Current reading + empty surface: the lane runs and finds nothing to drop,
      // which journals nothing at all (the pre-existing shape).
      expect(entries.some(entry => entry.kind === 'emergency-reclaim')).toBe(false)
    } finally {
      stores.close()
    }
  })
})
