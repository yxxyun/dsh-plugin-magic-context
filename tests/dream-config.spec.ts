/**
 * Dream tunables: unwrapping, defaults, bounds, and the property that makes the
 * settings form useful at all — a value read at run time, not at mount.
 *
 * The failures this guards against are quiet ones:
 *
 *  - a volatile reference read as a plain value (you get `[object Object]`,
 *    or in a numeric field, the default — so the form looks like it works and
 *    changes nothing);
 *  - a value captured at mount, which ignores every later edit until restart;
 *  - `curateDryRun` defaulting to malformed input as "write", which is the one
 *    direction that cannot be undone.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_DREAM_CONFIG, resolveDreamConfig } from '../src/dsh/dream-config.ts'
import { liveStringArray, liveValue } from '../src/dsh/volatile.ts'

/** Stand-in for a schemastery volatile reference. */
const ref = <T>(get: () => T) => ({ get })

describe('resolveDreamConfig — defaults', () => {
  it('returns the shipped defaults for an absent block', () => {
    expect(resolveDreamConfig(undefined)).toEqual(DEFAULT_DREAM_CONFIG)
    expect(resolveDreamConfig(null)).toEqual(DEFAULT_DREAM_CONFIG)
    expect(resolveDreamConfig({})).toEqual(DEFAULT_DREAM_CONFIG)
  })

  it('overrides only what is present', () => {
    const resolved = resolveDreamConfig({ classifyBatchSize: 5 })
    expect(resolved.classifyBatchSize).toBe(5)
    // Everything else stays at its default.
    expect(resolved.verifyBatchSize).toBe(DEFAULT_DREAM_CONFIG.verifyBatchSize)
    expect(resolved.curateDryRun).toBe(true)
  })

  it('unwraps a volatile reference', () => {
    // The wrapper is what actually arrives from the host. Reading `.x` off it
    // yields the wrapper, so an unwrapped read would silently take the default.
    const resolved = resolveDreamConfig(ref(() => ({ verifyBatchSize: 3 })))
    expect(resolved.verifyBatchSize).toBe(3)
  })

  it('unwraps a nested chain', () => {
    // `config.a?.b` hands back a reference whose `.get()` is another reference;
    // one dereference is not always enough (measured on maintenance.verifyProvider).
    const resolved = resolveDreamConfig(ref(() => ref(() => ({ curateMaxPairs: 2 }))))
    expect(resolved.curateMaxPairs).toBe(2)
  })
})

describe('resolveDreamConfig — bounds', () => {
  it('clamps an out-of-range number rather than trusting it', () => {
    const resolved = resolveDreamConfig({
      classifyBatchSize: 9_999,
      verifyBatchSize: 0,
      curateSimilarityFloor: 5,
      curateMaxPairs: -3,
    })
    expect(resolved.classifyBatchSize).toBe(200)
    expect(resolved.verifyBatchSize).toBe(1)
    expect(resolved.curateSimilarityFloor).toBe(1)
    expect(resolved.curateMaxPairs).toBe(1)
  })

  it('clamps the windows so a task cannot be starved or hammered', () => {
    expect(resolveDreamConfig({ classifyStaleAfterMs: 1 }).classifyStaleAfterMs).toBe(3_600_000)
    expect(resolveDreamConfig({ retrospectiveWindowMs: 1 }).retrospectiveWindowMs).toBe(3_600_000)
  })

  it('rounds batch sizes to integers', () => {
    expect(resolveDreamConfig({ classifyBatchSize: 7.6 }).classifyBatchSize).toBe(8)
  })
})

describe('resolveDreamConfig — the one field where the default is a safety property', () => {
  it('is a dry run unless something explicitly said false', () => {
    // Absent, malformed, wrapped-and-empty: all dry run.
    expect(resolveDreamConfig({}).curateDryRun).toBe(true)
    expect(resolveDreamConfig({ curateDryRun: undefined }).curateDryRun).toBe(true)
    expect(resolveDreamConfig({ curateDryRun: 'yes' as unknown as boolean }).curateDryRun).toBe(true)
    // Only the literal false opts in.
    expect(resolveDreamConfig({ curateDryRun: false }).curateDryRun).toBe(false)
  })
})

describe('resolveDreamConfig — extra roots', () => {
  it('keeps a normal list', () => {
    expect(resolveDreamConfig({ verifyExtraRoots: ['C:/data/code', 'C:/Strata'] }).verifyExtraRoots)
      .toEqual(['C:/data/code', 'C:/Strata'])
  })

  it('drops empty and whitespace entries', () => {
    // An empty string would resolve to the process cwd inside buildFileIndex and
    // index the whole working tree by accident.
    expect(resolveDreamConfig({ verifyExtraRoots: ['C:/data', '', '   '] }).verifyExtraRoots)
      .toEqual(['C:/data'])
  })

  it('trims entries', () => {
    expect(resolveDreamConfig({ verifyExtraRoots: ['  C:/data/code  '] }).verifyExtraRoots)
      .toEqual(['C:/data/code'])
  })

  it('falls back when the value is not a string array', () => {
    expect(resolveDreamConfig({ verifyExtraRoots: 'C:/data' as unknown as string[] }).verifyExtraRoots)
      .toEqual([])
    expect(resolveDreamConfig({ verifyExtraRoots: [1, 2] as unknown as string[] }).verifyExtraRoots)
      .toEqual([])
  })
})

