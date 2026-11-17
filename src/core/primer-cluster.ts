/**
 * Primer clustering: deciding when repeated questions deserve a primer.
 *
 * Ported from upstream `primer-clustering.ts` (184 lines). The constants are kept
 * because they encode judgement, not arithmetic:
 *
 *  - `0.85` — how close two question vectors must be to be the same question;
 *  - `0.02` — hysteresis: a candidate already inside a primer needs only 0.83, so
 *    an established cluster does not shed members as the centroid drifts;
 *  - support `2` — asked twice;
 *  - span `7` days — asked twice WITHIN A WEEK is a follow-up, not a habit. The
 *    span requirement is what makes a primer describe a recurring need.
 *
 * ## Support is counted per DAY, not per occurrence
 *
 * The same question asked six times in one sitting is one occasion, not six
 * supports. `summarizePrimerCluster` therefore keeps the earliest occurrence of
 * each UTC day and counts distinct days. Without this every busy afternoon would
 * manufacture a primer.
 *
 * ## Two lanes, and the text lane is not a fallback for missing vectors
 *
 * Clustering uses the embedding when the candidate AND the cluster centroid share
 * a model id, and `normalizedQuestion` equality otherwise. Mixed-space vectors are
 * never compared: cosine across spaces is meaningless, and the guard is
 * `sameEmbeddingSpace` rather than a try/catch.
 */
import { cosineScore } from './chunk-store.ts'
import {
  normalizePrimerQuestion,
  primerOccurrenceKey,
  primerOccurrenceUtcDay,
  type Primer,
  type PrimerCandidate,
} from './primer-store.ts'

/** Cosine similarity at which two questions count as the same question. */
export const PRIMER_CLUSTER_THRESHOLD = 0.85
/** Slack for a candidate already inside a primer, so clusters do not shed members. */
export const PRIMER_CLUSTER_HYSTERESIS = 0.02
/** Distinct days a question must recur on. */
export const PRIMER_PROMOTION_THRESHOLD = 2
/** Minimum span between the first and last support. */
export const PRIMER_MIN_SPAN_DAYS = 7

/** One cluster: either an existing primer gaining evidence, or a candidate group. */
export interface PrimerCluster {
  primer: Primer | null
  candidates: PrimerCandidate[]
  centroid: Float32Array | null
  modelId: string | null
}

/** The numbers a promotion decision reads. */
export interface PrimerClusterSummary {
  readonly candidates: readonly PrimerCandidate[]
  /** Distinct UTC days on which this question was asked. */
  readonly support: number
  /** Days between the first and last support; 0 for a single day. */
  readonly spanDays: number
  readonly lastObservedAt: number
  readonly sourceCandidateIds: readonly number[]
  readonly centroid: Float32Array | null
  readonly modelId: string | null
}

function cloneVector(vector: Float32Array | null): Float32Array | null {
  return vector === null ? null : new Float32Array(vector)
}

/** Mean of a set of vectors, or null when they are empty or ragged. */
function averageVectors(vectors: readonly Float32Array[]): Float32Array | null {
  if (vectors.length === 0) return null
  const dims = vectors[0]?.length ?? 0
  if (dims === 0) return null
  const out = new Float32Array(dims)
  for (const vector of vectors) {
    if (vector.length !== dims) return null
    for (let index = 0; index < dims; index += 1) {
      out[index] = (out[index] as number) + (vector[index] as number)
    }
  }
  for (let index = 0; index < dims; index += 1) {
    out[index] = (out[index] as number) / vectors.length
  }
  return out
}

/** Sort key that keeps U+001F significant, so session `s1` precedes `s10`. */
function candidateSortKey(candidate: PrimerCandidate): string {
  return `${primerOccurrenceKey(candidate)}\u001f${String(candidate.id)}`
}

/** Both sides must carry a vector AND agree on the space. */
function sameEmbeddingSpace(candidate: PrimerCandidate, modelId: string | null): boolean {
  return candidate.questionEmbedding !== null
    && candidate.questionEmbeddingModelId !== null
    && modelId !== null
    && candidate.questionEmbeddingModelId === modelId
}

/** Recompute a cluster's centroid, falling back to the primer's own vector. */
function recomputeClusterCentroid(cluster: PrimerCluster): void {
  const vectors: Float32Array[] = []
  for (const candidate of cluster.candidates) {
    if (!sameEmbeddingSpace(candidate, cluster.modelId)) continue
    const vector = candidate.questionEmbedding
    if (vector !== null) vectors.push(vector)
  }
  if (vectors.length > 0) {
    cluster.centroid = averageVectors(vectors)
    return
  }
  if (cluster.primer?.questionEmbedding != null) {
    cluster.centroid = cloneVector(cluster.primer.questionEmbedding)
  }
}

/**
 * Text equality, used when either side lacks a comparable vector.
 *
 * The primer's question must be normalized through the SAME function the
 * candidates went through. Comparing `primer.question.toLowerCase().trim()` (raw,
 * still carrying its trailing `?`) against `candidate.normalizedQuestion` (which
 * had the punctuation stripped) never matches — and a primer with no embedding
 * then never absorbs its own recurrences, so every new occurrence spawns a
 * duplicate primer. That is the exact failure the primer lane exists to prevent,
 * and it is silent: both rows look correct, the duplication only shows up as
 * support that never accumulates.
 */
