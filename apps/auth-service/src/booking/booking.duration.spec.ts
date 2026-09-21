import {BadRequestException} from '@nestjs/common';
import {BookingService} from './booking.service';
import {DEFAULT_SERVICE_PRICING, PricingService, type ServicePricingConfig} from './pricing.service';
import type {DatabaseService} from '../database/database.service';
import type {ConfigService} from '@nestjs/config';

/**
 * 2026-09-04 — the customer picks how many hours an hourly service runs.
 *
 * Pins:
 *   - the 4-hour default is the ops-configurable `hourly_default_hours`, not a
 *     compiled literal; an absent duration takes it;
 *   - the SELECTED hours are what the REAL PricingService multiplies by, and
 *     what the INSERT stores ($20) — never the default when the client chose;
 *   - an out-of-range / non-integer duration is REJECTED (`invalid_duration`),
 *     never silently repriced;
 *   - estimate() applies the SAME rule (parity) and returns it for the picker;
 *   - Executive Protection keeps its fixed 3-hour-block rule, untouched.
 */
function mk(cfg: Partial<ServicePricingConfig> = {}) {
  const capture: {insertParams?: unknown[]} = {};
  const dbQOne = jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
    if (/INSERT INTO lite_bookings/.test(sql)) {
      capture.insertParams = params;
      return Promise.resolve({
        id: 'bk1', client_id: 'c1', status: 'PENDING_OPS',
        region_code: 'AE', region_label: 'Dubai', service: 'secure_transfer',
        pickup_address: 'X', pickup_lat: 25, pickup_lng: 55, dropoff_address: null,
        dropoff_lat: null, dropoff_lng: null, pickup_time: new Date(), passengers: 1,
        cpo_count: 1, vehicle_count: 1, driver_only: false, add_ons: [],
        total_eur: Number((params as unknown[])?.[20] ?? 0), duration_hours: (params as unknown[])?.[19],
        total_aed: 0, conversation_id: null, created_at: new Date(), updated_at: new Date(),
      });
    }
    if (/count\(\*\)::int AS n FROM lite_bookings/.test(sql)) return Promise.resolve({n: 0});
    if (/FROM wallet_balances/.test(sql)) return Promise.resolve({bravo_credits: 100_000});
    return Promise.resolve(null);
  });
  const db = {
    qOne: dbQOne, q: jest.fn().mockResolvedValue([]),
    withTransaction: (fn: (t: unknown) => unknown) => fn({q: jest.fn().mockResolvedValue([]), qOne: dbQOne}),
  } as unknown as DatabaseService;
  // The REAL calculator, with an injected board, so the total is rate × hours for real.
  const board: ServicePricingConfig = {...DEFAULT_SERVICE_PRICING, ...cfg};
  const pricing = new PricingService();
  (pricing as unknown as {config: () => Promise<ServicePricingConfig>}).config = async () => board;
  const family = {resolvePayer: jest.fn().mockResolvedValue({payerId: 'c1', familyRowId: null, spendLimit: null, spent: 0})};
  const svc = new BookingService(
    db, pricing, {assert: jest.fn()} as never, {} as never, {} as never,
    {} as never, family as never, {} as never, {get: () => undefined} as unknown as ConfigService,
  );
  return {svc, capture};
}

function dto(extra: Record<string, unknown> = {}) {
  return {
    type: 'transfer', region: 'AE', region_label: 'Dubai', service: 'secure_transfer',
    booking_mode: 'now', start_time: new Date(Date.now() + 6 * 3600_000).toISOString(),
    pickup: {address: 'X', latitude: 25.2, longitude: 55.3}, add_ons: [],
    passengers: 1, cpo_count: 1, vehicle_count: 1, driver_only: false,
    payment_method: 'card', location_consent: true, terms_accepted: true, ...extra,
  } as never;
}

/**
 * RE-POINTED 2026-09-14 (B-877), not weakened — every HOURLY assertion below
 * moved off `secure_transfer`, which is billed as a fixed per-region BLOCK from
 * 1.0.316, onto a service that still has an hourly stepper.
 *
 * Nothing about the hourly rule changes with it: Close Protection prices through
 * the SAME formula (`PricingService.calculate` branches only on
 * 'executive_protection', and its default arm is the transfer formula), so every
 * `86 × hours` number is byte-identical; and create()'s lead gate is skipped for
 * every non-EP on-demand auto request, exactly as it was for a transfer. The
 * transfer's own behaviour is pinned in the B-877 block at the bottom.
 */
const hourlyDto = (extra: Record<string, unknown> = {}) => dto({service: 'close_protection', ...extra});

// The 86 BC base rate at a non-peak hour (06:00Z = 10:00 Dubai) — the same number
// the real PricingService produces, so `rate × hours` below is a genuine check.
const OFF_PEAK = '2026-09-10T06:00:00.000Z';

