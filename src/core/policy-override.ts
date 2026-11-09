/**
 * Operator overrides for the two pressure thresholds, edited from the dashboard.
 *
 * Why a plugin-owned file instead of the profile config:
 *
 *  - The desktop profile is Electron-exclusive (`--dump-config` refuses it), its
 *    `cordis.patch.yml` carries hand-written comments and `!<tag:yaml.org,2002:js>`
 *    nodes, and a programmatic rewrite there is a whole-file round-trip that can
 *    drop both. A two-number preference has no business risking that.
 *  - The config values are schemastery *volatile* references: the host's settings
 *    form can write them, but a plugin cannot commit into them from inside. An
 *    overlay file is the one channel this plugin owns end to end.
 *
 * Why it is hot: `index.ts` resolves the policy through `activePolicy()`, which
 * re-reads on every decision point, so the next management pass sees a change
 * without a remount. This module only has to make the read cheap and safe.
 *
 * The file is small and read once per pass; an mtime check keeps it from becoming
 * a per-decision syscall.
 */
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import type { PressurePolicy } from './policy.ts'

/** The only two fields an operator may tune from the dashboard. */
export interface ThresholdOverride {
  readonly executeThreshold?: number
  readonly forceThreshold?: number
}

export const OVERRIDE_FILENAME = 'policy-override.json'

/** Percent bounds. 0 would compress on every turn; 100 would never fire. */
const MIN_PERCENT = 1
const MAX_PERCENT = 100

function isPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_PERCENT && value <= MAX_PERCENT
}

/**
 * Validate an untrusted override payload.
 *
 * Returns a discriminated result rather than throwing: the dashboard has to turn
 * a rejection into a 400 with a reason, and "which field was wrong" is the part
 * an operator actually needs.
 */
export function parseOverride(raw: unknown): { ok: true; value: ThresholdOverride } | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'expected a JSON object' }
  }
  const input = raw as Record<string, unknown>
  const out: { executeThreshold?: number; forceThreshold?: number } = {}
  for (const key of ['executeThreshold', 'forceThreshold'] as const) {
    const value = input[key]
    if (value === undefined || value === null) continue
    // Accept "30" as well: an <input> hands back a string unless coerced.
    const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
    if (!isPercent(numeric)) {
      return { ok: false, error: `${key} must be a number between ${String(MIN_PERCENT)} and ${String(MAX_PERCENT)}` }
    }
    out[key] = numeric
  }
  if (out.executeThreshold === undefined && out.forceThreshold === undefined) {
    return { ok: false, error: 'no threshold given' }
  }
  // The force band is the emergency lane; it must not open before the ordinary
  // one, or the pass would escalate on the first eligible reading.
  if (out.executeThreshold !== undefined && out.forceThreshold !== undefined
    && out.forceThreshold < out.executeThreshold) {
    return { ok: false, error: 'forceThreshold must be >= executeThreshold' }
  }
  return { ok: true, value: out }
}

/**
 * Read the override file, tolerating every kind of damage.
 *
 * A corrupt or half-written file must degrade to "no override" — the shipped
 * defaults keep compressing, which is far better than a plugin that refuses to
 * boot because a preference file has a stray byte.
 */
export function readOverride(path: string): ThresholdOverride | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = parseOverride(JSON.parse(text) as unknown)
    return parsed.ok ? parsed.value : undefined
  } catch {
    return undefined
  }
}

/**
 * Write the override atomically (temp + rename).
 *
 * An operator clicking save while a pass is reading must never let the pass see a
 * truncated file: rename is atomic on the same volume, so readers see either the
 * old file or the new one.
 */
export function writeOverride(path: string, value: ThresholdOverride): void {
  const payload = JSON.stringify({ ...value, updatedAt: new Date().toISOString() }, null, 2)
  const temporary = `${path}.tmp`
  writeFileSync(temporary, payload, 'utf8')
  renameSync(temporary, path)
}

/** Remove the override so the configured/default values apply again. */
export function clearOverride(path: string): boolean {
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Cached reader keyed by mtime.
 *
 * `activePolicy()` runs at every decision point; statting a small file is cheap
 * but not free, and the value can only change when the file does. A missing file
 * is cached too (mtime 0), so the common "no override" case costs one stat.
 */
export function createOverrideReader(path: string): () => ThresholdOverride | undefined {
  let cachedMtime = -1
  let cached: ThresholdOverride | undefined
  return () => {
    let mtime: number
    try {
      mtime = statSync(path).mtimeMs
    } catch {
      // No file: cache the absence so repeated reads stay one failing stat.
      if (cachedMtime !== 0) {
        cachedMtime = 0
        cached = undefined
      }
      return cached
    }
    if (mtime !== cachedMtime) {
      cachedMtime = mtime
      cached = readOverride(path)
    }
    return cached
  }
}

/**
 * Apply an override over a resolved policy.
 *
 * Only the two threshold fields are ever taken from the file, even if it holds
 * more — the dashboard edits exactly these, and a stray field must not silently
 * retune the historian.
 */
export function applyOverride(policy: PressurePolicy, override: ThresholdOverride | undefined): PressurePolicy {
  if (override === undefined) return policy
  const executeThreshold = override.executeThreshold ?? policy.executeThreshold
  const forceThreshold = override.forceThreshold ?? policy.forceThreshold
  if (executeThreshold === policy.executeThreshold && forceThreshold === policy.forceThreshold) return policy
  return { ...policy, executeThreshold, forceThreshold }
}
