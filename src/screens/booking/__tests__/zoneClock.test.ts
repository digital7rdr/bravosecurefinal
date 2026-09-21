/**
 * B-789b — schedule pickers are read in the booking ZONE's clock.
 *
 * `computeStartTime` built the instant from the device's wall-clock, and the
 * app knew no per-zone offset. A client in Dubai (UTC+4) scheduling Cape Town
 * (UTC+2) for 09:00 booked 09:00 Gulf — 07:00 in Cape Town — and the guard was
 * dispatched two hours early. The arithmetic here is what every picker now
 * routes through; it is written to be independent of the machine's timezone
 * so the suite means the same thing on a Gulf laptop and in CI.
 */
import {
  zoneWallClockToInstant, instantToZoneWallClock, zoneClockDiffers,
  zoneClockNote, zoneOffsetTag, deviceOffsetHours,
} from '../zoneClock';

/** A Date whose LOCAL fields are the given wall-clock — what a picker returns. */
const wall = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi, 0, 0);

describe('wall-clock in the zone → instant', () => {
  it('09:00 in a UTC+2 zone is 07:00Z, whatever the device zone is', () => {
    expect(zoneWallClockToInstant(wall(2026, 9, 4, 9, 0), 2).toISOString()).toBe('2026-09-04T07:00:00.000Z');
  });

  it('09:00 in a UTC+4 zone is 05:00Z', () => {
    expect(zoneWallClockToInstant(wall(2026, 9, 4, 9, 0), 4).toISOString()).toBe('2026-09-04T05:00:00.000Z');
  });

  it('handles half-hour zones and negative offsets', () => {
    expect(zoneWallClockToInstant(wall(2026, 9, 4, 9, 0), 5.5).toISOString()).toBe('2026-09-04T03:30:00.000Z');
    expect(zoneWallClockToInstant(wall(2026, 9, 4, 9, 0), -3).toISOString()).toBe('2026-09-04T12:00:00.000Z');
  });

  it('crosses midnight correctly', () => {
    // 01:00 on the 4th in UTC+4 is 21:00Z on the 3rd.
    expect(zoneWallClockToInstant(wall(2026, 9, 4, 1, 0), 4).toISOString()).toBe('2026-09-03T21:00:00.000Z');
  });

  it('with no offset known, the instant is the device reading (today\'s behaviour)', () => {
    const w = wall(2026, 9, 4, 9, 0);
    expect(zoneWallClockToInstant(w, null).getTime()).toBe(w.getTime());
    expect(zoneWallClockToInstant(w, undefined).getTime()).toBe(w.getTime());
    expect(zoneWallClockToInstant(w, Number.NaN).getTime()).toBe(w.getTime());
  });
});

describe('instant → wall-clock in the zone', () => {
  it('07:00Z reads as 09:00 in a UTC+2 zone', () => {
    const w = instantToZoneWallClock(new Date('2026-09-04T07:00:00.000Z'), 2);
    expect([w.getFullYear(), w.getMonth() + 1, w.getDate(), w.getHours(), w.getMinutes()]).toEqual([2026, 9, 4, 9, 0]);
  });

  it('round-trips with the forward conversion at every offset', () => {
    for (const off of [-8, -3, 0, 2, 4, 5.5, 9, 12]) {
      const w = wall(2026, 12, 31, 23, 45);
      const back = instantToZoneWallClock(zoneWallClockToInstant(w, off), off);
      expect(back.getTime()).toBe(w.getTime());
    }
  });

  it('with no offset known, returns the instant unchanged', () => {
    const i = new Date('2026-09-04T07:00:00.000Z');
    expect(instantToZoneWallClock(i, null).getTime()).toBe(i.getTime());
  });
});

describe('the "your time" note', () => {
  const dev = deviceOffsetHours(new Date('2026-09-04T07:00:00.000Z'));

  it('is silent when the zone clock IS the device clock', () => {
    expect(zoneClockDiffers(dev)).toBe(false);
    expect(zoneClockNote(new Date('2026-09-04T07:00:00.000Z'), dev)).toBeNull();
  });

  it('is silent when no offset is known', () => {
    expect(zoneClockDiffers(null)).toBe(false);
    expect(zoneClockNote(new Date(), null)).toBeNull();
  });

  it('names the device time when the zone clock differs', () => {
    const note = zoneClockNote(new Date('2026-09-04T07:00:00.000Z'), dev + 2);
    expect(note).toMatch(/your time$/);
    expect(note).toMatch(/\d{1,2}:\d{2} (AM|PM) your time/);
  });

  it('tags the zone clock without a tz database', () => {
    expect(zoneOffsetTag(2)).toBe('UTC+2');
    expect(zoneOffsetTag(5.5)).toBe('UTC+5:30');
    expect(zoneOffsetTag(-3)).toBe('UTC−3');
    expect(zoneOffsetTag(0)).toBe('UTC+0');
    expect(zoneOffsetTag(null)).toBeNull();
  });
});

describe('the founder\'s case, end to end', () => {
  it('Dubai phone, Cape Town booking, "tomorrow 09:00" → 07:00Z, not 05:00Z', () => {
    // 09:00 as the CAPE TOWN wall-clock.
    const picked = wall(2026, 9, 4, 9, 0);
    const instant = zoneWallClockToInstant(picked, 2);
    expect(instant.toISOString()).toBe('2026-09-04T07:00:00.000Z');
    // The old code read the same picker in the DEVICE zone; on a UTC+4 phone
    // that was 05:00Z — two hours early for the guard.
    const oldBehaviour = zoneWallClockToInstant(picked, 4);
    expect(oldBehaviour.toISOString()).toBe('2026-09-04T05:00:00.000Z');
  });
});
