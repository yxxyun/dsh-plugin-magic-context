/**
 * "Is this text safe to show another project?"
 *
 * Ported from upstream `shared/redaction.ts` (`hasShareabilitySensitiveText` plus
 * the `SECRET_TEXT_PATTERNS` shapes it reuses), because it is the answer to a
 * question this adapter was getting wrong.
 *
 * ## Why a mechanical check and not a human
 *
 * The adapter's sharing gate is a per-memory approval card. A card only works if
 * someone reads every one, and nobody does — measured on this installation, the
 * four published rows include one carrying `127.0.0.1:3067`, a machine-local
 * proxy port, which upstream's check would have refused. A human reading a card
 * sees a plausible sentence about HuggingFace mirrors, not a local endpoint.
 *
 * The check is deliberately dumb: shapes, not judgement. A model asking "is this
 * sensitive?" can be argued out of it by context; a regex cannot.
 *
 * ## Fail-closed, twice
 *
 * Two independent ways this returns `true`:
 *
 *  - any pattern matches, AND
 *  - the input is not a string, or the scan throws (`catch` → `true`).
 *
 * The second one matters because this runs inside a write path: an exception that
 * propagated would abort a publish, and an exception that returned `false` would
 * publish something unscanned. Neither is acceptable, so an unreadable input is
 * treated as sensitive.
 *
 * ## What this is NOT
 *
 * It does not redact — there is nothing to redact in a boolean decision, and a
 * "sanitized" copy that then gets shared is a worse idea than refusing to share.
 * `journal.ts`'s `redactData` handles the truncation/redaction of log payloads
 * and is unrelated.
 */

/**
 * Values that look like a secret only because their KEY contained a secret word.
 * `tokens.input=45000` and `hasUsageTokens=true` are diagnostics; flagging them
 * would make every run report "sensitive" and the gate would be turned off.
 */
function isNonSecretScalarValue(value: string): boolean {
  const trimmed = value.trim()
  // Exactly upstream's set: booleans, null, and numbers. Nothing else.
  //
  // An earlier version also passed bare identifiers ("qwerty1234", "mysecret"),
  // on the theory that a name is not a credential. That is precisely the shape a
  // weak password has, so the exception swallowed the case the gate exists for.
  // `max_tokens: 32768` and `tokens.input=45000` still pass because they are
  // numbers, which is the only exception worth having.
  if (/^(?:true|false|null|undefined)$/i.test(trimmed)) return true
  return /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)
}

/**
 * Credential shapes. Every entry is a `.test()`-only pattern — no replacement
 * machinery, because the caller needs a boolean.
 *
 * Kept in the same order and with the same bodies as upstream so a future diff
 * against `redaction.ts` is mechanical rather than interpretive.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bsk-ant-(?:api03-)?[A-Za-z0-9_-]{32,}/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\b(?:gh[opsu]|ghr)_[A-Za-z0-9_-]{30,}/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bxox[abprsuvc]-[A-Za-z0-9-]{10,}/,
  /\bAIza[A-Za-z0-9_-]{35}\b/,
  // Bearer tokens and other Authorization schemes.
  /\b(?:Proxy-)?Authorization\s*:\s*(?:Bearer|Basic|Digest|Token|Negotiate|NTLM)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  // JWT: three base64url segments.
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  // Credentials embedded in a URL: scheme://user:password@host.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
]

/** `key=value` / `key: value` where the value is not a plain scalar. */
const INLINE_CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)\s*[:=]\s*([^\s'"`,;<>]{6,})/gi,
  /\b(?:x-)?(?:api-?key|api-?token)\s*:\s*([^\s'"`,;<>]{6,})/gi,
]

/**
 * Machine-local traces. These are not secrets — the point is that they are only
 * TRUE on this machine, so sharing them exports an environment fact as though it
 * were project knowledge.
 */
const LOCAL_TRACE_PATTERNS: readonly RegExp[] = [
  // Windows user home, forward or back slash.
  /\bC:[\\/]Users[\\/][^\\/\s]+/i,
  // A `~`-rooted home path.
  /(?:^|\s)~\/[^\s]/,
  // Loopback and wildcard binds. `[::1]` is a separate pattern because a
  // leading `\b` cannot match before `[` — both sides are non-word characters,
  // so the IPv6 form silently escaped the gate.
  /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\b/i,
  /\[::1\](?::\d+)?/,
  // Private address ranges (RFC1918 + loopback).
  /\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  /\b192\.168\.\d{1,3}\.\d{1,3}\b/,
  /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/,
  // A Windows drive path into a user's AppData/Programs tree.
  /\bC:[\\/](?:Users|ProgramData)[\\/][^\s]*\b(?:AppData|Programs)\b/i,
]

/** Why a text was judged sensitive, for the journal. */
export type ShareabilityRefusal = 'credential-shape' | 'inline-credential' | 'local-trace' | 'unscannable'

export interface ShareabilityVerdict {
  /** True when the text may be shown to another project. */
  readonly safe: boolean
  readonly refusal?: ShareabilityRefusal
  /** The matched fragment, bounded — enough to act on, not enough to leak. */
  readonly fragment?: string
}

function firstMatch(patterns: readonly RegExp[], text: string): string | undefined {
  for (const pattern of patterns) {
    // `lastIndex` is state on a /g regex; reset so a repeated call cannot skip
    // a match (the shared instance is module-level).
    pattern.lastIndex = 0
    const match = pattern.exec(text)
    pattern.lastIndex = 0
    if (match === null) continue
    const fragment = match[0]
    // An `key=value` hit whose value is a plain scalar is not a credential.
    if (pattern.source.includes('[:=]') || pattern.source.includes('\\s*:')) {
      const value = match[1]
      if (value !== undefined && isNonSecretScalarValue(value)) continue
    }
    return fragment.length > 80 ? `${fragment.slice(0, 80)}…` : fragment
  }
  return undefined
}

/**
 * Judge one piece of memory text.
 *
 * Returns the first refusal reason rather than a list: the caller either shares
 * or does not, and a single reason is what a journal line can carry.
 */
export function assessShareability(content: unknown): ShareabilityVerdict {
  if (typeof content !== 'string' || content.length === 0) {
    // An empty memory is not shareable information; a non-string is a bug and
    // must not reach the shared store.
    return { safe: false, refusal: 'unscannable' }
  }
  try {
    const credential = firstMatch(CREDENTIAL_PATTERNS, content)
    if (credential !== undefined) return { safe: false, refusal: 'credential-shape', fragment: credential }
    const inline = firstMatch(INLINE_CREDENTIAL_PATTERNS, content)
    if (inline !== undefined) return { safe: false, refusal: 'inline-credential', fragment: inline }
    const local = firstMatch(LOCAL_TRACE_PATTERNS, content)
    if (local !== undefined) return { safe: false, refusal: 'local-trace', fragment: local }
    return { safe: true }
  } catch {
    // Fail-closed: an unscannable text is not a shared text.
    return { safe: false, refusal: 'unscannable' }
  }
}

/** Boolean form, for callers that only need the gate. */
export function hasShareabilitySensitiveText(content: unknown): boolean {
  return !assessShareability(content).safe
}
