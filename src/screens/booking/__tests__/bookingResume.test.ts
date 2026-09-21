import {resumeTargetFor, liveTargetFor, findResumableBooking, isUpcomingScheduled, isInProgressNow} from '../bookingStatus';

// LB-OTP1 / LB-ST2 — the booking FSM stays CONFIRMED for the whole mission, so
// resume/deep-link routing must key off mission_status (when present), not just
// booking.status. Regression guard for the "verify code / status frozen on
// resume" class of bugs.
describe('resumeTargetFor — mission-aware routing', () => {
  it('routes a plain CONFIRMED (no mission yet) to BookingConfirmation', () => {
    expect(resumeTargetFor('b1', 'CONFIRMED')).toEqual({screen: 'BookingConfirmation', bookingId: 'b1'});
  });

  it('routes CONFIRMED-with-a-live-mission straight to LiveTracking (CREWED included, 2026-09-04)', () => {
    for (const ms of ['CREWED', 'DISPATCHED', 'PICKUP', 'LIVE', 'SOS']) {
      expect(resumeTargetFor('b1', 'CONFIRMED', ms)).toEqual({screen: 'LiveTracking', bookingId: 'b1'});
    }
  });

  it('does NOT divert to LiveTracking for a mission that ended (ABORTED/COMPLETED)', () => {
    expect(resumeTargetFor('b1', 'CONFIRMED', 'ABORTED')).toEqual({screen: 'BookingConfirmation', bookingId: 'b1'});
    // COMPLETED booking is terminal → no resume target.
    expect(resumeTargetFor('b1', 'COMPLETED', 'COMPLETED')).toBeNull();
  });

  it('keeps the pre-mission booking states intact', () => {
    expect(resumeTargetFor('b1', 'DISPATCHING')).toEqual({screen: 'FindingDetail', bookingId: 'b1'});
    expect(resumeTargetFor('b1', 'PENDING_OPS')).toEqual({screen: 'OpsRoomReview', bookingId: 'b1'});
    expect(resumeTargetFor('b1', 'LIVE')).toEqual({screen: 'LiveTracking', bookingId: 'b1'});
    expect(resumeTargetFor('b1', 'NO_PROVIDER')).toEqual({screen: 'NoDetail', bookingId: 'b1'});
    expect(resumeTargetFor('b1', 'CANCELLED')).toBeNull();
  });

  it('liveTargetFor reads both fields off a booking object', () => {
    expect(liveTargetFor({id: 'b1', status: 'CONFIRMED', mission_status: 'PICKUP'}))
      .toEqual({screen: 'LiveTracking', bookingId: 'b1'});
    expect(liveTargetFor({id: 'b1', status: 'CONFIRMED', mission_status: null}))
      .toEqual({screen: 'BookingConfirmation', bookingId: 'b1'});
  });
});

