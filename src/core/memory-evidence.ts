/**
 * Host-side evidence for memory verification.
 *
 * ## Why this exists
 *
 * The maintenance sweep already asks a model whether each memory is still true,
 * and the prompt it sends says, in as many words: *"Judge only from general
 * software-engineering plausibility and internal consistency; you have no file
 * access."* That is an honest description of what it can do — and it is the
 * ceiling on what it can know. A memory saying "`director.py:707` gates the
 * aspect ratio" cannot be checked by plausibility; it is either still there or
 * it is not.
 *
 * This module is the host's half of the exchange: it reads the files a memory
 * names, and hands the model a short, factual summary instead of asking it to
 * imagine one. That is the substitution this adapter makes for upstream's tool
 * loop — the host retrieves, the model judges.
 *
 * ## What "evidence" means here, and what it refuses to mean
 *
 * Three outcomes per reference, and the distinction is the whole point:
 *
 * - `found`     the file exists at exactly one indexed path; the summary carries
 *               its size and the cited line(s).
 * - `ambiguous` the bare filename matches several files. The evidence says so and
 *               lists them; it does NOT pick one. Guessing which `director.py` a
 *               memory meant would manufacture a verdict out of a coin flip.
 * - `missing`   nothing in the index matches. This is real evidence — a memory
 *               citing a file that no longer exists is stale by definition.
 *
 * ## The index is built per run, on purpose
 *
 * A persistent index would go stale exactly as silently as the memories it is
 * meant to check. Building it costs one directory walk over the project (bounded
 * by depth and file count), which is cheap next to the model call it feeds.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, extname, basename } from 'node:path'

/**
 * Extensions worth indexing.
 *
 * Deliberately narrow: a memory cites code, config or docs, never a `.png`. The
 * narrowing is also what keeps the walk small on a repository that is mostly
 * assets — the ComfyUI tree this was built against holds tens of thousands of
 * images and a few hundred source files.
 */
const INDEXED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.java', '.rb', '.php', '.cs', '.c', '.h', '.cpp',
  '.json', '.yml', '.yaml', '.toml', '.ini', '.cfg',
  '.md', '.txt', '.sql', '.sh', '.ps1', '.bat',
])

/** Directories that are never worth walking: vendored code, build output, VCS. */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules', '.git', '__pycache__', 'dist', 'build', 'out', 'target',
  '.venv', 'venv', '.next', '.cache', 'coverage', '.pytest_cache', 'site-packages',
])

/** A reference extracted from a memory's text. */
export interface FileReference {
  /** The token as written, e.g. `lib/director_graph.py:637-639`. */
  readonly raw: string
  /** The filename with no directory part. */
  readonly base: string
  /** The directory part as written, or empty. */
  readonly directory: string
  /** Line, or line range, cited — undefined when the memory cited none. */
  readonly lineStart?: number
  readonly lineEnd?: number
}

export interface FileEvidence {
  readonly reference: FileReference
  readonly status: 'found' | 'ambiguous' | 'missing' | 'unreadable'
  /** Project-relative path when `found`. */
  readonly path?: string
  /** Bytes on disk when `found`. */
  readonly bytes?: number
  /** Project-relative paths when `ambiguous` (bounded). */
  readonly candidates?: readonly string[]
  /**
   * The cited lines, trimmed, when `found` and a line was cited. Bounded to
   * {@link MAX_EVIDENCE_LINES} lines so one memory cannot blow the prompt.
   */
  readonly citedLines?: readonly string[]
  /** Why the read failed, when `unreadable`. */
  readonly detail?: string
}

/**
 * How deep the index walks.
 *
 * Six was one short for a real case: a memory cited `dreamer/classify.ts`, whose
 * file sits at `mc-upstream/packages/plugin/src/features/magic-context/dreamer/`
 * — seven levels below `C:/data/code` — so it read as missing while the file was
 * right there. Eight covers the usual monorepo shape (repo/packages/pkg/src/…)
 * with a level to spare, and the walk is still bounded by MAX_FILES.
 */
const MAX_DEPTH = 8
/** Ceiling on indexed files, so a pathological tree cannot stall a task. */
const MAX_FILES = 20_000
/** Lines of context pulled around a cited line. */
const MAX_EVIDENCE_LINES = 6
/** A cited file larger than this is summarised by size only — reading a 40 MB
 *  bundle to check one line would cost more than the verdict is worth. */
const MAX_READ_BYTES = 256 * 1024

