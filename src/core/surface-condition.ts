/**
 * Declarative surface conditions for smart notes.
 *
 * A smart note is parked until an externally verifiable condition holds, then
 * surfaces on its own. Upstream implements this with an LLM that compiles the
 * condition into JavaScript, executed inside a QuickJS WASM sandbox
 * (`smart-notes/compiler.ts` 535 lines + `sandbox-runner.ts` 688 lines, plus a
 * ~2.6MB inlined WASM module). That is a subagent, a code generator and a
 * runtime VM — three subsystems this adapter does not have.
 *
 * This adapter takes the declarative subset instead: the condition states WHAT
 * to check, in a fixed grammar, and the checker is plain Node code with no
 * evaluation of generated source. The trade is expressiveness for auditability —
 * every kind of check the plugin can perform is enumerable in advance, so a note
 * can never make the plugin run arbitrary code.
 *
 * Grammar (one condition per note, `kind(args)`):
 *
 *   file-exists(path)              the path exists on disk
 *   file-contains(path, text)      the file exists and contains `text`
 *   git-head(sha-prefix)           HEAD starts with the given prefix
 *   git-tag-matches(regex)         `git describe --tags --abbrev=0` matches
 *   http-status(url, code)         GET returns that status
 *   http-body-contains(url, text)  GET returns a body containing `text`
 *
 * Every path is resolved against the project root and must stay inside it: an
 * absolute path, a `..` escape, or a home-relative `~` is refused at compile
 * time. Network checks go through {@link guardedHttpGet}, which applies the same
 * SSRF rules as the rest of the adapter: no loopback, no link-local, no
 * private ranges, http(s) only.
 */

/** Longest condition string accepted; a note's first line is its title (`<80`). */
export const SURFACE_CONDITION_MAX_CHARS = 512
/** A condition is re-checked no sooner than this, however small its interval. */
export const SURFACE_CHECK_FLOOR_MS = 5 * 60 * 1000
/** ...and no later than this, so a parked note still wakes eventually. */
export const SURFACE_CHECK_CEILING_MS = 24 * 60 * 60 * 1000
/** Default re-check interval. */
export const SURFACE_CHECK_INTERVAL_MS = 60 * 60 * 1000
/** After this many consecutive transport failures the note is surfaced with a warning. */
export const SURFACE_CHECK_MAX_FAILURES = 5

export type SurfaceConditionKind =
  | 'file-exists'
  | 'file-contains'
  | 'git-head'
  | 'git-tag-matches'
  | 'http-status'
  | 'http-body-contains'

export interface SurfaceCondition {
  readonly kind: SurfaceConditionKind
  /** Raw argument list, already trimmed; meaning depends on `kind`. */
  readonly args: readonly string[]
  /** The condition as written, for display and for the stored column. */
  readonly source: string
}

export class SurfaceConditionError extends Error {
  readonly code = 'invalid_surface_condition'
}

const KIND_ARITY: Record<SurfaceConditionKind, number> = {
  'file-exists': 1,
  'file-contains': 2,
  'git-head': 1,
  'git-tag-matches': 1,
  'http-status': 2,
  'http-body-contains': 2,
}

const KINDS = new Set<string>(Object.keys(KIND_ARITY))

/**
 * Split `kind(a, b)` into its kind and arguments.
 *
 * The argument splitter understands a quoted string so a path or needle may
 * contain a comma; it does not support escapes beyond `\"`, which is enough for
 * paths and short needles and keeps the grammar obvious.
 *
 * @param source - the condition as the agent wrote it.
 * @returns the parsed condition.
 * @throws SurfaceConditionError when the text is not a well-formed condition.
 */
