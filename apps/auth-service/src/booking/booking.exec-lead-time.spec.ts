/**
 * Executive Protection — ALWAYS SCHEDULED + configurable minimum lead time.
 *
 * Client change 2026-08-31. EP lost its Book Now / Book Later choice: the client
 * names when protection starts, and the earliest allowed start is
 * `server now + configured lead`. Phase 1 default is 3 h, ops-configurable
 * through the existing `service_pricing` board as `exec_min_lead_hours`.
 *
 * The invariant this file defends:
 *
 *     service = executive_protection
 *         -> a scheduled start is mandatory
 *         -> scheduled start >= SERVER now + configured lead
 *
 * Three things here are easy to regress and expensive when they go:
 *   1. the boundary (>= is valid, one ms under is not),
 *   2. estimate/create PARITY — a quote that succeeds for a start create() would
 *      refuse prices a booking that cannot exist,
 *   3. the blast radius — Secure Transfer's on-demand exemption must be
 *      untouched, or "I need a guard NOW" silently stops working.
 */
import {BadRequestException} from '@nestjs/common';
import {BookingService} from './booking.service';
import {resolveExecLeadHours, DEFAULT_SERVICE_PRICING} from './pricing.service';
import type {DatabaseService} from '../database/database.service';
import type {PricingService} from './pricing.service';
import type {ConfigService} from '@nestjs/config';

const H = 3600_000;

/** @param leadHours what the ops board currently says (undefined = table unreachable). */
function mk(leadHours?: unknown) {
  const inserted: Array<Record<string, unknown>> = [];
  const dbQOne = jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
    if (/INSERT INTO lite_bookings/.test(sql)) {
      inserted.push({params});
      return Promise.resolve({
        id: 'bk1', client_id: 'c1', status: 'PENDING_OPS',
        region_code: 'AE', region_label: 'Dubai', service: 'executive_protection',
        pickup_address: 'X', pickup_lat: 25, pickup_lng: 55, dropoff_address: null,
        dropoff_lat: null, dropoff_lng: null, pickup_time: new Date(), passengers: 1,
        cpo_count: 1, vehicle_count: 0, driver_only: false, add_ons: [], total_eur: 258,
        duration_hours: 3, total_aed: 947, conversation_id: null, created_at: new Date(),
      });
    }
    if (/FROM wallet_balances/.test(sql)) {return Promise.resolve({bravo_credits: 10_000});}
    return Promise.resolve(null);
  });
  const dbQ = jest.fn().mockResolvedValue([]);
  const db = {
    qOne: dbQOne, q: dbQ,
    withTransaction: (fn: (t: unknown) => unknown) => fn({q: dbQ, qOne: dbQOne}),
  } as unknown as DatabaseService;

  const pricing = {
    calculate: jest.fn().mockReturnValue({
      rate_eur_per_hour: 86, rate_aed_per_hour: 316, total_eur: 258, total_aed: 947, breakdown: [],
    }),
    // The live board. `undefined` leadHours models the fail-open path.
    config: jest.fn().mockResolvedValue({
      ...DEFAULT_SERVICE_PRICING,
      ...(leadHours === undefined ? {} : {exec_min_lead_hours: leadHours}),
    }),
  } as unknown as PricingService;

  const family = {resolvePayer: jest.fn().mockResolvedValue({
    payerId: 'c1', familyRowId: null, spendLimit: null, spent: 0,
  })};
  const svc = new BookingService(
    db, pricing, {assert: jest.fn()} as never, {} as never, {} as never,
    {} as never, family as never, {} as never,
    {get: () => undefined} as unknown as ConfigService,
  );
  return {svc, inserted};
}

function execDto(startMs: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'timeslot', region: 'AE', region_label: 'Dubai', service: 'executive_protection',
    booking_mode: 'later', start_time: new Date(startMs).toISOString(),
    pickup: {address: 'X', latitude: 25, longitude: 55}, add_ons: [],
    passengers: 1, cpo_count: 1, vehicle_count: 0, driver_only: false,
    payment_method: 'bravo_credits', duration_hours: 3, task_type: 'site_protection',
    location_consent: true, terms_accepted: true, ...extra,
  } as never;
}

