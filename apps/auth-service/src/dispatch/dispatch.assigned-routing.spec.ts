/**
 * B-788a — Dispatch v2: assigned providers per area, no radius.
 *
 * Founder, 2026-09-03: "Bravo should route according to assigned province/region
 * and provider priority, not a 50 km GPS restriction. The service provider
 * decides whether the distance is operationally feasible."
 *
 * Same harness discipline as dispatch.service.spec.ts: DatabaseService is
 * mocked, so the honest assertions are WHICH query ran, in WHAT order, with
 * WHICH bind values, and what landed in the dispatch_offers INSERT. The three
 * candidate queries carry distinct markers so the wiring can tell them apart:
 *   RANKING_SQL   — today's ranker  ('ST_DWithin')
 *   ASSIGNED_SQL  — the priority ladder ('area_provider_assignments')
 *   FALLBACK_SQL  — the region-wide, radius-free rank ('regional-fallback')
 */
import {DispatchService} from './dispatch.service';
import {setLiveRegions} from '../common/regions';

const db = {qOne: jest.fn(), q: jest.fn(), withTransaction: jest.fn()};
const fsm = {assert: jest.fn()};
const audit = {record: jest.fn().mockResolvedValue(undefined)};
const push = {dispatchOffer: jest.fn().mockResolvedValue(undefined), noProvider: jest.fn().mockResolvedValue(undefined)};
// noProvider() refunds a RELISTED booking's hold in the same transaction (R12).
const wallet = {refundEscrowHold: jest.fn().mockResolvedValue(undefined)};

function service(): DispatchService {
  // Same five positional args dispatch.service.spec.ts passes. The optional
  // trailing services (metrics, killswitch, pricing…) stay undefined on
  // purpose: the service guards them with `?.`, and a `{}` stand-in would be a
  // truthy object with none of the methods.
  return new DispatchService(db as never, fsm as never, audit as never, push as never, wallet as never);
}

interface Wire {
  booking: {
    status: string; region_code: string; cpo_count: number; pickup_lat: string; pickup_lng: string;
    requirements: unknown; armed_required: boolean; booking_mode: string | null; area_id: string | null;
    pickup_time?: string | null;
  };
  areaLookup?: {id: string} | null;
  nearest?: Array<{user_id: string; distance_km: string} | null>;
  assigned?: Array<{user_id: string; distance_km: string | null; source: string} | null>;
  fallback?: Array<{user_id: string; distance_km: string} | null>;
}

function wire(w: Wire) {
  const calls: Array<{kind: string; sql: string; params: unknown[]}> = [];
  const inserts: unknown[][] = [];
  let ni = 0, ai = 0, fi = 0;
  db.qOne.mockReset(); db.q.mockReset(); db.withTransaction.mockReset();
  db.qOne.mockImplementation((sql: string, params: unknown[] = []) => {
    if (/SELECT status, region_code, cpo_count/.test(sql)) {
      calls.push({kind: 'ctx', sql, params});
      return Promise.resolve(w.booking);
    }
    if (/FROM public\.operational_areas/.test(sql)) {
      calls.push({kind: 'area', sql, params});
      return Promise.resolve(w.areaLookup ?? null);
    }
    if (/area_provider_assignments/.test(sql)) {
      calls.push({kind: 'assigned', sql, params});
      return Promise.resolve(w.assigned?.[ai++] ?? null);
    }
    if (/regional-fallback/.test(sql)) {
      calls.push({kind: 'fallback', sql, params});
      return Promise.resolve(w.fallback?.[fi++] ?? null);
    }
    if (/ST_DWithin/.test(sql)) {
      calls.push({kind: 'nearest', sql, params});
      return Promise.resolve(w.nearest?.[ni++] ?? null);
    }
    if (/count\(\*\)::text/.test(sql)) {return Promise.resolve({n: '0'});}
    // offerNext()'s pre-insert re-check of the booking state (still DISPATCHING?).
    if (/SELECT status FROM lite_bookings WHERE id = \$1 FOR UPDATE/.test(sql)) {
      return Promise.resolve({status: w.booking.status});
    }
    // noProvider()'s row lock — the exhaustion path reads status + client + region,
    // and (E2E-11) booking_mode / service / pickup_time so a SCHEDULED exhaustion
    // can page Sentry. Matched on the LEADING columns, never the whole list: a
    // widened SELECT must not silently make this mock return null (which reads as
    // "already settled" and skips the NO_PROVIDER flip entirely).
    if (/SELECT status, client_id, region_code[\s\S]*?FROM lite_bookings WHERE id = \$1 FOR UPDATE/.test(sql)) {
      return Promise.resolve({
        status: w.booking.status, client_id: 'c1', region_code: w.booking.region_code,
        booking_mode: w.booking.booking_mode, service: 'secure_transfer',
        pickup_time: w.booking.pickup_time ?? null,
      });
    }
    return Promise.resolve(null);
  });
  db.q.mockImplementation((sql: string, params: unknown[] = []) => {
    if (/INSERT INTO dispatch_offers/.test(sql)) {inserts.push(params); calls.push({kind: 'insert', sql, params});}
    if (/UPDATE lite_bookings SET status = 'NO_PROVIDER'/.test(sql)) {return Promise.resolve([{id: 'b1'}]);}
    return Promise.resolve([]);
  });
  db.withTransaction.mockImplementation((fn: (tx: unknown) => unknown) => fn({q: db.q, qOne: db.qOne}));
  return {calls, inserts};
}

