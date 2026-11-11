/**
 * An idle pass may LAND work; it may not OPEN a new digest.
 *
 * Measured on 2026-11-11 (live store, 1 M window): the idle band
 * (`cache-ttl-idle`, fired by `ttlMs`) started historian runs at 18–23 % of the
 * window, and publishing those compartments rewrote 190–220 k tokens of cached
 * prefix to reclaim 55–79 k — one full-price step each. The pass was "free"
 * only in theory: the band is a permission to land queued work, and a routine
 * digest below the force band has nowhere to pay for itself.
 *
 * These two cases pin the admission: below the force band nothing is started
 * (and the skip is journalled with its reason), at or above it the historian
 * fires as before. `pressure === undefined` still admits a digest — a session
 * whose window is unknown must not lose compaction entirely.
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
  // One user turn: the baseline needs somewhere to hang.
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

const historianSeam = () => ({
  llm: { complete: async () => ({ text: '', usage: undefined }) } as never,
})

function pass(args: { reason: 'cache-ttl-idle' | 'execute-threshold'; pressure: number | undefined }) {
  return { kind: 'execute' as const, reason: args.reason }
}

describe('historian admission on an idle pass', () => {
  it('does not start a digest below the force band, and says why', () => {
    const entries: Recorded[] = []
    const result = runManagementPass({
      session: surfaceSession() as never,
      sessionId: 'mc-idle-admission-low',
      stores: baseStores(),
      policy: DEFAULT_POLICY, // forceThreshold 85
      logger: silentLogger,
      pass: pass({ reason: 'cache-ttl-idle', pressure: 18 }),
      pressure: 18,
      journal: recordingJournal(entries),
      historian: historianSeam(),
    })
    expect(result.historianRequested).toBe(false)
    const row = entries.find(entry => entry.kind === 'historian')
    expect(row?.data).toMatchObject({ phase: 'idle-below-force', pressure: 18, forceThreshold: 85 })
  })

  it('still starts one at or above the force band', () => {
    const entries: Recorded[] = []
    const result = runManagementPass({
      session: surfaceSession() as never,
      sessionId: 'mc-idle-admission-high',
      stores: baseStores(),
      policy: DEFAULT_POLICY,
      logger: silentLogger,
      pass: pass({ reason: 'cache-ttl-idle', pressure: 86 }),
      pressure: 86,
      journal: recordingJournal(entries),
      historian: historianSeam(),
    })
    expect(result.historianRequested).toBe(true)
  })

  it('a pressure-driven pass is unaffected at the same low pressure', () => {
    // The gate is about IDLE pokes, not about low pressure: an execute pass that
    // earned its band from the threshold keeps its digest.
    const entries: Recorded[] = []
    const result = runManagementPass({
      session: surfaceSession() as never,
      sessionId: 'mc-idle-admission-exec',
      stores: baseStores(),
      policy: DEFAULT_POLICY,
      logger: silentLogger,
      pass: pass({ reason: 'execute-threshold', pressure: 66 }),
      pressure: 66,
      journal: recordingJournal(entries),
      historian: historianSeam(),
    })
    expect(result.historianRequested).toBe(true)
  })
})
