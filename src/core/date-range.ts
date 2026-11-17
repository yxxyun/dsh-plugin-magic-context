/**
 * Date-range parsing for `ctx_search` — ported from upstream
 * `tools/ctx-search/date-range.ts` (55 lines).
 *
 * Why this exists here at all: the search lanes already accept numeric
 * boundaries (`memory-search.ts` `MemorySearchRequest.from`/`.to`), but the tool
 * never exposed them, and nothing translated a calendar day into an epoch. This
 * module is that translation, and it owns the two rules that are easy to get
 * wrong:
 *
 * - A date-only `to` means the WHOLE day, so it maps to `start + 24h - 1`, not
 *   to midnight. Otherwise `to=2026-11-14` silently excludes everything that
 *   happened that day.
 * - `Date.UTC` normalises invalid dates (month 13 rolls into the next year), so
 *   the round-trip check rejects `2026-02-30` instead of quietly accepting it.
 */

export interface ParsedSearchDateRange {
  readonly from?: number
  readonly to?: number
}

export class SearchDateRangeError extends Error {
  readonly code = 'invalid_search_date_range'
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const FULL_ISO = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/

function parseDate(value: string, field: 'from' | 'to'): number {
  const trimmed = value.trim()
  const dateOnly = DATE_ONLY.exec(trimmed)
  if (dateOnly) {
    const year = Number(dateOnly[1])
    const month = Number(dateOnly[2])
    const day = Number(dateOnly[3])
    const start = Date.UTC(year, month - 1, day)
    const roundTrip = new Date(start)
    if (
      roundTrip.getUTCFullYear() !== year
      || roundTrip.getUTCMonth() !== month - 1
      || roundTrip.getUTCDate() !== day
    ) {
      throw new SearchDateRangeError(`Invalid '${field}' date; use YYYY-MM-DD or a full ISO datetime.`)
    }
    // A bare date for `to` covers that whole day, inclusive.
    return field === 'to' ? start + 24 * 60 * 60 * 1000 - 1 : start
  }

  if (FULL_ISO.test(trimmed)) {
    const parsed = Date.parse(trimmed)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  throw new SearchDateRangeError(`Invalid '${field}' date; use YYYY-MM-DD or a full ISO datetime.`)
}

export function parseSearchDateRange(
  from: string | undefined,
  to: string | undefined,
): ParsedSearchDateRange {
  const parsed = {
    ...from === undefined ? {} : { from: parseDate(from, 'from') },
    ...to === undefined ? {} : { to: parseDate(to, 'to') },
  }
  if (parsed.from !== undefined && parsed.to !== undefined && parsed.from > parsed.to) {
    throw new SearchDateRangeError("Invalid date range; 'from' must be on or before 'to'.")
  }
  return parsed
}
