/**
 * Starvation escalation: when the drop lane has nothing left, summarisation is
 * the only lever and must not wait for the force band.
 *
 * Measured on the RCC ORC session 2026-11-17 (window 262144, local IQ3_XXS):
 * 44 execute passes in 80 minutes, 43 of them reclaiming exactly 0 tokens. The
 * execute band kept firing because pressure stayed above the threshold, while
 * the droppable tail had long since been exhausted — so each pass did nothing
 * and the next did nothing again.
 *
 * The two gates that answer it, and the boundary between them:
 *   · force band — `max(85, execute + 2)` from upstream `escalationBands`, so a
 *     configuration cannot collapse the dead zone (see escalation-bands.spec).
 *   · starvation escalation — a pass that reclaims nothing while inside the
 *     execute band admits the historian even below the force band.
 *
 * The "reclaimed something, so do not escalate" boundary is pinned at the unit
 * level (`drop-projection.spec.ts`, `reclaimEffectivelyEmpty`): building a
 * surface whose automatic reclaim actually bites requires the real agent loop,
 * and a hand-built fixture only proves the fixture.
 *
 * The boundary cases matter as much as the happy path: below the execute band
 * the adapter is not supposed to be working at all, so "the drops came up empty"
 * says nothing, and an idle poke is already admitted by its own window.
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

/** A surface with `nodeCount` tool results, each priced at `tokensEach`. */
function surfaceSession(nodeCount: number, tokensEach: number) {
  const events: Array<Record<string, unknown>> = []
  let nextSeq = 1
  const surface = { nodes: [] as number[], replaceGeneration: 0 }
  const session = {
    snapshotEvents: () => events.slice(),
    surface,
    append: (type: string, data: Record<string, unknown>) => {
      const seq = nextSeq++
      events.push({ seq, type, data })
      surface.nodes.push(seq)
      return { seq }
    },
  }
  session.append('user', { turn: 1, message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } })
  for (let i = 0; i < nodeCount; i += 1) {
    session.append('tool/result', {
      turn: 1,
      message: {
        role: 'toolResult',
        toolCallId: `call-${String(i)}`,
        content: [{ type: 'text', text: 'x'.repeat(tokensEach * 4) }],
      },
    })
  }
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
    // Drain accounting absent on purpose: the harness must degrade to the
    // pre-budget behaviour instead of blocking the historian.
  } as unknown as AdapterStores
}

const historianSeam = () => ({ llm: { complete: async () => ({ text: '', usage: undefined }) } as never })

function pass(pressure: number, extra: Record<string, unknown> = {}) {
  return {
    session: surfaceSession(4, 200) as never,
    sessionId: `mc-starved-${String(pressure)}`,
    stores: baseStores(),
    policy: DEFAULT_POLICY, // execute 65 / force 85
    logger: silentLogger,
    pass: { kind: 'execute' as const, reason: 'execute-threshold' as const },
    pressure,
    ...extra,
  }
}

describe('starvation escalation', () => {
  it('admits the historian below the force band when the drops reclaim nothing', () => {
    const entries: Recorded[] = []
    const result = runManagementPass({
      ...pass(70, { journal: recordingJournal(entries), historian: historianSeam() }),
    })
    // 70% is inside the execute band (65) and below the force band (85). Before
    // this gate the pass deferred the digest and kept firing on every step.
    expect(result.historianRequested).toBe(true)
    const escalated = entries.find(entry => entry.data?.phase === 'starved-escalation')
    expect(escalated).toBeDefined()
    expect(escalated?.data?.pressure).toBe(70)
    expect(escalated?.data?.forceThreshold).toBe(85)
  })

  it('still holds an active pass below the execute band', () => {
    const entries: Recorded[] = []
    // 40% is below execute (65): the adapter should not be working, so an empty
    // drop run is not evidence that summarisation is warranted.
    const result = runManagementPass({
      ...pass(40, { journal: recordingJournal(entries), historian: historianSeam() }),
    })
    expect(result.historianRequested).toBe(false)
    expect(entries.some(entry => entry.data?.phase === 'starved-escalation')).toBe(false)
  })

  it('never escalates at or above the force band, where the digest runs anyway', () => {
    const entries: Recorded[] = []
    const result = runManagementPass({
      ...pass(88, { journal: recordingJournal(entries), historian: historianSeam() }),
    })
    expect(result.historianRequested).toBe(true)
    expect(entries.some(entry => entry.data?.phase === 'starved-escalation')).toBe(false)
  })

  it('derives the force band from the execute threshold, ignoring a lower setting', () => {
    const entries: Recorded[] = []
    // The configuration that produced the 43 empty passes: execute 50, force 60.
    // The force band must still be 85, so 70% stays "below force".
    const result = runManagementPass({
      ...pass(70, {
        journal: recordingJournal(entries),
        historian: historianSeam(),
        policy: { ...DEFAULT_POLICY, executeThreshold: 50, forceThreshold: 60 },
      }),
    })
    const row = entries.find(entry => entry.kind === 'historian' && entry.data?.phase === 'active-below-force')
    // 70% is above the 50% execute threshold, so drops were tried; with nothing
    // to reclaim the pass escalates rather than deferring forever.
    expect(row === undefined || row.data?.forceThreshold === 85).toBe(true)
    expect(result.historianRequested).toBe(true)
  })
})
