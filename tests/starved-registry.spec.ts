import { beforeEach, describe, expect, it } from 'vitest'
import {
  lastPassStarved,
  notePassStarved,
  resetStarvedRegistry,
} from '../src/dsh/starved-registry.ts'

describe('starved registry — one bit per session', () => {
  beforeEach(() => {
    resetStarvedRegistry()
  })

  it('starts false for an unseen session', () => {
    expect(lastPassStarved('s1')).toBe(false)
  })

  it('remembers a starved pass', () => {
    notePassStarved('s1', true)
    expect(lastPassStarved('s1')).toBe(true)
  })

  it('clears the bit as soon as a pass reclaims something', () => {
    notePassStarved('s1', true)
    notePassStarved('s1', false)
    expect(lastPassStarved('s1')).toBe(false)
  })

  it('keeps sessions independent', () => {
    notePassStarved('s1', true)
    expect(lastPassStarved('s2')).toBe(false)
    notePassStarved('s2', true)
    notePassStarved('s1', false)
    expect(lastPassStarved('s1')).toBe(false)
    expect(lastPassStarved('s2')).toBe(true)
  })

  it('is idempotent on repeated writes', () => {
    notePassStarved('s1', true)
    notePassStarved('s1', true)
    expect(lastPassStarved('s1')).toBe(true)
    notePassStarved('s1', false)
    notePassStarved('s1', false)
    expect(lastPassStarved('s1')).toBe(false)
  })

  it('resets every session on demand', () => {
    notePassStarved('s1', true)
    notePassStarved('s2', true)
    resetStarvedRegistry()
    expect(lastPassStarved('s1')).toBe(false)
    expect(lastPassStarved('s2')).toBe(false)
  })
})