// B-405 — a parked FUTURE reservation ('later' + PENDING_OPS/OPS_APPROVED)
// must never auto-yank the user off Home: "after making a future booking it
// needs to go back to the normal screen" (founder, 2026-08-09).
describe('B-405 — parked future reservations do not trap the client', () => {
  it('isUpcomingScheduled recognises exactly the parked pre-dispatch later states', () => {
    expect(isUpcomingScheduled({status: 'PENDING_OPS', booking_mode: 'later'})).toBe(true);
    expect(isUpcomingScheduled({status: 'PENDING_OPS', booking_mode: 'later', dispatch_mode: null})).toBe(true);
    expect(isUpcomingScheduled({status: 'OPS_APPROVED', booking_mode: 'later', dispatch_mode: 'auto'})).toBe(true);
    // A LEGACY approved 'later' row owes payment NOW — it is ACTIVE, not
    // parked (3-agent review: parking it let the booking die unpaid at
    // pickup+60 behind a green APPROVED chip).
    expect(isUpcomingScheduled({status: 'OPS_APPROVED', booking_mode: 'later'})).toBe(false);
    expect(isUpcomingScheduled({status: 'OPS_APPROVED', booking_mode: 'later', dispatch_mode: null})).toBe(false);
    // A 'now' booking in the same states IS an active mission.
    expect(isUpcomingScheduled({status: 'PENDING_OPS', booking_mode: 'now'})).toBe(false);
    // Once dispatch starts (or payment/live phases), the reservation is active.
    for (const s of ['DISPATCHING', 'PAYMENT_PENDING', 'CONFIRMED', 'LIVE', 'COMPLETED', 'CANCELLED']) {
      expect(isUpcomingScheduled({status: s, booking_mode: 'later', dispatch_mode: 'auto'})).toBe(false);
    }
    // Legacy rows without booking_mode never match.
    expect(isUpcomingScheduled({status: 'OPS_APPROVED'})).toBe(false);
    expect(isUpcomingScheduled({status: 'OPS_APPROVED', booking_mode: null})).toBe(false);
  });

  it('findResumableBooking skips upcoming reservations but still resumes real missions', () => {
    const upcoming = {id: 'later1', status: 'OPS_APPROVED', booking_mode: 'later', dispatch_mode: 'auto'};
    const live = {id: 'now1', status: 'LIVE', booking_mode: 'now'};
    // Only the parked reservation → nothing to resume (user stays on Home).
    expect(findResumableBooking([upcoming])).toBeUndefined();
    // A genuinely live mission still resumes, even listed after the reservation.
    expect(findResumableBooking([upcoming, live])).toBe(live);
    // Once the sweep flips the reservation to DISPATCHING it resumes again.
    expect(findResumableBooking([{id: 'later1', status: 'DISPATCHING', booking_mode: 'later'}]))
      .toEqual({id: 'later1', status: 'DISPATCHING', booking_mode: 'later'});
    // A LEGACY approved 'later' booking resumes too — that yank into
    // OpsRoomReview is what runs its pay countdown.
    expect(findResumableBooking([{id: 'legacy1', status: 'OPS_APPROVED', booking_mode: 'later'}]))
      .toEqual({id: 'legacy1', status: 'OPS_APPROVED', booking_mode: 'later'});
  });
});

// 2026-09-04 — a customer may hold SEVERAL bookings. Home auto-resumes only into
// the one that is in progress NOW; a confirmed booking for tomorrow is an
// "Upcoming" row the customer taps deliberately, never a yank.
describe('multiple bookings — only the in-progress one resumes', () => {
  const NOW = new Date('2026-09-04T12:00:00Z').getTime();
  const at = (h: number) => new Date(NOW + h * 3600_000).toISOString();

  it('isInProgressNow: a live mission or search is in progress whatever its start time', () => {
    expect(isInProgressNow({status: 'CONFIRMED', mission_status: 'CREWED', start_time: at(48)}, NOW)).toBe(true);
    expect(isInProgressNow({status: 'CONFIRMED', mission_status: 'DISPATCHED', start_time: at(48)}, NOW)).toBe(true);
    expect(isInProgressNow({status: 'DISPATCHING', start_time: at(48)}, NOW)).toBe(true);
    expect(isInProgressNow({status: 'LIVE', start_time: at(-1)}, NOW)).toBe(true);
  });

  it('isInProgressNow: a confirmed booking is in progress only inside the 2-hour window', () => {
    expect(isInProgressNow({status: 'CONFIRMED', start_time: at(1)}, NOW)).toBe(true);
    expect(isInProgressNow({status: 'CONFIRMED', start_time: at(-0.5)}, NOW)).toBe(true);
    expect(isInProgressNow({status: 'CONFIRMED', start_time: at(3)}, NOW)).toBe(false);
    expect(isInProgressNow({status: 'CONFIRMED', start_time: at(24)}, NOW)).toBe(false);
    // A legacy row with no start time keeps the old behaviour (resumes).
    expect(isInProgressNow({status: 'CONFIRMED'}, NOW)).toBe(true);
  });

  it('a confirmed booking for tomorrow does NOT auto-resume, even when it is the only one', () => {
    expect(findResumableBooking([{id: 'tmrw', status: 'CONFIRMED', start_time: at(22)}], undefined, NOW)).toBeUndefined();
  });

  it('with three bookings, the one in progress now wins regardless of list order', () => {
    const tomorrow = {id: 'b', status: 'CONFIRMED', start_time: at(22)};
    const friday = {id: 'c', status: 'CONFIRMED', start_time: at(70)};
    const today = {id: 'a', status: 'CONFIRMED', mission_status: 'CREWED', start_time: at(1)};
    expect(findResumableBooking([friday, tomorrow, today], undefined, NOW)).toBe(today);
  });

  it('with two in-progress bookings the SOONER one resumes', () => {
    const later = {id: 'l', status: 'CONFIRMED', start_time: at(1.5)};
    const sooner = {id: 's', status: 'CONFIRMED', start_time: at(0.5)};
    expect(findResumableBooking([later, sooner], undefined, NOW)).toBe(sooner);
  });

  it('terminal rows never resume', () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'NO_PROVIDER', 'AGENCY_NO_SHOW']) {
      expect(findResumableBooking([{id: 'x', status, start_time: at(0)}], undefined, NOW)).toBeUndefined();
    }
  });
});

