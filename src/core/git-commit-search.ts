/**
 * Hybrid FTS + semantic search over indexed git commits.
 *
 * Ported from upstream `git-commits/search-git-commits.ts` (334 lines). The
 * scoring constants are kept: semantic 0.7 / FTS 0.3, a single-source penalty of
 * 0.8, and FTS rank turned into `1/(rank+1)`. Those numbers are shared with the
 * memory lane, so a commit hit and a memory hit are comparable when the unified
 * search merges them.
 *
 * Two behaviours that are easy to lose in a port and matter in practice:
 *
 *  - **The LIKE fallback.** FTS5 tokenises, so a query of two or three characters,
 *    or an exact substring that straddles tokens (`hist` inside `history`), matches
 *    nothing. Falling back to `LIKE '%…%'` on an empty FTS result is what makes
 *    short queries work at all.
 *  - **A commit can arrive from either lane.** The FTS pass returns rows; the
 *    semantic pass returns SHAs. Semantic-only SHAs need their metadata fetched,
 *    and a commit present in both must not be counted twice.
 *
 * Date bounds apply to both lanes. `committed_at` is the commit's own time, which
 * is what a user means by "when did this change".
 */
import type { DatabaseSync } from 'node:sqlite'
import { cosineScore } from './vector-math.ts'
import type { GitCommit } from './git-log.ts'

/** Weights shared with the memory lane so merged rankings stay comparable. */
const SEMANTIC_WEIGHT = 0.7
const FTS_WEIGHT = 0.3
const SINGLE_SOURCE_PENALTY = 0.8

/** A scored commit match. */
export interface GitCommitHit {
  readonly sha: string
  readonly shortSha: string
  readonly message: string
  readonly author: string | null
  readonly committedAtMs: number
  readonly score: number
  readonly matchType: 'hybrid' | 'fts' | 'semantic'
}

export interface SearchGitCommitsOptions {
  readonly limit: number
  /** Inclusive epoch-ms bounds on the commit time. */
  readonly from?: number
  readonly to?: number
  /** Query vector; omitted when the embedder is unavailable. */
  readonly queryEmbedding?: Float32Array | null
  readonly queryModelId?: string | null
  readonly semanticWeight?: number
  readonly ftsWeight?: number
  readonly singleSourcePenalty?: number
}

interface CommitRow {
  sha: string
  short_sha: string
  message: string
  author: string | null
  committed_at: number
}

/**
 * Turn free text into a safe FTS5 query.
 *
 * FTS5 treats `"`, `*`, `:`, `(`, `)`, `-` and the boolean keywords as syntax, so
 * a raw user query can be a syntax error rather than an empty result. Tokens are
 * reduced to alphanumerics and joined with AND; an empty result means the caller
 * falls back to LIKE.
 *
 * @param query - the raw query.
 */
export function sanitizeCommitFtsQuery(query: string): string {
  const tokens = query
    .split(/[^\p{L}\p{N}_]+/u)
    .map(token => token.trim())
    .filter(token => token.length > 0)
  if (tokens.length === 0) return ''
  return tokens.map(token => `"${token.replaceAll('"', '')}"`).join(' AND ')
}

/** Escape LIKE metacharacters so a literal `%` or `_` does not widen the match. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, character => `\\${character}`)
}

function rowToCommit(row: CommitRow): GitCommit {
  return {
    sha: row.sha,
    shortSha: row.short_sha,
    message: row.message,
    author: row.author,
    committedAtMs: row.committed_at,
  }
}

/**
 * Search a project's indexed commits.
 *
 * @param db - the corpus database.
 * @param projectPath - the project to search within.
 * @param query - the raw query.
 * @param options - limit, date bounds, and the query vector when available.
 * @returns scored hits, best first.
 */
