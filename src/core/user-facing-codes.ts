/**
 * User-facing failure codes — ported from upstream
 * `shared/user-facing-codes.ts` + `compartment-runner-validation.ts`
 * (mc-upstream a1ca346), restricted to the historian paths this adapter has.
 *
 * Why this exists: the RCC session failed history compression 21 times over six
 * hours and the conversation never said so. Every failure landed in the journal,
 * where only a human grepping the database would find it. Upstream talks to the
 * person instead, and it distinguishes two registers on purpose:
 *
 *   - a transient blip below the threshold stays quiet, because a retry fixes it
 *     and alarming the user every time trains them to ignore the notice;
 *   - at/above the threshold the notice escalates: the failures are persistent,
 *     which means the setting is wrong, not that luck was bad.
 *
 * Each entry carries a stable code so a user can search for it and a concrete
 * action so the notice is not just a diagnosis.
 */

export const HISTORIAN_PERSISTENT_FAILURE_THRESHOLD = 3

export interface UserFacingFailure {
  readonly code: string
  readonly sentence: string
  readonly action: string
}

export const USER_FACING_FAILURES = {
  historian_unavailable: {
    code: 'MC-H01',
    sentence: 'History compression could not finish this turn.',
    action: 'It will retry automatically.',
  },
  historian_saved_history_misaligned: {
    code: 'MC-H03',
    sentence:
      "History compression is paused because this session's saved summaries no longer line up with its messages.",
    action: 'Run the recompaction command to rebuild them.',
  },
  historian_window_too_small: {
    code: 'MC-H05',
    sentence:
      "History compression is paused because the history model's context window is too small for its instructions.",
    action: "Set the historian model to one with a larger context window.",
  },
} as const satisfies Record<string, UserFacingFailure>

export type UserFacingFailureKey = keyof typeof USER_FACING_FAILURES

/** One notice, in the two registers upstream distinguishes. */
export function renderUserFacingFailure(
  key: UserFacingFailureKey,
  failureCount = 0,
): string {
  const failure = USER_FACING_FAILURES[key]
  const persistent = failureCount >= HISTORIAN_PERSISTENT_FAILURE_THRESHOLD
  const lines = [
    `**${failure.code}** — ${failure.sentence}`,
    '',
  ]
  if (persistent && failureCount > 0) {
    lines.push(
      `This has failed ${String(failureCount)} times in a row, so the configured history model is likely misconfigured or unreachable.`,
    )
  }
  lines.push(`_${failure.action}_`)
  return lines.join('\n')
}

/**
 * The notice text for a historian failure. Upstream switches the heading at the
 * threshold; the body always names the code and the action.
 */
export function buildHistorianFailureNotice(failureCount: number): string {
  const heading = failureCount >= HISTORIAN_PERSISTENT_FAILURE_THRESHOLD
    ? '## Magic Context — History compression'
    : '## Magic Context'
  return [heading, '', renderUserFacingFailure('historian_unavailable', failureCount)].join('\n')
}
