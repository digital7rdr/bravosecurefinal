/**
 * IA-17 — one status vocabulary, and it must cover every value the server can
 * send.
 *
 * Five pages used to define their own label/colour map inline, so the same enum
 * read differently depending on where you looked and a value the server grew
 * rendered as a raw SCREAMING_SNAKE string — or, in the case a prior audit
 * caught (PAGE-21), vanished from every bucket.
 *
 * The unions below are copied from the SERVER's enums, not from the client
 * types, so this test fails when the two drift rather than agreeing with a
 * stale client copy.
 */

import {
  BOOKING_STATUS, MISSION_STATUS, JOB_STATUS, AGENT_STATUS,
  PRO_APPLICATION_STATUS, ESCROW_STATUS, PROTECTION_SESSION_STATUS,
  PRO_REQUEST_STATUS, BOOKING_NEEDS_OPS, statusMeta, pillClass,
} from '../lib/status';

/** lite_booking_status (20260423113000_booking_module.sql + auto-dispatch). */
const SERVER_BOOKING = [
  'DRAFT', 'PENDING_OPS', 'OPS_APPROVED', 'PAYMENT_PENDING', 'DISPATCHING',
  'NO_PROVIDER', 'AGENCY_NO_SHOW', 'CONFIRMED', 'LIVE', 'COMPLETED', 'CANCELLED',
];
/** mission_status (20260424000000_ops_admin.sql + 20260904120000 CREWED). */
const SERVER_MISSION = ['CREWED', 'DISPATCHED', 'PICKUP', 'LIVE', 'SOS', 'COMPLETED', 'ABORTED'];
const SERVER_JOB = ['PUBLISHED', 'REVIEW', 'ASSIGNED', 'DISPATCHED', 'CANCELLED'];
const SERVER_AGENT = [
  'DRAFT', 'PROFILE_COMPLETE', 'KYC_PENDING', 'DOCS_PENDING', 'SUBMITTED',
  'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'ACTIVE',
];
const SERVER_PRO_APP = [
  'PENDING_PROPOSAL', 'PROPOSAL_CREATED', 'REVISION_REQUESTED', 'ACCEPTED',
  'ACTIVE', 'EXPIRED', 'REJECTED', 'CANCELLED',
];
/** escrow_hold_status (20260620000002_escrow_integrity.sql). SK-03: no 'SPLIT'. */
const SERVER_ESCROW = ['HELD', 'PENDING_RELEASE', 'RELEASED', 'REFUNDED', 'PARTIAL', 'DISPUTED'];
const SERVER_PROTECTION = ['REQUESTED', 'ASSIGNED', 'ACTIVE', 'COMPLETED', 'ABORTED'];
// pro_plan_missions.status CHECK — 20260903100000_pro_mission_activation.sql:58
// gained CANCELLED (E2E-07, the ops release of a reserved date).
const SERVER_PRO_REQUEST = ['REQUESTED', 'SCHEDULED', 'DECLINED', 'COMPLETED', 'CANCELLED'];

const CASES: Array<[string, string[], Record<string, unknown>]> = [
  ['booking', SERVER_BOOKING, BOOKING_STATUS],
  ['mission', SERVER_MISSION, MISSION_STATUS],
  ['job', SERVER_JOB, JOB_STATUS],
  ['agent', SERVER_AGENT, AGENT_STATUS],
  ['proApplication', SERVER_PRO_APP, PRO_APPLICATION_STATUS],
  ['escrow', SERVER_ESCROW, ESCROW_STATUS],
  ['protection', SERVER_PROTECTION, PROTECTION_SESSION_STATUS],
  ['proRequest', SERVER_PRO_REQUEST, PRO_REQUEST_STATUS],
];

describe('status vocabulary covers every server value', () => {
  it.each(CASES)('%s', (_domain, serverValues, table) => {
    const missing = serverValues.filter(v => !(v in table));
    expect(missing).toEqual([]);
  });

  it('has no entry the server cannot send (a label nobody will ever see)', () => {
    for (const [, serverValues, table] of CASES) {
      const extra = Object.keys(table).filter(k => !serverValues.includes(k));
      expect(extra).toEqual([]);
    }
  });
});

describe('statusMeta', () => {
  it('title-cases an unknown value instead of rendering it raw or undefined', () => {
    // PAGE-21: an unknown status must still READ as words. It must never come
    // back undefined, which is what put a row in no bucket at all.
    expect(statusMeta('booking', 'SOME_NEW_STATE').label).toBe('SOME NEW STATE');
    expect(statusMeta('booking', 'SOME_NEW_STATE').tone).toBe('muted');
  });

  it('renders an em dash for a missing value', () => {
    expect(statusMeta('booking', null).label).toBe('—');
    expect(statusMeta('booking', undefined).label).toBe('—');
  });

  it('keeps LIVE as the live tone, never the error tone', () => {
    // A pulsing "live" indicator, not static red — a booking in progress is not
    // a failure, and the two used to be confused across pages.
    expect(statusMeta('booking', 'LIVE').tone).toBe('live');
    expect(statusMeta('mission', 'SOS').tone).toBe('err');
  });
});

describe('BOOKING_NEEDS_OPS', () => {
  it('is exactly the states no automation will move on its own', () => {
    // Drives the rail badges, the Lite landing queue and the dashboard tile —
    // if DISPATCHING crept in here, every cascading booking would read as
    // blocked and the badge would never clear.
    expect([...BOOKING_NEEDS_OPS].sort()).toEqual(
      ['AGENCY_NO_SHOW', 'NO_PROVIDER', 'PENDING_OPS'],
    );
  });

  it('every entry is a real booking status', () => {
    for (const s of BOOKING_NEEDS_OPS) expect(SERVER_BOOKING).toContain(s);
  });
});

describe('pillClass', () => {
  it('maps tones onto the globals.css pill classes', () => {
    expect(pillClass('ok')).toBe('pill pill-ok');
    expect(pillClass('muted')).toBe('pill');
  });
});
