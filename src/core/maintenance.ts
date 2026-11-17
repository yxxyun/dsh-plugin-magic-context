/**
 * The live-memory sentinel.
 *
 * This file used to hold the whole maintenance sweep: TTL expiry, verification,
 * and the budget/parse machinery around them. Every one of those steps is now a
 * dream task, where upstream keeps them:
 *
 *   TTL expiry        → `curate`            (core/expire-memories.ts)
 *   verification      → `verify`            (core/verify-memories.ts)
 *   profile review    → `review-user-memories`
 *   smart notes       → `evaluate-smart-notes`
 *   auto-staging      → `auto-stage-global`
 *   vector backfill   → `backfill-vectors`  (dsh/dream-handlers.ts)
 *   commit index      → `index-commits`
 *
 * Two schedulers on one store was the defect that forced the move: a
 * fixed-interval sweep always beat the daily tasks to the same unverified pool,
 * so the evidence-backed lane reported `pool 0` however it was scheduled.
 *
 * What is left is `memorySample`, which belongs to no task in particular — it is
 * a pure conversion the lanes call to write one RSS row per run. Kept here
 * rather than inlined because the rounding is worth pinning in a test.
 */

/**
 * Process memory in MB, rounded to one decimal.
 *
 * Exists as a series (one row per run) because upstream MC 0.49.1 (#681) leaked
 * in exactly this shape — each completed pass keeping the previous pass and its
 * message history — and a static audit of this adapter found no such retention.
 * The series is what would make a future regression visible across days, with no
 * profiler and no extra requests. Pure so the unit test can pin the rounding.
 */
export function memorySample(usage: {
  readonly rss: number
  readonly heapUsed: number
  readonly heapTotal: number
  readonly external: number
}): { rssMb: number; heapUsedMb: number; heapTotalMb: number; externalMb: number } {
  const mb = (bytes: number): number => Math.round((bytes / (1024 * 1024)) * 10) / 10
  return {
    rssMb: mb(usage.rss),
    heapUsedMb: mb(usage.heapUsed),
    heapTotalMb: mb(usage.heapTotal),
    externalMb: mb(usage.external),
  }
}
