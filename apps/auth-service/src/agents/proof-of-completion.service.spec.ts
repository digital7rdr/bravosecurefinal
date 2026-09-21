import {ProofOfCompletionService} from './proof-of-completion.service';
import type {DatabaseService} from '../database/database.service';
import type {ConfigService} from '@nestjs/config';

const db = {qOne: jest.fn()};
function cfgWith(requireIdentity = false, requireMovement = false) {
  return {
    get: (k: string) => (({
      'dispatch.arrivalRadiusM': 150,
      'dispatch.minPings': 5,
      'dispatch.minOnTaskSeconds': 300,
      'dispatch.requireIdentityHandshake': requireIdentity,
      'dispatch.requireLiveMovement': requireMovement,
      'dispatch.minLiveMovementM': 25,
      'dispatch.epMinCheckins': 1,
    } as Record<string, number | boolean>)[k]),
  };
}

function svc(requireIdentity = false, requireMovement = false): ProofOfCompletionService {
  return new ProofOfCompletionService(db as unknown as DatabaseService, cfgWith(requireIdentity, requireMovement) as unknown as ConfigService);
}

interface Wire {
  mission?: {pickup_at: Date | null; live_at: Date | null; ended_at: Date | null; identity_verified_at?: Date | null} | null;
  booking?: {
    pickup_lat: string | null; pickup_lng: string | null;
    // E2E-02 — present only on the location-anchored cases; a transport booking leaves
    // them undefined and takes exactly the pre-existing path.
    service?: string | null; duration_hours?: number | null; transport_mode?: string | null;
    pickup_time?: Date | null;
  } | null;
  reached?: boolean;
  pings?: number;
  spread?: number;    // meters of LIVE bounding-box spread (FRAUD-1)
  checkins?: number;  // rows in mission_hourly_checkins (E2E-02)
}

function wire(w: Wire): void {
  db.qOne.mockImplementation((sql: string) => {
    if (/FROM missions WHERE id = \$1/.test(sql)) return Promise.resolve(w.mission ?? null);
    if (/pickup_lat, pickup_lng FROM lite_bookings/.test(sql)) return Promise.resolve(w.booking ?? null);
    if (/ST_DWithin/.test(sql)) return Promise.resolve({ok: w.reached ?? true});
    if (/ST_Distance/.test(sql)) return Promise.resolve({m: w.spread ?? 100});
    // MUST precede the generic count branch — both queries are `count(*)::text`.
    if (/mission_hourly_checkins/.test(sql)) return Promise.resolve({n: String(w.checkins ?? 0)});
    if (/count\(\*\)::text/.test(sql)) return Promise.resolve({n: String(w.pings ?? 10)});
    return Promise.resolve(null);
  });
}

const agoSec = (s: number): Date => new Date(Date.now() - s * 1000);
const COORDS = {pickup_lat: '25.20', pickup_lng: '55.27'};
/** A stationary Executive Protection block: right place, no displacement, no transfer leg. */
const EP = {
  ...COORDS, service: 'executive_protection', duration_hours: 6, transport_mode: null,
  pickup_time: agoSec(4 * 3600 + 60),
};

