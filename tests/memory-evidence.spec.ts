/**
 * File evidence for memory verification.
 *
 * Two properties matter here and both are about NOT guessing:
 *
 * - An ambiguous bare filename stays ambiguous. `director.py` matches several
 *   files in a ComfyUI tree; picking one would manufacture a verdict from a coin
 *   flip, so the evidence reports the candidates and the model is told the
 *   reference is imprecise.
 * - A directory prefix disambiguates without guessing, because the memory itself
 *   supplied it.
 *
 * The extraction half is tested against the shapes that actually appear in the
 * live corpus (a bare name, a relative path, a `:line`, a `:range`, a URL that
 * must NOT be treated as a file).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildFileIndex,
  extractFileReferences,
  gatherEvidence,
  renderEvidence,
} from '../src/core/memory-evidence.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mc-evidence-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Create a file with `lines` numbered lines of content. */
function makeFile(relativePath: string, lines: number): void {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  const body = Array.from({ length: lines }, (_, i) => `line ${String(i + 1)} content`).join('\n')
  writeFileSync(absolute, body, 'utf8')
}

describe('extractFileReferences', () => {
  it('finds a bare filename', () => {
    const refs = extractFileReferences('the handler lives in director.py')
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ base: 'director.py', directory: '' })
    expect(refs[0]?.lineStart).toBeUndefined()
  })

  it('finds a relative path', () => {
    const refs = extractFileReferences('see lib/director_graph.py for the graph')
    expect(refs[0]).toMatchObject({ base: 'director_graph.py', directory: 'lib' })
  })

  it('reads a line citation', () => {
    const refs = extractFileReferences('director.py:707 gates the aspect ratio')
    expect(refs[0]?.lineStart).toBe(707)
    expect(refs[0]?.lineEnd).toBe(707)
  })

  it('reads a line range', () => {
    const refs = extractFileReferences('director.py:637-639')
    expect(refs[0]?.lineStart).toBe(637)
    expect(refs[0]?.lineEnd).toBe(639)
  })

  it('ignores extensions outside the indexed set', () => {
    expect(extractFileReferences('see preview.png and model.safetensors')).toEqual([])
  })

  it('ignores URLs', () => {
    expect(extractFileReferences('https://example.com/app.ts is the source')).toEqual([])
  })

  it('deduplicates repeats of the same token', () => {
    const refs = extractFileReferences('director.py then director.py again')
    expect(refs).toHaveLength(1)
  })

  it('handles several distinct references', () => {
    const refs = extractFileReferences('director.py:707, shots.js and lib/h3_sizes.py:12')
    expect(refs.map(r => r.base)).toEqual(['director.py', 'shots.js', 'h3_sizes.py'])
  })
})

describe('buildFileIndex', () => {
  it('keys by filename', () => {
    makeFile('a/director.py', 3)
    makeFile('b/other.js', 2)
    const { index } = buildFileIndex(root)
    expect([...index.keys()].sort()).toEqual(['director.py', 'other.js'])
  })

  it('collects every path for a duplicated name', () => {
    makeFile('x/director.py', 3)
    makeFile('y/director.py', 3)
    const { index } = buildFileIndex(root)
    expect(index.get('director.py')?.sort()).toEqual(['x/director.py', 'y/director.py'])
  })

  it('skips vendored and build directories', () => {
    makeFile('node_modules/pkg/index.js', 2)
    makeFile('.git/hooks/pre-commit.sh', 2)
    makeFile('src/real.ts', 2)
    const { index } = buildFileIndex(root)
    expect([...index.keys()]).toEqual(['real.ts'])
  })

  it('stops at the depth limit', () => {
    makeFile('a/b/c/d/deep.ts', 2)
    const { index } = buildFileIndex(root, { maxDepth: 2 })
    expect(index.has('deep.ts')).toBe(false)
  })

  it('reports truncation rather than walking forever', () => {
    for (let i = 0; i < 12; i += 1) makeFile(`f${String(i)}.ts`, 1)
    const result = buildFileIndex(root, { maxFiles: 5 })
    expect(result.truncated).toBe(true)
    expect(result.scanned).toBeGreaterThan(5)
  })

  it('does not spend the file budget on files it will not index', () => {
    // 50 images and 6 sources: a budget of 10 must be enough for all 6 sources.
    // Counting the images first is how a media-heavy tree ends up with real
    // source files silently absent (measured: C:/data/code truncated at 20,001
    // scanned with only 5,147 indexed before this was fixed).
    for (let i = 0; i < 50; i += 1) makeFile(`img${String(i)}.png`, 1)
    for (let i = 0; i < 6; i += 1) makeFile(`src${String(i)}.ts`, 1)
    const result = buildFileIndex(root, { maxFiles: 10 })
    expect(result.truncated).toBe(false)
    expect(result.index.size).toBe(6)
    // And the counter reports indexable files, not everything walked.
    expect(result.scanned).toBe(6)
  })
})