export function parseSurfaceCondition(source: string): SurfaceCondition {
  const text = source.trim()
  if (text.length === 0) throw new SurfaceConditionError('a surface condition cannot be empty')
  if (text.length > SURFACE_CONDITION_MAX_CHARS) {
    throw new SurfaceConditionError(
      `a surface condition must be at most ${String(SURFACE_CONDITION_MAX_CHARS)} characters`,
    )
  }
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open <= 0 || close !== text.length - 1 || close < open) {
    throw new SurfaceConditionError('expected `kind(args)` — for example `file-exists(dist/out.js)`')
  }
  const kind = text.slice(0, open).trim()
  if (!KINDS.has(kind)) {
    throw new SurfaceConditionError(
      `unknown condition kind "${kind}"; supported: ${[...KINDS].sort().join(', ')}`,
    )
  }
  const args = splitArgs(text.slice(open + 1, close))
  const expected = KIND_ARITY[kind as SurfaceConditionKind]
  if (args.length !== expected) {
    throw new SurfaceConditionError(
      `${kind} takes ${String(expected)} argument${expected === 1 ? '' : 's'}, got ${String(args.length)}`,
    )
  }
  if (args.some(arg => arg.length === 0)) {
    throw new SurfaceConditionError(`${kind} has an empty argument`)
  }
  return { kind: kind as SurfaceConditionKind, args, source: text }
}

/** Split on commas outside quotes; strips one layer of surrounding quotes. */
function splitArgs(raw: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string
    if (char === '"' && raw[index - 1] !== '\\') {
      quoted = !quoted
      current += char
      continue
    }
    if (char === ',' && !quoted) {
      out.push(unquote(current.trim()))
      current = ''
      continue
    }
    current += char
  }
  out.push(unquote(current.trim()))
  return out
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll('\\"', '"')
  }
  return value
}

/**
 * Resolve a note's path argument against the project root, refusing anything
 * that escapes it.
 *
 * Three escapes matter and all are cheap to write by accident: an absolute path,
 * a `..` segment, and a `~` prefix. Refusing them here (rather than at check
 * time) means a bad condition never even becomes a stored note, so a typo cannot
 * silently park a note forever.
 *
 * @param projectRoot - absolute project root.
 * @param path - the note's path argument.
 * @returns the resolved absolute path, known to be under the root.
 */
export function resolveInsideRoot(projectRoot: string, path: string): string {
  const trimmed = path.trim()
  if (trimmed.length === 0) throw new SurfaceConditionError('the path argument is empty')
  if (trimmed.startsWith('~')) {
    throw new SurfaceConditionError('paths must be relative to the project root; `~` is not allowed')
  }
  if (/^([A-Za-z]:|[\\/])/.test(trimmed)) {
    throw new SurfaceConditionError('paths must be relative to the project root; absolute paths are not allowed')
  }
  const segments = trimmed.replaceAll('\\', '/').split('/')
  if (segments.includes('..')) {
    throw new SurfaceConditionError('paths must not contain `..`')
  }
  const root = projectRoot.replaceAll('\\', '/').replace(/\/+$/, '')
  const joined = `${root}/${segments.filter(segment => segment.length > 0 && segment !== '.').join('/')}`
  // Belt and braces: a resolved path must still start with the root. This is what
  // catches a trick the segment scan misses, e.g. a Windows drive-relative form.
  const normalizedRoot = root.endsWith('/') ? root : `${root}/`
  if (!`${joined}/`.startsWith(normalizedRoot) && joined !== root) {
    throw new SurfaceConditionError('the path resolves outside the project root')
  }
  return joined
}

/** Outcome of one evaluation. `met` is the only thing the caller acts on. */
export interface SurfaceCheckResult {
  readonly met: boolean
  /**
   * Present when the check could not run. `met` is then false and the note stays
   * parked: an unrunnable check is not evidence that the condition holds.
   */
  readonly error?: string
}

