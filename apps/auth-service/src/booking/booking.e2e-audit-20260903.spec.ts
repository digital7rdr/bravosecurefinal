import {BadRequestException} from '@nestjs/common';
import {BookingService, ONE_ACTIVE_BOOKING_INDEX} from './booking.service';
import {PricingService, DEFAULT_SERVICE_PRICING} from './pricing.service';
import {setLiveRegions, regionFromPoint, DEFAULT_REGIONS, type RegionDef} from '../common/regions';
import type {DatabaseService} from '../database/database.service';
import type {WalletService} from '../wallet/wallet.service';
import type {ConfigService} from '@nestjs/config';

/**
 * SECURE_SERVICES_E2E_AUDIT_2026-09-03 — the booking-lane fixes.
 *
 *   E2E-23  POST /bookings had no DB-level one-active guard; the read-then-throw
 *           is a TOCTOU. A partial unique index now enforces it and its 23505 has
 *           to surface as the SAME `active_booking_exists` error.
 *   E2E-29  the estimate returned EUR that every client treats as Bravo Credits.
 *   E2E-31  the region CHIP and the pickup POINT were never cross-checked, so a
 *           mismatch priced one region and dispatched into another.
 *   E2E-47  the estimate did not mirror create()'s two exec transfer-leg rules.
 *   E2E-12  a scheduled booking could be cancelled for free at any lead distance.
 */

// ─── harness ────────────────────────────────────────────────────────────────

interface CreateOpts {
  /** Make the INSERT throw this error instead of returning a row. */
  insertThrows?: unknown;
  /** Row returned by the read-path one-active guard (and by the 23505 re-read). */
  activeRow?: {id: string; status: string} | null;
}

function mkCreate(opts: CreateOpts = {}) {
  const capture: {insertParams?: unknown[]} = {};
  const dbQOne = jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
    if (/INSERT INTO lite_bookings/.test(sql)) {
      if (opts.insertThrows) {return Promise.reject(opts.insertThrows);}
      capture.insertParams = params;
      return Promise.resolve({
        id: 'bk1', client_id: 'c1', status: 'PENDING_OPS',
        region_code: (params as unknown[])?.[1] ?? 'AE', region_label: 'Dubai', service: 'secure_transfer',
        pickup_address: 'X', pickup_lat: 25, pickup_lng: 55, dropoff_address: null,
        dropoff_lat: null, dropoff_lng: null, pickup_time: new Date('2026-06-30T00:00:00Z'),
        passengers: 1, cpo_count: 1, vehicle_count: 1, driver_only: false, add_ons: [],
        total_eur: 100, duration_hours: 4, total_aed: 367, conversation_id: null,
        created_at: new Date('2026-06-22T00:00:00Z'),
      });
    }
    // Both the read-path guard and the 23505 re-read use this shape.
    if (/SELECT id, status FROM lite_bookings/.test(sql)) {
      return Promise.resolve(opts.activeRow ?? null);
    }
    return Promise.resolve(null);
  });
  const db = {
    qOne: dbQOne, q: jest.fn().mockResolvedValue([]),
    withTransaction: (fn: (t: unknown) => unknown) => fn({q: jest.fn().mockResolvedValue([]), qOne: dbQOne}),
  } as unknown as DatabaseService;
  const pricing = {calculate: jest.fn().mockReturnValue({
    rate_eur_per_hour: 25, rate_aed_per_hour: 91, total_eur: 100, total_aed: 367, total_bc: 100, breakdown: [],
  })} as unknown as PricingService;
  const config = {get: () => undefined} as unknown as ConfigService;
  const svc = new BookingService(
    db, pricing, {assert: jest.fn()} as never, {} as never, {} as never,
    {} as never, selfPayerFamily() as never, {} as never, config,
  );
  return {svc, capture, dbQOne};
}

/**
 * B-843 (A1) — `create()` resolves the payer on EVERY path now (it used to run
 * only inside `if (auto)`), because the legacy path stamps `payer_user_id` too
 * and a client-supplied id must never reach that column unresolved. These
 * fixtures are all non-family clients, so the payer is the caller.
 */
function selfPayerFamily() {
  return {
    resolvePayer: jest.fn(async (uid: string) => ({
      payerId: uid, familyRowId: null, spendLimit: null, spent: 0,
      holderSuspended: false, holderId: null, holderName: null,
    })),
    payerOptions: jest.fn().mockResolvedValue([]),
  };
}