/**
 * Pull file references out of a memory's text.
 *
 * The regex is intentionally conservative about what counts as a path: a
 * recognizable source extension with an optional `:line` or `:line-line` suffix.
 * No extension list, no reference — otherwise every `e.g.` and `i.e.` would be
 * treated as a filename and the evidence block would fill with noise the model
 * then has to ignore.
 */
export function extractFileReferences(content: string): FileReference[] {
  const pattern = /((?:[\w.\-]+\/)*[\w.\-]+\.([A-Za-z0-9]{1,6}))(?::(\d+)(?:-(\d+))?)?/g
  const out: FileReference[] = []
  const seen = new Set<string>()
  for (const match of content.matchAll(pattern)) {
    const raw = match[0]
    const pathPart = match[1] as string
    const extension = `.${(match[2] as string).toLowerCase()}`
    if (!INDEXED_EXTENSIONS.has(extension)) continue
    // The regex cannot see what came before the match, so a URL yields
    // `example.com/app.ts` rather than `https://example.com/app.ts`. Inspect the
    // preceding character instead: a path never starts right after `:` or `/`.
    const before = match.index === undefined || match.index === 0 ? '' : (content[match.index - 1] as string)
    if (before === ':' || before === '/') continue
    if (pathPart.startsWith('.')) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    const lineStart = match[3] === undefined ? undefined : Number(match[3])
    const lineEnd = match[4] === undefined ? lineStart : Number(match[4])
    const slash = pathPart.lastIndexOf('/')
    out.push({
      raw,
      base: slash < 0 ? pathPart : pathPart.slice(slash + 1),
      directory: slash < 0 ? '' : pathPart.slice(0, slash),
      ...lineStart === undefined ? {} : { lineStart },
      ...lineEnd === undefined ? {} : { lineEnd },
    })
  }
  return out
}

/** filename → project-relative paths. */
export type FileIndex = Map<string, string[]>

export interface BuildIndexResult {
  readonly index: FileIndex
  /** Files walked (indexed or not). */
  readonly scanned: number
  /** True when the walk stopped at {@link MAX_FILES}. */
  readonly truncated: boolean
}

/**
 * Walk `root` and index source files by filename.
 *
 * Filename-keyed rather than path-keyed because that is how memories cite: 179
 * of 493 live memories cite files, and almost all cite a bare `director.py`
 * rather than a full path. A path-keyed index would match nearly none of them.
 */
