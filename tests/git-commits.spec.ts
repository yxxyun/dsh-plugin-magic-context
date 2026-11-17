/**
 * Git commit lane: parsing, storage, and ranking.
 *
 * The parser is tested against the exact wire format because three details of it
 * were each a real production failure:
 *
 *  - separators are US/RS, never NUL (Node's execFile rejects argv with NUL);
 *  - only the first four separators are taken (a body may contain `\x1f`, and
 *    `split(sep, n)` caps the ARRAY, silently truncating the body);
 *  - a record whose SHA is not a full object name is dropped (a partial line
 *    would otherwise enter the index with a sha that cannot be looked up).
 *
 * Storage is tested on eviction-by-commit-time and the conditional upsert, and
 * ranking on the merge of the FTS and semantic lanes.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classifyGitLogFailure, parseGitLogOutput } from '../src/core/git-log.ts'
import {
  enforceProjectCap,
  getCommitCount,
  getLatestIndexedCommitSha,
  getLatestIndexedCommitTimeMs,
  GIT_COMMIT_DDL,
  upsertCommits,
} from '../src/core/git-commit-store.ts'
import {
  sanitizeCommitFtsQuery,
  saveCommitEmbedding,
  searchGitCommits,
  unembeddedCommits,
} from '../src/core/git-commit-search.ts'

const US = '\x1f'
const RS = '\x1e'
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)

function record(sha: string, subject: string, author: string, seconds: number, body = ''): string {
  return `${sha}${US}${subject}${US}${author}${US}${String(seconds)}${US}${body}${RS}`
}

describe('parseGitLogOutput', () => {
  it('parses a single record', () => {
    const commits = parseGitLogOutput(record(SHA_A, 'fix: the thing', 'dev@x.test', 1_700_000_000))
    expect(commits).toHaveLength(1)
    expect(commits[0]).toEqual({
      sha: SHA_A,
      shortSha: 'aaaaaaa',
      message: 'fix: the thing',
      author: 'dev@x.test',
      committedAtMs: 1_700_000_000_000,
    })
  })

  it('joins subject and body with a blank line', () => {
    const commits = parseGitLogOutput(
      record(SHA_A, 'subject here', 'd@x', 1_700_000_000, 'body line one\nbody line two'),
    )
    expect(commits[0]!.message).toBe('subject here\n\nbody line one\nbody line two')
  })

  it('keeps a field separator that appears inside the body', () => {
    // A body containing \x1f must not truncate: this is why the split is manual
    // and limited to four separators rather than String.split(sep, 5).
    const body = `before${US}after`
    const commits = parseGitLogOutput(record(SHA_A, 'subj', 'd@x', 1_700_000_000, body))
    expect(commits[0]!.message).toContain('before\x1fafter')
  })

  it('parses several records', () => {
    const out = record(SHA_A, 'one', 'a@x', 1_700_000_000) + record(SHA_B, 'two', 'b@x', 1_700_000_100)
    expect(parseGitLogOutput(out).map(c => c.shortSha)).toEqual(['aaaaaaa', 'bbbbbbb'])
  })

  it('drops a record whose SHA is not a full object name', () => {
    // A truncated read would otherwise index a sha that cannot be looked up.
    expect(parseGitLogOutput(record('abc123', 'short sha', 'a@x', 1_700_000_000))).toEqual([])
  })

  it('accepts a 64-character SHA-256 object name', () => {
    const sha256 = 'd'.repeat(64)
    expect(parseGitLogOutput(record(sha256, 'sha256 repo', 'a@x', 1_700_000_000))).toHaveLength(1)
  })

  it('drops a record with a non-positive time', () => {
    expect(parseGitLogOutput(record(SHA_A, 's', 'a@x', 0))).toEqual([])
  })

  it('returns null author for an empty author field', () => {
    expect(parseGitLogOutput(record(SHA_A, 's', '', 1_700_000_000))[0]!.author).toBeNull()
  })

  it('tolerates leading whitespace between records', () => {
    const out = `\n  ${record(SHA_A, 's', 'a@x', 1_700_000_000)}`
    expect(parseGitLogOutput(out)).toHaveLength(1)
  })

  it('returns empty for empty output', () => {
    expect(parseGitLogOutput('')).toEqual([])
  })
})

describe('classifyGitLogFailure', () => {
  it('separates structural failures from transient ones', () => {
    // Structural: retrying every tick cannot help.
    expect(classifyGitLogFailure('fatal: not a git repository (or any parent)')).toBe('not_a_repo')
    expect(classifyGitLogFailure('fatal: your current branch has no commits yet')).toBe('no_head')
    expect(classifyGitLogFailure("fatal: bad revision 'HEAD'")).toBe('no_head')
    // Transient: a later tick may succeed.
    expect(classifyGitLogFailure('spawn git ENOENT')).toBe('transient')
    expect(classifyGitLogFailure('timeout')).toBe('transient')
  })
})

describe('sanitizeCommitFtsQuery', () => {
  it('quotes tokens and joins with AND', () => {
    expect(sanitizeCommitFtsQuery('fix parser bug')).toBe('"fix" AND "parser" AND "bug"')
  })

  it('strips FTS syntax that would be a parse error', () => {
    // A raw `col:value` or a dangling `*` is a syntax error in FTS5, not an
    // empty result, so the lane would fail rather than fall back to LIKE.
    for (const query of ['col:value', 'fix*', '"unbalanced', 'a OR b', 'NOT x']) {
      const sanitized = sanitizeCommitFtsQuery(query)
      expect(sanitized).not.toContain(':')
      expect(sanitized).not.toContain('*')
      expect((sanitized.match(/"/g) ?? []).length % 2).toBe(0)
    }
  })

  it('returns empty when there is nothing to search', () => {
    expect(sanitizeCommitFtsQuery('   ')).toBe('')
    expect(sanitizeCommitFtsQuery('!!!')).toBe('')
  })

  it('keeps CJK runs as single tokens', () => {
    expect(sanitizeCommitFtsQuery('修复 解析器')).toBe('"修复" AND "解析器"')
  })
})

let dir: string
let db: DatabaseSync
const PROJECT = 'C:/work/proj'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mc-gitc-'))
  db = new DatabaseSync(join(dir, 'corpus.db'))
  db.exec('CREATE TABLE memories(id INTEGER PRIMARY KEY, content TEXT);')
  db.exec(GIT_COMMIT_DDL)
})

afterEach(() => {
  try { db.close() } catch { /* closed */ }
  rmSync(dir, { recursive: true, force: true })
})

