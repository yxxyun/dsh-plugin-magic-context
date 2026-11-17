/**
 * Primer storage: "reusable project Q&A distilled from recurring questions".
 *
 * A primer is what a project keeps answering. Two tables, and the split is the
 * whole design:
 *
 *  - `primer_candidates` — one row per OBSERVED question occurrence. Cheap to
 *    write, never deduplicated by text, because the same question asked in two
 *    sessions is exactly the evidence a primer needs.
 *  - `primers` — a promoted question with an answer. Created only when the
 *    clustering says an occurrence pattern is real (see `primer-cluster.ts`).
 *
 * ## The unique key is an occurrence identity, not the question text
 *
 * `UNIQUE(project_path, harness, session_id, source_start_message_id,
 * source_end_message_id)` makes re-indexing the same span idempotent while
 * letting the same words appear in many rows. A text-based unique key would
 * collapse the evidence that a question recurs, which is the only signal that a
 * primer is worth writing.
 *
 * ## Upserts keep the earliest creation time and any existing vector
 *
 * `created_at = MIN(...)` and `COALESCE(excluded.question_embedding, old)`: a
 * re-index must not move a candidate's age forward (age drives expiry) and must
 * not erase a vector computed by a earlier pass when this pass had no embedder.
 *
 * Ported from upstream `storage-primers.ts` (573 lines), minus the dreamer-side
 * promotion flow: this adapter has no dreamer, so promotion is driven by the
 * cluster helpers in `primer-cluster.ts` and the manual write path in
 * `ctx_memory`-style tooling rather than a nightly task.
 */
import type { DatabaseSync } from 'node:sqlite'

/** Candidates older than this stop counting as support. */
export const PRIMER_CANDIDATE_TTL_MS = 90 * 24 * 60 * 60 * 1000
/** Candidates older than this are pruned outright. */
export const PRIMER_CANDIDATE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000

/** One observed question, as evidence for a future primer. */
export interface PrimerCandidateInput {
  readonly projectPath: string
  /** Harness that observed it; distinguishes DSH from any other client. */
  readonly harness: string
  readonly sessionId: string
  readonly question: string
  readonly normalizedQuestion?: string
  readonly sourceCompartmentStart?: number | null
  readonly sourceCompartmentEnd?: number | null
  readonly sourceStartMessageId: string
  readonly sourceEndMessageId: string
  readonly sourceMessageTime: number
  readonly questionEmbedding?: Float32Array | null
  readonly questionEmbeddingModelId?: string | null
  readonly createdAt?: number
}

/** A stored candidate. */
export interface PrimerCandidate {
  readonly id: number
  readonly projectPath: string
  readonly harness: string
  readonly sessionId: string
  readonly question: string
  readonly normalizedQuestion: string
  readonly sourceCompartmentStart: number | null
  readonly sourceCompartmentEnd: number | null
  readonly sourceStartMessageId: string
  readonly sourceEndMessageId: string
  readonly sourceMessageTime: number
  readonly questionEmbedding: Float32Array | null
  readonly questionEmbeddingModelId: string | null
  readonly createdAt: number
}

/** Where a primer's evidence came from, kept so a stale primer can be re-derived. */
export interface PrimerSourceProvenance {
  readonly candidateId: number
  readonly projectPath: string
  readonly harness: string
  readonly sessionId: string
  readonly sourceCompartmentStart: number | null
  readonly sourceCompartmentEnd: number | null
  readonly sourceStartMessageId: string
  readonly sourceEndMessageId: string
}

