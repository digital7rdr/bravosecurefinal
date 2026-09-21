/**
 * B-840 — the WHEN rule for the bookings queue.
 *
 * A cancel only flips `status`; the booking keeps its future `pickup_time`
 * (there is no `cancelled_at` column). The pre-2026-09-10 rule read the date
 * and nothing else, so a cancelled booking 96 days out sat in "Upcoming",
 * counted in the chip and badged "IN 96 DAYS" — in the queue an operator works
 * from. Status wins over the date now.
 *
 * Pure and dependency-free (`datetime` is the only import, itself pure) so the
 * node Jest project can execute it: `src/__tests__/bookingBuckets.test.ts`.
 */

import {utcDayDelta} from './datetime';

export type WhenBucket = 'today' | 'upcoming' | 'past' | 'cancelled';

/** The buckets the WHEN rail COUNTS. 'cancelled' is a verdict, not a bucket:
 *  its rail chip is the server-side status filter (complete across the whole
 *  set), so a client count over the loaded window would be a floor (B-842). */
export type CountedBucket = Exclude<WhenBucket, 'cancelled'>;

export type WhenCounts = Record<CountedBucket, number>;

export interface WhenBucketMeta {
  value: CountedBucket;
  label: string;
  /** The rail's dot, so the three read apart without their labels. */
  color: string;
}

/** Rail order. */
export const WHEN_BUCKETS: ReadonlyArray<WhenBucketMeta> = [
  {value: 'today', label: 'Today', color: 'var(--act)'},
  {value: 'upcoming', label: 'Upcoming', color: 'var(--info)'},
  {value: 'past', label: 'Past', color: 'var(--tx-3)'},
];

export function bucketOf(status: string, pickupIso: string, now: Date = new Date()): WhenBucket {
  if (status === 'CANCELLED') return 'cancelled';
  const delta = utcDayDelta(pickupIso, now);
  return delta === 0 ? 'today' : delta < 0 ? 'past' : 'upcoming';
}

export function bucketCounts(
  rows: ReadonlyArray<{status: string; pickup_time: string}>,
  now: Date = new Date(),
): WhenCounts {
  // Why: the seed is ANNOTATED, never `… as Record<CountedBucket, number>` — a
  // cast lets a missing key through as `undefined++`, i.e. NaN in the rail;
  // the annotation makes the same omission a compile error.
  const counts: WhenCounts = {today: 0, upcoming: 0, past: 0};
  for (const row of rows) {
    const bucket = bucketOf(row.status, row.pickup_time, now);
    if (bucket !== 'cancelled') counts[bucket] += 1;
  }
  return counts;
}
