/**
 * B-860 — a shift series you can take days OUT of.
 *
 * Founder, 2026-09-11: _"if I choose a sequence of 10 days for a shift for a
 * person I cannot exclude a day; it could be a holiday — we should have the
 * ability to exclude any date."_
 *
 * The editor could only repeat WEEKLY (`repeat_weeks` 2..12, materialised
 * server-side at `start + k × 7 days`) and had no exclusion concept at all. This
 * module is the pure half: generate the dates, apply the exclusions, and answer
 * the two questions worth warning about before Create.
 *
 * ── WHY EVERY DATE HERE IS A LOCAL `YYYY-MM-DD` ──────────────────────────────
 *
 * The weekly generator this replaces added `k × 7 × 86_400_000` MILLISECONDS to
 * an instant. Across a DST boundary that lands an hour early or late, so a
 * 06:00 shift becomes 05:00 or 07:00 for the back half of a series — and the
 * geofenced check-in window moves with it. `new Date(y, m - 1, d + k)` is a
 * LOCAL CALENDAR add: it normalises day/month/year overflow for us and keeps the
 * wall-clock time the manager typed. The dates then go through the editor's
 * existing `windowsForDates`, which is the same local-wall-clock path the roster
 * calendar already uses.
 */

export type RepeatKind = 'none' | 'daily' | 'weekly';

/** `CreateShiftDto.occurrences` is capped at 31 server-side. */
export const MAX_OCCURRENCES = 31;

/** Offered counts per mode. Daily is bounded by the DTO cap, weekly by its own. */
export const DAILY_COUNTS: readonly number[] = [3, 5, 7, 10, 14, 21, 31];
export const WEEKLY_COUNTS: readonly number[] = [2, 3, 4, 6, 8, 12];

/** Local calendar key — never `toISOString()`, which is UTC and shifts the day. */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * The dates of a series, INCLUDING the anchor day, in order.
 *
 * `count` is the number of occurrences, not the number of steps: daily × 3 from
 * Monday is Mon/Tue/Wed. `'none'` — or a count below 2 — is the anchor alone,
 * which the caller renders as the ordinary single-shift form.
 */
export function seriesDates(anchor: Date, kind: RepeatKind, count: number): string[] {
  if (kind === 'none') {return [localDateKey(anchor)];}
  const step = kind === 'weekly' ? 7 : 1;
  const n = Math.max(1, Math.min(Math.floor(count) || 1, MAX_OCCURRENCES));
  const y = anchor.getFullYear();
  const m = anchor.getMonth();
  const d = anchor.getDate();
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    // Local calendar add — DST-safe, and it rolls month/year ends for us.
    out.push(localDateKey(new Date(y, m, d + i * step)));
  }
  return out;
}

/** Generated minus excluded, order preserved. */
export function keptDates(all: readonly string[], excluded: ReadonlySet<string>): string[] {
  return all.filter(d => !excluded.has(d));
}

/**
 * Do any two of these windows overlap?
 *
 * The roster's `findConflicts` asks the same question at PUBLISH time, per
 * member, across the whole month — by which point the rows already exist. This
 * is the cheap same-request version so the manager is told BEFORE Create rather
 * than at publish. Touching edges (one window's end exactly at the next one's
 * start — a 24-hour daily series) are NOT an overlap.
 */
export function windowsOverlap(
  windows: ReadonlyArray<{start_at: string; end_at: string}>,
): boolean {
  const spans = windows
    .map(w => ({s: Date.parse(w.start_at), e: Date.parse(w.end_at)}))
    .filter(w => Number.isFinite(w.s) && Number.isFinite(w.e))
    .sort((a, b) => a.s - b.s);
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i].s < spans[i - 1].e) {return true;}
  }
  return false;
}

/**
 * Does the series cross a calendar month?
 *
 * Worth saying out loud because the monthly roster is planned a month at a time:
 * the tail of a 31-day series files into a month that may never have been
 * planned, where nothing conflict-checks it and nobody is looking for it.
 */
export function spansTwoMonths(dates: readonly string[]): boolean {
  const months = new Set(dates.map(d => d.slice(0, 7)));
  return months.size > 1;
}

/**
 * Q6 — apply the shared time window to each selected local date. An end at or
 * before the start rolls to the NEXT day (overnight shift), so a 22:00–06:00
 * window means what a manager means by it.
 *
 * Lives HERE, beside the generator, because it is the second half of the same
 * local-wall-clock rule the header states — and it is pure, so the DST cases
 * are pinned by execution rather than by mounting the editor.
 */
export const windowsForDates = (dates: readonly string[], start: Date, end: Date) =>
  dates.map(d => {
    const [y, m, dd] = d.split('-').map(Number);
    const st = new Date(y, m - 1, dd, start.getHours(), start.getMinutes(), 0, 0);
    let en = new Date(y, m - 1, dd, end.getHours(), end.getMinutes(), 0, 0);
    // A LOCAL CALENDAR add, never + 86_400_000 ms: across a DST boundary the
    // millisecond form lands an hour late (spring) or early (autumn), which
    // moves the end of the shift and the geofenced check-in window with it.
    if (en.getTime() <= st.getTime()) {
      en = new Date(y, m - 1, dd + 1, end.getHours(), end.getMinutes(), 0, 0);
    }
    return {start_at: st.toISOString(), end_at: en.toISOString()};
  });

/** The Create button's own rule, so the screen and its test cannot disagree. */
export function seriesBlocker(kept: readonly string[]): 'empty' | 'too_many' | null {
  if (kept.length === 0) {return 'empty';}
  if (kept.length > MAX_OCCURRENCES) {return 'too_many';}
  return null;
}