/** A promoted question with its answer. */
export interface Primer {
  readonly id: number
  readonly projectPath: string
  readonly question: string
  readonly questionEmbedding: Float32Array | null
  readonly questionEmbeddingModelId: string | null
  readonly answer: string
  readonly status: 'active' | 'archived'
  readonly totalSupport: number
  readonly lastObservedAt: number | null
  readonly answerRefreshedAt: number | null
  readonly sourceCandidateIds: readonly number[]
  readonly sourceProvenance: readonly PrimerSourceProvenance[] | null
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * DDL for both tables. `IF NOT EXISTS` so it runs on every mount against an
 * inherited corpus as well as a fresh one.
 */
export const PRIMER_DDL = `
  CREATE TABLE IF NOT EXISTS primer_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL,
    harness TEXT NOT NULL DEFAULT 'dsh',
    session_id TEXT NOT NULL,
    question TEXT NOT NULL,
    normalized_question TEXT NOT NULL,
    source_compartment_start INTEGER,
    source_compartment_end INTEGER,
    source_start_message_id TEXT NOT NULL DEFAULT '',
    source_end_message_id TEXT NOT NULL DEFAULT '',
    source_message_time INTEGER NOT NULL,
    question_embedding BLOB,
    question_embedding_model_id TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(project_path, harness, session_id, source_start_message_id, source_end_message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_primer_candidates_project
    ON primer_candidates(project_path, source_message_time DESC);

  CREATE TABLE IF NOT EXISTS primers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL,
    question TEXT NOT NULL,
    question_embedding BLOB,
    question_embedding_model_id TEXT,
    answer TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
    total_support INTEGER NOT NULL DEFAULT 0,
    last_observed_at INTEGER,
    answer_refreshed_at INTEGER,
    source_candidate_ids TEXT NOT NULL DEFAULT '[]',
    source_candidate_provenance TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_primers_project_status
    ON primers(project_path, status);
`

/**
 * Reduce a question to the form two occurrences are compared in.
 *
 * Lowercase, straight quotes, single spaces, no trailing punctuation. This is what
 * makes "What is the deploy command?" and "what is the deploy command" the same
 * question without an embedding, which matters because the embedding lane is
 * optional and the text lane must still work.
 *
 * @param question - the raw question.
 */
export function normalizePrimerQuestion(question: string): string {
  return question
    .trim()
    .toLowerCase()
    .replaceAll('\u201c', '"')
    .replaceAll('\u201d', '"')
    .replaceAll('\u2019', "'")
    .replace(/\s+/g, ' ')
    .replace(/[?.!]+$/g, '')
    .trim()
}

/** The occurrence identity, as the unique key spells it. */
export function primerOccurrenceKey(
  candidate: Pick<
    PrimerCandidate,
    'projectPath' | 'harness' | 'sessionId' | 'sourceStartMessageId' | 'sourceEndMessageId'
  >,
): string {
  return [
    candidate.projectPath,
    candidate.harness,
    candidate.sessionId,
    candidate.sourceStartMessageId,
    candidate.sourceEndMessageId,
  ].join('\u001f')
}

/** The UTC day an occurrence falls on — the unit support is counted in. */
export function primerOccurrenceUtcDay(sourceMessageTime: number): string {
  return new Date(sourceMessageTime).toISOString().slice(0, 10)
}

/** A `Float32Array` as the BLOB column stores it. */
export function vectorBlob(vector: Float32Array | null | undefined): Uint8Array | null {
  if (vector === null || vector === undefined) return null
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)
}

/**
 * A stored BLOB as a `Float32Array`.
 *
 * Copies rather than aliases: `node:sqlite` hands out a view into the result
 * buffer, which the next statement invalidates. A caller holding an alias would
 * read released memory — the same failure mode as the chunk store.
 *
 * @param value - the BLOB as SQLite returned it.
 */
export function blobToFloat32Array(
  value: Uint8Array | ArrayBuffer | null | undefined,
): Float32Array | null {
  if (value === null || value === undefined) return null
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value
  const copy = new Float32Array(bytes.byteLength / 4)
  new Uint8Array(copy.buffer).set(bytes)
  return copy
}

interface CandidateRow {
  id: number
  project_path: string
  harness: string
  session_id: string
  question: string
  normalized_question: string
  source_compartment_start: number | null
  source_compartment_end: number | null
  source_start_message_id: string
  source_end_message_id: string
  source_message_time: number
  question_embedding: Uint8Array | null
  question_embedding_model_id: string | null
  created_at: number
}

interface PrimerRow {
  id: number
  project_path: string
  question: string
  question_embedding: Uint8Array | null
  question_embedding_model_id: string | null
  answer: string
  status: string
  total_support: number
  last_observed_at: number | null
  answer_refreshed_at: number | null
  source_candidate_ids: string | null
  source_candidate_provenance: string | null
  created_at: number
  updated_at: number
}

