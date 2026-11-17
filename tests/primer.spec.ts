/**
 * Primer lane: occurrence storage, clustering, and search.
 *
 * The properties pinned here are the ones that decide whether a primer means
 * anything:
 *
 *  - support counts distinct DAYS, not occurrences. Six asks in one afternoon is
 *    one occasion; counting them separately would manufacture a primer from a
 *    single busy session.
 *  - a promotion needs BOTH support and span. Support alone promotes a burst; span
 *    alone promotes one old question.
 *  - the occurrence unique key keeps the same words in two sessions as two rows,
 *    because recurrence is the evidence.
 *  - a re-index must not move `created_at` forward (age drives expiry) or erase a
 *    vector an earlier pass computed.
 *  - clustering is deterministic: the same input must promote the same primer.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  archivePrimer,
  createPrimer,
  getActivePrimers,
  getPrimerCandidatesForProject,
  insertPrimerCandidates,
  normalizePrimerQuestion,
  PRIMER_DDL,
  primerOccurrenceKey,
  pruneExpiredPrimerCandidates,
  updatePrimerAnswer,
  updatePrimerSupport,
  type PrimerCandidateInput,
} from '../src/core/primer-store.ts'
import {
  buildPrimerClusters,
  clusterEligibleForPromotion,
  PRIMER_CLUSTER_THRESHOLD,
  summarizePrimerCluster,
} from '../src/core/primer-cluster.ts'
import { promotePrimerClusters, searchPrimers } from '../src/core/primer-search.ts'

const DAY = 24 * 60 * 60 * 1000
/**
 * A `now` inside the candidate age window. The default candidate time is
 * 1_700_000_000_000 ms; the window is 180 days, so `now` must stay within it —
 * an arbitrarily large value silently excludes every candidate and makes a
 * working store look empty.
 */
const NOW = 1_700_000_000_000 + 11 * DAY
const PROJECT = 'C:/work/proj'

let dir: string
let db: DatabaseSync

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mc-primer-'))
  db = new DatabaseSync(join(dir, 'corpus.db'))
  db.exec(PRIMER_DDL)
})

afterEach(() => {
  try { db.close() } catch { /* closed */ }
  rmSync(dir, { recursive: true, force: true })
})

/** One observed question occurrence. */
function candidate(overrides: Partial<PrimerCandidateInput> = {}): PrimerCandidateInput {
  return {
    projectPath: PROJECT,
    harness: 'dsh',
    sessionId: 's1',
    question: 'How do we deploy?',
    sourceStartMessageId: 'm1',
    sourceEndMessageId: 'm1',
    sourceMessageTime: 1_700_000_000_000,
    ...overrides,
  }
}

describe('normalizePrimerQuestion', () => {
  it('folds case, quotes, whitespace and trailing punctuation', () => {
    expect(normalizePrimerQuestion('  What   is “Deploy”?  ')).toBe('what is "deploy"')
  })

  it('makes two phrasings of one question equal', () => {
    expect(normalizePrimerQuestion('How do we deploy?'))
      .toBe(normalizePrimerQuestion('how do we deploy'))
  })

  it('keeps a question mark inside the text', () => {
    // Only TRAILING punctuation goes; an internal mark is part of the question.
    expect(normalizePrimerQuestion('is it a? b?')).toBe('is it a? b')
  })
})

describe('primerOccurrenceKey', () => {
  it('keeps the same words in two sessions distinct', () => {
    // A text-based key would collapse this, destroying the recurrence evidence.
    const one = primerOccurrenceKey({
      projectPath: PROJECT, harness: 'dsh', sessionId: 's1',
      sourceStartMessageId: 'm1', sourceEndMessageId: 'm1',
    })
    const two = primerOccurrenceKey({
      projectPath: PROJECT, harness: 'dsh', sessionId: 's2',
      sourceStartMessageId: 'm1', sourceEndMessageId: 'm1',
    })
    expect(one).not.toBe(two)
  })
})