function dto(extra: Record<string, unknown> = {}) {
  return {
    type: 'transfer', region: 'AE', region_label: 'Dubai', service: 'secure_transfer',
    booking_mode: 'now', start_time: new Date(Date.now() + 4 * 3_600_000).toISOString(),
    pickup: {address: 'X', latitude: 25, longitude: 55}, add_ons: [],
    passengers: 1, cpo_count: 1, vehicle_count: 1, driver_only: false,
    payment_method: 'card', duration_hours: 4, ...extra,
  } as never;
}

/** A REAL PricingService (no db) so the estimate's numbers are the charge path's. */
function mkEstimate() {
  const db = {qOne: jest.fn().mockResolvedValue(null), q: jest.fn().mockResolvedValue([])} as unknown as DatabaseService;
  const config = {get: () => undefined} as unknown as ConfigService;
  const svc = new BookingService(
    db, new PricingService(), {assert: jest.fn()} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, config,
  );
  return svc;
}

function estimateDto(extra: Record<string, unknown> = {}) {
  return {
    type: 'timeslot', service: 'executive_protection', duration_hours: 3,
    add_ons: [], region: 'AE', cpo_count: 1, vehicle_count: 0,
    driver_only: false, passengers: 1, ...extra,
  } as never;
}

// ─── E2E-29 — the estimate must name Bravo Credits, not EUR ─────────────────

describe('E2E-29 — estimate returns total_bc alongside the (unchanged) EUR total', () => {
  it('adds total_bc computed by the SAME calculator the escrow charge uses', async () => {
    const svc = mkEstimate();
    // 1 CPO x 3 h at the shipped exec rate = 86 * 3 = 258.
    const res = await svc.estimate(estimateDto());
    expect(res.total).toBe(258);
    expect(res.total_bc).toBe(258);
    // The peg is 1.0 today, so nothing moves numerically — that is the point:
    // this removes the LATENT divergence, it does not change a price.
    expect(DEFAULT_SERVICE_PRICING.eur_per_bc).toBe(1.0);
  });

  it('keeps `total` as EUR for back-compat — it is NOT renamed or removed', async () => {
    const svc = mkEstimate();
    const res = await svc.estimate(estimateDto());
    expect(res).toEqual(expect.objectContaining({
      total: expect.any(Number),
      total_bc: expect.any(Number),
      breakdown: expect.any(Object),
      rate_per_hour: expect.any(Number),
      duration_hours: 3,
      total_aed: expect.any(Number),
    }));
  });

  it('total_bc is the round(total_eur / eur_per_bc) the charge path applies', async () => {
    const pricing = new PricingService();
    const svc = mkEstimate();
    const res = await svc.estimate(estimateDto({cpo_count: 2, duration_hours: 6}));
    const charge = pricing.calculate({
      cpoCount: 2, vehicleCount: 0, driverOnly: false, durationHours: 6,
      pickupTime: new Date(), addOns: [], regionCode: 'AE', service: 'executive_protection',
    });
    expect(res.total_bc).toBe(charge.total_bc);
    expect(res.total).toBe(charge.total_eur);
  });
});

// ─── E2E-47 — estimate/create parity on the exec transfer-leg rules ─────────

describe('E2E-47 — the estimate mirrors exec_transport_required / exec_vehicle_required', () => {
  it('OMITTED exec_transport quotes exactly as before (shipped clients send none)', async () => {
    const svc = mkEstimate();
    // vehicle_count 1 with NO declared transport — create() would reject this,
    // but a legacy caller cannot say whether it has a leg, and 400ing here would
    // take down the live price preview of every EP booking on installed builds.
    await expect(svc.estimate(estimateDto({vehicle_count: 1}))).resolves.toEqual(
      expect.objectContaining({total: expect.any(Number)}),
    );
  });

  it('exec_transport: null + vehicles ⇒ exec_transport_required (create()s rule)', async () => {
    const svc = mkEstimate();
    await expect(svc.estimate(estimateDto({vehicle_count: 1, exec_transport: null})))
      .rejects.toMatchObject({response: {code: 'exec_transport_required'}});
  });

  it('exec_transport: null + driver_only ⇒ exec_transport_required', async () => {
    const svc = mkEstimate();
    await expect(svc.estimate(estimateDto({vehicle_count: 0, driver_only: true, exec_transport: null})))
      .rejects.toMatchObject({response: {code: 'exec_transport_required'}});
  });

  it('a declared leg with nothing to drive it ⇒ exec_vehicle_required', async () => {
    const svc = mkEstimate();
    await expect(svc.estimate(estimateDto({
      vehicle_count: 0, driver_only: false,
      exec_transport: {mode: 'one_way', pickup: {latitude: 25, longitude: 55}, dropoff: {latitude: 25, longitude: 56}},
    }))).rejects.toMatchObject({response: {code: 'exec_vehicle_required'}});
  });

  it('a declared leg WITH a vehicle quotes normally', async () => {
    const svc = mkEstimate();
    const res = await svc.estimate(estimateDto({
      vehicle_count: 1,
      exec_transport: {mode: 'one_way', pickup: {latitude: 25, longitude: 55}, dropoff: {latitude: 25, longitude: 56}},
    }));
    // 1 CPO (86) + 1 vehicle (30) = 116/h x 3 h.
    expect(res.total).toBe(348);
  });

  it('neither rule fires on a NON-exec estimate', async () => {
    const svc = mkEstimate();
    await expect(svc.estimate(estimateDto({
      service: 'secure_transfer', duration_hours: 4, vehicle_count: 1, exec_transport: null,
    }))).resolves.toEqual(expect.objectContaining({total: expect.any(Number)}));
  });
});

