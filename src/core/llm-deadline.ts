/**
 * Wall-clock budgets for one auxiliary LLM round trip.
 *
 * The historian has carried this guard since it was wired (see
 * `src/dsh/historian.ts` `collectAttempt`): its policy note spells the rule out —
 * "a provider that never settles must not leave the run unaccounted". The
 * maintenance lane (verify + profile review) never got one, and there the
 * consequence is worse than a lost row: the ticker's schedule is installed by
 * its own timer today, but the tick itself is a single-flight slot — one
 * never-settling stream would hold that slot forever and stop TTL expiry,
 * verification, profile review and vector backfill for the whole life of the
 * process, silently, because the lane simply never reports again.
 *
 * The budget is enforced twice on purpose, exactly like the historian's:
 *
 * - the abort signal tells a compliant provider stream to stop, so the socket is
 *   released instead of lingering until the host's own transport timeout;
 * - `Promise.race` rejects even when the seam ignores the signal entirely, which
 *   is the case this module exists for (a stream that yields nothing forever
 *   never observes an abort).
 */
export class LlmDeadlineError extends Error {
  readonly budgetMs: number
  constructor(budgetMs: number) {
    super(`no terminal event within ${String(budgetMs)}ms`)
    this.name = 'LlmDeadlineError'
    this.budgetMs = budgetMs
  }
}

/**
 * Run `work` against a fresh abort signal, rejecting with {@link LlmDeadlineError}
 * once `budgetMs` elapses. The timer is `unref`ed so a pending budget never holds
 * the host process open by itself.
 */
export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  budgetMs: number,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Abort first: a stream that *would* have stopped on a signal gets the
      // chance to release its socket before the rejection unwinds.
      controller.abort(new LlmDeadlineError(budgetMs))
      reject(new LlmDeadlineError(budgetMs))
    }, budgetMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
  try {
    return await Promise.race([work(controller.signal), expiry])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