const ZA = {code: 'ZA', name: 'South Africa', currency: 'ZAR', utcOffsetHours: 2, launched: true};
const booking = (over: Partial<Wire['booking']> = {}): Wire['booking'] => ({
  status: 'DISPATCHING', region_code: 'ZA', cpo_count: 1,
  pickup_lat: '-33.09', pickup_lng: '18.03',           // Langebaan, ~100 km from Cape Town
  requirements: {}, armed_required: false, booking_mode: 'later', area_id: 'area-wc',
  ...over,
});

afterEach(() => { setLiveRegions(null); delete process.env.DISPATCH_ROUTING_MODE; });

describe('dark by default — nearest mode is byte-identical to today', () => {
  it('runs ONLY the radius ranker when the region routes nearest', async () => {
    setLiveRegions([{...ZA, routingMode: 'nearest'}]);
    const w = wire({booking: booking(), nearest: [{user_id: 'agency-near', distance_km: '3.1'}]});
    await service().offerNext('b1');
    expect(w.calls.map(c => c.kind)).toEqual(['ctx', 'nearest', 'insert']);
    expect(w.calls[1].sql).toMatch(/ST_DWithin/);
    // 30 s TTL, exactly as before; source recorded as 'nearest'.
    const ins = w.inserts[0];
    expect(ins).toContain('agency-near');
    expect(ins).toContain(30);
    expect(ins).toContain('nearest');
  });

  it('a region with no ops-set mode follows the process default (nearest)', async () => {
    setLiveRegions([ZA]);
    const w = wire({booking: booking(), nearest: [{user_id: 'agency-near', distance_km: '3.1'}]});
    await service().offerNext('b1');
    expect(w.calls.map(c => c.kind)).toEqual(['ctx', 'nearest', 'insert']);
  });
});

