/**
 * E2E-08 / E2E-50 — the two ops-side gaps around a reserved date.
 *
 * E2E-08: listMissionRequests filtered status='REQUESTED' only, so ops had no
 * surface anywhere that answered "what protection is running today?". Widened
 * ADDITIVELY — the REQUESTED rows keep their fields and their oldest-first
 * order and still sort first, so a console that ignores the new rows is unchanged.
 *
 * E2E-50: scheduleRequestWithCpos created ONE assignment row spanning
 * dates[0]→dates[last]. pro_cpo_assignments carries a gist exclusion over
 * (cpo_user_id, daterange), so reserving the 3rd and the 9th locked the officer
 * out of the 4th–8th, which nobody had booked.
 */
import {ProManagementService, contiguousRuns} from './pro-management.service';
import {OpsService} from '../ops/ops.service';
import type {DatabaseService} from '../database/database.service';
import type {AdminContext} from '../ops/admin.guard';
import {GULF_TODAY_SQL} from '../pro-applications/gulf-day';

const ADMIN = {user_id: 'admin-1', call_sign: 'OPS'} as unknown as AdminContext;

function mk(dates: string[]) {
  const qCalls: Array<{sql: string; params?: unknown[]}> = [];
  const qOneCalls: Array<{sql: string; params?: unknown[]}> = [];
  const inserted: Array<{cpo: string; starts_on: string; ends_on: string}> = [];
  const db = {
    q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qCalls.push({sql, params});
      if (/FROM users WHERE id = ANY/.test(sql)) {
        return Promise.resolve([{id: 'cpo-1', display_name: 'Vinod'}]);
      }
      return Promise.resolve([]); // no conflicts, no covering rows
    }),
    qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qOneCalls.push({sql, params});
      if (/FROM pro_plan_missions WHERE id/.test(sql)) {
        return Promise.resolve({id: 'msn-1', status: 'REQUESTED', mission_dates: dates});
      }
      // getActiveMission's restore lookup (MISSION_VIEW_SELECT). The window is
      // 2026-10-05..06, so live_today is TRUE on the Gulf day and FALSE on UTC.
      if (/ORDER BY pca\.starts_on ASC/.test(sql) && /LIMIT 1/.test(sql)) {
        return Promise.resolve({
          id: 'asg-live', application_id: 'app-1', mission_id: 'msn-1',
          cpo_user_id: 'cpo-1', org_user_id: 'org-1',
          starts_on: '2026-10-05', ends_on: '2026-10-06',
          status: 'ASSIGNED', mission_code: 'PMC-AAAAAA', note: null,
          created_at: 'now', authorized_at: 'then', revoked_at: null,
          member_name: 'Member', member_avatar: null, coverage_area: 'Dubai',
        });
      }
      if (/FROM pro_applications WHERE id/.test(sql)) {
        return Promise.resolve({user_id: 'client-1', status: 'ACTIVE'});
      }
      if (/FROM agents WHERE user_id/.test(sql)) {return Promise.resolve({status: 'ACTIVE'});}
      if (/FROM org_members/.test(sql)) {
        return Promise.resolve({org_user_id: 'org-1', status: 'active', suspended_until: null});
      }
      if (/@> daterange/.test(sql)) {return Promise.resolve(null);} // nothing covers it yet
      if (/INSERT INTO pro_cpo_assignments/.test(sql)) {
        inserted.push({cpo: String(params?.[2]), starts_on: String(params?.[4]), ends_on: String(params?.[5])});
        return Promise.resolve({
          id: `asg-${inserted.length}`, application_id: 'app-1', mission_id: 'msn-1',
          cpo_user_id: params?.[2], org_user_id: 'org-1',
          starts_on: params?.[4], ends_on: params?.[5],
          status: 'ASSIGNED', mission_code: 'PMC-AAAAAA', note: null, created_at: 'now',
        });
      }
      if (/UPDATE pro_plan_missions/.test(sql)) {
        return Promise.resolve({id: 'msn-1', status: 'SCHEDULED', assigned_team: [], ops_note: null});
      }
      return Promise.resolve(null);
    }),
  } as unknown as DatabaseService;
  const svc = new ProManagementService(
    db, {} as never, {} as never,
    {broadcast: jest.fn().mockResolvedValue(undefined)} as never,
    {proMissionUpdate: jest.fn().mockResolvedValue(undefined)} as never,
  );
  return {svc, qCalls, qOneCalls, inserted};
}

