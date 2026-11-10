/**
 * The baseline must re-render to the SAME BYTES when nothing changed.
 *
 * Upstream states the invariant we broke (`crates/mc-module/src/m0_compose.rs`
 * header, v0.49.48): "same inputs → same bytes, the property the frozen-m0
 * cache depends on. The expiry cutoff (`now_ms`) is passed in — frozen at the
 * HARD by the caller, never read here from a live clock — so a later defer
 * replays identical bytes."
 *
 * Why this file exists: `renderCompartment` puts a wall-clock age in the
 * compartment header (`§C3§ [p2, importance 84, 12m ago]`) and derives the
 * fidelity tier from wall-clock age too. While `refreshBaseline` rendered with
 * `Date.now()`, the `baselineBlockOf(target.text) === block` guard could never
 * match, so EVERY execute pass rewrote the first user node. Measured on the
 * 2026-11-09..10 store: 35 `soft` baseline refreshes against 10 published
 * compartments, and the step after a no-op pass reported `cacheRead 32,768`
 * against a 303k-token prompt (the whole history behind the baseline node
 * re-billed at full price).
 *
 * The fix is one line in `refreshBaseline`: a SOFT pass renders with the clock
 * the baseline was folded at, and only a HARD move it. These cases pin both
 * halves — a no-op pass must append nothing, and a real change must still land.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_POLICY, type PressurePolicy } from '../src/core/policy.ts'
import { openStores, type AdapterStores } from '../src/core/stores.ts'
import { runManagementPass } from '../src/dsh/management-pass.ts'
import type { Journal } from '../src/core/journal.ts'
import type { Session } from '../src/dsh/seams.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
    } catch {
      /* OS temp sweep covers residue */
    }
  }
})

interface FakeEvent {
  seq: number
  type: string
  data: { id: string; role: string; content: Array<{ type: string; text?: string }> }
}

function userEvent(seq: number, text: string): FakeEvent {
  return { seq, type: 'user/message', data: { id: `u${String(seq)}`, role: 'user', content: [{ type: 'text', text }] } }
}

const draft = {
  tiers: { p1: 'digest one', p2: 'digest one', p3: 'digest one', p4: 'digest one' },
  importance: 50,
  facts: [],
  events: [],
}

/**
 * A session whose appends land in an array we can inspect afterwards.
 *
 * `surfaceOp: { op: 'replace', startSeq, endSeq }` (seams.replaceSurfaceRange)
 * shadows the replaced nodes, exactly as the host does — without that the
 * original user node stays on the surface and the baseline pool is read from
 * the wrong node.
 */
function fakeSession(events: readonly FakeEvent[]): {
  session: Session
  appends: FakeEvent[]
  baselineTexts: () => string[]
} {
  const log = [...events]
  const surfaceNodes = events.map(event => event.seq)
  let nextSeq = (events.at(-1)?.seq ?? 0) + 1
  let replaceGeneration = 1
  const appends: FakeEvent[] = []
  const session = {
    snapshotEvents: () => log.filter(event => surfaceNodes.includes(event.seq)),
    surface: {
      get nodes() { return [...surfaceNodes] },
      get replaceGeneration() { return replaceGeneration },
    },
    append: (type: string, data: unknown, options?: { surfaceOp?: { op: string; startSeq: number; endSeq: number } }) => {
      const op = options?.surfaceOp
      // `surfaceOp: replace` keeps the replaced range's POSITION: the host swaps
      // the nodes in place, it does not move them to the tail. Getting this
      // wrong makes the compacted placeholder the first user node, so the
      // baseline is read from (and re-attached to) the wrong node.
      let insertAt = surfaceNodes.length
      if (op?.op === 'replace') {
        const firstIndex = surfaceNodes.findIndex(seq => seq >= op.startSeq && seq <= op.endSeq)
        if (firstIndex >= 0) insertAt = firstIndex
        for (let index = surfaceNodes.length - 1; index >= 0; index -= 1) {
          const seq = surfaceNodes[index] as number
          if (seq >= op.startSeq && seq <= op.endSeq) surfaceNodes.splice(index, 1)
        }
        replaceGeneration += 1
      }
      const event = { seq: nextSeq, type, data } as FakeEvent
      nextSeq += 1
      log.push(event)
      surfaceNodes.splice(insertAt, 0, event.seq)
      appends.push(event)
      return { seq: event.seq }
    },
  } as unknown as Session
  const baselineTexts = (): string[] =>
    appends
      .filter(event => String(event.data.id ?? '').startsWith('mc-baseline'))
      .map(event => event.data.content.map(block => block.text ?? '').join(''))
  return { session, appends, baselineTexts }
}

