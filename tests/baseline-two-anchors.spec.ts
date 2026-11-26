/**
 * m[0] and m[1] ride two different anchors.
 *
 * Defect measured 2026-11-26: one block held the frozen prefix AND the delta,
 * attached to the FIRST user node. Any delta change (a compartment landing, a
 * promoted memory, a profile addition) therefore rewrote the node that carries
 * the prefix, and the whole cached prompt behind it was re-read. Fifteen of
 * eighteen `soft / m[0]-unchanged` rebuilds were harmful, costing 5,865,247
 * tokens over four days — for bytes that were already correct.
 *
 * Upstream keeps them apart as two frozen units, hence two wire messages
 * (`transform.rs:16974-16999`: `synthetic_m0_message`, then
 * `CkWireMessage::synthetic_user_text` for m1). The host surface can only replace
 * a node in place, so the split is expressed as two ANCHORS: m[0] on the first
 * ordinary user node, m[1] on the last.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_POLICY } from '../src/core/policy.ts'
import { openStores, type AdapterStores } from '../src/core/stores.ts'
import type { Journal } from '../src/core/journal.ts'
import {
  runManagementPass,
  BASELINE_RENDER_EPOCH,
} from '../src/dsh/management-pass.ts'

const T0 = 1_700_000_000_000
const SESSION = 'mc-two-anchors'
const DIGEST = 'digest-1'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
})

function openStore(): AdapterStores {
  const dir = mkdtempSync(join(tmpdir(), 'mc-anchors-'))
  tempDirs.push(dir)
  return openStores(dir)
}

interface Recorded { readonly level: string; readonly kind: string; readonly summary: string; readonly data: unknown }

function recordingJournal(entries: Recorded[]): Journal {
  const record = (level: string) => (kind: string, summary: string, data?: unknown): void => {
    entries.push({ level, kind, summary, data })
  }
  return { info: record('info'), warn: record('warn'), error: record('error') } as unknown as Journal
}

/** A surface with `turns` user messages, each carryable independently. */
function surfaceSession(turns: number) {
  const events: Array<Record<string, unknown>> = []
  let nextSeq = 1
  const surface = { nodes: [] as number[], replaceGeneration: 0 }
  const session = {
    snapshotEvents: () => events.slice(),
    surface,
    append: (type: string, data: Record<string, unknown>, options?: Record<string, unknown>) => {
      const seq = nextSeq++
      events.push({ seq, type, data })
      const op = (options as { surfaceOp?: { op: string; startSeq: number; endSeq: number } } | undefined)?.surfaceOp
      if (op?.op === 'replace') {
        // A replacement keeps the replaced node's POSITION: the host rewrites a
        // message in place, so a node that is replaced does not jump to the tail.
        // Pushing it would silently reorder the surface and make an assertion
        // about "the first user node" meaningless.
        const at = surface.nodes.indexOf(op.startSeq)
        surface.nodes = surface.nodes.filter(node => node < op.startSeq || node > op.endSeq)
        surface.replaceGeneration += 1
        if (at === -1) surface.nodes.push(seq)
        else surface.nodes.splice(at, 0, seq)
        return { seq }
      }
      surface.nodes.push(seq)
      return { seq }
    },
  }
  for (let index = 0; index < turns; index += 1) {
    session.append('user/message', {
      turn: index + 1,
      message: { role: 'user', content: [{ type: 'text', text: `turn ${String(index + 1)}` }] },
    })
  }
  return session as unknown as Parameters<typeof runManagementPass>[0]['session']
}

/** Text of every user node on the surface, in order (the injected blocks live here). */
function userTexts(session: Parameters<typeof runManagementPass>[0]['session']): string[] {
  const bySeq = new Map<number, string>()
  for (const event of session.snapshotEvents()) {
    const data = event.data as {
      message?: { role?: string; content?: Array<{ type?: string; text?: string }> }
      content?: Array<{ type?: string; text?: string }>
      role?: string
    } | undefined
    const role = data?.message?.role ?? data?.role
    if (role !== 'user') continue
    // `user/message` carries the message AT `data`; anything else wraps it in
    // `data.message` (seams.ts `contentOf`).
    const parts = data?.message?.content ?? data?.content ?? []
    bySeq.set(event.seq as number, parts
      .filter(part => part.type === 'text')
      .map(part => part.text ?? '')
      .join('\n'))
  }
  return [...session.surface.nodes].map(seq => bySeq.get(seq) ?? '')
}

function seedBaseline(stores: AdapterStores, maxCompartmentId = 0): void {
  stores.saveBaselineState({
    sessionId: SESSION,
    epoch: 1,
    frozenAt: T0,
    memoriesDigest: DIGEST,
    renderEpoch: BASELINE_RENDER_EPOCH,
    maxCompartmentId,
    updatedAt: T0,
  })
}

