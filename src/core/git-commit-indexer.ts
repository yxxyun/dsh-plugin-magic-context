/**
 * Index a project's git history into the corpus.
 *
 * Composes the three pieces: read (`git-log.ts`), store (`git-commit-store.ts`),
 * and vectorise (`git-commit-search.ts`). Kept separate from all of them so the
 * read/store/search layers stay testable without touching git.
 *
 * ## Incremental by reachability, not by date
 *
 * A `--since` filter is the obvious incremental strategy and it is wrong here: a
 * branch merged today contains commits authored weeks ago, so a since-filter skips
 * exactly the commits that just became reachable. Instead the read excludes
 * everything reachable from the newest INDEXED sha (`^<sha>`), which returns
 * precisely what is new to the graph.
 *
 * ## Embedding is bounded per call
 *
 * The FTS lane works the moment a commit is stored; vectors only improve ranking.
 * So the indexer stores every commit it reads and embeds at most `embedLimit` of
 * them per call, letting a sweep converge over several ticks instead of blocking
 * on a model for a large history.
 */
import type { DatabaseSync } from 'node:sqlite'
import { readGitCommitsResult, type GitCommit } from './git-log.ts'
import {
  enforceProjectCap,
  getLatestIndexedCommitSha,
  upsertCommits,
  type StoredGitCommit,
} from './git-commit-store.ts'
import { saveCommitEmbedding, unembeddedCommits } from './git-commit-search.ts'

export interface IndexCommitsOptions {
  /** Corpus database. */
  readonly db: DatabaseSync
  /** Absolute project directory to read git history from. */
  readonly projectPath: string
  /** Opaque label for diagnostics; never the absolute path. */
  readonly projectIdentity?: string
  readonly now?: number
  /** Commits to read in this call. */
  readonly readLimit?: number
  /** Commits to embed in this call; 0 skips the embedding lane entirely. */
  readonly embedLimit?: number
  /** Embedding space; required for the embedding lane. */
  readonly modelId?: string
  readonly embed?: (texts: readonly string[]) => Promise<readonly Float32Array[]>
  /** Commits one project may keep before the oldest are evicted. */
  readonly cap?: number
  readonly log?: (message: string) => void
}

export interface IndexCommitsResult {
  readonly read: number
  readonly inserted: number
  readonly updated: number
  readonly embedded: number
  readonly evicted: number
  /** Present when the read failed structurally; see `GitLogFailureKind`. */
  readonly failure?: string
}

/**
 * One indexing pass for a project.
 *
 * Fail-open throughout: a directory that is not a repository, a missing git
 * binary, or an embedder that cannot load all leave the corpus unchanged and
 * report why. Indexing never fails the caller.
 *
 * @param options - database, project, limits, and embedder.
 */
export async function indexCommitsForProject(
  options: IndexCommitsOptions,
): Promise<IndexCommitsResult> {
  const now = options.now ?? Date.now()
  const log = options.log ?? (() => {})
  const db = options.db

  // Read only what became reachable since the newest indexed commit.
  const tip = getLatestIndexedCommitSha(db, options.projectPath)
  const read = await readGitCommitsResult(options.projectPath, {
    maxCommits: options.readLimit ?? 2_000,
    ...tip === undefined ? {} : { excludeReachableFrom: tip },
    ...options.projectIdentity === undefined ? {} : { projectIdentity: options.projectIdentity },
    log,
  })
  if (read.failure !== null) {
    return { read: 0, inserted: 0, updated: 0, embedded: 0, evicted: 0, failure: read.failure }
  }

  const commits: readonly GitCommit[] = read.commits
  const stored = commits.length === 0
    ? { inserted: 0, updated: 0 }
    : upsertCommits(db, options.projectPath, commits, now)

  const evicted = options.cap === undefined
    ? enforceProjectCap(db, options.projectPath)
    : enforceProjectCap(db, options.projectPath, options.cap)

  // Embedding lane: bounded, and skipped entirely when no embedder was supplied.
  let embedded = 0
  const embedLimit = options.embedLimit ?? 0
  if (embedLimit > 0 && options.embed !== undefined && options.modelId !== undefined) {
    const pending = unembeddedCommits(db, options.projectPath, options.modelId, embedLimit)
    if (pending.length > 0) {
      try {
        const vectors = await options.embed(pending.map(row => row.message))
        if (vectors.length === pending.length) {
          for (const [index, row] of pending.entries()) {
            const vector = vectors[index]
            if (vector === undefined || vector.length === 0) continue
            saveCommitEmbedding(db, row.sha, options.modelId, vector, now)
            embedded += 1
          }
        }
      } catch (error) {
        // A model failure costs ranking quality for this pass, nothing else.
        log(`[git-commits] embedding skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  return {
    read: commits.length,
    inserted: stored.inserted,
    updated: stored.updated,
    embedded,
    evicted,
  }
}

/** Re-export so callers need one import for the whole lane. */
export type { StoredGitCommit }
