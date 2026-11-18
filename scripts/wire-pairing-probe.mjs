#!/usr/bin/env node
/**
 * Compare the pass timeline with the usage timeline for one session.
 *
 * The accuracy report pairs each pass's estimate with the first usage row at or
 * after it. If that pairing is wrong — because a session records several usage
 * rows per request, or because a pass and its request interleave differently than
 * assumed — then every ratio it prints measures the wrong thing.
 *
 * Usage: node scripts/wire-pairing-probe.mjs [--db <path>] [--session <id>]
 */
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_DB = join(
  homedir(), '.local', 'share', 'cortexkit', 'magic-context-dsh-poc', 'dsh-magic-context.db',
)

const argv = process.argv
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}

const db = new DatabaseSync(arg('db', DEFAULT_DB), { readOnly: true })
const stamp = ms => new Date(ms + 8 * 3_600_000).toISOString().slice(11, 19)

try {
  const session = arg('session', undefined)
  const sessionId = session ?? db.prepare(
    "SELECT session_id FROM journal WHERE kind = 'pass' ORDER BY id DESC LIMIT 1",
  ).get()?.session_id
  if (sessionId === undefined) {
    console.log('no pass rows at all')
    process.exit(0)
  }
  console.log(`session ${sessionId}`)

  const passes = db.prepare(`
    SELECT at, json_extract(data, '$.estSurfaceTokens') AS est,
           json_extract(data, '$.estSystemPromptTokens') AS sys,
           json_extract(data, '$.decision') AS decision,
           json_extract(data, '$.pressure') AS pressure
      FROM journal
     WHERE kind = 'pass' AND session_id = ?
     ORDER BY at DESC LIMIT 12
  `).all(sessionId)

  const usage = db.prepare(`
    SELECT recorded_at, turn, step, input_tokens, cache_read_tokens, cache_write_tokens
      FROM usage_records WHERE session_id = ?
     ORDER BY recorded_at DESC LIMIT 12
  `).all(sessionId)

  const merged = [
    ...passes.map(row => ({ at: row.at, kind: 'pass', row })),
    ...usage.map(row => ({ at: row.recorded_at, kind: 'usage', row })),
  ].sort((left, right) => left.at - right.at)

  console.log('\n  time      kind   detail')
  for (const entry of merged) {
    if (entry.kind === 'pass') {
      const { est, sys, decision, pressure } = entry.row
      console.log(`  ${stamp(entry.at)}  pass   ${String(decision).padEnd(8)} `
        + `p=${pressure === null ? '?' : Number(pressure).toFixed(1)}% est=${est ?? '-'} sys=${sys ?? '-'}`)
    } else {
      const { turn, step, input_tokens: input, cache_read_tokens: cr, cache_write_tokens: cw } = entry.row
      const total = (input ?? 0) + (cr ?? 0) + (cw ?? 0)
      console.log(`  ${stamp(entry.at)}  usage  t${turn ?? '?'}s${step ?? '?'} `
        + `in=${input ?? '-'} cr=${cr ?? '-'} cw=${cw ?? '-'}  total=${total}`)
    }
  }

  // How many usage rows share a turn/step? Several per request would mean the
  // first-at-or-after rule picks an arbitrary one.
  const grouped = db.prepare(`
    SELECT turn, step, COUNT(*) AS n FROM usage_records WHERE session_id = ?
     GROUP BY turn, step HAVING n > 1 ORDER BY n DESC LIMIT 5
  `).all(sessionId)
  console.log(grouped.length === 0
    ? '\nusage rows per (turn, step): exactly one'
    : `\nusage rows per (turn, step) > 1: ${JSON.stringify(grouped)}`)
} finally {
  db.close()
}
