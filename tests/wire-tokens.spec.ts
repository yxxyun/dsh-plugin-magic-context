/**
 * Wire tokens vs text tokens (`wireTokensOfSurfaceEvent`).
 *
 * The distinction is the whole 2.4x gap measured on 2026-11-18: the adapter's
 * `text` view of a message excludes tool-call arguments and reasoning blocks by
 * design, while the provider bills for every block. An estimator built on `text`
 * is systematically optimistic — and in a tool-heavy session, wildly so.
 */
import { describe, expect, it } from 'vitest'
import { wireTokensOfSurfaceEvent } from '../src/dsh/seams.ts'

const event = (content: unknown[]) =>
  ({ seq: 1, type: 'assistant/message', data: { message: { content } } }) as never
const count = (chunks: unknown[]): number =>
  wireTokensOfSurfaceEvent(event(chunks), text => text.length)

describe('wireTokensOfSurfaceEvent', () => {
  it('charges text blocks', () => {
    expect(count([{ type: 'text', text: 'abcde' }])).toBe(5)
  })

  it('charges reasoning blocks, which the text view drops', () => {
    expect(count([{ type: 'reasoning', text: 'abcd' }])).toBe(4)
  })

  it('charges tool-call arguments, which the text view drops', () => {
    const tokens = count([{ type: 'tool-call', id: 'c1', name: 'x', arguments: { a: 'bbbb' } }])
    // JSON.stringify({a:'bbbb'}) is 12 characters.
    expect(tokens).toBe(12)
  })

  it('sums every block, not just the first', () => {
    const tokens = count([
      { type: 'text', text: 'ab' },
      { type: 'reasoning', text: 'cde' },
      { type: 'tool-call', id: 'c', name: 'n', arguments: {} },
    ])
    expect(tokens).toBeGreaterThan(2 + 3)
  })

  it('charges an image a flat estimate rather than nothing', () => {
    // `image` blocks cost tokens the text estimate cannot see; pretending they
    // are free is how an estimate drifts from the bill.
    expect(count([{ type: 'image', ref: 'x' }])).toBeGreaterThan(100)
  })

  it('charges a tool call with no arguments a token, not zero', () => {
    expect(count([{ type: 'tool-call', id: 'c', name: 'n' }])).toBe(1)
  })

  it('returns zero for a message with no content', () => {
    expect(count([])).toBe(0)
  })
})
