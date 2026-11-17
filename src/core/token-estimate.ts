/**
 * Token estimation, and the fixed overhead no character count can see.
 *
 * ## Why `chars / 4` is wrong here, and by how much
 *
 * Measured on this install (7,354 step-pairs across every long session, comparing
 * the provider's own prompt-token growth against the material that actually
 * landed between two steps):
 *
 *     chars / 4                → 31% UNDER the provider's count
 *     composition-weighted     →  5% under
 *     fitted per-class weights → no better than the fixed constant
 *
 * The last line is the interesting one. Fitting ascii/cjk/other coefficients gave
 * coefficients that moved by an order of magnitude between sessions (cjk 0.31 to
 * 4.34 chars/token) and a negative "other" weight. A model whose coefficients are
 * unstable is a model describing the wrong thing: the token growth is not driven
 * by the text that landed, it is dominated by the FIXED part of every request.
 *
 * ## The fixed part, measured
 *
 * A session's first step carries the fixed overhead plus one user message, so
 * `firstPrompt − estimate(firstUserMessage)` isolates it. Grouped by route:
 *
 *     dsh-opencode-go/deepseek-v4.1-flash   median 42,956 tok
 *     workbuddy/deepseek-v4.1-flash         median 42,419 tok
 *
 * That is the system prompt plus the tool definitions plus the request envelope,
 * resent on every step and absent from every persisted document. Nothing derived
 * from text can see it. It is therefore modelled as its own term here rather than
 * folded into a ratio.
 *
 * ## What this module does
 *
 * - {@link estimateTokens} keeps a per-class estimate, calibrated so that the
 *   aggregate lands near the provider's count rather than 31% under it. It is
 *   used where only TEXT is available (compaction span sizing, per-node budgets).
 * - {@link FIXED_OVERHEAD_TOKENS} / {@link overheadFor} model the fixed term, so a
 *   caller asking "how full is the window" can include it.
 *
 * Deliberately NOT ported: upstream's per-model `systemRatio`/`toolsRatio`
 * calibration table (`tokenizer-calibration.ts`). Those ratios correct the drift of
 * a LOCAL tokenizer (ai-tokenizer's cl100k/o200k encodings). This adapter has no
 * tokenizer to correct, so importing the ratios would calibrate nothing — the
 * measurement above shows the error they address is not the error present here.
 */

/** Provider-reported median fixed overhead, measured on this install. */
export const FIXED_OVERHEAD_TOKENS = 42_000

/**
 * Lower bound for a route whose overhead was not measured: the smallest first-step
 * prompt observed. Under-estimating is the dangerous direction (it makes the
 * window look emptier than it is), so the floor is a real observation, not zero.
 */
export const FIXED_OVERHEAD_FLOOR_TOKENS = 18_000

/**
 * Characters per token by class, calibrated against this install's measurements.
 *
 * ASCII stays at 4: that is the classic English-prose ratio and the measured
 * aggregate is dominated by it. CJK is 1 token per character — for these models a
 * CJK codepoint is very close to one token, which is why the aggregate came out
 * 31% above `chars/4` when CJK was 12% of the material. "Other" (accents, symbols,
 * emoji) sits between the two.
 */
const CHARS_PER_TOKEN_ASCII = 4
const CHARS_PER_TOKEN_CJK = 1
const CHARS_PER_TOKEN_OTHER = 2

/** CJK ideographs, including the extension-A block and the compatibility forms. */
function isCjk(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0x3040 && cp <= 0x30ff)   // hiragana + katakana
    || (cp >= 0xac00 && cp <= 0xd7af)   // hangul syllables
  )
}

