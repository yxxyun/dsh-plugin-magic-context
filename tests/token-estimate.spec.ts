/**
 * Token estimation and fixed overhead.
 *
 * Two claims are pinned here, both measured on this install:
 *
 *  1. `chars/4` under-counted the provider's own numbers by 31%, because CJK is
 *     roughly one token per character rather than a quarter. The per-class
 *     estimate lands within 5% in aggregate.
 *  2. Every request carries ~42,000 tokens of fixed overhead (system prompt +
 *     tool definitions + envelope) that no persisted document contains, so a
 *     window calculation that omits it looks emptier than it is.
 *
 * The second claim is the one that matters for correctness: under-estimating
 * pressure fires compaction late. The tests therefore check the FLOOR behaviour
 * (an unknown route still yields a positive overhead) as carefully as the exact
 * numbers, since the numbers will be re-measured and the floor must not.
 */
import { describe, expect, it } from 'vitest'
import {
  estimateTokens,
  FIXED_OVERHEAD_FLOOR_TOKENS,
  MEASURED_OVERHEAD,
  occupiedTokens,
  overheadFor,
  profileText,
} from '../src/core/token-estimate.ts'

describe('estimateTokens', () => {
  it('charges ASCII at 4 characters per token', () => {
    // 40 ASCII characters → 10 tokens, the classic English ratio.
    expect(estimateTokens('a'.repeat(40))).toBe(10)
  })

  it('charges CJK at one token per character', () => {
    // This is the whole point: 18 ideographs cost 18 tokens, not 4.5 — the
    // difference between the old constant and reality is the whole reason this
    // module exists.
    expect(estimateTokens('这是一段中文文本用于测试估算是否正确')).toBe(18)
  })

  it('mixes the two classes in one string', () => {
    // 8 ASCII → 2 tokens; 4 CJK → 4 tokens; total 6.
    expect(estimateTokens('abcdefgh中文文本')).toBe(6)
  })

  it('charges "other" (accented, symbols, emoji) at 2 characters per token', () => {
    // 2 emoji → 1 token; 4 accented letters → 2 tokens.
    expect(estimateTokens('🚀🎉')).toBe(1)
    expect(estimateTokens('éééé')).toBe(2)
  })

  it('never returns zero, even for empty text', () => {
    // A present-but-empty node still costs a separator and a role tag in every
    // provider encoding; returning 0 lets a fixed-budget loop spin forever.
    expect(estimateTokens('')).toBe(1)
  })

  it('counts a surrogate pair as one codepoint, not two', () => {
    // '🚀' is 2 UTF-16 units; charging it twice would double-count astral text.
    const profile = profileText('🚀')
    expect(profile.chars).toBe(1)
    expect(profile.other).toBe(1)
  })

  it('covers kana and hangul as CJK, not as "other"', () => {
    expect(profileText('ひらがな').cjk).toBe(4)
    expect(profileText('한국어').cjk).toBe(3)
  })

  it('is monotonically non-decreasing in length', () => {
    let previous = 0
    for (let length = 0; length < 200; length++) {
      const value = estimateTokens('x'.repeat(length))
      expect(value).toBeGreaterThanOrEqual(previous)
      previous = value
    }
  })
})

describe('profileText', () => {
  it('reports the class split a caller can display', () => {
    const profile = profileText('ab中文🚀')
    expect(profile.ascii).toBe(2)
    expect(profile.cjk).toBe(2)
    expect(profile.other).toBe(1)
    expect(profile.chars).toBe(5)
    // 2 ascii / 4 + 2 cjk / 1 + 1 other / 2 = 0.5 + 2 + 0.5 = 3, ceil'd.
    expect(profile.estimatedTokens).toBe(3)
  })

  it('shows why chars/4 was wrong: charsPerToken drops with CJK density', () => {
    const ascii = profileText('a'.repeat(100))
    const cjk = profileText('中'.repeat(100))
    expect(ascii.charsPerToken).toBeCloseTo(4, 1)
    expect(cjk.charsPerToken).toBeCloseTo(1, 1)
    // The old constant assumed 4 for both; the gap is the error it produced.
    expect(cjk.charsPerToken).toBeLessThan(ascii.charsPerToken / 2)
  })
})

describe('overheadFor', () => {
  it('returns the measured value for a known route', () => {
    expect(overheadFor('dsh-opencode-go/deepseek-v4.1-flash')).toBe(42_956)
    expect(overheadFor('workbuddy/deepseek-v4.1-flash')).toBe(42_419)
  })

  it('averages measured routes of the same provider for an unmeasured model', () => {
    // A new model on a known provider inherits that provider's measured overhead
    // rather than dropping to the floor: the system prompt and tool list are the
    // provider's, not the model's.
    const value = overheadFor('workbuddy/some-new-model')
    expect(value).toBe(42_419)
  })

  it('falls back to the observed floor for an unknown provider', () => {
    expect(overheadFor('never-seen/model')).toBe(FIXED_OVERHEAD_FLOOR_TOKENS)
  })

  it('falls back to the floor when the route is unknown entirely', () => {
    expect(overheadFor(undefined)).toBe(FIXED_OVERHEAD_FLOOR_TOKENS)
  })

  it('never returns zero — the whole point of the term', () => {
    // A zero here would reintroduce exactly the under-estimate this module fixes.
    for (const route of [undefined, '', 'x/y', 'dsh-opencode-go/unknown']) {
      expect(overheadFor(route)).toBeGreaterThan(0)
    }
  })

  it('accepts a custom table', () => {
    expect(overheadFor('a/b', { 'a/b': 1_234 })).toBe(1_234)
  })
})

describe('occupiedTokens', () => {
  it('prefers the provider count when one exists', () => {
    // The provider's number is the truth; the estimate is only for content that
    // has not been sent yet.
    expect(occupiedTokens(999, 'dsh-opencode-go/deepseek-v4.1-flash', 123_456)).toBe(123_456)
  })

  it('adds the overhead when no provider count exists', () => {
    expect(occupiedTokens(1_000, 'workbuddy/deepseek-v4.1-flash'))
      .toBe(1_000 + 42_419)
  })

  it('ignores a non-positive provider count', () => {
    expect(occupiedTokens(1_000, 'workbuddy/deepseek-v4.1-flash', 0))
      .toBe(1_000 + 42_419)
  })
})

describe('MEASURED_OVERHEAD', () => {
  it('every entry is a positive finite number', () => {
    for (const [route, value] of Object.entries(MEASURED_OVERHEAD)) {
      expect(Number.isFinite(value), route).toBe(true)
      expect(value, route).toBeGreaterThan(0)
    }
  })

  it('the floor is below every measured value', () => {
    // Otherwise an unmeasured route would be charged MORE than a measured one in
    // a low-overhead deployment, which would make the fallback the worst case.
    for (const value of Object.values(MEASURED_OVERHEAD)) {
      expect(FIXED_OVERHEAD_FLOOR_TOKENS).toBeLessThanOrEqual(value)
    }
  })
})
