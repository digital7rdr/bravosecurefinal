/**
 * Ops-console audit 2026-08-07 — server projections/behaviours pinned:
 *  - CA-01: dispatchBooking loads picked applications in PICK ORDER
 *    (array_position) so the agentIds[0] lead fallback matches the operator's
 *    first pick, and a driver-only/exec dispatch needs no vehicle.
 *  - IS-11: listBookings projects the client display name.
 *  - IS-14: the dashboard KPI row carries the Pro queue counts.
 *  - IS-07: getBookingDetail attaches the per-unit exec price composition,
 *    computed via PricingService (not re-tabled anywhere else).
 */
import {OpsService} from './ops.service';
import type {AdminContext} from './admin.guard';

const ADMIN: AdminContext = {user_id: 'adm-1', role: 'ADMIN', call_sign: 'OPS-1', region: 'AE'};

type Cap = {sql: string; params?: unknown[]};

/**
 * B-854 — `getBookingDetail`'s booking read. It is `SELECT b.* … LEFT JOIN
 * public.users vu … WHERE b.id = $1` now (it picks up the via holder's NAME,
 * which is not a column on the row), so a `SELECT \* FROM lite_bookings`
 * matcher answers NULL and every detail test 404s. Anchored on the aliased FROM
 * plus the by-id WHERE, which is still specific to this one read.
 */
const DETAIL_READ = /SELECT b\.\*[\s\S]{0,200}FROM lite_bookings b[\s\S]{0,200}WHERE b\.id = \$1/;

function mkSvc(overrides: {
  qOne?: (sql: string) => unknown;
  q?: (sql: string) => unknown[];
} = {}) {
  const qCalls: Cap[] = [];
  const qOneCalls: Cap[] = [];
  const db = {
    q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qCalls.push({sql, params});
      return Promise.resolve(overrides.q ? overrides.q(sql) : []);
    }),
    qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qOneCalls.push({sql, params});
      return Promise.resolve(overrides.qOne ? overrides.qOne(sql) : null);
    }),
    withTransaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        q: jest.fn().mockResolvedValue([]),
        qOne: jest.fn().mockImplementation((sql: string) =>
          /FROM lite_bookings/.test(sql)
            ? Promise.resolve({status: 'CONFIRMED', cpo_count: 1, region_code: 'AE', driver_only: true, vehicle_count: 0, service: 'executive_protection'})
            : Promise.resolve(null)),
      })),
  };
  const audit = {
    recordAdmin: jest.fn().mockResolvedValue(undefined),
    listForSubject: jest.fn().mockResolvedValue([]),
    recentFeed: jest.fn().mockResolvedValue([]),
    emit: jest.fn().mockResolvedValue(undefined),
  };
  const cpoAssign = {
    getMissionCrewForBooking: jest.fn().mockResolvedValue([]),
    getForBooking: jest.fn().mockResolvedValue([]),
  };
  const vehicles = {getForBooking: jest.fn().mockResolvedValue(null)};
  const svc = new OpsService(
    db as never, {} as never, {} as never, {} as never, {} as never,
    audit as never, {} as never, {} as never, cpoAssign as never, vehicles as never,
    {} as never, {} as never, {} as never, {} as never, {} as never,
  );
  return {svc, qCalls, qOneCalls};
}

describe('OpsService.listBookings — client identity (IS-11)', () => {
  it('projects the client display name via a users join', async () => {
    const {svc, qCalls} = mkSvc();
    await svc.listBookings({}, ADMIN);
    const sql = qCalls.find(c => /FROM lite_bookings b/.test(c.sql))?.sql ?? '';
    expect(sql).toMatch(/cu\.display_name AS client_name/);
    expect(sql).toMatch(/LEFT JOIN public\.users cu ON cu\.id = b\.client_id/);
  });

  /**
   * B-854 — the console renders "Paid by A via B" from `payer_via_user_id` +
   * `payer_via_name`. Both are OPTIONAL on its side, so a projection that omits
   * them degrades SILENTLY to "Paid by A" — a chained booking then reads as the
   * root's own spend on the one screen an operator uses to answer "who paid for
   * this?".
   *
   * Anchored on the exact `AS payer_via_name`, never a greedy `[\s\S]*` that
   * would span the whole statement and match the wrong join.
   */
  it('B-854: the LIST carries the chain — payer_via_user_id + payer_via_name', async () => {
    const {svc, qCalls} = mkSvc();
    await svc.listBookings({}, ADMIN);
    const sql = qCalls.find(c => /FROM lite_bookings b/.test(c.sql))?.sql ?? '';
    expect(sql).toMatch(/b\.payer_via_user_id/);
    expect(sql).toMatch(/vu\.display_name AS payer_via_name/);
    expect(sql).toMatch(/LEFT JOIN public\.users vu ON vu\.id = b\.payer_via_user_id/);
  });
});

describe('OpsService.getBookingDetail — the chain (B-854)', () => {
  it('the DETAIL projection carries payer_via_name beside the row it belongs to', async () => {
    const {svc, qOneCalls} = mkSvc({
      qOne: sql => /FROM lite_bookings b/.test(sql)
        ? {id: 'b1', client_id: 'c1', region_code: 'AE', payer_user_id: 'A',
           payer_via_user_id: 'B', payer_via_name: 'Bee', add_ons: [], cpo_count: 1,
           vehicle_count: 0, driver_only: true, duration_hours: 4}
        : null,
    });
    const out = await svc.getBookingDetail('b1', ADMIN);
    expect((out.booking as {payer_via_name?: string}).payer_via_name).toBe('Bee');
    const sql = qOneCalls.find(c => /FROM lite_bookings b/.test(c.sql))?.sql ?? '';
    expect(sql).toMatch(/vu\.display_name AS payer_via_name/);
    expect(sql).toMatch(/LEFT JOIN public\.users vu ON vu\.id = b\.payer_via_user_id/);
    // `b.*` stays: every existing consumer of this detail reads whole columns
    // off it, and narrowing the projection to a list would break them silently.
    expect(sql).toMatch(/SELECT b\.\*/);
  });
});

