/**
 * B-788b — a pickup outside the zone's own box is REFUSED, on create and on
 * estimate alike, and only when the region actually carries a box.
 *
 * Before: `regionFromPoint` returned null for such a pin, a null region priced on
 * the GLOBAL board, and the booking was accepted. The client's city ring made
 * that unreachable; with the ring gone (B-788, founder: no distance restriction)
 * the server has to say no itself. The fail-open half matters just as much: the
 * compiled fallback region set carries NO boxes, so if `public.regions` is
 * unreachable this check must not refuse every booking product-wide.
 *
 * Same harness discipline as booking.region.spec.ts — DatabaseService is mocked,
 * so the honest assertions are the exception thrown and whether an INSERT ran.
 */
import {BadRequestException} from '@nestjs/common';
import {BookingService} from './booking.service';
import {setLiveRegions} from '../common/regions';
import type {DatabaseService} from '../database/database.service';
import type {PricingService} from './pricing.service';
import type {ConfigService} from '@nestjs/config';

const ZA_WITH_BOX = [{
  code: 'ZA', name: 'South Africa — Johannesburg, Cape Town', currency: 'ZAR',
  utcOffsetHours: 2, launched: true,
  bbox: {minLat: -35.0, maxLat: -22.1, minLng: 16.4, maxLng: 33.0},
}];

const LANGEBAAN = {latitude: -33.09, longitude: 18.03}; // ~100 km from Cape Town, inside ZA
const HARARE = {latitude: -17.83, longitude: 31.05};    // outside the ZA box

function mk(capture: {insertParams?: unknown[]}) {
  const dbQOne = jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
    if (/INSERT INTO lite_bookings/.test(sql)) {
      capture.insertParams = params;
      return Promise.resolve({
        id: 'bk1', client_id: 'c1', status: 'PENDING_OPS',
        region_code: 'ZA', region_label: 'South Africa', service: 'secure_transfer',
        pickup_address: 'X', pickup_lat: -33.09, pickup_lng: 18.03, dropoff_address: null,
        dropoff_lat: null, dropoff_lng: null, pickup_time: new Date('2026-09-30T00:00:00Z'),
        passengers: 1, cpo_count: 1, vehicle_count: 1, driver_only: false, add_ons: [],
        total_eur: 100, duration_hours: 4, total_aed: 367, conversation_id: null,
        created_at: new Date('2026-09-22T00:00:00Z'),
      });
    }
    return Promise.resolve(null);
  });
  const db = {
    qOne: dbQOne, q: jest.fn().mockResolvedValue([]),
    withTransaction: (fn: (t: unknown) => unknown) => fn({q: jest.fn().mockResolvedValue([]), qOne: dbQOne}),
  } as unknown as DatabaseService;
  const pricing = {
    calculate: jest.fn().mockReturnValue({
      rate_eur_per_hour: 25, rate_aed_per_hour: 91, total_eur: 100, total_aed: 367, breakdown: [],
    }),
  } as unknown as PricingService;
  const config = {get: () => undefined} as unknown as ConfigService;
  const fsm = {assert: jest.fn()};
  // B-843 (A1) — the payer resolution moved ABOVE the `auto` gate, so a legacy
  // create needs it too. Identity payer: the client pays for themselves.
  const family = {
    resolvePayer: jest.fn(async (uid: string) => ({
      payerId: uid, familyRowId: null, spendLimit: null, spent: 0,
      holderSuspended: false, holderId: null, holderName: null,
    })),
    payerOptions: jest.fn().mockResolvedValue([]),
  };
  const svc = new BookingService(
    db, pricing, fsm as never, {} as never, {} as never, {} as never, family as never, {} as never, config,
  );
  return {svc};
}