export function buildFileIndex(root: string, options: { maxDepth?: number; maxFiles?: number } = {}): BuildIndexResult {
  const index: FileIndex = new Map()
  const maxDepth = options.maxDepth ?? MAX_DEPTH
  const maxFiles = options.maxFiles ?? MAX_FILES
  let scanned = 0
  let truncated = false

  const walk = (directory: string, depth: number): void => {
    if (truncated || depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      // An unreadable directory (permissions, a vanished mount) ends that branch.
      return
    }
    for (const entry of entries) {
      if (truncated) return
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue
        walk(absolute, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      // Count INDEXABLE files, not every file.
      //
      // The ceiling exists to bound memory, and memory is spent on indexed
      // entries — a `.png` costs nothing and is skipped below. Counting it would
      // let a media-heavy tree exhaust the budget before the source was reached:
      // measured 2026-11-17 on this machine, `C:/data/code` stopped at 20,001
      // scanned with only 5,147 indexed, and `C:/data` (which holds a large
      // ComfyUI install) truncated the same way, so real source files were
      // silently absent from the index and read as `missing`.
      const extension = extname(entry.name).toLowerCase()
      if (!INDEXED_EXTENSIONS.has(extension)) continue
      scanned += 1
      if (scanned > maxFiles) {
        truncated = true
        return
      }
      const relativePath = relative(root, absolute).replace(/\\/g, '/')
      const existing = index.get(entry.name)
      if (existing === undefined) index.set(entry.name, [relativePath])
      // Bounded: a name matching dozens of files is already ambiguous, and the
      // evidence block only ever lists a handful.
      else if (existing.length < 8) existing.push(relativePath)
    }
  }

  walk(root, 0)
  return { index, scanned, truncated }
}

/** Read a bounded window of lines around `start`, centred when a range is given. */
function readCitedLines(absolute: string, start: number, end: number): { lines: string[] } | { detail: string } {
  try {
    const stats = statSync(absolute)
    if (!stats.isFile()) return { detail: 'not a regular file' }
    if (stats.size > MAX_READ_BYTES) return { detail: `file is ${String(stats.size)} bytes (over the read ceiling)` }
    const text = readFileSync(absolute, 'utf8')
    const all = text.split('\n')
    if (start <= 0 || start > all.length) {
      return { detail: `line ${String(start)} is past the end (the file has ${String(all.length)} lines)` }
    }
    // A range is clamped, never trusted: a memory citing `:1-99999` must not
    // pull the whole file into the prompt.
    const last = Math.min(Math.max(end, start), start + MAX_EVIDENCE_LINES - 1, all.length)
    const lines: string[] = []
    for (let number = start; number <= last; number += 1) {
      lines.push(`${String(number)}: ${(all[number - 1] ?? '').trim()}`)
    }
    return { lines }
  } catch (error) {
    return { detail: error instanceof Error ? error.message : String(error) }
  }
}

export interface GatherEvidenceOptions {
  /** Project root the index was built from. */
  readonly root: string
  /** Cap on references examined per memory. */
  readonly maxReferences?: number
}

/**
 * Resolve each reference against the index.
 *
 * A directory prefix narrows an ambiguous name when the index holds several:
 * `lib/director_graph.py` disambiguates against `nodes/director_graph.py`
 * without guessing, because the memory itself supplied the prefix.
 */
export function gatherEvidence(
  references: readonly FileReference[],
  index: FileIndex,
  options: GatherEvidenceOptions,
): FileEvidence[] {
  const out: FileEvidence[] = []
  const limit = options.maxReferences ?? 6
  for (const reference of references.slice(0, limit)) {
    const matches = index.get(reference.base)
    if (matches === undefined || matches.length === 0) {
      out.push({ reference, status: 'missing' })
      continue
    }
    let chosen: string | undefined
    if (matches.length === 1) chosen = matches[0]
    else if (reference.directory.length > 0) {
      // Prefer an indexed path that ENDS with the cited directory + name, which
      // is what the memory author saw when they wrote it. Only when exactly ONE
      // path matches: two projects sharing a `lib/director_graph.py` is still
      // ambiguous, and picking the first would be a coin flip dressed as
      // evidence.
      const suffix = `${reference.directory}/${reference.base}`
      const suffixMatches = matches.filter(path => path === suffix || path.endsWith(`/${suffix}`))
      if (suffixMatches.length === 1) chosen = suffixMatches[0]
    }
    if (chosen === undefined) {
      out.push({ reference, status: 'ambiguous', candidates: matches.slice(0, 5) })
      continue
    }
    const absolute = join(options.root, chosen)
    let bytes: number | undefined
    try {
      bytes = statSync(absolute).size
    } catch {
      out.push({ reference, status: 'missing' })
      continue
    }
    if (reference.lineStart === undefined) {
      out.push({ reference, status: 'found', path: chosen, ...bytes === undefined ? {} : { bytes } })
      continue
    }
    const cited = readCitedLines(absolute, reference.lineStart, reference.lineEnd ?? reference.lineStart)
    if ('detail' in cited) {
      out.push({
        reference, status: 'unreadable', path: chosen, detail: cited.detail,
        ...bytes === undefined ? {} : { bytes },
      })
      continue
    }
    out.push({
      reference, status: 'found', path: chosen, citedLines: cited.lines,
      ...bytes === undefined ? {} : { bytes },
    })
  }
  return out
}

/**
 * Render the evidence block appended to a verify prompt.
 *
 * Written as statements of fact, with no interpretation: the model is being told
 * what is on disk so it can judge, not told what verdict to reach. The one place
 * this module editorialises is `missing`, and only to the extent of naming it —
 * whether a vanished file makes a memory stale is still the model's call, since a
 * memory can legitimately cite a file that was renamed while its FACT stays true.
 */
export function renderEvidence(evidence: readonly FileEvidence[]): string {
  if (evidence.length === 0) return ''
  const lines: string[] = ['', 'Filesystem evidence (read from the project just now):']
  for (const item of evidence) {
    const cited = item.reference.raw
    if (item.status === 'found') {
      lines.push(`- ${cited}: FOUND at ${item.path ?? '?'}${item.bytes === undefined ? '' : ` (${String(item.bytes)} bytes)`}`)
      for (const line of item.citedLines ?? []) lines.push(`    ${line}`)
      continue
    }
    if (item.status === 'ambiguous') {
      lines.push(`- ${cited}: AMBIGUOUS — ${String(item.candidates?.length ?? 0)} files share that name: ${(item.candidates ?? []).join(', ')}`)
      continue
    }
    if (item.status === 'missing') {
      lines.push(`- ${cited}: NOT FOUND anywhere under the project`)
      continue
    }
    lines.push(`- ${cited}: found at ${item.path ?? '?'} but unreadable (${item.detail ?? 'unknown'})`)
  }
  return lines.join('\n')
}