function pass(args: {
  stores: AdapterStores
  session: Parameters<typeof runManagementPass>[0]['session']
  entries: Recorded[]
  now: number
  /** Rendered lines for the additive lane — a delta with no compartment, so no
   *  publish runs and the case measures the baseline layout alone. */
  newLines?: readonly string[]
}) {
  return runManagementPass({
    session: args.session,
    sessionId: SESSION,
    stores: args.stores,
    policy: DEFAULT_POLICY,
    logger: { info: () => {}, warn: () => {} },
    // `execute-threshold`, never `cache-ttl-idle`: an idle poke folds m[0] by
    // design, and these cases are about what a SOFT pass does.
    pass: { kind: 'execute', reason: 'execute-threshold' },
    pressure: 40,
    now: () => args.now,
    lastResponseAt: args.now - 1_000,
    memories: {
      digest: DIGEST,
      lines: ['- [CONSTRAINTS] never commit secrets'],
      ...args.newLines === undefined ? {} : { newLines: args.newLines },
    },
    journal: recordingJournal(args.entries),
  })
}

function addCompartment(stores: AdapterStores, session: Parameters<typeof runManagementPass>[0]['session'], marker: string) {
  const seqs = [...session.surface.nodes]
  stores.allocateCompartment(session.id ?? SESSION, {
    tiers: { p1: `${marker}-P1`, p2: `${marker}-P2`, p3: `${marker}-P3`, p4: `${marker}-P4` },
    importance: 70,
    facts: [],
    events: [`${marker}-event`],
  }, { startSeq: seqs[0] as never, endSeq: seqs[seqs.length - 1] as never, seqs: seqs as never, tokens: 10 }, 1, T0)
}

describe('m[0] and m[1] on separate anchors', () => {
  it('puts the frozen prefix on the first user node and the delta on the last', () => {
    const stores = openStore()
    const entries: Recorded[] = []
    const session = surfaceSession(3)
    try {
      seedBaseline(stores)
      pass({ stores, session, entries, now: T0 + 1_000, newLines: ['- [CONSTRAINTS] ONE delta line'] })
      const texts = userTexts(session)
      // m[0] on the first turn, delta on the last.
      expect(texts[0]).toContain('<magic-context>')
      expect(texts[0]).not.toContain('<magic-context-delta>')
      expect(texts[2]).toContain('<magic-context-delta>')
      expect(texts[2]).toContain('ONE delta line')
      // The middle turn carries neither.
      expect(texts[1]).not.toContain('<magic-context>')
      expect(texts[1]).not.toContain('<magic-context-delta>')
    } finally {
      stores.close()
    }
  })

  it('leaves the frozen prefix byte-identical when only the delta changes', () => {
    const stores = openStore()
    const entries: Recorded[] = []
    const session = surfaceSession(3)
    try {
      seedBaseline(stores)
      pass({ stores, session, entries, now: T0 + 1_000, newLines: ['- [CONSTRAINTS] ONE delta line'] })
      const headBefore = userTexts(session)[0]

      // The additive lane grows: the delta changes, m[0] cannot.
      pass({ stores, session, entries, now: T0 + 2_000, newLines: ['- [CONSTRAINTS] ONE delta line', '- [NAMING] TWO delta line'] })
      const texts = userTexts(session)
      // The defect in one assertion: a delta-only change must not touch the node
      // that carries the frozen prefix.
      expect(texts[0]).toBe(headBefore)
      expect(texts[2]).toContain('TWO delta line')
      // And it really did rewrite the tail (otherwise this case proves nothing).
      expect(stores.baselineState(SESSION)?.epoch).toBe(1)
    } finally {
      stores.close()
    }
  })

  it('carries both blocks on one node when the surface has a single turn', () => {
    const stores = openStore()
    const entries: Recorded[] = []
    const session = surfaceSession(1)
    try {
      seedBaseline(stores)
      pass({ stores, session, entries, now: T0 + 1_000, newLines: ['- [CONSTRAINTS] ONE delta line'] })
      const text = userTexts(session)[0] ?? ''
      expect(text).toContain('<magic-context>')
      expect(text).toContain('<magic-context-delta>')
      // Said out loud in the journal, so an audit never mistakes this for the
      // split failing to happen.
      const row = entries.find(entry => entry.kind === 'baseline')
      expect((row?.data as { sameAnchor?: boolean } | undefined)?.sameAnchor).toBe(true)
    } finally {
      stores.close()
    }
  })

  it('folds once when an epoch-6 baseline still carries the delta inside m[0]', () => {
    const stores = openStore()
    const entries: Recorded[] = []
    const session = surfaceSession(3)
    try {
      // A baseline written by the previous layout: its m[0] block already holds
      // the `<compartment-delta>` section.
      stores.saveBaselineState({
        sessionId: SESSION,
        epoch: 4,
        frozenAt: T0,
        memoriesDigest: DIGEST,
        renderEpoch: BASELINE_RENDER_EPOCH - 1,
        maxCompartmentId: 0,
        updatedAt: T0,
      })
      pass({ stores, session, entries, now: T0 + 1_000 })
      // The render-epoch gate fires exactly once and names itself.
      const row = entries.find(entry => entry.kind === 'baseline')
      expect((row?.data as { hardReason?: string } | undefined)?.hardReason).toBe('render-epoch')
      expect(stores.baselineState(SESSION)?.renderEpoch).toBe(BASELINE_RENDER_EPOCH)
    } finally {
      stores.close()
    }
  })
})