// ─── E2E-31 — the region chip vs the pickup point ───────────────────────────

describe('E2E-31 — region chip / pickup point cross-check', () => {
  // The compiled DEFAULT_REGIONS carry NO bbox, so regionFromPoint answers null
  // for every point and the guard is inert. Publish boxes the way RegionsService
  // does to exercise it.
  const BOXED: RegionDef[] = [
    {code: 'AE', name: 'UAE', currency: 'AED', utcOffsetHours: 4, launched: true,
     bbox: {minLat: 22, maxLat: 27, minLng: 51, maxLng: 57}},
    {code: 'ZA', name: 'South Africa', currency: 'ZAR', utcOffsetHours: 2, launched: true,
     bbox: {minLat: -35, maxLat: -22, minLng: 16, maxLng: 33}},
  ];
  afterEach(() => setLiveRegions(null));

  it('FAIL-OPEN today: with no bbox published, a create is untouched', async () => {
    setLiveRegions(null);
    expect(DEFAULT_REGIONS.every(r => r.bbox === undefined)).toBe(true);
    const {svc, capture} = mkCreate();
    await svc.create('c1', dto({region: 'AE'}));
    expect(capture.insertParams?.[1]).toBe('AE');
  });

  it('refuses a ZA pin on an AE chip with a typed, renderable error and NO insert', async () => {
    setLiveRegions(BOXED);
    const {svc, capture} = mkCreate();
    // The refusal is B-788b's `pickup_outside_region` (merged 2026-09-04): the
    // decided rule is the STRICTER "outside the chip's own box", which subsumes
    // this case. The renderable half — `pickup_region`, so the client can say
    // "switch the zone to ZA" — is what E2E-31 contributes to it.
    await expect(svc.create('c1', dto({region: 'AE', pickup: {address: 'JHB', latitude: -26, longitude: 28}})))
      .rejects.toMatchObject({response: {
        code: 'pickup_outside_region', region_code: 'AE', pickup_region: 'ZA',
      }});
    // Refused BEFORE anything is persisted — the old behaviour priced ZA,
    // dispatched into AE and was guaranteed NO_PROVIDER.
    expect(capture.insertParams).toBeUndefined();
  });

  it('accepts a pin INSIDE the chip it was booked under', async () => {
    setLiveRegions(BOXED);
    const {svc, capture} = mkCreate();
    await svc.create('c1', dto({region: 'AE', pickup: {address: 'DXB', latitude: 25, longitude: 55}}));
    expect(capture.insertParams?.[1]).toBe('AE');
  });

  it('REFUSES a pin in no box at all (ocean / unmapped), naming no other zone', async () => {
    setLiveRegions(BOXED);
    const {svc, capture} = mkCreate();
    // Merge decision 2026-09-04 (audit §11.7): the E2E-31 formulation accepted
    // this — "an unresolvable point cannot contradict the chip". B-788b is the
    // founder rule and it is STRICTER: with the client's distance ring gone, a
    // pin outside the chosen zone's own box is undispatchable whatever else
    // does or does not contain it, so the server refuses it here. The body
    // still names no region — there is none to name.
    await expect(svc.create('c1', dto({region: 'AE', pickup: {address: 'mid-ocean', latitude: 0, longitude: 0}})))
      .rejects.toMatchObject({response: {code: 'pickup_outside_region', region_code: 'AE', pickup_region: null}});
    expect(capture.insertParams).toBeUndefined();
  });

  it('accepts when the CHIP has no bbox at all — nothing to check against', async () => {
    setLiveRegions([
      {code: 'AE', name: 'UAE', currency: 'AED', utcOffsetHours: 4, launched: true,
       bbox: {minLat: 22, maxLat: 27, minLng: 51, maxLng: 57}},
      {code: 'BD', name: 'Bangladesh', currency: 'BDT', utcOffsetHours: 6, launched: true},
    ]);
    const {svc, capture} = mkCreate();
    // A BD booking whose pin happens to sit inside the AE box: BD has no box, so
    // there is no evidence the chip is wrong. Fail open.
    await svc.create('c1', dto({region: 'BD', pickup: {address: 'x', latitude: 25, longitude: 55}}));
    expect(capture.insertParams?.[1]).toBe('BD');
  });

  // ── P1-5: ops-entered rectangles OVERLAP, and first-match-wins is not proof ──
  describe('overlapping bboxes must not produce a false refusal', () => {
    // `regionFromPoint` is FIRST-MATCH-WINS over axis-aligned rectangles, and
    // these are ops data. A plausible AE box and a plausible SA box share the
    // western Gulf, so a genuine Saudi booking near the coast resolves to
    // whichever region ops created first. Refusing on "regionFromPoint
    // disagrees" would have rejected a paying customer for a data-entry artefact
    // — and armed itself silently the day ops published the first bbox.
    //
    // The merged rule (2026-09-04) asks the only question that cannot be wrong
    // this way: is the point inside the CHOSEN zone's own box? A pin inside it
    // is accepted no matter how many other boxes also contain it. The overlap
    // still decides one thing — whether the refusal can NAME another zone —
    // and an ambiguous point names none rather than pointing at a country that
    // merely happens to be first in the list.
    const OVERLAP: RegionDef[] = [
      {code: 'AE', name: 'UAE', currency: 'AED', utcOffsetHours: 4, launched: true,
       bbox: {minLat: 22, maxLat: 27, minLng: 51, maxLng: 57}},
      {code: 'SA', name: 'Saudi Arabia', currency: 'SAR', utcOffsetHours: 3, launched: true,
       bbox: {minLat: 16, maxLat: 32, minLng: 34, maxLng: 56}},   // overlaps AE
    ];

    it('a genuine SA booking in the shared strip is ACCEPTED, not refused', async () => {
      setLiveRegions(OVERLAP);
      const {svc, capture} = mkCreate();
      // (25, 52) is inside BOTH boxes; regionFromPoint answers 'AE' (first match).
      expect(regionFromPoint(25, 52)).toBe('AE');
      await svc.create('c1', dto({region: 'SA', pickup: {address: 'Dammam', latitude: 25, longitude: 52}}));
      expect(capture.insertParams?.[1]).toBe('SA');
    });

    it('the mirror case — an AE booking in the same strip is also accepted', async () => {
      setLiveRegions(OVERLAP);
      const {svc, capture} = mkCreate();
      await svc.create('c1', dto({region: 'AE', pickup: {address: 'Abu Dhabi', latitude: 25, longitude: 52}}));
      expect(capture.insertParams?.[1]).toBe('AE');
    });

    it('an UNAMBIGUOUS mismatch is still refused (only one box contains the point)', async () => {
      setLiveRegions(OVERLAP);
      const {svc} = mkCreate();
      // (20, 40) is inside SA only, well outside AE.
      await expect(svc.create('c1', dto({region: 'AE', pickup: {address: 'Riyadh', latitude: 20, longitude: 40}})))
        .rejects.toMatchObject({response: {code: 'pickup_outside_region', pickup_region: 'SA'}});
    });
  });
});

