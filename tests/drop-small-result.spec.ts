/**
 * Small-result protection (upstream `planNewToolDrop`, apply-operations.ts:132):
 * a result at or under `SKELETON_REAL_INPUT_MAX_BYTES` inside the newest
 * `RECENT_TOOL_SKELETON_WINDOW` tool calls is NOT dropped.
 *
 * Why: the reclaim is a few hundred bytes, while the reader loses the actual
 * output of a step. The RCC session hit the degenerate version of this — 44
 * execute passes, 40 of them reclaiming nothing — because everything droppable
 * had already been dropped, cheap results included.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_POLICY } from '../src/core/policy.ts'
import { openStores } from '../src/core/stores.ts'
import { runManagementPass } from '../src/dsh/management-pass.ts'

const SESSION = 'mc-drop-small'
const silentLogger = { info: () => {}, warn: () => {} }

interface FakeEvent {
  seq: number
  type: string
  data: Record<string, unknown>
}

/**
 * A surface with one user message and `toolResults` tool results, each carrying
 * a distinct call id so `enumerateSurfaceToolResults` tags them in order.
 */
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

function run(session: ReturnType<typeof surfaceWith>, stores: ReturnType<typeof openStores>, floor: number) {
  return runManagementPass({
    session: session as never,
    sessionId: SESSION,
    stores,
    policy: { ...DEFAULT_POLICY, executeThreshold: 50, dropSmallResultFloor: floor },
    logger: silentLogger,
    pass: { kind: 'execute', reason: 'execute-threshold' } as never,
    pressure: 80,
  })
}

function withStore<T>(fn: (stores: ReturnType<typeof openStores>) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'mc-drop-small-'))
  const stores = openStores(dir)
  try {
    return fn(stores)
  } finally {
    stores.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 })
  }
}

describe('small-result protection', () => {
  it('leaves a tiny result alone inside the newest-call window', () => {
    withStore((stores) => {
      const session = surfaceWith(['short output'])
      const tag = stores.allocateTag(SESSION, { kind: 'tool-result', callId: 'call-1' }, Date.now())
      stores.queueDrop(SESSION, tag, Date.now())
      const result = run(session, stores, 1_024)
      expect(result.landedDrops).toEqual([])
      // Still queued: the pass chose not to consume it.
      expect(stores.listPendingDrops(SESSION)).toEqual([tag])
    })
  })

  // The LANDING path (large result -> placeholder) needs a real
  // `replaceToolResultContent` seam, which this fake session does not provide.
  // It is covered by the integration cases that set `dropSmallResultFloor: 0`
  // (phase1, journal, poc, memory-promotion) — those exercise exactly the
  // unprotected branch.
})
