/**
 * The message lane of `ctx_search`: raw conversation history, searched through
 * the HOST's own session index.
 *
 * Why this file exists at all, given Magic Context upstream ships an 884-line
 * `message-index.ts` with its own FTS5 table, rowid map, dual watermark and
 * backfill state: none of that is needed here. DSH already mounts a
 * session-query service whose sqlite backend indexes every event of every
 * session (`@deepseek-ai/dsh-session-query-sqlite`), and `searchEvents` answers
 * exactly the question this lane asks — ranked, paginated hits inside one
 * session. Re-indexing the same rows a second time would double the write path
 * and drift out of sync with the host's own reconciliation, for no capability
 * gain.
 *
 * The two things upstream's indexer does that the host's does not are handled
 * by NOT asking for them:
 *   - it filters out the live tail (everything after the last compartment) so
 *     the model cannot be handed back content already in its window. Here the
 *     whole tail IS the window, so the caller passes the cutoff explicitly;
 *   - it strips system reminders / task notifications before indexing. The host
 *     indexes the persisted event text as-is; the snippet is truncated to a few
 *     hundred characters anyway, so the noise never reaches the model in bulk.
 *
 * Failure discipline: the host ships the index DISABLED (`openAt: never` in the
 * base bundle) and `searchEvents` then throws `SESSION_QUERY_SEARCH_DISABLED`.
 * That is a deployment fact, not an error the agent should retry, so it maps to
 * a quiet `disabled` outcome the tool reports in one line.
 */

/** One ranked history hit, already shaped for the tool's renderer. */
export interface MessageHit {
  readonly seq: number
  readonly type: string
  readonly time: number
  /** Truncated, marked-up snippet from the host index. */
  readonly snippet: string
  /** True when this hit is still visible on the model's surface. */
  readonly live: boolean
}

export type MessageSearchOutcome =
  | { readonly ok: true; readonly hits: readonly MessageHit[] }
  /** The deployment did not turn the session index on. Nothing to retry. */
  | { readonly ok: false; readonly reason: 'disabled' }
  | { readonly ok: false; readonly reason: string }

/**
 * The slice of `ctx.sessionQuery` this lane uses. Structural on purpose: the
 * package must mount on a host whose session-query package is a different minor
 * version, and an `import type` from it would make a missing service a mount
 * failure instead of a graceful degradation.
 */
export interface SessionQueryLike {
  searchEvents(
    request: {
      readonly sessionId: string
      readonly query: string
      readonly limit?: number
      readonly cursor?: string
    },
    exec?: unknown,
  ): Promise<{
    readonly items: readonly {
      readonly seq: number
      readonly type: string
      readonly time: number
      readonly snippet?: string
    }[]
  }>
}

/** Error code the host raises when the index is configured `openAt: never`. */
export const SEARCH_DISABLED_CODE = 'SESSION_QUERY_SEARCH_DISABLED'

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const candidate = (error as { code?: unknown }).code
  return typeof candidate === 'string' ? candidate : undefined
}

/**
 * Search one session's persisted history.
 *
 * `liveSeqs` is the set of event seqs the model's current surface still shows.
 * Hits inside it are dropped: they are already in the window, so returning them
 * spends output tokens to say what the model just read (MC `messageOrdinalCutoff`
 * exists for the same reason). Absent = no filtering, which is what a caller
 * with no surface (headless replay) wants.
 */
export async function searchMessageHistory(
  sessionQuery: SessionQueryLike | undefined,
  request: {
    readonly sessionId: string
    readonly query: string
    readonly limit?: number
    /** Seqs still visible on the surface; hits inside this set are dropped. */
    readonly liveSeqs?: ReadonlySet<number>
    readonly signal?: AbortSignal
  },
): Promise<MessageSearchOutcome> {
  if (sessionQuery === undefined) {
    return { ok: false, reason: 'the host exposes no session index' }
  }
  const trimmed = request.query.trim()
  if (trimmed.length === 0) return { ok: true, hits: [] }
  if (request.signal?.aborted === true) return { ok: true, hits: [] }
  try {
    const page = await sessionQuery.searchEvents({
      sessionId: request.sessionId,
      query: trimmed,
      // Over-fetch: the live tail may swallow a large share of the raw hits,
      // and the caller wants `limit` survivors, not `limit` minus drops.
      limit: Math.max(1, Math.min(100, (request.limit ?? 10) * 3)),
    })
    const live = request.liveSeqs
    const hits: MessageHit[] = []
    for (const item of page.items) {
      const isLive = live?.has(item.seq) === true
      if (isLive) continue
      hits.push({
        seq: item.seq,
        type: item.type,
        time: item.time,
        snippet: item.snippet ?? '',
        live: false,
      })
      if (hits.length >= (request.limit ?? 10)) break
    }
    return { ok: true, hits }
  } catch (error) {
    if (codeOf(error) === SEARCH_DISABLED_CODE) return { ok: false, reason: 'disabled' }
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
