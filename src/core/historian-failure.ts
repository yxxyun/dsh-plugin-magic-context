/**
 * Historian failure reason — ported from upstream
 * `features/magic-context/historian-failure-reason.ts` (mc-upstream a1ca346),
 * minus the subprocess branch (this adapter never launches a child process).
 *
 * Why it matters more than it looks: the local classifier answered with one of
 * six words (`timeout`, `max-tokens`, `invalid-output`, `aborted`,
 * `stream-error`, `no-route`). When the RCC session failed 21 times in six hours,
 * every row said `timeout` — indistinguishable from a provider that was
 * rate-limiting, authenticating badly, or refusing the model name. Upstream
 * answers with the structured facts the error actually carries:
 *
 *     provider_error:http_429:rate_limit_error
 *     provider_error:http_401:authentication_error:code_invalid_api_key
 *
 * Only STRUCTURED fields are read (status/statusCode, type, code, and the
 * constructor name). Messages are pattern-matched for a status or a code, never
 * copied wholesale — an error message can contain user content, and the failure
 * row is a diagnostic, not a transcript.
 *
 * Pure and total: no clock, no I/O.
 */

const MAX_FAILURE_REASON_LENGTH = 512

const KNOWN_PROVIDER_ERROR_TYPES = [
  'authentication_error',
  'context_length_exceeded',
  'insufficient_quota',
  'invalid_api_key',
  'invalid_request_error',
  'model_not_found',
  'overloaded_error',
  'permission_error',
  'rate_limit_error',
  'server_error',
  'content_filter',
] as const

export type FailurePrefix =
  | 'provider_error'
  | 'exception'
  | 'timeout'
  | 'aborted'
  | 'empty_output'
  | 'parse_failed'

/** Bound the reason while preserving its diagnostic text. */
export function capHistorianFailureReason(
  reason: string | null | undefined,
  fallback = 'provider_error',
): string {
  const value = typeof reason === 'string' && reason.trim() ? reason : fallback
  return value.slice(0, MAX_FAILURE_REASON_LENGTH)
}

/** Summarise an external error using only structured status, type, code, or class. */
export function externalHistorianFailureReason(
  error: unknown,
  prefix: FailurePrefix = 'provider_error',
): string {
  const record =
    typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>)
      : undefined
  const message =
    typeof error === 'string'
      ? error
      : typeof record?.message === 'string'
        ? record.message
        : String(error ?? '')
  const normalized = message.toLowerCase()
  const dataRecord =
    typeof record?.data === 'object' && record.data !== null
      ? (record.data as Record<string, unknown>)
      : undefined
  const statusValue =
    record?.statusCode
    ?? record?.status
    ?? record?.status_code
    ?? dataRecord?.statusCode
    ?? dataRecord?.status
    ?? dataRecord?.status_code
  const structuredStatus =
    typeof statusValue === 'number' || typeof statusValue === 'string'
      ? /^[1-5]\d{2}$/.exec(String(statusValue))?.[0]
      : undefined
  const status =
    structuredStatus
    ?? /(?:\bhttp(?:\s+status)?|\bstatus(?:\s+code)?|\bapi\s+error|\berror)\s*[(:= ]+([1-5]\d{2})\b/i
      .exec(message)?.[1]
  const structuredTypes = [record?.type, dataRecord?.type].filter(
    (value): value is string =>
      typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(value),
  )
  const structuredType = [record?.type, record?.code, dataRecord?.type, dataRecord?.code]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase()
  const providerType =
    KNOWN_PROVIDER_ERROR_TYPES.find(
      value => normalized.includes(value) || structuredType.includes(value),
    )
    ?? (structuredTypes[0]?.toLowerCase()
      || (/model not found|unknown model|model does not exist/.test(normalized)
        ? 'model_not_found'
        : undefined))
  const structuredCode = record?.code ?? dataRecord?.code
  const safeCode =
    typeof structuredCode === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(structuredCode)
      ? structuredCode
      : /\b(?:code|error code)\s*[:= ]\s*([A-Za-z][A-Za-z0-9_.-]{0,39})\b/i.exec(message)?.[1]
  const nameField = typeof record?.name === 'string' ? record.name : undefined
  const className =
    nameField && nameField !== 'Error'
      ? nameField
      : (error as { constructor?: { name?: string } } | null)?.constructor?.name
  const safeClass =
    className && className !== 'Error' && /^[A-Za-z][A-Za-z0-9]{0,39}(?:Error|Exception)$/.test(className)
      ? `class_${className}`
      : undefined
  const detail = [
    status ? `http_${status}` : undefined,
    providerType,
    safeCode ? `code_${safeCode}` : undefined,
    safeClass,
  ].filter((part): part is string => part !== undefined)
  return capHistorianFailureReason(`${prefix}${detail.length > 0 ? `:${detail.join(':')}` : ''}`)
}
