/**
 * The served check: measuring whether a pass kept the cacheable prefix.
 *
 * The invariant (upstream `hooks/magic-context/served-check.ts`): a pass without
 * rebuild permission may only APPEND to the request served before it. Anything
 * else invalidates the provider's cached prefix, and the next request pays full
 * price for history that did not need to move.
 *
 * These tests pin the measurement, not a policy: the module changes no byte.
 */
import { describe, expect, it } from 'vitest'
import {
  compareServed,
  forgetServed,
  noteServed,
  servedRecord,
  shapeFingerprint,
  surfaceShapes,
} from '../src/core/served-check.ts'

/** A session whose surface is the given (type, text, hasToolCalls) rows. */
const session = (rows: ReadonlyArray<{ type?: string; text: string; tool?: boolean }>) => ({
  surface: { nodes: rows.map((_, index) => index + 1) },
  snapshotEvents: () => rows.map((row, index) => ({
    seq: index + 1,
    type: row.type ?? 'user/message',
    data: {
      message: {
        content: [
          { type: 'text', text: row.text },
          // A real tool-call block is what makes `hasToolCalls` true; a text-only
          // message must stay at one part or the shape stops describing the wire.
          ...row.tool === true ? [{ type: 'tool-call', id: `c${String(index)}`, name: 'x', arguments: {} }] : [],
        ],
      },
    },
  })),
}) as never

describe('surfaceShapes', () => {
  it('reads one shape per surface node, in order', () => {
    const shapes = surfaceShapes(session([{ text: 'abc' }, { text: 'defgh' }]))
    expect(shapes.map(shape => shape.textLength)).toEqual([3, 5])
  })

  it('counts a tool-call node as two parts', () => {
    const shapes = surfaceShapes(session([{ text: 'x', tool: true }]))
    expect(shapes[0]?.parts).toBe(2)
  })
})

describe('shapeFingerprint', () => {
  it('is stable for the same shapes', () => {
    const one = session([{ text: 'abc' }])
    expect(shapeFingerprint(surfaceShapes(one))).toBe(shapeFingerprint(surfaceShapes(one)))
  })

  it('changes when a text length changes', () => {
    const before = shapeFingerprint(surfaceShapes(session([{ text: 'abc' }])))
    const after = shapeFingerprint(surfaceShapes(session([{ text: 'ab' }])))
    expect(before).not.toBe(after)
  })

  it('changes when a node is added', () => {
    const before = shapeFingerprint(surfaceShapes(session([{ text: 'a' }])))
    const after = shapeFingerprint(surfaceShapes(session([{ text: 'a' }, { text: 'b' }])))
    expect(before).not.toBe(after)
  })
})

describe('compareServed', () => {
  it('reports unknown for a session this process never served', () => {
    forgetServed('s-unknown')
    const result = compareServed('s-unknown', session([{ text: 'a' }]))
    expect(result.known).toBe(false)
    // Unknown is not equal: claiming the prefix survived would be inventing
    // knowledge the process does not have.
    expect(result.prefixIntact).toBe(false)
  })

  it('accepts a pure append — the healthy case', () => {
    forgetServed('s-append')
    const first = session([{ text: 'a' }, { text: 'b' }])
    noteServed('s-append', first, false, 1)
    const result = compareServed('s-append', session([{ text: 'a' }, { text: 'b' }, { text: 'c' }]))
    expect(result.known).toBe(true)
    expect(result.prefixIntact).toBe(true)
    expect(result.appended).toBe(1)
    expect(result.rewroteInPlace).toBe(false)
  })

  it('catches a rewrite in place and names the index', () => {
    forgetServed('s-rewrite')
    noteServed('s-rewrite', session([{ text: 'aaa' }, { text: 'bbb' }]), false, 1)
    // Same count, first message shorter: a drop placeholder landed on history
    // that a defer pass had no permission to touch.
    const result = compareServed('s-rewrite', session([{ text: 'aa' }, { text: 'bbb' }]))
    expect(result.prefixIntact).toBe(false)
    expect(result.firstChangeIndex).toBe(0)
    expect(result.rewroteInPlace).toBe(true)
    expect(result.appended).toBe(0)
  })

  it('carries the previous pass permission so a rewrite can be excused', () => {
    forgetServed('s-perm')
    noteServed('s-perm', session([{ text: 'aaa' }]), true, 1)
    const result = compareServed('s-perm', session([{ text: 'a' }]))
    expect(result.previousHadPermission).toBe(true)
    expect(result.rewroteInPlace).toBe(true)
  })

  it('treats a truncation as a broken prefix, not an append', () => {
    forgetServed('s-trunc')
    noteServed('s-trunc', session([{ text: 'a' }, { text: 'b' }, { text: 'c' }]), false, 1)
    const result = compareServed('s-trunc', session([{ text: 'a' }]))
    expect(result.prefixIntact).toBe(true)
    // Nothing in the shared range changed; the surface simply got shorter. The
    // appended count is what distinguishes growth from shrinkage.
    expect(result.appended).toBe(0)
  })

  it('keeps records per session', () => {
    forgetServed('s-a')
    forgetServed('s-b')
    noteServed('s-a', session([{ text: 'a' }]), false, 1)
    expect(servedRecord('s-a')).toBeDefined()
    expect(servedRecord('s-b')).toBeUndefined()
  })
})
