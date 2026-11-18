#!/usr/bin/env node
/**
 * Report modules no other file imports.
 *
 * The question this answers: "is this file actually wired, or does it only exist?"
 * A module reached only by its own test is not wired — that is exactly how
 * `wire-accuracy.ts` sat unused for a round while passing 11 tests, and how the
 * `memory_chunks` chain ended up complete but never read — that one was found
 * this way and deleted (see ALIGNMENT.md).
 *
 * Usage: node scripts/unwired-modules.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

const files = walk(SRC)
const texts = new Map(files.map(file => [file, readFileSync(file, 'utf8')]))

// Every import specifier in the tree, resolved to an absolute path.
const imported = new Set()
for (const [file, text] of texts) {
  for (const match of text.matchAll(/from\s+'([^']+)'/g)) {
    const spec = match[1]
    if (!spec.startsWith('.')) continue
    const base = join(file, '..', spec.replace(/\.ts$/, ''))
    imported.add(`${base}.ts`)
    imported.add(base)
  }
}

// A module imported only by tests or only by scripts under scripts/ is reported
// separately: it exists, runs somewhere, but is not part of the runtime graph.
const scriptsText = readdirSync(join(ROOT, 'scripts'))
  .filter(name => name.endsWith('.mjs') || name.endsWith('.js'))
  .map(name => readFileSync(join(ROOT, 'scripts', name), 'utf8'))
  .join('\n')

const rows = []
for (const file of files) {
  if (file.endsWith('.d.ts')) continue
  const base = file.replace(/\.ts$/, '')
  const runtime = files.filter(other => other !== file && imported.has(file)
    && texts.get(other)?.includes(relative(join(other, '..'), base).replace(/\.ts$/, '')))
  const viaTest = imported.has(file)
  const viaScript = scriptsText.includes(base.split(/[\\/]/).pop())
  if (!viaTest && !viaScript) rows.push({ file, kind: 'nothing' })
  else if (!viaTest) rows.push({ file, kind: 'script-only' })
}

if (rows.length === 0) {
  console.log('every module is imported by at least one other file')
} else {
  for (const row of rows.sort((left, right) => left.file.localeCompare(right.file))) {
    console.log(`${row.kind.padEnd(12)} ${relative(ROOT, row.file)}`)
  }
}