/**
 * Estimate tokens for a piece of text.
 *
 * Counts the three character classes in one pass and charges each its calibrated
 * rate. Minimum 1, so an empty-but-present node never costs zero: a node that
 * exists occupies a separator and a role tag in every provider's encoding, and
 * returning 0 lets a caller with a fixed budget loop forever.
 *
 * @param text - the text to estimate.
 * @returns estimated tokens, at least 1.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 1
  let ascii = 0
  let cjk = 0
  let other = 0
  for (let index = 0; index < text.length; index += 1) {
    const cp = text.codePointAt(index) as number
    if (cp < 0x80) ascii += 1
    else if (isCjk(cp)) cjk += 1
    else other += 1
    // A surrogate pair is one codepoint but two UTF-16 units; skip the low half.
    if (cp > 0xffff) index += 1
  }
  const tokens = ascii / CHARS_PER_TOKEN_ASCII + cjk / CHARS_PER_TOKEN_CJK + other / CHARS_PER_TOKEN_OTHER
  return Math.max(1, Math.ceil(tokens))
}

/** Per-class character counts, exposed for diagnostics and for tests. */
export interface TextProfile {
  readonly chars: number
  readonly ascii: number
  readonly cjk: number
  readonly other: number
  readonly estimatedTokens: number
  /** `chars / estimatedTokens`: what `chars/4` would have assumed. */
  readonly charsPerToken: number
}

/**
 * Profile a string the way {@link estimateTokens} does.
 *
 * Exists so `/ctx-status` and the measurement scripts can show WHY an estimate
 * came out where it did, instead of a single opaque number.
 *
 * @param text - the text to profile.
 */
export function profileText(text: string): TextProfile {
  let ascii = 0
  let cjk = 0
  let other = 0
  for (let index = 0; index < text.length; index += 1) {
    const cp = text.codePointAt(index) as number
    if (cp < 0x80) ascii += 1
    else if (isCjk(cp)) cjk += 1
    else other += 1
    if (cp > 0xffff) index += 1
  }
  const estimated = estimateTokens(text)
  return {
    chars: ascii + cjk + other,
    ascii,
    cjk,
    other,
    estimatedTokens: estimated,
    charsPerToken: estimated === 0 ? 0 : (ascii + cjk + other) / estimated,
  }
}

/**
 * Fixed overhead to add for a given route.
 *
 * Returns the measured median when the route has been measured, and the observed
 * floor otherwise. There is no "0" answer on purpose: every DSH request carries a
 * system prompt and a tool list, so a caller that assumes none is the bug this
 * function exists to prevent.
 *
 * @param routeKey - `provider/model`, or undefined when the route is unknown.
 * @param table - measured overheads by route; defaults to the built-in table.
 */
export function overheadFor(
  routeKey: string | undefined,
  table: Readonly<Record<string, number>> = MEASURED_OVERHEAD,
): number {
  if (routeKey !== undefined) {
    const exact = table[routeKey]
    if (typeof exact === 'number' && Number.isFinite(exact) && exact > 0) return exact
    // A route we have never seen still belongs to a provider family: fall back to
    // any measured route with the same provider prefix before dropping to the floor.
    const provider = routeKey.split('/')[0]
    if (provider !== undefined && provider.length > 0) {
      const sameProvider = Object.entries(table)
        .filter(([key]) => key.startsWith(`${provider}/`))
        .map(([, value]) => value)
      if (sameProvider.length > 0) {
        return Math.round(sameProvider.reduce((total, value) => total + value, 0) / sameProvider.length)
      }
    }
  }
  return FIXED_OVERHEAD_FLOOR_TOKENS
}

/**
 * Measured per-route fixed overhead (first-step prompt minus the first user
 * message, median across that route's sessions on this install).
 *
 * Numbers, not a formula: they were measured, and re-measuring is a script run
 * (`scripts/measure-overhead.mjs`), not a code change.
 */
export const MEASURED_OVERHEAD: Readonly<Record<string, number>> = {
  'dsh-opencode-go/deepseek-v4.1-flash': 42_956,
  'workbuddy/deepseek-v4.1-flash': 42_419,
}

/**
 * Tokens actually occupied, as the window sees them.
 *
 * The one place pressure maths should go through: text estimate plus the fixed
 * overhead. `providerTokens` wins when available because it is the truth — the
 * estimate is only for content that has not been sent yet.
 *
 * @param textTokens - estimate for the text under consideration.
 * @param routeKey - `provider/model` of the current route.
 * @param providerTokens - the provider's own count, when a request already ran.
 */
export function occupiedTokens(
  textTokens: number,
  routeKey: string | undefined,
  providerTokens?: number,
): number {
  if (providerTokens !== undefined && Number.isFinite(providerTokens) && providerTokens > 0) {
    return providerTokens
  }
  return Math.max(0, textTokens) + overheadFor(routeKey)
}
