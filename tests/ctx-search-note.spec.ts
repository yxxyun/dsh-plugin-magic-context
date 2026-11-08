/**
 * `ctx_search` and `ctx_note` — the two tools that make the adapter carry what
 * upstream Magic Context carries but the DSH port did not: a way back to raw
 * conversation history, and a queue of parked intentions.
 *
 * Why this file exists: both tools shipped without a single test. The stores
 * half (schema v11 `notes`) was only covered indirectly by the schema pin, and
 * the search tool's most likely production shape — a host whose session index
 * is DISABLED, which is the shipped default (`openAt: never` in the base
 * bundle) — was never exercised at all. A lane that throws instead of
 * degrading would take the whole tool call down on every stock desktop profile.
 *
 * Covered here:
 *  1. notes CRUD through the store: create / list / get / update / dismiss are
 *     scoped by session OR project (union, not intersection) and dismissal is
 *     sticky.
 *  2. `ctx_note`'s four actions through the tool boundary, including the
 *     refusals (empty content, two ids for update, 51 ids for dismiss).
 *  3. `ctx_search` degrades to a one-line note when the session index is
 *     disabled, and still answers from notes it can see.
 *  4. `ctx_search` drops hits that are still on the model's surface (the live
 *     tail) instead of spending output tokens echoing the window.
 *  5. no lane, no query: the tool says so instead of returning an empty blob.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openStores, type AdapterStores } from '../src/core/stores.ts'
import {
  defineCtxNoteTool,
  defineCtxSearchTool,
  type LocalDefineTool,
} from '../src/dsh/tool-bridge.ts'
import { searchMessageHistory, type SessionQueryLike } from '../src/core/message-search.ts'

const dirs: string[] = []
const opened: Array<{ close(): void }> = []

function tempStore(): AdapterStores {
  const dir = mkdtempSync(join(tmpdir(), 'mc-search-note-'))
  dirs.push(dir)
  const stores = openStores(dir)
  opened.push(stores)
  return stores
}

afterEach(() => {
  for (const store of opened.splice(0).reverse()) {
    try {
      store.close()
    } catch {
      /* best effort: a failed assertion must not mask the real error */
    }
  }
  for (const dir of dirs.splice(0).reverse()) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
  }
})

interface Captured<A> {
  readonly options: {
    readonly name: string
    readonly parameters: Record<string, { readonly type: string; readonly enum?: readonly string[] }>
    readonly output: { readonly render: (args: A, value: unknown) => { readonly text?: string }[] }
    readonly execute: (args: A, exec: unknown) => Promise<unknown>
  }
}

/** Capture the definition the tool registers, then drive it directly. */
function capture<A>(build: (defineTool: LocalDefineTool) => unknown): Captured<A> {
  const holder: { options?: Captured<A>['options'] } = {}
  const defineTool = ((options: Captured<A>['options']) => {
    holder.options = options
    return options
  }) as unknown as LocalDefineTool
  build(defineTool)
  const options = holder.options
  if (options === undefined) throw new Error('the tool did not register a definition')
  return { options }
}

const CWD = 'D:/work/project'
const NOW = 1_700_000_000_000

function execAt(cwd: string = CWD, sessionId = 'ses-search'): unknown {
  return { agent: { session: { id: sessionId, header: { cwd } } } }
}

const textOf = (blocks: readonly { readonly text?: string }[]): string =>
  blocks.map(block => block.text ?? '').join('\n')

// ── the store half ────────────────────────────────────────────────────────

