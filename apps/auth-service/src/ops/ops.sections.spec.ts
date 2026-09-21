/**
 * 2026-09-03 IA restructure — the SERVER half of the console's product split.
 *
 * The console's own pin suite proves the rail and the routes; it cannot prove
 * that `?service=` actually narrows the SQL, that the `lane` chip has a source,
 * or that the segmented dashboard counts split on the right boundary. Those are
 * the assertions that keep IA-03, IA-05, IA-10 and IA-16 from silently
 * regressing into "the filter is decorative".
 *
 * Pinned here:
 *  - IA-03 `service` is a bound parameter, comma-split, applied to lite_bookings
 *    AND to the mission board — never string-interpolated.
 *  - IA-05 `lane` is derived from dispatch_offers / jobs on the same row.
 *  - IA-16 the Executive columns ride the SAME projection (no second endpoint).
 *  - IA-10 the dashboard counts split Lite vs Executive on `service`.
 *  - IA-06 the escrow list can be narrowed to one booking.
 */
import {OpsService} from './ops.service';
import {OpsDataService} from './ops-data.service';
import type {AdminContext} from './admin.guard';

const ADMIN: AdminContext = {user_id: 'adm-1', role: 'ADMIN', call_sign: 'OPS-1', region: 'AE'};

type Cap = {sql: string; params?: unknown[]};

function mkOps(qOne?: (sql: string) => unknown) {
  const qCalls: Cap[] = [];
  const qOneCalls: Cap[] = [];
  const db = {
    q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qCalls.push({sql, params});
      return Promise.resolve([]);
    }),
    qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qOneCalls.push({sql, params});
      return Promise.resolve(qOne ? qOne(sql) : null);
    }),
    withTransaction: jest.fn(),
  };
  const audit = {
    recordAdmin: jest.fn().mockResolvedValue(undefined),
    listForSubject: jest.fn().mockResolvedValue([]),
    recentFeed: jest.fn().mockResolvedValue([]),
    emit: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new OpsService(
    db as never, {} as never, {} as never, {} as never, {} as never,
    audit as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never, {} as never,
  );
  return {svc, qCalls, qOneCalls};
}

const bookingSql = (calls: Cap[]) => calls.find(c => /FROM lite_bookings b/.test(c.sql)) ?? {sql: '', params: []};

describe('IA-03 — listBookings scopes by product SERVER-side', () => {
  it('binds the service list as a parameter, never interpolates it', async () => {
    const {svc, qCalls} = mkOps();
    await svc.listBookings({service: 'secure_transfer,recon_team'}, ADMIN);
    const cap = bookingSql(qCalls);
    expect(cap.sql).toMatch(/b\.service = ANY\(\$\d\)/);
    // The values must arrive as a bound array, not spliced into the string.
    expect(cap.params).toContainEqual(['secure_transfer', 'recon_team']);
    expect(cap.sql).not.toMatch(/secure_transfer/);
  });

  it('keeps placeholder numbering aligned when status and region are also set', async () => {
    const {svc, qCalls} = mkOps();
    await svc.listBookings({status: 'PENDING_OPS', service: 'executive_protection', region: 'AE'}, ADMIN);
    const cap = bookingSql(qCalls);
    // status $1, service $2, region $3, limit $4, offset $5 — one param per
    // placeholder, in order. (`q` would sit between status and service; the
    // merged builder indexes on params.length after each push, so the numbering
    // holds with or without it.)
    expect(cap.sql).toMatch(/b\.status = \$1/);
    expect(cap.sql).toMatch(/b\.service = ANY\(\$2\)/);
    expect(cap.sql).toMatch(/b\.region_code = \$3/);
    expect(cap.sql).toMatch(/LIMIT \$4 OFFSET \$5/);
    expect(cap.params).toEqual(['PENDING_OPS', ['executive_protection'], 'AE', 50, 0]);
  });

  it('adds no clause at all when no service is asked for', async () => {
    const {svc, qCalls} = mkOps();
    await svc.listBookings({}, ADMIN);
    expect(bookingSql(qCalls).sql).not.toMatch(/b\.service = ANY/);
  });

  it('ignores an empty service list rather than emitting ANY(empty)', async () => {
    // An empty array would match NOTHING and read as "no bookings today".
    const {svc, qCalls} = mkOps();
    await svc.listBookings({service: ' , '}, ADMIN);
    expect(bookingSql(qCalls).sql).not.toMatch(/b\.service = ANY/);
  });
});

describe('IA-05 / IA-16 — the Lite lane and the Executive columns ride one projection', () => {
  it('derives lane from a dispatch offer, else a job row', async () => {
    const {svc, qCalls} = mkOps();
    await svc.listBookings({}, ADMIN);
    const sql = bookingSql(qCalls).sql;
    expect(sql).toMatch(/FROM public\.dispatch_offers o WHERE o\.booking_id = b\.id/);
    expect(sql).toMatch(/FROM public\.jobs j WHERE j\.booking_id = b\.id/);
    expect(sql).toMatch(/THEN 'auto'/);
    expect(sql).toMatch(/THEN 'manual'/);
    expect(sql).toMatch(/AS lane/);
  });

  it('projects the Executive columns so no second endpoint is needed', async () => {
    const {svc, qCalls} = mkOps();
    await svc.listBookings({}, ADMIN);
    const sql = bookingSql(qCalls).sql;
    for (const col of ['b.task_type', 'b.duration_hours', 'b.add_ons', 'b.driver_only']) {
      expect(sql).toContain(col);
    }
    expect(sql).toMatch(/\(b\.exec_transport IS NOT NULL\) AS has_transfer_leg/);
  });
});