function normalizedTextMatches(candidate: PrimerCandidate, cluster: PrimerCluster): boolean {
  const first = cluster.candidates[0]
  if (first !== undefined) return first.normalizedQuestion === candidate.normalizedQuestion
  if (cluster.primer === null) return false
  return normalizePrimerQuestion(cluster.primer.question) === candidate.normalizedQuestion
}

/**
 * Group candidates into clusters, seeding one cluster per active primer.
 *
 * Candidates are processed in a stable code-unit order rather than in input order:
 * clustering is order-dependent (a candidate joins the FIRST cluster it is close
 * enough to), so a stable order is what makes the same input produce the same
 * clusters on every run. Without it, two passes over the same data could promote
 * different primers.
 *
 * @param args - candidates, active primers, and optional threshold overrides.
 */
export function buildPrimerClusters(args: {
  readonly candidates: readonly PrimerCandidate[]
  readonly activePrimers: readonly Primer[]
  readonly threshold?: number
  readonly hysteresis?: number
}): PrimerCluster[] {
  const threshold = args.threshold ?? PRIMER_CLUSTER_THRESHOLD
  const hysteresis = args.hysteresis ?? PRIMER_CLUSTER_HYSTERESIS

  const clusters: PrimerCluster[] = [...args.activePrimers]
    .sort((left, right) => left.id - right.id)
    .map(primer => ({
      primer,
      candidates: [],
      centroid: cloneVector(primer.questionEmbedding),
      modelId: primer.questionEmbeddingModelId,
    }))

  const sorted = [...args.candidates].sort((left, right) => {
    const a = candidateSortKey(left)
    const b = candidateSortKey(right)
    return a < b ? -1 : a > b ? 1 : 0
  })

  for (const candidate of sorted) {
    let best: { cluster: PrimerCluster; score: number } | null = null
    for (const cluster of clusters) {
      let score = Number.NEGATIVE_INFINITY
      if (
        candidate.questionEmbedding !== null
        && cluster.centroid !== null
        && sameEmbeddingSpace(candidate, cluster.modelId)
      ) {
        score = cosineScore(candidate.questionEmbedding, cluster.centroid)
      } else if (normalizedTextMatches(candidate, cluster)) {
        // Text equality is a certain match, so it scores above any cosine.
        score = 1
      }
      // A candidate already counted for this primer gets the hysteresis slack, so
      // an established cluster does not drop members as its centroid moves.
      const stickier = cluster.primer !== null && cluster.primer.sourceCandidateIds.includes(candidate.id)
        ? threshold - hysteresis
        : threshold
      if (score >= stickier && (best === null || score > best.score)) {
        best = { cluster, score }
      }
    }

    if (best !== null) {
      best.cluster.candidates.push(candidate)
      recomputeClusterCentroid(best.cluster)
      continue
    }

    clusters.push({
      primer: null,
      candidates: [candidate],
      centroid: cloneVector(candidate.questionEmbedding),
      modelId: candidate.questionEmbeddingModelId,
    })
  }

  return clusters
}

/**
 * Reduce a cluster to the numbers a promotion decision reads.
 *
 * Support counts distinct UTC DAYS, keeping the earliest occurrence of each day:
 * six asks in one afternoon are one occasion.
 *
 * @param cluster - the cluster to summarize.
 */
export function summarizePrimerCluster(cluster: PrimerCluster): PrimerClusterSummary {
  const byDay = new Map<string, PrimerCandidate>()
  const byOccurrence = new Map<string, PrimerCandidate>()
  for (const candidate of cluster.candidates) {
    const key = primerOccurrenceKey(candidate)
    if (!byOccurrence.has(key)) byOccurrence.set(key, candidate)
  }
  for (const candidate of byOccurrence.values()) {
    const day = primerOccurrenceUtcDay(candidate.sourceMessageTime)
    const existing = byDay.get(day)
    if (existing === undefined || candidate.sourceMessageTime < existing.sourceMessageTime) {
      byDay.set(day, candidate)
    }
  }
  const distinct = [...byDay.values()].sort((left, right) =>
    left.sourceMessageTime - right.sourceMessageTime || left.id - right.id)

  const first = distinct[0]?.sourceMessageTime ?? 0
  const last = distinct[distinct.length - 1]?.sourceMessageTime ?? first

  const supportIds = new Set<number>(cluster.primer?.sourceCandidateIds ?? [])
  for (const candidate of cluster.candidates) supportIds.add(candidate.id)

  return {
    candidates: cluster.candidates,
    support: distinct.length,
    spanDays: distinct.length <= 1 ? 0 : Math.floor((last - first) / (24 * 60 * 60 * 1000)),
    lastObservedAt: last > 0 ? last : Date.now(),
    sourceCandidateIds: [...supportIds].sort((left, right) => left - right),
    centroid: cluster.centroid,
    modelId: cluster.modelId,
  }
}

/**
 * Should this cluster become (or refresh) a primer?
 *
 * Both conditions are required. Support alone promotes a burst within one session;
 * span alone promotes a single ancient question. Together they describe a habit.
 *
 * @param summary - the cluster's numbers.
 * @param threshold - distinct days required.
 * @param minSpanDays - minimum span required.
 */
export function clusterEligibleForPromotion(
  summary: PrimerClusterSummary,
  threshold: number = PRIMER_PROMOTION_THRESHOLD,
  minSpanDays: number = PRIMER_MIN_SPAN_DAYS,
): boolean {
  return summary.support >= threshold && summary.spanDays >= minSpanDays
}