describe('notes store (schema v11)', () => {
  it('round-trips a note and dismisses it without deleting the row', () => {
    const stores = tempStore()
    const row = stores.createNote({ content: 'revisit the fold threshold', sessionId: 's1', projectPath: CWD }, NOW)
    expect(row.id).toBeGreaterThan(0)
    expect(row.status).toBe('active')
    expect(row.type).toBe('session')

    const read = stores.getNote(row.id)
    expect(read?.content).toBe('revisit the fold threshold')

    const updated = stores.updateNote(row.id, 'revisit the fold threshold AFTER the split', NOW + 5)
    expect(updated?.content).toContain('AFTER the split')

    expect(stores.retireNotes([row.id], 'dismiss', NOW + 10)).toBe(1)
    // Dismissed, not deleted: the row is still readable by id, which is what
    // lets a later reader see that the thread was closed on purpose.
    expect(stores.getNote(row.id)?.status).toBe('dismissed')
    // ...and it is gone from every open listing.
    expect(stores.listNotes({ sessionId: 's1', status: 'open' })).toHaveLength(0)
    expect(stores.listNotes({ sessionId: 's1', status: 'dismissed' })).toHaveLength(1)
  })

  it('lists by session OR project, because a note is relevant to both', () => {
    const stores = tempStore()
    stores.createNote({ content: 'from this session', sessionId: 's1', projectPath: CWD }, NOW)
    stores.createNote({ content: 'from a sibling session', sessionId: 's2', projectPath: CWD }, NOW + 1)
    stores.createNote({ content: 'unrelated', sessionId: 's9', projectPath: 'D:/elsewhere' }, NOW + 2)

    const rows = stores.listNotes({ sessionId: 's1', projectPath: CWD, status: 'open' })
    const contents = rows.map(row => row.content)
    // Union, not intersection: the sibling session's parked thread is exactly
    // what a fresh session needs to pick up.
    expect(contents).toContain('from this session')
    expect(contents).toContain('from a sibling session')
    expect(contents).not.toContain('unrelated')
    // Newest first.
    expect(rows[0]?.content).toBe('from a sibling session')
  })

  it('deletes on request and prunes only what was dismissed before the cutoff', () => {
    const stores = tempStore()
    const keep = stores.createNote({ content: 'keep', sessionId: 's1' }, NOW)
    const gone = stores.createNote({ content: 'gone', sessionId: 's1' }, NOW)
    expect(stores.retireNotes([gone.id], 'delete', NOW)).toBe(1)
    expect(stores.getNote(gone.id)).toBeUndefined()

    expect(stores.retireNotes([keep.id], 'dismiss', NOW)).toBe(1)
    expect(stores.pruneNotes(NOW + 1)).toBe(1)
    expect(stores.getNote(keep.id)).toBeUndefined()
  })
})

// ── ctx_note ──────────────────────────────────────────────────────────────

