/**
 * The historian's `<project-memory>` block (upstream `renderHistorianMemoryBlock`,
 * inject-compartments.ts:301).
 *
 * It is deliberately NOT the agent-facing block: no ids, bare `- fact` lines,
 * grouped by category priority, and categories outside the list are omitted.
 *
 * The ids are the point of the difference. The agent-facing wire carries
 * `#<id>` because `<memory-updates>` addresses corrections by id; the historian
 * reads this block only to skip facts that overlap, and never addresses a memory
 * by id — an id there would be noise the model might try to reuse.
 */
import { describe, expect, it } from 'vitest'
import { renderHistorianMemoryBlock, type MemoryRow } from '../src/core/memory-bridge.ts'
import { historianPromptText } from '../src/dsh/historian.ts'

const row = (id: number, category: string, content: string): MemoryRow => ({
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

describe('renderHistorianMemoryBlock', () => {
  it('renders bare fact lines with NO ids', () => {
    const block = renderHistorianMemoryBlock([row(12, 'CONSTRAINTS', 'never commit secrets')])
    expect(block).toContain('- never commit secrets')
    expect(block).not.toContain('#12')
    expect(block).not.toContain('#')
  })

  it('groups by category and orders by the priority list', () => {
    const block = renderHistorianMemoryBlock([
      row(1, 'CONSTRAINTS', 'never commit'),
      row(2, 'PROJECT_RULES', 'run the gates'),
    ])
    // PROJECT_RULES comes before CONSTRAINTS in the taxonomy.
    expect(block.indexOf('<PROJECT_RULES>')).toBeLessThan(block.indexOf('<CONSTRAINTS>'))
  })

  it('omits categories outside the priority list', () => {
    const block = renderHistorianMemoryBlock([row(1, 'NOT_A_CATEGORY', 'ignored')])
    expect(block).toBe('')
  })

  it('returns an empty string when there is nothing to render', () => {
    expect(renderHistorianMemoryBlock([])).toBe('')
  })

  it('collapses whitespace so a fact stays one line', () => {
    const block = renderHistorianMemoryBlock([row(1, 'NAMING', 'a\n\n b   c')])
    expect(block).toContain('- a b c')
  })
})

describe('historianPromptText', () => {
  it('puts the memory block before the instruction', () => {
    const prompt = historianPromptText(true, '<project-memory>\n<NAMING>\n- x\n</NAMING>\n</project-memory>')
    expect(prompt.indexOf('<project-memory>')).toBe(0)
    expect(prompt).toContain('HISTORIAN')
  })

  it('omits the block when there is none', () => {
    const prompt = historianPromptText(true, '')
    expect(prompt).not.toContain('<project-memory>')
    expect(prompt).toContain('HISTORIAN')
  })

  it('still appends the observations toggle after the block', () => {
    const prompt = historianPromptText(false, '<project-memory>\n</project-memory>')
    expect(prompt.indexOf('<project-memory>')).toBeLessThan(prompt.length)
  })
})