function commit(sha: string, message: string, ms: number) {
  return { sha, shortSha: sha.slice(0, 7), message, author: 'a@x', committedAtMs: ms }
}

describe('upsertCommits', () => {
  it('inserts new commits and counts them', () => {
    const result = upsertCommits(db, PROJECT, [
      commit(SHA_A, 'first', 1_700_000_000_000),
      commit(SHA_B, 'second', 1_700_000_100_000),
    ], 1_800_000_000_000)
    expect(result).toEqual({ inserted: 2, updated: 0 })
    expect(getCommitCount(db, PROJECT)).toBe(2)
  })

  it('treats a re-index of an unchanged commit as a no-op', () => {
    upsertCommits(db, PROJECT, [commit(SHA_A, 'first', 1_700_000_000_000)], 1_800_000_000_000)
    // The conditional upsert exists so the FTS triggers do not fire on every
    // sweep for content that did not change.
    const again = upsertCommits(db, PROJECT, [commit(SHA_A, 'first', 1_700_000_000_000)], 1_900_000_000_000)
    expect(again).toEqual({ inserted: 0, updated: 0 })
  })

  it('counts an amended message as an update', () => {
    upsertCommits(db, PROJECT, [commit(SHA_A, 'first', 1_700_000_000_000)], 1_800_000_000_000)
    const amended = upsertCommits(db, PROJECT, [commit(SHA_A, 'first, reworded', 1_700_000_000_000)], 1_900_000_000_000)
    expect(amended).toEqual({ inserted: 0, updated: 1 })
  })

  it('mirrors into the FTS index through the triggers', () => {
    upsertCommits(db, PROJECT, [commit(SHA_A, 'parser bug fixed', 1_700_000_000_000)], 1_800_000_000_000)
    const rows = db.prepare("SELECT sha FROM git_commits_fts WHERE git_commits_fts MATCH ?")
      .all('"parser"') as Array<{ sha: string }>
    expect(rows.map(row => row.sha)).toEqual([SHA_A])
  })

  it('replaces the FTS row when a message is amended', () => {
    upsertCommits(db, PROJECT, [commit(SHA_A, 'alpha token', 1_700_000_000_000)], 1_800_000_000_000)
    upsertCommits(db, PROJECT, [commit(SHA_A, 'beta token', 1_700_000_000_000)], 1_900_000_000_000)
    const stale = db.prepare("SELECT sha FROM git_commits_fts WHERE git_commits_fts MATCH ?")
      .all('"alpha"') as Array<{ sha: string }>
    expect(stale).toEqual([])
  })
})

describe('enforceProjectCap', () => {
  it('evicts the OLDEST by commit time, not by index time', () => {
    // All three are indexed in the same pass, so indexed_at is identical; only
    // committed_at can order them. Evicting by indexed_at would delete arbitrary
    // history instead of the oldest.
    upsertCommits(db, PROJECT, [
      commit(SHA_A, 'oldest', 1_000),
      commit(SHA_B, 'middle', 2_000),
      commit(SHA_C, 'newest', 3_000),
    ], 9_999)
    expect(enforceProjectCap(db, PROJECT, 2)).toBe(1)
    const remaining = db.prepare('SELECT sha FROM git_commits ORDER BY committed_at')
      .all() as Array<{ sha: string }>
    expect(remaining.map(row => row.sha)).toEqual([SHA_B, SHA_C])
  })

  it('does nothing when the project fits', () => {
    upsertCommits(db, PROJECT, [commit(SHA_A, 'one', 1_000)], 9_999)
    expect(enforceProjectCap(db, PROJECT, 10)).toBe(0)
  })
})

