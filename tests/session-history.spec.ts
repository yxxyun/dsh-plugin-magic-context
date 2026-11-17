/**
 * The history channel of `ctx_expand` — `message=<seq>` and `start`/`end`.
 *
 * Why this channel exists at all: the tag channel only works while the
 * `[dropped §N§]` placeholder is still on the surface. The moment the message
 * carrying it is folded into a compartment, `management-pass` retires the drop
 * with `target-gone`, the placeholder leaves with the message, and
 * `ctx_expand(tags="N")` can only answer "no dropped item carries this tag".
 * Measured 2026-11-17: 1508 drop rows, 76 compartments — the dead end is the
 * normal case, not an edge one.
 *
 * The host exposes the way back as `ctx.sessionQuery.readEvent`, which returns
 * one complete `SessionEvent` from the persisted log regardless of surface
 * state. `listEvents` is NOT usable for this: it returns
 * `buildSessionEventRecords` output (`{seq, type, time, surface}`), no content.
 *
 * Everything here drives the real renderers with structural fixtures — no host,
 * no session, no store.
 */
import { describe, expect, it } from 'vitest'
import {
  CTX_EXPAND_TOKEN_BUDGET,
  EVENT_NOT_FOUND_CODE,
  READ_EVENT_WINDOW_MAX,
  eventLabel,
  readEventBySeq,
  readEventRange,
  renderEventFull,
  renderEventPreview,
  type SessionEventLike,
  type SessionQueryReadLike,
} from '../src/core/session-history.ts'

// ── fixtures ────────────────────────────────────────────────────────────────

function userMessage(seq: number, text: string): SessionEventLike {
  return { seq, type: 'user/message', time: 1_700_000_000_000, data: { content: [{ type: 'text', text }] } }
}

function assistantMessage(seq: number, text: string): SessionEventLike {
  return {
    seq,
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text }] } },
  }
}

function toolCall(seq: number, name: string, args: string): SessionEventLike {
  return { seq, type: 'tool/call', data: { name, arguments: args } }
}

function toolResult(seq: number, text: string): SessionEventLike {
  return { seq, type: 'tool/result', data: { message: { content: [{ type: 'text', text }] } } }
}

function toolError(seq: number, name: string, code: string, message: string): SessionEventLike {
  return { seq, type: 'tool/result', data: { message: { content: [] }, error: { name, code, message } } }
}

/** A fake `ctx.sessionQuery` over a dense event array, honouring the window cap. */
function fakeQuery(events: readonly SessionEventLike[]): SessionQueryReadLike & { calls: number } {
  const bySeq = new Map(events.map(event => [event.seq, event] as const))
  const query = {
    calls: 0,
    async readEvent(request: { sessionId: string; seq: number; before?: number; after?: number }) {
      query.calls += 1
      const before = Math.min(request.before ?? 0, READ_EVENT_WINDOW_MAX)
      const after = Math.min(request.after ?? 0, READ_EVENT_WINDOW_MAX)
      const target = bySeq.get(request.seq)
      if (target === undefined) {
        const error = new Error(`session has no event at seq ${String(request.seq)}`)
        ;(error as { code?: string }).code = EVENT_NOT_FOUND_CODE
        throw error
      }
      // The host treats seq as a dense index into the log, so the last existing
      // seq is the last event's own seq — not `length - 1` (that only agrees
      // when the log starts at 0).
      const maxSeq = events.length === 0 ? -1 : (events[events.length - 1] as SessionEventLike).seq
      const startSeq = Math.max(0, request.seq - before)
      const endSeq = Math.min(maxSeq, request.seq + after)
      return {
        target,
        events: events.filter(event => event.seq >= startSeq && event.seq <= endSeq),
        startSeq,
        endSeq,
      }
    },
  }
  return query as unknown as SessionQueryReadLike & { calls: number }
}

// ── renderEventFull ─────────────────────────────────────────────────────────