// ─── E2E-23 — the DB one-active guard's 23505 ───────────────────────────────

describe('E2E-23 — the partial unique index surfaces as active_booking_exists', () => {
  it('translates the named 23505 into the same error the read-path guard throws', async () => {
    const {svc} = mkCreate({
      insertThrows: {code: '23505', constraint: ONE_ACTIVE_BOOKING_INDEX},
      activeRow: {id: 'winner-1', status: 'CONFIRMED'},
    });
    await expect(svc.create('c1', dto())).rejects.toMatchObject({response: {
      code: 'active_booking_exists', booking_id: 'winner-1', booking_status: 'CONFIRMED',
    }});
  });

  it('still answers active_booking_exists when the winner re-read fails', async () => {
    const {svc} = mkCreate({
      insertThrows: {code: '23505', constraint: ONE_ACTIVE_BOOKING_INDEX},
      activeRow: null,
    });
    await expect(svc.create('c1', dto())).rejects.toMatchObject({response: {
      code: 'active_booking_exists', booking_id: null,
    }});
  });

  it('does NOT swallow an unrelated 23505 — matching is by CONSTRAINT NAME, never bare code', async () => {
    // e.g. a future unique on the table, or the referral FK: reporting those as
    // "you already have an active booking" would hide a real bug.
    const {svc} = mkCreate({insertThrows: {code: '23505', constraint: 'some_other_uq'}});
    await expect(svc.create('c1', dto())).rejects.toMatchObject({constraint: 'some_other_uq'});
  });

  it('does NOT swallow a non-unique database error', async () => {
    const {svc} = mkCreate({insertThrows: {code: '23503', constraint: 'lite_bookings_referral_fk'}});
    await expect(svc.create('c1', dto())).rejects.toMatchObject({code: '23503'});
  });

  it('the read-path guard is unchanged and still fires first for a KEY-LESS (older app) client', async () => {
    // B-795 (merge 2026-09-04): a request with no Idempotency-Key is an app built
    // before multi-booking; it keeps the one-active rule it was built against.
    const {svc} = mkCreate({activeRow: {id: 'live-1', status: 'LIVE'}});
    await expect(svc.create('c1', dto(), {legacyClient: true})).rejects.toMatchObject({
      response: expect.objectContaining({code: 'active_booking_exists', booking_id: 'live-1'}),
    });
  });

  it('a KEYED client is not held to one booking by the read path — the partial index is its floor', async () => {
    // Several SCHEDULED bookings may be open at once; a second go-now booking is
    // refused by lite_bookings_one_active_per_client_uq (translated above), not here.
    const {svc} = mkCreate({activeRow: {id: 'live-1', status: 'LIVE'}});
    await expect(svc.create('c1', dto())).resolves.toBeDefined();
  });
});

