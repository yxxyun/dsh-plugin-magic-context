/**
 * The four refusals that guard consolidation.
 *
 * Each rule exists because a specific failure mode deletes a fact:
 *
 *  - an archive with no live successor removes knowledge without saying so;
 *  - a user-profile citation publishes local knowledge as a personal preference;
 *  - merging two directives loses one of two independently-violable rules;
 *  - a rewrite that keeps a fraction of the text replaced the fact, not tightened it.
 *
 * These are pure functions, so the tests read as the rules themselves.
 */
import { describe, expect, it } from 'vitest'
import {
  assessCurateMutationSafety,
  isDirectiveShapedProjectRule,
  type CurateCandidateRow,
} from '../src/core/curate-safety.ts'

const NOW = 1_800_000_000_000

const row = (over: Partial<CurateCandidateRow> & { id: number; content: string }): CurateCandidateRow => ({
  category: 'ARCHITECTURE',
  status: 'active',
  supersededByMemoryId: null,
  ...over,
})

describe('isDirectiveShapedProjectRule', () => {
  it('recognises policy modals', () => {
    expect(isDirectiveShapedProjectRule('PROJECT_RULES', 'You must never push directly to main.')).toBe(true)
    expect(isDirectiveShapedProjectRule('PROJECT_RULES', 'Always run the formatter before committing')).toBe(true)
    expect(isDirectiveShapedProjectRule('PROJECT_RULES', "Don't commit generated files")).toBe(true)
  })

  it('recognises actor policy', () => {
    expect(isDirectiveShapedProjectRule('PROJECT_RULES', 'Agents should not edit vendored code')).toBe(true)
    expect(isDirectiveShapedProjectRule('PROJECT_RULES', 'Maintainers must approve breaking changes')).toBe(true)
  })

  it('recognises behavioral when-clauses', () => {
    expect(isDirectiveShapedProjectRule('PROJECT_RULES', 'When debugging, check the journal first')).toBe(true)
    expect(isDirectiveShapedProjectRule('PROJECT_RULES', 'When you are reviewing, prefer the diff')).toBe(true)
  })

  it('recognises workflow imperatives', () => {
    expect(isDirectiveShapedProjectRule('PROJECT_RULES', 'Run the phase gate before claiming done')).toBe(true)
    expect(isDirectiveShapedProjectRule('PROJECT_RULES', 'Prefer edit over write for existing files')).toBe(true)
  })

  it('recognises decision authority', () => {
    expect(isDirectiveShapedProjectRule('PROJECT_RULES', 'The operator has the final say on scope')).toBe(true)
  })

  it('leaves declarative claims alone', () => {
    // A statement about the code is verifiable, and merging it is ordinary dedup.
    expect(isDirectiveShapedProjectRule('PROJECT_RULES', 'The scheduler tick runs every five minutes')).toBe(false)
    expect(isDirectiveShapedProjectRule('PROJECT_RULES', 'policy.ts exports decidePass')).toBe(false)
  })

  it('only gates PROJECT_RULES', () => {
    // The same imperative wording inside ARCHITECTURE is a statement about the
    // code, not a team rule.
    expect(isDirectiveShapedProjectRule('ARCHITECTURE', 'You must never push to main')).toBe(false)
  })

  it('ignores empty content', () => {
    expect(isDirectiveShapedProjectRule('PROJECT_RULES', '   ')).toBe(false)
  })
})

