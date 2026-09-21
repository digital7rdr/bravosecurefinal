/**
 * Ops-surface projections of ProApplicationsService (audit 2026-08-07):
 *  - F1  (SK-01/CA-02/IS-01): both ops projections carry the derived
 *    covered_until alias so no surface renders the off-by-one
 *    current_period_end directly.
 *  - F2  (SK-07/IS-03): getForOps returns the applicant's linked family
 *    members (queried by holder_id = applicant).
 *  - F3  (IS-02): getForOps resolves decided_by to a display identity.
 *  - F16 (IS-08/CA-10): actionable buckets list oldest-first; everything
 *    else stays newest-first.
 * DatabaseService is mocked — the SQL text and bind values ARE the behavior
 * a unit test can honestly pin here (same rationale as booking.list.spec.ts).
 */
import {ProApplicationsService} from './pro-applications.service';
import type {DatabaseService} from '../database/database.service';

function mk() {
  const qCalls: Array<{sql: string; params?: unknown[]}> = [];
  const qOneCalls: Array<{sql: string; params?: unknown[]}> = [];
  const db = {
    q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qCalls.push({sql, params});
      return Promise.resolve([]);
    }),
    qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qOneCalls.push({sql, params});
      if (/FROM pro_applications pa/.test(sql)) {
        return Promise.resolve({id: 'app-1', user_id: 'client-1', status: 'ACTIVE'});
      }
      return Promise.resolve(null);
    }),
    withTransaction: jest.fn(),
  } as unknown as DatabaseService;
  const svc = new ProApplicationsService(
    db, {} as never, {} as never,
    {broadcast: jest.fn().mockResolvedValue(undefined)} as never,
    {} as never,
    {emit: jest.fn().mockResolvedValue(undefined), record: jest.fn().mockResolvedValue(undefined)} as never,
  );
  return {svc, db, qCalls, qOneCalls};
}

const listSql = (qCalls: Array<{sql: string}>) =>
  qCalls.find(c => /LEFT JOIN LATERAL/.test(c.sql) && /u\.display_name AS client_name/.test(c.sql))?.sql ?? '';

describe('ProApplicationsService — ops projections', () => {
  it('listForOps carries the derived covered_until (never raw current_period_end alone)', async () => {
    const {svc, qCalls} = mk();
    await svc.listForOps('all');
    const sql = listSql(qCalls);
    expect(sql).toMatch(/current_period_end - interval '1 day'.*AS covered_until/);
    expect(sql).toMatch(/pa\.activated_at/);
  });

  it('listForOps orders the actionable buckets oldest-first (queue drains fairly)', async () => {
    const {svc, qCalls} = mk();
    await svc.listForOps('PENDING_PROPOSAL');
    expect(listSql(qCalls)).toMatch(/ORDER BY pa\.submitted_at ASC/);
  });

  it('listForOps keeps REVISION_REQUESTED oldest-first too', async () => {
    const {svc, qCalls} = mk();
    await svc.listForOps('REVISION_REQUESTED');
    expect(listSql(qCalls)).toMatch(/ORDER BY pa\.submitted_at ASC/);
  });

  it('listForOps keeps every non-actionable view newest-first', async () => {
    const {svc, qCalls} = mk();
    await svc.listForOps('ACTIVE');
    expect(listSql(qCalls)).toMatch(/ORDER BY pa\.submitted_at DESC/);
  });

  it('getForOps projects covered_until + the decided_by identity join', async () => {
    const {svc, qOneCalls} = mk();
    await svc.getForOps('app-1');
    const appSql = qOneCalls.find(c => /FROM pro_applications pa/.test(c.sql))?.sql ?? '';
    expect(appSql).toMatch(/AS covered_until/);
    expect(appSql).toMatch(/du\.display_name AS decided_by_name/);
    expect(appSql).toMatch(/du\.email AS decided_by_email/);
  });

  it('getForOps returns the applicant family block, queried by holder_id = applicant', async () => {
    const {svc, qCalls} = mk();
    const out = await svc.getForOps('app-1');
    expect(out).toHaveProperty('family');
    const fam = qCalls.find(c => /FROM public\.family_members fm/.test(c.sql));
    expect(fam).toBeDefined();
    expect(fam!.sql).toMatch(/fm\.held_until/);
    expect(fam!.params).toEqual(['client-1']);
    // A11 — the roster is unlimited now, so the ride-along is capped and the
    // real size travels separately (the card links to the full roster).
    expect(fam!.sql).toMatch(/LIMIT 50/);
    expect(out).toHaveProperty('family_total');
    // B-833 — no relationship badge on the wire.
    expect(fam!.sql).not.toMatch(/fm\.relationship/);
  });
});

/**
 * Dedicated-officer fast path (founder 2026-08-10): a Pro member whose plan
 * already has an ops-assigned officer covering the requested dates must NOT
 * land back in the ops queue — the request routes straight to that officer.
 * Before this, the member's own dedicated officer read as BUSY in the ops
 * pool (his dedication window to this very member) and the request dead-ended.
 */