describe('liveValue / liveStringArray', () => {
  it('unwraps recursively', () => {
    expect(liveValue(ref(() => ref(() => 'x')))).toBe('x')
    expect(liveValue('x')).toBe('x')
    expect(liveValue(undefined)).toBeUndefined()
  })

  it('returns the fallback for a non-array', () => {
    expect(liveStringArray(undefined, ['a'])).toEqual(['a'])
    expect(liveStringArray('nope', ['a'])).toEqual(['a'])
  })

  it('rejects the whole list when one entry is not a string', () => {
    // A half-readable list is worse than the default: it would search the wrong
    // trees and report real files as missing.
    expect(liveStringArray(['a', 2], ['fallback'])).toEqual(['fallback'])
  })

  it('does not alias the fallback array', () => {
    const fallback = ['a']
    const out = liveStringArray(undefined, fallback)
    out.push('b')
    expect(fallback).toEqual(['a'])
  })
})

describe('the settings schema exposes the block', () => {
  it('materialises `dream` with the shipped defaults', async () => {
    // Without this declaration the settings form has no control for any of these
    // fields — `settings.describe()` projects only declared volatile fields, so an
    // undeclared block is invisible no matter what the runtime would accept.
    const { Config } = await import('../src/index.ts')
    const resolved = (Config as unknown as (input: unknown) => Record<string, unknown>)({})
    const dream = resolved.dream as Record<string, unknown> | undefined
    expect(dream).toBeDefined()
    // Every field comes back as a VOLATILE REFERENCE, not a value — the wrapper
    // with `get` and `[cosmokit.volatile.write]`. That is the evidence the
    // declaration took effect, and the reason `resolveDreamConfig` must unwrap:
    // reading `dream.classifyStaleAfterMs` directly yields the wrapper, and
    // `typeof wrapper === 'object'` would silently fall back to the default.
    expect(typeof (dream?.classifyStaleAfterMs as { get?: unknown } | undefined)?.get).toBe('function')
    const unwrap = <T>(value: unknown): T => {
      const seen = new Set<unknown>()
      let current: unknown = value
      while (current !== null && typeof current === 'object' && typeof (current as { get?: unknown }).get === 'function' && !seen.has(current)) {
        seen.add(current)
        current = (current as { get(): unknown }).get()
      }
      return current as T
    }
    expect(unwrap(dream?.classifyStaleAfterMs)).toBe(1_209_600_000)
    expect(unwrap(dream?.classifyBatchSize)).toBe(16)
    expect(unwrap(dream?.verifyBatchSize)).toBe(16)
    expect(unwrap(dream?.curateDryRun)).toBe(true)
    expect(unwrap(dream?.curateSimilarityFloor)).toBe(0.92)
    expect(unwrap(dream?.curateMaxPairs)).toBe(6)
    expect(unwrap(dream?.retrospectiveWindowMs)).toBe(604_800_000)
    expect(unwrap(dream?.verifyExtraRoots)).toEqual([])
    expect(unwrap(dream?.profileReviewBatch)).toBe(12)
    // And the resolver agrees with the schema, field for field.
    expect(resolveDreamConfig(resolved.dream)).toEqual(DEFAULT_DREAM_CONFIG)
  })

  it('keeps the schema defaults equal to the runtime defaults', () => {
    // Two copies of the same numbers, and they must not drift: the schema decides
    // what the form SHOWS, the resolver decides what a run USES.
    expect(1_209_600_000).toBe(DEFAULT_DREAM_CONFIG.classifyStaleAfterMs)
    expect(16).toBe(DEFAULT_DREAM_CONFIG.classifyBatchSize)
    expect(16).toBe(DEFAULT_DREAM_CONFIG.verifyBatchSize)
    expect(0.92).toBe(DEFAULT_DREAM_CONFIG.curateSimilarityFloor)
    expect(6).toBe(DEFAULT_DREAM_CONFIG.curateMaxPairs)
    expect(604_800_000).toBe(DEFAULT_DREAM_CONFIG.retrospectiveWindowMs)
    expect(12).toBe(DEFAULT_DREAM_CONFIG.profileReviewBatch)
  })
})


describe('resolveDreamConfig is a function of the CURRENT value', () => {
  it('sees a change made between two calls', () => {
    // This is the whole point: the handler holds `() => resolveDreamConfig(...)`
    // and calls it per run. If resolution happened once at mount, the second read
    // would return the first value and the settings form would be decorative.
    let current: Record<string, unknown> = { verifyBatchSize: 2 }
    const live = ref(() => current)
    expect(resolveDreamConfig(live).verifyBatchSize).toBe(2)

    current = { verifyBatchSize: 40 }
    expect(resolveDreamConfig(live).verifyBatchSize).toBe(40)

    current = {}
    expect(resolveDreamConfig(live).verifyBatchSize).toBe(DEFAULT_DREAM_CONFIG.verifyBatchSize)
  })
})