describe('insertPrimerCandidates', () => {
  it('inserts and returns an id', () => {
    const ids = insertPrimerCandidates(db, [candidate()])
    expect(ids).toHaveLength(1)
    expect(ids[0]).toBeGreaterThan(0)
  })

  it('is idempotent for the same occurrence', () => {
    const first = insertPrimerCandidates(db, [candidate()])
    const second = insertPrimerCandidates(db, [candidate()])
    expect(second).toEqual(first)
    expect(getPrimerCandidatesForProject(db, PROJECT, NOW)).toHaveLength(1)
  })

  it('keeps two sessions asking the same question as two rows', () => {
    insertPrimerCandidates(db, [
      candidate({ sessionId: 's1' }),
      candidate({ sessionId: 's2' }),
    ])
    expect(getPrimerCandidatesForProject(db, PROJECT, NOW)).toHaveLength(2)
  })

  it('does not move created_at forward on a re-index', () => {
    // Age drives expiry, so a re-index of an old occurrence must stay old.
    const early = 1_700_000_000_000
    insertPrimerCandidates(db, [candidate({ createdAt: early })])
    insertPrimerCandidates(db, [candidate({ createdAt: early + 90 * DAY })])
    const rows = getPrimerCandidatesForProject(db, PROJECT, early + DAY)
    expect(rows[0]!.createdAt).toBe(early)
  })

  it('keeps an existing vector when the re-index has none', () => {
    const vector = Float32Array.from([1, 0, 0])
    insertPrimerCandidates(db, [candidate({ questionEmbedding: vector, questionEmbeddingModelId: 'm1' })])
    insertPrimerCandidates(db, [candidate()])
    const rows = getPrimerCandidatesForProject(db, PROJECT, NOW)
    expect(rows[0]!.questionEmbedding).not.toBeNull()
    expect(Array.from(rows[0]!.questionEmbedding!)).toEqual([1, 0, 0])
  })

  it('skips an empty question rather than storing it', () => {
    expect(insertPrimerCandidates(db, [candidate({ question: '   ' })])).toEqual([])
  })

  it('excludes candidates past the age window', () => {
    const now = NOW
    insertPrimerCandidates(db, [candidate({ sourceMessageTime: now - 400 * DAY })])
    expect(getPrimerCandidatesForProject(db, PROJECT, now)).toHaveLength(0)
  })
})

describe('clustering', () => {
  it('groups candidates by normalized text when no vectors exist', () => {
    insertPrimerCandidates(db, [
      candidate({ question: 'How do we deploy?', sourceMessageTime: NOW - 3 * DAY }),
      candidate({ question: 'how do we deploy', sourceMessageTime: NOW - 2 * DAY, sourceStartMessageId: 'm2' }),
      candidate({ question: 'What is the port?', sourceMessageTime: NOW - 1 * DAY, sourceStartMessageId: 'm3' }),
    ])
    const candidates = getPrimerCandidatesForProject(db, PROJECT, NOW)
    const clusters = buildPrimerClusters({ candidates, activePrimers: [] })
    expect(clusters).toHaveLength(2)
  })

  it('groups by cosine when the model space matches', () => {
    const vector = Float32Array.from([1, 0, 0])
    insertPrimerCandidates(db, [
      candidate({ question: 'alpha phrasing one', questionEmbedding: vector, questionEmbeddingModelId: 'm1', sourceMessageTime: NOW - 3 * DAY }),
      candidate({
        question: 'beta totally different words',
        questionEmbedding: Float32Array.from([0.99, 0.01, 0]),
        questionEmbeddingModelId: 'm1',
        sourceMessageTime: NOW - 2 * DAY,
        sourceStartMessageId: 'm2',
      }),
    ])
    const candidates = getPrimerCandidatesForProject(db, PROJECT, NOW)
    const clusters = buildPrimerClusters({ candidates, activePrimers: [] })
    // Different text, near-identical vector → one cluster.
    expect(clusters).toHaveLength(1)
  })

  it('never compares vectors from different spaces', () => {
    // Cosine across spaces is meaningless; the guard must fall back to text.
    insertPrimerCandidates(db, [
      candidate({ question: 'alpha', questionEmbedding: Float32Array.from([1, 0, 0]), questionEmbeddingModelId: 'm1', sourceMessageTime: NOW - 3 * DAY }),
      candidate({
        question: 'beta',
        questionEmbedding: Float32Array.from([1, 0, 0]),
        questionEmbeddingModelId: 'm2',
        sourceMessageTime: NOW - 2 * DAY,
        sourceStartMessageId: 'm2',
      }),
    ])
    const candidates = getPrimerCandidatesForProject(db, PROJECT, NOW)
    expect(buildPrimerClusters({ candidates, activePrimers: [] })).toHaveLength(2)
  })

  it('is deterministic across runs', () => {
    insertPrimerCandidates(db, [
      candidate({ question: 'q one', sourceMessageTime: NOW - 3 * DAY }),
      candidate({ question: 'q two', sourceMessageTime: NOW - 2 * DAY, sourceStartMessageId: 'm2' }),
      candidate({ question: 'q three', sourceMessageTime: NOW - 1 * DAY, sourceStartMessageId: 'm3' }),
    ])
    const candidates = getPrimerCandidatesForProject(db, PROJECT, NOW)
    const first = buildPrimerClusters({ candidates, activePrimers: [] })
      .map(cluster => cluster.candidates.map(entry => entry.id))
    const second = buildPrimerClusters({ candidates: [...candidates].reverse(), activePrimers: [] })
      .map(cluster => cluster.candidates.map(entry => entry.id))
    expect(second).toEqual(first)
  })

  it('seeds one cluster per active primer', () => {
    const primerId = createPrimer(db, {
      projectPath: PROJECT,
      question: 'How do we deploy?',
      totalSupport: 2,
      lastObservedAt: 1_000,
      sourceCandidateIds: [],
    })
    expect(primerId).toBeGreaterThan(0)
    const clusters = buildPrimerClusters({
      candidates: getPrimerCandidatesForProject(db, PROJECT, NOW),
      activePrimers: getActivePrimers(db, PROJECT),
    })
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.primer?.id).toBe(primerId)
  })
})