describe('B-405 × multi-booking — payment-due rows are never parked behind the 2-hour window', () => {
  // Critic 2026-09-04: the 2 h window reclassified a LEGACY 'later' row at
  // OPS_APPROVED (payment due NOW — only auto escrow-charges at accept) as
  // "upcoming", so Home never yanked into OpsRoomReview, the pay countdown never
  // ran, and the drift janitor cancelled it unpaid at pickup+60 behind a green
  // APPROVED chip — the exact B-405 regression. Every earlier case had omitted
  // start_time, which the "legacy row" escape hatch masked; a real row has one.
  const NOW = new Date('2026-09-04T12:00:00Z').getTime();
  const at = (h: number) => new Date(NOW + h * 3600_000).toISOString();

  it('a LEGACY later row at OPS_APPROVED owes payment now — in progress whatever its start', () => {
    expect(isInProgressNow({status: 'OPS_APPROVED', booking_mode: 'later', dispatch_mode: null, start_time: at(72)}, NOW)).toBe(true);
    expect(isInProgressNow({status: 'OPS_APPROVED', booking_mode: 'later', start_time: at(72)}, NOW)).toBe(true);
    expect(findResumableBooking([{id: 'x', status: 'OPS_APPROVED', booking_mode: 'later', dispatch_mode: null, start_time: at(72)}], undefined, NOW)?.id).toBe('x');
  });

  it('PAYMENT_PENDING owes payment now, whatever its start', () => {
    expect(isInProgressNow({status: 'PAYMENT_PENDING', booking_mode: 'later', dispatch_mode: 'auto', start_time: at(72)}, NOW)).toBe(true);
  });

  it('an AUTO later row at OPS_APPROVED is parked — nothing is due until the T-15 sweep', () => {
    expect(isInProgressNow({status: 'OPS_APPROVED', booking_mode: 'later', dispatch_mode: 'auto', start_time: at(72)}, NOW)).toBe(false);
    expect(findResumableBooking([{id: 'x', status: 'OPS_APPROVED', booking_mode: 'later', dispatch_mode: 'auto', start_time: at(72)}], undefined, NOW)).toBeUndefined();
  });

  it("only CONFIRMED takes the window — tomorrow's confirmed booking is Upcoming, not a yank", () => {
    expect(isInProgressNow({status: 'CONFIRMED', booking_mode: 'later', dispatch_mode: 'auto', start_time: at(72)}, NOW)).toBe(false);
    expect(isInProgressNow({status: 'CONFIRMED', booking_mode: 'later', dispatch_mode: 'auto', start_time: at(1)}, NOW)).toBe(true);
  });
});