describe('renderEventFull', () => {
  it('renders a user message verbatim', () => {
    expect(renderEventFull(userMessage(3, 'what changed in the lease?'))).toBe('what changed in the lease?')
  })

  it('renders an assistant message from data.message.content, not data.content', () => {
    // The two roles nest their blocks differently (`assistant/message` puts them
    // under `data.message.content`); reading the wrong field yields null and the
    // recovery silently reports "no content" for every reply.
    expect(renderEventFull(assistantMessage(4, 'the TTL is 15 minutes'))).toBe('the TTL is 15 minutes')
  })

  it('renders a tool call with its full argument string', () => {
    const event = toolCall(5, 'grep', '{"pattern":"dreamTick","path":"src"}')
    expect(renderEventFull(event)).toBe('[tool: grep]\n  arguments: {"pattern":"dreamTick","path":"src"}')
  })

  it('renders a tool result with its complete output', () => {
    const output = 'x'.repeat(5_000)
    expect(renderEventFull(toolResult(6, output))).toBe(output)
  })

  it('renders a tool error even when the result carried no content', () => {
    expect(renderEventFull(toolError(7, 'ReadError', 'ENOENT', 'no such file'))).toBe(
      '[error] ReadError: ENOENT: no such file',
    )
  })

  it('renders todos', () => {
    const event: SessionEventLike = {
      seq: 8,
      type: 'todo/write',
      data: { todos: [{ status: 'in_progress', content: 'ship the channel' }, { status: 'pending', content: 'push' }] },
    }
    expect(renderEventFull(event)).toBe('- [in_progress] ship the channel\n- [pending] push')
  })

  it('renders a turn-end error', () => {
    const event: SessionEventLike = {
      seq: 9,
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: 'provider 500' } } },
    }
    expect(renderEventFull(event)).toBe('[turn ended: error] provider 500')
  })

  it('returns null for structural events', () => {
    for (const type of ['turn/start', 'step/start', 'step/end', 'assistant/attempt', 'request/header']) {
      expect(renderEventFull({ seq: 10, type, data: {} })).toBeNull()
    }
  })

  it('returns null when the only content was reasoning', () => {
    // Upstream drops reasoning from the recovery view too: it is not the
    // evidence an agent came back for, and printing it spends the budget.
    const event: SessionEventLike = {
      seq: 11,
      type: 'assistant/message',
      data: { message: { content: [{ type: 'reasoning', text: 'let me think…' }] } },
    }
    expect(renderEventFull(event)).toBeNull()
  })

  it('keeps a tool-call block inside a message body', () => {
    const event: SessionEventLike = {
      seq: 12,
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'text', text: 'reading the file' },
            { type: 'tool-call', name: 'read', arguments: '{"path":"a.ts"}' },
          ],
        },
      },
    }
    expect(renderEventFull(event)).toBe('reading the file\n[tool-call read] {"path":"a.ts"}')
  })
})

// ── renderEventPreview ──────────────────────────────────────────────────────

describe('renderEventPreview', () => {
  it('collapses whitespace, truncates and reports the full size', () => {
    const preview = renderEventPreview(toolResult(13, 'line\n'.repeat(400)))
    expect(preview).toMatch(/^ {4}• line line/)
    expect(preview).toContain('…')
    expect(preview).toMatch(/\(~\d+ tok\)$/)
  })

  it('is null exactly where the full render is null', () => {
    expect(renderEventPreview({ seq: 14, type: 'step/start', data: {} })).toBeNull()
  })
})

describe('eventLabel', () => {
  it('names the two roles and the tool halves', () => {
    expect(eventLabel(userMessage(1, 'x'))).toBe('U (user)')
    expect(eventLabel(assistantMessage(2, 'x'))).toBe('A (assistant)')
    expect(eventLabel(toolCall(3, 'grep', ''))).toBe('tool call')
    expect(eventLabel(toolResult(4, 'x'))).toBe('tool result')
  })
})

// ── readEventBySeq ──────────────────────────────────────────────────────────

describe('readEventBySeq', () => {
  it('returns the event at that seq', async () => {
    const query = fakeQuery([userMessage(1, 'a'), assistantMessage(2, 'b')])
    expect(await readEventBySeq(query, 's', 2)).toMatchObject({ seq: 2, type: 'assistant/message' })
  })

  it('returns undefined when the host reports the seq missing', async () => {
    // Deleted history is a normal answer, not an exception: the caller turns it
    // into "it was deleted, re-run the tool" rather than a thrown error.
    const query = fakeQuery([userMessage(1, 'a')])
    expect(await readEventBySeq(query, 's', 99)).toBeUndefined()
  })

  it('rethrows a host failure that is not "not found"', async () => {
    const query = {
      async readEvent() {
        throw new Error('index offline')
      },
    } as unknown as SessionQueryReadLike
    await expect(readEventBySeq(query, 's', 1)).rejects.toThrow('index offline')
  })
})