describe('summarizePrimerCluster counts distinct days', () => {
  it('collapses six asks in one day to one day of support', () => {
    // The core anti-inflation rule: a burst is not a habit.
    const base = 1_700_000_000_000
    const inputs = Array.from({ length: 6 }, (_unused, index) => candidate({
      sourceMessageTime: base + index * 60_000,
      sourceStartMessageId: `m${String(index)}`,
      sourceEndMessageId: `m${String(index)}`,
    }))
    insertPrimerCandidates(db, inputs)
    const candidates = getPrimerCandidatesForProject(db, PROJECT, base + DAY)
    const clusters = buildPrimerClusters({ candidates, activePrimers: [] })
    const summary = summarizePrimerCluster(clusters[0]!)
    expect(summary.support).toBe(1)
    expect(clusterEligibleForPromotion(summary)).toBe(false)
  })

  it('counts two days a week apart as eligible', () => {
    const base = 1_700_000_000_000
    insertPrimerCandidates(db, [
      candidate({ sourceMessageTime: base, sourceStartMessageId: 'm1' }),
      candidate({ sourceMessageTime: base + 8 * DAY, sourceStartMessageId: 'm2' }),
    ])
    const candidates = getPrimerCandidatesForProject(db, PROJECT, base + 9 * DAY)
    const clusters = buildPrimerClusters({ candidates, activePrimers: [] })
    const summary = summarizePrimerCluster(clusters[0]!)
    expect(summary.support).toBe(2)
    expect(summary.spanDays).toBe(8)
    expect(clusterEligibleForPromotion(summary)).toBe(true)
  })

  it('rejects two days that are too close together', () => {
    const base = 1_700_000_000_000
    insertPrimerCandidates(db, [
      candidate({ sourceMessageTime: base, sourceStartMessageId: 'm1' }),
      candidate({ sourceMessageTime: base + 2 * DAY, sourceStartMessageId: 'm2' }),
    ])
    const candidates = getPrimerCandidatesForProject(db, PROJECT, base + 3 * DAY)
    const summary = summarizePrimerCluster(buildPrimerClusters({ candidates, activePrimers: [] })[0]!)
    expect(summary.support).toBe(2)
    expect(summary.spanDays).toBe(2)
    // Support alone is not enough: this is a follow-up, not a habit.
    expect(clusterEligibleForPromotion(summary)).toBe(false)
  })
})

