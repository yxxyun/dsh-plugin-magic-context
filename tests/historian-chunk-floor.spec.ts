/**
 * The historian's chunked-content floor (upstream `historian_chunk.rs:1364`).
 *
 *   if chunk.token_estimate * source_ratio < config.min_chunk_tokens
 *      && !config.in_emergency && !config.fold_is_only_reclaim { NoFire }
 *
 * Why it exists: publishing a compartment rewrites the cached prefix, so a run
 * is only worth its price when the material is big enough for a summary to
 * improve on. Measured 2026-11-26: compartment §C73 took 12 nodes / 471 tokens,
 * published, and the next step re-read 355,880 tokens — 471 tokens reclaimed at
 * a cost of 356k.
 *
 * These cases pin the floor, both of its upstream exceptions, and its window
 * boundary. They do NOT pin the historian's own gates (tail_size, proactive
 * floor, redundancy): those have their own specs.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_POLICY } from '../src/core/policy.ts'
import { openStores, type AdapterStores } from '../src/core/stores.ts'
import type { Journal } from '../src/core/journal.ts'
import { runManagementPass, BASELINE_RENDER_EPOCH } from '../src/dsh/management-pass.ts'

const T0 = 1_700_000_000_000
const SESSION = 'mc-chunk-floor'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
})

function openStore(): AdapterStores {
  const dir = mkdtempSync(join(tmpdir(), 'mc-floor-'))
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

/**
 * A surface of `count` user turns each carrying `chars` characters.
 *
 * Each turn is its own user node, so the historian's eligible span is the set of
 * nodes minus whatever the protected tail holds back. Characters, not tokens:
 * the estimate is ~4 chars per token for ASCII, so `chars = 4 * n` is ~n tokens.
 */
function surfaceSession(count: number, chars: number) {
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
        surface.nodes = surface.nodes.filter(node => node < op.startSeq || node > op.endSeq)
        surface.replaceGeneration += 1
      }
      surface.nodes.push(seq)
      return { seq }
    },
  }
  const body = 'trace the failing assertion back to its fixture and report the mismatch. '.repeat(
    Math.max(1, Math.ceil(chars / 74)),
  ).slice(0, chars)
  for (let index = 0; index < count; index += 1) {
    session.append('user/message', {
      turn: index + 1,
      message: { role: 'user', content: [{ type: 'text', text: body }] },
    })
  }
  return session as unknown as Parameters<typeof runManagementPass>[0]['session']
}

/** A baseline already at the current render epoch, so no other gate fires first. */
function seedBaseline(stores: AdapterStores): void {
  stores.saveBaselineState({
    sessionId: SESSION,
    epoch: 1,
    frozenAt: T0,
    memoriesDigest: 'digest-1',
    renderEpoch: BASELINE_RENDER_EPOCH,
    updatedAt: T0,
  })
}

/** A historian seam that records calls instead of talking to a provider. */
function recordingLlm(calls: string[]): Parameters<typeof runManagementPass>[0]['historian'] {
  return {
    llm: {
      stream: () => {
        calls.push('digest')
        throw new Error('the floor cases never reach the provider')
      },
    },
  } as unknown as Parameters<typeof runManagementPass>[0]['historian']
}

function run(args: {
  stores: AdapterStores
  entries: Recorded[]
  nodes: number
  chars: number
  pressure: number
  contextWindow: number
  calls: string[]
}) {
  return runManagementPass({
    session: surfaceSession(args.nodes, args.chars),
    sessionId: SESSION,
    stores: args.stores,
    policy: {
      ...DEFAULT_POLICY,
      // Nothing protected and a tiny floor, so the span under test is the whole
      // surface: this file is about the chunk floor, not about the protection
      // window.
      historianProtectedNodes: 0,
      historianMinNodes: 1,
      historianMinBudgetTokens: 1,
      forbidden: undefined,
    } as typeof DEFAULT_POLICY,
    logger: { info: () => {}, warn: () => {} },
    pass: { kind: 'execute', reason: 'execute-threshold' },
    pressure: args.pressure,
    now: () => T0 + 60_000,
    lastResponseAt: T0 + 30_000,
    contextWindow: args.contextWindow,
    historian: recordingLlm(args.calls),
    journal: recordingJournal(args.entries),
  })
}

function floorSkip(entries: Recorded[]): Recorded | undefined {
  return entries.find(entry => entry.kind === 'historian'
    && (entry.data as { phase?: string } | undefined)?.phase === 'below-chunk-floor')
}

describe('historian chunk floor', () => {
  it('refuses a span whose正文 is under 1 000 tokens', () => {
    const stores = openStore()
    const entries: Recorded[] = []
    const calls: string[] = []
    try {
      seedBaseline(stores)
      // 12 turns (the meaningfulness floor) × ~60 tokens = ~720 tokens of正文:
      // meant enough nodes to look worth a run, far too little text to be one.
      run({ stores, entries, nodes: 12, chars: 240, pressure: 40, contextWindow: 200_000, calls })
      expect(calls).toEqual([])
      expect(floorSkip(entries)).toBeDefined()
    } finally {
      stores.close()
    }
  })

  it('admits a span comfortably over the floor', () => {
    const stores = openStore()
    const entries: Recorded[] = []
    const calls: string[] = []
    try {
      seedBaseline(stores)
      // 12 turns × ~1 250 tokens = ~15 000 tokens of正文.
      run({ stores, entries, nodes: 12, chars: 5_000, pressure: 40, contextWindow: 200_000, calls })
      expect(floorSkip(entries)).toBeUndefined()
      // Admission is proven by the drain RESERVATION, which the runner takes only
      // after the range, budget and lease gates have all passed (`reserveRun` in
      // management-pass; upstream `reserveProtectedTailDrainTokens`). Asserting on
      // the provider seam instead would race the out-of-band run.
      const reserved = entries.find(entry => entry.kind === 'drain')
      expect(reserved).toBeDefined()
      expect((reserved?.data as { reserved?: number } | undefined)?.reserved ?? 0).toBeGreaterThan(0)
    } finally {
      stores.close()
    }
  })

  it('waives the floor in the force band (upstream `in_emergency`)', () => {
    const stores = openStore()
    const entries: Recorded[] = []
    const calls: string[] = []
    try {
      seedBaseline(stores)
      // Same tiny span as the first case, but the window is about to blow: any
      // reclaim is worth taking, so the floor does not apply.
      run({ stores, entries, nodes: 12, chars: 240, pressure: 95, contextWindow: 200_000, calls })
      expect(floorSkip(entries)).toBeUndefined()
    } finally {
      stores.close()
    }
  })

  it('does not apply on a window too small to hold the floor', () => {
    const stores = openStore()
    const entries: Recorded[] = []
    const calls: string[] = []
    try {
      seedBaseline(stores)
      // A 12-token window can never satisfy a 1 000-token floor; applying it
      // would disable the historian for that session forever (the same trap as
      // the 2026-11-18 span-cap/budget equality).
      run({ stores, entries, nodes: 12, chars: 240, pressure: 83, contextWindow: 12, calls })
      expect(floorSkip(entries)).toBeUndefined()
    } finally {
      stores.close()
    }
  })
})
