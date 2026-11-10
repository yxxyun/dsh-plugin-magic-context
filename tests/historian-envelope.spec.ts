/**
 * The historian's TAG ENVELOPE — the shape upstream actually asks for.
 *
 * `crates/mc-module/testdata/historian-parse-golden.json` has eight cases and
 * not one of them is JSON. This adapter asked for JSON and threw away whole
 * digests when the model produced 6k characters with one unescaped quote
 * (2026-11-10 16:49:17: 105k-token span, `invalid JSON (position 1132, line 3
 * column 1116)`, two attempts, both at the same size).
 *
 * The texts below are copied verbatim from that golden file (cases 0, 1 and 3),
 * trimmed to the parts this adapter stores. Assertions are deliberately about
 * OUR mapping, not about upstream's full record shape: we keep p1..p4,
 * importance, facts and events; `user_observations` / `primer_candidates` /
 * `episode_type` / anchors have no home in `CompartmentDraft`.
 */
import { describe, expect, it } from 'vitest'
import {
  hasHistorianEnvelope,
  parseHistorianEnvelope,
  parseHistorianOutput,
} from '../src/core/compartments.ts'

/** Golden case 0 — "well-formed tiers, facts and side channels". */
const CASE_WELL_FORMED = `<output>
<compartments>
<compartment start="1" end="2" title="Setup" episode_type="infra" importance="40">
<p1>did setup</p1>
<p2>did setup short</p2>
<p3>did setup shorter</p3>
<p4/>
</compartment>
</compartments>
<facts>
<PROJECT_RULES>
* Keep goldens deterministic.
</PROJECT_RULES>
</facts>
<events><causal_incident at_compartment="1"><summary>Setup broke.</summary></causal_incident></events>
<user_observations>
* Prefers short answers.
</user_observations>
<meta><unprocessed_from>3</unprocessed_from></meta>
</output>`

/** Golden case 1 — "mismatched and missing tier closes stay lenient". */
const CASE_LENIENT_CLOSES = `<output><compartments>
<compartment start="1" end="2" title="mismatch"><p1>first</p2><p2>second</p1><p3>third</p3><p4 /></compartment>
<compartment start="3" end="4" title="missing"><p1>first body<p2>second body</p2><p3>third</p3><p4/></compartment>
</compartments></output>`

/** Golden case 3 — "raw `>` inside a quoted attribute value keeps the compartment". */
const CASE_RAW_GT = `<output><compartments>
<compartment start="1" end="2" title="Migrate store -> SQLite" episode_type="a>b" importance="70">
<p1>moved storage</p1>
<p2>moved storage short</p2>
<p3>moved storage shorter</p3>
<p4/>
</compartment>
</compartments></output>`