describe('assigned mode — the primary gets the job regardless of distance', () => {
  beforeEach(() => setLiveRegions([{...ZA, routingMode: 'assigned'}]));

  it('offers the PRIMARY first even when an unassigned agency is far closer', async () => {
    const w = wire({
      booking: booking(),
      assigned: [{user_id: 'cape-town-primary', distance_km: '101.4', source: 'assigned:1'}],
      nearest: [{user_id: 'unassigned-2km', distance_km: '2.0'}],
    });
    await service().offerNext('b1');
    expect(w.calls.map(c => c.kind)).toEqual(['ctx', 'assigned', 'insert']);
    expect(w.calls.some(c => c.kind === 'nearest')).toBe(false);
    const ins = w.inserts[0];
    expect(ins).toContain('cape-town-primary');
    expect(ins).toContain('assigned:1');
    // Distance is INFORMATION on the offer row, never a gate.
    expect(ins).toContain('101.4');
  });

  it('binds the booking\'s area and the booking id to the ladder query', async () => {
    const w = wire({booking: booking(), assigned: [{user_id: 'p1', distance_km: null, source: 'assigned:1'}]});
    await service().offerNext('b1');
    const a = w.calls.find(c => c.kind === 'assigned')!;
    expect(a.params).toContain('area-wc');
    expect(a.params).toContain('b1');
    expect(a.params).toContain('ZA');
  });

  it('the ladder query carries NO radius and NO freshness window — the mocked-location anti-fraud stop STAYS', async () => {
    const w = wire({booking: booking(), assigned: [{user_id: 'p1', distance_km: null, source: 'assigned:1'}]});
    await service().offerNext('b1');
    const sql = w.calls.find(c => c.kind === 'assigned')!.sql;
    expect(sql).not.toMatch(/ST_DWithin/);
    expect(sql).not.toMatch(/last_location_at >/);
    expect(sql).toMatch(/AND a\.last_location_mocked = FALSE/);
    // An area ops deactivated stops routing even for bookings already stamped with it.
    expect(sql).toMatch(/JOIN public\.operational_areas oa ON oa\.id = ap\.area_id AND oa\.active = TRUE/);
  });

  it('…but keeps every compliance and correctness predicate', async () => {
    const w = wire({booking: booking(), assigned: [{user_id: 'p1', distance_km: null, source: 'assigned:1'}]});
    await service().offerNext('b1');
    const sql = w.calls.find(c => c.kind === 'assigned')!.sql;
    expect(sql).toMatch(/is_eligible_for_dispatch/);
    expect(sql).toMatch(/has_free_cpo_capacity/);
    expect(sql).toMatch(/cooldown_until/);
    expect(sql).toMatch(/a\.status = 'ACTIVE'/);
    expect(sql).toMatch(/a\.region_code = \$3/);
    expect(sql).toMatch(/status IN \('REJECTED','EXPIRED','SUPERSEDED'\)/);
    expect(sql).toMatch(/ORDER BY ap\.priority ASC/);
  });

  it('falls to the regional, radius-free rank when the ladder is exhausted', async () => {
    const w = wire({
      booking: booking(),
      assigned: [null],
      fallback: [{user_id: 'other-za-agency', distance_km: '240.0'}],
    });
    await service().offerNext('b1');
    expect(w.calls.map(c => c.kind)).toEqual(['ctx', 'assigned', 'fallback', 'insert']);
    const fb = w.calls.find(c => c.kind === 'fallback')!.sql;
    expect(fb).not.toMatch(/ST_DWithin/);
    expect(fb).toMatch(/is_eligible_for_dispatch/);
    expect(w.inserts[0]).toContain('regional_fallback');
  });

  it('resolves the area lazily for a booking created before the migration', async () => {
    const w = wire({
      booking: booking({area_id: null}),
      areaLookup: {id: 'area-default'},
      assigned: [{user_id: 'p1', distance_km: null, source: 'assigned:1'}],
    });
    await service().offerNext('b1');
    expect(w.calls.map(c => c.kind)).toEqual(['ctx', 'area', 'assigned', 'insert']);
    expect(w.calls.find(c => c.kind === 'area')!.params).toEqual(['ZA', true, -33.09, 18.03]);
  });

  it('with no area at all in the region, goes straight to the fallback', async () => {
    const w = wire({booking: booking({area_id: null}), areaLookup: null, fallback: [{user_id: 'x', distance_km: '9'}]});
    await service().offerNext('b1');
    expect(w.calls.map(c => c.kind)).toEqual(['ctx', 'area', 'fallback', 'insert']);
  });

  it('ends NO_PROVIDER only when the ladder AND the region are empty', async () => {
    const w = wire({booking: booking(), assigned: [null], fallback: [null]});
    await service().offerNext('b1');
    expect(w.calls.map(c => c.kind)).toEqual(['ctx', 'assigned', 'fallback']);
    expect(w.inserts).toHaveLength(0);
    expect(db.q.mock.calls.some(([sql]) => /UPDATE lite_bookings SET status = 'NO_PROVIDER'/.test(String(sql)))).toBe(true);
  });
});

