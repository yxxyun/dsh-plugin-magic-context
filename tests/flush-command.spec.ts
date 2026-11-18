/**
 * `/ctx-flush` (upstream `execute-flush.ts:10`).
 *
 * Three answers, kept verbatim from upstream: what was flushed, that nothing was
 * pending, and that the change takes effect on the NEXT message. The last one
 * matters — flush does not rewrite the request in flight, it settles the queue so
 * the next render serves the placeholders.
 *
 * Two local additions the upstream text does not need and this surface does: a
 * target that left the surface is "retired" rather than flushed, and a small
 * result inside the newest-call window is KEPT (the protection added in the
 * previous round) instead of being reported as dropped.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_POLICY } from '../src/core/policy.ts'
import { openStores } from '../src/core/stores.ts'
import { landPendingDrops } from '../src/dsh/drop-landing.ts'

const SESSION = 'mc-flush'

interface FakeEvent { seq: number; type: string; data: Record<string, unknown> }

function surfaceWith(toolTexts: readonly string[]) {
  const events: FakeEvent[] = []
  let seq = 1
  const surface = { nodes: [] as number[], replaceGeneration: 0 }
  const push = (type: string, data: Record<string, unknown>): void => {
    events.push({ seq, type, data })
    surface.nodes.push(seq)
    seq += 1
  }
  push('user/message', { turn: 1, message: { role: 'user', content: [{ type: 'text', text: 'go' }] } })
  toolTexts.forEach((text, index) => {
    push('tool/result', {
      message: {
        role: 'tool',
        toolCallId: `call-${String(index + 1)}`,
        content: [{ type: 'text', text }],
      },
    })
  })
  return {
    surface,
    snapshotEvents: () => events.slice(),
    append: (type: string, data: Record<string, unknown>) => push(type, data),
    requestContext: () => ({ provider: 'mock', model: 'mock', contextWindow: 100_000 }),
  }
}

function withStore<T>(fn: (stores: ReturnType<typeof openStores>) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'mc-flush-'))
  const stores = openStores(dir)
  try {
    return fn(stores)
  } finally {
    stores.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
  }
}

describe('landPendingDrops — the engine behind /ctx-flush', () => {
  it('reports nothing to do when the queue is empty', () => {
    withStore((stores) => {
      const session = surfaceWith([])
      const result = landPendingDrops({
        session: session as never,
        sessionId: SESSION,
        stores,
        policy: DEFAULT_POLICY,
      })
      expect(result.landed).toEqual([])
      expect(result.retired).toEqual([])
      expect(result.error).toBeUndefined()
    })
  })

  it('retires a queued tag whose target left the surface', () => {
    withStore((stores) => {
      const session = surfaceWith([]) // no tool results at all
      const tag = stores.allocateTag(SESSION, { kind: 'tool-result', callId: 'call-9' }, Date.now())
      stores.queueDrop(SESSION, tag, Date.now())
      const result = landPendingDrops({
        session: session as never,
        sessionId: SESSION,
        stores,
        policy: DEFAULT_POLICY,
      })
      expect(result.retired).toEqual([tag])
      // Retiring is not landing: the queue is drained so it cannot grow forever.
      expect(stores.listPendingDrops(SESSION)).toEqual([])
    })
  })

  it('keeps a small result and leaves it queued for a later pass', () => {
    withStore((stores) => {
      const session = surfaceWith(['tiny'])
      const tag = stores.allocateTag(SESSION, { kind: 'tool-result', callId: 'call-1' }, Date.now())
      stores.queueDrop(SESSION, tag, Date.now())
      const result = landPendingDrops({
        session: session as never,
        sessionId: SESSION,
        stores,
        policy: DEFAULT_POLICY,
      })
      expect(result.landed).toEqual([])
      expect(result.skippedSmall).toBe(1)
      expect(stores.listPendingDrops(SESSION)).toEqual([tag])
    })
  })

  it('surfaces a store fault instead of swallowing it', () => {
    withStore((stores) => {
      const broken = { ...stores, listPendingDrops: () => { throw new Error('store closed') } }
      const session = surfaceWith([])
      const result = landPendingDrops({
        session: session as never,
        sessionId: SESSION,
        stores: broken as never,
        policy: DEFAULT_POLICY,
      })
      expect(result.error).toBeInstanceOf(Error)
      expect((result.error as Error).message).toContain('store closed')
    })
  })
})
