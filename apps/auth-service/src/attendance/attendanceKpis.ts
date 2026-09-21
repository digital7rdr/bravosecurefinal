/**
 * Attendance KPIs for one member (founder, 2026-09-05: "click then that
 * person's full history will show with KPI type").
 *
 * Pure: the endpoint feeds it the effective-folded session rows and it
 * returns the numbers the app renders. Computed server-side so the app,
 * the console and any export agree on what "punctuality" means.
 *
 *  - present / late / absent / early_checkout / leave counts by status;
 *  - punctuality = present ÷ (present + late + absent + early_checkout),
 *    i.e. "of the days you were expected, how many were clean";
 *  - average lateness in minutes across the late sessions that have a shift
 *    start to measure against;
 *  - hours on duty (closed sessions only);
 *  - current streak of consecutive clean (present) sessions, newest first.
 */

export interface KpiSessionRow {
  attendance_status: string | null;
  clock_in_at: string | Date | null;
  clock_out_at: string | Date | null;
  shift_start_at?: string | Date | null;
  review_status?: string | null;
}

export interface AttendanceKpis {
  sessions: number;
  present: number;
  late: number;
  absent: number;
  early_checkout: number;
  leave: number;
  pending_review: number;
  /** 0..100, null when nothing was expected of the member. */
  punctuality_pct: number | null;
  /** Mean minutes after shift start across late sessions with a shift; null if none. */
  avg_late_minutes: number | null;
  /** Sum of closed-session durations, one decimal. */
  hours_on_duty: number;
  /** Consecutive clean sessions counting back from the newest; absences break it. */
  clean_streak: number;
}

const ms = (v: string | Date | null | undefined): number | null => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};

/** `rows` newest first (the history endpoint's order). */
export function computeAttendanceKpis(rows: readonly KpiSessionRow[]): AttendanceKpis {
  let present = 0, late = 0, absent = 0, early = 0, leave = 0, pending = 0;
  let lateSum = 0, lateN = 0, dutyMs = 0;
  for (const r of rows) {
    switch (r.attendance_status) {
      case 'present': present++; break;
      case 'late': late++; break;
      case 'absent': absent++; break;
      case 'early_checkout': early++; break;
      case 'leave': case 'sick_leave': case 'emergency_leave': case 'off_duty': leave++; break;
      case 'pending_review': pending++; break;
      default: break;
    }
    if (r.review_status === 'pending' && r.attendance_status !== 'pending_review') pending++;
    if (r.attendance_status === 'late') {
      const start = ms(r.shift_start_at), at = ms(r.clock_in_at);
      if (start !== null && at !== null && at > start) { lateSum += (at - start) / 60_000; lateN++; }
    }
    const i = ms(r.clock_in_at), o = ms(r.clock_out_at);
    if (i !== null && o !== null && o > i && r.attendance_status !== 'absent') dutyMs += o - i;
  }
  const expected = present + late + absent + early;
  let streak = 0;
  for (const r of rows) {
    if (r.attendance_status === 'present') { streak++; continue; }
    if (r.attendance_status === 'late' || r.attendance_status === 'absent' || r.attendance_status === 'early_checkout') break;
    // leave / pending / unmarked days neither extend nor break the streak.
  }
  return {
    sessions: rows.length,
    present, late, absent, early_checkout: early, leave, pending_review: pending,
    punctuality_pct: expected > 0 ? Math.round((present / expected) * 100) : null,
    avg_late_minutes: lateN > 0 ? Math.round(lateSum / lateN) : null,
    hours_on_duty: Math.round((dutyMs / 3_600_000) * 10) / 10,
    clean_streak: streak,
  };
}
