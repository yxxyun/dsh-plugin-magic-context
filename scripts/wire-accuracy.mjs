#!/usr/bin/env node
/**
 * Wire-estimate accuracy report.
 *
 * Pairs each pass's local token estimate (`journal.pass.data.estSurfaceTokens`)
 * with what the provider actually billed for the same session around the same
 * moment (`usage_records.input_tokens`), and prints the ratio distribution.
 *
 * Why this exists: the emergency fail-closed gate may only disarm on a
 * trustworthy measurement, and this adapter's estimate is chars/4 — a guess that
 * ignores tool definitions and the provider's tokenizer. Rather than asserting
 * the guess is good enough, this measures it. Run it until `trusted` is true,
 * then the gate's disarm branch can be enabled with evidence behind it.
 *
 * Usage: node scripts/wire-accuracy.mjs [--db <path>] [--hours <n>]
 */
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_DB = join(
  homedir(),
  '.local',
  'share',
  'cortexkit',
  'magic-context-dsh-poc',
  'dsh-magic-context.db',
)

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const dbPath = arg('db', DEFAULT_DB)
const hours = Number(arg('hours', '24'))

const db = new DatabaseSync(dbPath, { readOnly: true })
try {
  const since = Date.now() - hours * 3_600_000
  // One row per (session, moment): the pass's estimate and the usage reading
  // recorded closest to it. A pass and the request it sized are seconds apart.
  const rows = db.prepare(`
    SELECT p.session_id,
           p.at            AS pass_at,
           json_extract(p.data, '$.estSurfaceTokens') AS estimated,
           (SELECT u.input_tokens + COALESCE(u.cache_read_tokens, 0) + COALESCE(u.cache_write_tokens, 0)
              FROM usage_records u
             WHERE u.session_id = p.session_id
               AND u.recorded_at <= p.at
             ORDER BY u.recorded_at DESC
             LIMIT 1) AS actual
      FROM journal p
     WHERE p.kind = 'pass'
       AND p.at > ?
       AND json_extract(p.data, '$.estSurfaceTokens') IS NOT NULL
     ORDER BY p.at DESC
  `).all(since)

  const pairs = rows
    .filter(row => Number(row.estimated) > 0 && Number(row.actual) > 0)
    .map(row => ({ estimated: Number(row.estimated), actual: Number(row.actual) }))

  if (pairs.length === 0) {
    console.log(`no usable pairs in the last ${hours}h (${rows.length} pass rows with an estimate)`)
    console.log('the estimate is recorded from the pass that ran after this build — give it a while')
    process.exit(0)
  }

  const ratios = pairs.map(pair => pair.actual / pair.estimated).sort((a, b) => a - b)
  const at = fraction => ratios[Math.min(ratios.length - 1, Math.max(0, Math.round((ratios.length - 1) * fraction)))]
  const factor = at(0.5)
  const p10 = at(0.1)
  const p90 = at(0.9)

  console.log(`pairs:  ${pairs.length}`)
  console.log(`factor: ${factor.toFixed(3)}  (actual / estimated, median)`)
  console.log(`band:   p10 ${p10.toFixed(3)} .. p90 ${p90.toFixed(3)}  (spread ${(p90 / p10).toFixed(3)})`)
  console.log(`mean estimate ${Math.round(pairs.reduce((t, p) => t + p.estimated, 0) / pairs.length)} tok, `
    + `mean actual ${Math.round(pairs.reduce((t, p) => t + p.actual, 0) / pairs.length)} tok`)
  const trusted = pairs.length >= 30 && p90 / p10 <= 1.35
  console.log(trusted
    ? 'trusted: YES — a calibrated measurement may disarm the emergency gate'
    : `trusted: NO — needs >=30 pairs and a spread <= 1.35 (have ${pairs.length}, ${(p90 / p10).toFixed(2)})`)
} finally {
  db.close()
}
