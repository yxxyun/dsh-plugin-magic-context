/**
 * Compartment contract units: the historian's output validation, the tier
 * ladder, and the m[0]/m[1] baseline rendering (no DSH, no SQLite).
 */
import { describe, expect, it } from 'vitest'
import {
  BASELINE_CLOSE,
  BASELINE_OPEN,
  describeJsonImbalance,
  findBaselineRange,
  parseHistorianOutput,
  compartmentHeader,
  renderBaseline,
  renderCompartment,
  repairHistorianJson,
  selectTier,
  stripBaseline,
  type Compartment,
} from '../src/core/compartments.ts'

const VALID = JSON.stringify({
  summary: { p1: 'full detail', p2: 'essentials', p3: 'terse', p4: 'gist' },
  importance: 72,
  facts: [{ category: 'CONSTRAINTS', content: 'fact one' }],
  events: ['tried X'],
})

function compartment(overrides: Partial<Compartment> = {}): Compartment {
  return {
    sessionId: 's1',
    compartmentId: 1,
    createdAt: 0,
    coveredStartSeq: 1,
    coveredEndSeq: 4,
    coveredSeqs: [1, 2, 4],
    coveredTokens: 100,
    importance: 50,
    tiers: { p1: 'P1 body', p2: 'P2 body', p3: 'P3 body', p4: 'P4 body' },
    facts: [],
    events: [],
    baselineEpoch: 1,
    ...overrides,
  }
}

describe('historian output contract', () => {
  it('accepts a valid digest, including JSON wrapped in prose', () => {
    const draft = parseHistorianOutput(`here you go:\n${VALID}\nthanks`)
    expect(draft.tiers.p1).toBe('full detail')
    expect(draft.importance).toBe(72)
    // Magic Context's promotable shape: every fact carries a category.
    expect(draft.facts).toEqual([{ category: 'CONSTRAINTS', content: 'fact one' }])
    expect(draft.events).toEqual(['tried X'])
  })

  it('tolerates legacy plain-string and unknown-category facts without failing the run', () => {
    // A model that ignores the instruction must not lose the whole digest.
    const draft = parseHistorianOutput(JSON.stringify({
      summary: { p1: 'a', p2: 'b', p3: 'c', p4: 'd' },
      facts: ['legacy plain string', { category: 'MADE_UP', content: 'unknown category' }, { content: 'no category' }],
    }))
    expect(draft.facts).toEqual([
      { category: '', content: 'legacy plain string' },
      { category: 'MADE_UP', content: 'unknown category' },
      { category: '', content: 'no category' },
    ])
  })

  it('fails closed on every contract violation', () => {
    expect(() => parseHistorianOutput('no json here')).toThrow(/no JSON object/)
    expect(() => parseHistorianOutput('{ not json }')).toThrow(/invalid JSON/)
    expect(() => parseHistorianOutput(JSON.stringify({ summary: { p1: 'a' }, importance: 1 })))
      .toThrow(/summary\.p2/)
    expect(() => parseHistorianOutput(JSON.stringify({
      summary: { p1: 'a', p2: 'b', p3: 'c', p4: '   ' },
    }))).toThrow(/summary\.p4/)
    expect(() => parseHistorianOutput(JSON.stringify({
      summary: { p1: 'a', p2: 'b', p3: 'c', p4: 'd' }, facts: 'nope',
    }))).toThrow(/facts must be an array/)
    expect(() => parseHistorianOutput(JSON.stringify({
      summary: { p1: 'a', p2: 'b', p3: 'c', p4: 'd' }, events: 'nope',
    }))).toThrow(/must be arrays/)
  })

  it('clamps importance and defaults it to 50', () => {
    const clamped = parseHistorianOutput(JSON.stringify({
      summary: { p1: 'a', p2: 'b', p3: 'c', p4: 'd' }, importance: 250,
    }))
    expect(clamped.importance).toBe(100)
    const defaulted = parseHistorianOutput(JSON.stringify({ summary: { p1: 'a', p2: 'b', p3: 'c', p4: 'd' } }))
    expect(defaulted.importance).toBe(50)
    expect(defaulted.facts).toEqual([])
  })
})