// ── readEventRange ──────────────────────────────────────────────────────────

describe('readEventRange', () => {
  it('renders a small range in seq order', async () => {
    const query = fakeQuery([
      userMessage(1, 'first'),
      assistantMessage(2, 'second'),
      toolResult(3, 'third'),
    ])
    const result = await readEventRange(query, 's', 1, 3, CTX_EXPAND_TOKEN_BUDGET)
    expect(result.empty).toBe(false)
    expect(result.truncated).toBe(false)
    expect(result.lastSeq).toBe(3)
    expect(result.blocks).toEqual([
      '[1] U (user)\nfirst',
      '[2] A (assistant)\nsecond',
      '[3] tool result\nthird',
    ])
  })

  it('skips structural events but still advances lastSeq past them', async () => {
    const query = fakeQuery([
      userMessage(1, 'hello'),
      { seq: 2, type: 'step/start', data: {} },
      assistantMessage(3, 'world'),
    ])
    const result = await readEventRange(query, 's', 1, 3, CTX_EXPAND_TOKEN_BUDGET)
    expect(result.blocks.map(block => block.split('\n')[0])).toEqual(['[1] U (user)', '[3] A (assistant)'])
    expect(result.lastSeq).toBe(3)
  })

  it('pages past the host window cap instead of loading the whole range', async () => {
    // 120 events against a 50-event window: a single readEvent cannot cover it,
    // and the loop must not silently return only the first window.
    const events = Array.from({ length: 120 }, (_, index) => userMessage(index + 1, `m${String(index + 1)}`))
    const query = fakeQuery(events)
    const result = await readEventRange(query, 's', 1, 120, CTX_EXPAND_TOKEN_BUDGET)
    expect(result.blocks).toHaveLength(120)
    expect(result.lastSeq).toBe(120)
    expect(query.calls).toBeGreaterThanOrEqual(3)
  })

  it('stops on the token budget and reports where to continue', async () => {
    const events = Array.from({ length: 60 }, (_, index) =>
      toolResult(index + 1, 'y'.repeat(2_000)))
    const query = fakeQuery(events)
    const result = await readEventRange(query, 's', 1, 60, 3_000)
    expect(result.truncated).toBe(true)
    expect(result.blocks.length).toBeGreaterThan(0)
    expect(result.blocks.length).toBeLessThan(60)
    // lastSeq is the last block actually returned, so `start=lastSeq+1` resumes.
    expect(result.lastSeq).toBeLessThan(60)
  })

  it('renders at least one block even when a single block exceeds the budget', async () => {
    // Otherwise a huge tool output would make the range permanently empty.
    const query = fakeQuery([toolResult(1, 'z'.repeat(80_000))])
    const result = await readEventRange(query, 's', 1, 1, 100)
    expect(result.blocks).toHaveLength(1)
    expect(result.empty).toBe(false)
  })

  it('reports empty when the range holds nothing recoverable', async () => {
    const query = fakeQuery([{ seq: 1, type: 'step/start', data: {} }])
    const result = await readEventRange(query, 's', 1, 1, CTX_EXPAND_TOKEN_BUDGET)
    expect(result.empty).toBe(true)
    expect(result.blocks).toEqual([])
  })

  it('reports empty for a range entirely past the end of history', async () => {
    const query = fakeQuery([userMessage(1, 'only')])
    const result = await readEventRange(query, 's', 50, 60, CTX_EXPAND_TOKEN_BUDGET)
    expect(result.empty).toBe(true)
  })

  it('verbose previews each event separately instead of the transcript', async () => {
    const query = fakeQuery([userMessage(1, 'alpha'), toolResult(2, 'beta')])
    const result = await readEventRange(query, 's', 1, 2, CTX_EXPAND_TOKEN_BUDGET, { verbose: true })
    expect(result.blocks[0]).toBe('[1] U (user)\n    • alpha (~2 tok)')
    expect(result.blocks[1]).toContain('• beta')
  })
})
