/**
 * Importance semantics + the merge prompt's scoring instruction.
 *
 * Two separate defects met here, and either one alone produced the same symptom
 * (every merged compartment stored at 50):
 *
 *   1. the parser treated an explicit `importance="0"` as "absent" and fell back
 *      to 50 (upstream keeps 0 and clamps to 1 at render time);
 *   2. the merge prompt's contract example literally read `importance="0"`, and a
 *      literal example is the strongest signal in a prompt — the model copied it.
 */
import { describe, expect, it } from 'vitest'
import { parseHistorianOutput, selectTier } from '../src/core/compartments.ts'
import { HISTORIAN_MERGE_INSTRUCTION } from '../src/dsh/historian.ts'

const wrap = (importanceAttr: string): string => [
  '<output><compartments>',
  `<compartment start="1" end="2" title="Setup" episode_type="infra"${importanceAttr}>`,
  '<p1>Did the thing.</p1><p2>Thing.</p2><p3>Thing.</p3><p4/>',
  '</compartment>',
  '</compartments></output>',
].join('\n')

describe('importance parsing', () => {
  it('keeps an explicit 0 instead of promoting it to 50', () => {
    expect(parseHistorianOutput(wrap(' importance="0"')).importance).toBe(0)
  })

  it('defaults to 50 only when the attribute is absent', () => {
    expect(parseHistorianOutput(wrap('')).importance).toBe(50)
  })

  it('keeps a normal score untouched', () => {
    expect(parseHistorianOutput(wrap(' importance="88"')).importance).toBe(88)
  })

  it('clamps out-of-range scores', () => {
    expect(parseHistorianOutput(wrap(' importance="140"')).importance).toBe(100)
  })

  it('an explicit 0 decays much faster than an absent-score 50', () => {
    // Age 0 is P1 for every score (z is 0), so compare where they diverge:
    // importance 0 halves the half-life four times over vs 50.
    expect(selectTier(0, 10)).toBe('p4')
    expect(selectTier(50, 10)).toBe('p2')
  })
})

describe('merge instruction', () => {
  it('does not teach the model to emit importance="0"', () => {
    expect(HISTORIAN_MERGE_INSTRUCTION).not.toContain('importance="0"')
  })

  it('shows a realistic example score', () => {
    expect(HISTORIAN_MERGE_INSTRUCTION).toContain('importance="70"')
  })

  it('asks for a score for the merged unit and points at the partials', () => {
    expect(HISTORIAN_MERGE_INSTRUCTION).toContain('MERGED work unit')
    expect(HISTORIAN_MERGE_INSTRUCTION).toContain('calibration anchors')
    expect(HISTORIAN_MERGE_INSTRUCTION).toContain('near the HIGHEST partial')
  })
})
