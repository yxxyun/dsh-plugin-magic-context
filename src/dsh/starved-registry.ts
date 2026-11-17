/**
 * Starvation registry — one bit per session, in memory.
 *
 * The drain budget exists to stop a pass that cannot make progress from running
 * again, but the budget is charged by what a pass RECLAIMED. An empty pass
 * reclaims nothing, so it is charged nothing, so the budget never fills and
 * never holds. Measured on the replay of 48 real execute passes from the RCC ORC
 * session (2026-11-17): the admission check held 0 of 48, because every pass in
 * the starvation stretch reported `reclaimed = 0`.
 *
 * The missing input is "did the previous pass actually do anything". That is
 * what this registry carries: the management pass reports whether its drops came
 * up empty, and the NEXT pass consults it before spending a round on the same
 * surface. Combined with the budget — which now measures the historian it
 * admits rather than the drops it does not — a starved session is held once its
 * summarisation allowance for the window is gone.
 *
 * Deliberately in-memory: the bit describes "the surface right now", and a
 * process restart rebuilds the surface anyway. The durable half of the state
 * (window tokens, latch, failure backoff) lives in the `drain_state` table.
 */

const starved = new Map<string, boolean>()

/** Record whether the pass that just ran reclaimed nothing worth counting. */
export function notePassStarved(sessionId: string, value: boolean): void {
  if (value) starved.set(sessionId, true)
  else starved.delete(sessionId)
}

/** Did the previous pass on this session come up empty? */
export function lastPassStarved(sessionId: string): boolean {
  return starved.get(sessionId) === true
}

/** Test seam: drop every recorded bit. */
export function resetStarvedRegistry(): void {
  starved.clear()
}
