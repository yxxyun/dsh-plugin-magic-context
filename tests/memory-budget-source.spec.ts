/**
 * Per-source fair budget selection (upstream `trimWorkspaceMemoriesToBudgetV2`,
 * inject-compartments.ts:2063).
 *
 * The failure this prevents is quiet: with more than one memory source (own
 * project + domain peers, or several workspaces) a single-pool pick lets one
 * source fill the whole budget, and the other vanishes from the prompt without
 * anything erroring. The floor pass gives every source a share first.
 */
import { describe, expect, it } from 'vitest'
import { trimToBudgetBySource } from '../src/core/memory-budget.ts'

interface Row {
  id: number
  content: string
  source?: string
  permanent?: boolean
  seenCount?: number
  retrievalCount?: number
}

const row = (id: number, source: string, over: Partial<Row> = {}): Row => ({
  id,
  content: 'x'.repeat(10),
  source,
  ...over,
})

const bySource = (memory: Row): string | undefined => memory.source
const cost10 = (): number => 10

describe('trimToBudgetBySource', () => {
  it('takes permanent rows first, even from the smallest source', () => {
    const rows = [
      row(1, 'own'),
      row(2, 'own'),
      row(3, 'peer', { permanent: true }),
    ]
    const selected = trimToBudgetBySource(rows, 20, bySource, cost10)
    expect(selected[0]?.id).toBe(3)
  })

  it('gives each source a floor so no source is crowded out', () => {
    // Budget 40 = four rows. Without a floor, "own" (first by priority) would
    // take all four and "peer" would vanish.
    const rows = [
      row(1, 'own'), row(2, 'own'), row(3, 'own'), row(4, 'own'),
      row(5, 'peer'), row(6, 'peer'),
    ]
    const selected = trimToBudgetBySource(rows, 40, bySource, cost10)
    const sources = selected.map(m => m.source)
    expect(sources).toContain('own')
    expect(sources).toContain('peer')
  })

  it('never exceeds the budget', () => {
    const rows = Array.from({ length: 10 }, (_, index) => row(index + 1, index % 2 === 0 ? 'a' : 'b'))
    const selected = trimToBudgetBySource(rows, 35, bySource, cost10)
    expect(selected.length).toBeLessThanOrEqual(3)
  })

  it('skips an oversized row instead of stopping the whole pass', () => {
    // A floor pass that `break`s would starve every later row of that source.
    const rows = [
      { id: 1, content: 'big', source: 'own', seenCount: 5 },
      { id: 2, content: 'small', source: 'own' },
      { id: 3, content: 'small', source: 'peer' },
    ]
    const cost = (memory: Row): number => memory.content === 'big' ? 100 : 10
    const selected = trimToBudgetBySource(rows, 25, bySource, cost)
    expect(selected.map(m => m.id)).toContain(2)
    expect(selected.map(m => m.id)).toContain(3)
  })

  it('leaves unused floor in the pot for the final priority pass', () => {
    // "peer" has one row; its unused share goes back to "own".
    const rows = [row(1, 'own'), row(2, 'own'), row(3, 'own'), row(4, 'peer')]
    const selected = trimToBudgetBySource(rows, 40, bySource, cost10)
    expect(selected).toHaveLength(4)
  })

  it('honours the row limit', () => {
    const rows = Array.from({ length: 8 }, (_, index) => row(index + 1, 'own'))
    expect(trimToBudgetBySource(rows, 1_000, bySource, cost10, 3)).toHaveLength(3)
  })

  it('falls back sensibly when a row has no source', () => {
    const rows = [{ id: 1, content: 'x' }, { id: 2, content: 'x', source: '' }]
    const selected = trimToBudgetBySource(rows, 100, bySource, cost10)
    // No source means "not eligible for a floor" — the final pass still takes it.
    expect(selected.map(m => m.id).sort((left, right) => left - right)).toEqual([1, 2])
  })

  it('is deterministic for equal-priority rows', () => {
    const rows = [row(3, 'a'), row(1, 'b'), row(2, 'c')]
    const first = trimToBudgetBySource(rows, 1_000, bySource, cost10).map(m => m.id)
    const second = trimToBudgetBySource([...rows].reverse(), 1_000, bySource, cost10).map(m => m.id)
    expect(first).toEqual(second)
  })
})
