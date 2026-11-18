/**
 * The m[0]/m[1] boundary is a compartment SEQUENCE, not a timestamp (upstream
 * `cachedM0MaxCompartmentSeq`, inject-compartments.ts:972).
 *
 * Why it matters, in one case: two compartments created in the same millisecond.
 * With a timestamp boundary their side of the split depends on iteration order,
 * so the same database can render them into m[0] on one pass and m[1] on the
 * next — a silent rewrite of the frozen prefix, which is the one thing m[0] must
 * never do.
 */
import { describe, expect, it } from 'vitest'
import type { Compartment } from '../src/core/compartments.ts'
import { splitBaselineSets } from '../src/dsh/management-pass.ts'

const compartment = (id: number, createdAt: number): Compartment => ({
  sessionId: 's',
  compartmentId: id,
  createdAt,
  coveredStartSeq: 1,
  coveredEndSeq: 2,
  coveredSeqs: [1, 2],
  coveredTokens: 100,
  tiers: { p1: 'a', p2: 'b', p3: 'c', p4: 'd' },
  importance: 50,
  facts: [],
  events: [],
  userObservations: [],
} as unknown as Compartment)

const state = (over: Partial<{ frozenAt: number; maxCompartmentId: number }>) => ({
  sessionId: 's',
  epoch: 1,
  frozenAt: 1_000,
  updatedAt: 1_000,
  ...over,
})

describe('splitBaselineSets', () => {
  it('splits by sequence when the boundary is known', () => {
    const all = [compartment(1, 900), compartment(2, 1_000), compartment(3, 1_100)]
    const { baseline, delta } = splitBaselineSets(all, state({ frozenAt: 1_000, maxCompartmentId: 2 }))
    expect(baseline.map(c => c.compartmentId)).toEqual([1, 2])
    expect(delta.map(c => c.compartmentId)).toEqual([3])
  })

  it('keeps same-millisecond compartments on the SAME side', () => {
    // Both created at 1000; a timestamp split could not decide.
    const all = [compartment(1, 1_000), compartment(2, 1_000)]
    const { baseline, delta } = splitBaselineSets(all, state({ frozenAt: 1_000, maxCompartmentId: 1 }))
    expect(baseline.map(c => c.compartmentId)).toEqual([1])
    expect(delta.map(c => c.compartmentId)).toEqual([2])
  })

  it('is immune to a clock step backwards', () => {
    // A compartment created AFTER the freeze but with an earlier timestamp stays
    // in m[1] because its sequence is above the boundary.
    const all = [compartment(1, 900), compartment(2, 500)]
    const { baseline, delta } = splitBaselineSets(all, state({ frozenAt: 1_000, maxCompartmentId: 1 }))
    expect(baseline.map(c => c.compartmentId)).toEqual([1])
    expect(delta.map(c => c.compartmentId)).toEqual([2])
  })

  it('falls back to the frozen timestamp for rows written before v17', () => {
    const all = [compartment(1, 900), compartment(2, 1_100)]
    const { baseline, delta } = splitBaselineSets(all, state({ frozenAt: 1_000 }))
    expect(baseline.map(c => c.compartmentId)).toEqual([1])
    expect(delta.map(c => c.compartmentId)).toEqual([2])
  })

  it('puts everything in m[0] when there is no state yet', () => {
    const all = [compartment(1, 900), compartment(2, 1_100)]
    expect(splitBaselineSets(all, undefined).baseline).toHaveLength(2)
    expect(splitBaselineSets(all, undefined).delta).toHaveLength(0)
  })
})
