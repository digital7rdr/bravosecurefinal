// Why: the Schedule step (BookingDateTimeScreen) gates advancing to the next step
// on having the required locations. A point-to-point `transfer` needs BOTH a
// pick-up and a drop-off; hourly/itinerary bookings legitimately have no single
// destination, so they only require a pick-up. Extracted here so the gate is
// unit-testable without rendering the screen.
import {roundUpToMinuteStep} from '@components/booking/time12h';
import {priceValue} from './servicePricingOverrides';

export const canAdvanceSchedule = (
  type: string | undefined,
  pickup: unknown,
  dropoff: unknown,
): boolean => Boolean(pickup) && (type !== 'transfer' || Boolean(dropoff));

/**
 * Issue 29 — which booking SHAPE a service uses.
 *
 * 'transfer' is point-to-point and needs a drop-off; everything else is
 * time-based (a duration at a location) and legitimately has none —
 * scheduleGate.canAdvanceSchedule already encodes that rule.
 *
 * This also closes a latent hole: ServiceTypeScreen used to set only `service`,
 * leaving `type` at its 'timeslot' default, so a Secure TRANSFER never required
 * a drop-off either.
 */
export function bookingTypeFor(service: string): 'transfer' | 'timeslot' {
  return service === 'secure_transfer' ? 'transfer' : 'timeslot';
}

/**
 * E-13 — minimum lead time (hours) for a scheduled ("later") booking. Client
 * mirror of `booking.service.ts` MIN_LEAD_HOURS. ONE definition: the Lite
 * schedule screen and the executive schedule screen previously each re-declared
 * it, so a server change would silently drift one of them.
 *
 * B-874 (founder 2026-09-14: "the app must simply not allow you to select a
 * time less than 3 hours ahead") — this is now the Secure Transfer PICKER's
 * floor as well as the `booking_mode` boundary. The ops-board Book-Now lead
 * (`transfer_min_lead_hours`) and its client helpers are GONE: one number, one
 * rule, so the picker can never offer a time the server's own gate would
 * refuse. Every Secure Transfer therefore derives 'later' by construction; the
 * server still accepts 'now' from other callers, so nothing is removed there.
 */
export const MIN_LEAD_HOURS = 3;

/** Mirrors the server ceiling (pricing.service.ts EXEC_LEAD_HOURS_MAX). */
export const EXEC_LEAD_HOURS_MAX = 168;

/**
 * Executive Protection minimum lead time, in hours.
 *
 * EP is ALWAYS SCHEDULED, and its lead time is ops-configurable via the
 * `exec_min_lead_hours` key on the live service-pricing board - so the client
 * must never hardcode 3. Read at CALL time (never captured in a module const or
 * a mount-time memo): the value can hydrate after first render, and a screen
 * left open must not keep quoting a stale minimum.
 *
 * FAIL-OPEN to the compiled default, exactly like the price mirrors: no
 * hydration (offline, old server, cold boot) means the picker uses 3 h, which is
 * the shipped server default, so client and server still agree.
 *
 * This is a CONVENIENCE bound for the picker only. The server re-decides on
 * every estimate and create against its own clock and its own current config -
 * see BookingService.assertExecLeadTime.
 */
export function execMinLeadHours(): number {
  const v = priceValue('exec_min_lead_hours', MIN_LEAD_HOURS);
  return Number.isFinite(v) && v > 0 && v <= EXEC_LEAD_HOURS_MAX ? v : MIN_LEAD_HOURS;
}

/** Earliest bookable EP start from a given instant, rounded up to 5 minutes. */
export function execEarliestStart(nowMs: number = Date.now()): Date {
  // B-861 P2-1 — the SHARED rounder, never a local setMinutes(Math.ceil(...)).
  // Clearing the seconds is part of the value, so they have to count towards
  // the rounding: a floor landing on a step boundary WITH seconds otherwise
  // rounded DOWN, and the only start the picker offered was under the gate.
  return roundUpToMinuteStep(new Date(nowMs + execMinLeadHours() * 3600_000), 5);
}

/**
 * B-861 — `booking_mode`, DERIVED from the chosen MISSION START.
 *
 * The Book Now / Book Later toggle is gone: it only ever chose which of the
 * server's two rules applied, and the time decides that on its own. Below
 * `MIN_LEAD_HOURS` the booking is on-demand (`'now'`: exempt from the lead
 * gate, immediate dispatch on approval, the one-active partial index, the
 * accept-anchored cancel window); at or above it the booking is scheduled
 * (`'later'`: the lead gate, the scheduled-dispatch sweep from T-15, the T-60
 * reminder, the `lateCancelHours` cancel policy).
 *
 * The boundary is `MIN_LEAD_HOURS` and MUST NOT be parameterised on the
 * ops-configurable Book-Now lead: `MIN_LEAD_HOURS` is the server's own gate, so
 * anything below it cannot be submitted as `'later'`, and anything above it
 * would be dispatched immediately as `'now'` although the user asked for a
 * later time. Only this value has no failure mode on either side.
 */
export function deriveBookingMode(startMs: number, nowMs: number): 'now' | 'later' {
  return startMs - nowMs < MIN_LEAD_HOURS * 3600_000 ? 'now' : 'later';
}

/**
 * B-861 — the ONE vocabulary for a booking lane, shared by the wizard's derived
 * pill and the post-submit Summary row.
 *
 * They name the same server field (`booking_mode`), so they must not drift. The
 * old words were "Book Now" / "Book Later" — the two halves of a toggle that no
 * longer exists; a label must describe what the system decided, not a control
 * the user cannot see.
 */
export function bookingModeLabel(mode: 'now' | 'later'): string {
  return mode === 'now' ? 'On demand' : 'Scheduled';
}

/**
 * B-861 D3 / A12.11 — does a chosen start still clear the earliest bookable
 * instant?
 *
 * Used when the PICK-UP moves the booking to another zone: the wall-clock the
 * user picked is re-read in the new zone's clock, and THAT instant is compared
 * with the new earliest. Only a start that has fallen below it is re-seeded —
 * a time the user deliberately chose must not be overwritten just because the
 * zone changed.
 *
 * Both arguments are INSTANTS, never wall-clocks: the frame conversion is the
 * caller's job (B-792), so the two-clock defect cannot re-enter through here.
 * The comparison mirrors the server's own gate, which is strictly `<` — a start
 * exactly ON the floor is bookable.
 */
export function startNeedsReseed(startMs: number, nowMs: number, leadHours: number): boolean {
  return startMs < nowMs + leadHours * 3600_000;
}
