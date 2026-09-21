import {BadRequestException} from '@nestjs/common';
import {BookingService} from './booking.service';
import type {DatabaseService} from '../database/database.service';
import type {PricingService} from './pricing.service';
import type {ConfigService} from '@nestjs/config';

/**
 * 2026-09-04 — a customer may hold SEVERAL bookings at once (today 17:00,
 * tomorrow 10:00, Friday…). The former "one mission at a time" guard (B-405 let
 * only PARKED future reservations through, and capped those at 3) is replaced
 * by a single cap on OPEN bookings. This suite pins:
 *   - a confirmed / live / searching booking no longer blocks a new one;
 *   - the cap counts every non-terminal row, and LB17's terminals never trap;
 *   - the cap is configurable, defaults to 5, and refuses the (cap+1)th.
 */
function mkCreate(openCount = 0, cap?: number, money: {balance?: number; committedEur?: number} = {}, legacyActive: {id: string; status: string} | null = null) {
  const capCalls: string[] = [];
  const dbQOne = jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
    if (/count\(\*\)::int AS n FROM lite_bookings/.test(sql)) {
      capCalls.push(sql);
      return Promise.resolve({n: openCount});
    }
    if (/INSERT INTO lite_bookings/.test(sql)) {
      return Promise.resolve({
        id: 'bk1', client_id: 'c1', status: (params as unknown[])?.[24] ?? 'PENDING_OPS',
        region_code: 'AE', region_label: 'Dubai', service: 'secure_transfer',
        pickup_address: 'X', pickup_lat: 25, pickup_lng: 55, dropoff_address: null,
        dropoff_lat: null, dropoff_lng: null, pickup_time: new Date(), passengers: 1,
        cpo_count: 1, vehicle_count: 1, driver_only: false, add_ons: [], total_eur: 100,
        duration_hours: 4, total_aed: 367, conversation_id: null, created_at: new Date(),
        updated_at: new Date(),
      });
    }
    if (/FROM wallet_balances/.test(sql)) return Promise.resolve({bravo_credits: money.balance ?? 10_000});
    if (/SUM\(total_eur\)/.test(sql)) return Promise.resolve({committed_eur: String(money.committedEur ?? 0)});
    if (/ORDER BY created_at DESC\s+LIMIT 1/.test(sql)) return Promise.resolve(legacyActive);
    return Promise.resolve(null);
  });
  const db = {
    qOne: dbQOne, q: jest.fn().mockResolvedValue([]),
    withTransaction: (fn: (t: unknown) => unknown) => fn({q: jest.fn().mockResolvedValue([]), qOne: dbQOne}),
  } as unknown as DatabaseService;
  const pricing = {calculate: jest.fn().mockReturnValue({
    rate_eur_per_hour: 25, rate_aed_per_hour: 91, total_eur: 100, total_aed: 367, total_bc: 100,
  })} as unknown as PricingService;
  const family = {resolvePayer: jest.fn().mockResolvedValue({payerId: 'c1', familyRowId: null, spendLimit: null, spent: 0})};
  const config = {get: (k: string) => (k === 'booking.maxOpenPerClient' ? cap : undefined)} as unknown as ConfigService;
  const svc = new BookingService(
    db, pricing, {assert: jest.fn()} as never, {} as never, {} as never,
    {} as never, family as never, {} as never, config,
  );
  return {svc, capCalls, dbQOne};
}

function nowDto(extra: Record<string, unknown> = {}) {
  return {
    type: 'transfer', region: 'AE', region_label: 'Dubai', service: 'secure_transfer',
    booking_mode: 'now', start_time: new Date(Date.now() + 30 * 60_000).toISOString(),
    pickup: {address: 'X', latitude: 25, longitude: 55}, add_ons: [],
    passengers: 1, cpo_count: 1, vehicle_count: 1, driver_only: false,
    payment_method: 'card', duration_hours: 4,
    location_consent: true, terms_accepted: true, ...extra,
  } as never;
}

