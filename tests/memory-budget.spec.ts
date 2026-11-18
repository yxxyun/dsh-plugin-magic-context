/**
 * Memory budget selection (upstream `utilityTier` + `trimMemoriesToBudget`).
 *
 * The two properties under test are the ones the local picker lacked: ranking by
 * EVIDENCE of use (retrieval count) rather than by an authored importance score,
 * and stopping at the first row that does not fit so the surviving set stays a
 * priority prefix.
 */
import { describe, expect, it } from 'vitest'
import { compareMemoryPriority, trimToBudget, utilityTier } from '../src/core/memory-budget.ts'

const memory = (over: Partial<{ id: number; content: string; retrievalCount: number; permanent: boolean; seenCount: number }>) => ({
  id: 1,
  content: 'plain note',
  ...over,
})

describe('utilityTier', () => {
  it('ranks a retrieved memory first', () => {
    expect(utilityTier(memory({ retrievalCount: 3, content: 'never do X' }))).toBe(0)
  })

  it('ranks constraint wording second', () => {
    expect(utilityTier(memory({ content: 'always answer in Chinese' }))).toBe(1)
    expect(utilityTier(memory({ content: 'must not push without asking' }))).toBe(1)
  })

  it('ranks everything else last', () => {
    expect(utilityTier(memory({ content: 'a colour choice' }))).toBe(2)
  })

  it('is case-insensitive on the constraint pattern', () => {
    expect(utilityTier(memory({ content: 'NEVER push' }))).toBe(1)
  })
})

describe('compareMemoryPriority', () => {
  it('puts permanent first', () => {
    const permanent = memory({ id: 2, permanent: true, retrievalCount: 0 })
    const retrieved = memory({ id: 1, retrievalCount: 9 })
    expect(compareMemoryPriority(permanent, retrieved)).toBeLessThan(0)
  })

  it('orders by tier before seen count', () => {
    const constraint = memory({ id: 2, content: 'always X', seenCount: 0 })
    const popular = memory({ id: 1, content: 'plain', seenCount: 99 })
    expect(compareMemoryPriority(constraint, popular)).toBeLessThan(0)
  })

  it('prefers shorter content at the same tier and seen count', () => {
    const short = memory({ id: 2, content: 'aaa' })
    const long = memory({ id: 1, content: 'a'.repeat(200) })
    expect(compareMemoryPriority(short, long)).toBeLessThan(0)
  })

  it('falls back to id, so the order is total', () => {
    const a = memory({ id: 1 })
    const b = memory({ id: 2 })
    expect(compareMemoryPriority(a, b)).toBeLessThan(0)
    expect(compareMemoryPriority(b, a)).toBeGreaterThan(0)
    expect(compareMemoryPriority(a, { ...a })).toBe(0)
  })
})

describe('trimToBudget', () => {
  it('takes a priority prefix and STOPS at the first that does not fit', () => {
    const big = memory({ id: 1, content: 'x'.repeat(100), retrievalCount: 1 })
    const small = memory({ id: 2, content: 'y', retrievalCount: 0 })
    // Budget fits the big one but not both. Continuing past it would have
    // swapped in the small one; upstream stops, keeping the priority prefix.
    const selected = trimToBudget([big, small], 100, m => m.content.length)
    expect(selected.map(m => m.id)).toEqual([1])
  })

  it('never exceeds the budget', () => {
    const rows = Array.from({ length: 10 }, (_, index) => memory({ id: index + 1, content: 'z'.repeat(30) }))
    const selected = trimToBudget(rows, 100, m => m.content.length)
    expect(selected.reduce((total, m) => total + m.content.length, 0)).toBeLessThanOrEqual(100)
  })

  it('honours the row-count limit', () => {
    const rows = Array.from({ length: 10 }, (_, index) => memory({ id: index + 1, content: 'z' }))
    expect(trimToBudget(rows, 10_000, m => m.content.length, 3)).toHaveLength(3)
  })

  it('is deterministic for equal-priority rows', () => {
    const rows = [memory({ id: 3 }), memory({ id: 1 }), memory({ id: 2 })]
    expect(trimToBudget(rows, 10_000, () => 1).map(m => m.id)).toEqual([1, 2, 3])
  })

  it('returns nothing when the budget is zero', () => {
    expect(trimToBudget([memory({})], 0, () => 10)).toEqual([])
  })
})