describe('BookingService.create — configurable hourly duration (2026-09-04)', () => {
  it('an absent duration takes the ops default (4 h) — and prices exactly rate × 4', async () => {
    const {svc, capture} = mk();
    const res = await svc.create('c1', hourlyDto({start_time: OFF_PEAK, duration_hours: undefined}), {autoDispatch: true});
    expect(capture.insertParams?.[19]).toBe(4);
    expect(res.booking.duration_hours).toBe(4);
    expect(Number(capture.insertParams?.[20])).toBe(86 * 4);
  });

  it('the ops default is read from the board, never a compiled 4', async () => {
    const {svc, capture} = mk({hourly_default_hours: 6});
    await svc.create('c1', hourlyDto({start_time: OFF_PEAK, duration_hours: undefined}), {autoDispatch: true});
    expect(capture.insertParams?.[19]).toBe(6);
    expect(Number(capture.insertParams?.[20])).toBe(86 * 6);
  });

  it.each([6, 8, 12])('the SELECTED %d hours are priced and stored — total = rate × selected, never × default', async (hours) => {
    const {svc, capture} = mk();
    const res = await svc.create('c1', hourlyDto({start_time: OFF_PEAK, duration_hours: hours}), {autoDispatch: true});
    expect(capture.insertParams?.[19]).toBe(hours);
    expect(Number(capture.insertParams?.[20])).toBe(86 * hours);
    expect(res.booking.total_eur).toBe(86 * hours);
  });

  it('two bookings with different durations are priced independently', async () => {
    const {svc, capture} = mk();
    await svc.create('c1', hourlyDto({start_time: OFF_PEAK, duration_hours: 4}), {autoDispatch: true});
    const a = Number(capture.insertParams?.[20]);
    await svc.create('c1', hourlyDto({start_time: OFF_PEAK, duration_hours: 8}), {autoDispatch: true});
    const b = Number(capture.insertParams?.[20]);
    expect(a).toBe(86 * 4);
    expect(b).toBe(86 * 8);
  });

  it('rejects a duration outside the configured range (never silently reprices)', async () => {
    const {svc, capture} = mk({hourly_min_hours: 4, hourly_max_hours: 8});
    await expect(svc.create('c1', hourlyDto({duration_hours: 2}), {autoDispatch: true}))
      .rejects.toMatchObject({response: expect.objectContaining({code: 'invalid_duration', min_hours: 4, max_hours: 8, default_hours: 4})});
    await expect(svc.create('c1', hourlyDto({duration_hours: 9}), {autoDispatch: true}))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(capture.insertParams).toBeUndefined();
  });

  it('rejects a fractional duration', async () => {
    const {svc} = mk();
    await expect(svc.create('c1', hourlyDto({duration_hours: 4.5}), {autoDispatch: true}))
      .rejects.toMatchObject({response: expect.objectContaining({code: 'invalid_duration'})});
  });

  it('a contradictory board (min above max) falls back to the compiled range rather than blocking every booking', async () => {
    const {svc, capture} = mk({hourly_min_hours: 10, hourly_max_hours: 2});
    await svc.create('c1', hourlyDto({start_time: OFF_PEAK, duration_hours: 6}), {autoDispatch: true});
    expect(capture.insertParams?.[19]).toBe(6);
  });

  it('Executive Protection keeps its fixed 3-hour-block rule and ignores the hourly keys', async () => {
    const {svc} = mk({hourly_min_hours: 1, hourly_max_hours: 24});
    await expect(svc.create('c1', dto({service: 'executive_protection', duration_hours: 4, start_time: new Date(Date.now() + 48 * 3600_000).toISOString()}), {autoDispatch: true}))
      .rejects.toMatchObject({response: expect.objectContaining({code: 'exec_invalid_duration'})});
  });
});

describe('BookingService.estimate — duration parity with create', () => {
  it('quotes the selected hours and returns the rule for the picker', async () => {
    const {svc} = mk({hourly_default_hours: 4, hourly_min_hours: 2, hourly_max_hours: 10});
    const q = await svc.estimate({
      type: 'transfer', region: 'AE', service: 'close_protection', add_ons: [],
      cpo_count: 1, vehicle_count: 1, driver_only: false, passengers: 1,
      duration_hours: 8, pickup_time: OFF_PEAK,
    } as never);
    expect(q.duration_hours).toBe(8);
    expect(q.total).toBe(86 * 8);
    expect(q.duration_rule).toEqual({default: 4, min: 2, max: 10});
  });

  it('refuses to quote a duration create() would refuse (parity)', async () => {
    const {svc} = mk({hourly_min_hours: 4, hourly_max_hours: 8});
    await expect(svc.estimate({
      type: 'transfer', region: 'AE', service: 'close_protection', add_ons: [],
      cpo_count: 1, vehicle_count: 1, driver_only: false, passengers: 1, duration_hours: 2,
    } as never)).rejects.toMatchObject({response: expect.objectContaining({code: 'invalid_duration'})});
  });

  it('an absent duration quotes the same default create() would store', async () => {
    const {svc} = mk({hourly_default_hours: 6});
    const q = await svc.estimate({
      type: 'transfer', region: 'AE', service: 'close_protection', add_ons: [],
      cpo_count: 1, vehicle_count: 1, driver_only: false, passengers: 1, pickup_time: OFF_PEAK,
    } as never);
    expect(q.duration_hours).toBe(6);
    expect(q.total).toBe(86 * 6);
  });
});