describe('contiguousRuns — the E2E-50 primitive', () => {
  it('splits on every gap and merges consecutive days', () => {
    expect(contiguousRuns(['2030-01-03', '2030-01-04', '2030-01-09']))
      .toEqual([['2030-01-03', '2030-01-04'], ['2030-01-09', '2030-01-09']]);
  });

  it('a single date is a one-day run', () => {
    expect(contiguousRuns(['2030-01-03'])).toEqual([['2030-01-03', '2030-01-03']]);
  });

  it('crosses a month boundary as ONE run (the successor is calendar-aware)', () => {
    expect(contiguousRuns(['2030-01-31', '2030-02-01'])).toEqual([['2030-01-31', '2030-02-01']]);
  });

  it('crosses a leap day as ONE run', () => {
    expect(contiguousRuns(['2032-02-28', '2032-02-29', '2032-03-01']))
      .toEqual([['2032-02-28', '2032-03-01']]);
  });
});

describe('scheduleRequestWithCpos — one row per contiguous run (E2E-50)', () => {
  it('two dates a month apart become TWO windows, not one month-long lock', async () => {
    const {svc, inserted} = mk(['2030-01-03', '2030-02-09']);
    const out = await svc.scheduleRequestWithCpos(ADMIN, 'app-1', 'msn-1', {cpo_user_ids: ['cpo-1']});

    expect(inserted).toEqual([
      {cpo: 'cpo-1', starts_on: '2030-01-03', ends_on: '2030-01-03'},
      {cpo: 'cpo-1', starts_on: '2030-02-09', ends_on: '2030-02-09'},
    ]);
    expect((out.assignments as unknown[]).length).toBe(2);
  });

  it('consecutive dates still collapse into ONE window', async () => {
    const {svc, inserted} = mk(['2030-01-03', '2030-01-04', '2030-01-05']);
    await svc.scheduleRequestWithCpos(ADMIN, 'app-1', 'msn-1', {cpo_user_ids: ['cpo-1']});
    expect(inserted).toEqual([{cpo: 'cpo-1', starts_on: '2030-01-03', ends_on: '2030-01-05'}]);
  });

  it('the overlap pre-check runs PER RUN (a clash on any one is still a 409)', async () => {
    const {svc, qCalls} = mk(['2030-01-03', '2030-02-09']);
    await svc.scheduleRequestWithCpos(ADMIN, 'app-1', 'msn-1', {cpo_user_ids: ['cpo-1']});
    const checks = qCalls.filter(c => /&& daterange/.test(c.sql));
    expect(checks).toHaveLength(2);
    expect(checks.map(c => [c.params?.[1], c.params?.[2]])).toEqual([
      ['2030-01-03', '2030-01-03'],
      ['2030-02-09', '2030-02-09'],
    ]);
  });

  it('the derived team counts OFFICERS, not assignment rows', async () => {
    const {svc, qOneCalls} = mk(['2030-01-03', '2030-02-09']);
    await svc.scheduleRequestWithCpos(ADMIN, 'app-1', 'msn-1', {cpo_user_ids: ['cpo-1']});
    const upd = qOneCalls.find(c => /UPDATE pro_plan_missions/.test(c.sql))!;
    expect(JSON.parse(String(upd.params?.[2]))).toEqual([
      {role: 'Close Protection Officer', count: 1, label: 'Vinod'},
    ]);
  });
});