describe('BookingService.create — multiple simultaneous bookings per customer (2026-09-04)', () => {
  it('a customer with an open booking (confirmed / live / searching) can still book another', async () => {
    // 3 open bookings — e.g. today CONFIRMED, tomorrow scheduled, Friday scheduled —
    // must NOT block a 4th. The old guard threw active_booking_exists here.
    const {svc, capCalls, dbQOne} = mkCreate(3);
    const res = await svc.create('c1', nowDto(), {autoDispatch: true});
    expect(res.booking.id).toBe('bk1');
    expect(capCalls).toHaveLength(1);
    // The former guard SELECT (one row, ORDER BY created_at DESC LIMIT 1) is gone.
    expect(dbQOne.mock.calls.some(c => /ORDER BY created_at DESC\s+LIMIT 1/.test(String(c[0])))).toBe(false);
  });

  it('the cap counts every NON-TERMINAL row and excludes the LB17 terminals (NO_PROVIDER / AGENCY_NO_SHOW)', async () => {
    const {svc, capCalls} = mkCreate(0);
    await svc.create('c1', nowDto(), {autoDispatch: true});
    expect(capCalls[0]).toMatch(/status NOT IN \('COMPLETED','CANCELLED','NO_PROVIDER','AGENCY_NO_SHOW'\)/);
    // No parked-reservation exemption any more: a scheduled booking is an open booking.
    expect(capCalls[0]).not.toMatch(/booking_mode = 'later'/);
  });

  it('refuses the (cap+1)th open booking with too_many_open_bookings, default cap 5', async () => {
    const {svc} = mkCreate(5);
    await expect(svc.create('c1', nowDto(), {autoDispatch: true}))
      .rejects.toMatchObject({
        response: expect.objectContaining({code: 'too_many_open_bookings', max_open: 5}),
      });
    await expect(svc.create('c1', nowDto(), {autoDispatch: true}))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('the cap is configurable (BOOKING_MAX_OPEN_PER_CLIENT)', async () => {
    const {svc} = mkCreate(2, 2);
    await expect(svc.create('c1', nowDto(), {autoDispatch: true}))
      .rejects.toMatchObject({response: expect.objectContaining({code: 'too_many_open_bookings', max_open: 2})});
    const {svc: roomy} = mkCreate(2, 10);
    await expect(roomy.create('c1', nowDto(), {autoDispatch: true})).resolves.toBeDefined();
  });

  it('applies to the legacy route and to scheduled ("later") bookings identically', async () => {
    const later = nowDto({booking_mode: 'later', start_time: new Date(Date.now() + 48 * 3600_000).toISOString()});
    const {svc, capCalls} = mkCreate(5);
    await expect(svc.create('c1', later)).rejects.toMatchObject({response: expect.objectContaining({code: 'too_many_open_bookings'})});
    expect(capCalls).toHaveLength(1);
  });

  it('never throws the retired active_booking_exists / too_many_scheduled_bookings codes', async () => {
    const {svc} = mkCreate(5);
    await expect(svc.create('c1', nowDto(), {autoDispatch: true})).rejects.not.toMatchObject({
      response: expect.objectContaining({code: 'active_booking_exists'}),
    });
    await expect(svc.create('c1', nowDto(), {autoDispatch: true})).rejects.not.toMatchObject({
      response: expect.objectContaining({code: 'too_many_scheduled_bookings'}),
    });
  });
});

describe('B-795 — the affordability check covers every uncharged booking of the payer', () => {
  // Each booking is charged at its OWN accept. With several open bookings on one
  // wallet, checking this booking's cost alone let three 100 BC bookings pass on
  // 150 BC — the second and third then died at accept with a payment-failed push.
  it('this booking alone fits, but with the other open bookings it does not → insufficient_credits with the full figure', async () => {
    const {svc} = mkCreate(2, undefined, {balance: 150, committedEur: 1_000});
    const err = await svc.create('c1', nowDto(), {autoDispatch: true}).then(() => null, (e: unknown) => e as {response: Record<string, unknown>});
    expect(err).not.toBeNull();
    expect(err!.response).toMatchObject({code: 'insufficient_credits', message: 'insufficient_credits', this_booking: 100, balance: 150});
    expect(Number(err!.response.committed)).toBeGreaterThan(0);
    expect(Number(err!.response.required)).toBeGreaterThan(100);
  });

  it('the committed figure counts the payer\'s PRE-CHARGE rows only — CONFIRMED/LIVE rows already hold escrow', async () => {
    const {svc, dbQOne} = mkCreate(2, undefined, {balance: 150, committedEur: 0});
    await expect(svc.create('c1', nowDto(), {autoDispatch: true})).resolves.toMatchObject({booking: {id: 'bk1'}});
    const sum = dbQOne.mock.calls.find(c => /SUM\(total_eur\)/.test(String(c[0])));
    expect(sum).toBeDefined();
    expect(String(sum![0])).toMatch(/status IN \('PENDING_OPS', 'OPS_APPROVED', 'PAYMENT_PENDING', 'DISPATCHING'\)/);
    expect(String(sum![0])).toMatch(/COALESCE\(payer_user_id, client_id\) = \$1/);
    expect(sum![1]).toEqual(['c1']);
  });
});

describe('B-795 — a key-less (old app) request keeps the one-active rule it was built against', () => {
  // The installed app has no per-booking UI and no double-submit key; before
  // this change its second tap got active_booking_exists (with the blocker's
  // id, which it navigates to). Removing the guard for it would have let a
  // laggy double-tap file up to five PENDING_OPS bookings.
  it('legacyClient + an open booking → active_booking_exists with the blocker', async () => {
    const {svc} = mkCreate(1, undefined, {}, {id: 'bk0', status: 'PENDING_OPS'});
    await expect(svc.create('c1', nowDto(), {legacyClient: true})).rejects.toMatchObject({
      response: expect.objectContaining({code: 'active_booking_exists', booking_id: 'bk0', booking_status: 'PENDING_OPS'}),
    });
  });

  it('legacyClient with nothing open books normally, and the old B-405 parked exemption is in the SQL', async () => {
    const {svc, dbQOne} = mkCreate(0, undefined, {}, null);
    await expect(svc.create('c1', nowDto(), {autoDispatch: true, legacyClient: true})).resolves.toMatchObject({booking: {id: 'bk1'}});
    const guard = dbQOne.mock.calls.find(c => /ORDER BY created_at DESC\s+LIMIT 1/.test(String(c[0])));
    expect(String(guard![0])).toMatch(/AND NOT \(booking_mode = 'later'/);
    expect(String(guard![0])).toMatch(/status = 'OPS_APPROVED' AND dispatch_mode = 'auto'/);
  });

  it('a KEYED client (the updated app) never runs the old guard', async () => {
    const {svc, dbQOne} = mkCreate(3, undefined, {}, {id: 'bk0', status: 'PENDING_OPS'});
    await expect(svc.create('c1', nowDto(), {autoDispatch: true})).resolves.toMatchObject({booking: {id: 'bk1'}});
    expect(dbQOne.mock.calls.some(c => /ORDER BY created_at DESC\s+LIMIT 1/.test(String(c[0])))).toBe(false);
  });
});