export function searchGitCommits(
  db: DatabaseSync,
  projectPath: string,
  query: string,
  options: SearchGitCommitsOptions,
): GitCommitHit[] {
  const trimmed = query.trim()
  if (trimmed.length === 0 || options.limit <= 0) return []

  const semanticWeight = options.semanticWeight ?? SEMANTIC_WEIGHT
  const ftsWeight = options.ftsWeight ?? FTS_WEIGHT
  const penalty = options.singleSourcePenalty ?? SINGLE_SOURCE_PENALTY
  const fetchLimit = Math.max(options.limit * 3, 30)
  const hasBounds = options.from !== undefined || options.to !== undefined
  const from = options.from ?? Number.MIN_SAFE_INTEGER
  const to = options.to ?? Number.MAX_SAFE_INTEGER
  const bounds = hasBounds ? ' AND committed_at >= ? AND committed_at <= ?' : ''
  const boundParams = hasBounds ? [from, to] : []

  // ---- FTS pass ---------------------------------------------------------
  const bySha = new Map<string, GitCommit>()
  const ftsOrder: string[] = []
  const sanitized = sanitizeCommitFtsQuery(trimmed)
  if (sanitized.length > 0) {
    try {
      const rows = db.prepare(
        `SELECT c.sha, c.short_sha, c.message, c.author, c.committed_at
           FROM git_commits_fts f
           JOIN git_commits c ON c.sha = f.sha
          WHERE f.project_path = ? AND f.git_commits_fts MATCH ?${bounds}
          ORDER BY rank
          LIMIT ?`,
      ).all(projectPath, sanitized, ...boundParams, fetchLimit) as unknown as CommitRow[]
      for (const row of rows) {
        if (!bySha.has(row.sha)) ftsOrder.push(row.sha)
        bySha.set(row.sha, rowToCommit(row))
      }
    } catch {
      // A malformed MATCH is not fatal: the LIKE fallback below still runs, and it
      // accepts any literal text.
    }
  }

  // ---- LIKE fallback ----------------------------------------------------
  if (bySha.size === 0) {
    const rows = db.prepare(
      `SELECT sha, short_sha, message, author, committed_at
         FROM git_commits
        WHERE project_path = ? AND message LIKE ? ESCAPE '\\'${bounds}
        ORDER BY committed_at DESC
        LIMIT ?`,
    ).all(projectPath, `%${escapeLikePattern(trimmed)}%`, ...boundParams, fetchLimit) as unknown as CommitRow[]
    for (const row of rows) {
      if (!bySha.has(row.sha)) ftsOrder.push(row.sha)
      bySha.set(row.sha, rowToCommit(row))
    }
  }

  // ---- Semantic pass ----------------------------------------------------
  const semanticScores = new Map<string, number>()
  const vector = options.queryEmbedding ?? null
  const modelId = options.queryModelId ?? null
  if (vector !== null && modelId !== null && modelId !== 'off') {
    for (const [sha, embedding] of loadCommitEmbeddings(db, projectPath, modelId)) {
      const score = cosineScore(vector, embedding)
      if (score > 0) semanticScores.set(sha, score)
    }
  }

  // Semantic-only SHAs still need their metadata; fetch it in one statement.
  const semanticOnly = [...semanticScores.keys()].filter(sha => !bySha.has(sha))
  if (semanticOnly.length > 0) {
    const placeholders = semanticOnly.map(() => '?').join(', ')
    const rows = db.prepare(
      `SELECT sha, short_sha, message, author, committed_at
         FROM git_commits
        WHERE project_path = ? AND sha IN (${placeholders})${bounds}`,
    ).all(projectPath, ...semanticOnly, ...boundParams) as unknown as CommitRow[]
    for (const row of rows) bySha.set(row.sha, rowToCommit(row))
  }

  // ---- Merge and rank ---------------------------------------------------
  const ftsScores = new Map<string, number>()
  ftsOrder.forEach((sha, rank) => ftsScores.set(sha, 1 / (rank + 1)))

  const hits: GitCommitHit[] = []
  for (const [sha, commit] of bySha) {
    const fts = ftsScores.get(sha)
    const semantic = semanticScores.get(sha)
    let score: number
    let matchType: GitCommitHit['matchType']
    if (semantic !== undefined && fts !== undefined) {
      score = semanticWeight * semantic + ftsWeight * fts
      matchType = 'hybrid'
    } else if (semantic !== undefined) {
      score = semantic * penalty
      matchType = 'semantic'
    } else if (fts !== undefined) {
      score = fts * penalty
      matchType = 'fts'
    } else {
      continue
    }
    if (score <= 0) continue
    hits.push({
      sha,
      shortSha: commit.shortSha,
      message: commit.message,
      author: commit.author,
      committedAtMs: commit.committedAtMs,
      score,
      matchType,
    })
  }
  hits.sort((left, right) => right.score - left.score || left.sha.localeCompare(right.sha))
  return hits.slice(0, options.limit)
}

/** Read every stored commit vector for a project in one space. */
function loadCommitEmbeddings(
  db: DatabaseSync,
  projectPath: string,
  modelId: string,
): Map<string, Float32Array> {
  const rows = db.prepare(
    `SELECT e.sha, e.embedding
       FROM git_commit_embeddings e
       JOIN git_commits c ON c.sha = e.sha
      WHERE c.project_path = ? AND e.model_id = ?`,
  ).all(projectPath, modelId) as Array<{ sha: string; embedding: Uint8Array }>
  const out = new Map<string, Float32Array>()
  for (const row of rows) {
    const vector = new Float32Array(row.embedding.byteLength / 4)
    // Copy: the buffer belongs to the statement result and is freed by the next
    // query, so holding a view would read released memory.
    new Uint8Array(vector.buffer).set(row.embedding)
    out.set(row.sha, vector)
  }
  return out
}

/** Store one commit's vector. */
export function saveCommitEmbedding(
  db: DatabaseSync,
  sha: string,
  modelId: string,
  vector: Float32Array,
  now: number,
): void {
  db.prepare(
    `INSERT INTO git_commit_embeddings(sha, embedding, model_id, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(sha) DO UPDATE SET
       embedding = excluded.embedding,
       model_id = excluded.model_id,
       created_at = excluded.created_at`,
  ).run(sha, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), modelId, now)
}

/** Which commits in a project still lack a vector in this space. */
export function unembeddedCommits(
  db: DatabaseSync,
  projectPath: string,
  modelId: string,
  limit: number,
): Array<{ sha: string; message: string }> {
  return db.prepare(
    `SELECT c.sha, c.message
       FROM git_commits c
       LEFT JOIN git_commit_embeddings e ON e.sha = c.sha AND e.model_id = ?
      WHERE c.project_path = ? AND e.sha IS NULL
      ORDER BY c.committed_at DESC
      LIMIT ?`,
  ).all(modelId, projectPath, Math.max(1, limit)) as Array<{ sha: string; message: string }>
}

/** How many commits of a project have a vector in this space. */
export function countEmbeddedCommits(
  db: DatabaseSync,
  projectPath: string,
  modelId: string,
): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS count
       FROM git_commit_embeddings e
       JOIN git_commits c ON c.sha = e.sha
      WHERE c.project_path = ? AND e.model_id = ?`,
  ).get(projectPath, modelId) as { count: number }
  return row.count
}