describe('gatherEvidence', () => {
  it('resolves a unique filename and reports its size', () => {
    makeFile('nodes/director.py', 20)
    const { index } = buildFileIndex(root)
    const refs = extractFileReferences('director.py')
    const evidence = gatherEvidence(refs, index, { root })
    expect(evidence[0]).toMatchObject({ status: 'found', path: 'nodes/director.py' })
    expect(evidence[0]?.bytes).toBeGreaterThan(0)
  })

  it('pulls the cited lines with their numbers', () => {
    makeFile('director.py', 20)
    const { index } = buildFileIndex(root)
    const evidence = gatherEvidence(extractFileReferences('director.py:5'), index, { root })
    expect(evidence[0]?.status).toBe('found')
    expect(evidence[0]?.citedLines).toEqual(['5: line 5 content'])
  })

  it('clamps a huge cited range', () => {
    makeFile('big.py', 500)
    const { index } = buildFileIndex(root)
    const evidence = gatherEvidence(extractFileReferences('big.py:10-499'), index, { root })
    // Six lines max, regardless of what the memory claimed.
    expect(evidence[0]?.citedLines).toHaveLength(6)
    expect(evidence[0]?.citedLines?.[0]).toBe('10: line 10 content')
  })

  it('reports a line past the end as unreadable, not as found', () => {
    makeFile('short.py', 3)
    const { index } = buildFileIndex(root)
    const evidence = gatherEvidence(extractFileReferences('short.py:900'), index, { root })
    expect(evidence[0]?.status).toBe('unreadable')
    expect(evidence[0]?.detail).toContain('past the end')
  })

  it('reports a missing file as missing', () => {
    makeFile('present.py', 3)
    const { index } = buildFileIndex(root)
    const evidence = gatherEvidence(extractFileReferences('gone.py'), index, { root })
    expect(evidence[0]?.status).toBe('missing')
  })

  it('refuses to pick between duplicates without a prefix', () => {
    makeFile('x/director.py', 3)
    makeFile('y/director.py', 3)
    const { index } = buildFileIndex(root)
    const evidence = gatherEvidence(extractFileReferences('director.py'), index, { root })
    expect(evidence[0]?.status).toBe('ambiguous')
    expect(evidence[0]?.candidates).toHaveLength(2)
  })

  it('disambiguates with the directory the memory supplied', () => {
    makeFile('x/lib/director_graph.py', 3)
    makeFile('other/nodes/director_graph.py', 3)
    const { index } = buildFileIndex(root)
    const evidence = gatherEvidence(extractFileReferences('lib/director_graph.py'), index, { root })
    expect(evidence[0]?.status).toBe('found')
    expect(evidence[0]?.path).toBe('x/lib/director_graph.py')
  })

  it('stays ambiguous when two paths share the cited directory suffix', () => {
    // `x/lib/...` and `other/lib/...` both end with `lib/director_graph.py`, so
    // the prefix did NOT disambiguate. Picking either would be a coin flip
    // dressed as evidence.
    makeFile('x/lib/director_graph.py', 3)
    makeFile('other/lib/director_graph.py', 3)
    const { index } = buildFileIndex(root)
    const evidence = gatherEvidence(extractFileReferences('lib/director_graph.py'), index, { root })
    expect(evidence[0]?.status).toBe('ambiguous')
  })

  it('bounds the references per memory', () => {
    makeFile('a.py', 2)
    makeFile('b.py', 2)
    makeFile('c.py', 2)
    const { index } = buildFileIndex(root)
    const refs = extractFileReferences('a.py b.py c.py')
    const evidence = gatherEvidence(refs, index, { root, maxReferences: 2 })
    expect(evidence).toHaveLength(2)
  })
})

describe('renderEvidence', () => {
  it('states facts without prescribing a verdict', () => {
    makeFile('director.py', 10)
    const { index } = buildFileIndex(root)
    const block = renderEvidence(gatherEvidence(extractFileReferences('director.py:7'), index, { root }))
    expect(block).toContain('FOUND at director.py')
    expect(block).toContain('7: line 7 content')
  })

  it('names ambiguity and lists the candidates', () => {
    makeFile('x/a.py', 2)
    makeFile('y/a.py', 2)
    const { index } = buildFileIndex(root)
    const block = renderEvidence(gatherEvidence(extractFileReferences('a.py'), index, { root }))
    expect(block).toContain('AMBIGUOUS')
    expect(block).toContain('x/a.py')
    expect(block).toContain('y/a.py')
  })

  it('says NOT FOUND plainly', () => {
    const { index } = buildFileIndex(root)
    const block = renderEvidence(gatherEvidence(extractFileReferences('ghost.py'), index, { root }))
    expect(block).toContain('NOT FOUND')
  })

  it('renders nothing when there is no evidence', () => {
    expect(renderEvidence([])).toBe('')
  })
})