// ─── E2E-12 — the scheduled late-cancel fee ─────────────────────────────────

describe('E2E-12 — a scheduled booking cancelled close to its contracted start pays the fee', () => {
  function mkCancel(row: Record<string, unknown>, cfg: Record<string, unknown> = {}) {
    const txQ = jest.fn().mockImplementation((sql: string) => {
      if (/UPDATE lite_bookings/.test(sql)) {return Promise.resolve([{id: 'b1'}]);}
      return Promise.resolve([]);
    });
    const txQOne = jest.fn().mockImplementation((sql: string) => {
      if (/SELECT status, payment_captured/.test(sql)) {return Promise.resolve(row);}
      if (/SELECT gross_credits FROM escrow_holds/.test(sql)) {return Promise.resolve({gross_credits: 800});}
      // NO crew committed — the branch that used to make the fee unreachable for EP.
      if (/SELECT id FROM missions WHERE booking_id = \$1 AND status <> 'ABORTED'/.test(sql)) {return Promise.resolve(null);}
      if (/SELECT region_code FROM lite_bookings/.test(sql)) {return Promise.resolve({region_code: 'AE'});}
      return Promise.resolve(null);
    });
    const tx = {q: txQ, qOne: txQOne};
    const db = {
      qOne: jest.fn().mockResolvedValue(null), q: jest.fn().mockResolvedValue([]),
      withTransaction: (fn: (t: unknown) => unknown) => fn(tx),
    } as unknown as DatabaseService;
    const wallet = {
      refundEscrowHold: jest.fn().mockResolvedValue({refunded: true, credits: 800}),
      settleEscrowSplit: jest.fn().mockResolvedValue({settled: true, toProvider: 200, toClient: 600}),
      refundForBooking: jest.fn().mockResolvedValue({refunded: true, credits: 0}),
    } as unknown as WalletService;
    const config = {get: (k: string) => cfg[k]} as unknown as ConfigService;
    const svc = new BookingService(
      db, new PricingService(undefined, undefined, config), {assert: jest.fn()} as never,
      {release: jest.fn()} as never, {release: jest.fn()} as never, wallet,
      {} as never, {} as never, config,
    );
    return {svc, wallet};
  }

  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);
  const agoHours = (h: number) => new Date(Date.now() - h * 3_600_000);
  /**
   * REALISTIC timestamps. The first cut of this suite used
   * `dispatch_settled_at: now` with `pickup_time: +20 min`, a combination the
   * same diff makes IMPOSSIBLE: with the EP lead window now 1440 min the agency
   * accepts ~24 h out, so `dispatch_settled_at` is ~24 h old by the time the
   * client is 20 minutes from the block. That fixture hid the fact that the
   * accept-anchored `cancel_window_expired` gate fired first and the fee below
   * was unreachable on the exact path it was written for.
   *
   * So: accepted 24 h ago, created 3 days ago — what an EP booking actually
   * looks like when a client changes their mind.
   */
  const CONFIRMED = {
    status: 'CONFIRMED', payment_captured: true, created_at: agoHours(72),
    dispatch_mode: 'auto', dispatch_settled_at: agoHours(24),
  };
  const FEE_25 = {'dispatch.cancelFeePct': 25, 'booking.lateCancelHours': 12};

  it('EP cancelled 20 min before the block pays cancel_fee_pct even with NO crew assigned', async () => {
    const {svc, wallet} = mkCancel(
      {...CONFIRMED, service: 'executive_protection', booking_mode: 'later', pickup_time: inHours(0.33)},
      FEE_25,
    );
    await svc.cancel('c1', 'b1');
    // The EXISTING split machinery, same basis/statuses/formula — no new money path.
    expect(wallet.settleEscrowSplit).toHaveBeenCalledWith(expect.anything(), 'b1', expect.objectContaining({
      toProvider: 200, toClient: 600, basis: 'partial', fromStatuses: ['HELD'], finalStatus: 'PARTIAL',
    }));
    expect(wallet.refundEscrowHold).not.toHaveBeenCalled();
  });

  it('EP cancelled 3 days out is still a FULL refund (outside the window)', async () => {
    const {svc, wallet} = mkCancel(
      {...CONFIRMED, service: 'executive_protection', booking_mode: 'later', pickup_time: inHours(72)},
      FEE_25,
    );
    await svc.cancel('c1', 'b1');
    expect(wallet.refundEscrowHold).toHaveBeenCalled();
    expect(wallet.settleEscrowSplit).not.toHaveBeenCalled();
  });

  it('SECURE TRANSFER ON-DEMAND IS UNTOUCHED — a `now` booking still needs committed crew', async () => {
    const {svc, wallet} = mkCancel(
      // Accepted 10 min ago, i.e. INSIDE the 1 h accept-anchored window so the
      // cancel is allowed at all — an on-demand booking never has a 24 h gap.
      {...CONFIRMED, dispatch_settled_at: agoHours(0.16),
       service: 'secure_transfer', booking_mode: 'now', pickup_time: inHours(0.1)},
      FEE_25,
    );
    await svc.cancel('c1', 'b1');
    expect(wallet.refundEscrowHold).toHaveBeenCalled();
    expect(wallet.settleEscrowSplit).not.toHaveBeenCalled();
  });

  // ── P1-4: the accept-anchored gate used to swallow this whole feature ──────
  it('a SCHEDULED booking is EXEMPT from the accept-anchored cancel window', async () => {
    // Accepted 24 h ago (the new EP lead), cancelled 20 min before the block.
    // Before the exemption this threw `cancel_window_expired` — the client was
    // locked out of their own booking for a day and the fee never ran.
    const {svc, wallet} = mkCancel(
      {...CONFIRMED, service: 'executive_protection', booking_mode: 'later', pickup_time: inHours(0.33)},
      FEE_25,
    );
    await expect(svc.cancel('c1', 'b1')).resolves.toMatchObject({status: 'CANCELLED'});
    expect(wallet.settleEscrowSplit).toHaveBeenCalled();
  });

  it('a SCHEDULED booking accepted long ago can still cancel FREE far from the block', async () => {
    const {svc, wallet} = mkCancel(
      {...CONFIRMED, service: 'executive_protection', booking_mode: 'later', pickup_time: inHours(48)},
      FEE_25,
    );
    await expect(svc.cancel('c1', 'b1')).resolves.toMatchObject({status: 'CANCELLED'});
    expect(wallet.refundEscrowHold).toHaveBeenCalled();
    expect(wallet.settleEscrowSplit).not.toHaveBeenCalled();
  });

  it('ON-DEMAND still REFUSES outside the accept-anchored window (byte-for-byte unchanged)', async () => {
    const {svc, wallet} = mkCancel(
      {...CONFIRMED, dispatch_settled_at: agoHours(2),
       service: 'secure_transfer', booking_mode: 'now', pickup_time: inHours(0.1)},
      FEE_25,
    );
    await expect(svc.cancel('c1', 'b1')).rejects.toMatchObject({response: {code: 'cancel_window_expired'}});
    expect(wallet.refundEscrowHold).not.toHaveBeenCalled();
    expect(wallet.settleEscrowSplit).not.toHaveBeenCalled();
  });

  it('a scheduled SECURE TRANSFER inside the window pays the fee too (booking_mode later)', async () => {
    const {svc, wallet} = mkCancel(
      {...CONFIRMED, service: 'secure_transfer', booking_mode: 'later', pickup_time: inHours(1)},
      FEE_25,
    );
    await svc.cancel('c1', 'b1');
    expect(wallet.settleEscrowSplit).toHaveBeenCalled();
  });

  it('lateCancelHours = 0 DISABLES the rule — the documented rollback', async () => {
    const {svc, wallet} = mkCancel(
      {...CONFIRMED, service: 'executive_protection', booking_mode: 'later', pickup_time: inHours(0.1)},
      {'dispatch.cancelFeePct': 25, 'booking.lateCancelHours': 0},
    );
    await svc.cancel('c1', 'b1');
    expect(wallet.refundEscrowHold).toHaveBeenCalled();
    expect(wallet.settleEscrowSplit).not.toHaveBeenCalled();
  });

  it('a PAST pickup_time counts as inside the window (never as "plenty of time left")', async () => {
    const {svc, wallet} = mkCancel(
      {...CONFIRMED, service: 'executive_protection', booking_mode: 'later', pickup_time: inHours(-2)},
      FEE_25,
    );
    await svc.cancel('c1', 'b1');
    expect(wallet.settleEscrowSplit).toHaveBeenCalled();
  });

  it('cancel_fee_pct = 0 still means a full refund, window or not', async () => {
    const {svc, wallet} = mkCancel(
      {...CONFIRMED, service: 'executive_protection', booking_mode: 'later', pickup_time: inHours(0.1)},
      {'dispatch.cancelFeePct': 0, 'booking.lateCancelHours': 12},
    );
    await svc.cancel('c1', 'b1');
    expect(wallet.refundEscrowHold).toHaveBeenCalled();
    expect(wallet.settleEscrowSplit).not.toHaveBeenCalled();
  });

  it('a NULL pickup_time cannot arm the fee (no anchor ⇒ no late-cancel)', async () => {
    const {svc, wallet} = mkCancel(
      {...CONFIRMED, service: 'executive_protection', booking_mode: 'later', pickup_time: null},
      FEE_25,
    );
    await svc.cancel('c1', 'b1');
    expect(wallet.refundEscrowHold).toHaveBeenCalled();
    expect(wallet.settleEscrowSplit).not.toHaveBeenCalled();
  });
});

