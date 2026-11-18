/**
 * Memory line format and render order (upstream `renderMemoryLineV2` +
 * `memoryRenderOrder`, inject-compartments.ts:2327-1300).
 *
 * Two properties, both about whether the model can ACT on what it reads:
 *
 *   1. Every line carries its `#id`. The `<memory-updates>` block addresses
 *      corrections by id (`<superseded id="12" by="14"/>`), so a line without one
 *      is an instruction pointing at a number the model has never seen.
 *
 *   2. The render order is stable under edits. Upstream sorts by category, then
 *      by id — never by `updatedAt`, which changes on every touch and would
 *      reorder the same set of memories after an unrelated write.
 */
import { describe, expect, it } from 'vitest'
import { renderMemoryLine, type MemoryRow } from '../src/core/memory-bridge.ts'

const row = (over: Partial<MemoryRow>): MemoryRow => ({
  id: 1,
  projectPath: 'git:x',
  category: 'CONSTRAINTS',
  content: 'never commit secrets',
  importance: 50,
  shareable: false,
  permanent: false,
  updatedAt: 1_000,
  lastSeenAt: 1_000,
  ...over,
})

describe('renderMemoryLine', () => {
  it('carries the id the corrections block points at', () => {
    expect(renderMemoryLine(row({ id: 12 }))).toContain('#12')
  })

  it('keeps the category on the line (this adapter renders a flat list)', () => {
    expect(renderMemoryLine(row({ category: 'ARCHITECTURE' }))).toContain('[ARCHITECTURE]')
  })

  it('marks a permanent row', () => {
    expect(renderMemoryLine(row({ permanent: true }))).toContain('(permanent)')
  })

  it('does not mark a normal row', () => {
    expect(renderMemoryLine(row({}))).not.toContain('permanent')
  })

  it('collapses whitespace so a multi-line body stays one line', () => {
    const line = renderMemoryLine(row({ content: 'a\n\n  b   c' }))
    expect(line).toContain('a b c')
    expect(line.split('\n')).toHaveLength(1)
  })

  it('falls back to MEMORY for a row with no category', () => {
    expect(renderMemoryLine(row({ category: '' }))).toContain('[MEMORY]')
  })
})