describe('ProofOfCompletionService', () => {
  beforeEach(() => jest.resetAllMocks());

  it('PASSES when progression + reached-pickup + coverage + on-task all hold', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null}, booking: COORDS, reached: true, pings: 10});
    expect(await svc().runProofGate('b1', 'm1')).toEqual({pass: true, reasons: []});
  });

  it('FAILS no_progression on a one-tap jump (no live_at)', async () => {
    wire({mission: {pickup_at: null, live_at: null, ended_at: null}, booking: COORDS, reached: true, pings: 10});
    const r = await svc().runProofGate('b1', 'm1');
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain('no_progression');
  });

  it('FAILS never_reached_pickup when no GPS fix is within the arrival radius', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null}, booking: COORDS, reached: false, pings: 10});
    expect((await svc().runProofGate('b1', 'm1')).reasons).toContain('never_reached_pickup');
  });

  it('FAILS insufficient_telemetry when too few pings during LIVE', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null}, booking: COORDS, reached: true, pings: 2});
    expect((await svc().runProofGate('b1', 'm1')).reasons).toContain('insufficient_telemetry');
  });

  it('FAILS too_short when LIVE duration is under the minimum', async () => {
    wire({mission: {pickup_at: agoSec(100), live_at: agoSec(60), ended_at: null}, booking: COORDS, reached: true, pings: 10});
    expect((await svc().runProofGate('b1', 'm1')).reasons).toContain('too_short');
  });

  it('FAILS no_pickup_coords when the booking has no pickup point', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null}, booking: {pickup_lat: null, pickup_lng: null}, reached: true, pings: 10});
    expect((await svc().runProofGate('b1', 'm1')).reasons).toContain('no_pickup_coords');
  });

  it('FAILS gracefully when the mission or booking is missing', async () => {
    wire({mission: null});
    expect(await svc().runProofGate('b1', 'm1')).toEqual({pass: false, reasons: ['mission_or_booking_missing']});
  });

  // FRAUD-2 / P0 — identity handshake (check 5).
  it('IGNORES identity when the handshake flag is off (default), even if unverified', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null, identity_verified_at: null}, booking: COORDS, reached: true, pings: 10});
    expect(await svc(false).runProofGate('b1', 'm1')).toEqual({pass: true, reasons: []});
  });

  it('FAILS identity_unverified when the handshake is required but the guard never verified', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null, identity_verified_at: null}, booking: COORDS, reached: true, pings: 10});
    const r = await svc(true).runProofGate('b1', 'm1');
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain('identity_unverified');
  });

  it('PASSES with the handshake required AND a server-verified identity present', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null, identity_verified_at: new Date()}, booking: COORDS, reached: true, pings: 10});
    expect(await svc(true).runProofGate('b1', 'm1')).toEqual({pass: true, reasons: []});
  });

  // FRAUD-1 — LIVE movement (check 4b).
  it('IGNORES movement when the flag is off (default), even with zero spread', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null}, booking: COORDS, reached: true, pings: 10, spread: 0});
    expect(await svc(false, false).runProofGate('b1', 'm1')).toEqual({pass: true, reasons: []});
  });

  it('FAILS no_live_movement when required and the LIVE fixes barely spread (fabricated at one point)', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null}, booking: COORDS, reached: true, pings: 10, spread: 2});
    const r = await svc(false, true).runProofGate('b1', 'm1');
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain('no_live_movement');
  });

  it('PASSES with movement required AND real spread present', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null}, booking: COORDS, reached: true, pings: 10, spread: 400});
    expect(await svc(false, true).runProofGate('b1', 'm1')).toEqual({pass: true, reasons: []});
  });

  it('FRAUD-1 boundary — spread EXACTLY at the threshold (25m) PASSES (check is `< min`, not `<=`)', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null}, booking: COORDS, reached: true, pings: 10, spread: 25});
    const r = await svc(false, true).runProofGate('b1', 'm1');
    expect(r.reasons).not.toContain('no_live_movement');
  });

  it('FRAUD-1 boundary — spread one metre under the threshold (24m) FAILS', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null}, booking: COORDS, reached: true, pings: 10, spread: 24});
    const r = await svc(false, true).runProofGate('b1', 'm1');
    expect(r.reasons).toContain('no_live_movement');
  });

  it('FRAUD-1 — no valid LIVE coords (ST_Distance null → 0 spread) FAILS as no movement', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null}, booking: COORDS, reached: true, pings: 10, spread: 0});
    const r = await svc(false, true).runProofGate('b1', 'm1');
    expect(r.reasons).toContain('no_live_movement');
  });
});

/**
 * E2E-02 — the gate was TRANSPORT-SHAPED: a stationary site/residential detail could
 * fail it (the service's own comment conceded "a truly stationary detail would trip
 * it"), and a FAIL sets review_required, which the release sweep then skips FOREVER —
 * the agency's money stranded with no console button to free it. For a location-anchored
 * detail the movement requirement is replaced by a PRESENCE requirement built from the
 * only progress record EP actually produces: the hourly check-in cadence.
 */