describe('time to decide — TTL by mode', () => {
  beforeEach(() => setLiveRegions([{...ZA, routingMode: 'assigned'}]));

  it('a scheduled booking gets the long TTL', async () => {
    const w = wire({booking: booking({booking_mode: 'later'}), assigned: [{user_id: 'p1', distance_km: null, source: 'assigned:1'}]});
    await service().offerNext('b1');
    expect(w.inserts[0]).toContain(600);
  });

  it('a scheduled offer never outlives the booking start (clamped, never below the radius TTL)', async () => {
    const w = wire({booking: {...booking(), booking_mode: 'later', pickup_time: new Date(Date.now() + 240_000).toISOString()},
      assigned: [{user_id: 'p1', distance_km: null, source: 'assigned:1'}]});
    await service().offerNext('b1');
    const ttl = w.inserts[0][4] as number;
    expect(ttl).toBeGreaterThanOrEqual(230);
    expect(ttl).toBeLessThanOrEqual(240);
    const w2 = wire({booking: {...booking(), booking_mode: 'later', pickup_time: new Date(Date.now() - 60_000).toISOString()},
      assigned: [{user_id: 'p1', distance_km: null, source: 'assigned:1'}]});
    await service().offerNext('b1');
    expect(w2.inserts[0][4]).toBe(30);
  });

  it('an on-demand booking gets the assigned on-demand TTL', async () => {
    const w = wire({booking: booking({booking_mode: 'now'}), assigned: [{user_id: 'p1', distance_km: null, source: 'assigned:1'}]});
    await service().offerNext('b1');
    expect(w.inserts[0]).toContain(120);
  });

  it('honours on_duty for on-demand only', async () => {
    const now = wire({booking: booking({booking_mode: 'now'}), assigned: [{user_id: 'p1', distance_km: null, source: 'assigned:1'}]});
    await service().offerNext('b1');
    const dutyNow = now.calls.find(c => c.kind === 'assigned')!.params;
    expect(dutyNow[dutyNow.length - 1]).toBe(true);

    const later = wire({booking: booking({booking_mode: 'later'}), assigned: [{user_id: 'p1', distance_km: null, source: 'assigned:1'}]});
    await service().offerNext('b1');
    const dutyLater = later.calls.find(c => c.kind === 'assigned')!.params;
    expect(dutyLater[dutyLater.length - 1]).toBe(false);
  });
});

describe('the process default can turn a region on without an ops row', () => {
  it('DISPATCH_ROUTING_MODE=assigned routes a mode-less region by the ladder', async () => {
    process.env.DISPATCH_ROUTING_MODE = 'assigned';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {DispatchService: Fresh} = require('./dispatch.service') as {DispatchService: typeof DispatchService};
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {setLiveRegions: setFresh} = require('../common/regions') as {setLiveRegions: typeof setLiveRegions};
    setFresh([ZA]);
    const w = wire({booking: booking(), assigned: [{user_id: 'p1', distance_km: null, source: 'assigned:1'}]});
    const svc = new Fresh(db as never, fsm as never, audit as never, push as never, {} as never);
    await svc.offerNext('b1');
    expect(w.calls.map(c => c.kind)).toEqual(['ctx', 'assigned', 'insert']);
    setFresh(null);
  });
});

describe('the offer card — information for the provider, LB1 kept, dark path unchanged', () => {
  const base = {
    offer_id: 'o1', expires_at: new Date('2026-06-21T10:00:00Z'), offered_at: new Date('2026-06-21T09:59:30Z'),
    distance_km: '14.20', region_code: 'ZA', region_label: 'Cape Town', service: 'CPO',
    pickup_time: new Date('2026-06-21T12:00:00Z'), duration_hours: 4, cpo_count: 1, vehicle_count: 0,
    driver_only: false, armed_required: false, add_ons: [], requirements: {}, total_eur: '100.00', total_aed: '400.00',
    booking_mode: 'later',
  };

  it('a radius offer keeps the legacy bucket and carries no km — byte-identical to before', async () => {
    db.qOne.mockResolvedValueOnce({...base, source: 'nearest'});
    const dto = await service().getCurrentOfferForOrg('agency-A');
    expect(dto!.distance_bucket).toBe('>10km');
    expect(dto!.distance_km).toBeNull();
  });

  it('an assigned offer gets the wide bucket, ~km to 5 km, and its source — never the pickup', async () => {
    db.qOne.mockResolvedValueOnce({...base, source: 'assigned:1'});
    const dto = await service().getCurrentOfferForOrg('agency-A');
    expect(dto!.distance_bucket).toBe('10-20km');
    expect(dto!.distance_km).toBe(15);
    expect(dto!.source).toBe('assigned:1');
    expect(dto!.booking_mode).toBe('later');
    expect(JSON.stringify(dto)).not.toMatch(/pickup_lat|pickup_lng|dropoff|address|client_id|booking_id/);
  });
});
