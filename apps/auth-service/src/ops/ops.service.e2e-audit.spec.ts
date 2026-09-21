/**
 * SECURE_SERVICES_E2E_AUDIT_2026-09-03 — OpsService half.
 *
 *  E2E-04 (P0) approveBooking had NO time check: ops could approve a booking
 *              whose start was already hours past, and the T-15 sweep (no lower
 *              bound) would then hold escrow and hunt for a crew.
 *  E2E-19 (P1) the agent directory had no region scoping — `filter.region` was
 *              declared and never used, so a region-scoped admin read every
 *              region's officer email + phone while the bookings list
 *              force-scoped the same admin.
 *  E2E-28 (P1) the ops EP price breakdown recomputed at COMPILED defaults,
 *              ignoring the persisted `pricing_breakdown` and the region overlay
 *              — ops approved against a number the client was never charged.
 *  E2E-41 (P2) ops dispatch pushed the agents only; the client learned a crew
 *              existed on their next poll.
 *  E2E-48 (P3) the approve response could not tell "auto lane, nothing
 *              published" from "job publish failed".
 */
import {BadRequestException, ForbiddenException} from '@nestjs/common';
import {OpsService} from './ops.service';
import {BookingStateMachine} from '../booking/state-machine.service';
import {DEFAULT_SERVICE_PRICING, PricingService} from '../booking/pricing.service';
import type {AdminContext} from './admin.guard';

const GLOBAL_ADMIN: AdminContext = {user_id: 'u-a', role: 'ADMIN', call_sign: 'ADM', region: 'AE'};
const AE_SUPERVISOR: AdminContext = {user_id: 'u-s', role: 'SUPERVISOR', call_sign: 'SUP', region: 'AE'};

const HOUR = 3600_000;

type Cap = {sql: string; params?: unknown[]};

/**
 * A DatabaseService double whose answers are chosen by SQL shape, plus a
 * transaction that ROLLS BACK: writes issued on `tx` reach `applied` only when
 * the callback resolves. Approve must not half-apply on a refusal.
 */
function makeDb(opts: {
  qOne?: (sql: string, params?: unknown[]) => unknown;
  q?: (sql: string, params?: unknown[]) => unknown[];
} = {}) {
  const qCalls: Cap[] = [];
  const applied: Cap[] = [];
  const q = jest.fn(async (sql: string, params?: unknown[]) => {
    qCalls.push({sql, params});
    return (opts.q ? opts.q(sql, params) : []) as unknown[];
  });
  const qOne = jest.fn(async (sql: string, params?: unknown[]) =>
    (opts.qOne ? opts.qOne(sql, params) : null));
  const withTransaction = jest.fn(async (fn: (tx: {q: jest.Mock; qOne: jest.Mock}) => unknown) => {
    const staged: Cap[] = [];
    const txQ = jest.fn(async (sql: string, params?: unknown[]) => {
      staged.push({sql, params});
      return q(sql, params);
    });
    const txQOne = jest.fn(async (sql: string, params?: unknown[]) => qOne(sql, params));
    const out = await fn({q: txQ, qOne: txQOne});
    applied.push(...staged);   // COMMIT
    return out;
  });
  return {db: {q, qOne, withTransaction}, qCalls, applied, q, qOne};
}

