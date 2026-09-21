/**
 * B-861 (plan `docs/planning/SECURE_TRANSFER_ZONE_SCHEDULE_PLAN_2026-09-11.md`
 * §10 A1) — the Book Now / Book Later toggle is gone; MISSION START is always
 * shown and `booking_mode` is DERIVED from the time the user picked.
 *
 * The boundary is `MIN_LEAD_HOURS` (3 h) and nothing else, BECAUSE it is the
 * server's own gate (`booking.service.ts` assertLeadTime):
 *   · below 3 h a derived `'later'` would be refused ("Minimum 3-hour lead time");
 *   · above 3 h a derived `'now'` would widen IMMEDIATE dispatch past anything
 *     the user asked for (ops publishes a `!isLater` booking the moment it is
 *     approved).
 * Only 3 h has no failure mode — so this must NEVER be parameterised on the
 * ops-configurable `transfer_min_lead_hours`, which is the PICKER's floor, a
 * different number for a different job.
 *
 * B-874 (founder 2026-09-14) — the Secure Transfer PICKER now floors at the
 * same 3 h for every account, so the derived answer is always `'later'` there
 * and the pill that used to render it is gone. The derivation itself stays: the
 * draft, the Summary row and the server all still speak `booking_mode`, and
 * other callers can still file `'now'`.
 */
import {bookingModeLabel, deriveBookingMode, startNeedsReseed, MIN_LEAD_HOURS} from '../scheduleGate';
import {setServicePricingOverrides} from '../servicePricingOverrides';

const H = 3_600_000;
const NOW = Date.UTC(2026, 8, 11, 9, 0, 0);

describe('B-861 A1 — deriveBookingMode: the time decides the mode', () => {
  it('2 h 59 out is on-demand', () => {
    expect(deriveBookingMode(NOW + 2 * H + 59 * 60_000, NOW)).toBe('now');
  });

  it('EXACTLY 3 h 00 out is scheduled — the boundary is the server gate itself', () => {
    expect(deriveBookingMode(NOW + MIN_LEAD_HOURS * H, NOW)).toBe('later');
  });

  it('3 h 01 out is scheduled', () => {
    expect(deriveBookingMode(NOW + MIN_LEAD_HOURS * H + 60_000, NOW)).toBe('later');
  });

  it('the earliest on-demand slot (15 min) is on-demand', () => {
    expect(deriveBookingMode(NOW + 15 * 60_000, NOW)).toBe('now');
  });

  it('a start already in the past is on-demand, never scheduled', () => {
    // `computeStartTime` clamps such a pick up to the earliest bookable instant,
    // but the derivation must not hand the server a `'later'` it would refuse.
    expect(deriveBookingMode(NOW - H, NOW)).toBe('now');
  });

  it('a week out is scheduled', () => {
    expect(deriveBookingMode(NOW + 168 * H, NOW)).toBe('later');
  });

  it('is a pure function of the two instants — the ops lead cannot move it', () => {
    setServicePricingOverrides({transfer_min_lead_hours: 0.25});
    expect(deriveBookingMode(NOW + 2 * H, NOW)).toBe('now');
    expect(deriveBookingMode(NOW + 4 * H, NOW)).toBe('later');
    // Ops raising the Book-Now lead moves the PICKER's floor, never the mode
    // boundary — otherwise a 3 h 30 booking would flip lane on an ops edit.
    setServicePricingOverrides({transfer_min_lead_hours: 3});
    expect(deriveBookingMode(NOW + 2 * H, NOW)).toBe('now');
    expect(deriveBookingMode(NOW + 4 * H, NOW)).toBe('later');
    setServicePricingOverrides({});
  });
});

/**
 * FLIPPED by B-874. This block used to prove the on-demand LANE was AUTO-only
 * (so the pill was gated on it). There is no lane and no pill now: the picker
 * floors at MIN_LEAD_HOURS for EVERY account, so the earliest slot anyone can
 * pick is exactly the boundary and derives `'later'`.
 */
describe('B-874 — one floor for every account, so every transfer is scheduled', () => {
  afterEach(() => setServicePricingOverrides({}));

  it('the earliest bookable start is exactly the boundary, and derives later', () => {
    expect(deriveBookingMode(NOW + MIN_LEAD_HOURS * H, NOW)).toBe('later');
    // Anything the picker could have offered BELOW it is refused by the floor.
    expect(startNeedsReseed(NOW + MIN_LEAD_HOURS * H - 60_000, NOW, MIN_LEAD_HOURS)).toBe(true);
    expect(startNeedsReseed(NOW + 15 * 60_000, NOW, MIN_LEAD_HOURS)).toBe(true);
  });

  it('an ops board still carrying the old Book-Now lead changes nothing', () => {
    setServicePricingOverrides({transfer_min_lead_hours: 0.25});
    expect(deriveBookingMode(NOW + MIN_LEAD_HOURS * H, NOW)).toBe('later');
    expect(startNeedsReseed(NOW + 15 * 60_000, NOW, MIN_LEAD_HOURS)).toBe(true);
  });
});

