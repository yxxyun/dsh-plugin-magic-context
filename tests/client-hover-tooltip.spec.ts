/**
 * The dock pill's hover contract, pinned at the SOURCE level.
 *
 * Three separate defects produced one visible symptom — the MC pill made the
 * whole window flicker on hover, in some sessions only:
 *
 *  1. The pill handed React MOUSE handlers to the official `Tooltip`, which
 *     clones the element and chains its own POINTER handlers. Every crossing
 *     then ran two independent hover truths (our `setHovered` and the tooltip's
 *     internal `hover` ref + three `setState`s).
 *  2. The bubble the tooltip renders is `position: fixed` but, without
 *     `portal`, it is a SIBLING inside this same subtree — i.e. inside the
 *     composer dock, where the shell's `backdrop-filter` ancestors become its
 *     containing block. The viewport coordinates got reinterpreted against that
 *     box, the bubble was clipped, and its own `ResizeObserver` re-fired on
 *     every write it made.
 *  3. With `width: max-content` + `overflow: auto` + no width cap, the bubble's
 *     text variants (pressure / N err / pressure+memories) could cross a
 *     scrollbar threshold mid-hover and change size between measurements.
 *
 * This spec reads the shipped client source rather than rendering it: the repo
 * has no client test runner (see tests/client-pure.spec.ts), and the regressions
 * above are all decisions visible in the source — one handler family, `portal`
 * on the dock branch, and a finite `maxWidth`.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CLIENT = fileURLToPath(new URL('../src/client/index.js', import.meta.url))
const source = readFileSync(CLIENT, 'utf8')

/** The `el(Tooltip, { ... }, pillCore)` call, balanced-brace sliced. */
function tooltipCall(): string {
  const start = source.indexOf('el(Tooltip, {')
  if (start === -1) throw new Error('the pill no longer wraps in Tooltip')
  let depth = 0
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error('unbalanced Tooltip call')
}

describe('dock pill hover', () => {
  it('drives its own hover from POINTER events only', () => {
    // The tooltip chains onPointerEnter/onPointerLeave onto the same element;
    // a mouse handler next to them is the duplicate truth we removed.
    expect(source).toContain('onPointerEnter: () => setHovered(true)')
    expect(source).toContain('onPointerLeave: () => setHovered(false)')
    expect(source).not.toContain('onMouseEnter: () => setHovered(true)')
    expect(source).not.toContain('onMouseLeave: () => setHovered(false)')
  })

  it('portals the bubble out of the composer dock', () => {
    const call = tooltipCall()
    // `portal` is a real teleport: the tooltip renders
    // `portal ? createPortal(bubble, document.body) : bubble`.
    expect(call).toContain('portal: inDock')
  })

  it('pins a finite bubble width so the text variants cannot resize it', () => {
    const call = tooltipCall()
    const maxWidth = /maxWidth:\s*(\d+)/.exec(call)
    expect(maxWidth).not.toBeNull()
    expect(Number(maxWidth?.[1])).toBeGreaterThan(0)
    expect(Number(maxWidth?.[1])).toBeLessThanOrEqual(400)
  })

  it('keeps the click-to-open behaviour and the tooltip suppression while open', () => {
    const call = tooltipCall()
    // The panel is the richer surface; a bubble on top of it is noise, and the
    // `disabled` flag is also what un-arms the tooltip's own pointer lane.
    expect(call).toContain('disabled: open')
    expect(call).toContain('side: \'top\'')
  })
})
