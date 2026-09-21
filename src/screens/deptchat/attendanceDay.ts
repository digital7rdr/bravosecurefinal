/**
 * Attendance verification helpers (founder, 2026-09-05) — pure, so the node
 * `booking` Jest project can pin them without mounting a screen.
 *
 *  - `dayWindow` turns the dashboard's date preset into the [from, to) ISO
 *    window the Present / Late / Absent tiles were computed over, so tapping a
 *    tile lists EXACTLY the people the number counted (local midnight, like the
 *    dashboard's own `fromFor`).
 *  - `placeLabel` is the one rule for "where": the reverse-geocoded name when
 *    the server has one, else the shift's site label, else the coordinates —
 *    never a code, never blank.
 *  - `statusBucket` maps a tile to the server status it filters on.
 */
import type {ShiftSessionDto} from '@services/api';

export type DayPresetKey = 'all' | 'today' | '7d' | '30d';

export function dayWindow(key: DayPresetKey, now: Date = new Date()): {from?: string; to?: string} {
  const days = key === 'today' ? 1 : key === '7d' ? 7 : key === '30d' ? 30 : null;
  if (!days) {return {};}
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 1);
  return {from: start.toISOString(), to: end.toISOString()};
}

export function placeLabel(
  s: Pick<ShiftSessionDto, 'clock_in_place' | 'site_label' | 'clock_in_lat' | 'clock_in_lng'>,
  which: 'in' | 'out' = 'in',
  out?: Pick<ShiftSessionDto, 'clock_out_place' | 'clock_out_lat' | 'clock_out_lng'>,
): string {
  const place = (which === 'in' ? s.clock_in_place : out?.clock_out_place)?.trim();
  if (place) {return place;}
  const lat = which === 'in' ? s.clock_in_lat : out?.clock_out_lat;
  const lng = which === 'in' ? s.clock_in_lng : out?.clock_out_lng;
  if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)) {
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }
  const site = s.site_label?.trim();
  if (site) {return site;}
  return 'Location not recorded';
}

export function hasFix(s: Pick<ShiftSessionDto, 'clock_in_lat' | 'clock_in_lng'>): boolean {
  return typeof s.clock_in_lat === 'number' && typeof s.clock_in_lng === 'number'
    && Number.isFinite(s.clock_in_lat) && Number.isFinite(s.clock_in_lng)
    && !(s.clock_in_lat === 0 && s.clock_in_lng === 0);
}

/** The server status a dashboard tile filters on. */
export function statusBucket(tile: 'present' | 'late' | 'absent'): string {
  return tile;
}

/** "08:40 · 12 min late" style secondary line for a row. */
export function lateBy(s: Pick<ShiftSessionDto, 'clock_in_at' | 'shift_start_at' | 'attendance_status'>): number | null {
  if (s.attendance_status !== 'late' || !s.shift_start_at) {return null;}
  const a = new Date(s.clock_in_at).getTime(), b = new Date(s.shift_start_at).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= b) {return null;}
  return Math.round((a - b) / 60_000);
}