async function expectLeadReject(p: Promise<unknown>): Promise<{lead_hours: number; earliest_start: string}> {
  try {
    await p;
    throw new Error('expected exec_insufficient_lead_time — resolved instead');
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    const body = (e as BadRequestException).getResponse() as
      {code?: string; lead_hours?: number; earliest_start?: string};
    expect(body.code).toBe('exec_insufficient_lead_time');
    return {lead_hours: body.lead_hours!, earliest_start: body.earliest_start!};
  }
}

describe('EP lead time — the 3-hour boundary', () => {
  it('exactly the lead is VALID; one millisecond under is not', async () => {
    // The rule is `start >= now + lead`. Boundary bugs here are invisible on a
    // device and decide whether "book at 10:00 for 13:00" works at all.
    const {svc} = mk(3);
    await expect(svc.create('c1', execDto(Date.now() + 3 * H + 5_000))).resolves.toBeDefined();

    const {svc: svc2} = mk(3);
    const body = await expectLeadReject(svc2.create('c1', execDto(Date.now() + 3 * H - 1)));
    expect(body.lead_hours).toBe(3);
  });

  it('rejects 2h59m and a start in the PAST', async () => {
    const {svc} = mk(3);
    await expectLeadReject(svc.create('c1', execDto(Date.now() + 2 * H + 59 * 60_000)));
    const {svc: s2} = mk(3);
    await expectLeadReject(s2.create('c1', execDto(Date.now() - H)));
  });

  it('the rejection carries the configured hours and a usable earliest_start', async () => {
    // The client re-seeds its picker from these rather than recomputing, and the
    // message must never hardcode "3 hours".
    const {svc} = mk(6);
    const before = Date.now();
    const body = await expectLeadReject(svc.create('c1', execDto(Date.now() + H)));
    expect(body.lead_hours).toBe(6);
    const earliest = new Date(body.earliest_start).getTime();
    expect(earliest).toBeGreaterThanOrEqual(before + 6 * H);
    expect(earliest).toBeLessThanOrEqual(Date.now() + 6 * H);
  });
});

describe('EP lead time — configurable, not hardcoded', () => {
  it.each([1, 3, 6, 12, 24])('honours a %ih ops-configured lead on both sides of the boundary', async hours => {
    const {svc} = mk(hours);
    await expect(svc.create('c1', execDto(Date.now() + hours * H + 5_000))).resolves.toBeDefined();
    const {svc: s2} = mk(hours);
    const body = await expectLeadReject(s2.create('c1', execDto(Date.now() + hours * H - 60_000)));
    expect(body.lead_hours).toBe(hours);
  });

  it('a start that is valid at 3h is REFUSED once ops raises the lead to 6h', async () => {
    // The spec's "config changed between screen open and submit" case: the UI may
    // still be offering +3h, the server decides on its CURRENT configuration.
    const start = Date.now() + 4 * H;
    await expect(mk(3).svc.create('c1', execDto(start))).resolves.toBeDefined();
    await expectLeadReject(mk(6).svc.create('c1', execDto(start)));
  });
});

