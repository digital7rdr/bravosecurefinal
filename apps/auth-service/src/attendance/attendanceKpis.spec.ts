/**
 * Attendance KPIs (founder, 2026-09-05) — the arithmetic behind a member's
 * history header. Pure, so every number the manager reads is pinned here.
 */
import {computeAttendanceKpis} from './attendanceKpis';

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 5, h, m)).toISOString();

describe('computeAttendanceKpis', () => {
  it('counts by status and derives punctuality over the days something was expected', () => {
    const k = computeAttendanceKpis([
      {attendance_status: 'present', clock_in_at: at(8), clock_out_at: at(16)},
      {attendance_status: 'late', clock_in_at: at(8, 40), clock_out_at: at(16), shift_start_at: at(8)},
      {attendance_status: 'absent', clock_in_at: at(8), clock_out_at: null},
      {attendance_status: 'leave', clock_in_at: at(8), clock_out_at: null},
      {attendance_status: 'early_checkout', clock_in_at: at(8), clock_out_at: at(12)},
    ]);
    expect(k.sessions).toBe(5);
    expect(k.present).toBe(1);
    expect(k.late).toBe(1);
    expect(k.absent).toBe(1);
    expect(k.early_checkout).toBe(1);
    expect(k.leave).toBe(1);
    // 1 clean of 4 expected days (leave is not "expected").
    expect(k.punctuality_pct).toBe(25);
    expect(k.avg_late_minutes).toBe(40);
    // 8 h + 7 h 20 m + 4 h = 19.3 h; the absent row has no clock-out.
    expect(k.hours_on_duty).toBe(19.3);
  });

  it('a member with nothing expected has no punctuality figure, not 0%', () => {
    const k = computeAttendanceKpis([{attendance_status: 'leave', clock_in_at: at(8), clock_out_at: null}]);
    expect(k.punctuality_pct).toBeNull();
    expect(k.avg_late_minutes).toBeNull();
    expect(k.hours_on_duty).toBe(0);
  });

  it('the clean streak counts back from the newest session; leave neither extends nor breaks it', () => {
    const rows = [
      {attendance_status: 'present', clock_in_at: at(8), clock_out_at: at(16)},
      {attendance_status: 'leave', clock_in_at: at(8), clock_out_at: null},
      {attendance_status: 'present', clock_in_at: at(8), clock_out_at: at(16)},
      {attendance_status: 'late', clock_in_at: at(9), clock_out_at: at(16)},
      {attendance_status: 'present', clock_in_at: at(8), clock_out_at: at(16)},
    ];
    expect(computeAttendanceKpis(rows).clean_streak).toBe(2);
    expect(computeAttendanceKpis([{attendance_status: 'absent', clock_in_at: at(8), clock_out_at: null}, ...rows]).clean_streak).toBe(0);
  });

  it('pending review is counted once whether the status or the review flag says so', () => {
    const k = computeAttendanceKpis([
      {attendance_status: 'pending_review', clock_in_at: at(8), clock_out_at: null, review_status: 'pending'},
      {attendance_status: 'late', clock_in_at: at(9), clock_out_at: null, review_status: 'pending'},
    ]);
    expect(k.pending_review).toBe(2);
    expect(k.late).toBe(1);
  });

  it('lateness needs a shift start; garbage timestamps are ignored', () => {
    const k = computeAttendanceKpis([
      {attendance_status: 'late', clock_in_at: at(9), clock_out_at: 'not-a-date'},
      {attendance_status: 'late', clock_in_at: at(9), clock_out_at: at(10), shift_start_at: 'nope'},
    ]);
    expect(k.avg_late_minutes).toBeNull();
    expect(k.hours_on_duty).toBe(1);
  });
});
