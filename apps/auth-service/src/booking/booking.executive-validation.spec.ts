/**
 * E-7 (audit 2026-08-05) — the executive create()/estimate() VALIDATION layer had
 * zero coverage: pricing was pinned on both sides, but the reject-never-reprice
 * money guards (all eight `exec_*` codes) could regress silently. Every code is
 * exercised here, plus the two guards the same audit added (B-385 `unknown_add_on`,
 * E-14 `vehicle_capacity_insufficient`).
 */
import {BadRequestException} from '@nestjs/common';
import {BookingService} from './booking.service';
import type {DatabaseService} from '../database/database.service';
import type {PricingService} from './pricing.service';
import type {ConfigService} from '@nestjs/config';
import {TEAM_UNIT_MAX} from './dto/create-booking.dto';

const FLAT_PRICE = {
  rate_eur_per_hour: 86, rate_aed_per_hour: 316, total_eur: 258, total_aed: 947,
  breakdown: [],
};

/** B-876 — a pricing double that really scales with the team, so "5 CPOs are
 *  priced as 5" is an assertion about the MONEY, not just about an argument. */
const perCpoPrice = (args: {cpoCount: number; durationHours: number}) => ({
  rate_eur_per_hour: 86 * args.cpoCount,
  rate_aed_per_hour: 316 * args.cpoCount,
  total_eur: 86 * args.cpoCount * args.durationHours,
  total_aed: 316 * args.cpoCount * args.durationHours,
  breakdown: [],
});