/**
 * B-877 (2026-09-14) — a Secure Transfer is billed as a fixed BLOCK of hours
 * that ops set PER REGION; the client has no duration control for it.
 *
 * Founder, on the SERVICE DURATION card of a ten-minute transfer: "What is this
 * for? ... This card is not relative." Decision relayed 13:16: "Confirm we can
 * set the 4 hours per region" - "Yes".
 *
 * The compatibility rule these pins exist for: every app shipped before 1.0.316
 * ALWAYS sends `duration_hours` from its own stepper. The server must therefore
 * IGNORE that value for a transfer, never 400 it — a refusal would break the
 * whole transfer flow on every installed build the moment ops moved the block
 * off 4. Preview == charge survives because estimate() resolves through the same
 * function, so the total the client consented to was already the block's.
 */
describe('BookingService — Secure Transfer is billed as a per-region block (B-877)', () => {
  it('an old app sending 8 hours is priced and STORED with the block, not with 8', async () => {
    const {svc, capture} = mk();
    const res = await svc.create('c1', dto({start_time: OFF_PEAK, duration_hours: 8}), {autoDispatch: true});
    expect(capture.insertParams?.[19]).toBe(4);
    expect(Number(capture.insertParams?.[20])).toBe(86 * 4);
    expect(res.booking.duration_hours).toBe(4);
  });

  it('the block is READ FROM THE BOARD — a region set to 5 stores and charges 5', async () => {
    const {svc, capture} = mk({transfer_block_hours: 5});
    await svc.create('c1', dto({start_time: OFF_PEAK, duration_hours: 8}), {autoDispatch: true});
    expect(capture.insertParams?.[19]).toBe(5);
    expect(Number(capture.insertParams?.[20])).toBe(86 * 5);
  });

  it('an absent duration (a 1.0.316 app) stores the same block', async () => {
    const {svc, capture} = mk({transfer_block_hours: 6});
    await svc.create('c1', dto({start_time: OFF_PEAK, duration_hours: undefined}), {autoDispatch: true});
    expect(capture.insertParams?.[19]).toBe(6);
    expect(Number(capture.insertParams?.[20])).toBe(86 * 6);
  });

  it('NO transfer value is ever refused — not out of range, not fractional, not zero', async () => {
    for (const requested of [1, 2, 12, 24, 30, 0, -4, 4.5, null]) {
      const {svc, capture} = mk({transfer_block_hours: 4, hourly_min_hours: 4, hourly_max_hours: 8});
      await expect(
        svc.create('c1', dto({start_time: OFF_PEAK, duration_hours: requested}), {autoDispatch: true}),
      ).resolves.toBeDefined();
      expect(capture.insertParams?.[19]).toBe(4);
    }
  });

  it('a service-less booking is a transfer here too — calculate() has always priced it as one', async () => {
    const {svc, capture} = mk({transfer_block_hours: 5});
    await svc.create('c1', dto({start_time: OFF_PEAK, service: undefined, duration_hours: 9}), {autoDispatch: true});
    expect(capture.insertParams?.[19]).toBe(5);
    expect(Number(capture.insertParams?.[20])).toBe(86 * 5);
  });

  it('an hourly service still REFUSES an illegal duration — the block is not a blanket amnesty', async () => {
    const {svc} = mk({hourly_min_hours: 1, hourly_max_hours: 24});
    await expect(svc.create('c1', hourlyDto({start_time: OFF_PEAK, duration_hours: 30}), {autoDispatch: true}))
      .rejects.toMatchObject({response: expect.objectContaining({code: 'invalid_duration'})});
  });

  it('estimate() quotes the block and reports the collapsed rule, so preview == charge', async () => {
    const {svc} = mk({transfer_block_hours: 5, hourly_default_hours: 6, hourly_min_hours: 1, hourly_max_hours: 24});
    const q = await svc.estimate({
      type: 'transfer', region: 'AE', service: 'secure_transfer', add_ons: [],
      cpo_count: 1, vehicle_count: 1, driver_only: false, passengers: 1,
      duration_hours: 8, pickup_time: OFF_PEAK,
    } as never);
    expect(q.duration_hours).toBe(5);
    expect(q.total).toBe(86 * 5);
    expect(q.duration_rule).toEqual({default: 5, min: 5, max: 5});
  });

  it('the quote and the charge agree on the block for the SAME request (old app, 8 hours)', async () => {
    const {svc, capture} = mk({transfer_block_hours: 5});
    const q = await svc.estimate({
      type: 'transfer', region: 'AE', service: 'secure_transfer', add_ons: [],
      cpo_count: 1, vehicle_count: 1, driver_only: false, passengers: 1,
      duration_hours: 8, pickup_time: OFF_PEAK,
    } as never);
    await svc.create('c1', dto({start_time: OFF_PEAK, duration_hours: 8}), {autoDispatch: true});
    expect(Number(capture.insertParams?.[20])).toBe(q.total);
    expect(capture.insertParams?.[19]).toBe(q.duration_hours);
  });
});
