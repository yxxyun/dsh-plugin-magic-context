/**
 * When a routine digest may start, and what it may cost.
 *
 * Measured 2026-11-11 (live store + session transcripts): a publish costs one
 * full-price step (~200–350 k) whenever the provider's prompt cache is alive.
 * Publishes whose previous step was 1–16 s old were followed by 0–14 % reuse;
 * publishes preceded by 427–1703 s of idle were followed by 12–27 % — the cache
 * had already expired, so that rewrite was free. The provider's cache also dies
 * after ~5 min regardless of what we do (21/21 turn openings under 5 min reused
 * 100 %; 5–10 min gaps collapsed 5/5).
 *
 * Hence the two windows: an IDLE pass is the cheap window (the band only fired
 * because `ttlMs` elapsed, i.e. the cache is gone) and a digest belongs there;
 * an ACTIVE pass waits for the force band. An earlier revision had this exactly
 * backwards — it blocked idle digests, which pushed every rewrite into the paid
 * window.
 *
 * The second case here is the other half of the same measurement: while a run is
 * in flight nothing publishes, so the baseline refresh waits instead of paying
 * for a second rewrite of the same prefix 20–30 s before the digest lands
 * (12:08:58 + 12:09:26 cost 534 k tokens to reclaim 92 k).
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY } from '../src/core/policy.ts'
import type { AdapterStores } from '../src/core/stores.ts'
import type { Journal } from '../src/core/journal.ts'
import { runManagementPass } from '../src/dsh/management-pass.ts'

interface Recorded {
  level: string
  kind: string
  summary: string
  data: Record<string, unknown> | undefined
}

function recordingJournal(entries: Recorded[]): Journal {
  const record = (level: string) => (kind: string, summary: string, data?: Record<string, unknown>) => {
    entries.push({ level, kind, summary, data })
  }
  return { info: record('info'), warn: record('warn'), error: record('error') } as unknown as Journal
}

const silentLogger = { info: () => {}, warn: () => {} }

function surfaceSession() {
  const events: Array<Record<string, unknown>> = []
  let nextSeq = 1
  const surface = { nodes: [] as number[], replaceGeneration: 0 }
  const session = {
    snapshotEvents: () => events.slice(),
    surface,
    append: (type: string, data: Record<string, unknown>, options?: Record<string, unknown>) => {
      const seq = nextSeq++
      events.push({ seq, type, data })
      const op = (options as { surfaceOp?: { op: string; startSeq: number; endSeq: number } } | undefined)?.surfaceOp
      if (op?.op === 'replace') {
        surface.nodes = surface.nodes.filter(node => node < op.startSeq || node > op.endSeq)
        surface.replaceGeneration += 1
      }
      surface.nodes.push(seq)
      return { seq }
    },
  }
  session.append('user', { turn: 1, message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } })
  return session
}

function baseStores(): AdapterStores {
  return {
    listPendingDrops: () => [],
    getTag: () => undefined,
    markDropLanded: () => {},
    retireDrop: () => {},
    markCompartmentLanded: () => {},
    markCompartmentRejected: () => {},
    listCompartments: () => [],
    listNotes: () => [],
    listUnlandedCompartments: () => [],
    baselineState: () => undefined,
    saveBaselineState: () => {},
    coveredSeqs: () => new Set<number>(),
    recallMemories: () => [],
  } as unknown as AdapterStores
}

const historianSeam = () => ({ llm: { complete: async () => ({ text: '', usage: undefined }) } as never })

function pass(reason: 'cache-ttl-idle' | 'execute-threshold', pressure: number | undefined, extra: Record<string, unknown> = {}) {
  return {
    session: surfaceSession() as never,
    sessionId: `mc-admission-${reason}-${String(pressure)}`,
    stores: baseStores(),
    policy: DEFAULT_POLICY, // execute 65 / force 85
    logger: silentLogger,
    pass: { kind: 'execute' as const, reason },
    pressure,
    ...extra,
  }
}

describe('historian admission: the idle window is the cheap one', () => {
  it('starts a digest on an idle pass, even far below the force band', () => {
    const entries: Recorded[] = []
    const result = runManagementPass({
      ...pass('cache-ttl-idle', 18, { journal: recordingJournal(entries), historian: historianSeam() }),
    })
    expect(result.historianRequested).toBe(true)
    expect(entries.find(entry => entry.kind === 'historian')).toBeUndefined()
  })

  it('holds an active pass below the force band, and says why', () => {
    const entries: Recorded[] = []
    const result = runManagementPass({
      ...pass('execute-threshold', 45, { journal: recordingJournal(entries), historian: historianSeam() }),
    })
    expect(result.historianRequested).toBe(false)
    const row = entries.find(entry => entry.kind === 'historian')
    expect(row?.data).toMatchObject({ phase: 'active-below-force', pressure: 45, forceThreshold: 85 })
  })

  it('starts one on an active pass at or above the force band', () => {
    const result = runManagementPass({
      ...pass('execute-threshold', 86, { historian: historianSeam() }),
    })
    expect(result.historianRequested).toBe(true)
  })

  it('an unknown window pressure never blocks the digest', () => {
    const result = runManagementPass({
      ...pass('execute-threshold', undefined, { historian: historianSeam() }),
    })
    expect(result.historianRequested).toBe(true)
  })
})

describe('a run in flight does not buy a second rewrite', () => {
  it('defers the baseline refresh while nothing has published', () => {
    const entries: Recorded[] = []
    const result = runManagementPass(pass('cache-ttl-idle', 20, {
      journal: recordingJournal(entries),
      historianBusy: true,
    }))
    expect(result.baselineUpdated).toBe(false)
    const row = entries.find(entry => entry.kind === 'baseline')
    expect(row?.data).toMatchObject({ phase: 'deferred-historian-in-flight', trigger: 'cache-ttl-idle' })
  })

  it('journals no deferral when no run is in flight', () => {
    // The control only needs the deferral to be absent: whether the baseline
    // actually changes is refreshBaseline's own call (it skips a no-op render).
    const entries: Recorded[] = []
    runManagementPass(pass('cache-ttl-idle', 20, { journal: recordingJournal(entries) }))
    expect(entries.find(entry => entry.kind === 'baseline')).toBeUndefined()
  })
})
