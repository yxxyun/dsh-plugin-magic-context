/**
 * Read git commit history from a working directory with one `git log` call.
 *
 * Ported from upstream `git-commits/git-log-reader.ts` (264 lines). The parsing
 * contract is kept verbatim because each detail fixed a real failure:
 *
 *  - **US/RS separators, never NUL.** `%x1f` (unit separator) between fields and
 *    `%x1e` (record separator) between commits. NUL would be the obvious choice,
 *    but Node's `child_process.execFile` rejects any argv element containing an
 *    embedded NUL ("must be a string without null bytes") before git ever runs.
 *    A more permissive runtime masked this during unit tests and it only surfaced
 *    in production.
 *  - **Split on the first four separators only.** A commit body can contain `\x1f`
 *    legitimately; `String.split(sep, n)` caps the OUTPUT ARRAY rather than the
 *    SPLIT COUNT, so it would silently truncate the body. The split is manual.
 *  - **`--` before the revision list ends.** Without it, a worktree file named
 *    like the revision (`HEAD`) makes git fail with "ambiguous argument" on every
 *    index attempt.
 *  - **`--no-merges`.** Merge commits carry no authored change and would fill the
 *    index with "Merge branch 'x'" noise.
 *
 * Failure is classified rather than thrown: a directory that is not a repo and a
 * repo with no commits are STRUCTURAL (retrying every cycle cannot help), while a
 * timeout or a missing git binary is TRANSIENT. Callers use that split to decide
 * whether to back off for a long time or retry on the normal cadence.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 10_000
/** Hard cap per invocation; the indexer loops with a since-filter for more. */
const DEFAULT_MAX_COMMITS = 5_000
const RECORD_SEPARATOR = '\x1e'
const FIELD_SEPARATOR = '\x1f'
/** A full SHA-1 (40 hex) or SHA-256 (64 hex) object name as printed by `%H`. */
const FULL_OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** Why `git log` produced nothing, when it failed. */
export type GitLogFailureKind = 'not_a_repo' | 'no_head' | 'transient'

/**
 * Classify a git failure message.
 *
 * `not_a_repo` and `no_head` are structural: a directory that will never become
 * a repository, or one whose HEAD has no commits yet. Both deserve a long
 * re-probe cooldown instead of a log line every cycle. Everything else is
 * `transient`.
 *
 * @param message - the error text from the failed `git log`.
 */
export function classifyGitLogFailure(message: string): GitLogFailureKind {
  if (message.includes('not a git repository')) return 'not_a_repo'
  if (
    message.includes('unknown revision or path not in the working tree')
    || message.includes('does not have any commits yet')
    // The wording git actually emits on `git log HEAD` in a repo with no commits:
    // "fatal: your current branch 'main' does not have any commits yet". The
    // upstream classifier matched only the long form and silently classified this
    // as transient, so a fresh repo was re-probed every cycle forever.
    || message.includes('has no commits yet')
    || message.includes('bad revision')
  ) {
    return 'no_head'
  }
  return 'transient'
}

/** One commit, in the shape the index and search lanes consume. */
export interface GitCommit {
  /** Full object name: 40 hex characters, or 64 in a SHA-256 repository. */
  readonly sha: string
  /** First 7 characters, for display. */
  readonly shortSha: string
  /** Subject, plus a blank line and the body when a body exists. */
  readonly message: string
  /** Author email, or null when git reported none. */
  readonly author: string | null
  /** Committer time in milliseconds since epoch. */
  readonly committedAtMs: number
}

export interface ReadGitCommitsOptions {
  /** Only include commits newer than this (epoch ms). */
  readonly sinceMs?: number
  /** Revision to walk; defaults to `HEAD`. */
  readonly branch?: string
  /** Hard cap on returned commits. */
  readonly maxCommits?: number
  /**
   * A commit whose history is already indexed. Commits reachable from it are
   * skipped, so an incremental read returns exactly what became reachable since
   * — including merged branch commits whose dates predate anything indexed.
   */
  readonly excludeReachableFrom?: string
  /** Opaque project label for diagnostics; never the absolute path. */
  readonly projectIdentity?: string
  /**
   * Diagnostic sink. Take the message as data: this module never logs the
   * absolute directory, which carries the username and project name.
   */
  readonly log?: (message: string) => void
}

/** Outcome of a read: the commits, and why it was empty when it was. */
export interface GitLogReadResult {
  readonly commits: GitCommit[]
  readonly failure: GitLogFailureKind | null
}

/**
 * Read commits reachable from HEAD (or `branch`) up to `maxCommits`.
 *
 * Never throws on a git failure — indexing is a background nicety, and a repo
 * that cannot be read must not fail the pass that requested it. An invalid
 * `branch` (one that looks like an option) is the single exception: that is a
 * programming error in the caller, not an environment condition.
 *
 * @param directory - working directory to run git in.
 * @param options - range, cap, and incremental exclusion.
 */