function mk(
  addOnRows: Array<{id: string; label: string; price_eur_per_hour: string}> = [],
  pricingImpl?: (args: {cpoCount: number; durationHours: number}) => unknown,
) {
  const dbQOne = jest.fn().mockImplementation((sql: string) => {
    if (/INSERT INTO lite_bookings/.test(sql)) {
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
  const dbQ = jest.fn().mockImplementation((sql: string) => {
    if (/FROM lite_booking_add_ons/.test(sql)) {return Promise.resolve(addOnRows);}
    return Promise.resolve([]);
  });
  const db = {
    qOne: dbQOne, q: dbQ,
    withTransaction: (fn: (t: unknown) => unknown) => fn({q: dbQ, qOne: dbQOne}),
  } as unknown as DatabaseService;
  const calculate = pricingImpl
    ? jest.fn().mockImplementation(pricingImpl)
    : jest.fn().mockReturnValue(FLAT_PRICE);
  const pricing = {calculate} as unknown as PricingService;
  const family = {resolvePayer: jest.fn().mockResolvedValue({payerId: 'c1', familyRowId: null, spendLimit: null, spent: 0})};
  const svc = new BookingService(
    db, pricing, {assert: jest.fn()} as never, {} as never, {} as never,
    {} as never, family as never, {} as never, {get: () => undefined} as unknown as ConfigService,
  );
  return {svc, calculate, dbQOne};
}

/**
 * A start that CLEARS the lead gate.
 *
 * EP became always-scheduled on 2026-08-31 and lost its lead-time exemption, so
 * the old `now + 30 min` fixture is refused before any of the codes below are
 * reached. 4 h is comfortably past the 3 h default without being so far out that
 * a transport-window case stops making sense.
 */
export const VALID_START_MS = () => Date.now() + 4 * 3600_000;

function execDto(extra: Record<string, unknown> = {}) {
  return {
    type: 'timeslot', region: 'AE', region_label: 'Dubai', service: 'executive_protection',
    booking_mode: 'later', start_time: new Date(VALID_START_MS()).toISOString(),
    pickup: {address: 'X', latitude: 25, longitude: 55}, add_ons: [],
    passengers: 1, cpo_count: 1, vehicle_count: 0, driver_only: false,
    payment_method: 'bravo_credits', duration_hours: 3, task_type: 'site_protection',
    location_consent: true, terms_accepted: true, ...extra,
  } as never;
}

const transport = (over: Record<string, unknown> = {}) => ({
  mode: 'one_way',
  pickup: {address: 'A', latitude: 25.1, longitude: 55.1},
  dropoff: {address: 'B', latitude: 25.2, longitude: 55.2},
  ...over,
});

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
    throw new Error(`expected BadRequestException(${code}) — resolved instead`);
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    const body = (e as BadRequestException).getResponse() as {code?: string; message?: string};
    const got = typeof body === 'string' ? body : (body.code ?? body.message);
    expect(got).toBe(code);
  }
}

describe('executive create() — reject-never-reprice validation (E-7)', () => {
  it('exec_invalid_duration — off the 3..24 %3 grid', async () => {
    const {svc} = mk();
    await expectCode(svc.create('c1', execDto({duration_hours: 5})), 'exec_invalid_duration');
    await expectCode(svc.create('c1', execDto({duration_hours: 27})), 'exec_invalid_duration');
  });

  it('exec_invalid_task_type — unknown task', async () => {
    const {svc} = mk();
    await expectCode(svc.create('c1', execDto({task_type: 'yacht_party'})), 'exec_invalid_task_type');
  });

  it('exec_invalid_transport — malformed leg', async () => {
    const {svc} = mk();
    await expectCode(
      svc.create('c1', execDto({vehicle_count: 1, exec_transport: transport({mode: 'teleport'})})),
      'exec_invalid_transport');
    await expectCode(
      svc.create('c1', execDto({vehicle_count: 1, exec_transport: transport({pickup: {address: 'A'}})})),
      'exec_invalid_transport');
  });

  it('exec_transport_time_out_of_window — leg outside [start − 2h, start + block]', async () => {
    const {svc} = mk();
    const start = VALID_START_MS();
    await expectCode(
      svc.create('c1', execDto({
        vehicle_count: 1,
        exec_transport: transport({pickup_time: new Date(start - 3 * 3600_000).toISOString()}),
      })),
      'exec_transport_time_out_of_window');
    await expectCode(
      svc.create('c1', execDto({
        vehicle_count: 1, duration_hours: 3,
        exec_transport: transport({pickup_time: new Date(start + 4 * 3600_000).toISOString()}),
      })),
      'exec_transport_time_out_of_window');
  });

  it('exec_transport_required — vehicles or driver-only without a transfer leg', async () => {
    const {svc} = mk();
    await expectCode(svc.create('c1', execDto({vehicle_count: 1})), 'exec_transport_required');
    await expectCode(svc.create('c1', execDto({driver_only: true})), 'exec_transport_required');
  });

  it('exec_vehicle_required — a transfer leg with nothing to drive it', async () => {
    const {svc} = mk();
    await expectCode(
      svc.create('c1', execDto({vehicle_count: 0, exec_transport: transport()})),
      'exec_vehicle_required');
  });

  // B-864 (founder, 2026-09-12) — the client's own car no longer limits the
  // detail. This case USED to throw exec_cpo_seat_cap; the team the client
  // picked is now accepted and priced (the rate already rises per CPO).
  it('B-864 — a driver-only team bigger than the client car seats is ACCEPTED', async () => {
    const {svc} = mk();
    const res = await svc.create('c1', execDto({
      driver_only: true, passengers: 3, cpo_count: 2, exec_transport: transport(),
    }));
    expect(res.booking.id).toBe('bk1');
  });

  // B-876 (founder, 2026-09-14: "The limit is still here") — the ceiling moved
  // from 4 to TEAM_UNIT_MAX (50). This case used to send cpo_count: 5. What it
  // pins is UNCHANGED: exec REJECTS above the ceiling rather than quietly
  // repricing the team the client confirmed.
  it('exec_cpo_cap — above the MAX_CPOS ceiling is still REJECTED, never repriced', async () => {
    const {svc} = mk();
    await expectCode(
      svc.create('c1', execDto({
        driver_only: true, passengers: 1, cpo_count: TEAM_UNIT_MAX + 1, exec_transport: transport(),
      })),
      'exec_cpo_cap');
  });

  // B-876 — the other half of the same rule, and the one the founder actually
  // reported: a team of 5 is now simply ACCEPTED (it was a 400 before).
  it('B-876 — 5 CPOs are accepted and priced as 5, never clamped to 4', async () => {
    const {svc, calculate} = mk([], perCpoPrice);
    const res = await svc.create('c1', execDto({
      driver_only: true, passengers: 1, cpo_count: 5, exec_transport: transport(),
    }));
    expect(res.booking.id).toBe('bk1');
    expect(calculate).toHaveBeenCalledWith(
      expect.objectContaining({cpoCount: 5}), expect.anything());
    expect(calculate.mock.results[0].value.total_eur).toBe(86 * 5 * 3);
  });

  // B-876 — the executive VEHICLE clamp was a second hard-coded 4
  // (`Math.min(dto.vehicle_count ?? 0, 4)` in create() AND estimate()). It was
  // unreachable while the DTO also stopped at 4; raising the DTO to
  // TEAM_UNIT_MAX without raising it too would have turned it into a SILENT
  // REPRICE — the one thing the whole exec path refuses to do. Pinned on the
  // PERSISTED value: $15 is vehicle_count in the lite_bookings INSERT (15th
  // bound param, 0-indexed 14).
  it('B-876 — an exec booking with 6 vehicles persists 6, not a clamped 4', async () => {
    const {svc, calculate, dbQOne} = mk();
    const res = await svc.create('c1', execDto({
      vehicle_count: 6, passengers: 1, exec_transport: transport(),
    }));
    expect(res.booking.id).toBe('bk1');
    expect(calculate).toHaveBeenCalledWith(
      expect.objectContaining({vehicleCount: 6}), expect.anything());
    const insert = dbQOne.mock.calls.find(
      (c: unknown[]) => /INSERT INTO lite_bookings/.test(String(c[0])));
    expect(((insert as unknown[])[1] as unknown[])[14]).toBe(6);
  });

  it('exec_unknown_addon — outside the fixed executive catalogue', async () => {
    const {svc} = mk();
    await expectCode(svc.create('c1', execDto({add_ons: ['gold_plating']})), 'exec_unknown_addon');
  });

  it('a fully valid executive request passes validation and inserts', async () => {
    const {svc} = mk();
    const res = await svc.create('c1', execDto());
    expect(res.booking.id).toBe('bk1');
  });
});

describe('B-385 / E-14 — the same audit’s new Lite guards', () => {
  it('unknown_add_on — a Lite id the catalogue does not resolve is REJECTED (was silently dropped)', async () => {
    const {svc} = mk([]); // catalogue resolves nothing
    await expectCode(
      svc.create('c1', execDto({
        service: 'secure_transfer', vehicle_count: 1, add_ons: ['medical'],
        start_time: new Date(Date.now() + 4 * 3600_000).toISOString(), booking_mode: 'later',
      })),
      'unknown_add_on');
  });

  // B-876 — the Lite lane CLAMPED instead of rejecting (create() runs
  // Math.min(requested, MAX_CPOS) and only exec turns a changed team into a
  // 400). With the ceiling at 4 that silently quoted one team and dispatched
  // another; with TEAM_UNIT_MAX the requested team is what lands on the row.
  //
  // $14 is cpo_count in the lite_bookings INSERT (14th bound param, 0-indexed
  // 13) — see the column list in booking.service.create(). Asserted against the
  // PERSISTED value, not just the priced one: the row is what dispatch reads.
  it('B-876 — a Lite create with 6 CPOs persists 6, not a clamped 4', async () => {
    const {svc, calculate, dbQOne} = mk();
    const res = await svc.create('c1', execDto({
      service: 'secure_transfer', task_type: undefined, cpo_count: 6,
      passengers: 1, vehicle_count: 1, duration_hours: 3,
      start_time: new Date(Date.now() + 4 * 3600_000).toISOString(), booking_mode: 'later',
    }));
    expect(res.booking.id).toBe('bk1');
    expect(calculate).toHaveBeenCalledWith(
      expect.objectContaining({cpoCount: 6}), expect.anything());
    const insert = dbQOne.mock.calls.find(
      (c: unknown[]) => /INSERT INTO lite_bookings/.test(String(c[0])));
    expect(insert).toBeDefined();
    expect((insert as unknown[])[1]).toBeDefined();
    expect(((insert as unknown[])[1] as unknown[])[13]).toBe(6);
  });

  it('vehicle_capacity_insufficient — passengers that cannot board the vehicles', async () => {
    const {svc} = mk();
    await expectCode(
      svc.create('c1', execDto({
        service: 'secure_transfer', passengers: 7, vehicle_count: 2, cpo_count: 1,
        start_time: new Date(Date.now() + 4 * 3600_000).toISOString(), booking_mode: 'later',
      })),
      'vehicle_capacity_insufficient');
  });
});

describe('E-9 — estimate() mirrors create()’s reject rules', () => {
  // B-864 — the seat rule is gone, so this quote is legitimate now. What the
  // estimate must still refuse is a team create() would refuse: above MAX_CPOS.
  it('B-864 — exec estimate QUOTES a driver-only team past the car seats', async () => {
    const {svc} = mk();
    await expect(svc.estimate({
      type: 'timeslot', region: 'AE', service: 'executive_protection', add_ons: [],
      duration_hours: 3, driver_only: true, passengers: 3, cpo_count: 2,
    } as never)).resolves.toBeDefined();
  });

  it('exec estimate REJECTS above the ceiling instead of silently clamping the quote', async () => {
    const {svc} = mk();
    await expectCode(
      svc.estimate({
        type: 'timeslot', region: 'AE', service: 'executive_protection', add_ons: [],
        duration_hours: 3, driver_only: true, passengers: 1, cpo_count: TEAM_UNIT_MAX + 1,
      } as never),
      'exec_cpo_cap');
  });

  // B-876 — the estimate must QUOTE the team create() will charge. A clamp here
  // (the old min(cpo, 4)) quoted 4 CPOs for a booking that would be created with
  // 5 — preview != charge, which is the exact divergence E-9 exists to prevent.
  it('B-876 — exec estimate prices 5 CPOs as 5 (5 x rate), never clamped', async () => {
    const {svc, calculate} = mk([], perCpoPrice);
    const quote = await svc.estimate({
      type: 'timeslot', region: 'AE', service: 'executive_protection', add_ons: [],
      duration_hours: 3, driver_only: true, passengers: 1, cpo_count: 5,
    } as never);
    expect(calculate).toHaveBeenCalledWith(
      expect.objectContaining({cpoCount: 5}), expect.anything());
    // `total` IS `price.total_eur` (E2E-29 comment in estimate()).
    expect(quote.total).toBe(86 * 5 * 3);
  });

  // B-876 — and the estimate must quote the same 6 (preview == charge, E-9).
  it('B-876 — the exec estimate quotes 6 vehicles, not a clamped 4', async () => {
    const {svc, calculate} = mk();
    await svc.estimate({
      type: 'timeslot', region: 'AE', service: 'executive_protection', add_ons: [],
      duration_hours: 3, vehicle_count: 6, passengers: 1,
      exec_transport: {mode: 'one_way'},
    } as never);
    expect(calculate).toHaveBeenCalledWith(
      expect.objectContaining({vehicleCount: 6}), expect.anything());
  });

  it('Lite estimate rejects an unboardable passenger/vehicle combination', async () => {
    const {svc} = mk();
    await expectCode(
      svc.estimate({
        type: 'timeslot', region: 'AE', add_ons: [],
        passengers: 7, vehicle_count: 2, cpo_count: 1,
      } as never),
      'vehicle_capacity_insufficient');
  });
});