describe('ProofOfCompletionService — E2E-02 location-anchored (Executive Protection)', () => {
  beforeEach(() => jest.resetAllMocks());

  // 4 hours on task: enough contracted hours have elapsed for check-ins to be expected.
  const epLive = {pickup_at: agoSec(4 * 3600 + 60), live_at: agoSec(4 * 3600), ended_at: null};

  it('PASSES a STATIONARY EP block that has check-ins (zero displacement, movement required)', async () => {
    wire({mission: epLive, booking: EP, reached: true, pings: 10, spread: 0, checkins: 4});
    expect(await svc(false, true).runProofGate('b1', 'm1')).toEqual({pass: true, reasons: []});
  });

  it('FAILS the SAME block when nobody ever confirmed an hour', async () => {
    wire({mission: epLive, booking: EP, reached: true, pings: 10, spread: 400, checkins: 0});
    const r = await svc(false, true).runProofGate('b1', 'm1');
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain('no_presence_checkins');
  });

  it('replaces the movement check rather than adding to it — no_live_movement is never raised for EP', async () => {
    wire({mission: epLive, booking: EP, reached: true, pings: 10, spread: 0, checkins: 4});
    const r = await svc(false, true).runProofGate('b1', 'm1');
    expect(r.reasons).not.toContain('no_live_movement');
  });

  it('still requires PRESENCE at the service location (check 2 is untouched)', async () => {
    wire({mission: epLive, booking: EP, reached: false, pings: 10, checkins: 4});
    expect((await svc(false, true).runProofGate('b1', 'm1')).reasons).toContain('never_reached_pickup');
  });

  it('the identity handshake stays MANDATORY exactly where it is mandatory today', async () => {
    wire({
      mission: {...epLive, identity_verified_at: null},
      booking: EP, reached: true, pings: 10, spread: 0, checkins: 4,
    });
    const r = await svc(true, true).runProofGate('b1', 'm1');
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain('identity_unverified');
  });

  it('a block that ended inside its first hour is NOT failed for having no check-in', async () => {
    // Nothing had come due, so there is nothing the lead failed to confirm. Demanding one
    // here would strand the agency for a short block — the exact bug being fixed.
    // The CONTRACTED start is what decides "has an hour come due", so it moves with the
    // mission (P2-6): a 10-minute-old block, not a 4-hour-old one.
    wire({
      mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null},
      booking: {...EP, pickup_time: agoSec(700)},
      reached: true, pings: 10, spread: 0, checkins: 0,
    });
    const r = await svc(false, true).runProofGate('b1', 'm1');
    expect(r.reasons).not.toContain('no_presence_checkins');
    expect(r.pass).toBe(true);
  });

  it('applies to any location-anchored detail declaring no transfer leg', async () => {
    wire({
      mission: epLive,
      booking: {...COORDS, service: 'secure_transfer', duration_hours: 6, transport_mode: 'none'},
      reached: true, pings: 10, spread: 0, checkins: 0,
    });
    const r = await svc(false, true).runProofGate('b1', 'm1');
    expect(r.reasons).toContain('no_presence_checkins');
    expect(r.reasons).not.toContain('no_live_movement');
  });

  it('a TRANSPORT mission is unchanged — old thresholds, old reason ids, no check-in demand', async () => {
    wire({
      mission: epLive,
      booking: {...COORDS, service: 'secure_transfer', duration_hours: 6, transport_mode: 'one_way'},
      reached: true, pings: 10, spread: 2, checkins: 0,
    });
    const r = await svc(false, true).runProofGate('b1', 'm1');
    expect(r.reasons).toContain('no_live_movement');           // FRAUD-1 still bites
    expect(r.reasons).not.toContain('no_presence_checkins');   // and EP's rule does not
  });

  it('and a transport mission with real spread still passes with zero check-ins', async () => {
    wire({
      mission: epLive,
      booking: {...COORDS, service: 'secure_transfer', duration_hours: 6, transport_mode: 'one_way'},
      reached: true, pings: 10, spread: 400, checkins: 0,
    });
    expect(await svc(false, true).runProofGate('b1', 'm1')).toEqual({pass: true, reasons: []});
  });

  // ── P2-6: the gate must count due hours from the same anchor as the clock it audits ──

  it('P2-6 — a LATE go-live cannot skip the presence check by shrinking elapsed to zero', async () => {
    // Contracted 1 h block that started 70 minutes ago; the CPO went live 15 minutes ago.
    // Measured from live_at, elapsedHours floors to 0 and the whole check was SKIPPED —
    // a full paid block passed with zero check-ins, the gate silently disagreeing with
    // the check-in endpoint and the overdue sweep, both of which anchor on pickup_time.
    wire({
      mission: {pickup_at: agoSec(16 * 60), live_at: agoSec(15 * 60), ended_at: null},
      booking: {...EP, duration_hours: 1, pickup_time: agoSec(70 * 60)},
      reached: true, pings: 10, spread: 0, checkins: 0,
    });
    const r = await svc(false, true).runProofGate('b1', 'm1');
    expect(r.reasons).toContain('no_presence_checkins');
  });

  it('…and the same block PASSES once that hour was actually confirmed', async () => {
    wire({
      mission: {pickup_at: agoSec(16 * 60), live_at: agoSec(15 * 60), ended_at: null},
      booking: {...EP, duration_hours: 1, pickup_time: agoSec(70 * 60)},
      reached: true, pings: 10, spread: 0, checkins: 1,
    });
    expect((await svc(false, true).runProofGate('b1', 'm1')).pass).toBe(true);
  });

  it('an EARLY go-live is not punished — the contracted anchor cuts both ways', async () => {
    // Live for 3 h, but the contracted block only started 20 minutes ago: no hour has
    // come due yet, so no check-in is owed.
    wire({
      mission: epLive,
      booking: {...EP, pickup_time: agoSec(20 * 60)},
      reached: true, pings: 10, spread: 0, checkins: 0,
    });
    expect((await svc(false, true).runProofGate('b1', 'm1')).reasons)
      .not.toContain('no_presence_checkins');
  });

  // ── P2-7: classify by the transfer leg, not by the service label ──

  it('P2-7 — an EP booking WITH a real transport leg still owes MOVEMENT proof', async () => {
    // `service === 'executive_protection'` alone marked every EP booking stationary, so
    // an EP mission carrying a one_way leg escaped the movement check — and with P2-6
    // also escaped presence, leaving it with no proof at all.
    wire({
      mission: epLive,
      booking: {...EP, transport_mode: 'one_way'},
      reached: true, pings: 10, spread: 2, checkins: 4,
    });
    expect((await svc(false, true).runProofGate('b1', 'm1')).reasons).toContain('no_live_movement');
  });

  it('…and owes PRESENCE too — an EP block with a leg produces check-ins like any other', async () => {
    wire({
      mission: epLive,
      booking: {...EP, transport_mode: 'one_way'},
      reached: true, pings: 10, spread: 400, checkins: 0,
    });
    expect((await svc(false, true).runProofGate('b1', 'm1')).reasons).toContain('no_presence_checkins');
  });

  it('an EP block with a leg PASSES when it both moved and was attended', async () => {
    wire({
      mission: epLive,
      booking: {...EP, transport_mode: 'one_way'},
      reached: true, pings: 10, spread: 400, checkins: 4,
    });
    expect(await svc(false, true).runProofGate('b1', 'm1')).toEqual({pass: true, reasons: []});
  });

  it('a stationary EP block is still exempt from movement (the leg is what decides)', async () => {
    wire({mission: epLive, booking: {...EP, transport_mode: 'none'}, reached: true, pings: 10, spread: 0, checkins: 4});
    expect(await svc(false, true).runProofGate('b1', 'm1')).toEqual({pass: true, reasons: []});
  });
});
