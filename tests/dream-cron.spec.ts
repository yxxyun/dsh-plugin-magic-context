/**
 * The cron evaluator the scheduler's clock runs on.
 *
 * These are pure-function tests, and they exist because every later phase
 * depends on this clock being right in two specific ways that are easy to get
 * wrong and invisible when broken:
 *
 *  - **The due instant is never `now`.** A task that returns its own slot fires
 *    twice per tick under a coarse clock. `nextOccurrence` is strictly after.
 *  - **An impossible expression resolves to null, not to a far-future date.**
 *    `0 0 31 2 *` (Feb 31) must not scan two million minutes on every evaluation
 *    and must not be retried forever — the runner reads null as "never".
 *
 * Times are built with the `new Date(y, m, d, h, min)` local constructor on
 * purpose: cron matching is wall-clock, so a test written in UTC would pass on a
 * machine in UTC and mean something else anywhere else.
 */
import { describe, expect, it } from 'vitest'
import {
  __setCronCandidateVisitCounterForTests,
  isValidCron,
  nextDueAtMs,
  nextOccurrence,
  parseCron,
} from '../src/core/cron.ts'

describe('parseCron', () => {
  it('accepts the forms the config schema allows', () => {
    for (const expression of ['* * * * *', '0 4 * * *', '*/15 * * * *', '0 0 * * 0', '0 0 1 * *', '30 4 * * 1-5', '0 */6 * * *']) {
      expect(isValidCron(expression), expression).toBe(true)
    }
  })

  it('rejects wrong field counts', () => {
    expect(isValidCron('')).toBe(false)
    expect(isValidCron('0 4 * *')).toBe(false)
    expect(isValidCron('0 4 * * * *')).toBe(false)
  })

  it('rejects out-of-range and non-numeric values', () => {
    // Minute 60, hour 24, day 0, month 13, weekday 8 are all invalid. Weekday 7
    // is the one alias that is legal (Sunday).
    expect(isValidCron('60 * * * *')).toBe(false)
    expect(isValidCron('* 24 * * *')).toBe(false)
    expect(isValidCron('* * 0 * *')).toBe(false)
    expect(isValidCron('* * * 13 *')).toBe(false)
    expect(isValidCron('* * * * 8')).toBe(false)
    expect(isValidCron('* * * * 7')).toBe(true)
    expect(isValidCron('mon * * * *')).toBe(false)
  })

  it('rejects a reversed range', () => {
    expect(isValidCron('30-10 * * * *')).toBe(false)
  })

  it('normalises weekday 7 to Sunday', () => {
    const parsed = parseCron('0 0 * * 7')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.cron.dow.has(0)).toBe(true)
  })

  it('marks a star-prefixed day field as unrestricted', () => {
    const star = parseCron('0 0 * * 1')
    const restricted = parseCron('0 0 15 * 1')
    expect(star.ok).toBe(true)
    expect(restricted.ok).toBe(true)
    if (!star.ok || !restricted.ok) return
    expect(star.cron.domRestricted).toBe(false)
    expect(restricted.cron.domRestricted).toBe(true)
    // A step is also unrestricted for Vixie's OR rule.
    const stepped = parseCron('0 0 */2 * 1')
    expect(stepped.ok).toBe(true)
    if (!stepped.ok) return
    expect(stepped.cron.domRestricted).toBe(false)
  })
})

describe('nextOccurrence', () => {
  const parsed = (expression: string) => {
    const result = parseCron(expression)
    if (!result.ok) throw new Error(result.error)
    return result.cron
  }

  it('is strictly after the reference instant', () => {
    const after = new Date(2026, 0, 15, 10, 0, 0)
    const next = nextOccurrence(parsed('* * * * *'), after)
    expect(next).not.toBeNull()
    // Exactly one minute later, never the same instant.
    expect(next?.getTime()).toBe(after.getTime() + 60_000)
  })

  it('lands on the next daily slot', () => {
    const after = new Date(2026, 0, 15, 10, 0, 0)
    const next = nextOccurrence(parsed('17 4 * * *'), after)
    expect(next?.getFullYear()).toBe(2026)
    expect(next?.getMonth()).toBe(0)
    expect(next?.getDate()).toBe(16)
    expect(next?.getHours()).toBe(4)
    expect(next?.getMinutes()).toBe(17)
  })

  it('steps with a star-step schedule', () => {
    const after = new Date(2026, 0, 15, 10, 1, 0)
    const next = nextOccurrence(parsed('*/15 * * * *'), after)
    expect(next?.getHours()).toBe(10)
    expect(next?.getMinutes()).toBe(15)
  })

  it('treats two restricted day fields as an OR', () => {
    // Day-of-month 15 OR any Monday. From the 15th at 10:00 the next hit is the
    // following Monday, not January 15th of next year.
    const after = new Date(2026, 0, 15, 10, 0, 0) // 2026-01-15 is a Thursday
    const next = nextOccurrence(parsed('0 0 20 * 1'), after)
    // 2026-01-19 is a Monday and precedes the 20th.
    expect(next?.getDate()).toBe(19)
  })

  it('returns null for an expression that can never fire', () => {
    const after = new Date(2026, 0, 15, 10, 0, 0)
    // Feb 31 does not exist; the day-of-month pre-check answers without scanning.
    expect(nextOccurrence(parsed('0 0 31 2 *'), after)).toBeNull()
  })

  it('does not scan minutes for an impossible schedule', () => {
    let visits = 0
    __setCronCandidateVisitCounterForTests(() => { visits += 1 })
    try {
      nextOccurrence(parsed('0 0 31 2 *'), new Date(2026, 0, 15, 10, 0, 0))
    } finally {
      __setCronCandidateVisitCounterForTests(undefined)
    }
    // The pre-check short-circuits, so the ~2M-minute scan never starts.
    expect(visits).toBe(0)
  })

  it('skips a repeated wall-clock minute when asked', () => {
    // The exclude hook exists for a DST fall-back, where a local civil minute
    // occurs twice. Simulate it directly: ask for the minute after 04:17 but
    // exclude the 04:17 label.
    const after = new Date(2026, 0, 15, 4, 16, 0)
    const withoutExclude = nextOccurrence(parsed('17 4 * * *'), after)
    expect(withoutExclude?.getDate()).toBe(15)
    const withExclude = nextOccurrence(parsed('17 4 * * *'), after, '2026-01-15 04:17')
    // The next occurrence shares the excluded civil minute, so it moves a day on.
    expect(withExclude?.getDate()).toBe(16)
  })
})

describe('nextDueAtMs', () => {
  it('returns null for an empty expression', () => {
    expect(nextDueAtMs('', new Date(2026, 0, 15).getTime())).toBeNull()
  })

  it('returns null for an invalid expression', () => {
    expect(nextDueAtMs('nope', new Date(2026, 0, 15).getTime())).toBeNull()
  })

  it('returns an epoch instant for a valid expression', () => {
    const after = new Date(2026, 0, 15, 10, 0, 0).getTime()
    const due = nextDueAtMs('17 4 * * *', after)
    expect(due).not.toBeNull()
    expect(due as number).toBeGreaterThan(after)
  })
})