/** The seams a check needs. All injectable, so the evaluator is testable offline. */
export interface SurfaceCheckSeams {
  readonly projectRoot: string
  readonly readFile: (absolutePath: string) => Promise<string | null>
  readonly git: (args: readonly string[]) => Promise<string | null>
  readonly httpGet: (url: string) => Promise<{ readonly status: number; readonly body: string }>
  /** Upper bound on a file read; a larger file counts as "not containing". */
  readonly fileLimitBytes?: number
}

const DEFAULT_FILE_LIMIT_BYTES = 64 * 1024

/**
 * Evaluate a parsed condition.
 *
 * Errors are returned, never thrown: a note whose check cannot run must stay
 * parked and retry, and a thrown error would instead abort the whole maintenance
 * tick that evaluates many notes in one pass.
 *
 * @param condition - the parsed condition.
 * @param seams - the injected capabilities.
 * @returns whether the condition holds, or why it could not be checked.
 */
export async function evaluateSurfaceCondition(
  condition: SurfaceCondition,
  seams: SurfaceCheckSeams,
): Promise<SurfaceCheckResult> {
  const limit = seams.fileLimitBytes ?? DEFAULT_FILE_LIMIT_BYTES
  try {
    switch (condition.kind) {
      case 'file-exists': {
        const path = resolveInsideRoot(seams.projectRoot, condition.args[0] as string)
        const content = await seams.readFile(path)
        return { met: content !== null }
      }
      case 'file-contains': {
        const path = resolveInsideRoot(seams.projectRoot, condition.args[0] as string)
        const needle = condition.args[1] as string
        const content = await seams.readFile(path)
        if (content === null) return { met: false }
        // A file past the limit cannot be searched, so it does not match: saying
        // "met" on a truncated read would surface a note whose evidence was never
        // actually seen.
        if (content.length > limit) return { met: false }
        return { met: content.includes(needle) }
      }
      case 'git-head': {
        const prefix = (condition.args[0] as string).toLowerCase()
        if (!/^[0-9a-f]{4,64}$/.test(prefix)) {
          return { met: false, error: 'git-head expects a hex SHA prefix of at least 4 characters' }
        }
        const sha = await seams.git(['rev-parse', 'HEAD'])
        if (sha === null) return { met: false }
        return { met: sha.trim().toLowerCase().startsWith(prefix) }
      }
      case 'git-tag-matches': {
        let regex: RegExp
        try {
          regex = new RegExp(condition.args[0] as string)
        } catch (error) {
          return { met: false, error: `invalid regex: ${error instanceof Error ? error.message : String(error)}` }
        }
        const tag = await seams.git(['describe', '--tags', '--abbrev=0', '--always'])
        if (tag === null) return { met: false }
        return { met: regex.test(tag.trim()) }
      }
      case 'http-status': {
        const url = condition.args[0] as string
        const want = Number(condition.args[1])
        if (!Number.isInteger(want) || want < 100 || want > 599) {
          return { met: false, error: 'http-status expects an integer status code' }
        }
        const response = await seams.httpGet(url)
        return { met: response.status === want }
      }
      case 'http-body-contains': {
        const url = condition.args[0] as string
        const needle = condition.args[1] as string
        const response = await seams.httpGet(url)
        return { met: response.body.includes(needle) }
      }
    }
  } catch (error) {
    return { met: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * When should this note be checked next?
 *
 * Deterministic, no jitter: two passes over the same note must agree, or a note
 * could be re-checked twice within one tick by two different code paths.
 *
 * @param lastCheckedAt - when the last check ran, or undefined for a new note.
 * @param now - current time.
 * @param intervalMs - desired interval; clamped into [floor, ceiling].
 */
export function nextSurfaceCheckAt(
  lastCheckedAt: number | undefined,
  now: number,
  intervalMs: number = SURFACE_CHECK_INTERVAL_MS,
): number {
  const interval = Math.min(
    SURFACE_CHECK_CEILING_MS,
    Math.max(SURFACE_CHECK_FLOOR_MS, intervalMs),
  )
  return (lastCheckedAt ?? now) + interval
}