function toCandidate(row: CandidateRow): PrimerCandidate {
  return {
    id: row.id,
    projectPath: row.project_path,
    harness: row.harness,
    sessionId: row.session_id,
    question: row.question,
    normalizedQuestion: row.normalized_question,
    sourceCompartmentStart: row.source_compartment_start,
    sourceCompartmentEnd: row.source_compartment_end,
    sourceStartMessageId: row.source_start_message_id,
    sourceEndMessageId: row.source_end_message_id,
    sourceMessageTime: row.source_message_time,
    questionEmbedding: blobToFloat32Array(row.question_embedding),
    questionEmbeddingModelId: row.question_embedding_model_id,
    createdAt: row.created_at,
  }
}

function parseCandidateIds(raw: string | null): number[] {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((value): value is number => typeof value === 'number' && Number.isInteger(value))
      : []
  } catch {
    return []
  }
}

function parseProvenance(raw: string | null): PrimerSourceProvenance[] | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return parsed.filter((entry): entry is PrimerSourceProvenance =>
      typeof entry === 'object' && entry !== null && 'candidateId' in entry)
  } catch {
    return null
  }
}

function toPrimer(row: PrimerRow): Primer {
  return {
    id: row.id,
    projectPath: row.project_path,
    question: row.question,
    questionEmbedding: blobToFloat32Array(row.question_embedding),
    questionEmbeddingModelId: row.question_embedding_model_id,
    answer: row.answer,
    status: row.status === 'archived' ? 'archived' : 'active',
    totalSupport: row.total_support,
    lastObservedAt: row.last_observed_at,
    answerRefreshedAt: row.answer_refreshed_at,
    sourceCandidateIds: parseCandidateIds(row.source_candidate_ids),
    sourceProvenance: parseProvenance(row.source_candidate_provenance),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Insert or refresh candidates, returning their ids in input order.
 *
 * A candidate with no question text is skipped rather than stored: an empty
 * question can never be promoted, and storing it would inflate the candidate
 * count the expiry sweep has to walk.
 *
 * @param db - the corpus database.
 * @param candidates - observed questions.
 * @returns ids of the rows that now exist, aligned with the input.
 */
export function insertPrimerCandidates(
  db: DatabaseSync,
  candidates: readonly PrimerCandidateInput[],
): number[] {
  const ids: number[] = []
  const insert = db.prepare(
    `INSERT INTO primer_candidates (
        project_path, harness, session_id, question, normalized_question,
        source_compartment_start, source_compartment_end,
        source_start_message_id, source_end_message_id, source_message_time,
        question_embedding, question_embedding_model_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_path, harness, session_id, source_start_message_id, source_end_message_id)
     DO UPDATE SET
        question = excluded.question,
        normalized_question = excluded.normalized_question,
        source_compartment_start = excluded.source_compartment_start,
        source_compartment_end = excluded.source_compartment_end,
        source_message_time = excluded.source_message_time,
        question_embedding = COALESCE(excluded.question_embedding, primer_candidates.question_embedding),
        question_embedding_model_id = COALESCE(excluded.question_embedding_model_id, primer_candidates.question_embedding_model_id),
        created_at = MIN(primer_candidates.created_at, excluded.created_at)`,
  )
  const select = db.prepare(
    `SELECT id FROM primer_candidates
      WHERE project_path = ? AND harness = ? AND session_id = ?
        AND source_start_message_id = ? AND source_end_message_id = ?`,
  )

  db.exec('BEGIN IMMEDIATE')
  try {
    for (const candidate of candidates) {
      const question = candidate.question.trim()
      if (question.length === 0) continue
      const harness = candidate.harness.length > 0 ? candidate.harness : 'dsh'
      insert.run(
        candidate.projectPath,
        harness,
        candidate.sessionId,
        question,
        candidate.normalizedQuestion ?? normalizePrimerQuestion(question),
        candidate.sourceCompartmentStart ?? null,
        candidate.sourceCompartmentEnd ?? null,
        candidate.sourceStartMessageId,
        candidate.sourceEndMessageId,
        candidate.sourceMessageTime,
        vectorBlob(candidate.questionEmbedding),
        candidate.questionEmbeddingModelId ?? null,
        candidate.createdAt ?? Date.now(),
      )
      const row = select.get(
        candidate.projectPath,
        harness,
        candidate.sessionId,
        candidate.sourceStartMessageId,
        candidate.sourceEndMessageId,
      ) as { id: number } | undefined
      if (row !== undefined) ids.push(row.id)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return ids
}

/** Fill in a candidate's question vector after the fact. */
export function updatePrimerCandidateEmbedding(
  db: DatabaseSync,
  candidateId: number,
  vector: Float32Array,
  modelId: string,
): void {
  db.prepare(
    'UPDATE primer_candidates SET question_embedding = ?, question_embedding_model_id = ? WHERE id = ?',
  ).run(vectorBlob(vector), modelId, candidateId)
}

/** Candidates by id, in any order. */
export function getPrimerCandidatesByIds(
  db: DatabaseSync,
  ids: readonly number[],
): PrimerCandidate[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db.prepare(
    `SELECT * FROM primer_candidates WHERE id IN (${placeholders}) ORDER BY source_message_time, id`,
  ).all(...ids) as unknown as CandidateRow[]
  return rows.map(toCandidate)
}

/**
 * Candidates of a project recent enough to count.
 *
 * `maxAgeMs` bounds the scan: a candidate from two years ago is not evidence that
 * a question recurs now, and letting the set grow without bound would make every
 * clustering pass progressively slower.
 *
 * @param db - the corpus database.
 * @param projectPath - project scope.
 * @param now - current time.
 * @param maxAgeMs - candidates older than this are excluded.
 */
export function getPrimerCandidatesForProject(
  db: DatabaseSync,
  projectPath: string,
  now: number,
  maxAgeMs: number = PRIMER_CANDIDATE_MAX_AGE_MS,
): PrimerCandidate[] {
  const rows = db.prepare(
    `SELECT * FROM primer_candidates
      WHERE project_path = ? AND source_message_time >= ?
      ORDER BY source_message_time, id`,
  ).all(projectPath, now - maxAgeMs) as unknown as CandidateRow[]
  return rows.map(toCandidate)
}

/** How many candidates a project holds within the age window. */
export function countPrimerCandidatesForProject(
  db: DatabaseSync,
  projectPath: string,
  now: number,
  maxAgeMs: number = PRIMER_CANDIDATE_MAX_AGE_MS,
): number {
  const row = db.prepare(
    'SELECT COUNT(*) AS count FROM primer_candidates WHERE project_path = ? AND source_message_time >= ?',
  ).get(projectPath, now - maxAgeMs) as { count: number }
  return row.count
}

/** Active primers of a project, newest first. */
export function getActivePrimers(db: DatabaseSync, projectPath: string): Primer[] {
  const rows = db.prepare(
    "SELECT * FROM primers WHERE project_path = ? AND status = 'active' ORDER BY updated_at DESC, id DESC",
  ).all(projectPath) as unknown as PrimerRow[]
  return rows.map(toPrimer)
}

/** Every primer of a project, any status. */
export function getAllPrimers(db: DatabaseSync, projectPath?: string): Primer[] {
  const rows = projectPath === undefined
    ? db.prepare('SELECT * FROM primers ORDER BY updated_at DESC, id DESC').all() as unknown as PrimerRow[]
    : db.prepare('SELECT * FROM primers WHERE project_path = ? ORDER BY updated_at DESC, id DESC')
      .all(projectPath) as unknown as PrimerRow[]
  return rows.map(toPrimer)
}

/**
 * Create a primer from a cluster's evidence.
 *
 * @param db - the corpus database.
 * @param input - the question, its answer, and the candidates that support it.
 * @returns the new primer's id.
 */
export function createPrimer(
  db: DatabaseSync,
  input: {
    readonly projectPath: string
    readonly question: string
    readonly questionEmbedding?: Float32Array | null
    readonly questionEmbeddingModelId?: string | null
    readonly answer?: string
    readonly totalSupport: number
    readonly lastObservedAt: number
    readonly sourceCandidateIds: readonly number[]
    readonly now?: number
  },
): number {
  const now = input.now ?? Date.now()
  const ids = [...new Set(input.sourceCandidateIds)].sort((left, right) => left - right)
  const provenance = loadProvenance(db, ids)
  const info = db.prepare(
    `INSERT INTO primers (
        project_path, question, question_embedding, question_embedding_model_id, answer,
        status, total_support, last_observed_at, answer_refreshed_at,
        source_candidate_ids, source_candidate_provenance, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    input.projectPath,
    input.question,
    vectorBlob(input.questionEmbedding),
    input.questionEmbeddingModelId ?? null,
    input.answer ?? '',
    input.totalSupport,
    input.lastObservedAt,
    JSON.stringify(ids),
    JSON.stringify(provenance),
    now,
    now,
  )
  return Number(info.lastInsertRowid)
}

/** Record fresh support for an existing primer. */
export function updatePrimerSupport(
  db: DatabaseSync,
  input: {
    readonly primerId: number
    readonly questionEmbedding?: Float32Array | null
    readonly questionEmbeddingModelId?: string | null
    readonly totalSupport: number
    readonly lastObservedAt: number
    readonly sourceCandidateIds: readonly number[]
    readonly now?: number
  },
): void {
  const now = input.now ?? Date.now()
  const ids = [...new Set(input.sourceCandidateIds)].sort((left, right) => left - right)
  const provenance = loadProvenance(db, ids)
  db.prepare(
    `UPDATE primers SET
        question_embedding = COALESCE(?, question_embedding),
        question_embedding_model_id = COALESCE(?, question_embedding_model_id),
        total_support = ?, last_observed_at = ?,
        source_candidate_ids = ?, source_candidate_provenance = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    vectorBlob(input.questionEmbedding),
    input.questionEmbeddingModelId ?? null,
    input.totalSupport,
    input.lastObservedAt,
    JSON.stringify(ids),
    JSON.stringify(provenance),
    now,
    input.primerId,
  )
}

/** Replace a primer's answer and mark when it was refreshed. */
export function updatePrimerAnswer(
  db: DatabaseSync,
  primerId: number,
  answer: string,
  now: number = Date.now(),
): void {
  db.prepare(
    'UPDATE primers SET answer = ?, answer_refreshed_at = ?, updated_at = ? WHERE id = ?',
  ).run(answer, now, now, primerId)
}

/** Retire a primer without deleting its evidence. */
export function archivePrimer(db: DatabaseSync, primerId: number, now: number = Date.now()): void {
  db.prepare("UPDATE primers SET status = 'archived', updated_at = ? WHERE id = ?").run(now, primerId)
}

/**
 * Delete candidates past the max age.
 *
 * @returns how many rows were removed.
 */
export function pruneExpiredPrimerCandidates(
  db: DatabaseSync,
  now: number,
  maxAgeMs: number = PRIMER_CANDIDATE_MAX_AGE_MS,
): number {
  const result = db.prepare('DELETE FROM primer_candidates WHERE source_message_time < ?')
    .run(now - maxAgeMs)
  return Number(result.changes)
}

/** Load provenance rows for a set of candidate ids. */
function loadProvenance(db: DatabaseSync, ids: readonly number[]): PrimerSourceProvenance[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db.prepare(
    `SELECT id, project_path, harness, session_id, source_compartment_start,
            source_compartment_end, source_start_message_id, source_end_message_id
       FROM primer_candidates WHERE id IN (${placeholders}) ORDER BY id`,
  ).all(...ids) as Array<{
    id: number
    project_path: string
    harness: string
    session_id: string
    source_compartment_start: number | null
    source_compartment_end: number | null
    source_start_message_id: string
    source_end_message_id: string
  }>
  return rows.map(row => ({
    candidateId: row.id,
    projectPath: row.project_path,
    harness: row.harness,
    sessionId: row.session_id,
    sourceCompartmentStart: row.source_compartment_start,
    sourceCompartmentEnd: row.source_compartment_end,
    sourceStartMessageId: row.source_start_message_id,
    sourceEndMessageId: row.source_end_message_id,
  }))
}