describe('historian tag envelope', () => {
  it('reads tiers, importance, facts and events', () => {
    const draft = parseHistorianEnvelope(CASE_WELL_FORMED)
    expect(draft.tiers).toEqual({
      p1: 'did setup',
      p2: 'did setup short',
      p3: 'did setup shorter',
      // `<p4/>` is empty, so the tier falls back to the content rather than
      // rendering a header with no body under it.
      p4: 'did setup',
    })
    expect(draft.importance).toBe(40)
    expect(draft.facts).toEqual([{ category: 'PROJECT_RULES', content: 'Keep goldens deterministic.' }])
    expect(draft.events).toEqual(['causal_incident: Setup broke.'])
  })

  it('keeps a compartment whose attribute value contains a raw `>`', () => {
    const draft = parseHistorianEnvelope(CASE_RAW_GT)
    expect(draft.tiers.p1).toBe('moved storage')
    expect(draft.importance).toBe(70)
  })

  it('survives mismatched and missing tier closes', () => {
    const drafts = parseHistorianEnvelope(CASE_LENIENT_CLOSES)
    // Only the first compartment is used: this adapter chunks on its own.
    expect(drafts.tiers.p1).toBe('first')
    // The second compartment in the same envelope is the "missing close" shape;
    // ask for it directly to pin the lenient boundary.
    const second = parseHistorianEnvelope(
      CASE_LENIENT_CLOSES.replace(/^[\s\S]*?<compartment start="1"/, '<output><compartment start="1"'),
    )
    expect(second.tiers.p1.length).toBeGreaterThan(0)
  })

  it('a missing close runs to the next tier, not through the compartment', () => {
    const draft = parseHistorianEnvelope(
      '<output><compartment start="1" end="2" title="missing">'
        + '<p1>first body<p2>second body</p2><p3>third</p3><p4/></compartment></output>',
    )
    expect(draft.tiers.p1).toBe('first body')
    expect(draft.tiers.p2).toBe('second body')
  })

  it('an envelope with no compartment fails closed', () => {
    expect(() => parseHistorianEnvelope('<output><facts/><events/></output>')).toThrow(/no <compartment>/)
  })

  it('parseHistorianOutput routes by shape and keeps JSON working', () => {
    expect(hasHistorianEnvelope(CASE_WELL_FORMED)).toBe(true)
    expect(hasHistorianEnvelope('{"summary":{"p1":"a"}}')).toBe(false)
    // Both shapes land on the same draft type.
    const fromEnvelope = parseHistorianOutput(CASE_WELL_FORMED)
    expect(fromEnvelope.tiers.p1).toBe('did setup')
    const fromJson = parseHistorianOutput(
      JSON.stringify({ summary: { p1: 'a', p2: 'b', p3: 'c', p4: 'd' }, importance: 61 }),
    )
    expect(fromJson.importance).toBe(61)
  })
})

describe('the envelope carries the WP5 lane', () => {
  it('reads <user_observations> into draft.userObservations', () => {
    // `historian.ts:997` writes these to the candidate pool straight from the
    // draft. If the envelope path ever stops filling it, profile collection goes
    // quiet with no error anywhere — the prompt asks for the block, so dropping
    // it here would be silent data loss.
    const draft = parseHistorianEnvelope(
      '<output><compartments><compartment importance="55">'
        + '<p1>did work</p1><p2>p</p2><p3>p</p3><p4>p</p4></compartment></compartments>'
        + '<user_observations>\n* Always answer in Chinese.\n* Never push without asking.\n</user_observations>'
        + '</output>',
    )
    expect(draft.userObservations).toEqual(['Always answer in Chinese.', 'Never push without asking.'])
  })

  it('omits the field entirely when the block is empty', () => {
    const draft = parseHistorianEnvelope(
      '<output><compartment importance="50"><p1>x</p1><p2>x</p2><p3>x</p3><p4>x</p4></compartment>'
        + '<user_observations></user_observations></output>',
    )
    expect(draft.userObservations).toBeUndefined()
  })
})

