/**
 * Provider limit parsing (`evaluateEmergencyFailClosed`'s
 * `providerProvenLimitTokens`, transform-postprocess-phase.ts:1915).
 *
 * Only a number the provider itself stated may disarm an emergency latch. These
 * cases are the phrasings that matter, plus the two ways a careless parser goes
 * wrong: latching onto the token COUNT instead of the limit, and accepting a
 * number small enough to be noise.
 */
import { describe, expect, it } from 'vitest'
import { parseProviderLimitTokens, provenLimitKey } from '../src/core/provider-limit.ts'

describe('parseProviderLimitTokens', () => {
  it('reads the Anthropic phrasing (count > maximum)', () => {
    expect(parseProviderLimitTokens(
      'prompt is too long: 250000 tokens > 200000 maximum',
    )).toBe(200_000)
  })

  it('reads the OpenAI phrasing', () => {
    expect(parseProviderLimitTokens(
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens.",
    )).toBe(128_000)
  })

  it('reads a generic context-window sentence', () => {
    expect(parseProviderLimitTokens('The context window is 64000 for this deployment')).toBe(64_000)
  })

  it('reads a generic "limit of N tokens" sentence', () => {
    expect(parseProviderLimitTokens('exceeded the limit of 32000 tokens')).toBe(32_000)
  })

  it('reads the llama.cpp phrasing', () => {
    expect(parseProviderLimitTokens(
      'the request exceeds the available context size (8192 tokens), try increasing it',
    )).toBe(8_192)
  })

  it('does NOT mistake the token count for the limit', () => {
    // The 250000 is what we sent; 200000 is the limit.
    expect(parseProviderLimitTokens('prompt is too long: 250000 tokens > 200000 maximum'))
      .not.toBe(250_000)
  })

  it('rejects an implausibly small number', () => {
    // "context window is 42" in a log line must not become the limit.
    expect(parseProviderLimitTokens('the context window is 42 rows wide')).toBeUndefined()
  })

  it('returns undefined when nothing matches', () => {
    expect(parseProviderLimitTokens('internal server error')).toBeUndefined()
    expect(parseProviderLimitTokens('')).toBeUndefined()
    expect(parseProviderLimitTokens(undefined)).toBeUndefined()
  })

  it('handles a number with no separators or with them', () => {
    expect(parseProviderLimitTokens('maximum context length is 1,048,576')).toBeUndefined()
    expect(parseProviderLimitTokens('maximum context length is 1048576 tokens')).toBe(1_048_576)
  })
})

describe('provenLimitKey', () => {
  it('namespaces the route so two models cannot share a limit', () => {
    expect(provenLimitKey('deepseek', 'v4')).toBe('proven.limit.deepseek|v4')
    expect(provenLimitKey('deepseek', 'v4')).not.toBe(provenLimitKey('deepseek', 'v3'))
  })
})
