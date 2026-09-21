/**
 * B-786 — the ONE row chip: (booking status × mission status × payment state).
 *
 * The old history rendered `describeStatus` alone, so a COMPLETED booking whose
 * credits were still held for the dispute window said only "COMPLETED" — the
 * user could not tell whether they had been charged, refunded, or were waiting.
 * These pin the whole matrix, including the precedence rules that decide which
 * of the three inputs wins.
 */
import {
  describeBookingRow, bucketFor, describeStatus, isTerminalBookingStatus,
} from '../bookingStatus';

const NOW = new Date('2026-09-03T12:00:00Z').getTime();
const future = new Date('2026-09-10T12:00:00Z').toISOString();
const past = new Date('2026-09-01T12:00:00Z').toISOString();

describe('a live mission outranks the lagging booking status', () => {
  // The booking FSM stays CONFIRMED for the WHOLE mission (LB-OTP1/LB-ST2);
  // only mission_status tracks the phase. Reading the booking status alone is
  // why the list showed a frozen "CONFIRMED" for an entire detail.
  it.each([
    // 2026-09-04 — CREWED (crew named, not sent) never reads as dispatched.
    ['CREWED', 'TEAM ASSIGNED'],
    ['DISPATCHED', 'TEAM DISPATCHED'],
    ['PICKUP', 'ARRIVED'],
    ['LIVE', 'PROTECTION ACTIVE'],
  ])('mission %s renders %s', (mission, label) => {
    const r = describeBookingRow({status: 'CONFIRMED', mission_status: mission}, NOW);
    expect(r.label).toBe(label);
    expect(r.bucket).toBe('active');
  });

  it('SOS outranks everything, including a terminal booking', () => {
    expect(describeBookingRow({status: 'COMPLETED', mission_status: 'SOS'}, NOW).label).toBe('SOS');
    expect(describeBookingRow({status: 'COMPLETED', mission_status: 'SOS'}, NOW).bucket).toBe('active');
  });

  it('a TERMINAL booking is history even if a stale mission row says LIVE', () => {
    // A re-dispatched booking keeps an older mission; without this a completed
    // booking could read as running forever.
    const r = describeBookingRow({status: 'COMPLETED', mission_status: 'LIVE'}, NOW);
    expect(r.label).toBe('COMPLETED');
    expect(r.bucket).toBe('past');
  });
});

describe('the money word', () => {
  it.each([
    ['held', 'ON HOLD'],
    ['released', 'PAID'],
    ['paid', 'PAID'],
    ['refunded', 'REFUNDED'],
    ['partially_refunded', 'PARTLY REFUNDED'],
    ['under_review', 'UNDER REVIEW'],
    ['due', 'PAYMENT DUE'],
  ] as const)('%s reads %s', (state, word) => {
    expect(describeBookingRow({status: 'COMPLETED', payment_state: state}, NOW).money).toBe(word);
  });

  it('stays silent when nothing ever moved', () => {
    expect(describeBookingRow({status: 'CANCELLED', payment_state: 'not_charged'}, NOW).money).toBeNull();
    expect(describeBookingRow({status: 'CANCELLED'}, NOW).money).toBeNull();
  });

  it('turns the chip amber when payment is contested', () => {
    const normal = describeBookingRow({status: 'COMPLETED', payment_state: 'released'}, NOW);
    const disputed = describeBookingRow({status: 'COMPLETED', payment_state: 'under_review'}, NOW);
    expect(disputed.color).not.toBe(normal.color);
    expect(disputed.label).toBe('COMPLETED');
    expect(disputed.money).toBe('UNDER REVIEW');
  });

  it('carries the money word onto an in-flight row too', () => {
    const r = describeBookingRow({status: 'CONFIRMED', mission_status: 'LIVE', payment_state: 'held'}, NOW);
    expect(r.label).toBe('PROTECTION ACTIVE');
    expect(r.money).toBe('ON HOLD');
  });
});