/**
 * B-861 T-1 / P2-5 — the two words the user sees for a lane, in ONE place.
 *
 * The wizard's pill and the post-submit Summary row must not drift: they name
 * the same server field. "Book Now"/"Book Later" are retired with the toggle
 * that named them — a control the user no longer has cannot be the label for
 * what the system decided.
 */
describe('B-861 — bookingModeLabel is the one lane vocabulary', () => {
  it('names the two lanes exactly', () => {
    expect(bookingModeLabel('now')).toBe('On demand');
    expect(bookingModeLabel('later')).toBe('Scheduled');
  });

  it('the retired toggle words never come back', () => {
    for (const m of ['now', 'later'] as const) {
      expect(bookingModeLabel(m)).not.toMatch(/Book (Now|Later)/);
    }
  });

  it('composes with the derivation: a 3 h start reads Scheduled, 2 h 59 On demand', () => {
    expect(bookingModeLabel(deriveBookingMode(NOW + MIN_LEAD_HOURS * H, NOW))).toBe('Scheduled');
    expect(bookingModeLabel(deriveBookingMode(NOW + 2 * H + 59 * 60_000, NOW))).toBe('On demand');
  });
});

/**
 * B-861 P1-3 — the derived lane is a function of the CLOCK, not only of what
 * the user last touched.
 *
 * A user who sets +3 h 00 and then idles drifts under the gate, and submit
 * would file `'now'`: immediate dispatch and the accept-anchored cancel window
 * instead of the `lateCancelHours` one. That is a MONEY difference the user was
 * never shown. The screen refreshes a `now` tick every 30 s and on AppState
 * 'active', and re-derives the mode on it; this pins the flip that tick
 * produces. B-874 note: on the Secure Transfer wizard the same tick also
 * re-floors the START, so the flip is not reachable there any more — the
 * derivation itself must still be correct for every other caller.
 */
describe('B-861 P1-3 — the derived lane moves as "now" moves under the start', () => {
  it('60 s of idling across the boundary flips Scheduled → On demand', () => {
    const start = NOW + MIN_LEAD_HOURS * H;          // exactly the boundary
    expect(bookingModeLabel(deriveBookingMode(start, NOW))).toBe('Scheduled');
    // Two ticks later (the screen ticks every 30 s) the same start is inside.
    const afterTwoTicks = NOW + 60_000;
    expect(bookingModeLabel(deriveBookingMode(start, afterTwoTicks))).toBe('On demand');
  });

  it('a start well clear of the boundary does NOT flip on a tick', () => {
    const start = NOW + 8 * H;
    expect(bookingModeLabel(deriveBookingMode(start, NOW))).toBe('Scheduled');
    expect(bookingModeLabel(deriveBookingMode(start, NOW + 60_000))).toBe('Scheduled');
  });
});

/**
 * B-861 T-2 (D3 / plan A12.11) — a pick-up in another zone moves the CLOCK the
 * pickers read in, so the SAME wall-clock the user chose now names a different
 * instant. Re-seed only when that instant has fallen below the new zone's
 * earliest: a time the user deliberately picked must never be overwritten just
 * because the zone changed.
 */
describe('B-861 T-2 — startNeedsReseed on a zone change', () => {
  it('re-seeds when the recomputed instant falls BELOW the new earliest', () => {
    // 15-min lane: a start 5 minutes out no longer clears the floor.
    expect(startNeedsReseed(NOW + 5 * 60_000, NOW, 0.25)).toBe(true);
    // 3-hour lane: a start 2 h out is under it.
    expect(startNeedsReseed(NOW + 2 * H, NOW, MIN_LEAD_HOURS)).toBe(true);
    // A start that has slipped into the past.
    expect(startNeedsReseed(NOW - H, NOW, 0.25)).toBe(true);
  });

  it('leaves a start that still clears the new earliest ALONE', () => {
    expect(startNeedsReseed(NOW + 8 * H, NOW, MIN_LEAD_HOURS)).toBe(false);
    expect(startNeedsReseed(NOW + 20 * 60_000, NOW, 0.25)).toBe(false);
    // Exactly ON the floor is still bookable — the server's gate is `<`.
    expect(startNeedsReseed(NOW + MIN_LEAD_HOURS * H, NOW, MIN_LEAD_HOURS)).toBe(false);
  });

  it('the two zone clocks are the caller’s job — this compares INSTANTS', () => {
    // A Cape Town (UTC+2) 09:00 read from a Gulf (UTC+4) draft is two hours
    // LATER as an instant; the helper only ever sees the resolved instants, so
    // the frame bug (B-792) cannot re-enter through it.
    const capeTown0900 = NOW + 4 * H;
    const gulf0900 = NOW + 2 * H;
    expect(startNeedsReseed(capeTown0900, NOW, MIN_LEAD_HOURS)).toBe(false);
    expect(startNeedsReseed(gulf0900, NOW, MIN_LEAD_HOURS)).toBe(true);
  });
});