// ─── E2E-06 — the client's dispute door after a lead-declared no-show ───────

describe('E2E-06 — openDispute accepts a no-show PARTIAL hold', () => {
  function mkDispute(hold: Record<string, unknown> | null, cfg: Record<string, unknown> = {}) {
    const txQ = jest.fn().mockResolvedValue([]);
    const txQOne = jest.fn().mockImplementation((sql: string) => {
      if (/FROM escrow_holds eh JOIN lite_bookings/.test(sql)) {return Promise.resolve(hold);}
      if (/UPDATE escrow_holds SET status = 'DISPUTED'/.test(sql)) {return Promise.resolve({id: 'eh1'});}
      if (/INSERT INTO booking_disputes/.test(sql)) {return Promise.resolve({id: 'd1'});}
      return Promise.resolve(null);
    });
    const db = {
      qOne: jest.fn().mockResolvedValue({provider_user_id: null}),
      q: jest.fn().mockResolvedValue([]),
      withTransaction: (fn: (t: unknown) => unknown) => fn({q: txQ, qOne: txQOne}),
    } as unknown as DatabaseService;
    const config = {get: (k: string) => cfg[k]} as unknown as ConfigService;
    const svc = new BookingService(
      db, new PricingService(), {assert: jest.fn()} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, config,
    );
    return {svc, txQOne};
  }
  const agoHours = (h: number) => new Date(Date.now() - h * 3_600_000);
  const CLAIM = {category: 'not_performed' as const, reason: 'I was there'};

  it('lets the client file a claim on a fresh no-show PARTIAL settlement', async () => {
    const {svc} = mkDispute({status: 'PARTIAL', client_id: 'c1', no_show_at: agoHours(2)});
    await expect(svc.openDispute('c1', 'b1', CLAIM)).resolves.toEqual({
      id: 'b1', status: 'DISPUTED', dispute_id: 'd1',
    });
  });

  it('does NOT touch the hold status — a PARTIAL hold is ALREADY settled', async () => {
    // Flipping it to DISPUTED would route ops to resolveDispute's
    // `fromStatuses:['DISPUTED']` settle branch and pay the split a SECOND time.
    const {svc, txQOne} = mkDispute({status: 'PARTIAL', client_id: 'c1', no_show_at: agoHours(2)});
    await svc.openDispute('c1', 'b1', CLAIM);
    const flips = txQOne.mock.calls.filter(c => /UPDATE escrow_holds SET status = 'DISPUTED'/.test(c[0] as string));
    expect(flips).toHaveLength(0);
  });

  it('refuses a no-show PARTIAL past the dispute window (agency money stops being contestable)', async () => {
    const {svc} = mkDispute(
      {status: 'PARTIAL', client_id: 'c1', no_show_at: agoHours(80)},
      {'dispatch.disputeWindowSeconds': 259_200}, // 72 h
    );
    await expect(svc.openDispute('c1', 'b1', CLAIM)).rejects.toThrow('dispute_not_allowed');
  });

  it('accepts one just INSIDE the window and refuses one just outside it', async () => {
    const cfg = {'dispatch.disputeWindowSeconds': 3_600}; // 1 h, to make the edge crisp
    const inside = mkDispute({status: 'PARTIAL', client_id: 'c1', no_show_at: agoHours(0.9)}, cfg);
    await expect(inside.svc.openDispute('c1', 'b1', CLAIM)).resolves.toBeTruthy();
    const outside = mkDispute({status: 'PARTIAL', client_id: 'c1', no_show_at: agoHours(1.1)}, cfg);
    await expect(outside.svc.openDispute('c1', 'b1', CLAIM)).rejects.toThrow('dispute_not_allowed');
  });

  it('refuses a PARTIAL that came from a CLIENT CANCELLATION (no no_show_at stamp)', async () => {
    // A cancel-fee split settles on the SAME basis, so `basis` cannot tell them
    // apart — only `no_show_at` can, and the client already consented to that one.
    const {svc} = mkDispute({status: 'PARTIAL', client_id: 'c1', no_show_at: null});
    await expect(svc.openDispute('c1', 'b1', CLAIM)).rejects.toThrow('dispute_not_allowed');
  });

  it.each(['HELD', 'RELEASED', 'REFUNDED'])(
    'still refuses a %s hold — this ADDS one state, it loosens nothing', async (status) => {
      const {svc} = mkDispute({status, client_id: 'c1', no_show_at: agoHours(1)});
      await expect(svc.openDispute('c1', 'b1', CLAIM)).rejects.toThrow('dispute_not_allowed');
    });

  it('still 404s a non-owner on a disputable no-show hold (ownership is checked first)', async () => {
    const {svc} = mkDispute({status: 'PARTIAL', client_id: 'OWNER', no_show_at: agoHours(1)});
    await expect(svc.openDispute('intruder', 'b1', CLAIM)).rejects.toThrow('Booking not found');
  });

  it('PENDING_RELEASE is unchanged: it still freezes the escrow with the conditional flip', async () => {
    const {svc, txQOne} = mkDispute({status: 'PENDING_RELEASE', client_id: 'c1', no_show_at: null});
    await expect(svc.openDispute('c1', 'b1', CLAIM)).resolves.toMatchObject({status: 'DISPUTED'});
    expect(txQOne).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE escrow_holds SET status = 'DISPUTED'[\s\S]*status = 'PENDING_RELEASE'/),
      ['b1'],
    );
  });
});

