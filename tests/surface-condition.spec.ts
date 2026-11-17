/**
 * Declarative surface conditions.
 *
 * The security-relevant property is that a condition is DATA, never code: the
 * parser accepts a fixed set of kinds and the evaluator dispatches on them. A
 * condition can therefore never make the plugin execute generated source — which
 * is why this adapter does not need upstream's QuickJS WASM sandbox.
 *
 * The correctness-relevant properties:
 *  - a path that escapes the project root is refused at parse time, so a typo
 *    cannot become a note that checks `../../../etc/passwd`;
 *  - `file-contains` on a file past the read limit reports NOT met rather than
 *    met — a truncated read is not evidence;
 *  - an evaluation error is returned, never thrown, and never counts as "met".
 */
import { describe, expect, it } from 'vitest'
import {
  evaluateSurfaceCondition,
  nextSurfaceCheckAt,
  parseSurfaceCondition,
  resolveInsideRoot,
  SurfaceConditionError,
  SURFACE_CHECK_CEILING_MS,
  SURFACE_CHECK_FLOOR_MS,
  type SurfaceCheckSeams,
} from '../src/core/surface-condition.ts'

const ROOT = 'C:/work/project'

/** Seams with everything stubbed: no filesystem, no git, no network. */
function seams(overrides: Partial<SurfaceCheckSeams> = {}): SurfaceCheckSeams {
  return {
    projectRoot: ROOT,
    readFile: async () => null,
    git: async () => null,
    httpGet: async () => ({ status: 200, body: '' }),
    ...overrides,
  }
}

describe('parseSurfaceCondition', () => {
  it('parses each supported kind with its arity', () => {
    expect(parseSurfaceCondition('file-exists(dist/out.js)').kind).toBe('file-exists')
    expect(parseSurfaceCondition('file-contains(a.txt, hello)').args).toEqual(['a.txt', 'hello'])
    expect(parseSurfaceCondition('git-head(abc1234)').args).toEqual(['abc1234'])
    expect(parseSurfaceCondition('git-tag-matches(^v\\d+)').args).toEqual(['^v\\d+'])
    expect(parseSurfaceCondition('http-status(https://x.test/a, 200)').args).toHaveLength(2)
  })

  it('keeps a comma inside a quoted argument', () => {
    expect(parseSurfaceCondition('file-contains(a.txt, "one, two")').args).toEqual(['a.txt', 'one, two'])
  })

  it('trims surrounding whitespace', () => {
    expect(parseSurfaceCondition('  file-exists( a.js )  ').args).toEqual(['a.js'])
  })

  it('rejects an unknown kind and names the supported ones', () => {
    expect(() => parseSurfaceCondition('exec(rm -rf /)')).toThrow(SurfaceConditionError)
    try {
      parseSurfaceCondition('exec(rm -rf /)')
    } catch (error) {
      expect((error as Error).message).toContain('file-exists')
    }
  })

  it('rejects the wrong number of arguments', () => {
    expect(() => parseSurfaceCondition('file-exists(a, b)')).toThrow(SurfaceConditionError)
    expect(() => parseSurfaceCondition('file-contains(a)')).toThrow(SurfaceConditionError)
  })

  it('rejects empty text and a missing wrapper', () => {
    expect(() => parseSurfaceCondition('')).toThrow(SurfaceConditionError)
    expect(() => parseSurfaceCondition('file-exists')).toThrow(SurfaceConditionError)
    expect(() => parseSurfaceCondition('file-exists(a) trailing')).toThrow(SurfaceConditionError)
  })

  it('rejects an empty argument', () => {
    expect(() => parseSurfaceCondition('file-exists()')).toThrow(SurfaceConditionError)
  })
})

describe('resolveInsideRoot', () => {
  it('resolves a relative path under the root', () => {
    expect(resolveInsideRoot(ROOT, 'dist/out.js')).toBe('C:/work/project/dist/out.js')
  })

  it('normalises backslashes and a leading ./', () => {
    expect(resolveInsideRoot(ROOT, '.\\dist\\out.js')).toBe('C:/work/project/dist/out.js')
  })

  it('refuses an absolute path', () => {
    expect(() => resolveInsideRoot(ROOT, '/etc/passwd')).toThrow(SurfaceConditionError)
    expect(() => resolveInsideRoot(ROOT, 'C:/Windows/win.ini')).toThrow(SurfaceConditionError)
  })

  it('refuses a parent traversal', () => {
    expect(() => resolveInsideRoot(ROOT, '../secret.txt')).toThrow(SurfaceConditionError)
    expect(() => resolveInsideRoot(ROOT, 'a/../../b.txt')).toThrow(SurfaceConditionError)
  })

  it('refuses a home-relative path', () => {
    expect(() => resolveInsideRoot(ROOT, '~/.ssh/id_rsa')).toThrow(SurfaceConditionError)
  })
})

