/**
 * B-789b — the booking ZONE's clock, not the device's.
 *
 * Every schedule picker in the app hands back a `Date` whose LOCAL fields are
 * the wall-clock the user tapped ("tomorrow 09:00"). `computeStartTime` then
 * called `toISOString()` on it — which reads that wall-clock in the DEVICE's
 * timezone. A client in Dubai (UTC+4) scheduling Cape Town (UTC+2) for 09:00
 * therefore booked 09:00 Gulf, which is 07:00 in Cape Town, and the guard was
 * dispatched two hours early. Every downstream clock (lead gate, T-15 sweep,
 * reminder) then agreed on the wrong instant.
 *
 * The zone's offset comes from `public.regions.utc_offset_hours` via
 * `regionsAvailability` and rides on the draft as `zone_utc_offset_hours`.
 * A fixed offset (no DST) is what the server models too; every launched
 * region is DST-free. `null` offset = unknown = today's behaviour (device clock),
 * so a stale server or a seed-only zone can never make a booking WORSE than it
 * was.
 *
 * Pure — no RN imports — so the node `booking` project pins the arithmetic.
 */
import {formatTime12h} from '../../components/booking/time12h';

const HOUR_MS = 3_600_000;

/** The device's own UTC offset at an instant, in hours (east positive). */
export function deviceOffsetHours(at: Date = new Date()): number {
  return -at.getTimezoneOffset() / 60;
}

/**
 * A picker Date (local fields = the wall-clock the user chose IN THE ZONE) →
 * the instant that wall-clock denotes in the zone.
 */
export function zoneWallClockToInstant(
  wall: Date,
  zoneOffsetHours: number | null | undefined,
): Date {
  if (zoneOffsetHours === null || zoneOffsetHours === undefined || !Number.isFinite(zoneOffsetHours)) {
    return new Date(wall.getTime());
  }
  const utcOfWall = Date.UTC(
    wall.getFullYear(), wall.getMonth(), wall.getDate(),
    wall.getHours(), wall.getMinutes(), wall.getSeconds(), wall.getMilliseconds(),
  );
  return new Date(utcOfWall - zoneOffsetHours * HOUR_MS);
}

/**
 * An instant → a Date whose LOCAL fields read as the zone's wall-clock, so the
 * existing pickers and labels (which read `getHours()` etc.) show zone time.
 */
export function instantToZoneWallClock(
  instant: Date,
  zoneOffsetHours: number | null | undefined,
): Date {
  if (zoneOffsetHours === null || zoneOffsetHours === undefined || !Number.isFinite(zoneOffsetHours)) {
    return new Date(instant.getTime());
  }
  const shifted = new Date(instant.getTime() + zoneOffsetHours * HOUR_MS);
  return new Date(
    shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(),
    shifted.getUTCHours(), shifted.getUTCMinutes(), shifted.getUTCSeconds(), shifted.getUTCMilliseconds(),
  );
}

/** True when the zone's clock differs from the device's — the only case a
 *  second time is worth showing. */
export function zoneClockDiffers(
  zoneOffsetHours: number | null | undefined,
  at: Date = new Date(),
): boolean {
  if (zoneOffsetHours === null || zoneOffsetHours === undefined || !Number.isFinite(zoneOffsetHours)) {
    return false;
  }
  return Math.abs(deviceOffsetHours(at) - zoneOffsetHours) > 1e-9;
}

/**
 * "7:00 AM your time" for an instant, or null when the zone and device clocks
 * agree. Appended to a label that already shows the zone wall-clock.
 */
export function zoneClockNote(
  instant: Date,
  zoneOffsetHours: number | null | undefined,
): string | null {
  if (!zoneClockDiffers(zoneOffsetHours, instant)) {return null;}
  return `${formatTime12h(instant.getHours(), instant.getMinutes())} your time`;
}

/** Short zone-clock tag for labels: "UTC+2" (no tz database on the client). */
export function zoneOffsetTag(zoneOffsetHours: number | null | undefined): string | null {
  if (zoneOffsetHours === null || zoneOffsetHours === undefined || !Number.isFinite(zoneOffsetHours)) {
    return null;
  }
  const sign = zoneOffsetHours >= 0 ? '+' : '−';
  const abs = Math.abs(zoneOffsetHours);
  const h = Math.floor(abs);
  const m = Math.round((abs - h) * 60);
  return `UTC${sign}${h}${m ? ':' + String(m).padStart(2, '0') : ''}`;
}
