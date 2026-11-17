/**
 * The shareability gate.
 *
 * This is the replacement for "a human reads every approval card". It has to be
 * right in both directions, and the live corpus supplies the cases:
 *
 *  - one memory carries a plaintext API key (`sk-strata-…`);
 *  - 129 carry machine-local paths or endpoints;
 *  - one of those (a local proxy port) was ALREADY published, because a human
 *    reading the sentence saw a HuggingFace mirror note, not `127.0.0.1:3067`.
 *
 * So the tests are the refusal cases, and the "must not over-refuse" cases are
 * just as important: a gate that flags everything gets switched off.
 */
import { describe, expect, it } from 'vitest'
import {
  assessShareability,
  hasShareabilitySensitiveText,
} from '../src/core/shareable-guard.ts'

describe('credential shapes are refused', () => {
  it('catches the API key that is actually in the corpus', () => {
    // Verbatim from live memory #759.
    const verdict = assessShareability(
      'API key sk-strata-fa8dd7d3a6c8b7d8f6f61acba7546fce（写在 C:\\Strata\\strata-iq3_xxs-abl.json）',
    )
    expect(verdict.safe).toBe(false)
    // The local path matches first or the key does; either way it is refused,
    // and the fragment never carries the whole secret.
    expect(['credential-shape', 'local-trace']).toContain(verdict.refusal)
  })

  it('catches each provider prefix', () => {
    for (const sample of [
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
      'sk-proj-abcdefghijklmnop',
      'github_pat_11ABCDEFG0123456789_abcdefghij',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'hf_abcdefghijklmnopqrstuvwxyz0123456789',
      'AKIAIOSFODNN7EXAMPLE',
      'xoxb-1234567890-abcdefghij',
      'AIzaSyA1234567890abcdefghijklmnopqrstuv',
    ]) {
      expect(hasShareabilitySensitiveText(sample), sample).toBe(true)
    }
  })

  it('catches authorization headers and JWTs', () => {
    expect(hasShareabilitySensitiveText('Authorization: Bearer abcdefghijklmnop')).toBe(true)
    expect(hasShareabilitySensitiveText('Proxy-Authorization: Basic dXNlcjpwYXNz')).toBe(true)
    expect(hasShareabilitySensitiveText('token is eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij')).toBe(true)
  })

  it('catches credentials inside a URL', () => {
    expect(hasShareabilitySensitiveText('postgres://admin:hunter2@db.internal/app')).toBe(true)
  })

  it('catches an inline key: value', () => {
    expect(hasShareabilitySensitiveText('api_key: 8f4b2c9d1e6a7b3c')).toBe(true)
    expect(hasShareabilitySensitiveText('password=qwerty1234')).toBe(true)
  })
})

describe('machine-local traces are refused', () => {
  it('catches a Windows home path', () => {
    const verdict = assessShareability('C:\\Users\\yxx\\.dsh\\profiles\\desktop\\cordis.patch.yml 现 667 行')
    expect(verdict.safe).toBe(false)
    expect(verdict.refusal).toBe('local-trace')
    expect(verdict.fragment).toContain('C:\\Users\\yxx')
  })

  it('catches a forward-slash home path', () => {
    expect(hasShareabilitySensitiveText('config at C:/Users/alice/app/settings.json')).toBe(true)
  })

  it('catches a tilde path', () => {
    expect(hasShareabilitySensitiveText('see ~/.ssh/config for the host entry')).toBe(true)
  })

  it('catches the loopback port that was actually published', () => {
    // Verbatim shape from live memory #590, which is `shareable=1` today.
    const verdict = assessShareability(
      'VPN 已从「代理模式」切到「TUN 模式」，因此不再需要 127.0.0.1:3067 代理',
    )
    expect(verdict.safe).toBe(false)
    expect(verdict.refusal).toBe('local-trace')
    expect(verdict.fragment).toContain('127.0.0.1:3067')
  })

  it('catches each private range', () => {
    for (const sample of [
      'bind 0.0.0.0:8080',
      'http://localhost:5173',
      'http://[::1]:9000',
      'host 192.168.1.42',
      'host 10.1.2.3',
      'host 172.16.5.9',
      'host 172.31.0.1',
    ]) {
      expect(hasShareabilitySensitiveText(sample), sample).toBe(true)
    }
  })
})

describe('it does not over-refuse', () => {
  it('passes an ordinary architectural fact', () => {
    const verdict = assessShareability('The scheduler tick is five minutes and takes a lease before writing.')
    expect(verdict.safe).toBe(true)
    expect(verdict.refusal).toBeUndefined()
  })

  it('passes Chinese prose about the design', () => {
    expect(hasShareabilitySensitiveText('本地没有工具循环，所以上游的 tool-loop 任务改成宿主取证。')).toBe(false)
  })

  it('passes a relative path', () => {
    expect(hasShareabilitySensitiveText('src/core/dream-runner.ts owns the backoff')).toBe(false)
  })

  it('passes diagnostic scalars that merely look keyed', () => {
    // These would be flagged by a naive `key=value` rule, and flagging them
    // would make every run report "sensitive" until the gate gets disabled.
    expect(hasShareabilitySensitiveText('tokens.input=45000')).toBe(false)
    expect(hasShareabilitySensitiveText('hasUsageTokens=true')).toBe(false)
    expect(hasShareabilitySensitiveText('max_tokens: 32768')).toBe(false)
  })

  it('passes a public DNS name', () => {
    expect(hasShareabilitySensitiveText('the mirror is hf-mirror.com, not a local proxy')).toBe(false)
  })

  it('passes a non-private IP in prose', () => {
    // 172.32 is outside the RFC1918 range that 172.16-31 covers.
    expect(hasShareabilitySensitiveText('the CDN resolves to 172.32.0.1')).toBe(false)
  })
})

describe('fail-closed', () => {
  it('refuses a non-string', () => {
    expect(assessShareability(undefined).refusal).toBe('unscannable')
    expect(assessShareability(null).refusal).toBe('unscannable')
    expect(assessShareability(42).refusal).toBe('unscannable')
  })

  it('refuses an empty string', () => {
    expect(assessShareability('').refusal).toBe('unscannable')
  })

  it('bounds the fragment it reports', () => {
    const long = `C:/Users/${'a'.repeat(200)}/x`
    const verdict = assessShareability(long)
    expect(verdict.safe).toBe(false)
    expect((verdict.fragment ?? '').length).toBeLessThanOrEqual(81)
  })

  it('is state-free across repeated calls', () => {
    // The shared /g regexes carry lastIndex; a second call must find the same
    // match as the first.
    const text = 'api_key: 8f4b2c9d1e6a7b3c'
    expect(hasShareabilitySensitiveText(text)).toBe(true)
    expect(hasShareabilitySensitiveText(text)).toBe(true)
    expect(hasShareabilitySensitiveText('harmless text here')).toBe(false)
    expect(hasShareabilitySensitiveText(text)).toBe(true)
  })
})