describe('promotePrimerClusters', () => {
  it('creates a primer for a question that recurs across days', () => {
    const base = 1_700_000_000_000
    insertPrimerCandidates(db, [
      candidate({ sourceMessageTime: base, sourceStartMessageId: 'm1' }),
      candidate({ sourceMessageTime: base + 10 * DAY, sourceStartMessageId: 'm2', sessionId: 's2' }),
    ])
    const result = promotePrimerClusters(db, PROJECT, base + 11 * DAY)
    expect(result.created).toHaveLength(1)
    const primers = getActivePrimers(db, PROJECT)
    expect(primers).toHaveLength(1)
    // The answer starts EMPTY on purpose: inventing one would return a fabricated
    // answer as established fact.
    expect(primers[0]!.answer).toBe('')
    expect(primers[0]!.totalSupport).toBe(2)
  })

  it('stores the earliest occurrence wording', () => {
    const base = 1_700_000_000_000
    insertPrimerCandidates(db, [
      candidate({ question: 'How do we deploy?', sourceMessageTime: base, sourceStartMessageId: 'm1' }),
      candidate({ question: 'how do we deploy', sourceMessageTime: base + 10 * DAY, sourceStartMessageId: 'm2', sessionId: 's2' }),
    ])
    promotePrimerClusters(db, PROJECT, base + 11 * DAY)
    expect(getActivePrimers(db, PROJECT)[0]!.question).toBe('How do we deploy?')
  })

  it('does not create a primer for a single-day burst', () => {
    const base = 1_700_000_000_000
    insertPrimerCandidates(db, Array.from({ length: 5 }, (_unused, index) => candidate({
      sourceMessageTime: base + index * 60_000,
      sourceStartMessageId: `m${String(index)}`,
      sourceEndMessageId: `m${String(index)}`,
    })))
    expect(promotePrimerClusters(db, PROJECT, base + DAY).created).toEqual([])
  })

  it('refreshes an existing primer instead of creating a second', () => {
    const base = 1_700_000_000_000
    insertPrimerCandidates(db, [
      candidate({ sourceMessageTime: base, sourceStartMessageId: 'm1' }),
      candidate({ sourceMessageTime: base + 10 * DAY, sourceStartMessageId: 'm2' }),
    ])
    const first = promotePrimerClusters(db, PROJECT, base + 11 * DAY)
    expect(first.created).toHaveLength(1)

    // A third occurrence, two more weeks on.
    insertPrimerCandidates(db, [
      candidate({ sourceMessageTime: base + 24 * DAY, sourceStartMessageId: 'm3' }),
    ])
    const second = promotePrimerClusters(db, PROJECT, base + 25 * DAY)
    expect(second.created).toEqual([])
    expect(second.refreshed).toEqual(first.created)
    expect(getActivePrimers(db, PROJECT)).toHaveLength(1)
  })

  it('keeps the answer when refreshing support', () => {
    const base = 1_700_000_000_000
    insertPrimerCandidates(db, [
      candidate({ sourceMessageTime: base, sourceStartMessageId: 'm1' }),
      candidate({ sourceMessageTime: base + 10 * DAY, sourceStartMessageId: 'm2' }),
    ])
    const id = promotePrimerClusters(db, PROJECT, base + 11 * DAY).created[0]!
    updatePrimerAnswer(db, id, 'Run `npm run deploy`.')
    insertPrimerCandidates(db, [candidate({ sourceMessageTime: base + 20 * DAY, sourceStartMessageId: 'm3' })])
    promotePrimerClusters(db, PROJECT, base + 21 * DAY)
    expect(getActivePrimers(db, PROJECT)[0]!.answer).toBe('Run `npm run deploy`.')
  })
})