describe('tier ladder', () => {
  it('renders the same bytes whenever it is rendered', () => {
    const row = compartment({ compartmentId: 7, createdAt: 0 })
    const header = compartmentHeader(row, 0)
    expect(header).toContain('§C7§')
    expect(header).not.toMatch(/\d+m ago/)
    // Pure function of (row, positional age): no clock, no drift.
    expect(renderCompartment(row, 0)).toBe(renderCompartment(row, 0))
  })

  it('degrades by positional age (compartments), never by the clock', () => {
    expect(selectTier(50, 0)).toBe('p1')
    expect(selectTier(50, 3)).toBe('p2')
    expect(selectTier(50, 8)).toBe('p3')
    expect(selectTier(50, 20)).toBe('p4')
    // importance promotes one step, never beyond p1
    expect(selectTier(90, 3)).toBe('p1')
    expect(selectTier(90, 20)).toBe('p3')
    // low importance demotes one step, never beyond p4
    expect(selectTier(10, 0)).toBe('p2')
    expect(selectTier(10, 20)).toBe('p4')
    // Positional age, not wall-clock age — the clock is not an input at all,
    // which is what makes the rendered block byte-stable (upstream
    // `mc-core/src/decay.rs:61-62`: "`a` is the 0-based age").
    expect(selectTier(50, -3)).toBe('p1')
  })
})

describe('baseline rendering', () => {
  it('renders memories, the frozen baseline and the delta', () => {
    const block = renderBaseline({
      now: 1000,
      baseline: [compartment({ compartmentId: 1 })],
      delta: [compartment({ compartmentId: 2, createdAt: 500, importance: 90, tiers: { p1: 'FRESH', p2: 'b', p3: 'c', p4: 'd' } })],
      memories: ['- [CONSTRAINTS] never commit secrets'],
      budgetTokens: 5000,
    })
    expect(block.startsWith(BASELINE_OPEN)).toBe(true)
    expect(block.endsWith(BASELINE_CLOSE)).toBe(true)
    expect(block).toContain('<project-memories>')
    expect(block).toContain('never commit secrets')
    expect(block).toContain('<compartment-baseline>')
    expect(block).toContain('§C1§')
    expect(block).toContain('<compartment-delta>')
    expect(block).toContain('FRESH')
  })

  it('compresses older baseline compartments to p4 when the budget is tight', () => {
    const block = renderBaseline({
      now: 1000,
      baseline: [compartment({ compartmentId: 1, tiers: { p1: 'A'.repeat(400), p2: 'b', p3: 'c', p4: 'p4-only' } })],
      delta: [],
      memories: [],
      budgetTokens: 40,
    })
    expect(block).toContain('p4-only')
    expect(block).not.toContain('A'.repeat(400))
  })

  it('returns an empty block when there is nothing to inject', () => {
    expect(renderBaseline({ now: 0, baseline: [], delta: [], memories: [], budgetTokens: 10 })).toBe('')
  })

  it('round-trips the baseline block through strip/find', () => {
    const text = `${BASELINE_OPEN}\n<compartment-delta>\n§C9§ hi\n</compartment-delta>\n${BASELINE_CLOSE}\n\n§1§ user words`
    const range = findBaselineRange(text)
    expect(range).toBeDefined()
    expect(text.slice(range!.start, range!.end)).toContain('§C9§')
    expect(stripBaseline(text)).toBe('§1§ user words')
    expect(stripBaseline('no baseline here')).toBe('no baseline here')
  })
})

/**
 * The imbalance scan exists because the journal could not answer the question it
 * was asked. All four live invalid-JSON failures ended at the last character of
 * the output while their recorded tails were well-formed endings, so the missing
 * bracket was somewhere in the middle — the one part 120 characters of tail could
 * never show. These cases pin the four shapes that distinction has to cover.
 */
