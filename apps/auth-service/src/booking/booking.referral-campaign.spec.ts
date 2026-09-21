/**
 * Referral / discount campaigns (2026-09-05) — the BOOKING side.
 *
 * The campaign service decides; this pins what the booking does with the
 * decision, which is where the money actually moves:
 *  - the STORED total_eur is already net of the discount (every charge path
 *    reads it, so none of them needs to know a discount exists);
 *  - the campaign id / code / discount ride the insert on their own columns;
 *  - the ledger row is written AFTER the insert with the gross, and a ledger
 *    miss never fails the booking;
 *  - a non-campaign code still takes the Issue 28 partner path;
 *  - estimate() returns the discounted total plus what the code did.
 */
import {BookingService} from './booking.service';
import type {DatabaseService} from '../database/database.service';
import type {PricingService} from './pricing.service';
import type {ConfigService} from '@nestjs/config';

function mk(opts: {
  campaigns?: {resolveForBooking?: jest.Mock; quote?: jest.Mock; recordRedemption?: jest.Mock; warnLedgerMiss?: jest.Mock};
  qOneRoutes?: Array<[RegExp, unknown]>;
  capture?: {insertParams?: unknown[]};
}) {
  const dbQOne = jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
    if (/INSERT INTO lite_bookings/.test(sql)) {
      if (opts.capture) {opts.capture.insertParams = params;}
      return Promise.resolve({
        id: 'bk1', client_id: 'c1', status: 'PENDING_OPS',
        region_code: 'AE', region_label: 'Dubai', service: 'secure_transfer',
        pickup_address: 'X', pickup_lat: 25, pickup_lng: 55, dropoff_address: null,
        dropoff_lat: null, dropoff_lng: null, pickup_time: new Date('2026-06-30T00:00:00Z'),
        passengers: 1, cpo_count: 1, vehicle_count: 1, driver_only: false, add_ons: [],
        total_eur: (params as unknown[])?.[20] ?? 100, duration_hours: 4, total_aed: 367, conversation_id: null,
        created_at: new Date('2026-06-22T00:00:00Z'),
        referral_campaign_code: (params as unknown[])?.[38] ?? null,
        referral_discount_eur: (params as unknown[])?.[39] ?? 0,
      });
    }
    if (/FROM wallet_balances/.test(sql)) return Promise.resolve({bravo_credits: 10_000});
    for (const [re, val] of opts.qOneRoutes ?? []) if (re.test(sql)) return Promise.resolve(val);
    return Promise.resolve(null);
  });
  const dbQ = jest.fn().mockResolvedValue([]);
  const db = {
    qOne: dbQOne, q: dbQ,
    withTransaction: (fn: (t: unknown) => unknown) => fn({q: dbQ, qOne: dbQOne}),
  } as unknown as DatabaseService;
  const pricing = {calculate: jest.fn().mockReturnValue({
    total_bc: 100, rate_eur_per_hour: 25, rate_aed_per_hour: 91, total_eur: 100, total_aed: 367,
    breakdown: [{label: 'Base', amount_eur: 25}],
  })} as unknown as PricingService;
  const config = {get: () => undefined} as unknown as ConfigService;
  const fsm = {assert: jest.fn()};
  const family = {resolvePayer: jest.fn().mockResolvedValue({payerId: 'c1', familyRowId: null, spendLimit: null, spent: 0})};
  const campaigns = opts.campaigns && {
    resolveForBooking: jest.fn().mockResolvedValue(null),
    quote: jest.fn().mockResolvedValue(null),
    recordRedemption: jest.fn().mockResolvedValue(undefined),
    warnLedgerMiss: jest.fn(),
    ...opts.campaigns,
  };
  const svc = new BookingService(
    db, pricing, fsm as never, {} as never, {} as never, {} as never, family as never, {} as never, config,
    undefined, undefined, campaigns as never,
  );
  return {svc, dbQOne, dbQ, campaigns};
}