describe('no UTC "today" survives in this service (E2E-09)', () => {
  it('the CPO mission view computes live_today on the GULF day', async () => {
    // 2026-10-04 20:00 UTC — the 5th in the Gulf. authorizedAssignment admits
    // the officer on GULF_TODAY_SQL, so a UTC live_today here returned false for
    // the very row the same call had just matched.
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-04T20:00:00.000Z'));
    try {
      const {svc} = mk([]);
      const out = await svc.getActiveMission('cpo-1') as {live_today: boolean};
      expect(out.live_today).toBe(true);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('listPool defaults its window to the Gulf day', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-04T20:00:00.000Z'));
    try {
      const {svc, qCalls} = mk([]);
      await svc.listPool();
      const pool = qCalls.find(c => /AS busy_in_window/.test(c.sql))!;
      expect(pool.params).toEqual(['2026-10-05', '2026-10-05', null]);
    } finally {
      jest.restoreAllMocks();
    }
  });
});

describe('listMissionRequests — ops can SEE reserved dates (E2E-08)', () => {
  const queries = (qCalls: Array<{sql: string}>) =>
    qCalls.filter(c => /FROM pro_plan_missions pm/.test(c.sql)).map(c => c.sql);

  it('reserved_today is a SIBLING key — the REQUESTED queue is untouched', async () => {
    const {svc, qCalls} = mk([]);
    const out = await svc.listMissionRequests();
    expect(out).toHaveProperty('requests');
    expect(out).toHaveProperty('reserved_today');

    // Why a sibling and not a wider array: the console renders EVERY row of
    // `requests` as "AWAITING OFFICERS" with ASSIGN/DECLINE, so a SCHEDULED row
    // in there would be mislabelled and offer actions the server refuses.
    const [requestsSql] = queries(qCalls);
    expect(requestsSql).toMatch(/WHERE pm\.status = 'REQUESTED' AND pa\.status = 'ACTIVE'\s+ORDER BY pm\.created_at ASC/);
    expect(requestsSql).not.toMatch(/SCHEDULED/);
    for (const col of ['pm.id', 'pm.application_id', 'pm.note', 'pm.status', 'pm.created_at',
      'member_name', 'requested_by_name']) {
      expect(requestsSql).toContain(col);
    }
  });

  it('reserved_today lists SCHEDULED dates landing today/tomorrow on the Gulf day', async () => {
    const {svc, qCalls} = mk([]);
    await svc.listMissionRequests();
    const todaySql = queries(qCalls)[1];

    expect(todaySql).toMatch(/pm\.status = 'SCHEDULED'/);
    expect(todaySql).toContain(`d BETWEEN ${GULF_TODAY_SQL} AND ${GULF_TODAY_SQL} + 1`);
    // The E2E-08 question ops could not answer: is anyone actually assigned?
    expect(todaySql).toMatch(/AS officers_today/);
    expect(todaySql).toMatch(/pm\.activated_at/);
    expect(todaySql).not.toMatch(/CURRENT_DATE/);
  });

  it('every row names its OWN date and counts cover on THAT date, not on today', async () => {
    const {svc, qCalls} = mk([]);
    await svc.listMissionRequests();
    const todaySql = queries(qCalls)[1];

    // `win.d` = the date that put the row in the set (earliest inside
    // [today, tomorrow]), so the console never has to infer it and never has to
    // read `first_date`, which is the min over ALL dates and can be in the past.
    expect(todaySql).toMatch(/win\.d::text AS date/);
    expect(todaySql).toMatch(/CROSS JOIN LATERAL/);
    expect(todaySql).toMatch(/ORDER BY win\.d ASC/);
    expect(todaySql).toContain(`(win.d = ${GULF_TODAY_SQL}) AS is_today`);

    // The alert basis: a TOMORROW row staffed by an assignment starting
    // tomorrow must not read as unstaffed. officers_on_date keys on win.d;
    // officers_today keeps keying on today for compatibility.
    expect(todaySql).toMatch(/win\.d BETWEEN pca\.starts_on AND pca\.ends_on\) AS officers_on_date/);
    expect(todaySql).toContain(
      `${GULF_TODAY_SQL} BETWEEN pca.starts_on AND pca.ends_on) AS officers_today`);
  });

  it('one row per mission — the LATERAL cannot fan a multi-date reservation out', async () => {
    const {svc, qCalls} = mk([]);
    await svc.listMissionRequests();
    const todaySql = queries(qCalls)[1];
    // min() over a possibly-empty set is one row (NULL when nothing qualifies),
    // so a mission covering BOTH today and tomorrow still yields a single row
    // and a console keyed on pm.id keeps unique keys. The filter is that NULL.
    expect(todaySql).toMatch(/SELECT min\(d\) AS d FROM unnest\(pm\.mission_dates\) d/);
    expect(todaySql).toMatch(/WHERE pm\.status = 'SCHEDULED' AND win\.d IS NOT NULL/);
  });

  it('B-841: the Requests queue and the dashboard badge count REQUESTED dates on ACTIVE plans only', async () => {
    // A SQL-string scan on both emitted queries — this suite executes no SQL.
    // The badge (ops dashboard KPI) and the queue it points at (Assignments)
    // must share ONE predicate, or the sidebar number and the page disagree
    // the way B-593 did. Prior art for the predicate itself: escalateUnassigned
    // and activateToday already require the parent plan to be ACTIVE.
    const {svc, qCalls} = mk([]);
    await svc.listMissionRequests();
    const [requestsSql] = queries(qCalls);
    expect(requestsSql).toMatch(/JOIN pro_applications pa ON pa\.id = pm\.application_id/);
    expect(requestsSql).toMatch(/pm\.status = 'REQUESTED' AND pa\.status = 'ACTIVE'/);

    const kpiCalls: string[] = [];
    const opsDb = {
      q: jest.fn().mockResolvedValue([]),
      qOne: jest.fn().mockImplementation((sql: string) => {
        kpiCalls.push(sql);
        return Promise.resolve(null);
      }),
    };
    const ops = new OpsService(
      opsDb as never, {} as never, {} as never, {} as never, {} as never,
      {recentFeed: jest.fn().mockResolvedValue([])} as never,
      {} as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never, {} as never,
    );
    await ops.dashboard();
    const kpiSql = kpiCalls.find(s => /AS pro_requests/.test(s)) ?? '';
    expect(kpiSql).toMatch(/JOIN pro_applications pa ON pa\.id = pm\.application_id/);
    expect(kpiSql).toMatch(/pm\.status = 'REQUESTED' AND pa\.status = 'ACTIVE'\) AS pro_requests/);
  });
});