describe('evaluateSurfaceCondition', () => {
  it('file-exists reports met only when the file is readable', async () => {
    const present = await evaluateSurfaceCondition(
      parseSurfaceCondition('file-exists(a.txt)'),
      seams({ readFile: async () => 'x' }),
    )
    expect(present).toEqual({ met: true })

    const absent = await evaluateSurfaceCondition(
      parseSurfaceCondition('file-exists(a.txt)'),
      seams({ readFile: async () => null }),
    )
    expect(absent).toEqual({ met: false })
  })

  it('file-contains looks for the needle', async () => {
    const yes = await evaluateSurfaceCondition(
      parseSurfaceCondition('file-contains(a.txt, hello)'),
      seams({ readFile: async () => 'say hello there' }),
    )
    expect(yes.met).toBe(true)

    const no = await evaluateSurfaceCondition(
      parseSurfaceCondition('file-contains(a.txt, goodbye)'),
      seams({ readFile: async () => 'say hello there' }),
    )
    expect(no.met).toBe(false)
  })

  it('file-contains reports NOT met when the file exceeds the read limit', async () => {
    // A truncated read is not evidence: claiming "met" would surface a note
    // whose evidence was never actually seen.
    const result = await evaluateSurfaceCondition(
      parseSurfaceCondition('file-contains(big.txt, needle)'),
      seams({ readFile: async () => 'needle' + 'x'.repeat(200_000), fileLimitBytes: 1_000 }),
    )
    expect(result.met).toBe(false)
  })

  it('git-head compares a hex prefix case-insensitively', async () => {
    const met = await evaluateSurfaceCondition(
      parseSurfaceCondition('git-head(ABC1)'),
      seams({ git: async () => 'abc1234def\n' }),
    )
    expect(met.met).toBe(true)
  })

  it('git-head rejects a non-hex prefix as an error, not a false', async () => {
    const result = await evaluateSurfaceCondition(
      parseSurfaceCondition('git-head(not-a-sha)'),
      seams({ git: async () => 'abc1234' }),
    )
    expect(result.met).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('git-tag-matches applies the regex to the tag', async () => {
    const met = await evaluateSurfaceCondition(
      parseSurfaceCondition('git-tag-matches(^v0\\.4)'),
      seams({ git: async () => 'v0.49.41\n' }),
    )
    expect(met.met).toBe(true)
  })

  it('git-tag-matches reports a bad regex as an error', async () => {
    const result = await evaluateSurfaceCondition(
      parseSurfaceCondition('git-tag-matches([unclosed)'),
      seams({ git: async () => 'v1' }),
    )
    expect(result.met).toBe(false)
    expect(result.error).toContain('invalid regex')
  })

  it('http-status compares the code', async () => {
    expect((await evaluateSurfaceCondition(
      parseSurfaceCondition('http-status(https://x.test/a, 204)'),
      seams({ httpGet: async () => ({ status: 204, body: '' }) }),
    )).met).toBe(true)
    expect((await evaluateSurfaceCondition(
      parseSurfaceCondition('http-status(https://x.test/a, 200)'),
      seams({ httpGet: async () => ({ status: 500, body: '' }) }),
    )).met).toBe(false)
  })

  it('http-status rejects a non-numeric code', async () => {
    const result = await evaluateSurfaceCondition(
      parseSurfaceCondition('http-status(https://x.test/a, ok)'),
      seams(),
    )
    expect(result.met).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('http-body-contains searches the body', async () => {
    const met = await evaluateSurfaceCondition(
      parseSurfaceCondition('http-body-contains(https://x.test/a, "release v2")'),
      seams({ httpGet: async () => ({ status: 200, body: 'notes: release v2 shipped' }) }),
    )
    expect(met.met).toBe(true)
  })

  it('turns a transport failure into a returned error rather than a throw', async () => {
    const result = await evaluateSurfaceCondition(
      parseSurfaceCondition('http-status(https://x.test/a, 200)'),
      seams({ httpGet: async () => { throw new Error('ECONNREFUSED') } }),
    )
    expect(result.met).toBe(false)
    expect(result.error).toContain('ECONNREFUSED')
  })

  it('turns a throwing readFile into a returned error', async () => {
    const result = await evaluateSurfaceCondition(
      parseSurfaceCondition('file-exists(a.txt)'),
      seams({ readFile: async () => { throw new Error('EACCES') } }),
    )
    expect(result.met).toBe(false)
    expect(result.error).toContain('EACCES')
  })
})

describe('nextSurfaceCheckAt', () => {
  it('clamps a tiny interval up to the floor', () => {
    expect(nextSurfaceCheckAt(1_000, 1_000, 1)).toBe(1_000 + SURFACE_CHECK_FLOOR_MS)
  })

  it('clamps a huge interval down to the ceiling', () => {
    expect(nextSurfaceCheckAt(1_000, 1_000, 10 ** 12)).toBe(1_000 + SURFACE_CHECK_CEILING_MS)
  })

  it('starts from now when the note has never been checked', () => {
    // 60s is below the floor, so the result is now + FLOOR, not now + 60s.
    expect(nextSurfaceCheckAt(undefined, 5_000, 60_000)).toBe(5_000 + SURFACE_CHECK_FLOOR_MS)
  })
})