describe('OpsService.dashboard — Pro presence (IS-14)', () => {
  it('counts pending Pro applications + waiting protection-date requests', async () => {
    const {svc, qOneCalls} = mkSvc({
      qOne: sql => /AS pending_approval/.test(sql)
        ? {pending_approval: '0', active_missions: '0', agents_on_duty: '0', agents_total: '0',
           open_jobs: '0', gmv_today_aed: '0', gmv_today_bc: '0', sos_active: '0',
           pro_pending: '3', pro_requests: '2'}
        : null,
    });
    const out = await svc.dashboard();
    expect(out.kpis.pro_pending).toBe(3);
    expect(out.kpis.pro_requests).toBe(2);
    const sql = qOneCalls.find(c => /AS pending_approval/.test(c.sql))?.sql ?? '';
    expect(sql).toMatch(/FROM pro_applications[\s\S]*PENDING_PROPOSAL/);
    // B-841 — the badge counts REQUESTED dates on ACTIVE plans only, so it
    // agrees with the Assignments queue it points at. Anchored on the alias
    // terminator, never a greedy [\s\S]* that would span sibling subqueries.
    expect(sql).toMatch(
      /FROM pro_plan_missions pm\s+JOIN pro_applications pa ON pa\.id = pm\.application_id\s+WHERE pm\.status = 'REQUESTED' AND pa\.status = 'ACTIVE'\) AS pro_requests/,
    );
  });
});

describe('OpsService.dispatchBooking — pick order + driver-only gate (CA-01/SK-02)', () => {
  it('loads applications ORDER BY array_position of the picked ids, with no vehicle demanded', async () => {
    const {svc, qCalls} = mkSvc({
      qOne: sql => /FROM jobs WHERE booking_id/.test(sql) ? {id: 'job-1'} : null,
      q: sql => /FROM job_applications/.test(sql)
        // job_id mismatch aborts the flow AFTER the query we want to pin.
        ? [{id: 'a1', agent_id: 'g1', status: 'PENDING', job_id: 'other-job'}]
        : [],
    });
    await expect(
      svc.dispatchBooking('b1', ADMIN, {applicationIds: ['a1']}),
    ).rejects.toThrow('application_belongs_to_other_job');
    const appsSql = qCalls.find(c => /FROM job_applications/.test(c.sql))?.sql ?? '';
    expect(appsSql).toMatch(/ORDER BY array_position\(\$1::uuid\[\], id\)/);
  });

  it('rejects a vehicle pick on a driver-only booking (mirror of the console gate)', async () => {
    const {svc} = mkSvc();
    await expect(
      svc.dispatchBooking('b1', ADMIN, {applicationIds: ['a1'], vehicleId: 'v1'}),
    ).rejects.toThrow('driver_only_no_vehicle');
  });
});

describe('OpsService.getBookingDetail — exec price composition (IS-07)', () => {
  const execBooking = {
    id: 'b1', client_id: 'c1', payer_user_id: null, region_code: 'AE',
    service: 'executive_protection', cpo_count: 2, vehicle_count: 1,
    driver_only: false, duration_hours: 3, pickup_time: '2026-08-10T10:00:00Z',
    add_ons: ['medical'], total_eur: '876',
  };

  it('attaches per-unit line items and the pricing-service rate/total', async () => {
    const {svc} = mkSvc({
      // B-854 — the detail read is `SELECT b.* … LEFT JOIN users vu` now.
      qOne: sql => DETAIL_READ.test(sql) ? execBooking : null,
    });
    const out = await svc.getBookingDetail('b1', ADMIN) as {price_breakdown: {
      items: Array<{id: string; qty: number; rate_eur: number; subtotal_eur: number}>;
      rate_eur_per_hour: number; duration_hours: number; total_eur: number;
    }};
    const pb = out.price_breakdown;
    expect(pb).not.toBeNull();
    // 2×86 CPO + 1×30 vehicle + 90 medical = 292/hr; ×3h = 876 (flat, no peak).
    expect(pb.items).toEqual(expect.arrayContaining([
      expect.objectContaining({id: 'cpo', qty: 2, rate_eur: 86, subtotal_eur: 172}),
      expect.objectContaining({id: 'vehicle', qty: 1, rate_eur: 30, subtotal_eur: 30}),
      expect.objectContaining({id: 'medical', qty: 1, rate_eur: 90, subtotal_eur: 90}),
    ]));
    expect(pb.rate_eur_per_hour).toBe(292);
    expect(pb.duration_hours).toBe(3);
    expect(pb.total_eur).toBe(876);
  });

  it('stays null for non-exec services (Lite pricing keeps its own card)', async () => {
    const {svc} = mkSvc({
      qOne: sql => DETAIL_READ.test(sql)
        ? {...execBooking, service: 'secure_transport'} : null,
    });
    const out = await svc.getBookingDetail('b1', ADMIN) as {price_breakdown: unknown};
    expect(out.price_breakdown).toBeNull();
  });
});
