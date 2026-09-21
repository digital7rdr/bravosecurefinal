/**
 * B-840 (founder, 2026-09-10, Lite Bookings screenshot) — booking 20A88787D8E6
 * was CANCELLED and still sat under WHEN = Upcoming, badged "IN 96 DAYS". The
 * old rule read the pickup date and nothing else; a cancel only flips `status`
 * (there is no `cancelled_at` column), so the row kept its future date and its
 * place in the queue an operator works from.
 *
 * The rule is pure, so it is EXECUTED here. The wiring in BookingsList.tsx is a
 * client component the node project cannot import, so it is SCANNED at the
 * decision site with comments stripped and on whole lines (these files are
 * CRLF; the reader normalises), each absence assertion paired with a
 * present-token self-check so a renamed symbol cannot pass it vacuously.
 */

import fs from 'fs';
import path from 'path';
import {WHEN_BUCKETS, bucketCounts, bucketOf} from '../lib/bookingBuckets';

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
/** Strip comments — prose naming a token must not satisfy a scan. */
const code = (rel: string) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const LIST = 'apps/ops-console/src/features/bookings/BookingsList.tsx';

const NOW = new Date('2026-09-10T12:00:00.000Z');

describe('B-840 — status wins over the date', () => {
  it('a CANCELLED booking is never upcoming, however far ahead its pickup is', () => {
    // The founder's row: 96 days out, cancelled.
    expect(bucketOf('CANCELLED', '2026-12-15T09:00:00.000Z', NOW)).toBe('cancelled');
  });

  it('a CANCELLED booking whose pickup is TODAY is still cancelled, not today', () => {
    expect(bucketOf('CANCELLED', '2026-09-10T23:30:00.000Z', NOW)).toBe('cancelled');
  });

  it('a CANCELLED booking in the past is cancelled, not past', () => {
    expect(bucketOf('CANCELLED', '2026-08-01T09:00:00.000Z', NOW)).toBe('cancelled');
  });

  it('every other status keeps the UTC day-delta rule', () => {
    expect(bucketOf('PENDING_OPS', '2026-12-15T09:00:00.000Z', NOW)).toBe('upcoming');
    expect(bucketOf('CONFIRMED', '2026-09-10T23:30:00.000Z', NOW)).toBe('today');
    expect(bucketOf('COMPLETED', '2026-08-01T09:00:00.000Z', NOW)).toBe('past');
    // Q1 — a completed job's pickup is in the past; it is not hidden.
    expect(bucketOf('COMPLETED', '2026-09-09T09:00:00.000Z', NOW)).toBe('past');
  });

  it('reads the clock it is GIVEN — a Date, not the wall clock', () => {
    const iso = '2026-09-10T23:00:00.000Z';
    expect(bucketOf('CONFIRMED', iso, new Date('2026-09-10T00:00:00.000Z'))).toBe('today');
    expect(bucketOf('CONFIRMED', iso, new Date('2026-09-11T00:00:00.000Z'))).toBe('past');
    expect(bucketOf('CONFIRMED', iso, new Date('2026-09-09T00:00:00.000Z'))).toBe('upcoming');
  });
});

describe('the WHEN rail vocabulary', () => {
  it('is the three TIME buckets, in rail order — "cancelled" is not one of them', () => {
    expect(WHEN_BUCKETS.map(b => b.value)).toEqual(['today', 'upcoming', 'past']);
    expect(WHEN_BUCKETS.map(b => b.label)).toEqual(['Today', 'Upcoming', 'Past']);
  });

  it('every bucket carries a dot colour, so the rail reads without the labels', () => {
    for (const b of WHEN_BUCKETS) expect(b.color).toMatch(/^var\(--[a-z0-9-]+\)$/);
  });
});