const dto = (referral_code?: string) => ({
  type: 'transfer', region: 'AE', region_label: 'Dubai', service: 'secure_transfer',
  booking_mode: 'now', start_time: new Date(Date.now() + 4 * 3_600_000).toISOString(),
  pickup: {address: 'X', latitude: 25, longitude: 55}, add_ons: [],
  passengers: 1, cpo_count: 1, vehicle_count: 1, driver_only: false,
  payment_method: 'card', duration_hours: 4, referral_code,
}) as never;

const applied = {
  campaign: {id: 'camp-1', code: 'DXB20'}, applied: true, reason: null,
  discountEur: 20, discountBc: 20, label: '20% off',
};

describe('create — a campaign code discounts the STORED total', () => {
  it('stores total_eur net of the discount and binds the campaign columns', async () => {
    const capture: {insertParams?: unknown[]} = {};
    const resolveForBooking = jest.fn().mockResolvedValue(applied);
    const {svc, campaigns} = mk({campaigns: {resolveForBooking}, capture});
    const res = await svc.create('c1', dto('dxb20'));

    // Decided on the GROSS total, for THIS client, in the booking's dispatch zone.
    expect(resolveForBooking).toHaveBeenCalledWith(expect.objectContaining({
      code: 'dxb20', userId: 'c1', regionCode: 'AE', service: 'secure_transfer', grossEur: 100,
    }));
    const p = capture.insertParams!;
    expect(p[20]).toBe(80);                 // $21 total_eur — already discounted
    expect(p[37]).toBe('camp-1');           // $38 referral_campaign_id
    expect(p[38]).toBe('DXB20');            // $39 referral_campaign_code
    expect(p[39]).toBe(20);                 // $40 referral_discount_eur
    // The partner attribution columns stay empty: a campaign is not a partner code.
    expect(p[32]).toBeNull();
    expect(p[33]).toBeNull();
    // The client sees what the code did.
    expect(res.booking.referral_campaign_code).toBe('DXB20');
    expect(res.booking.referral_discount_eur).toBe(20);
    expect(res.booking.total_eur).toBe(80);
    // The ledger row: gross, discount, after the insert.
    expect(campaigns!.recordRedemption).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: 'camp-1', bookingId: 'bk1', userId: 'c1', regionCode: 'AE', grossEur: 100, discountEur: 20,
    }));
  });

  it('a ledger write failure is logged, never thrown', async () => {
    const {svc, campaigns} = mk({campaigns: {
      resolveForBooking: jest.fn().mockResolvedValue(applied),
      recordRedemption: jest.fn().mockRejectedValue(new Error('db down')),
    }});
    await expect(svc.create('c1', dto('dxb20'))).resolves.toBeTruthy();
    await new Promise(r => setImmediate(r));
    expect(campaigns!.warnLedgerMiss).toHaveBeenCalledWith('bk1', expect.any(Error));
  });

  it('a campaign code that does not apply REFUSES the create (never full price silently)', async () => {
    const {svc, dbQOne} = mk({campaigns: {
      resolveForBooking: jest.fn().mockRejectedValue(Object.assign(new Error('nope'), {response: {code: 'referral_campaign_expired'}})),
    }});
    await expect(svc.create('c1', dto('dxb20'))).rejects.toThrow('nope');
    expect(dbQOne.mock.calls.some(([sql]) => /INSERT INTO lite_bookings/.test(String(sql)))).toBe(false);
  });

  it('a non-campaign code still takes the Issue 28 partner path, at full price', async () => {
    const capture: {insertParams?: unknown[]} = {};
    const {svc} = mk({
      campaigns: {resolveForBooking: jest.fn().mockResolvedValue(null)},
      qOneRoutes: [[/FROM provider_referral_codes/, {id: 'ref-1', code: 'TRAVELCO-01'}]],
      capture,
    });
    await svc.create('c1', dto('travelco-01'));
    const p = capture.insertParams!;
    expect(p[20]).toBe(100);
    expect(p[32]).toBe('TRAVELCO-01');
    expect(p[33]).toBe('ref-1');
    expect(p[37]).toBeNull();
    expect(p[39]).toBe(0);
  });

  it('without the campaign service wired (legacy specs), a create is byte-for-byte the old shape', async () => {
    const capture: {insertParams?: unknown[]} = {};
    const {svc} = mk({capture});
    await svc.create('c1', dto());
    const p = capture.insertParams!;
    // B-854 added $41 `payer_via_user_id`, APPENDED so $1–$40 stay byte-for-byte.
    expect(p).toHaveLength(41);
    expect(p[20]).toBe(100);
    expect(p[37]).toBeNull();
    expect(p[38]).toBeNull();
    expect(p[39]).toBe(0);
    // A non-chained create must stamp NULL — the column is what every reader
    // (refunds, ops, history) uses to decide a booking is chained at all.
    expect(p[40]).toBeNull();
  });
});

