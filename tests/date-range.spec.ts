/**
 * `ctx_search` date-range parity with upstream.
 *
 * Three behaviours are worth pinning because each is a silent wrong answer
 * rather than a crash:
 *   - a date-only `to` must cover the WHOLE day, not stop at midnight;
 *   - an impossible calendar date must be rejected, not rolled forward by
 *     Date.UTC's month/day normalisation;
 *   - a reversed range must be rejected, not return a confusing empty result.
 */
import { describe, expect, it } from 'vitest'
import { parseSearchDateRange, SearchDateRangeError } from '../src/core/date-range.ts'

const DAY = 24 * 60 * 60 * 1000

describe('parseSearchDateRange', () => {
  it('maps a date-only from to the start of that UTC day', () => {
    expect(parseSearchDateRange('2026-11-14', undefined)).toEqual({ from: Date.UTC(2026, 10, 14) })
  })

  it('maps a date-only to to the LAST millisecond of that day', () => {
    // Midnight would exclude everything that happened on the 14th, which is the
    // inclusive-reading a caller expects from `to`.
    expect(parseSearchDateRange(undefined, '2026-11-14')).toEqual({
      to: Date.UTC(2026, 10, 14) + DAY - 1,
    })
  })

  it('accepts a full ISO instant', () => {
    expect(parseSearchDateRange('2026-11-14T21:05:41+08:00', undefined)).toEqual({
      from: Date.parse('2026-11-14T21:05:41+08:00'),
    })
  })

  it('returns an empty object when neither bound is given', () => {
    expect(parseSearchDateRange(undefined, undefined)).toEqual({})
  })

  it('rejects an impossible calendar date instead of normalising it', () => {
    // Date.UTC(2026, 1, 30) silently becomes 2026-03-02 without the round-trip check.
    expect(() => parseSearchDateRange('2026-02-30', undefined)).toThrow(SearchDateRangeError)
  })

  it('rejects a reversed range', () => {
    expect(() => parseSearchDateRange('2026-11-15', '2026-11-14')).toThrow(SearchDateRangeError)
  })

  it('rejects an unparseable string', () => {
    expect(() => parseSearchDateRange('yesterday', undefined)).toThrow(SearchDateRangeError)
  })

  it('keeps a same-day range valid', () => {
    const parsed = parseSearchDateRange('2026-11-14', '2026-11-14')
    expect(parsed.from).toBe(Date.UTC(2026, 10, 14))
    expect(parsed.to).toBe(Date.UTC(2026, 10, 14) + DAY - 1)
  })
})
