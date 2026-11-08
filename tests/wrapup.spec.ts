/**
 * `/ctx-wrapup` — the manual checkpoint that does NOT need the compaction
 * engine.
 *
 * Why this file exists: `/ctx-wrapup` is the one upstream entry point this
 * adapter had no path to at all. It used to live behind
 * `registerCompactionEngine`, which is off by default because mounting the
 * engine takes over `ctx.compaction` and fights the host's `compaction-basic`;
 * so "wrap up before we switch tasks" was unreachable in every shipped
 * composition. Pinned here:
 *  1. the keep-argument parser (absent / integer / everything else);
 *  2. `pickManualSpan` eligibility — system head, the baseline node, covered
 *     seqs, placeholders and tool-tail boundaries all stay out, and a span
 *     under `historianMinNodes` yields nothing rather than a one-line digest;
 *  3. `writeManualCheckpoint` protocol order and surface replacement — the
 *     transcript keeps `§checkpoint§`, the originals stay in the log;
 *  4. the command is accepted by the real command service, and its refusals
 *     (historian off, bad argument, nothing eligible) are refusals — a success
 *     with an empty summary would teach the model that the history is gone.
 */
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_POLICY, type PressurePolicy } from '../src/core/policy.ts'
import { openStores, type AdapterStores } from '../src/core/stores.ts'
import { pickManualSpan, writeManualCheckpoint } from '../src/dsh/manual-compaction.ts'
import type { Session, SurfaceNode } from '../src/dsh/seams.ts'
import { WRAPUP_USAGE, parseWrapupKeep, registerCtxWrapupCommand } from '../src/dsh/wrapup.ts'
import { scriptLlm } from './helpers/llm-fake'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
  }
})

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), name))
  tempDirs.push(dir)
  return dir
}

function tempStores(name: string): AdapterStores {
  const stores = openStores(tempDir(name))
  open.push(stores)
  return stores
}

const open: AdapterStores[] = []
afterEach(() => {
  for (const stores of open.splice(0)) {
    if (!stores.closed) stores.close()
  }
})

const noopLogger = { info: () => {}, warn: () => {} }

/** What the historian is scripted to answer. */
const DIGEST = JSON.stringify({
  summary: { p1: 'WRAPUP-P1', p2: 'wrapup p2', p3: 'wrapup p3', p4: 'wrapup p4' },
  importance: 61,
  facts: [{ category: 'CONSTRAINTS', content: 'the wire keeps §checkpoint§' }],
  events: ['wrapped up'],
})

interface FakeEvent {
  seq: number
  type: string
  data: unknown
  surfaceOp?: { op: string; startSeq: number; endSeq: number }
  sourceEventSeqs?: number[]
}

/**
 * A durable surface that behaves like the host's: one node per event, ordered,
 * and a `replace` op splices the shadowed range and appends the replacement.
 */
function makeSession(): {
  session: Session
  events: () => readonly FakeEvent[]
  nodes: () => readonly number[]
  appendTypes: () => readonly string[]
  push: (type: string, data: unknown) => number
} {
  let nextSeq = 1
  let replaceGeneration = 0
  const events: FakeEvent[] = []
  const nodes: number[] = []
  const append = (
    type: string,
    data: unknown,
    options?: { surfaceOp?: { op: string; startSeq: number; endSeq: number }; sourceEventSeqs?: number[] },
  ): { seq: number } => {
    replaceGeneration += 1
    const seq = nextSeq
    nextSeq += 1
    events.push({ seq, type, data, ...options === undefined ? {} : options })
    const op = options?.surfaceOp
    if (op !== undefined && op.op === 'replace') {
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const current = nodes[index] as number
        if (current >= op.startSeq && current <= op.endSeq) nodes.splice(index, 1)
      }
    }
    nodes.push(seq)
    return { seq }
  }
  const session = {
    id: 'ses-wrapup',
    get surface() {
      return { nodes, replaceGeneration }
    },
    snapshotEvents: () => events,
    append,
  }
  return {
    session: session as unknown as Session,
    events: () => events,
    nodes: () => nodes,
    appendTypes: () => events.map(event => event.type),
    push: (type, data) => append(type, data).seq,
  }
}

