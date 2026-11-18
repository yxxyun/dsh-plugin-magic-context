/**
 * Search active primers for a query.
 *
 * A primer answers "have we answered this before", so the ranking question is
 * different from the memory lane: the user is asking a question they have probably
 * asked in a slightly different form. That makes the embedding the primary signal
 * and the text match a tie-breaker, which is why the weights here are inverted
 * relative to the commit lane.
 *
 * A primer with an empty answer is still returned: the question itself tells the
 * agent that this recurs, and "we keep asking this and never wrote it down" is
 * exactly the state a primer is promoted out of.
 *
 * Only `active` primers are searched. An archived one is a decision that the
 * answer was wrong or obsolete, and surfacing it again would undo that decision.
 */
import type { DatabaseSync } from 'node:sqlite'
import { cosineScore } from './vector-math.ts'
import {
  buildPrimerClusters,
  clusterEligibleForPromotion,
  summarizePrimerCluster,
} from './primer-cluster.ts'
import {
  blobToFloat32Array,
  createPrimer,
  getActivePrimers,
  getPrimerCandidatesForProject,
  type Primer,
  updatePrimerSupport,
} from './primer-store.ts'

/** Similarity is the primary signal for "have we answered this". */
const SEMANTIC_WEIGHT = 0.7
const TEXT_WEIGHT = 0.3
const SINGLE_SOURCE_PENALTY = 0.8

/** A scored primer match. */
export interface PrimerHit {
  readonly id: number
  readonly question: string
  readonly answer: string
  readonly totalSupport: number
  readonly lastObservedAt: number | null
  readonly score: number
  readonly matchType: 'hybrid' | 'text' | 'semantic'
}

export interface SearchPrimersOptions {
  readonly limit: number
  readonly queryEmbedding?: Float32Array | null
  readonly queryModelId?: string | null
}

/**
 * Score a primer against the query text.
 *
 * Normalised substring and token overlap, in [0, 1]. Deliberately simple: the
 * embedding carries the real signal, and a cleverer text score would just add a
 * second thing to calibrate.
 */
function textScore(question: string, query: string): number {
  const normalizedQuestion = question.trim().toLowerCase()
  const normalizedQuery = query.trim().toLowerCase()
  if (normalizedQuery.length === 0) return 0
  if (normalizedQuestion.includes(normalizedQuery)) return 1
  // Token overlap: what fraction of the query's words appear in the question.
  const queryTokens = normalizedQuery.split(/[^\p{L}\p{N}_]+/u).filter(token => token.length > 1)
  if (queryTokens.length === 0) return 0
  let matched = 0
  for (const token of queryTokens) {
    if (normalizedQuestion.includes(token)) matched += 1
  }
  return matched / queryTokens.length
}

/**
 * Search a project's active primers.
 *
 * @param db - the corpus database.
 * @param projectPath - project scope.
 * @param query - the raw query.
 * @param options - limit and the query vector when available.
 * @returns scored hits, best first.
 */
export function searchPrimers(
  db: DatabaseSync,
  projectPath: string,
  query: string,
  options: SearchPrimersOptions,
): PrimerHit[] {
  const trimmed = query.trim()
  if (trimmed.length === 0 || options.limit <= 0) return []

  const primers = getActivePrimers(db, projectPath)
  if (primers.length === 0) return []

  const modelId = options.queryModelId ?? null
  const vector = options.queryEmbedding ?? null

  const hits: PrimerHit[] = []
  for (const primer of primers) {
    const text = textScore(primer.question, trimmed)
    let semantic: number | undefined
    if (
      vector !== null
      && modelId !== null
      && primer.questionEmbeddingModelId === modelId
      && primer.questionEmbedding !== null
    ) {
      semantic = cosineScore(vector, primer.questionEmbedding)
    }

    let score: number
    let matchType: PrimerHit['matchType']
    if (semantic !== undefined && text > 0) {
      score = SEMANTIC_WEIGHT * semantic + TEXT_WEIGHT * text
      matchType = 'hybrid'
    } else if (semantic !== undefined) {
      score = semantic * SINGLE_SOURCE_PENALTY
      matchType = 'semantic'
    } else if (text > 0) {
      score = text * SINGLE_SOURCE_PENALTY
      matchType = 'text'
    } else {
      continue
    }
    if (score <= 0) continue

    hits.push({
      id: primer.id,
      question: primer.question,
      answer: primer.answer,
      totalSupport: primer.totalSupport,
      lastObservedAt: primer.lastObservedAt,
      score,
      matchType,
    })
  }

  hits.sort((left, right) => right.score - left.score || left.id - right.id)
  return hits.slice(0, options.limit)
}

/**
 * Promote every eligible cluster of a project.
 *
 * The only place that writes primers, and the function a maintenance tick calls.
 *
 * A cluster touching an existing primer refreshes its support and keeps its
 * answer; a cluster with no primer creates one with an EMPTY answer. This adapter
 * has no dreamer, so promotion records the question and leaves the answer to the
 * agent — inventing an answer here would be worse than an obviously empty one,
 * because `ctx_search` would then return a fabricated answer as established fact.
 *
 * @param db - the corpus database.
 * @param projectPath - project scope.
 * @param now - current time.
 * @returns ids of created primers and ids of refreshed ones.
 */
export function promotePrimerClusters(
  db: DatabaseSync,
  projectPath: string,
  now: number = Date.now(),
): { created: number[]; refreshed: number[] } {
  const candidates = getPrimerCandidatesForProject(db, projectPath, now)
  if (candidates.length === 0) return { created: [], refreshed: [] }

  const clusters = buildPrimerClusters({
    candidates,
    activePrimers: getActivePrimers(db, projectPath),
  })

  const created: number[] = []
  const refreshed: number[] = []
  for (const cluster of clusters) {
    // A cluster with no candidates is an existing primer nobody re-asked.
    if (cluster.candidates.length === 0) continue
    const summary = summarizePrimerCluster(cluster)
    if (!clusterEligibleForPromotion(summary)) continue

    if (cluster.primer !== null) {
      updatePrimerSupport(db, {
        primerId: cluster.primer.id,
        totalSupport: summary.support,
        lastObservedAt: summary.lastObservedAt,
        sourceCandidateIds: summary.sourceCandidateIds,
        ...summary.centroid === null ? {} : { questionEmbedding: summary.centroid },
        ...summary.modelId === null ? {} : { questionEmbeddingModelId: summary.modelId },
        now,
      })
      refreshed.push(cluster.primer.id)
      continue
    }

    // The question to store is the EARLIEST occurrence's wording: the first time
    // the project asked is the phrasing the answer was shaped around.
    const first = [...cluster.candidates].sort((left, right) =>
      left.sourceMessageTime - right.sourceMessageTime || left.id - right.id)[0]
    if (first === undefined) continue
    created.push(createPrimer(db, {
      projectPath,
      question: first.question,
      totalSupport: summary.support,
      lastObservedAt: summary.lastObservedAt,
      sourceCandidateIds: summary.sourceCandidateIds,
      ...summary.centroid === null ? {} : { questionEmbedding: summary.centroid },
      ...summary.modelId === null ? {} : { questionEmbeddingModelId: summary.modelId },
      now,
    }))
  }
  return { created, refreshed }
}

/** Re-export so a caller can decode a stored vector without importing the store. */
export { blobToFloat32Array }

/** A primer as the search lane reports it, for callers that want the raw row. */
export type { Primer }
