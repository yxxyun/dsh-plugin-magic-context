/**
 * The mass window and the count floor are independent, and the WIDER one wins.
 *
 * Upstream `computeProtectionWindow` computes `cutoff = min(mass_cutoff,
 * newest3_cutoff)` — the more conservative of the two bounds. Expressed over a
 * surface where each row carries its own tag, that is: a node is protected if
 * EITHER the mass window admits it OR it is inside the count floor.
 *
 * The failure this prevents is specific: a result larger than the whole window
 * consumes the budget before any other node is considered, so a mass-only walk
 * protects that single node and drops everything else — including the newest
 * results the model needs to reason about the very next step.
 */
import { describe, expect, it } from 'vitest'
import { protectionWindowTokens, reclaimForEmergency } from '../src/dsh/emergency.ts'
import { enumerateSurfaceToolResults } from '../src/dsh/seams.ts'
import { DEFAULT_POLICY, type PressurePolicy } from '../src/core/policy.ts'

interface NodeSpec {
  readonly seq: number
  readonly callId: string
  readonly name: string
  readonly text: string
}

function fakeSession(nodes: readonly NodeSpec[]): { session: never } {
  const events: Array<Record<string, unknown>> = []
  const resultSeqs: number[] = []
  for (const node of nodes) {
    events.push({
      seq: node.seq - 1,
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: node.callId, name: node.name, arguments: '{}' },
    })
    events.push({
      seq: node.seq,
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: { toolCallId: node.callId, content: [{ type: 'text', text: node.text }] },
      },
    })
    resultSeqs.push(node.seq)
  }
  let nextSeq = nodes.reduce((max, node) => Math.max(max, node.seq), 0) + 10
  const session = {
    snapshotEvents: () => events,
    surface: { nodes: resultSeqs, replaceGeneration: 1 },
    append(_type: string, data: unknown): { seq: number } {
      const seq = nextSeq++
      events.push({ seq, type: 'tool/result', data })
      return { seq }
    },
  }
  return { session: session as never }
}

function tagOf(callId: string): number | undefined {
  const match = /^c(\d+)$/.exec(callId)
  return match === null ? undefined : Number(match[1])
}

function enumerate(session: never) {
  return enumerateSurfaceToolResults(session, tagOf)
}

function specs(count: number, text: string): NodeSpec[] {
  return Array.from({ length: count }, (_unused, index) => ({
    seq: (index + 1) * 10,
    callId: `c${String(index + 1)}`,
    name: 'bash',
    text,
  }))
}

describe('mass window ∪ count floor', () => {
  it('protects the count floor even when one result exhausts the mass budget', () => {
    // 40k chars = 10k tokens each; the 8k window admits none of them.
    const nodes = specs(4, 'x'.repeat(40_000))
    const { session } = fakeSession(nodes)
    const policy: PressurePolicy = { ...DEFAULT_POLICY, protectedToolResults: 3 }
    const result = reclaimForEmergency(session, enumerate(session), policy, 100_000)
    expect(protectionWindowTokens(100_000)).toBe(8_000)
    // The floor wins over the empty mass window: newest three survive.
    expect(result.protectedCount).toBe(3)
    // Only the oldest is reclaimable, and the can't-fit guard is off (no estimate).
    expect(result.dropped.map(entry => entry.seq)).toEqual([10])
  })

  it('lets the mass window protect MORE than the count floor when rows are small', () => {
    // 1,000 chars = 250 tokens each; an 8k window covers 32 of them.
    const nodes = specs(10, 'x'.repeat(1_000))
    const { session } = fakeSession(nodes)
    const policy: PressurePolicy = { ...DEFAULT_POLICY, protectedToolResults: 1 }
    const result = reclaimForEmergency(session, enumerate(session), policy, 100_000)
    // All ten fit in the 8k budget, so nothing is reclaimed — the mass window
    // is wider than the count floor here, which is the point of taking the union.
    expect(result.dropped).toEqual([])
    expect(result.protectedCount).toBe(10)
  })

  it('drops older rows once both windows are exceeded', () => {
    // 2,000 chars = 500 tokens each; 8k covers 16, so a 20-row surface ends.
    const nodes = specs(20, 'x'.repeat(2_000))
    const { session } = fakeSession(nodes)
    const policy: PressurePolicy = { ...DEFAULT_POLICY, protectedToolResults: 2 }
    const result = reclaimForEmergency(session, enumerate(session), policy, 100_000)
    expect(result.protectedCount).toBe(16)
    expect(result.dropped).toHaveLength(4)
    // Oldest four go, newest sixteen stay.
    expect(result.dropped.map(entry => entry.seq).sort((a, b) => a - b)).toEqual([10, 20, 30, 40])
  })

  it('falls back to the count floor alone when the window is unknown', () => {
    const nodes = specs(6, 'x'.repeat(40_000))
    const { session } = fakeSession(nodes)
    const policy: PressurePolicy = { ...DEFAULT_POLICY, protectedToolResults: 2 }
    const result = reclaimForEmergency(session, enumerate(session), policy, undefined)
    expect(result.protectedCount).toBe(2)
    expect(result.dropped).toHaveLength(4)
  })
})
