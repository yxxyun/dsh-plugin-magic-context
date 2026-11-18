/**
 * Parse the context limit a provider reports in an overflow error.
 *
 * This is the only trustworthy source of a route's real limit: catalog values
 * are per-model defaults, and a provider that shrank a window (or a gateway that
 * proxies to a shorter one) only ever tells the truth in the refusal. Upstream
 * labels the value `providerProvenLimitTokens` for exactly that reason
 * (`transform-postprocess-phase.ts:1915`) and refuses to disarm an emergency
 * latch on anything else — a guess must not be allowed to say "we fit now".
 *
 * The shapes below are the ones actually seen in the wild. Each is anchored on a
 * number next to a limit word so a token COUNT in the middle of a message (the
 * "210000 tokens" in Anthropic's phrasing) is not mistaken for the limit.
 *
 * Pure and total: any input, including a malformed one, returns undefined rather
 * than throwing.
 */

/** Ways providers word the limit, in the order they are tried. */
const PATTERNS: readonly RegExp[] = [
  // Anthropic: "prompt is too long: 250000 tokens > 200000 maximum"
  /\b\d+\s*tokens?\s*>\s*(\d+)\s*(?:tokens?)?\s*(?:maximum|max|limit)\b/i,
  // OpenAI: "This model's maximum context length is 128000 tokens"
  /maximum\s+context\s+(?:length|window)\s+is\s+(\d+)/i,
  // Generic: "context window is 64000", "limit of 32000 tokens"
  /context\s+(?:window|length)\s*(?:is|of|:)\s*(\d+)/i,
  /limit\s*(?:is|of|:)\s*(\d+)\s*tokens?/i,
  // Ollama / llama.cpp: "exceeds the available context size (8192 tokens)"
  /context\s+size\s*\(?\s*(\d+)\s*tokens?\s*\)?/i,
]

/**
 * Numbers below this are treated as noise (a token count, an index), not a
 * limit. No production model has a window under 2 000 tokens, and a false small
 * limit would make the disarm ratio fire on every measurement.
 */
const MIN_PLAUSIBLE_LIMIT = 2_000

export function parseProviderLimitTokens(message: string | undefined): number | undefined {
  if (typeof message !== 'string' || message.length === 0) return undefined
  for (const pattern of PATTERNS) {
    const match = pattern.exec(message)
    if (match === null) continue
    const parsed = Number(match[1])
    if (!Number.isFinite(parsed) || parsed < MIN_PLAUSIBLE_LIMIT) continue
    return Math.floor(parsed)
  }
  return undefined
}

/** The meta key a proven limit is stored under, per provider+model route. */
export function provenLimitKey(provider: string, model: string): string {
  return `proven.limit.${provider}|${model}`
}