describe('describeJsonImbalance', () => {
  it('reports nothing for balanced text', () => {
    expect(describeJsonImbalance('{"a":1,"b":[1,2]}')).toBe('')
    expect(describeJsonImbalance('')).toBe('')
  })

  it('names the mismatch the live failures hit — an array closed by a brace', () => {
    // "expected ',' or ']' after array element" at the FINAL character: the
    // model writes `"..."}` where `"..."]}` belongs, so the closing `}` meets an
    // open `[`. Naming the pair is sharper than saying "unclosed".
    expect(describeJsonImbalance('{"a":["x","y"}')).toBe("'[' closed by '}'")
  })

  it('reports a closer that never arrived at all', () => {
    expect(describeJsonImbalance('["x","y"')).toBe("unclosed ']'×1")
  })

  it('counts several unclosed groups, outermost first', () => {
    expect(describeJsonImbalance('{"a":[{"b":1}')).toBe("unclosed '}'×1+']'×1")
  })

  it('ignores brackets inside string literals', () => {
    expect(describeJsonImbalance('{"a":"}}]","b":"[{","c":1}')).toBe('')
  })

  it('does not mistake an escaped quote for the end of a string', () => {
    expect(describeJsonImbalance('{"a":"he said \\"}\\" ok","b":2}')).toBe('')
  })

  it('reports an unexpected closer and a mismatched pair', () => {
    expect(describeJsonImbalance('{"a":1}}')).toBe("unexpected '}'")
    expect(describeJsonImbalance('[}')).toBe("'[' closed by '}'")
  })

  it('reports an unterminated string', () => {
    expect(describeJsonImbalance('{"a":"never closed')).toBe('unterminated string')
  })

  it('rides along in the parse error, so the journal carries the diagnosis', () => {
    expect(() => parseHistorianOutput('{"summary":["x"}')).toThrow(/closed by '\}'/)
  })

  it('adds no suffix when the text balances but is still invalid JSON', () => {
    // A missing comma balances perfectly — the scan must not invent a bracket story.
    expect(() => parseHistorianOutput('{"a":1 "b":2}')).toThrow(/invalid JSON/)
    try {
      parseHistorianOutput('{"a":1 "b":2}')
    } catch (error) {
      expect((error as Error).message).not.toContain('unclosed')
      expect((error as Error).message).not.toContain('unexpected')
    }
  })
})

/**
 * `repairHistorianJson` — the two shapes that break `JSON.parse` on a real
 * model response, and the one shape that must keep failing.
 *
 * Live trigger (2026-11-10 16:49:17): a 105k-token span chunked 3 ways came
 * back `finishReason=stop`, 6,131 characters, `invalid JSON (position 1132,
 * line 3 column 1116)` — one long line, i.e. a digest written with real
 * newlines instead of `\n`.
 */
describe('historian JSON repair', () => {
  const round = (raw: string) => JSON.parse(repairHistorianJson(raw).text) as Record<string, unknown>

  it('escapes raw newlines and tabs inside strings', () => {
    const raw = '{"summary":{"p1":"line one\nline two\tend","p2":"b","p3":"c","p4":"d"}}'
    const repaired = repairHistorianJson(raw)
    expect(repaired.notes).toContain('raw-newline')
    expect(repaired.notes).toContain('raw-tab')
    expect(round(raw).summary).toMatchObject({ p1: 'line one\nline two\tend' })
    // …and the real parser accepts it end to end.
    expect(parseHistorianOutput(raw).tiers.p1).toBe('line one\nline two\tend')
  })

  it('doubles a backslash that starts no valid escape', () => {
    // NB `C:\temp` would NOT be repaired: `\t` is a valid JSON escape, so the
    // text is legal JSON whose meaning is a tab. Only invalid escapes (a path
    // like `C:\data`, a `\§` in prose) are unambiguous enough to fix.
    const raw = '{"summary":{"p1":"path C:\\data\\§x","p2":"b","p3":"c","p4":"d"}}'
    expect(repairHistorianJson(raw).notes).toContain('bad-escape')
    expect(round(raw).summary).toMatchObject({ p1: 'path C:\\data\\§x' })
  })

  it('leaves a well-formed response byte-identical', () => {
    const raw = JSON.stringify({ summary: { p1: 'a', p2: 'b', p3: 'c', p4: 'd' }, importance: 55 })
    expect(repairHistorianJson(raw)).toEqual({ text: raw, notes: [] })
  })

  it('does NOT rescue a truncated object — a half digest must fail loudly', () => {
    const raw = '{"summary":{"p1":"only the first tier","p2":"b"'
    expect(() => parseHistorianOutput(raw)).toThrow(/no JSON object|invalid JSON/)
  })
})