function makeSvc(dbLike: unknown, extra: {
  pricing?: unknown;
  bookingPush?: unknown;
  cpoAssign?: unknown;
  vehicles?: unknown;
  conversations?: unknown;
  jobFeed?: unknown;
} = {}) {
  const audit = {
    record: jest.fn().mockResolvedValue(undefined),
    recordAdmin: jest.fn().mockResolvedValue(undefined),
    emit: jest.fn().mockResolvedValue(undefined),
    listForSubject: jest.fn().mockResolvedValue([]),
    recentFeed: jest.fn().mockResolvedValue([]),
  };
  const bookingPush = extra.bookingPush ?? {
    bookingApproved: jest.fn().mockResolvedValue(undefined),
    crewAssigned: jest.fn().mockResolvedValue(undefined),
    missionDispatched: jest.fn().mockResolvedValue(undefined),
  };
  const jobFeed = extra.jobFeed ?? {publishFromBooking: jest.fn().mockResolvedValue({short_code: 'JF-1'})};
  const systemMsg = {
    sendBookingApproved: jest.fn().mockResolvedValue(undefined),
    sendBookingRejected: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new OpsService(
    dbLike as never,
    {} as never,                                        // bookings
    {
      getMe: jest.fn().mockResolvedValue({user_id: 'g1'}),
      reviewDocument: jest.fn().mockResolvedValue({ok: true}),
      reviewKycCheck: jest.fn().mockResolvedValue({ok: true}),
    } as never,  // agents
    new BookingStateMachine(),
    {} as never,                                        // agentFsm
    audit as never,
    jobFeed as never,
    systemMsg as never,
    (extra.cpoAssign ?? {
      getMissionCrewForBooking: jest.fn().mockResolvedValue([]),
      getForBooking: jest.fn().mockResolvedValue([]),
      assignSpecific: jest.fn().mockResolvedValue(undefined),
    }) as never,
    (extra.vehicles ?? {
      getForBooking: jest.fn().mockResolvedValue(null),
      assignSpecific: jest.fn().mockResolvedValue(undefined),
    }) as never,
    (extra.conversations ?? {create: jest.fn().mockResolvedValue({id: 'conv-1'})}) as never,
    {} as never,                                        // wallet
    {} as never,                                        // settlement
    {getRoute: jest.fn().mockResolvedValue({distance_m: 0, duration_s: 0, polyline: null})} as never,
    bookingPush as never,
    undefined as never,                                 // redis
    undefined as never,                                 // sentry
    undefined as never,                                 // auth
    extra.pricing as never,                             // pricing
  );
  return {svc, audit, bookingPush: bookingPush as Record<string, jest.Mock>, jobFeed: jobFeed as Record<string, jest.Mock>};
}

// ─── E2E-04 — a late approval is refused ───────────────────────────────────

describe('E2E-04 — approveBooking refuses a start it can no longer deliver', () => {
  function bookingRow(over: Record<string, unknown> = {}) {
    return {
      status: 'PENDING_OPS', client_id: 'c-1', pickup_address: 'A', dropoff_address: 'B',
      pickup_time: new Date(Date.now() + 6 * HOUR), total_aed: '500', region_code: 'AE',
      dispatch_mode: 'auto', booking_mode: 'later', service: 'executive_protection',
      ...over,
    };
  }
  const approvableDb = (over: Record<string, unknown> = {}) => makeDb({
    qOne: sql => /FROM lite_bookings WHERE id = \$1 FOR UPDATE/.test(sql) ? bookingRow(over) : null,
    q: sql => /UPDATE lite_bookings/.test(sql) ? [{id: 'b1'}] : [],
  });
  // The ops pricing board, not a constant: EP lead 3 h.
  const board = {
    config: jest.fn().mockResolvedValue({...DEFAULT_SERVICE_PRICING, exec_min_lead_hours: 3}),
    calculate: jest.fn(),
  };

  it('refuses a start that has already PASSED with a stable code, and applies no write', async () => {
    const {db, applied} = approvableDb({pickup_time: new Date(Date.now() - 4 * HOUR)});
    const {svc} = makeSvc(db, {pricing: board});

    const err = await svc.approveBooking('b1', GLOBAL_ADMIN, 'tactical suit only').catch(e => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toEqual(expect.objectContaining({
      code: OpsService.APPROVE_START_PASSED,
    }));
    expect(OpsService.APPROVE_START_PASSED).toBe('booking_start_time_passed');
    // The refusal happens inside the txn, before the FSM flip: nothing committed.
    expect(applied.filter(w => /UPDATE lite_bookings/.test(w.sql))).toHaveLength(0);
  });

  it('refuses a start inside the service lead and echoes lead_hours + earliest_start', async () => {
    const {db} = approvableDb({pickup_time: new Date(Date.now() + 1 * HOUR)});
    const {svc} = makeSvc(db, {pricing: board});

    const err = await svc.approveBooking('b1', GLOBAL_ADMIN, 'tactical suit only').catch(e => e);
    expect(err).toBeInstanceOf(BadRequestException);
    const body = (err as BadRequestException).getResponse() as Record<string, unknown>;
    expect(body.code).toBe(OpsService.APPROVE_LEAD_TOO_SHORT);
    expect(OpsService.APPROVE_LEAD_TOO_SHORT).toBe('booking_insufficient_lead_time');
    expect(body.lead_hours).toBe(3);
    expect(typeof body.earliest_start).toBe('string');
  });

  it('reads the lead from the OPS BOARD for the booking region, never a compiled number', async () => {
    // Same 4 h start, two different board values → two different verdicts.
    const lenient = {config: jest.fn().mockResolvedValue({...DEFAULT_SERVICE_PRICING, exec_min_lead_hours: 3}), calculate: jest.fn()};
    const strict = {config: jest.fn().mockResolvedValue({...DEFAULT_SERVICE_PRICING, exec_min_lead_hours: 12}), calculate: jest.fn()};

    const a = approvableDb({pickup_time: new Date(Date.now() + 4 * HOUR)});
    await expect(makeSvc(a.db, {pricing: lenient}).svc
      .approveBooking('b1', GLOBAL_ADMIN, 'tactical suit only')).resolves.toEqual(
      expect.objectContaining({ok: true}));
    expect(lenient.config).toHaveBeenCalledWith('AE');

    const b = approvableDb({pickup_time: new Date(Date.now() + 4 * HOUR)});
    await expect(makeSvc(b.db, {pricing: strict}).svc
      .approveBooking('b1', GLOBAL_ADMIN, 'tactical suit only')).rejects.toThrow(BadRequestException);
  });

  it('approve_late overrides the LEAD refusal but never the passed-start refusal', async () => {
    const inLead = approvableDb({pickup_time: new Date(Date.now() + 1 * HOUR)});
    await expect(makeSvc(inLead.db, {pricing: board}).svc
      .approveBooking('b1', GLOBAL_ADMIN, 'tactical suit only', undefined, {approveLate: true}))
      .resolves.toEqual(expect.objectContaining({ok: true}));

    const past = approvableDb({pickup_time: new Date(Date.now() - 1 * HOUR)});
    const err = await makeSvc(past.db, {pricing: board}).svc
      .approveBooking('b1', GLOBAL_ADMIN, 'tactical suit only', undefined, {approveLate: true})
      .catch(e => e);
    expect((err as BadRequestException).getResponse()).toEqual(expect.objectContaining({
      code: OpsService.APPROVE_START_PASSED,
    }));
  });

  it("an ON-DEMAND auto request ('guard now') stays exempt — its start IS submit time", async () => {
    // Mirrors booking.service.ts create(), which exempts auto+'now' from the
    // lead gate. Without this exemption the headline product would be
    // unapprovable: every such booking is already "past" on the ops board.
    const {db} = approvableDb({
      dispatch_mode: 'auto', booking_mode: 'now', service: 'secure_transfer',
      pickup_time: new Date(Date.now() - 8 * 60_000),
    });
    const {svc} = makeSvc(db, {pricing: board});
    await expect(svc.approveBooking('b1', GLOBAL_ADMIN, 'tactical suit only'))
      .resolves.toEqual(expect.objectContaining({ok: true}));
  });

  // CRITIC P1 — the exemption must be SERVICE-GATED. At create, EP takes the
  // `if (dto.service === 'executive_protection')` arm and is lead-gated
  // UNCONDITIONALLY ("EP is ALWAYS SCHEDULED… the exemption is gone"); the
  // auto+'now' exemption lives only in the non-EP `else`. Ungated here, an EP row
  // carrying booking_mode:'now' skipped BOTH checks — including the
  // non-overridable past-start one this guard exists for.
  it('an EP booking marked booking_mode:now is NOT exempt — past start still refused', async () => {
    const {db, applied} = approvableDb({
      service: 'executive_protection', dispatch_mode: 'auto', booking_mode: 'now',
      pickup_time: new Date(Date.now() - 4 * HOUR),
    });
    const {svc} = makeSvc(db, {pricing: board});
    const err = await svc.approveBooking('b1', GLOBAL_ADMIN, 'tactical suit only').catch(e => e);
    expect((err as BadRequestException).getResponse()).toEqual(expect.objectContaining({
      code: OpsService.APPROVE_START_PASSED,
    }));
    expect(applied.filter(w => /UPDATE lite_bookings/.test(w.sql))).toHaveLength(0);
  });

  it('an EP booking marked booking_mode:now still gets the LEAD check', async () => {
    const {db} = approvableDb({
      service: 'executive_protection', dispatch_mode: 'auto', booking_mode: 'now',
      pickup_time: new Date(Date.now() + 1 * HOUR),
    });
    const {svc} = makeSvc(db, {pricing: board});
    const err = await svc.approveBooking('b1', GLOBAL_ADMIN, 'tactical suit only').catch(e => e);
    expect((err as BadRequestException).getResponse()).toEqual(expect.objectContaining({
      code: OpsService.APPROVE_LEAD_TOO_SHORT, lead_hours: 3,
    }));
  });

  it('the exemption still holds for the non-EP now-lane it was written for', async () => {
    const {db} = approvableDb({
      service: 'secure_transfer', dispatch_mode: 'auto', booking_mode: 'now',
      pickup_time: new Date(Date.now() - 8 * 60_000),
    });
    const {svc} = makeSvc(db, {pricing: board});
    await expect(svc.approveBooking('b1', GLOBAL_ADMIN, 'tactical suit only'))
      .resolves.toEqual(expect.objectContaining({ok: true}));
  });

  it('an unparseable pickup_time never blocks an approval', async () => {
    const {db} = approvableDb({pickup_time: 'not-a-date' as unknown as Date});
    const {svc} = makeSvc(db, {pricing: board});
    await expect(svc.approveBooking('b1', GLOBAL_ADMIN, 'tactical suit only'))
      .resolves.toEqual(expect.objectContaining({ok: true}));
  });
});

// ─── E2E-48 — the approve response says which lane actually has the booking ──

describe('E2E-48 — approve response is unambiguous about publication', () => {
  const board = {config: jest.fn().mockResolvedValue(DEFAULT_SERVICE_PRICING), calculate: jest.fn()};
  const rowFor = (over: Record<string, unknown>) => ({
    status: 'PENDING_OPS', client_id: 'c-1', pickup_address: 'A', dropoff_address: null,
    pickup_time: new Date(Date.now() + 6 * HOUR), total_aed: '500', region_code: 'AE',
    service: 'secure_transfer', ...over,
  });
  const dbFor = (over: Record<string, unknown>) => makeDb({
    qOne: sql => /FROM lite_bookings WHERE id = \$1 FOR UPDATE/.test(sql) ? rowFor(over) : null,
    q: sql => /UPDATE lite_bookings/.test(sql) ? [{id: 'b1'}] : [],
  }).db;

  it('auto lane reports job_published:false — nothing was ever published', async () => {
    const {svc} = makeSvc(dbFor({dispatch_mode: 'auto', booking_mode: 'now'}), {pricing: board});
    const r = await svc.approveBooking('b1', GLOBAL_ADMIN, 'tactical suit only');
    expect(r).toEqual({ok: true, job: null, job_published: false, dispatch_path: 'auto_dispatch'});
  });

  it('a legacy approve whose publish SUCCEEDED reports job_published:true', async () => {
    const {svc} = makeSvc(dbFor({dispatch_mode: null}), {pricing: board});
    const r = await svc.approveBooking('b1', GLOBAL_ADMIN, 'tactical suit only');
    expect(r).toEqual(expect.objectContaining({job_published: true, dispatch_path: 'job_feed'}));
  });

  it('a legacy approve whose publish THREW reports job_published:false (approval still stands)', async () => {
    const {svc} = makeSvc(dbFor({dispatch_mode: null}), {
      pricing: board,
      jobFeed: {publishFromBooking: jest.fn().mockRejectedValue(new Error('short code collision'))},
    });
    const r = await svc.approveBooking('b1', GLOBAL_ADMIN, 'tactical suit only');
    expect(r).toEqual(expect.objectContaining({ok: true, job: null, job_published: false}));
  });
});

// ─── E2E-19 — the agent directory is region-scoped ─────────────────────────

describe('E2E-19 — agent surface region scoping', () => {
  it('FORCES a region-scoped admin onto their own region, ignoring the query they sent', async () => {
    const {db, qCalls} = makeDb();
    const {svc} = makeSvc(db);
    await svc.listAgents({region: 'SA', status: 'APPROVED', type: 'cpo'}, AE_SUPERVISOR);
    const call = qCalls.find(c => /FROM agents a/.test(c.sql));
    // The predicate is the DERIVED region (CRITIC P0), bound at $3.
    expect(call?.sql).toMatch(/COALESCE\([\s\S]*?\)\s*=\s*\$3/);
    // Placeholder arithmetic: status $1, type $2, region $3 (the listBookings lesson —
    // index off params.length, never conds.length).
    expect(call?.params?.slice(0, 3)).toEqual(['APPROVED', 'cpo', 'AE']);
    expect(call?.params).not.toContain('SA');
  });

  it('a global ADMIN keeps the explicit ?region= drill-in', async () => {
    const {db, qCalls} = makeDb();
    const {svc} = makeSvc(db);
    await svc.listAgents({region: 'SA'}, GLOBAL_ADMIN);
    const call = qCalls.find(c => /FROM agents a/.test(c.sql));
    expect(call?.sql).toMatch(/COALESCE\([\s\S]*?\)\s*=\s*\$1/);
    expect(call?.params?.[0]).toBe('SA');
  });

  const scopeDb = (effective: string | null) =>
    makeDb({qOne: sql => /AS effective_region/.test(sql) ? {effective_region: effective} : null});

  it('getAgentDetail refuses an out-of-region officer (no PII read at all)', async () => {
    const {db, qOne} = scopeDb('SA');
    const {svc} = makeSvc(db);
    await expect(svc.getAgentDetail('g-1', AE_SUPERVISOR)).rejects.toBeInstanceOf(ForbiddenException);
    // The scope read is the ONLY query that ran — the users/email lookup never fired.
    expect(qOne.mock.calls.every(([sql]: [string]) => /AS effective_region/.test(sql))).toBe(true);
  });

  it('getAgentDetail fails CLOSED only when NOTHING resolves', async () => {
    const {db} = scopeDb(null);
    const {svc} = makeSvc(db);
    await expect(svc.getAgentDetail('g-1', AE_SUPERVISOR)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('an in-region officer still resolves for a scoped admin', async () => {
    const {db} = scopeDb('AE');
    const {svc} = makeSvc(db);
    await expect(svc.getAgentDetail('g-1', AE_SUPERVISOR)).resolves.toBeTruthy();
  });

  // ─── CRITIC P0 — the derivation, not the raw column ────────────────────────
  //
  // `agents.region_code` has ONE writer (setAgencyProfile, "Company agents only"),
  // so it is NULL for every individual officer. Filtering on it emptied the whole
  // CPO directory — including the SUBMITTED approval queue — for every non-global
  // admin, and 403'd the detail page. The earlier specs missed it because every
  // fixture set region_code:'AE'.
  describe('CRITIC P0 — an officer whose own region_code is NULL', () => {
    it('the LIST filters on the DERIVED region, never the raw column', async () => {
      const {db, qCalls} = makeDb();
      const {svc} = makeSvc(db);
      await svc.listAgents({}, AE_SUPERVISOR);
      const sql = qCalls.find(c => /FROM agents a/.test(c.sql))?.sql ?? '';
      // The predicate is the COALESCE chain, not `a.region_code = $n`.
      expect(sql).not.toMatch(/\ba\.region_code = \$/);
      expect(sql).toMatch(/COALESCE\([\s\S]*a\.region_code[\s\S]*orga\.region_code[\s\S]*home_region/);
      // …and the chain's joins are actually in the FROM, or it would be NULL always.
      expect(sql).toMatch(/LEFT JOIN agents orga\s+ON orga\.user_id = a\.managed_by_org_id/);
      expect(sql).toMatch(/LEFT JOIN agent_profiles p/);
    });

    it("resolves a managed CPO through its ORG's region", async () => {
      // region_code NULL on the officer, 'AE' on the managing agency → visible.
      const {db} = scopeDb('AE');
      const {svc} = makeSvc(db);
      await expect(svc.getAgentDetail('cpo-1', AE_SUPERVISOR)).resolves.toBeTruthy();
      await expect(svc.getAgentStats('cpo-1', AE_SUPERVISOR)).resolves.toBeTruthy();
    });

    it('the fallback chain names every source in priority order', async () => {
      const {db, qOne} = scopeDb('AE');
      const {svc} = makeSvc(db);
      await svc.getAgentDetail('cpo-1', AE_SUPERVISOR);
      const sql = (qOne.mock.calls.find(([s]: [string]) => /AS effective_region/.test(s))?.[0] ?? '') as string;
      // own row → managing org → home_region → coverage country → country_code.
      const order = ['a.region_code', 'orga.region_code', 'home_region', "coverage->'countries'", 'country_code'];
      let at = -1;
      for (const token of order) {
        const next = sql.indexOf(token);
        expect(next).toBeGreaterThan(at);
        at = next;
      }
      // 'N/A' is the explicit outside-coverage sentinel and must not count.
      expect(sql).toMatch(/NULLIF\(u\.home_region, 'N\/A'\)/);
    });

    it('the list and the by-id gate use the SAME expression (no see-it-then-403)', async () => {
      const list = makeDb();
      await makeSvc(list.db).svc.listAgents({}, AE_SUPERVISOR);
      const listSql = list.qCalls.find(c => /FROM agents a/.test(c.sql))?.sql ?? '';
      const detail = scopeDb('AE');
      await makeSvc(detail.db).svc.getAgentDetail('cpo-1', AE_SUPERVISOR);
      const detailSql = (detail.qOne.mock.calls.find(([s]: [string]) => /AS effective_region/.test(s))?.[0] ?? '') as string;
      const chain = (s: string) => (s.match(/COALESCE\([\s\S]*?\n\s*\)/)?.[0] ?? '').replace(/\s+/g, ' ');
      expect(chain(listSql)).not.toBe('');
      expect(chain(listSql)).toBe(chain(detailSql));
    });
  });

  // ─── CRITIC P1 — the neighbouring by-id agent surfaces ─────────────────────
  describe('CRITIC P1 — stats / doc review / KYC review are scoped too', () => {
    it('getAgentStats refuses out-of-region (it returns LIVE coordinates)', async () => {
      const {db} = scopeDb('SA');
      const {svc} = makeSvc(db);
      await expect(svc.getAgentStats('g-1', AE_SUPERVISOR)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('reviewDocument and reviewKycCheck refuse out-of-region MUTATIONS', async () => {
      const a = scopeDb('SA');
      await expect(makeSvc(a.db).svc.reviewDocument('g-1', 'passport', 'adm', AE_SUPERVISOR))
        .rejects.toBeInstanceOf(ForbiddenException);
      const b = scopeDb('SA');
      await expect(makeSvc(b.db).svc.reviewKycCheck('g-1', 'identity', 'adm', AE_SUPERVISOR))
        .rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a global ADMIN bypasses every one of them', async () => {
      const {db} = scopeDb(null);
      const {svc} = makeSvc(db);
      await expect(svc.getAgentStats('g-1', GLOBAL_ADMIN)).resolves.toBeTruthy();
      await expect(svc.getAgentDetail('g-1', GLOBAL_ADMIN)).resolves.toBeTruthy();
    });
  });
});

// ─── E2E-28 — the EP breakdown reflects what the client PAID ───────────────

describe('E2E-28 — ops EP price breakdown', () => {
  const baseBooking = {
    id: 'b1', client_id: 'c1', payer_user_id: null, region_code: 'AE',
    service: 'executive_protection', cpo_count: 2, vehicle_count: 1,
    driver_only: false, duration_hours: 3, pickup_time: '2026-08-10T10:00:00Z',
    add_ons: ['medical'],
  };
  // B-854 — the detail read is now `SELECT b.* … LEFT JOIN users vu` (it picks
  // up the via holder's NAME, which is not a column on the row). Matched on the
  // aliased FROM + the by-id WHERE, which is still specific to THIS read.
  const detailDb = (booking: Record<string, unknown>) => makeDb({
    qOne: sql => /SELECT b\.\*[\s\S]{0,200}FROM lite_bookings b[\s\S]{0,200}WHERE b\.id = \$1/.test(sql)
      ? booking : null,
  }).db;

  it('prefers the PERSISTED breakdown — no recompute, and ops sees the charged number', async () => {
    // The client was charged at a board that has since MOVED (CPO 100, not 86).
    const persisted = {
      ...baseBooking,
      pricing_breakdown: [
        {label: '2 × Close Protection Officer', amount_eur: 200},
        {label: '1 × Vehicle & Driver', amount_eur: 40},
        {label: 'Medical Support', amount_eur: 90},
      ],
      rate_eur_per_hour: '330',
      total_eur: '990',
    };
    const calculate = jest.fn();
    const {svc} = makeSvc(detailDb(persisted), {
      pricing: {config: jest.fn().mockResolvedValue(DEFAULT_SERVICE_PRICING), calculate},
    });

    const out = await svc.getBookingDetail('b1', GLOBAL_ADMIN) as {price_breakdown: {
      items: Array<{id: string; label: string; qty: number; rate_eur: number; subtotal_eur: number}>;
      rate_eur_per_hour: number; duration_hours: number; total_eur: number;
    }};
    const pb = out.price_breakdown;
    // The ids survive — the console keys add-on rates off item.id.
    expect(pb.items).toEqual([
      {id: 'cpo', label: '2 × Close Protection Officer', qty: 2, rate_eur: 100, subtotal_eur: 200},
      {id: 'vehicle', label: '1 × Vehicle & Driver', qty: 1, rate_eur: 40, subtotal_eur: 40},
      {id: 'medical', label: 'Medical Support', qty: 1, rate_eur: 90, subtotal_eur: 90},
    ]);
    expect(pb.rate_eur_per_hour).toBe(330);
    expect(pb.total_eur).toBe(990);
    // THE E2E-28 ASSERTION: history is not re-derived from today's config.
    expect(calculate).not.toHaveBeenCalled();
  });

  it('falls back to a recompute that passes the BOOKING REGION cfg, not compiled defaults', async () => {
    const regionCfg = {
      ...DEFAULT_SERVICE_PRICING,
      exec_cpo_rate_bc: 120, exec_vehicle_rate_bc: 50, addon_medical_bc: 111,
    };
    const config = jest.fn().mockResolvedValue(regionCfg);
    // Use the real formula so the summary cannot silently drift from the items.
    const calculate = jest.fn((input, cfg) => new PricingService().calculate(input, cfg));
    const {svc} = makeSvc(detailDb(baseBooking), {pricing: {config, calculate}});

    const out = await svc.getBookingDetail('b1', GLOBAL_ADMIN) as {price_breakdown: {
      items: Array<{id: string; rate_eur: number; subtotal_eur: number}>;
      rate_eur_per_hour: number; total_eur: number;
    }};
    expect(config).toHaveBeenCalledWith('AE');
    // Rates come from the region cfg (120/50/111), not 86/30/90.
    expect(out.price_breakdown.items).toEqual(expect.arrayContaining([
      expect.objectContaining({id: 'cpo', rate_eur: 120, subtotal_eur: 240}),
      expect.objectContaining({id: 'vehicle', rate_eur: 50, subtotal_eur: 50}),
      expect.objectContaining({id: 'medical', rate_eur: 111, subtotal_eur: 111}),
    ]));
    // …and the recompute itself was handed the same cfg (240+50+111 = 401/hr × 3).
    expect(calculate).toHaveBeenCalledWith(expect.anything(), regionCfg);
    expect(out.price_breakdown.rate_eur_per_hour).toBe(401);
    expect(out.price_breakdown.total_eur).toBe(1203);
  });

  it('a persisted breakdown with an unreadable stored summary derives it from the lines (never NaN)', async () => {
    // The console renders rate/total with `.toLocaleString()`; a NULL column
    // would paint "NaN" across a money field on the approval page.
    const legacy = {
      ...baseBooking,
      pricing_breakdown: [
        {label: '2 × Close Protection Officer', amount_eur: 200},
        {label: '1 × Vehicle & Driver', amount_eur: 40},
        {label: 'Medical Support', amount_eur: 90},
      ],
      rate_eur_per_hour: null, total_eur: null,
    };
    const {svc} = makeSvc(detailDb(legacy), {
      pricing: {config: jest.fn().mockResolvedValue(DEFAULT_SERVICE_PRICING), calculate: jest.fn()},
    });
    const out = await svc.getBookingDetail('b1', GLOBAL_ADMIN) as {
      price_breakdown: {rate_eur_per_hour: number; total_eur: number};
    };
    expect(out.price_breakdown.rate_eur_per_hour).toBe(330);   // 200 + 40 + 90
    expect(out.price_breakdown.total_eur).toBe(990);           // × 3 h
  });

  it('a persisted breakdown that does not match the booking shape falls back rather than mislabelling money', async () => {
    const mismatched = {
      ...baseBooking,
      // Three structural slots (cpo, vehicle, medical) but only one stored line.
      pricing_breakdown: [{label: 'Legacy flat rate', amount_eur: 292}],
      rate_eur_per_hour: '292', total_eur: '876',
    };
    const calculate = jest.fn((input, cfg) => new PricingService().calculate(input, cfg));
    const {svc} = makeSvc(detailDb(mismatched), {
      pricing: {config: jest.fn().mockResolvedValue(DEFAULT_SERVICE_PRICING), calculate},
    });
    const out = await svc.getBookingDetail('b1', GLOBAL_ADMIN) as {price_breakdown: {items: unknown[]}};
    expect(calculate).toHaveBeenCalled();
    expect(out.price_breakdown.items).toHaveLength(3);
  });

  it('stays null for non-exec services', async () => {
    const {svc} = makeSvc(detailDb({...baseBooking, service: 'secure_transfer'}));
    const out = await svc.getBookingDetail('b1', GLOBAL_ADMIN) as {price_breakdown: unknown};
    expect(out.price_breakdown).toBeNull();
  });
});

// ─── E2E-41 — ops dispatch wakes the client too ────────────────────────────

describe('E2E-41 — ops dispatch tells the client a crew was assigned', () => {
  it('pushes crewAssigned to the principal alongside missionDispatched to each agent', async () => {
    const db = makeDb({
      qOne: sql => {
        if (/FROM lite_bookings WHERE id = \$1 FOR UPDATE/.test(sql)) {
          return {
            status: 'CONFIRMED', cpo_count: 1, region_code: 'AE', driver_only: true,
            vehicle_count: 0, service: 'secure_transfer', client_id: 'client-7',
          };
        }
        if (/FROM jobs WHERE booking_id/.test(sql)) return {id: 'job-1'};
        if (/FROM missions WHERE booking_id/.test(sql)) return null;
        if (/INSERT INTO missions/.test(sql)) return {id: 'm-1'};
        if (/SELECT conversation_id FROM lite_bookings/.test(sql)) return null;
        return null;
      },
      q: sql => {
        if (/FROM job_applications/.test(sql) && /SELECT/.test(sql)) {
          return [{id: 'a1', agent_id: 'g1', status: 'PENDING', job_id: 'job-1'}];
        }
        if (/SET status = 'LIVE'/.test(sql)) return [{id: 'b1'}];
        return [];
      },
    }).db;
    const bookingPush = {
      bookingApproved: jest.fn().mockResolvedValue(undefined),
      missionDispatched: jest.fn().mockResolvedValue(undefined),
      crewAssigned: jest.fn().mockResolvedValue(undefined),
    };
    const {svc} = makeSvc(db, {bookingPush});

    const out = await svc.dispatchBooking('b1', GLOBAL_ADMIN, {applicationIds: ['a1']});

    expect(out).toEqual(expect.objectContaining({ok: true, status: 'LIVE', mission_id: 'm-1'}));
    expect(bookingPush.missionDispatched).toHaveBeenCalledWith('g1', 'm-1', 'b1');
    // The half that was missing — same bridge + kind the agency path uses.
    expect(bookingPush.crewAssigned).toHaveBeenCalledWith('client-7', 'b1');
  });
});

describe('B-809 — approving a JOB-FEED booking wakes the providers who can see it', () => {
  const HOUR6 = 6 * 60 * 60 * 1000;
  function row(over: Record<string, unknown> = {}) {
    return {
      status: 'PENDING_OPS', client_id: 'c-1', pickup_address: 'A', dropoff_address: 'B',
      pickup_time: new Date(Date.now() + HOUR6), total_aed: '500', region_code: 'AE',
      dispatch_mode: null, booking_mode: 'now', service: 'secure_transfer',
      ...over,
    };
  }
  const board = {config: jest.fn().mockResolvedValue({...DEFAULT_SERVICE_PRICING}), calculate: jest.fn()};
  const push = () => ({
    bookingApproved: jest.fn().mockResolvedValue(undefined),
    jobPublished: jest.fn().mockResolvedValue(undefined),
  });
  const flush = () => new Promise(r => setTimeout(r, 0));

  it('job-feed lane: every ACTIVE agent in the job\'s region (or with no region) is woken with booking + job ids', async () => {
    const {db, qCalls} = makeDb({
      qOne: sql => /FROM lite_bookings WHERE id = \$1 FOR UPDATE/.test(sql) ? row() : null,
      q: sql => /UPDATE lite_bookings/.test(sql) ? [{id: 'b1'}]
        : /FROM public\.agents/.test(sql) ? [{user_id: 'p-1'}, {user_id: 'p-2'}] : [],
    });
    const bookingPush = push();
    const jobFeed = {publishFromBooking: jest.fn().mockResolvedValue({id: 'j-1', short_code: 'JF-1'})};
    const {svc} = makeSvc(db, {pricing: board, bookingPush, jobFeed});
    const out = await svc.approveBooking('b1', GLOBAL_ADMIN, 'tactical suit only');
    expect(out.dispatch_path).toBe('job_feed');
    await flush();
    expect(bookingPush.jobPublished).toHaveBeenCalledWith(['p-1', 'p-2'], 'b1', 'j-1');
    // The recipient query = the accounts that APPLY to marketplace jobs. CRITIC P0:
    // a type-less "ACTIVE, region or NULL" query woke every org-managed CPO
    // (type='cpo', region NULL) in every country, into a shell with no marketplace.
    const q = qCalls.find(c => /FROM public\.agents/.test(c.sql));
    expect(q).toBeDefined();
    expect(q!.sql).toMatch(/type = 'company'/);
    expect(q!.sql).toMatch(/status IN \('ACTIVE', 'APPROVED'\)/);
    expect(q!.sql).toMatch(/region_code = \$1 OR region_code IS NULL/);
    expect(q!.sql).toMatch(/LIMIT 500/);
    expect(q!.sql).not.toMatch(/last_location_at/); // GPS-freshness ordering would cut agency desks (no fix) under the cap
    expect(q!.params).toEqual(['AE']);
    // The client still gets its own approval wake.
    expect(bookingPush.bookingApproved).toHaveBeenCalledWith('c-1', 'b1', 'OPS_APPROVED');
  });

  it('staging-only DISPATCH_DISABLE_REGION_FILTER drops the region clause and its param (never in production)', async () => {
    const prev = {flag: process.env.DISPATCH_DISABLE_REGION_FILTER, env: process.env.NODE_ENV};
    try {
      process.env.DISPATCH_DISABLE_REGION_FILTER = 'true';
      process.env.NODE_ENV = 'test';
      const {db, qCalls} = makeDb({
        qOne: sql => /FROM lite_bookings WHERE id = \$1 FOR UPDATE/.test(sql) ? row() : null,
        q: sql => /UPDATE lite_bookings/.test(sql) ? [{id: 'b1'}] : /FROM public\.agents/.test(sql) ? [{user_id: 'p-9'}] : [],
      });
      const bookingPush = push();
      const jobFeed = {publishFromBooking: jest.fn().mockResolvedValue({id: 'j-1', short_code: 'JF-1'})};
      const {svc} = makeSvc(db, {pricing: board, bookingPush, jobFeed});
      await svc.approveBooking('b1', GLOBAL_ADMIN, 'tactical suit only');
      await flush();
      const q = qCalls.find(c => /FROM public\.agents/.test(c.sql))!;
      expect(q.sql).not.toMatch(/region_code/);
      expect(q.params).toEqual([]);
      expect(bookingPush.jobPublished).toHaveBeenCalledWith(['p-9'], 'b1', 'j-1');
      // Production ignores the flag even if set.
      process.env.NODE_ENV = 'production';
      const second = makeDb({
        qOne: sql => /FROM lite_bookings WHERE id = \$1 FOR UPDATE/.test(sql) ? row() : null,
        q: sql => /UPDATE lite_bookings/.test(sql) ? [{id: 'b1'}] : [],
      });
      const {svc: svc2} = makeSvc(second.db, {pricing: board, bookingPush: push(), jobFeed});
      await svc2.approveBooking('b1', GLOBAL_ADMIN, 'tactical suit only');
      await flush();
      expect(second.qCalls.find(c => /FROM public\.agents/.test(c.sql))!.params).toEqual(['AE']);
    } finally {
      if (prev.flag === undefined) {delete process.env.DISPATCH_DISABLE_REGION_FILTER;} else {process.env.DISPATCH_DISABLE_REGION_FILTER = prev.flag;}
      process.env.NODE_ENV = prev.env;
    }
  });

  it('job-feed lane: a publish failure wakes nobody (there is no job to open)', async () => {
    const {db} = makeDb({
      qOne: sql => /FROM lite_bookings WHERE id = \$1 FOR UPDATE/.test(sql) ? row() : null,
      q: sql => /UPDATE lite_bookings/.test(sql) ? [{id: 'b1'}] : [{user_id: 'p-1'}],
    });
    const bookingPush = push();
    const jobFeed = {publishFromBooking: jest.fn().mockRejectedValue(new Error('boom'))};
    const {svc} = makeSvc(db, {pricing: board, bookingPush, jobFeed});
    const out = await svc.approveBooking('b1', GLOBAL_ADMIN, 'tactical suit only');
    expect(out.job_published).toBe(false);
    await flush();
    expect(bookingPush.jobPublished).not.toHaveBeenCalled();
  });

  it('auto-dispatch lane is untouched: the cascade offers ONE agency at a time, no broadcast', async () => {
    const {db} = makeDb({
      qOne: sql => /FROM lite_bookings WHERE id = \$1 FOR UPDATE/.test(sql) ? row({dispatch_mode: 'auto', booking_mode: 'later'}) : null,
      q: sql => /UPDATE lite_bookings/.test(sql) ? [{id: 'b1'}] : [{user_id: 'p-1'}],
    });
    const bookingPush = push();
    const {svc} = makeSvc(db, {pricing: board, bookingPush});
    const out = await svc.approveBooking('b1', GLOBAL_ADMIN, 'tactical suit only');
    expect(out.dispatch_path).toBe('auto_scheduled');
    await flush();
    expect(bookingPush.jobPublished).not.toHaveBeenCalled();
  });
});
