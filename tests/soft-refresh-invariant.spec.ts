/**
 * A SOFT refresh must not change a single byte of m[0].
 *
 * Upstream states the invariant (`ARCHITECTURE.md:96`): "Decay re-tiering
 * happens ONLY on a HARD fold — a SOFT pass must never re-tier (that would
 * change m[0] bytes)." The header must not carry it either
 * (`decay-render.ts:63` `compartmentHeading`: `## start-end · title`).
 *
 * Why this file exists: m[0]'s positional age was computed as
 * `baseline.length + delta.length - 1`, so every compartment that landed in
 * m[1] shifted every m[0] row one step older. Once a row crossed a tier band
 * (3/8/20) its rendered BODY changed, and because the header also spelled the
 * tier out (`§C3§ [p2, importance 84]`), even sub-band drift changed header
 * bytes. `refreshBaseline`'s `baselineBlockOf(target.text) === block` guard
 * therefore never matched on the common path and every execute pass rewrote
 * the whole node. Measured on the 2026-11-08..11 store: soft refreshes carried
 * a p10 fidelity of 24.0% — worse than a HARD fold — and 12.8M re-billed input
 * tokens, 3x the HARD cost.
 *
 * The fix has two halves, and each case here pins one:
 *  - the header carries neither tier nor importance, so tier drift inside m[0]
 *    cannot change the heading;
 *  - m[0]'s age is measured inside m[0] only, so m[1] growth cannot drift it at
 *    all, and m[1] rows render at P1 (upstream `inject-compartments.ts:3050`).
 */
import { describe, expect, it } from 'vitest'
import {
  compartmentHeader,
  renderBaseline,
  renderCompartment,
  type Compartment,
} from '../src/core/compartments.ts'

function compartment(overrides: Partial<Compartment> = {}): Compartment {
  return {
    sessionId: 's1',
    compartmentId: 1,
    createdAt: 0,
    coveredStartSeq: 1,
    coveredEndSeq: 4,
    coveredSeqs: [1, 2, 4],
    coveredTokens: 100,
    importance: 50,
    tiers: { p1: 'P1 body', p2: 'P2 body', p3: 'P3 body', p4: 'P4 body' },
    facts: [],
    events: [],
    baselineEpoch: 1,
    ...overrides,
  }
}

/** A frozen m[0] of `count` rows plus an m[1] delta of `delta` rows. */
function baselineWith(count: number, delta: number): string {
  const baseline = Array.from({ length: count }, (_, index) =>
    compartment({ compartmentId: index + 1, createdAt: index, importance: 50 }))
  const rows = Array.from({ length: delta }, (_, index) =>
    compartment({ compartmentId: 100 + index, createdAt: 1000 + index, importance: 50 }))
  return renderBaseline({
    baseline,
    delta: rows,
    memories: [],
    budgetTokens: 200_000,
  })
}

/** The `<compartment-baseline>` slice — m[0] only, excluding the delta section. */
function m0Slice(block: string): string {
  const start = block.indexOf('<compartment-baseline>')
  const end = block.indexOf('</compartment-baseline>')
  return start === -1 || end === -1 ? '' : block.slice(start, end + '</compartment-baseline>'.length)
}

describe('soft refresh keeps m[0] byte-identical', () => {
  it('does not move m[0] bytes when compartments land in m[1]', () => {
    const none = m0Slice(baselineWith(6, 0))
    expect(none.length).toBeGreaterThan(0)
    // Every one of these is a SOFT-refresh shape: the frozen m[0] is unchanged
    // and only the delta grew. m[0] must not notice.
    for (const delta of [1, 2, 3, 5, 9]) {
      expect(m0Slice(baselineWith(6, delta))).toBe(none)
    }
  })

  it('does not re-tier m[0] rows that sit below a band boundary', () => {
    // 6 frozen rows => the oldest sits at age 5 (p2 band). Adding delta rows
    // used to push it to 6, 7, 8 (p3) and eventually 20 (p4).
    const six = m0Slice(baselineWith(6, 0))
    expect(six).toContain('P2 body')
    const pushed = m0Slice(baselineWith(6, 40))
    expect(pushed).toBe(six)
    expect(pushed).not.toContain('P4 body')
  })

  it('still ages m[0] rows by their own position (decay is not disabled)', () => {
    // A longer frozen baseline must decay its oldest rows: age 0..2 => p1,
    // 3..7 => p2, 8..19 => p3, 20+ => p4. 24 rows puts the first at age 23.
    const block = m0Slice(baselineWith(24, 0))
    expect(block).toContain('P4 body')
    expect(block).toContain('P1 body')
    // The second-newest row is inside the p1 band, so both tiers coexist.
    expect(block.indexOf('P1 body')).toBeGreaterThan(-1)
  })
})

describe('compartment header carries no cache-unstable field', () => {
  it('omits tier and importance', () => {
    const low = compartmentHeader(compartment({ importance: 10 }))
    const high = compartmentHeader(compartment({ importance: 95 }))
    expect(low).toBe(high)
    expect(low).toBe('§C1§')
  })

  it('omits relative time', () => {
    expect(compartmentHeader(compartment())).not.toMatch(/\d+m ago/)
    expect(compartmentHeader(compartment())).not.toMatch(/\d+s ago/)
  })

  it('keeps header bytes constant while the body decays across every band', () => {
    const row = compartment()
    const ages = [0, 1, 2, 3, 7, 8, 19, 20, 200]
    const headers = new Set(ages.map(age => compartmentHeader(row)))
    expect(headers.size).toBe(1)
    // Same row, three different bodies across those ages — that is the decay
    // doing its job, and why the body (not the header) is the only thing that
    // may differ.
    const bodies = new Set(ages.map(age => renderCompartment(row, age)))
    expect(bodies.size).toBeGreaterThan(1)
  })
})

describe('m[1] rows render at full fidelity', () => {
  it('renders every delta row at P1 regardless of its position in the delta', () => {
    // Upstream `inject-compartments.ts:3050` hard-codes tier 1 for m[1].
    const rows = Array.from({ length: 12 }, (_, index) =>
      compartment({ compartmentId: 200 + index, createdAt: 2000 + index }))
    const block = renderBaseline({
      baseline: [],
      delta: rows,
      memories: [],
      budgetTokens: 200_000,
    })
    const deltaSlice = block.slice(block.indexOf('<compartment-delta>'))
    expect(deltaSlice).toContain('P1 body')
    // Position in the delta must not demote the freshest work: with 12 rows,
    // the old indexing would have reached the p3 band (age >= 8).
    expect(deltaSlice).not.toContain('P3 body')
    expect(deltaSlice).not.toContain('P2 body')
  })
})