function dto(extra: Record<string, unknown> = {}) {
  return {
    type: 'transfer', region: 'ZA', region_label: 'South Africa', service: 'secure_transfer',
    booking_mode: 'now', start_time: new Date(Date.now() + 4 * 3_600_000).toISOString(),
    pickup: {address: 'X', ...LANGEBAAN}, add_ons: [],
    passengers: 1, cpo_count: 1, vehicle_count: 1, driver_only: false,
    payment_method: 'card', duration_hours: 4, ...extra,
  } as never;
}

afterEach(() => setLiveRegions(null));

describe('create — pickup inside the zone box', () => {
  it('accepts a Western Cape pickup 100 km from the nearest hub', async () => {
    setLiveRegions(ZA_WITH_BOX);
    const cap: {insertParams?: unknown[]} = {};
    const {svc} = mk(cap);
    await expect(svc.create('c1', dto())).resolves.toBeDefined();
    expect(cap.insertParams).toBeDefined();
  });

  it('refuses a pickup outside the box with no INSERT', async () => {
    setLiveRegions(ZA_WITH_BOX);
    const cap: {insertParams?: unknown[]} = {};
    const {svc} = mk(cap);
    await expect(svc.create('c1', dto({pickup: {address: 'Harare', ...HARARE}})))
      .rejects.toMatchObject({response: {code: 'pickup_outside_region'}});
    expect(cap.insertParams).toBeUndefined();
  });

  it('the refusal is a 400, not a 500', async () => {
    setLiveRegions(ZA_WITH_BOX);
    const {svc} = mk({});
    await expect(svc.create('c1', dto({pickup: {address: 'Harare', ...HARARE}})))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('FAILS OPEN when the region carries no box (compiled fallback set)', async () => {
    // setLiveRegions(null) = the compiled seed, which has no boxes. A box is
    // data; no data must never refuse every booking in a region.
    setLiveRegions(null);
    const cap: {insertParams?: unknown[]} = {};
    const {svc} = mk(cap);
    await expect(svc.create('c1', dto({pickup: {address: 'Harare', ...HARARE}}))).resolves.toBeDefined();
    expect(cap.insertParams).toBeDefined();
  });

  it('a pickup with no coordinates is outside every box', async () => {
    setLiveRegions(ZA_WITH_BOX);
    const cap: {insertParams?: unknown[]} = {};
    const {svc} = mk(cap);
    await expect(svc.create('c1', dto({pickup: {address: 'nowhere'}})))
      .rejects.toMatchObject({response: {code: 'pickup_outside_region'}});
    expect(cap.insertParams).toBeUndefined();
  });
});

describe('estimate — parity with create', () => {
  it('refuses the same pickup create() refuses', async () => {
    setLiveRegions(ZA_WITH_BOX);
    const {svc} = mk({});
    await expect(svc.estimate({
      type: 'transfer', region: 'ZA', add_ons: [], duration_hours: 4,
      pickup: HARARE,
    } as never)).rejects.toMatchObject({response: {code: 'pickup_outside_region'}});
  });

  it('quotes the same pickup create() accepts', async () => {
    setLiveRegions(ZA_WITH_BOX);
    const {svc} = mk({});
    await expect(svc.estimate({
      type: 'transfer', region: 'ZA', add_ons: [], duration_hours: 4,
      pickup: LANGEBAAN,
    } as never)).resolves.toBeDefined();
  });
});

describe('the source says what the test says', () => {
  it('the create-time gate sits BEFORE pricing and fails open on null', () => {
    // A gate placed after the quote would let a refused booking be priced;
    // one that treated null as false would take a region down on a data gap.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require('fs').readFileSync(require('path').join(__dirname, 'booking.service.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const gate = src.indexOf("code: 'pickup_outside_region'");
    const price = src.indexOf('const pricingCfg = (await this.pricing.config?.(priceRegion))');
    expect(gate).toBeGreaterThan(-1);
    expect(price).toBeGreaterThan(gate);
    expect(src).toMatch(/isInsideRegionBox\(regionCode, dto\.pickup\?\.latitude, dto\.pickup\?\.longitude\) === false/);
  });
});