function runPass(
  stores: AdapterStores,
  session: Session,
  policy: PressurePolicy,
  now: number,
  options: { route?: { provider: string; model: string }; memories?: { digest: string; lines: string[] } } = {},
): ReturnType<typeof runManagementPass> {
  return runManagementPass({
    session,
    sessionId: 's',
    stores,
    policy,
    logger: { info() {}, warn() {} },
    pass: { kind: 'execute', reason: 'execute-threshold' },
    pressure: 70,
    now: () => now,
    ...options.route === undefined ? {} : { route: options.route },
    ...options.memories === undefined
      ? {}
      : {
        memories: {
          digest: options.memories.digest,
          lines: options.memories.lines,
          newLines: [],
          newMemoryIds: [],
          baselineIds: [],
          eligibleIds: [],
          eligibleRows: [],
        },
      },
  } as never)
}

// Real "now": `splitBaselineSets` keeps only compartments created at or before
// `frozenAt` in m[0], so a synthetic past timestamp would push the freshly
// allocated compartment into the delta set and rewrite for an unrelated reason.
const T0 = Date.now()
const FIVE_MIN = 5 * 60_000

describe('baseline byte identity across passes', () => {
  it('a pass with nothing to reclaim writes nothing — the age line does not tick', () => {
    const stores = openStores(tempDir('mc-clock-freeze-'))
    const policy: PressurePolicy = { ...DEFAULT_POLICY }
    try {
      stores.allocateCompartment('s', draft, { startSeq: 2, endSeq: 2, seqs: [2], tokens: 500 }, 1, 5)
      const { session, baselineTexts } = fakeSession([userEvent(1, 'head'), userEvent(2, 'covered')])

      // Pass 1: first baseline (HARD) plus the compartment publish.
      const first = runPass(stores, session, policy, T0)
      expect(first.published).toHaveLength(1)
      expect(first.baselineUpdated).toBe(true)
      const foldedAt = stores.baselineState('s')?.frozenAt
      expect(foldedAt).toBe(T0)
      expect(baselineTexts()).toHaveLength(1)

      // Pass 2: five minutes later, nothing published, nothing queued. The
      // rendered header would read `5m ago` under a live clock; the guard must
      // still see identical bytes.
      const second = runPass(stores, session, policy, T0 + FIVE_MIN)
      expect(second.published).toEqual([])
      expect(second.baselineUpdated).toBe(false)
      expect(baselineTexts()).toHaveLength(1)
      // A SOFT pass never moves the frozen clock (only a HARD does).
      expect(stores.baselineState('s')?.frozenAt).toBe(T0)

      // Pass 3, an hour later, still nothing to do: still no rewrite.
      const third = runPass(stores, session, policy, T0 + 60 * 60_000)
      expect(third.baselineUpdated).toBe(false)
      expect(baselineTexts()).toHaveLength(1)
    } finally {
      stores.close()
    }
  })

  it('a real change still rewrites (the guard is not a mute switch)', () => {
    const stores = openStores(tempDir('mc-clock-real-change-'))
    const policy: PressurePolicy = { ...DEFAULT_POLICY }
    const route = { provider: 'workbuddy', model: 'deepseek-v4.1-flash' }
    const recalled = { digest: 'digest-a', lines: ['- [PROJECT_RULES] keep it stable'] }
    try {
      stores.allocateCompartment('s', draft, { startSeq: 2, endSeq: 2, seqs: [2], tokens: 500 }, 1, 5)
      const { session, baselineTexts } = fakeSession([userEvent(1, 'head'), userEvent(2, 'covered')])
      expect(runPass(stores, session, policy, T0, { route, memories: recalled }).baselineUpdated).toBe(true)
      expect(baselineTexts()).toHaveLength(1)
      expect(baselineTexts()[0]).toContain('keep it stable')

      // Same everything, nothing to reclaim: still no rewrite.
      expect(runPass(stores, session, policy, T0 + 5 * 60_000, { route, memories: recalled }).baselineUpdated).toBe(false)
      expect(baselineTexts()).toHaveLength(1)

      // The recalled pool changes (a memory was written): the block genuinely
      // differs, so the node is rewritten exactly once and the frozen clock
      // moves with it.
      const changed = runPass(stores, session, policy, T0 + 6 * 60_000, {
        route,
        memories: { digest: 'digest-b', lines: ['- [PROJECT_RULES] keep it stable', '- [ARCHITECTURE] new fact'] },
      })
      expect(changed.baselineUpdated).toBe(true)
      expect(baselineTexts()).toHaveLength(2)
      expect(baselineTexts()[1]).toContain('new fact')
      expect(stores.baselineState('s')?.frozenAt).toBe(T0 + 6 * 60_000)
      // …and the pass after that is quiet again.
      const quiet = runPass(stores, session, policy, T0 + 7 * 60_000, {
        route,
        memories: { digest: 'digest-b', lines: ['- [PROJECT_RULES] keep it stable', '- [ARCHITECTURE] new fact'] },
      })
      expect(quiet.baselineUpdated).toBe(false)
      expect(baselineTexts()).toHaveLength(2)
    } finally {
      stores.close()
    }
  })
})