describe('latest indexed pointers', () => {
  it('reports the newest commit time and sha', () => {
    upsertCommits(db, PROJECT, [
      commit(SHA_A, 'old', 1_000),
      commit(SHA_B, 'new', 5_000),
    ], 9_999)
    expect(getLatestIndexedCommitTimeMs(db, PROJECT)).toBe(5_000)
    // The sha becomes the next read's excludeReachableFrom.
    expect(getLatestIndexedCommitSha(db, PROJECT)).toBe(SHA_B)
  })

  it('reports undefined for a project with no commits', () => {
    expect(getLatestIndexedCommitTimeMs(db, 'C:/other')).toBeUndefined()
    expect(getLatestIndexedCommitSha(db, 'C:/other')).toBeUndefined()
  })
})

describe('searchGitCommits', () => {
  beforeEach(() => {
    upsertCommits(db, PROJECT, [
      commit(SHA_A, 'fix: the parser dropped separators', 1_700_000_000_000),
      commit(SHA_B, 'feat: add the dashboard route', 1_700_100_000_000),
      commit(SHA_C, 'docs: mention the parser in the readme', 1_700_200_000_000),
    ], 1_800_000_000_000)
  })

  it('finds by FTS and marks the match type', () => {
    const hits = searchGitCommits(db, PROJECT, 'parser', { limit: 10 })
    expect(hits.length).toBe(2)
    expect(hits.every(hit => hit.matchType === 'fts')).toBe(true)
    expect(hits.map(hit => hit.sha).sort()).toEqual([SHA_A, SHA_C].sort())
  })

  it('falls back to a substring match when FTS finds nothing', () => {
    // FTS tokenises, so a fragment inside a token matches nothing. The LIKE
    // fallback is what makes a short query work.
    const hits = searchGitCommits(db, PROJECT, 'ashbo', { limit: 10 })
    expect(hits.map(hit => hit.sha)).toEqual([SHA_B])
  })

  it('honours the project scope', () => {
    expect(searchGitCommits(db, 'C:/elsewhere', 'parser', { limit: 10 })).toEqual([])
  })

  it('honours a date range', () => {
    const hits = searchGitCommits(db, PROJECT, 'parser', {
      limit: 10,
      from: 1_700_150_000_000,
    })
    expect(hits.map(hit => hit.sha)).toEqual([SHA_C])
  })

  it('adds a semantic lane and prefers hybrid matches', () => {
    // A vector aligned with an axis the query vector shares makes SHA_B hybrid:
    // it is found by FTS (the LIKE fallback) AND by cosine.
    saveCommitEmbedding(db, SHA_B, 'm1', Float32Array.from([1, 0, 0]), 1_800_000_000_000)
    const hits = searchGitCommits(db, PROJECT, 'dashboard', {
      limit: 10,
      queryEmbedding: Float32Array.from([1, 0, 0]),
      queryModelId: 'm1',
    })
    const hit = hits.find(entry => entry.sha === SHA_B)
    expect(hit?.matchType).toBe('hybrid')
  })

  it('returns semantic-only matches with the penalty applied', () => {
    // SHA_A is found by neither FTS nor LIKE for this query, only by cosine.
    saveCommitEmbedding(db, SHA_A, 'm1', Float32Array.from([0, 1, 0]), 1_800_000_000_000)
    const hits = searchGitCommits(db, PROJECT, 'zzz-no-text-match', {
      limit: 10,
      queryEmbedding: Float32Array.from([0, 1, 0]),
      queryModelId: 'm1',
    })
    const hit = hits.find(entry => entry.sha === SHA_A)
    expect(hit?.matchType).toBe('semantic')
    expect(hit!.score).toBeLessThanOrEqual(1)
  })

  it('returns empty for an empty query or a zero limit', () => {
    expect(searchGitCommits(db, PROJECT, '   ', { limit: 10 })).toEqual([])
    expect(searchGitCommits(db, PROJECT, 'parser', { limit: 0 })).toEqual([])
  })
})

describe('unembeddedCommits', () => {
  it('lists only the commits without a vector in the given space', () => {
    upsertCommits(db, PROJECT, [
      commit(SHA_A, 'one', 1_000),
      commit(SHA_B, 'two', 2_000),
    ], 9_999)
    saveCommitEmbedding(db, SHA_A, 'm1', Float32Array.from([1, 0]), 9_999)
    const pending = unembeddedCommits(db, PROJECT, 'm1', 10)
    expect(pending.map(row => row.sha)).toEqual([SHA_B])
    // A different space knows nothing, so both are pending there.
    expect(unembeddedCommits(db, PROJECT, 'm2', 10)).toHaveLength(2)
  })
})
