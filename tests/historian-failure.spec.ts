/**
 * Historian failure classification (upstream `historian-failure-reason.ts`).
 *
 * The point of these cases: a failure row has to say WHY, not just THAT. The
 * local classifier used to answer one of six words, so 21 failed runs all read
 * "timeout" — indistinguishable from rate limiting or a bad model name.
 */
import { describe, expect, it } from 'vitest'
import {
  capHistorianFailureReason,
  externalHistorianFailureReason,
} from '../src/core/historian-failure.ts'

describe('externalHistorianFailureReason', () => {
  it('keeps the HTTP status when the error carries one', () => {
    expect(externalHistorianFailureReason({ status: 429, message: 'slow down' }))
      .toBe('provider_error:http_429')
  })

  it('reads status from the nested provider payload', () => {
    expect(externalHistorianFailureReason({ data: { statusCode: 401 } }))
      .toBe('provider_error:http_401')
  })

  it('names the provider error type', () => {
    expect(externalHistorianFailureReason({ message: 'Error: rate_limit_error reached' }))
      .toBe('provider_error:rate_limit_error')
  })

  it('combines status, type, code and class in that order', () => {
    const reason = externalHistorianFailureReason({
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'context_length_exceeded',
      message: 'bad',
    })
    // KNOWN_PROVIDER_ERROR_TYPES is scanned in array order and
    // `context_length_exceeded` sits above `invalid_request_error`, so the code
    // wins the type slot — upstream behaves exactly this way.
    expect(reason).toBe('provider_error:http_400:context_length_exceeded:code_context_length_exceeded')
  })

  it('recognises a model-not-found phrasing', () => {
    expect(externalHistorianFailureReason({ message: 'unknown model: qwen' }))
      .toBe('provider_error:model_not_found')
  })

  it('keeps the error class when it is a real subclass', () => {
    class ProviderRejectedError extends Error {}
    expect(externalHistorianFailureReason(new ProviderRejectedError('nope')))
      .toBe('provider_error:class_ProviderRejectedError')
  })

  it('does not copy the message body into the reason', () => {
    const secret = 'user pasted a token: sk-abcdef123456'
    const reason = externalHistorianFailureReason({ message: secret })
    expect(reason).not.toContain('sk-abcdef')
  })

  it('honours an explicit prefix', () => {
    expect(externalHistorianFailureReason({ status: 500 }, 'empty_output'))
      .toBe('empty_output:http_500')
  })

  it('caps the reason length', () => {
    const long = externalHistorianFailureReason({ code: 'a'.repeat(300) }, 'exception')
    expect(long.length).toBeLessThanOrEqual(512)
  })
})

describe('capHistorianFailureReason', () => {
  it('falls back when the reason is blank', () => {
    expect(capHistorianFailureReason('   ', 'timeout')).toBe('timeout')
    expect(capHistorianFailureReason(undefined, 'timeout')).toBe('timeout')
  })

  it('leaves a normal reason untouched', () => {
    expect(capHistorianFailureReason('provider_error:http_503')).toBe('provider_error:http_503')
  })
})