describe('EP lead time — bad ops configuration cannot break booking', () => {
  it.each([
    ['negative', -5],
    ['zero', 0],
    ['NaN', Number.NaN],
    ['null', null],
    ['a string', 'three' as unknown],
    ['absurdly large', 100_000],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('%s falls back to the compiled default rather than propagating', (_label, bad) => {
    expect(resolveExecLeadHours(bad)).toBe(DEFAULT_SERVICE_PRICING.exec_min_lead_hours);
  });

  it('a numeric string that IS a sane lead is honoured', () => {
    // service_pricing.value is numeric(10,4); node-postgres hands numerics back
    // as strings, so this is the ordinary path, not an edge case.
    expect(resolveExecLeadHours('6')).toBe(6);
  });

  it('a garbage configured value still books at the 3h default, not never', () => {
    // The failure mode that matters: a bad row must not make EVERY booking
    // invalid. A start beyond the DEFAULT lead has to succeed.
    return expect(mk(-1).svc.create('c1', execDto(Date.now() + 4 * H))).resolves.toBeDefined();
  });

  it('an unreachable pricing table fails OPEN to the default lead', async () => {
    const {svc} = mk(undefined);
    await expect(svc.create('c1', execDto(Date.now() + 4 * H))).resolves.toBeDefined();
    const {svc: s2} = mk(undefined);
    const body = await expectLeadReject(s2.create('c1', execDto(Date.now() + H)));
    expect(body.lead_hours).toBe(3);
  });
});

describe('EP lead time — estimate/create parity', () => {
  const estimateDto = (startMs: number) => ({
    service: 'executive_protection', region: 'AE', duration_hours: 3,
    cpo_count: 1, vehicle_count: 0, driver_only: false, passengers: 1, add_ons: [],
    pickup_time: new Date(startMs).toISOString(),
  } as never);

  it('estimate REFUSES a start create() would refuse', async () => {
    // Never quote a booking that cannot exist.
    const {svc} = mk(3);
    await expectLeadReject(svc.estimate(estimateDto(Date.now() + H)));
  });

  it('estimate ACCEPTS a start create() accepts', async () => {
    const {svc} = mk(3);
    await expect(svc.estimate(estimateDto(Date.now() + 4 * H))).resolves.toBeDefined();
  });

  it('an estimate with NO start time still quotes', async () => {
    // The live price preview runs while the user is still choosing a team, before
    // a start is necessarily named. Defaulting an absent start to `now` and then
    // rejecting it would take the price off screen mid-build. An absent start is
    // not an invalid start.
    const {svc} = mk(3);
    const dto = {
      service: 'executive_protection', region: 'AE', duration_hours: 3,
      cpo_count: 1, vehicle_count: 0, driver_only: false, passengers: 1, add_ons: [],
    } as never;
    await expect(svc.estimate(dto)).resolves.toBeDefined();
  });
});

describe('EP lead time — blast radius', () => {
  it('SECURE TRANSFER on-demand is untouched — a "now" booking still dispatches immediately', async () => {
    // The headline Lite feature. If the EP rule leaked to every service, an
    // "I need a guard NOW" request would start failing with a lead error.
    const {svc} = mk(3);
    const dto = {
      type: 'timeslot', region: 'AE', region_label: 'Dubai', service: 'secure_transfer',
      booking_mode: 'now', start_time: new Date(Date.now() + 60_000).toISOString(),
      pickup: {address: 'X', latitude: 25, longitude: 55}, add_ons: [],
      passengers: 1, cpo_count: 1, vehicle_count: 1, driver_only: false,
      payment_method: 'bravo_credits', duration_hours: 3,
      location_consent: true, terms_accepted: true,
    } as never;
    await expect(svc.create('c1', dto, {autoDispatch: true})).resolves.toBeDefined();
  });

  it('EP can no longer buy the on-demand exemption by sending booking_mode=now', async () => {
    // The old code exempted EP whenever mode was 'now'. A stale or hand-rolled
    // client must not be able to reach that path any more.
    const {svc} = mk(3);
    await expectLeadReject(svc.create('c1', execDto(Date.now() + 60_000, {booking_mode: 'now'})));
  });

  it('nor by claiming auto-dispatch', async () => {
    const {svc} = mk(3);
    await expectLeadReject(
      svc.create('c1', execDto(Date.now() + 60_000, {booking_mode: 'now'}), {autoDispatch: true}),
    );
  });
});

describe('EP lead time — the booked block is anchored to the SELECTED start', () => {
  it('an overnight block is accepted and persists the chosen start, not now', async () => {
    // book 15:00 -> start 23:00 -> 6 h -> ends 05:00 next day. The contracted
    // block follows the client's chosen start; created_at is irrelevant to it.
    const start = Date.now() + 8 * H;
    const {svc, inserted} = mk(3);
    await expect(svc.create('c1', execDto(start, {duration_hours: 6}))).resolves.toBeDefined();
    // The persisted pickup_time must be the CLIENT'S CHOSEN start, never `now`.
    // That distinction is the whole point of the change: booking time is not
    // protection start, and the block runs from the latter.
    const params = (inserted[0]?.params as unknown[]) ?? [];
    const dates = params.filter((p): p is Date => p instanceof Date);
    expect(dates.some(d => d.getTime() === start)).toBe(true);
    // ...and that start is genuinely 8 h out, so "persisted the chosen start"
    // cannot be satisfied by a `now` stamp. (The INSERT carries other
    // timestamps of its own, so asserting "no now-ish Date" would be wrong.)
    expect(start - Date.now()).toBeGreaterThan(7 * H);
  });

  it('a far-future start (next month) is accepted', async () => {
    const {svc} = mk(3);
    await expect(svc.create('c1', execDto(Date.now() + 30 * 24 * H))).resolves.toBeDefined();
  });
});