describe('buckets', () => {
  it('a confirmed booking with no crew and a future start is UPCOMING', () => {
    expect(bucketFor({status: 'CONFIRMED', start_time: future}, NOW)).toBe('upcoming');
  });

  it('the same booking becomes ACTIVE once its start time has passed', () => {
    expect(bucketFor({status: 'CONFIRMED', start_time: past}, NOW)).toBe('active');
  });

  it('a crewed booking is ACTIVE whatever its start time says', () => {
    expect(bucketFor({status: 'CONFIRMED', mission_status: 'DISPATCHED', start_time: future}, NOW))
      .toBe('active');
  });

  it('a parked future reservation is UPCOMING, never active (B-405)', () => {
    // PENDING_OPS + later, and auto + OPS_APPROVED + later. Pinning these to the
    // active card is the "one mission at a time" trap that B-405 closed.
    expect(bucketFor({status: 'PENDING_OPS', booking_mode: 'later'}, NOW)).toBe('upcoming');
    expect(bucketFor({status: 'OPS_APPROVED', booking_mode: 'later', dispatch_mode: 'auto'}, NOW))
      .toBe('upcoming');
  });

  it('a LEGACY later booking at OPS_APPROVED stays ACTIVE — payment is due now', () => {
    // Deliberate asymmetry, documented on isUpcomingScheduled: only the auto
    // path escrow-charges at accept. Classifying this as upcoming let bookings
    // die unpaid behind a green chip.
    expect(bucketFor({status: 'OPS_APPROVED', booking_mode: 'later'}, NOW)).toBe('active');
  });

  it.each([
    ['COMPLETED', 'past'],
    ['CANCELLED', 'cancelled'],
    ['NO_PROVIDER', 'cancelled'],
    ['AGENCY_NO_SHOW', 'cancelled'],
  ] as const)('%s buckets as %s', (status, bucket) => {
    expect(bucketFor({status}, NOW)).toBe(bucket);
  });

  it('NO_PROVIDER never occupies the active slot (the LB17 trap)', () => {
    expect(bucketFor({status: 'NO_PROVIDER'}, NOW)).not.toBe('active');
  });

  it('is case-insensitive about the wire enum', () => {
    expect(bucketFor({status: 'completed'}, NOW)).toBe('past');
  });
});

describe('unknown input never renders a blank chip', () => {
  it('falls back to the raw status word', () => {
    expect(describeBookingRow({status: 'SOMETHING_NEW'}, NOW).label).toBe('SOMETHING_NEW');
  });

  it('falls back to UNKNOWN with no status at all', () => {
    expect(describeBookingRow({}, NOW).label).toBe('UNKNOWN');
  });
});

describe('the existing describeStatus is untouched', () => {
  // Its callers (Home hero, OpsRoom, the resume card) were not part of B-786.
  it('still answers the old way', () => {
    expect(describeStatus('LIVE').label).toBe('LIVE');
    expect(describeStatus('PENDING_OPS').label).toBe('PENDING OPS');
    expect(describeStatus(undefined).label).toBe('UNKNOWN');
  });
});

describe('isTerminalBookingStatus — the chip and the TAP must agree', () => {
  // `resumeTargetFor` checks mission_status FIRST and must keep doing so (the
  // booking FSM stays CONFIRMED for a whole mission, which is what makes Home's
  // auto-resume work). But a TERMINAL booking can still carry a stale live
  // mission row, and then the row rendered COMPLETED while tapping it opened
  // LiveTracking. This predicate is what the tap target consults.
  it.each(['COMPLETED', 'CANCELLED', 'NO_PROVIDER', 'AGENCY_NO_SHOW'])('%s is terminal', s => {
    expect(isTerminalBookingStatus(s)).toBe(true);
  });

  it.each(['CONFIRMED', 'LIVE', 'DISPATCHING', 'PENDING_OPS', 'OPS_APPROVED', 'PAYMENT_PENDING'])(
    '%s is NOT terminal', s => {
      expect(isTerminalBookingStatus(s)).toBe(false);
    });

  it('is case-insensitive and safe on nothing', () => {
    expect(isTerminalBookingStatus('completed')).toBe(true);
    expect(isTerminalBookingStatus(null)).toBe(false);
    expect(isTerminalBookingStatus(undefined)).toBe(false);
  });

  it('agrees with the chip for the stale-mission case', () => {
    // The row that exposed the contradiction.
    const chip = describeBookingRow({status: 'COMPLETED', mission_status: 'LIVE'}, Date.now());
    expect(chip.label).toBe('COMPLETED');
    expect(isTerminalBookingStatus('COMPLETED')).toBe(true);
  });
});