describe('estimate — the quote shows the discount and why', () => {
  const est = (referral_code?: string) => ({
    type: 'transfer', region: 'AE', service: 'secure_transfer', add_ons: [], duration_hours: 4,
    cpo_count: 1, vehicle_count: 1, driver_only: false, passengers: 1, referral_code,
  }) as never;

  it('an applied campaign lowers total_bc and reports gross_bc + the label', async () => {
    const quote = jest.fn().mockResolvedValue(applied);
    const {svc} = mk({campaigns: {quote}});
    const res = await svc.estimate(est('dxb20'), 'c1');
    expect(quote).toHaveBeenCalledWith(expect.objectContaining({code: 'dxb20', userId: 'c1', regionCode: 'AE', grossEur: 100}));
    expect(res.total_bc).toBe(80);
    expect(res.total).toBe(80);
    expect(res.gross_bc).toBe(100);
    expect(res.referral).toEqual(expect.objectContaining({code: 'DXB20', kind: 'campaign', applied: true, label: '20% off', discount_bc: 20}));
  });

  it('a refused campaign keeps the gross and carries the reason + message', async () => {
    const {svc} = mk({campaigns: {quote: jest.fn().mockResolvedValue({
      ...applied, applied: false, reason: 'referral_campaign_region_mismatch', discountEur: 0, discountBc: 0,
      campaign: {id: 'camp-1', code: 'DXB20', region_code: 'AE'},
    })}});
    const res = await svc.estimate(est('dxb20'));
    expect(res.total_bc).toBe(100);
    expect(res.referral?.applied).toBe(false);
    expect(res.referral?.reason).toBe('referral_campaign_region_mismatch');
    expect(res.referral?.message).toMatch(/only valid in AE/);
  });

  it('a partner code is reported as attribution; an unknown code as unknown — neither discounts', async () => {
    const partner = mk({
      campaigns: {quote: jest.fn().mockResolvedValue(null)},
      qOneRoutes: [[/FROM provider_referral_codes/, {id: 'ref-1', code: 'TRAVELCO-01'}]],
    });
    const a = await partner.svc.estimate(est('travelco-01'));
    expect(a.total_bc).toBe(100);
    expect(a.referral).toEqual(expect.objectContaining({kind: 'attribution', applied: false, code: 'TRAVELCO-01'}));

    const unknown = mk({campaigns: {quote: jest.fn().mockResolvedValue(null)}});
    const u = await unknown.svc.estimate(est('zzz'));
    expect(u.referral).toEqual(expect.objectContaining({kind: 'unknown', applied: false, reason: 'referral_code_invalid'}));
  });

  it('no code → no referral field, and the legacy fields are untouched', async () => {
    const {svc} = mk({campaigns: {}});
    const res = await svc.estimate(est());
    expect(res.referral).toBeUndefined();
    expect(res.total_bc).toBe(100);
    expect(res.gross_bc).toBe(100);
  });
});