/** A surface node as `enumerateSurfaceNodes` would hand it over. */
function node(seq: number, role: SurfaceNode['role'], text: string, extra: Partial<SurfaceNode> = {}): SurfaceNode {
  return {
    seq: seq as never,
    type: `${role}/message`,
    role,
    text,
    hasText: text.trim().length > 0,
    isPlaceholder: /^\[(?:dropped|compacted|checkpoint) §/.test(text.trim()),
    hasToolCalls: false,
    ...extra,
  }
}

const policy: PressurePolicy = { ...DEFAULT_POLICY, historianProtectedNodes: 2, historianMinNodes: 3 }

describe('parseWrapupKeep', () => {
  it('treats an absent argument as "use the policy default"', () => {
    expect(parseWrapupKeep(undefined)).toBeUndefined()
    expect(parseWrapupKeep('')).toBeUndefined()
    expect(parseWrapupKeep('   ')).toBeUndefined()
  })

  it('accepts a plain non-negative integer, including zero', () => {
    expect(parseWrapupKeep('0')).toBe(0)
    expect(parseWrapupKeep(' 12 ')).toBe(12)
  })

  it('refuses everything else with the usage line', () => {
    for (const raw of ['-1', '1.5', 'ten', '5k', '1e3']) {
      expect(parseWrapupKeep(raw)).toBe(WRAPUP_USAGE)
    }
    expect(parseWrapupKeep('99999999999999999999')).toBe(WRAPUP_USAGE)
  })
})

describe('pickManualSpan', () => {
  it('skips an ineligible head and never starts on a placeholder', () => {
    const stores = tempStores('mc-wrapup-span-')
    const nodes = [
      node(1, 'system', 'you are a helpful agent'),
      node(2, 'user', '[dropped §7§]'),
      node(3, 'user', 'first question'),
      node(4, 'assistant', 'first answer'),
      node(5, 'user', 'second question'),
      node(6, 'assistant', 'second answer'),
    ]
    const span = pickManualSpan(nodes, stores, 'ses-wrapup', policy, 0)
    // The system head and the leading placeholder stay out; everything from the
    // first eligible node on is folded as one range (an interior placeholder is
    // already a placeholder, so folding it costs nothing).
    expect(span.map(item => Number(item.seq))).toEqual([3, 4, 5, 6])
  })

  it('honours the covered set written by an earlier checkpoint', () => {
    const stores = tempStores('mc-wrapup-covered-')
    const created = stores.allocateCompartment(
      'ses-wrapup',
      { tiers: { p1: 'OLD', p2: '', p3: '', p4: '' }, importance: 10, facts: [], events: [] },
      { startSeq: 1, endSeq: 2, seqs: [1, 2], tokens: 20 },
      1,
      Date.now(),
    )
    stores.markCompartmentLanded('ses-wrapup', created.compartmentId, 99)
    expect([...stores.coveredSeqs('ses-wrapup')]).toEqual([1, 2])
    const nodes = [node(1, 'user', 'q1'), node(2, 'assistant', 'a1'), node(3, 'user', 'q2'), node(4, 'assistant', 'a2'), node(5, 'user', 'q3')]
    const span = pickManualSpan(nodes, stores, 'ses-wrapup', policy, 0)
    expect(span.map(item => Number(item.seq))).toEqual([3, 4, 5])
  })

  it('honours the keep override and never cuts inside a tool tail', () => {
    const stores = tempStores('mc-wrapup-keep-')
    const nodes = [
      node(1, 'user', 'q1'),
      node(2, 'assistant', 'a1'),
      node(3, 'user', 'q2'),
      node(4, 'assistant', 'a2', { hasToolCalls: true, toolCallIds: ['call-1'] }),
      node(5, 'tool', 'tool output'),
    ]
    // Keeping the newest 1 node would cut between the assistant call and its
    // result; the picker walks back to the pairing boundary instead.
    const span = pickManualSpan(nodes, stores, 'ses-wrapup', policy, 1)
    expect(span.map(item => Number(item.seq))).toEqual([1, 2, 3])
  })

  it('returns nothing when the eligible span is under the minimum', () => {
    const stores = tempStores('mc-wrapup-short-')
    const nodes = [node(1, 'user', 'q1'), node(2, 'assistant', 'a1')]
    expect(pickManualSpan(nodes, stores, 'ses-wrapup', policy)).toEqual([])
  })
})

describe('writeManualCheckpoint', () => {
  it('writes start → summary → replacement and keeps the digest on the surface', async () => {
    const stores = tempStores('mc-wrapup-write-')
    const fake = makeSession()
    const seqs = [
      fake.push('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'first question' }] }),
      fake.push('assistant/message', { message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'first answer' }] } }),
      fake.push('user/message', { id: 'u2', role: 'user', content: [{ type: 'text', text: 'second question' }] }),
    ]
    const nodes = [
      node(seqs[0]!, 'user', 'first question'),
      node(seqs[1]!, 'assistant', 'first answer'),
      node(seqs[2]!, 'user', 'second question'),
    ]
    const scripted = scriptLlm([DIGEST])
    const result = await writeManualCheckpoint(
      {
        stores,
        policy,
        logger: noopLogger,
        llm: scripted.llm,
        route: { provider: 'test', model: 'test' },
      },
      { session: fake.session, nodes, sourceCommandId: 'ctx-wrapup' },
    )

    expect(result.nodes).toBe(3)
    expect(result.importance).toBe(61)
    expect(result.shadowedSeqs).toEqual([seqs[0], seqs[1], seqs[2]])
    // The host protocol is start → summary → replacement → end: the replacement
    // lands between the metering event and the terminal one, so a UI card can
    // correlate the checkpoint while its range is already off the surface.
    expect(fake.appendTypes()).toEqual([
      'user/message', 'assistant/message', 'user/message',
      'compaction/start', 'compaction/summary', 'user/message', 'compaction/end',
    ])
    const summaryEvent = fake.events().find(event => event.type === 'compaction/summary')
    expect(summaryEvent?.data).toMatchObject({
      compactionId: result.compactionId,
      sourceCommandId: 'ctx-wrapup',
      shadowedRange: { start: seqs[0], end: seqs[2] },
      shadowedTokenCount: result.shadowedTokenCount,
    })
    // The replacement is a real surface op over the digested range, so the
    // originals stay reachable through `ctx_expand` instead of being deleted.
    const replacement = fake.events().find(event => event.surfaceOp !== undefined) as FakeEvent
    expect(replacement.surfaceOp).toEqual({ op: 'replace', startSeq: seqs[0], endSeq: seqs[2] })
    expect(replacement.sourceEventSeqs).toEqual([seqs[0], seqs[1], seqs[2]])
    const text = (replacement.data as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain('§checkpoint§')
    expect(text).toContain('WRAPUP-P1')
    expect(text).toContain('the wire keeps §checkpoint§')
  })

  it('propagates a historian failure instead of writing a half checkpoint', async () => {
    const stores = tempStores('mc-wrapup-fail-')
    const fake = makeSession()
    const seqs = [
      fake.push('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'q1' }] }),
      fake.push('user/message', { id: 'u2', role: 'user', content: [{ type: 'text', text: 'q2' }] }),
      fake.push('user/message', { id: 'u3', role: 'user', content: [{ type: 'text', text: 'q3' }] }),
    ]
    const scripted = scriptLlm([new Error('provider exploded')])
    await expect(writeManualCheckpoint(
      { stores, policy, logger: noopLogger, llm: scripted.llm, route: { provider: 'test', model: 'test' } },
      { session: fake.session, nodes: seqs.map(seq => node(seq, 'user', 'q')) },
    )).rejects.toThrow(/provider exploded/)
    expect(fake.appendTypes()).not.toContain('compaction/summary')
  })

  it('refuses to run without an LLM seam', async () => {
    const stores = tempStores('mc-wrapup-nollm-')
    const fake = makeSession()
    await expect(writeManualCheckpoint(
      { stores, policy, logger: noopLogger },
      { session: fake.session, nodes: [] },
    )).rejects.toThrow(/no LLM seam/)
  })
})

describe('registerCtxWrapupCommand', () => {
  it('is accepted by the real command service and visible to an agent', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    const stores = tempStores('mc-wrapup-mount-')
    try {
      registerCtxWrapupCommand(ctx as never, {
        stores,
        policy: DEFAULT_POLICY,
        logger: noopLogger,
        llm: {} as never,
        route: { provider: 'test', model: 'test' },
      })
      const session = ctx.sessions.create(SessionId('wrapup-mount'))
      const agent = { id: session.id, session }
      expect(ctx.commands.find(agent, 'ctx-wrapup')?.description).toContain('checkpoint')
      expect(ctx.commands.list(agent).map(entry => entry.name)).toContain('ctx-wrapup')
    } finally {
      stores.close()
    }
  })

  it('warns and stays out of the way when the commands service is absent', () => {
    const warns: string[] = []
    const ctx = {
      get: () => undefined,
      logger: { info: () => {}, warn: (message: string) => { warns.push(message) } },
    }
    registerCtxWrapupCommand(ctx as never, { stores: {} as never, policy: DEFAULT_POLICY, logger: noopLogger })
    expect(warns.some(message => message.includes('/ctx-wrapup unavailable'))).toBe(true)
  })

  it('answers a bad argument and a disabled historian with errors, not empty successes', async () => {
    const captured: Array<{
      name: string
      handler: (invocation: { agent: { session: { id: string } }; rawInput?: string }) => Promise<{ kind: string; text?: string }>
    }> = []
    const commands = { register: (definition: never) => { captured.push(definition); return definition } }
    const ctx = { get: () => commands, logger: noopLogger }
    const stores = tempStores('mc-wrapup-refuse-')
    try {
      registerCtxWrapupCommand(ctx as never, { stores, policy: DEFAULT_POLICY, logger: noopLogger, llm: {} as never })
      const handler = captured[0]!.handler
      const invocation = { agent: { session: { id: 'ses-wrapup' } }, rawInput: 'five' }
      await expect(handler(invocation)).resolves.toEqual({ kind: 'error', text: WRAPUP_USAGE })

      const disabled: typeof captured = []
      registerCtxWrapupCommand(
        { get: () => ({ register: (definition: never) => { disabled.push(definition); return definition } }), logger: noopLogger } as never,
        { stores, policy: DEFAULT_POLICY, logger: noopLogger, enabled: false, llm: {} as never },
      )
      const refusal = await disabled[0]!.handler(invocation)
      expect(refusal.kind).toBe('error')
      expect(refusal.text).toContain('nothing to wrap up')
    } finally {
      stores.close()
    }
  })
})
