/**
 * User-facing failure notices (upstream `user-facing-codes.ts` +
 * `compartment-runner-validation.ts:266`).
 *
 * The contract under test is the two-register behaviour: a transient blip stays
 * quiet, a persistent failure names the setting to fix. And every notice carries
 * a stable code — that is what makes it searchable later.
 */
import { describe, expect, it } from 'vitest'
import {
  buildHistorianFailureNotice,
  HISTORIAN_PERSISTENT_FAILURE_THRESHOLD,
  renderUserFacingFailure,
  USER_FACING_FAILURES,
} from '../src/core/user-facing-codes.ts'

describe('user-facing failure codes', () => {
  it('matches upstream threshold', () => {
    expect(HISTORIAN_PERSISTENT_FAILURE_THRESHOLD).toBe(3)
  })

  it('carries upstream codes', () => {
    expect(USER_FACING_FAILURES.historian_unavailable.code).toBe('MC-H01')
    expect(USER_FACING_FAILURES.historian_saved_history_misaligned.code).toBe('MC-H03')
    expect(USER_FACING_FAILURES.historian_window_too_small.code).toBe('MC-H05')
  })

  it('stays reassuring below the threshold', () => {
    const text = renderUserFacingFailure('historian_unavailable', 1)
    expect(text).toContain('MC-H01')
    expect(text).toContain('will retry automatically')
    expect(text).not.toContain('misconfigured')
  })

  it('escalates at the threshold', () => {
    const text = renderUserFacingFailure('historian_unavailable', 3)
    expect(text).toContain('3 times in a row')
    expect(text).toContain('misconfigured or unreachable')
  })

  it('keeps escalating above the threshold and reports the real count', () => {
    const text = renderUserFacingFailure('historian_unavailable', 21)
    expect(text).toContain('21 times in a row')
  })

  it('switches the heading at the threshold, as upstream does', () => {
    expect(buildHistorianFailureNotice(1)).toContain('## Magic Context\n')
    expect(buildHistorianFailureNotice(3)).toContain('## Magic Context — History compression')
  })

  it('names an actionable next step for a too-small window', () => {
    const text = renderUserFacingFailure('historian_window_too_small')
    expect(text).toContain('larger context window')
  })
})