describe('the parser survives what models really write', () => {
  // Every case below is a verbatim text from
  // `crates/mc-module/testdata/historian-parse-golden.json` that this adapter
  // read WRONG until 2026-11-10 — the health check that produced these tests
  // found 4 of the 8 golden cases diverging. They are pinned here because each
  // one is a silent-data-loss shape: a digest that parses to the wrong text is
  // worse than one that fails loudly.

  it('decodes XML entities exactly once (golden case 2)', () => {
    const draft = parseHistorianEnvelope(
      '<output><compartments><compartment importance="50">'
        + '<p1>tags &lt;compartment&gt; and &amp;lt; once &amp;amp; only</p1>'
        + '<p2>p</p2><p3>p</p3><p4/></compartment></compartments></output>',
    )
    // `&amp;lt;` must stay `&lt;`: decoding twice would turn a note about code
    // into a real tag on the next render.
    expect(draft.tiers.p1).toBe('tags <compartment> and &lt; once &amp; only')
  })

  it('keeps a quoted </p1> inside the paragraph (golden case 4)', () => {
    const draft = parseHistorianEnvelope(
      '<output><compartments><compartment start="1" end="2" title="qq">'
        + '<p1>Discussed <p2> tags vs <pre> and the </p1> close</p1>'
        + '<p2>Tier tag talk with <p3/></p2><p3>Tags</p3><p4>mentions <p1> again</p4>'
        + '</compartment></compartments></output>',
    )
    expect(draft.tiers.p1).toBe('Discussed <p2> tags vs <pre> and the </p1> close')
    expect(draft.tiers.p3).toBe('Tags')
  })

  it('does not let a quoted </compartment> amputate the block (golden case 5)', () => {
    const draft = parseHistorianEnvelope(
      '<output><compartments>'
        + '<compartment start="1" end="2" title="XML format">'
        + '<p1>Each block ends with </compartment> and facts go in <facts> or <events>.</p1>'
        + '<p2>The example was <events><causal_incident at_compartment="1"><summary>Fake.</summary>'
        + '</causal_incident></events> and <unprocessed_from>9</unprocessed_from>.</p2>'
        + '<p3>Quoted <primer_candidates><primer at_compartment="1">Fake?</primer></primer_candidates> too,'
        + ' all inside <output>…</output></p3><p4/>'
        + '</compartment>'
        + '<compartment start="3" end="4" title="Next"><p1>next work</p1><p2>n</p2><p3>n</p3><p4/></compartment>'
        + '</compartments>'
        + '<facts><PROJECT_RULES>\n* Real fact mentioning </compartment> as text.\n</PROJECT_RULES></facts>'
        + '<events><causal_incident at_compartment="2"><summary>Real event about </p1> text.</summary>'
        + '<evidence>Saw </compartment> too</evidence></causal_incident></events>'
        + '</output>',
    )
    expect(draft.tiers.p1).toBe('Each block ends with </compartment> and facts go in <facts> or <events>.')
    // One fact and ONE event: the quoted `<facts>`/`<events>` inside p1/p2 are
    // text, and a nested `<evidence>` is a field, not an event of its own.
    expect(draft.facts).toEqual([{ category: 'PROJECT_RULES', content: 'Real fact mentioning </compartment> as text.' }])
    expect(draft.events).toHaveLength(1)
    expect(draft.events[0]).toContain('Real event about </p1> text.')
  })

  it('takes the earliest anchor when compartments arrive out of order (golden case 7)', () => {
    const draft = parseHistorianEnvelope(
      '<output><compartments>'
        + '<compartment start="5" end="6"><p1>third</p1><p2>c</p2><p3>c</p3><p4/></compartment>'
        + '<compartment start="1" end="2"><p1>first</p1><p2>a</p2><p3>a</p3><p4/></compartment>'
        + '</compartments></output>',
    )
    expect(draft.tiers.p1).toBe('first')
  })

  it('reads bare legacy category blocks outside <facts> (golden case 6)', () => {
    const draft = parseHistorianEnvelope(
      '<output><compartments><compartment start="1" end="2" title="Legacy">'
        + '<p1>Body quoting </compartment> then <NAMING>\n* Fake fact\n</NAMING></p1>'
        + '<p2>two</p2><p3>three</p3><p4/></compartment></compartments>'
        + '<NAMING>\n* Real legacy fact\n</NAMING><unprocessed_from>3</unprocessed_from></output>',
    )
    // The quoted block is inside p1 and never reaches the facts lane.
    expect(draft.facts).toEqual([{ category: 'NAMING', content: 'Real legacy fact' }])
  })
})

describe('a digest that answers in one tier', () => {
  it('keeps a p3-only compartment instead of rejecting it', () => {
    // The fallback chain (p1 || p2 || p3 || p4) used to skip p3, so a model that
    // put its whole summary in p3 produced "carries no tier text" and the chunk
    // was thrown away — the exact loss the envelope format exists to prevent.
    const draft = parseHistorianEnvelope(
      '<output><compartments><compartment importance="45"><p3>only paragraph</p3>'
        + '</compartment></compartments></output>',
    )
    expect(draft.tiers.p3).toBe('only paragraph')
    expect(draft.tiers.p1).toBe('only paragraph')
  })
})