function mkMission(dedicated: Array<{cpo_user_id: string; cpo_name: string | null}>) {
  const qCalls: Array<{sql: string; params?: unknown[]}> = [];
  const qOneCalls: Array<{sql: string; params?: unknown[]}> = [];
  const db = {
    q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qCalls.push({sql, params});
      if (/FROM pro_cpo_assignments/.test(sql)) {return Promise.resolve(dedicated);}
      return Promise.resolve([]);
    }),
    qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qOneCalls.push({sql, params});
      if (/FROM pro_applications WHERE id/.test(sql)) {
        return Promise.resolve({id: 'app-1', user_id: 'client-1', status: 'ACTIVE'});
      }
      if (/FROM pro_proposals/.test(sql)) {
        return Promise.resolve({
          id: 'prop-1', proposal_number: 'P-1', version: 1, valid_until: '2031-01-01',
          coverage_start: '2030-01-01', coverage_end: '2030-12-31', total_credits: 100,
        });
      }
      if (/INSERT INTO pro_plan_missions/.test(sql)) {
        return Promise.resolve({
          id: 'msn-1', application_id: 'app-1', requested_by: 'client-1',
          mission_dates: params?.[2] ?? [], note: null,
          status: /'SCHEDULED'/.test(sql) ? 'SCHEDULED' : 'REQUESTED',
          assigned_team: [], ops_note: null, created_at: 'now',
        });
      }
      return Promise.resolve(null);
    }),
    withTransaction: jest.fn(),
  } as unknown as DatabaseService;
  const push = {proMissionUpdate: jest.fn().mockResolvedValue(undefined)};
  const svc = new ProApplicationsService(
    db, {} as never, {} as never,
    {broadcast: jest.fn().mockResolvedValue(undefined)} as never,
    push as never,
    {emit: jest.fn().mockResolvedValue(undefined), record: jest.fn().mockResolvedValue(undefined)} as never,
  );
  return {svc, qCalls, qOneCalls, push};
}

/**
 * B-843 (A12) — the Pro ride-along with SEVERAL roots.
 *
 * A member with no plan of their own rides an owner's ACTIVE plan. The lookup
 * used to be a bare `qOne` over "my active memberships", which with two roots
 * picks an ARBITRARY one — and if that one has no plan, the member is locked
 * OUT of Pro that their OTHER root actually pays for. Worse, `useProPlanGate`
 * refetches on every focus and `replace()`s the member out of Pro the moment
 * `planActive` flips, so an unordered read ejects them at random.
 *
 * Two fixes, both load-bearing: an EXISTS that narrows to roots WITH a live
 * plan, and an ORDER BY that makes the winner deterministic.
 */
describe('B-843 (A12) — the Pro ride-along is plan-aware and deterministic', () => {
  function mkMine(holder: {holder_id: string; holder_name: string | null} | null,
                  ownerApp: Record<string, unknown> | null) {
    const seen: Array<{sql: string; params?: unknown[]}> = [];
    const db = {
      q: jest.fn().mockResolvedValue([]),
      qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
        seen.push({sql, params});
        // The member has NO application of their own.
        if (/FROM pro_applications\s+WHERE user_id = \$1 ORDER BY submitted_at DESC LIMIT 1/.test(sql)) {
          return Promise.resolve(null);
        }
        if (/FROM public\.family_members fm/.test(sql)) {return Promise.resolve(holder);}
        if (/FROM pro_applications\s+WHERE user_id = \$1 AND status = 'ACTIVE'/.test(sql)) {
          return Promise.resolve(ownerApp);
        }
        return Promise.resolve(null);
      }),
      withTransaction: jest.fn(),
    } as unknown as DatabaseService;
    const svc = new ProApplicationsService(
      db, {} as never, {} as never,
      {broadcast: jest.fn().mockResolvedValue(undefined)} as never,
      {} as never,
      {emit: jest.fn().mockResolvedValue(undefined), record: jest.fn().mockResolvedValue(undefined)} as never,
    );
    return {svc, seen};
  }
  const famSql = (seen: Array<{sql: string}>) =>
    seen.find(c => /FROM public\.family_members fm/.test(c.sql))!.sql.replace(/\s+/g, ' ');

  it('narrows to roots that actually HAVE a live plan (EXISTS), not just to any membership', async () => {
    const {svc, seen} = mkMine({holder_id: 'h1', holder_name: 'Root A'},
                               {id: 'app-9', user_id: 'h1', status: 'ACTIVE'});
    const out = await svc.getMine('u-member');
    expect(out.application).toMatchObject({via_owner: {name: 'Root A'}});
    const sql = famSql(seen);
    // Without this, a member in {root with plan, root without} can resolve to
    // the planless one and lose Pro entirely.
    expect(sql).toContain('AND EXISTS (SELECT 1 FROM pro_applications pa');
    expect(sql).toContain('WHERE pa.user_id = fm.holder_id');
    expect(sql).toContain(`pa.status = 'ACTIVE'`);
  });

  it('picks the OLDEST such membership deterministically (LIMIT 1 with an ORDER BY)', async () => {
    const {svc, seen} = mkMine({holder_id: 'h1', holder_name: 'Root A'},
                               {id: 'app-9', user_id: 'h1', status: 'ACTIVE'});
    await svc.getMine('u-member');
    const sql = famSql(seen);
    expect(sql).toContain('ORDER BY fm.accepted_at ASC NULLS LAST, fm.id ASC');
    expect(sql).toContain('LIMIT 1');
    // A LIMIT without an ORDER BY is not determinism, it is luck.
    expect(sql.indexOf('ORDER BY')).toBeLessThan(sql.indexOf('LIMIT 1'));
  });

  it('still requires the membership to be ACTIVE and not held', async () => {
    const {svc, seen} = mkMine({holder_id: 'h1', holder_name: 'Root A'},
                               {id: 'app-9', user_id: 'h1', status: 'ACTIVE'});
    await svc.getMine('u-member');
    const sql = famSql(seen);
    expect(sql).toContain(`fm.status = 'active'`);
    expect(sql).toContain('fm.held_until IS NULL OR fm.held_until <= NOW()');
  });

  it('no qualifying root → no application (and the owner-plan read is never reached)', async () => {
    const {svc, seen} = mkMine(null, {id: 'app-9', user_id: 'h1', status: 'ACTIVE'});
    await expect(svc.getMine('u-member')).resolves.toEqual({application: null, history: []});
    expect(seen.some(c => /WHERE user_id = \$1 AND status = 'ACTIVE'/.test(c.sql))).toBe(false);
  });

  it('a nameless holder still badges (never renders "undefined")', async () => {
    const {svc} = mkMine({holder_id: 'h1', holder_name: null},
                         {id: 'app-9', user_id: 'h1', status: 'ACTIVE'});
    const out = await svc.getMine('u-member');
    expect(out.application).toMatchObject({via_owner: {name: 'Family owner'}});
  });
});