describe('bucketCounts', () => {
  const rows = [
    {status: 'CANCELLED', pickup_time: '2026-12-15T09:00:00.000Z'},
    {status: 'CANCELLED', pickup_time: '2026-09-10T09:00:00.000Z'},
    {status: 'PENDING_OPS', pickup_time: '2026-12-15T09:00:00.000Z'},
    {status: 'CONFIRMED', pickup_time: '2026-09-10T23:30:00.000Z'},
    {status: 'LIVE', pickup_time: '2026-09-10T01:00:00.000Z'},
    {status: 'COMPLETED', pickup_time: '2026-08-01T09:00:00.000Z'},
  ];

  it('counts the time buckets and leaves the cancelled rows out of all of them', () => {
    expect(bucketCounts(rows, NOW)).toEqual({today: 2, upcoming: 1, past: 1});
  });

  it('every WHEN_BUCKETS key is present and a real number — never NaN, never undefined', () => {
    // The predecessor seeded `{past, today, upcoming} as Record<…>`; a cast like
    // that turns a missing key into `undefined++` → NaN in the rail.
    const counts = bucketCounts(rows, NOW);
    for (const b of WHEN_BUCKETS) {
      expect(typeof counts[b.value]).toBe('number');
      expect(Number.isNaN(counts[b.value])).toBe(false);
    }
    expect(Object.keys(counts).sort()).toEqual(WHEN_BUCKETS.map(b => b.value).sort());
  });

  it('an empty set is all zeroes, not an empty object', () => {
    expect(bucketCounts([], NOW)).toEqual({today: 0, upcoming: 0, past: 0});
  });

  it('the totals never exceed the row count (a row lands in at most one bucket)', () => {
    const counts = bucketCounts(rows, NOW);
    const total = WHEN_BUCKETS.reduce((n, b) => n + counts[b.value], 0);
    expect(total).toBe(rows.length - 2);
  });
});

describe('B-840 wiring — BookingsList (source scan)', () => {
  const src = code(LIST);
  const lines = src.split('\n');

  it('scans a file that really holds the bucket wiring (self-check)', () => {
    expect(lines.length).toBeGreaterThan(200);
    expect(src).toContain('bucketOf(');
    expect(src).toContain('bucketCounts(');
    expect(src).toContain('WHEN_BUCKETS');
  });

  it('every bucket call is given the memo’s ONE clock', () => {
    // A second `new Date()` inside the row filter can disagree with the one the
    // counts used across a UTC midnight — "Today 3" over an empty table.
    const calls = [...src.matchAll(/\bbucket(?:Of|Counts)\(([^)]*)\)/g)].map(m => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter(args => !/\bnow\b/.test(args))).toEqual([]);
    expect(src.match(/new Date\(\)/g) ?? []).toHaveLength(1);
  });

  it('the WHEN rail’s Cancelled chip is the SERVER-side status filter, not a client bucket', () => {
    // A client-side count over the 50 loaded rows would be a floor (B-842) on
    // the very screen the founder complained about.
    const chip = lines.filter(l => l.includes("setStatus('CANCELLED')"));
    expect(chip).toHaveLength(1);
    expect(chip[0]).toContain('setBucket(undefined)');
    expect(src).toContain('var(--err)');
  });

  it('the STATUS chips clear the WHEN bucket, so the two rails cannot deadlock', () => {
    expect(src).toMatch(/onClick=\{\(\) => \{setStatus\(f\.value\); setBucket\(undefined\);\}\}/);
  });

  it('the old status-blind private rule is gone', () => {
    expect(src).not.toMatch(/^type TimeBucket/m);
    expect(src).not.toMatch(/^function bucketOf/m);
  });

  it('a cancelled row shows a muted date, not a countdown, and not a second CANCELLED', () => {
    expect(src).toMatch(/<RelChip iso=\{b\.pickup_time\} status=\{b\.status\} \/>/);
    // Anchored INSIDE the RelChip closure — a token elsewhere in the file (the
    // rail chip also tests for 'CANCELLED') would satisfy a whole-file scan.
    const start = src.indexOf('function RelChip');
    const end = src.indexOf('function relativeWhen');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const relChip = src.slice(start, end);
    expect(relChip).toContain("status === 'CANCELLED'");
    expect(relChip).toContain('formatDateUtc(iso)');
    // The StatusPill two columns left already says CANCELLED; twice is noise.
    expect(relChip).not.toContain("'CANCELLED'}");
    expect(relChip).not.toMatch(/label: 'CANCELLED'/);
    expect(relChip).not.toMatch(/>CANCELLED</);
  });
});
