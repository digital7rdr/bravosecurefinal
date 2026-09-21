/**
 * Attendance verification helpers (founder, 2026-09-05) — the window a tile
 * counts over, the one "where" rule, and the late-by arithmetic. Relative
 * import on purpose: the booking project has no module aliases.
 */
import {dayWindow, hasFix, lateBy, placeLabel, statusBucket} from '../../deptchat/attendanceDay';

describe('dayWindow — the tile and the list count the same people', () => {
  const now = new Date(2026, 8, 5, 14, 30); // local 5 Sep 2026 14:30

  it('today = local midnight to next local midnight', () => {
    const w = dayWindow('today', now);
    expect(new Date(w.from!).getTime()).toBe(new Date(2026, 8, 5, 0, 0, 0, 0).getTime());
    expect(new Date(w.to!).getTime()).toBe(new Date(2026, 8, 6, 0, 0, 0, 0).getTime());
  });

  it('7 days / 30 days start at local midnight N-1 days back, same end', () => {
    expect(new Date(dayWindow('7d', now).from!).getTime()).toBe(new Date(2026, 7, 30, 0, 0, 0, 0).getTime());
    expect(new Date(dayWindow('30d', now).from!).getTime()).toBe(new Date(2026, 7, 7, 0, 0, 0, 0).getTime());
    expect(dayWindow('30d', now).to).toBe(dayWindow('today', now).to);
  });

  it('all = no bounds', () => {
    expect(dayWindow('all', now)).toEqual({});
  });
});

describe('placeLabel — never a code, never blank', () => {
  it('prefers the reverse-geocoded name, then coordinates, then the site label', () => {
    expect(placeLabel({clock_in_place: ' Sandton City, Johannesburg ', site_label: 'HQ', clock_in_lat: -26.1, clock_in_lng: 28.05}))
      .toBe('Sandton City, Johannesburg');
    expect(placeLabel({clock_in_place: null, site_label: 'HQ', clock_in_lat: -26.10761, clock_in_lng: 28.05623}))
      .toBe('-26.10761, 28.05623');
    expect(placeLabel({clock_in_place: null, site_label: 'HQ', clock_in_lat: null, clock_in_lng: null})).toBe('HQ');
    expect(placeLabel({clock_in_place: '', site_label: null, clock_in_lat: null, clock_in_lng: null})).toBe('Location not recorded');
  });

  it('reads the check-OUT side when asked', () => {
    expect(placeLabel({clock_in_place: 'In', site_label: null, clock_in_lat: null, clock_in_lng: null}, 'out',
      {clock_out_place: 'Out', clock_out_lat: null, clock_out_lng: null})).toBe('Out');
  });

  it('hasFix refuses null and the 0,0 null island', () => {
    expect(hasFix({clock_in_lat: -26.1, clock_in_lng: 28})).toBe(true);
    expect(hasFix({clock_in_lat: null, clock_in_lng: 28})).toBe(false);
    expect(hasFix({clock_in_lat: 0, clock_in_lng: 0})).toBe(false);
  });
});

describe('lateBy + statusBucket', () => {
  it('minutes after shift start, only for late sessions with a shift', () => {
    expect(lateBy({attendance_status: 'late', clock_in_at: '2026-09-05T08:40:00Z', shift_start_at: '2026-09-05T08:00:00Z'})).toBe(40);
    expect(lateBy({attendance_status: 'present', clock_in_at: '2026-09-05T08:40:00Z', shift_start_at: '2026-09-05T08:00:00Z'})).toBeNull();
    expect(lateBy({attendance_status: 'late', clock_in_at: '2026-09-05T08:40:00Z', shift_start_at: null})).toBeNull();
  });

  it('a tile filters on its own status name', () => {
    expect(statusBucket('late')).toBe('late');
  });
});