// ─── settlement-lane config keys are DECLARED (discoverable + overridable) ──

describe('the 2026-09-03 settlement/EP tunables are declared under `dispatch`', () => {
  it.each([
    ['clientNoShowGraceMinutes', 'DISPATCH_CLIENT_NO_SHOW_GRACE_MINUTES', 20],
    ['noShowFixMaxAgeMinutes', 'DISPATCH_NO_SHOW_FIX_MAX_AGE_MINUTES', 10],
    ['settleRetryGraceMinutes', 'DISPATCH_SETTLE_RETRY_GRACE_MINUTES', 10],
    ['settleMaxAttempts', 'DISPATCH_SETTLE_MAX_ATTEMPTS', 5],
    ['epBlockEndGraceMinutes', 'DISPATCH_EP_BLOCK_END_GRACE_MINUTES', 15],
    ['checkinOverdueGraceMinutes', 'DISPATCH_CHECKIN_OVERDUE_GRACE_MINUTES', 20],
    ['epMinCheckins', 'DISPATCH_EP_MIN_CHECKINS', 1],
  ] as const)('%s defaults to %s and reads %s', async (key, envVar, def) => {
    const load = async (): Promise<Record<string, unknown>> => {
      jest.resetModules();
      const mod = await import('../config/configuration');
      return mod.default().dispatch as unknown as Record<string, unknown>;
    };
    const prev = process.env[envVar];
    try {
      delete process.env[envVar];
      expect((await load())[key]).toBe(def);
      // …and an env override actually reaches it — the point of declaring them.
      process.env[envVar] = '77';
      expect((await load())[key]).toBe(77);
    } finally {
      if (prev === undefined) {delete process.env[envVar];} else {process.env[envVar] = prev;}
    }
  });
});
