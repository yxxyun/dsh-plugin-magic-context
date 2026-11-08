/**
 * `drop-landed`'s estTokens must measure what the drop REMOVED.
 *
 * Why this file exists: the first version built its `seq -> text` map AFTER the
 * replacement loop had already run, so every lookup returned the freshly
 * written `[dropped §N§]` placeholder. The estimate was therefore always 0 and
 * the journal claimed "landed 165 drop(s)" with `estTokens: 0` — the reclaim
 * lane looked like it reclaimed nothing (measured live 2026-11-09). The map now
 * captures the surface BEFORE any replacement.
 *
 * The fake session here is a real surface: `append` with a `surfaceOp: replace`
 * shadows the previous seq, so building the map late genuinely reads the
 * placeholder — exactly the failure mode the fix removes. A stub that returned
 * the same text either way would pass regardless of the bug.
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
  return {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  } as unknown as Journal
}

const silentLogger = { info: () => {}, warn: () => {} }

const BODY = 'x'.repeat(4_000)

/**
 * A surface that behaves like the host's: `append` records an event and, when
 * it carries `surfaceOp: replace`, shadows the prior seq so only the new one is
 * visible. `snapshotEvents` keeps every event, which is how the real seam finds
 * the original to re-append.
 */
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
  return session
}

function baseStores(pending: number[]): AdapterStores {
  return {
    listPendingDrops: () => pending,
    getTag: (_sessionId: string, ref: { callId: string }) => {
      const map: Record<string, number> = { 'call-a': 7, 'call-b': 8 }
      return map[ref.callId]
    },
    markDropLanded: () => {},
    markCompartmentLanded: () => {},
    listCompartments: () => [],
    listNotes: () => [],
    listUnlandedCompartments: () => [],
  } as unknown as AdapterStores
}

describe('drop-landed reports the tokens the drop removed', () => {
  it('estimates from the pre-replacement text, not the placeholder', () => {
    const entries: Recorded[] = []
    const session = surfaceSession()

    // Two tool results on the surface, each 4k characters of text.
    for (const callId of ['call-a', 'call-b']) {
      const seq = nextSeqOf(session)
      ;(session as unknown as { append: (t: string, d: unknown) => { seq: number } }).append('tool/call', {
        callId,
        name: 'Read',
      })
      ;(session as unknown as { append: (t: string, d: unknown) => { seq: number } }).append('tool/result', {
        turn: 1,
        step: 1,
        message: { toolCallId: callId, content: [{ type: 'text', text: BODY }] },
      })
      void seq
    }

    const result = runManagementPass({
      session: session as never,
      sessionId: 'mc-drop-estimate',
      stores: baseStores([7, 8]),
      policy: DEFAULT_POLICY,
      logger: silentLogger,
      pass: { kind: 'execute', reason: 'execute-threshold' },
      pressure: 42.5,
      journal: recordingJournal(entries),
    })

    const landed = entries.find(entry => entry.kind === 'drop-landed')
    expect(landed).toBeDefined()
    expect(landed?.data?.count).toBe(2)
    // 8,000 characters ≈ 2,000 tokens. The bug produced 0 here.
    expect(landed?.data?.estTokens as number).toBeGreaterThan(1_500)
  })
})

/** The next seq the fake session will hand out (it is monotonic, 1-based). */
function nextSeqOf(session: { snapshotEvents: () => unknown[] }): number {
  return session.snapshotEvents().length + 1
}
