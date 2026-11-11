/**
 * Wall-clock budgets for auxiliary LLM calls (upstream adapter v0.11.2).
 *
 * Why this exists: the maintenance lane's verify/profile-review calls had no
 * deadline. A provider stream that never settles would hold the lane's single
 * execution slot forever — TTL expiry, verification, profile review and vector
 * backfill would all stop for the life of the process, with no error line,
 * because the lane simply never reports again.
 *
 * Two guards, and the second one is the point: the abort signal releases a
 * compliant socket, while `Promise.race` ends the call even when the seam ignores
 * the signal entirely (a generator that never yields never observes an abort).
 */
import { describe, expect, it } from 'vitest'
import { LlmDeadlineError, withDeadline } from '../src/core/llm-deadline.ts'

describe('withDeadline', () => {
  it('passes the work result through untouched when the budget is not spent', async () => {
    const value = await withDeadline(async () => 'done', 1_000)
    expect(value).toBe('done')
  })

  it('ends a call that never settles, with a named error', async () => {
    const startedAt = Date.now()
    const error = await withDeadline(() => new Promise<never>(() => {}), 40).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(LlmDeadlineError)
    expect((error as LlmDeadlineError).budgetMs).toBe(40)
    expect(String((error as Error).message)).toContain('no terminal event within 40ms')
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })

  it('aborts the signal before rejecting, so a compliant stream can release its socket', async () => {
    let aborted = false
    let signalSeen: AbortSignal | undefined
    const error = await withDeadline((signal) => {
      signalSeen = signal
      signal.addEventListener('abort', () => { aborted = true })
      return new Promise<never>(() => {})
    }, 30).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(LlmDeadlineError)
    expect(signalSeen?.aborted).toBe(true)
    expect(aborted).toBe(true)
  })

  it('a rejection from the work itself is reported as-is, not as a deadline', async () => {
    const error = await withDeadline(async () => { throw new Error('provider said no') }, 1_000).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(LlmDeadlineError)
    expect(String((error as Error).message)).toBe('provider said no')
  })
})