describe('ctx_note', () => {
  it('writes, lists and reads back through the tool boundary', async () => {
    const stores = tempStore()
    const tool = capture<{ action: string; content?: string; note_ids?: readonly number[] }>(
      defineTool => defineCtxNoteTool({ defineTool, stores, anchorOrdinalOf: () => 42 }),
    )

    const written = await tool.options.execute({ action: 'write', content: 'finish the reranker gate' }, execAt())
    expect(textOf(tool.options.output.render({ action: 'write' }, written))).toMatch(/Saved note #\d+\./)

    const listed = await tool.options.execute({ action: 'read' }, execAt())
    const listing = textOf(tool.options.output.render({ action: 'read' }, listed))
    expect(listing).toContain('finish the reranker gate')
    // The queue is useless if nothing ever tells the agent how to close a row.
    expect(listing).toContain('ctx_note(action="dismiss"')

    const one = await tool.options.execute({ action: 'read', note_ids: [1] }, execAt())
    const detail = textOf(tool.options.output.render({ action: 'read' }, one))
    expect(detail).toContain('finish the reranker gate')
    expect(detail).toContain('active')

    // The anchor travelled with the write: a note records which message it
    // was parked on, so a later reader can expand that point in history.
    expect(stores.listNotes({ sessionId: 'ses-search', status: 'open' })[0]?.anchorOrdinal).toBe(42)
  })

  it('refuses the malformed calls instead of guessing', async () => {
    const stores = tempStore()
    const tool = capture<{ action: string; content?: string; note_ids?: readonly number[] }>(
      defineTool => defineCtxNoteTool({ defineTool, stores }),
    )
    const refusal = async (args: { action: string; content?: string; note_ids?: readonly number[] }): Promise<string> =>
      textOf(tool.options.output.render(args, await tool.options.execute(args, execAt())))

    expect(await refusal({ action: 'write', content: '   ' })).toContain('write needs content')
    expect(await refusal({ action: 'update', content: 'x' })).toContain('exactly one note id')
    const many = Array.from({ length: 51 }, (_, index) => index + 1)
    expect(await refusal({ action: 'dismiss', note_ids: many })).toContain('at most 50')
    expect(await refusal({ action: 'dismiss', note_ids: [] })).toContain('at least one')
    expect(await refusal({ action: 'nonsense' })).toContain('unknown action')
  })

  it('dismisses and reports the count', async () => {
    const stores = tempStore()
    const tool = capture<{ action: string; content?: string; note_ids?: readonly number[] }>(
      defineTool => defineCtxNoteTool({ defineTool, stores }),
    )
    for (const content of ['a', 'b', 'c']) {
      await tool.options.execute({ action: 'write', content }, execAt())
    }
    const ids = stores.listNotes({ sessionId: 'ses-search', status: 'open' }).map(row => row.id)
    expect(ids).toHaveLength(3)
    const dismissed = await tool.options.execute({ action: 'dismiss', note_ids: ids.slice(0, 2) }, execAt())
    expect(textOf(tool.options.output.render({ action: 'dismiss' }, dismissed))).toBe('Dismissed 2 note(s).')
  })
})

// ── message lane ──────────────────────────────────────────────────────────

describe('searchMessageHistory', () => {
  it('reports "disabled" for the shipped default instead of throwing', async () => {
    const disabled: SessionQueryLike = {
      searchEvents: () => Promise.reject(Object.assign(new Error('session search is disabled'), { code: 'SESSION_QUERY_SEARCH_DISABLED' })),
    }
    await expect(searchMessageHistory(disabled, { sessionId: 's1', query: 'anything' }))
      .resolves.toEqual({ ok: false, reason: 'disabled' })
  })

  it('reports a missing service as its own reason, not as "disabled"', async () => {
    const outcome = await searchMessageHistory(undefined, { sessionId: 's1', query: 'anything' })
    expect(outcome).toEqual({ ok: false, reason: 'the host exposes no session index' })
  })

  it('drops hits that are still visible on the surface and honours the limit', async () => {
    const seenLimits: number[] = []
    const stub: SessionQueryLike = {
      searchEvents: request => {
        seenLimits.push(request.limit ?? 0)
        return Promise.resolve({
          items: [
            { seq: 1, type: 'user/message', time: 1, snippet: 'live tail' },
            { seq: 2, type: 'user/message', time: 2, snippet: 'persisted hit' },
            { seq: 3, type: 'assistant/message', time: 3, snippet: 'second persisted hit' },
            { seq: 4, type: 'assistant/message', time: 4, snippet: 'over the limit' },
          ],
        })
      },
    }
    const outcome = await searchMessageHistory(stub, {
      sessionId: 's1',
      query: 'hit',
      limit: 2,
      liveSeqs: new Set([1]),
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.hits.map(hit => hit.seq)).toEqual([2, 3])
    // Over-fetch 3x: the live tail can swallow most raw hits, and the caller
    // asked for `limit` survivors, not `limit` minus drops.
    expect(seenLimits).toEqual([6])
  })
})

// ── ctx_search ────────────────────────────────────────────────────────────

describe('ctx_search', () => {
  it('turns a disabled session index into one note line and still finds notes', async () => {
    const stores = tempStore()
    stores.createNote({ content: 'the fold threshold is 65 percent', sessionId: 'ses-search', projectPath: CWD }, Date.now())
    const tool = capture<{ query: string; limit?: number; sources?: readonly string[] }>(
      defineTool => defineCtxSearchTool({ defineTool, stores }),
    )

    const result = await tool.options.execute({ query: 'fold threshold', sources: ['message', 'note'] }, execAt())
    const text = textOf(tool.options.output.render({ query: 'fold threshold' }, result))
    expect(text).toContain('the fold threshold is 65 percent')
    // `undefined` sessionQuery is the "host exposes no index" path; the tool
    // must say so rather than claim there is no history.
    expect(text).toContain('(message: the host exposes no session index)')
  })

  it('reports the openAt: never deployment in the agent\'s own words', async () => {
    const stores = tempStore()
    const tool = capture<{ query: string; sources?: readonly string[] }>(
      defineTool => defineCtxSearchTool({
        defineTool,
        stores,
        sessionQueryOf: () => ({
          searchEvents: () => Promise.reject(Object.assign(new Error('disabled'), { code: 'SESSION_QUERY_SEARCH_DISABLED' })),
        }),
      }),
    )
    const result = await tool.options.execute({ query: 'anything', sources: ['message'] }, execAt())
    expect(textOf(tool.options.output.render({ query: 'anything' }, result)))
      .toContain('the session index is disabled in this deployment (openAt: never)')
  })

  it('renders history hits with their seq so ctx_expand can reach them', async () => {
    const stores = tempStore()
    const tool = capture<{ query: string; sources?: readonly string[] }>(
      defineTool => defineCtxSearchTool({
        defineTool,
        stores,
        sessionQueryOf: () => ({
          searchEvents: () => Promise.resolve({
            items: [{ seq: 87, type: 'user/message', time: 5, snippet: 'we settled on 65 percent' }],
          }),
        }),
      }),
    )
    const result = await tool.options.execute({ query: 'settled', sources: ['message'] }, execAt())
    const text = textOf(tool.options.output.render({ query: 'settled' }, result))
    expect(text).toContain('[1] [message] seq=87 type=user/message')
    expect(text).toContain('we settled on 65 percent')
    expect(text).toContain('History (1 hit)')
  })

  it('hands the memory lane the project identity and reuses its rendered text', async () => {
    const stores = tempStore()
    const seen: Array<{ query: string; identity: string }> = []
    const tool = capture<{ query: string; sources?: readonly string[] }>(
      defineTool => defineCtxSearchTool({
        defineTool,
        stores,
        resolveIdentity: () => 'git:abc',
        search: request => {
          seen.push({ query: request.query, identity: request.identity })
          return Promise.resolve({
            ok: true,
            text: 'Memories (1 hit):\n\n[1] [memory] score=1.0 id=7 category=CONSTRAINTS\nfold at 65%',
            hits: [{ id: 7 }],
          })
        },
      }),
    )
    const result = await tool.options.execute({ query: 'fold', sources: ['memory'] }, execAt())
    const text = textOf(tool.options.output.render({ query: 'fold' }, result))
    expect(seen).toEqual([{ query: 'fold', identity: 'git:abc' }])
    // Verbatim from the memory lane: reformatting here would drift from what
    // `ctx_memory action="search"` prints for the same query.
    expect(text).toContain('[1] [memory] score=1.0 id=7 category=CONSTRAINTS')
  })

  it('says nothing was found instead of returning an empty payload', async () => {
    const stores = tempStore()
    const tool = capture<{ query: string; sources?: readonly string[] }>(
      defineTool => defineCtxSearchTool({ defineTool, stores }),
    )
    const result = await tool.options.execute({ query: 'nothing here', sources: ['note'] }, execAt())
    expect(textOf(tool.options.output.render({ query: 'nothing here' }, result)))
      .toContain('No results for "nothing here" across note.')
  })

  it('asks for a query rather than searching for the empty string', async () => {
    const stores = tempStore()
    const tool = capture<{ query: string }>(defineTool => defineCtxSearchTool({ defineTool, stores }))
    const result = await tool.options.execute({ query: '   ' }, execAt())
    expect(textOf(tool.options.output.render({ query: '' }, result))).toContain('ctx_search needs a query')
  })
})
