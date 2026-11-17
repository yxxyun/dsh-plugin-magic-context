/**
 * `ctx_expand`'s tool surface: which channel a call reaches, and what it says
 * when a channel is unavailable.
 *
 * The two number spaces are the whole contract. A tag number and an event seq
 * look identical (`7`), point at different things, and the agent has no way to
 * tell them apart from the number alone — so the mode selection has to be
 * deterministic and the refusals have to name the other channel.
 *
 * These specs drive `execute` with a fake host session and a fake
 * `ctx.sessionQuery`, so they pin behaviour rather than the wiring.
 */
import { describe, expect, it } from 'vitest'
import { defineCtxExpandTool } from '../src/dsh/tool-bridge.ts'
import type { LocalDefineTool, ToolBridgeDeps } from '../src/dsh/tool-bridge.ts'
import type { AdapterStores } from '../src/core/stores.ts'
import type { SessionEventLike, SessionQueryReadLike } from '../src/core/session-history.ts'

type Args = {
  readonly tags?: string
  readonly message?: number
  readonly start?: number
  readonly end?: number
  readonly verbose?: boolean
}

interface Captured {
  readonly description: string
  readonly parameters: Record<string, { readonly type: string; readonly required?: boolean }>
  execute(args: Args, exec: unknown): Promise<unknown>
  readonly output: { render(args: Args, value: unknown): { readonly text?: string }[] }
}

/** Capture the options the tool registers, with no store or host involved. */
function capture(deps: Partial<ToolBridgeDeps> = {}): Captured {
  const holder: { options?: Captured } = {}
  const defineTool: LocalDefineTool = ((options: Captured) => {
    holder.options = options
    return options
  }) as unknown as LocalDefineTool
  defineCtxExpandTool({
    stores: {} as AdapterStores,
    defineTool,
    ...deps,
  })
  const options = holder.options
  if (options === undefined) throw new Error('defineCtxExpandTool registered nothing')
  return options
}

/** An exec carrying only what the tool reads: the session id. */
const exec = { agent: { session: { id: 'sess-1' } } }

function fakeQuery(events: readonly SessionEventLike[]): SessionQueryReadLike {
  const bySeq = new Map(events.map(event => [event.seq, event] as const))
  return {
    async readEvent(request) {
      const target = bySeq.get(request.seq)
      if (target === undefined) {
        const error = new Error('no such event')
        ;(error as { code?: string }).code = 'SESSION_QUERY_EVENT_NOT_FOUND'
        throw error
      }
      return { target, events: [...events], startSeq: 0, endSeq: events.length - 1 }
    },
  }
}

const history = [
  { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'ask' }] } },
  { seq: 1, type: 'tool/call', data: { name: 'read', arguments: '{"path":"a.ts"}' } },
  { seq: 2, type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'file body' }] } } },
] as const

function textOf(value: unknown): string {
  const payload = value as { text?: string }
  return payload.text ?? ''
}

// ── description / parameters ────────────────────────────────────────────────

describe('ctx_expand surface', () => {
  it('advertises both number spaces and keeps every argument optional', () => {
    // A required argument would make the model fill it with a placeholder just
    // to satisfy the schema, and the two channels would then always collide.
    const tool = capture()
    expect(Object.keys(tool.parameters).sort()).toEqual(['end', 'message', 'start', 'tags', 'verbose'])
    for (const name of Object.keys(tool.parameters)) {
      expect(tool.parameters[name]?.required).toBeUndefined()
    }
  })

  it('states that tags and event seqs are different numbers', () => {
    const description = capture().description
    expect(description).toContain('never interchangeable')
    expect(description).toContain('message=N')
    expect(description).toContain('verbose=true')
    expect(description).toContain('15K tokens')
  })
})

// ── message channel ─────────────────────────────────────────────────────────

describe('ctx_expand message=<seq>', () => {
  it('returns one event in full, with its seq and label', async () => {
    const tool = capture({ sessionQueryOf: () => fakeQuery(history) })
    const value = await tool.execute({ message: 2 }, exec)
    expect(textOf(value)).toBe('[2] tool result — full recovery:\n\nfile body')
  })

  it('recovers a tool call input and output the tag channel could no longer reach', async () => {
    // The point of the channel: no placeholder exists anywhere in this fixture.
    const tool = capture({ sessionQueryOf: () => fakeQuery(history) })
    expect(textOf(await tool.execute({ message: 1 }, exec))).toContain('arguments: {"path":"a.ts"}')
  })

  it('says the event was deleted when the seq is absent', async () => {
    const tool = capture({ sessionQueryOf: () => fakeQuery(history) })
    const text = textOf(await tool.execute({ message: 99 }, exec))
    expect(text).toContain('No event at seq 99')
    expect(text).toContain('deleted')
  })

  it('says so when the event held only structural content', async () => {
    const tool = capture({
      sessionQueryOf: () => fakeQuery([{ seq: 0, type: 'step/start', data: {} }]),
    })
    const text = textOf(await tool.execute({ message: 0 }, exec))
    expect(text).toContain('no recoverable content')
  })
})

