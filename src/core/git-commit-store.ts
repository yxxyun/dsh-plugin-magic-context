/**
 * SQLite storage for indexed git commits.
 *
 * Ported from upstream `git-commits/storage-git-commits.ts` (193 lines) plus the
 * table shapes from its migration v4. Three tables, and the split is deliberate:
 *
 *  - `git_commits` — the commit itself, keyed by SHA. Identity is the SHA, not a
 *    row id, because git owns the lifecycle: a rebase rewrites SHAs, and an
 *    amended commit must replace rather than accumulate.
 *  - `git_commit_embeddings` — one vector per SHA, separate from memory vectors so
 *    a commit query never competes with memory rows for the same space.
 *  - `git_commits_fts` — its own FTS index, so commit matches never enter the
 *    memory BM25 rank.
 *
 * ## Eviction is by COMMIT time, not index time
 *
 * When a project exceeds its commit cap, the oldest rows by `committed_at` go
 * first. `indexed_at` would be wrong: after a long absence the indexer catches up
 * in one sweep and every row gets nearly the same `indexed_at`, so evicting by it
 * would delete arbitrary history instead of the oldest history.
 *
 * ## The upsert is conditional
 *
 * `ON CONFLICT ... WHERE git_commits.message != excluded.message` makes a re-index
 * of an unchanged commit a no-op, which keeps the FTS triggers from firing on
 * every sweep. Without the guard the FTS table would be rewritten wholesale each
 * cycle for no change in content.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { GitCommit } from './git-log.ts'

/** A commit as stored, with the project it belongs to and when it was indexed. */
export interface StoredGitCommit extends GitCommit {
  readonly projectPath: string
  readonly indexedAtMs: number
}

/** How many commits one project may keep; the oldest by commit time are evicted. */
export const DEFAULT_PROJECT_COMMIT_CAP = 5_000

/**
 * DDL for the three tables plus the FTS triggers.
 *
 * `IF NOT EXISTS` throughout so it can run on every mount; the triggers are what
 * keep FTS in step, and they are created with the table.
 */
export const GIT_COMMIT_DDL = `
  CREATE TABLE IF NOT EXISTS git_commits (
    sha TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    short_sha TEXT NOT NULL,
    message TEXT NOT NULL,
    author TEXT,
    committed_at INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_git_commits_project_time
    ON git_commits(project_path, committed_at DESC);

  CREATE TABLE IF NOT EXISTS git_commit_embeddings (
    sha TEXT PRIMARY KEY,
    embedding BLOB NOT NULL,
    model_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS git_commits_fts USING fts5(
    sha UNINDEXED,
    project_path UNINDEXED,
    message,
    tokenize = 'porter unicode61'
  );

  -- Mirror writes into FTS. A row is rebuilt on every insert so an amended
  -- commit message replaces the old text rather than adding a second entry.
  CREATE TRIGGER IF NOT EXISTS git_commits_fts_insert
  AFTER INSERT ON git_commits BEGIN
    DELETE FROM git_commits_fts WHERE sha = NEW.sha;
    INSERT INTO git_commits_fts(sha, project_path, message)
    VALUES (NEW.sha, NEW.project_path, NEW.message);
  END;

  CREATE TRIGGER IF NOT EXISTS git_commits_fts_delete
  AFTER DELETE ON git_commits BEGIN
    DELETE FROM git_commits_fts WHERE sha = OLD.sha;
  END;

  CREATE TRIGGER IF NOT EXISTS git_commits_fts_update
  AFTER UPDATE OF message, project_path ON git_commits BEGIN
    DELETE FROM git_commits_fts WHERE sha = OLD.sha;
    INSERT INTO git_commits_fts(sha, project_path, message)
    VALUES (NEW.sha, NEW.project_path, NEW.message);
  END;
`

/**
 * Insert or refresh commits for one project.
 *
 * Returns how many rows actually changed; an unchanged commit counts as neither
 * inserted nor updated, so the caller can tell "caught up, nothing new" from
 * "indexed N commits".
 *
 * @param db - the corpus database.
 * @param projectPath - the project these commits belong to.
 * @param commits - commits in any order; the store sorts nothing.
 * @param now - index timestamp.
 */
export function upsertCommits(
  db: DatabaseSync,
  projectPath: string,
  commits: readonly GitCommit[],
  now: number,
): { inserted: number; updated: number } {
  const existing = new Set(
    (db.prepare('SELECT sha FROM git_commits WHERE project_path = ?').all(projectPath) as Array<{ sha: string }>)
      .map(row => row.sha),
  )
  const insert = db.prepare(
    `INSERT INTO git_commits (sha, project_path, short_sha, message, author, committed_at, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sha) DO UPDATE SET
       project_path = excluded.project_path,
       short_sha = excluded.short_sha,
       message = excluded.message,
       author = excluded.author,
       committed_at = excluded.committed_at,
       indexed_at = excluded.indexed_at
     WHERE git_commits.message != excluded.message`,
  )

  let inserted = 0
  let updated = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const commit of commits) {
      const known = existing.has(commit.sha)
      const result = insert.run(
        commit.sha,
        projectPath,
        commit.shortSha,
        commit.message,
        commit.author,
        commit.committedAtMs,
        now,
      )
      if (Number(result.changes) === 0) continue
      if (known) updated += 1
      else inserted += 1
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { inserted, updated }
}

/** How many commits a project has indexed. */
export function getCommitCount(db: DatabaseSync, projectPath: string): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM git_commits WHERE project_path = ?')
    .get(projectPath) as { count: number }
  return row.count
}

/**
 * Delete the oldest commits of a project until it fits `cap`.
 *
 * Oldest by COMMIT time, not index time — see the module header.
 *
 * @returns how many rows were evicted.
 */
export function enforceProjectCap(
  db: DatabaseSync,
  projectPath: string,
  cap: number = DEFAULT_PROJECT_COMMIT_CAP,
): number {
  if (cap <= 0) return 0
  const result = db.prepare(
    `DELETE FROM git_commits
      WHERE rowid IN (
        SELECT rowid FROM git_commits
         WHERE project_path = ?
         ORDER BY committed_at DESC, sha DESC
         LIMIT -1 OFFSET ?
      )`,
  ).run(projectPath, cap)
  return Number(result.changes)
}

/** Newest indexed commit time for a project, or undefined when nothing is indexed. */
export function getLatestIndexedCommitTimeMs(
  db: DatabaseSync,
  projectPath: string,
): number | undefined {
  const row = db.prepare('SELECT MAX(committed_at) AS latest FROM git_commits WHERE project_path = ?')
    .get(projectPath) as { latest: number | null } | undefined
  const value = row?.latest
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * The SHA of the newest indexed commit for a project.
 *
 * Used as the incremental read's `excludeReachableFrom`: reading `^<this sha>`
 * returns exactly what became reachable since — including commits on a merged
 * branch whose own dates are older than anything indexed, which a `--since`
 * filter would miss.
 */
export function getLatestIndexedCommitSha(
  db: DatabaseSync,
  projectPath: string,
): string | undefined {
  const row = db.prepare(
    'SELECT sha FROM git_commits WHERE project_path = ? ORDER BY committed_at DESC, sha DESC LIMIT 1',
  ).get(projectPath) as { sha: string } | undefined
  return row?.sha
}

/** Every indexed SHA for a project, as a set. */
export function indexedShas(db: DatabaseSync, projectPath: string): Set<string> {
  const rows = db.prepare('SELECT sha FROM git_commits WHERE project_path = ?')
    .all(projectPath) as Array<{ sha: string }>
  return new Set(rows.map(row => row.sha))
}
