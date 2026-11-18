/**
 * Grouped memory rendering (upstream `renderMemoryBlockV2`,
 * inject-compartments.ts:2332):
 *
 *   <project-memory>
 *   <CONSTRAINTS>
 *   - #12 [CONSTRAINTS]: never commit secrets
 *   </CONSTRAINTS>
 *   </project-memory>
 *
 * The category is named ONCE per run instead of on every line, which is what
 * lets the upstream line format drop it. The wrapper is `project-memory`
 * (singular) on this path; the plural tag survives only on the flat-list
 * fallback, where every line still carries its own category.
 */
import { describe, expect, it } from 'vitest'
import { groupMemoryLines, renderMemoryLine, type MemoryRow } from '../src/core/memory-bridge.ts'
import { renderBaseline } from '../src/core/compartments.ts'

const row = (id: number, category: string, content = `note ${String(id)}`): MemoryRow => ({
  id,
  projectPath: 'git:x',
  category,
  content,
  importance: 50,
  shareable: false,
  permanent: false,
  updatedAt: 1_000,
  lastSeenAt: 1_000,
})

describe('groupMemoryLines', () => {
  it('coalesces contiguous rows of the same category', () => {
    const groups = groupMemoryLines([row(1, 'CONSTRAINTS'), row(2, 'CONSTRAINTS'), row(3, 'NAMING')])
    expect(groups.map(g => g.category)).toEqual(['CONSTRAINTS', 'NAMING'])
    expect(groups[0]?.lines).toHaveLength(2)
    expect(groups[1]?.lines).toHaveLength(1)
  })

  it('starts a new group when the category returns after another one', () => {
    // The caller sorts by category, so this should not happen in practice — but
    // if it does, the output must stay a valid sequence of runs.
    const groups = groupMemoryLines([row(1, 'CONSTRAINTS'), row(2, 'NAMING'), row(3, 'CONSTRAINTS')])
    expect(groups.map(g => g.category)).toEqual(['CONSTRAINTS', 'NAMING', 'CONSTRAINTS'])
  })

  it('falls back to MEMORY for a blank category', () => {
    expect(groupMemoryLines([row(1, '')])[0]?.category).toBe('MEMORY')
  })

  it('renders each line with its id', () => {
    const groups = groupMemoryLines([row(7, 'CONSTRAINTS')])
    expect(groups[0]?.lines[0]).toBe(renderMemoryLine(row(7, 'CONSTRAINTS')))
    expect(groups[0]?.lines[0]).toContain('#7')
  })

  it('returns nothing for an empty pool', () => {
    expect(groupMemoryLines([])).toEqual([])
  })
})

describe('renderBaseline with groups', () => {
  const block = (memoryGroups?: readonly { category: string; lines: readonly string[] }[]) =>
    renderBaseline({
      now: 1,
      baseline: [],
      delta: [],
      memories: [],
      ...memoryGroups === undefined ? {} : { memoryGroups },
      budgetTokens: 10_000,
    })

  it('prefers the grouped form when given', () => {
    const text = block(groupMemoryLines([row(1, 'CONSTRAINTS')]))
    expect(text).toContain('<project-memory>')
    expect(text).toContain('<CONSTRAINTS>')
    expect(text).toContain('</CONSTRAINTS>')
    expect(text).not.toContain('<project-memories>')
  })

  it('uses the plural flat wrapper when only lines are given', () => {
    const text = renderBaseline({
      now: 1,
      baseline: [],
      delta: [],
      memories: [renderMemoryLine(row(1, 'CONSTRAINTS'))],
      budgetTokens: 10_000,
    })
    expect(text).toContain('<project-memories>')
    expect(text).not.toContain('<project-memory>')
  })

  it('names the category once per group, not once per line', () => {
    const text = block(groupMemoryLines([row(1, 'CONSTRAINTS'), row(2, 'CONSTRAINTS')]))
    expect(text.match(/<CONSTRAINTS>/g)).toHaveLength(1)
  })
})
