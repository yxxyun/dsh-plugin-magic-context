/**
 * m[0] section order (upstream `renderM0`, inject-compartments.ts:2408-2442):
 *
 *   project-docs -> user-profile -> session-history -> project-memory -> mural
 *
 * This adapter has no project-docs (the host injects AGENTS.md itself) and no
 * mural, so the order it must reproduce is:
 *
 *   user-profile -> compartment-baseline -> project-memories  [-> m[1] sections]
 *
 * Memory AFTER history, not before it. The order is a cache-prefix contract, not
 * a cosmetic choice: moving a non-empty block changes the digest of every
 * frozen m[0] on the next fold.
 */
import { describe, expect, it } from 'vitest'
import type { Compartment } from '../src/core/compartments.ts'
import { renderBaseline } from '../src/core/compartments.ts'

const compartment = (id: number, createdAt: number): Compartment => ({
  sessionId: 's',
  compartmentId: id,
  createdAt,
  coveredStartSeq: 1,
  coveredEndSeq: 2,
  coveredSeqs: [1, 2],
  coveredTokens: 100,
  tiers: { p1: 'history body', p2: 'b', p3: 'c', p4: 'd' },
  importance: 90,
  facts: [],
  events: [],
  userObservations: [],
} as unknown as Compartment)

const render = (over: Partial<Parameters<typeof renderBaseline>[0]> = {}): string =>
  renderBaseline({
    now: 1,
    baseline: [compartment(1, 10)],
    delta: [],
    memories: ['- a memory line'],
    profileLines: ['- a profile line'],
    budgetTokens: 100_000,
    ...over,
  })

describe('m[0] section order', () => {
  it('renders profile, then history, then memories', () => {
    const block = render()
    const profile = block.indexOf('<user-profile>')
    const history = block.indexOf('<compartment-baseline>')
    const memories = block.indexOf('<project-memories>')
    expect(profile).toBeGreaterThan(-1)
    expect(history).toBeGreaterThan(-1)
    expect(memories).toBeGreaterThan(-1)
    expect(profile).toBeLessThan(history)
    expect(history).toBeLessThan(memories)
  })

  it('keeps the order when only one of them is present', () => {
    const onlyHistory = render({ profileLines: [], memories: [] })
    expect(onlyHistory.indexOf('<compartment-baseline>')).toBeGreaterThan(-1)
    const onlyMemories = render({ profileLines: [], baseline: [] })
    expect(onlyMemories.indexOf('<project-memories>')).toBeGreaterThan(-1)
  })

  it('places every m[1] section after the m[0] ones', () => {
    const block = render({
      delta: [compartment(2, 20)],
      newMemories: ['- a new memory'],
      newProfileLines: ['- a new profile line'],
    })
    const lastM0 = block.indexOf('</project-memories>')
    for (const tag of ['<new-memories>', '<new-user-profile>', '<compartment-delta>']) {
      expect(block.indexOf(tag)).toBeGreaterThan(lastM0)
    }
  })

  it('is byte-stable for identical input', () => {
    expect(render()).toBe(render())
  })
})