describe('assessCurateMutationSafety — archive', () => {
  it('refuses an archive whose successor is gone', () => {
    const refusal = assessCurateMutationSafety({
      memory: row({ id: 1, content: 'duplicate fact' }),
      verdict: 'archive',
      successor: row({ id: 2, content: 'the other one', status: 'archived' }),
      now: NOW,
    })
    expect(refusal?.reason).toBe('missing-active-same-category-successor')
  })

  it('refuses an archive into a different category', () => {
    const refusal = assessCurateMutationSafety({
      memory: row({ id: 1, content: 'fact', category: 'ARCHITECTURE' }),
      verdict: 'archive',
      successor: row({ id: 2, content: 'fact', category: 'CONSTRAINTS' }),
      now: NOW,
    })
    expect(refusal?.reason).toBe('missing-active-same-category-successor')
  })

  it('refuses an archive into an expired successor', () => {
    const refusal = assessCurateMutationSafety({
      memory: row({ id: 1, content: 'fact' }),
      verdict: 'archive',
      successor: row({ id: 2, content: 'fact', expiresAt: NOW - 1 }),
      now: NOW,
    })
    expect(refusal?.reason).toBe('missing-active-same-category-successor')
  })

  it('permits an archive into a live same-category successor', () => {
    expect(assessCurateMutationSafety({
      memory: row({ id: 1, content: 'duplicate fact' }),
      verdict: 'archive',
      successor: row({ id: 2, content: 'the canonical fact' }),
      now: NOW,
    })).toBeNull()
  })

  it('refuses a drop justified by a user profile', () => {
    const refusal = assessCurateMutationSafety({
      memory: row({ id: 1, content: 'project fact', category: 'ARCHITECTURE' }),
      verdict: 'archive',
      reason: 'superseded by user profile U12',
      successor: null,
      now: NOW,
    })
    expect(refusal?.reason).toBe('user-profile-is-not-project-memory')
  })
})

describe('assessCurateMutationSafety — directives', () => {
  it('refuses to archive a directive, with or without a successor', () => {
    const directive = row({ id: 1, content: 'Never push without approval', category: 'PROJECT_RULES' })
    expect(assessCurateMutationSafety({
      memory: directive, verdict: 'archive', successor: null, now: NOW,
    })?.reason).toBe('directive-shaped-project-rule')
    expect(assessCurateMutationSafety({
      memory: directive, verdict: 'archive',
      successor: row({ id: 2, content: 'some other rule', category: 'PROJECT_RULES' }),
      now: NOW,
    })?.reason).toBe('directive-shaped-project-rule')
  })

  it('refuses to merge a directive', () => {
    const refusal = assessCurateMutationSafety({
      memory: row({ id: 1, content: 'Always run the tests', category: 'PROJECT_RULES' }),
      verdict: 'merge',
      replacementContent: 'Always run the tests and the linter',
      successor: row({ id: 2, content: 'Always run the linter', category: 'PROJECT_RULES' }),
      now: NOW,
    })
    expect(refusal?.reason).toBe('directive-shaped-project-rule')
  })
})

describe('assessCurateMutationSafety — merge', () => {
  it('permits a merge that keeps most of the text', () => {
    expect(assessCurateMutationSafety({
      memory: row({ id: 1, content: 'The scheduler tick is five minutes and runs sequentially.' }),
      verdict: 'merge',
      replacementContent: 'The scheduler tick is five minutes, runs sequentially, and takes a lease first.',
      successor: row({ id: 2, content: 'Ticks take a lease' }),
      now: NOW,
    })).toBeNull()
  })

  it('refuses a rewrite that loses most of the original', () => {
    const refusal = assessCurateMutationSafety({
      memory: row({ id: 1, content: 'The scheduler tick is five minutes and runs sequentially with a lease.' }),
      verdict: 'merge',
      replacementContent: 'Tick is 5m.',
      successor: row({ id: 2, content: 'other' }),
      now: NOW,
    })
    expect(refusal?.reason).toBe('content-loss')
    expect(refusal?.originalChars).toBeGreaterThan(refusal?.replacementChars ?? 0)
  })

  it('refuses a merge with no successor', () => {
    const refusal = assessCurateMutationSafety({
      memory: row({ id: 1, content: 'a fact that is reasonably long' }),
      verdict: 'merge',
      replacementContent: 'a fact that is reasonably long',
      successor: null,
      now: NOW,
    })
    expect(refusal?.reason).toBe('missing-active-same-category-successor')
  })
})