describe('ProApplicationsService — requestMission dedicated-officer fast path', () => {
  it('auto-schedules when an ASSIGNED window for THIS plan covers every requested date', async () => {
    const {svc, qCalls, qOneCalls, push} = mkMission([{cpo_user_id: 'cpo-9', cpo_name: 'Vinod'}]);
    const out = await svc.requestMission('client-1', 'app-1', ['2030-01-12', '2030-01-10']);

    const lookup = qCalls.find(c => /FROM pro_cpo_assignments/.test(c.sql));
    expect(lookup).toBeDefined();
    expect(lookup!.sql).toMatch(/status = 'ASSIGNED'/);
    expect(lookup!.sql).toMatch(/daterange\(pca\.starts_on, pca\.ends_on, '\[\]'\) @> daterange/);
    expect(lookup!.params).toEqual(['app-1', '2030-01-10', '2030-01-12']);

    const ins = qOneCalls.find(c => /INSERT INTO pro_plan_missions/.test(c.sql));
    expect(ins).toBeDefined();
    expect(ins!.sql).toMatch(/'SCHEDULED'/);
    expect(ins!.sql).toMatch(/assigned_team/);
    expect(JSON.stringify(ins!.params)).toContain('Vinod');

    expect(qCalls.some(c => /'system','mission\.scheduled'/.test(c.sql))).toBe(true);
    expect(push.proMissionUpdate).toHaveBeenCalledWith('client-1', 'app-1', 'SCHEDULED');
    expect(out.mission.status).toBe('SCHEDULED');
  });

  it('stays REQUESTED (ops queue) when no covering dedicated window exists', async () => {
    const {svc, qCalls, qOneCalls, push} = mkMission([]);
    const out = await svc.requestMission('client-1', 'app-1', ['2030-01-10']);

    const ins = qOneCalls.find(c => /INSERT INTO pro_plan_missions/.test(c.sql));
    expect(ins).toBeDefined();
    expect(ins!.sql).not.toMatch(/'SCHEDULED'/);
    expect(qCalls.some(c => /'client','mission\.requested'/.test(c.sql))).toBe(true);
    expect(push.proMissionUpdate).not.toHaveBeenCalled();
    expect(out.mission.status).toBe('REQUESTED');
  });
});

describe('ProApplicationsService — listTeam (client projection of the dedicated team)', () => {
  it('is gated by plan access and never projects mission_code', async () => {
    const {svc, qCalls, qOneCalls} = mkMission([]);
    await svc.listTeam('client-1', 'app-1');

    // assertPlanAccess ran (owner lookup on the application row).
    expect(qOneCalls.some(c => /FROM pro_applications WHERE id/.test(c.sql))).toBe(true);

    const teamQ = qCalls.find(c => /FROM pro_cpo_assignments/.test(c.sql));
    expect(teamQ).toBeDefined();
    expect(teamQ!.sql).toMatch(/status = 'ASSIGNED'/);
    expect(teamQ!.sql).toMatch(/AS live_today/);
    expect(teamQ!.sql).not.toMatch(/mission_code/);
    expect(teamQ!.params).toEqual(['app-1']);
  });
});