// ── range channel ───────────────────────────────────────────────────────────

describe('ctx_expand start/end', () => {
  it('renders the range and tells the agent how to resume', async () => {
    const tool = capture({ sessionQueryOf: () => fakeQuery(history) })
    const text = textOf(await tool.execute({ start: 0, end: 2 }, exec))
    expect(text).toContain('Events 0-2.')
    expect(text).toContain('ctx_expand(message=<seq>)')
    expect(text).toContain('[0] U (user)')
    expect(text).toContain('[2] tool result')
  })

  it('swaps the order of a reversed range instead of returning nothing', async () => {
    const tool = capture({ sessionQueryOf: () => fakeQuery(history) })
    const text = textOf(await tool.execute({ start: 2, end: 0 }, exec))
    expect(text).toContain('[0] U (user)')
  })

  it('previews each event in verbose mode', async () => {
    const tool = capture({ sessionQueryOf: () => fakeQuery(history) })
    const text = textOf(await tool.execute({ start: 0, end: 2, verbose: true }, exec))
    expect(text).toContain('(verbose)')
    expect(text).toContain('• ask')
  })

  it('reports an empty range rather than an empty string', async () => {
    const tool = capture({ sessionQueryOf: () => fakeQuery(history) })
    const text = textOf(await tool.execute({ start: 40, end: 50 }, exec))
    expect(text).toContain('No recoverable events in range 40-50')
  })
})

// ── channel selection and degradation ───────────────────────────────────────

describe('ctx_expand channel selection', () => {
  it('prefers the tag channel when tags were named', async () => {
    // A surface item was explicitly asked for; history must not shadow it.
    const tool = capture({
      sessionQueryOf: () => {
        throw new Error('history must not be consulted when tags were named')
      },
    })
    // An empty surface: the tag cannot resolve, which is exactly what proves
    // the call went down the tag channel instead of the history one.
    const emptySurface = { agent: { session: { id: 'sess-1', snapshotEvents: () => [], surface: { nodes: [] } } } }
    const value = await tool.execute({ tags: '7', message: 1 }, emptySurface)
    expect(textOf(value)).toBe('')
    expect(JSON.stringify(value)).toContain('no dropped item carries this tag')
  })

  it('treats an empty tags string as "no tags"', async () => {
    const tool = capture({ sessionQueryOf: () => fakeQuery(history) })
    const text = textOf(await tool.execute({ tags: '   ', message: 0 }, exec))
    expect(text).toContain('full recovery')
  })

  it('explains the deployment when history is unavailable', async () => {
    // `ctx.sessionQuery` is a soft service: absent is a deployment fact, not a
    // failure the agent should retry.
    const tool = capture({ sessionQueryOf: () => undefined })
    const text = textOf(await tool.execute({ message: 1 }, exec))
    expect(text).toContain('Stored history is unavailable')
    expect(text).toContain('tag channel')
  })

  it('reports a host read failure instead of throwing', async () => {
    const tool = capture({
      sessionQueryOf: () => ({
        async readEvent() {
          throw new Error('index offline')
        },
      }),
    })
    const text = textOf(await tool.execute({ message: 1 }, exec))
    expect(text).toBe('History read failed: index offline')
  })

  it('answers without a session instead of throwing', async () => {
    const tool = capture({ sessionQueryOf: () => fakeQuery(history) })
    const value = await tool.execute({ message: 1 }, {})
    expect(JSON.stringify(value)).toContain('no-session')
  })
})

// ── render ──────────────────────────────────────────────────────────────────

describe('ctx_expand render', () => {
  it('passes rendered history text straight through', () => {
    const tool = capture()
    expect(tool.output.render({ message: 1 }, { ok: true, text: 'recovered body' })[0]?.text).toBe('recovered body')
  })

  it('keeps the tag verdict rendering when there is no text', () => {
    const tool = capture()
    expect(tool.output.render({ tags: '3' }, { ok: true, restored: [3], refused: [] })[0]?.text)
      .toBe('Restored in full: §3§.')
  })

  it('names the working channel when a tag no longer exists', () => {
    // The dead end this whole change exists to remove: "not found" alone leaves
    // the agent retrying a number that can never resolve again.
    const tool = capture()
    const rendered = tool.output.render({ tags: '3' }, {
      ok: true,
      restored: [],
      refused: [{ tag: 3, ok: false, reason: 'no dropped item carries this tag on the current surface — its message was folded into a compartment. Recover it from stored history instead: ctx_search for the content, then ctx_expand(message=<seq>) or ctx_expand(start, end)' }],
    })
    expect(rendered[0]?.text).toContain('folded into a compartment')
    expect(rendered[0]?.text).toContain('ctx_expand(message=<seq>)')
  })
})