describe('searchPrimers', () => {
  function seedPrimer(question: string, answer: string): number {
    return createPrimer(db, {
      projectPath: PROJECT,
      question,
      answer,
      totalSupport: 3,
      lastObservedAt: 1_700_000_000_000,
      sourceCandidateIds: [],
    })
  }

  it('finds by text and reports the match type', () => {
    seedPrimer('How do we deploy?', 'Run the script.')
    const hits = searchPrimers(db, PROJECT, 'deploy', { limit: 5 })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.matchType).toBe('text')
    expect(hits[0]!.answer).toBe('Run the script.')
  })

  it('finds by vector when the space matches', () => {
    createPrimer(db, {
      projectPath: PROJECT,
      question: 'How do we deploy?',
      questionEmbedding: Float32Array.from([1, 0, 0]),
      questionEmbeddingModelId: 'm1',
      answer: 'x',
      totalSupport: 2,
      lastObservedAt: 1,
      sourceCandidateIds: [],
    })
    const hits = searchPrimers(db, PROJECT, 'zzz no text overlap', {
      limit: 5,
      queryEmbedding: Float32Array.from([1, 0, 0]),
      queryModelId: 'm1',
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.matchType).toBe('semantic')
  })

  it('never scores a vector from a different space', () => {
    createPrimer(db, {
      projectPath: PROJECT,
      question: 'How do we deploy?',
      questionEmbedding: Float32Array.from([1, 0, 0]),
      questionEmbeddingModelId: 'm1',
      answer: 'x',
      totalSupport: 2,
      lastObservedAt: 1,
      sourceCandidateIds: [],
    })
    const hits = searchPrimers(db, PROJECT, 'zzz', {
      limit: 5,
      queryEmbedding: Float32Array.from([1, 0, 0]),
      queryModelId: 'm2',
    })
    expect(hits).toEqual([])
  })

  it('does not return an archived primer', () => {
    const id = seedPrimer('How do we deploy?', 'Run the script.')
    archivePrimer(db, id, 2_000_000_000_000)
    expect(searchPrimers(db, PROJECT, 'deploy', { limit: 5 })).toEqual([])
  })

  it('returns an empty answer as an empty string, not a missing hit', () => {
    // "We keep asking this and never wrote it down" is exactly what promotion
    // exists to surface, so the hit must survive an empty answer.
    seedPrimer('Why is the build slow?', '')
    const hits = searchPrimers(db, PROJECT, 'build', { limit: 5 })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.answer).toBe('')
  })

  it('scopes to the project', () => {
    seedPrimer('How do we deploy?', 'x')
    expect(searchPrimers(db, 'C:/other', 'deploy', { limit: 5 })).toEqual([])
  })

  it('returns empty for an empty query', () => {
    seedPrimer('How do we deploy?', 'x')
    expect(searchPrimers(db, PROJECT, '   ', { limit: 5 })).toEqual([])
  })
})

describe('maintenance helpers', () => {
  it('prunes candidates past the max age', () => {
    const now = NOW
    insertPrimerCandidates(db, [
      candidate({ sourceMessageTime: now - 400 * DAY, sourceStartMessageId: 'old' }),
      candidate({ sourceMessageTime: now - 10 * DAY, sourceStartMessageId: 'new' }),
    ])
    expect(pruneExpiredPrimerCandidates(db, now)).toBe(1)
    // The 10-day-old candidate is inside the window and must survive: pruning
    // removes evidence that aged out, not evidence that is still current.
    const left = getPrimerCandidatesForProject(db, PROJECT, now)
    expect(left).toHaveLength(1)
    expect(left[0]!.sourceStartMessageId).toBe('new')
  })

  it('updates support without dropping an existing vector', () => {
    const id = createPrimer(db, {
      projectPath: PROJECT,
      question: 'q',
      questionEmbedding: Float32Array.from([1, 0]),
      questionEmbeddingModelId: 'm1',
      totalSupport: 2,
      lastObservedAt: 1,
      sourceCandidateIds: [],
    })
    updatePrimerSupport(db, {
      primerId: id,
      totalSupport: 5,
      lastObservedAt: 2,
      sourceCandidateIds: [],
    })
    const primer = getActivePrimers(db, PROJECT)[0]!
    expect(primer.totalSupport).toBe(5)
    // COALESCE keeps the vector: a support refresh is not an embedding pass.
    expect(primer.questionEmbedding).not.toBeNull()
  })

  it('defaults the cluster threshold to 0.85', () => {
    expect(PRIMER_CLUSTER_THRESHOLD).toBe(0.85)
  })
})