export async function readGitCommits(
  directory: string,
  options: ReadGitCommitsOptions = {},
): Promise<GitCommit[]> {
  return (await readGitCommitsResult(directory, options)).commits
}

/**
 * Like {@link readGitCommits}, but also reports WHY the read produced nothing.
 *
 * @param directory - working directory to run git in.
 * @param options - range, cap, and incremental exclusion.
 */
export async function readGitCommitsResult(
  directory: string,
  options: ReadGitCommitsOptions = {},
): Promise<GitLogReadResult> {
  const log = options.log ?? (() => {})
  // A revision beginning with `-` sits ahead of the format flags, so git would
  // parse it as an OPTION rather than a revision. No shell is involved, so this
  // was never command injection — but `--` would make git read it as a
  // pathspec, so the value is validated instead of escaped.
  const revision = options.branch ?? 'HEAD'
  if (revision.startsWith('-')) {
    throw new Error(`readGitCommits: refusing revision that looks like an option: "${revision}"`)
  }
  const projectLabel = options.projectIdentity ?? '<project>'
  const exclusion = options.excludeReachableFrom !== undefined
    && FULL_OBJECT_NAME.test(options.excludeReachableFrom)
    ? options.excludeReachableFrom
    : null

  const args = [
    'log',
    revision,
    ...exclusion === null ? [] : [`^${exclusion}`],
    '--no-merges',
    `--max-count=${String(options.maxCommits ?? DEFAULT_MAX_COMMITS)}`,
    `--format=%H${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%ae${FIELD_SEPARATOR}%ct${FIELD_SEPARATOR}%b${RECORD_SEPARATOR}`,
  ]
  if (options.sinceMs !== undefined && options.sinceMs > 0) {
    args.push(`--since=${new Date(options.sinceMs).toISOString()}`)
  }
  args.push('--')

  let stdout: string
  try {
    const result = await execFileAsync('git', args, {
      windowsHide: true,
      cwd: directory,
      timeout: GIT_TIMEOUT_MS,
      // The default 1 MB buffer is small for a long history; commits are tiny but
      // a 5,000-commit window of messages is not.
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    })
    stdout = result.stdout
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (exclusion !== null && message.includes('bad object')) {
      // The excluded commit was rewritten away and garbage-collected, so it no
      // longer bounds anything. Read the full window instead; the upsert skips
      // what is already indexed.
      log(`[git-commits] indexed tip ${exclusion.slice(0, 7)} is missing for ${projectLabel}; reading the full window`)
      return readGitCommitsResult(directory, { ...options, excludeReachableFrom: undefined })
    }
    const failure = classifyGitLogFailure(message)
    log(failure === 'transient'
      ? `[git-commits] read failed for ${projectLabel}: ${message.slice(0, 500)}`
      : `[git-commits] ${projectLabel} is not indexable (${failure})`)
    return { commits: [], failure }
  }

  return { commits: parseGitLogOutput(stdout), failure: null }
}

/**
 * Parse the delimited `git log` output.
 *
 * Exported so the format contract can be tested without a repository.
 *
 * @param stdout - raw `git log` output in the `%H\x1f%s\x1f%ae\x1f%ct\x1f%b\x1e` format.
 */
export function parseGitLogOutput(stdout: string): GitCommit[] {
  const commits: GitCommit[] = []
  for (const rawRecord of stdout.split(RECORD_SEPARATOR)) {
    const record = rawRecord.replace(/^\s+/, '')
    if (record.length === 0) continue

    // Take the first four separators only: a body may contain `\x1f` bytes, and
    // a limit on `split` would cap the array while truncating the body.
    const fields: string[] = []
    let remaining = record
    for (let field = 0; field < 4; field += 1) {
      const at = remaining.indexOf(FIELD_SEPARATOR)
      if (at < 0) break
      fields.push(remaining.slice(0, at))
      remaining = remaining.slice(at + FIELD_SEPARATOR.length)
    }
    fields.push(remaining)
    if (fields.length < 5) continue

    const sha = (fields[0] as string).trim()
    const subject = (fields[1] as string).trim()
    const author = (fields[2] as string).trim()
    const timeSec = Number.parseInt((fields[3] as string).trim(), 10)
    const body = (fields[4] as string).trim()

    // Reject anything that is not a full object name: a truncated read or a
    // partial line would otherwise enter the index with a sha that cannot be
    // looked up.
    if (!FULL_OBJECT_NAME.test(sha) || !Number.isFinite(timeSec) || timeSec <= 0) continue

    commits.push({
      sha,
      shortSha: sha.slice(0, 7),
      message: body.length > 0 ? `${subject}\n\n${body}` : subject,
      author: author.length > 0 ? author : null,
      committedAtMs: timeSec * 1000,
    })
  }
  return commits
}