describe('IA-10 — the dashboard splits Lite from Executive on `service`', () => {
  const KPI_ROW = {
    pending_approval: '1', active_missions: '2', agents_on_duty: '3', agents_total: '4',
    open_jobs: '5', gmv_today_aed: '6', gmv_today_bc: '7', sos_active: '8',
    pro_pending: '9', pro_requests: '10',
    lite_waiting: '11', lite_pending: '12', lite_dispatching: '13', lite_stalled: '14',
    lite_live: '15', lite_gmv: '16',
    exec_waiting: '17', exec_pending: '18', exec_dispatching: '19', exec_stalled: '20',
    exec_live: '21', exec_gmv: '22', exec_upcoming: '23',
    ent_waiting: '24', ent_critical: '25',
  };

  it('returns the per-product segments alongside the legacy flat keys', async () => {
    const {svc} = mkOps(sql => (/AS pending_approval/.test(sql) ? KPI_ROW : null));
    const out = await svc.dashboard();
    // Legacy keys survive for one release so an older console keeps working.
    expect(out.kpis.pending_approval).toBe(1);
    expect(out.kpis.lite.waiting).toBe(11);
    expect(out.kpis.executive.waiting).toBe(17);
    expect(out.kpis.executive.upcoming_24h).toBe(23);
    expect(out.kpis.enterprise.waiting).toBe(24);
    expect(out.kpis.enterprise.critical_incidents_24h).toBe(25);
  });

  it('counts Lite as everything that is NOT executive_protection', async () => {
    const {svc, qOneCalls} = mkOps(sql => (/AS pending_approval/.test(sql) ? KPI_ROW : null));
    await svc.dashboard();
    const sql = qOneCalls.find(c => /AS lite_waiting/.test(c.sql))?.sql ?? '';
    expect(sql).toMatch(/service <> 'executive_protection'[\s\S]*AS lite_waiting/);
    expect(sql).toMatch(/service = 'executive_protection'[\s\S]*AS exec_waiting/);
  });

  it('"waiting" is the three states no automation will move', async () => {
    const {svc, qOneCalls} = mkOps(sql => (/AS pending_approval/.test(sql) ? KPI_ROW : null));
    await svc.dashboard();
    const sql = qOneCalls.find(c => /AS lite_waiting/.test(c.sql))?.sql ?? '';
    // Drives the rail badge — DISPATCHING must NOT be in here or the badge
    // would never clear while the engine is working normally.
    const clause = sql.slice(sql.indexOf('AS lite_waiting') - 400, sql.indexOf('AS lite_waiting'));
    expect(clause).toMatch(/PENDING_OPS','NO_PROVIDER','AGENCY_NO_SHOW/);
    expect(clause).not.toMatch(/'DISPATCHING'/);
  });

  it('uses a half-open pickup_time window, never a ::date cast', async () => {
    // A cast is non-sargable and forced a seq scan on the polled dashboard.
    const {svc, qOneCalls} = mkOps(sql => (/AS pending_approval/.test(sql) ? KPI_ROW : null));
    await svc.dashboard();
    const raw = qOneCalls.find(c => /AS exec_upcoming/.test(c.sql))?.sql ?? '';
    expect(raw).toMatch(/pickup_time >= now\(\)[\s\S]*pickup_time <\s+now\(\) \+ interval '24 hours'/);
    // STRIP SQL COMMENTS BEFORE AN ABSENCE ASSERTION. The query carries a
    // comment reading "never pickup_time::date", so scanning the raw string
    // fails on the prose that documents the rule — the exact false positive
    // CLAUDE.md warns about, and it fired here on the first run.
    const code = raw
      .split(/\r?\n/)
      .filter(l => !l.trim().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/pickup_time::date/);
  });
});

describe('IA-06 — the escrow list can be narrowed to one booking', () => {
  function mkData() {
    const qCalls: Cap[] = [];
    const db = {
      q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
        qCalls.push({sql, params});
        return Promise.resolve([]);
      }),
      qOne: jest.fn().mockResolvedValue(null),
    };
    return {svc: new OpsDataService(db as never), qCalls};
  }

  it('binds the booking id and leaves the list unfiltered when absent', async () => {
    const {svc, qCalls} = mkData();
    await svc.listEscrows(ADMIN, undefined, undefined, 'b0000000-0000-0000-0000-000000000001');
    const cap = qCalls.find(c => /FROM escrow_holds e/.test(c.sql))!;
    expect(cap.sql).toMatch(/\$4::uuid IS NULL OR e\.booking_id = \$4/);
    expect(cap.params?.[3]).toBe('b0000000-0000-0000-0000-000000000001');

    const second = mkData();
    await second.svc.listEscrows(ADMIN);
    // The clause is always present; NULL makes it a no-op, which keeps the
    // placeholder count stable for every caller.
    expect(second.qCalls[0].params?.[3]).toBeNull();
  });
});
