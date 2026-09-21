/**
 * E2E-07 / E2E-51 / E2E-52 — the reservation lifecycle a client can actually
 * steer, and what happens when a plan expires under a live session.
 *
 * E2E-07: a SCHEDULED date could not be cancelled by ANYONE — no client route,
 * ops decideMission guarded status='REQUESTED', and CANCELLED was not even in
 * the CHECK. The client calendar kept painting a date booked whose officers had
 * been released. Pinned here:
 *   - the client releases a FUTURE reservation and the rows this date booked
 *     (mission_id = the mission) are released with it,
 *   - the plan's STANDING dedication (mission_id NULL) is NOT released,
 *   - a date that has already started is refused to the client and left to ops,
 *   - ops may cancel from SCHEDULED as well as REQUESTED, and only a cancel may.
 *
 * E2E-51: an expiring plan with a live session emits the ops signal and does
 * NOT kill the session.
 *
 * DatabaseService is mocked, and the mock MODELS the conditional claim — an
 * UPDATE that always returns a row could not tell a real guard from a missing one.
 */
import {ForbiddenException} from '@nestjs/common';
import {ProApplicationsService} from './pro-applications.service';
import type {DatabaseService} from '../database/database.service';
import type {AdminContext} from '../ops/admin.guard';
import {todayGulf} from './gulf-day';

const ADMIN = {user_id: 'admin-1', role: 'SUPERVISOR', call_sign: 'OPS'} as unknown as AdminContext;

const FUTURE = ['2099-06-01', '2099-06-02'];
type Row = Record<string, unknown>;

function mk(opts: {
  mission?: Row | null; member?: Row | null; expired?: Row[];
  liveSession?: Row | null; releaseThrows?: Error; missions?: Row[];
} = {}) {
  const qCalls: Array<{sql: string; params?: unknown[]}> = [];
  const qOneCalls: Array<{sql: string; params?: unknown[]}> = [];
  const mission = 'mission' in opts
    ? opts.mission
    : {id: 'msn-1', application_id: 'app-1', requested_by: 'client-1',
       mission_dates: FUTURE, note: null, status: 'SCHEDULED',
       assigned_team: [], ops_note: null, created_at: 'now', activated_at: null};

  const handle = (sql: string, params?: unknown[]): Promise<unknown> => {
    if (/FROM public\.protection_sessions ps/.test(sql)) {
      return Promise.resolve(opts.liveSession ?? null);
    }
    if (/SELECT[\s\S]*FROM pro_plan_missions WHERE id = \$1/.test(sql)) {
      return Promise.resolve(mission);
    }
    if (/UPDATE pro_plan_missions/.test(sql)) {
      // Model the conditional claim: the status guard is the behaviour.
      const to = /SET status = 'CANCELLED'/.test(sql) ? 'CANCELLED' : String(params?.[2]);
      const allowed = /status IN \('REQUESTED','SCHEDULED'\)/.test(sql)
        ? ['REQUESTED', 'SCHEDULED']
        : (params?.[6] as string[] | undefined) ?? [];
      const current = String((mission as Row | null)?.status ?? '');
      if (!mission || !allowed.includes(current)) {return Promise.resolve(null);}
      return Promise.resolve({...mission, status: to});
    }
    if (/FROM pro_applications WHERE id = \$1 FOR UPDATE/.test(sql)) {
      return Promise.resolve({user_id: 'client-1'});
    }
    if (/FROM pro_applications WHERE id/.test(sql)) {
      return Promise.resolve({id: 'app-1', user_id: 'client-1', status: 'ACTIVE'});
    }
    if (/FROM public\.family_members/.test(sql)) {return Promise.resolve(opts.member ?? null);}
    return Promise.resolve(null);
  };

  const db = {
    q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qCalls.push({sql, params});
      if (/WITH victims AS[\s\S]*pro_applications/.test(sql)) {return Promise.resolve(opts.expired ?? []);}
      if (opts.releaseThrows && /UPDATE pro_cpo_assignments/.test(sql)) {
        return Promise.reject(opts.releaseThrows);
      }
      if (/FROM pro_plan_missions pm/.test(sql)) {return Promise.resolve(opts.missions ?? []);}
      return Promise.resolve([]);
    }),
    qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qOneCalls.push({sql, params});
      return handle(sql, params);
    }),
    withTransaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
        qCalls.push({sql, params});
        return Promise.resolve([]);
      }),
      qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
        qOneCalls.push({sql, params});
        return handle(sql, params);
      }),
    })),
  } as unknown as DatabaseService;

  const push = {proMissionUpdate: jest.fn().mockResolvedValue(undefined)};
  const opsAudit = {
    emit: jest.fn().mockResolvedValue(undefined),
    record: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new ProApplicationsService(
    db, {} as never, {} as never,
    {broadcast: jest.fn().mockResolvedValue(undefined)} as never,
    push as never, opsAudit as never,
  );
  return {svc, qCalls, qOneCalls, push, opsAudit};
}

describe('ProApplicationsService.cancelMission — the client releases a date (E2E-07)', () => {
  it('cancels a future SCHEDULED reservation and pushes the plan owner', async () => {
    const {svc, qOneCalls, push} = mk();
    const out = await svc.cancelMission('client-1', 'app-1', 'msn-1');

    expect(out.mission.status).toBe('CANCELLED');
    const upd = qOneCalls.find(c => /UPDATE pro_plan_missions[\s\S]*'CANCELLED'/.test(c.sql))!;
    expect(upd.sql).toMatch(/status IN \('REQUESTED','SCHEDULED'\)/);
    expect(push.proMissionUpdate).toHaveBeenCalledWith('client-1', 'app-1', 'CANCELLED');
  });

  it('releases only the rows THIS date booked — the standing dedication survives', async () => {
    const {svc, qCalls} = mk();
    await svc.cancelMission('client-1', 'app-1', 'msn-1');

    const rel = qCalls.find(c => /UPDATE pro_cpo_assignments/.test(c.sql))!;
    expect(rel).toBeDefined();
    // Scoped by mission_id: a dedication row carries mission_id NULL and is the
    // plan's ongoing cover, not this date's booking.
    expect(rel.sql).toMatch(/WHERE mission_id = \$1 AND status = 'ASSIGNED'/);
    expect(rel.params).toEqual(['msn-1']);
  });

  it('refuses a date that has already started — ops owns the live day', async () => {
    const {svc, qOneCalls} = mk({mission: {
      id: 'msn-1', application_id: 'app-1', requested_by: 'client-1',
      mission_dates: [todayGulf()], status: 'SCHEDULED', assigned_team: [],
      note: null, ops_note: null, created_at: 'now',
    }});
    await expect(svc.cancelMission('client-1', 'app-1', 'msn-1'))
      .rejects.toMatchObject({message: 'mission_already_started'});
    expect(qOneCalls.some(c => /UPDATE pro_plan_missions/.test(c.sql))).toBe(false);
  });

  it('refuses a terminal reservation', async () => {
    const {svc} = mk({mission: {
      id: 'msn-1', application_id: 'app-1', requested_by: 'client-1',
      mission_dates: FUTURE, status: 'COMPLETED', assigned_team: [],
      note: null, ops_note: null, created_at: 'now',
    }});
    await expect(svc.cancelMission('client-1', 'app-1', 'msn-1'))
      .rejects.toMatchObject({message: 'mission_not_cancellable'});
  });

  it('a stranger with no family link is refused before anything is read', async () => {
    const {svc} = mk({member: null});
    await expect(svc.cancelMission('stranger-9', 'app-1', 'msn-1'))
      .rejects.toMatchObject({message: 'not_your_application'});
  });
});

/**
 * B-852 — the coverage calendar is scoped to the CALLER.
 *
 * Every linked member riding the holder's plan used to read (and release) every
 * reserved date on it, unattributed. The founder's rule is a data-access rule:
 * the HOLDER sees every mission, labelled with its requester; a MEMBER sees only
 * the dates they requested themselves. It is enforced in SQL because the client
 * cannot be trusted to hide rows it was handed.
 *
 * A row whose requested_by is unknown belongs to the holder — `requested_by = $2`
 * simply excludes it from a member's list, and the holder still sees it. The
 * column is NOT NULL in the schema, so the NULL cases below are defence-in-depth
 * on the guards, not a shape the table can currently produce.
 */
describe('ProApplicationsService.listMissions — holder sees all, member sees own (B-852)', () => {
  const listCall = (qCalls: Array<{sql: string; params?: unknown[]}>) =>
    qCalls.find(c => /FROM pro_plan_missions pm/.test(c.sql))!;

  it('the HOLDER gets no requester predicate and binds the application only', async () => {
    const {svc, qCalls} = mk();
    await svc.listMissions('client-1', 'app-1');
    const call = listCall(qCalls);
    expect(call).toBeDefined();
    expect(call.sql).not.toMatch(/requested_by\s*=\s*\$2/);
    expect(call.params).toEqual(['app-1']);
    // ONE page feeds the paint, the BOOKED DAYS chips and the REQUESTS list, and
    // the holder's page now carries every rider's dates — 100 dropped a busy
    // plan's older rows off all three at once. The pair is the pin: a LIMIT
    // without its ORDER BY is not a newest-first page, it is luck.
    expect(call.sql).toMatch(/ORDER BY pm\.created_at DESC LIMIT 300/);
  });

  it('a MEMBER is narrowed to their OWN requests in SQL, not in the client', async () => {
    const {svc, qCalls} = mk({member: {id: 'fm-1'}});
    await svc.listMissions('member-2', 'app-1');
    const call = listCall(qCalls);
    expect(call).toBeDefined();
    expect(call.sql).toMatch(/pm\.requested_by\s*=\s*\$2/);
    expect(call.params).toEqual(['app-1', 'member-2']);
  });

  it('projects the requester name over a LEFT JOIN and passes it through (null stays null)', async () => {
    const {svc, qCalls} = mk({missions: [
      {id: 'msn-1', requested_by: 'member-2', requested_by_name: 'Jack'},
      {id: 'msn-2', requested_by: null, requested_by_name: null},
    ]});
    const out = await svc.listMissions('client-1', 'app-1');
    const call = listCall(qCalls);
    expect(call.sql).toMatch(/LEFT JOIN public\.users ru ON ru\.id = pm\.requested_by/);
    expect(call.sql).toMatch(/ru\.display_name AS requested_by_name/);
    expect(out.missions.map(m => m.requested_by_name)).toEqual(['Jack', null]);
  });
});

describe('ProApplicationsService.cancelMission — a member releases only their OWN date (B-852)', () => {
  // mk()'s default mission is requested_by 'client-1' — the HOLDER's date.
  const MEMBER_MISSION = {
    id: 'msn-1', application_id: 'app-1', requested_by: 'member-2',
    mission_dates: FUTURE, note: null, status: 'SCHEDULED',
    assigned_team: [], ops_note: null, created_at: 'now', activated_at: null,
  };

  it('refuses a member releasing the HOLDER\'s date (403 not_your_mission) and writes nothing', async () => {
    const {svc, qCalls, qOneCalls} = mk({member: {id: 'fm-1'}});
    const err = await svc.cancelMission('member-2', 'app-1', 'msn-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err).toMatchObject({message: 'not_your_mission'});
    expect(qOneCalls.some(c => /UPDATE pro_plan_missions/.test(c.sql))).toBe(false);
    expect(qCalls.some(c => /UPDATE pro_cpo_assignments/.test(c.sql))).toBe(false);
  });

  it('a NULL requested_by counts as the holder\'s — a member may not release it', async () => {
    const {svc} = mk({member: {id: 'fm-1'}, mission: {...MEMBER_MISSION, requested_by: null}});
    await expect(svc.cancelMission('member-2', 'app-1', 'msn-1'))
      .rejects.toMatchObject({message: 'not_your_mission'});
  });

  it('lets the member release the date THEY requested (the owner is still the one told)', async () => {
    const {svc, push} = mk({member: {id: 'fm-1'}, mission: MEMBER_MISSION});
    const out = await svc.cancelMission('member-2', 'app-1', 'msn-1');
    expect(out.mission.status).toBe('CANCELLED');
    expect(push.proMissionUpdate).toHaveBeenCalledWith('client-1', 'app-1', 'CANCELLED');
  });

  it('lets the HOLDER release any date on their plan, including a member\'s', async () => {
    const {svc, qCalls} = mk({mission: MEMBER_MISSION});
    const out = await svc.cancelMission('client-1', 'app-1', 'msn-1');
    expect(out.mission.status).toBe('CANCELLED');
    expect(qCalls.some(c => /UPDATE pro_cpo_assignments/.test(c.sql))).toBe(true);
  });
});

/**
 * B-852 edge 7 — an ops DECISION reaches the person who asked for the date.
 *
 * With the calendar scoped (a member sees only their own dates), a member who is
 * never told their request was scheduled or declined has no other way to learn
 * it: the day-of activation push (pro-mission-activation) already goes to
 * `requested_by`, but nothing in the decide lane did. The plan OWNER is still
 * told either way — it is their plan — so a holder-requested date must stay ONE
 * push, not a duplicate to the same person.
 */
describe('decideMission notifies the requester as well as the owner (B-852)', () => {
  const REQUESTED_BY = (requestedBy: string | null) => ({
    id: 'msn-1', application_id: 'app-1', requested_by: requestedBy,
    mission_dates: FUTURE, note: null, status: 'REQUESTED',
    assigned_team: [], ops_note: null, created_at: 'now', activated_at: null,
  });

  it('a member-requested date tells BOTH the plan owner and the member', async () => {
    const {svc, push} = mk({mission: REQUESTED_BY('member-2')});
    await svc.scheduleMission(ADMIN, 'app-1', 'msn-1', [{role: 'Close Protection Officer', count: 1}]);
    expect(push.proMissionUpdate).toHaveBeenCalledWith('client-1', 'app-1', 'SCHEDULED');
    expect(push.proMissionUpdate).toHaveBeenCalledWith('member-2', 'app-1', 'SCHEDULED');
    expect(push.proMissionUpdate).toHaveBeenCalledTimes(2);
  });

  it('a DECLINE reaches the member too (the decision they most need)', async () => {
    const {svc, push} = mk({mission: REQUESTED_BY('member-2')});
    await svc.declineMission(ADMIN, 'app-1', 'msn-1', 'no cover');
    expect(push.proMissionUpdate).toHaveBeenCalledWith('member-2', 'app-1', 'DECLINED');
    expect(push.proMissionUpdate).toHaveBeenCalledTimes(2);
  });

  it('a holder-requested date is pushed ONCE — never twice to the same person', async () => {
    const {svc, push} = mk({mission: REQUESTED_BY('client-1')});
    await svc.scheduleMission(ADMIN, 'app-1', 'msn-1', []);
    expect(push.proMissionUpdate).toHaveBeenCalledTimes(1);
    expect(push.proMissionUpdate).toHaveBeenCalledWith('client-1', 'app-1', 'SCHEDULED');
  });

  it('a NULL requested_by pushes the owner only (there is no second party)', async () => {
    const {svc, push} = mk({mission: REQUESTED_BY(null)});
    await svc.scheduleMission(ADMIN, 'app-1', 'msn-1', []);
    expect(push.proMissionUpdate).toHaveBeenCalledTimes(1);
    expect(push.proMissionUpdate).toHaveBeenCalledWith('client-1', 'app-1', 'SCHEDULED');
  });
});

describe('ProApplicationsService — ops cancel widens the decision guard (E2E-07)', () => {
  it('ops may cancel a SCHEDULED reservation and releases its officer rows', async () => {
    const {svc, qCalls, qOneCalls, push} = mk();
    const out = await svc.opsCancelMission(ADMIN, 'app-1', 'msn-1', 'client called');

    expect(out.mission.status).toBe('CANCELLED');
    const upd = qOneCalls.find(c => /UPDATE pro_plan_missions/.test(c.sql))!;
    expect(upd.params?.[6]).toEqual(['REQUESTED', 'SCHEDULED']);
    expect(qCalls.some(c => /UPDATE pro_cpo_assignments/.test(c.sql))).toBe(true);
    expect(push.proMissionUpdate).toHaveBeenCalledWith('client-1', 'app-1', 'CANCELLED');
  });

  it('schedule/decline STAY REQUESTED-only — only a cancel may unwind a schedule', async () => {
    const {svc, qOneCalls} = mk();
    await svc.declineMission(ADMIN, 'app-1', 'msn-1').catch(() => undefined);
    const upd = qOneCalls.find(c => /UPDATE pro_plan_missions/.test(c.sql))!;
    expect(upd.params?.[6]).toEqual(['REQUESTED']);
  });

  it('a SCHEDULED row cannot be declined (the conditional claim refuses it)', async () => {
    const {svc, qCalls} = mk();
    await expect(svc.declineMission(ADMIN, 'app-1', 'msn-1'))
      .rejects.toMatchObject({message: 'mission_not_requestable'});
    // and nothing was released
    expect(qCalls.some(c => /UPDATE pro_cpo_assignments/.test(c.sql))).toBe(false);
  });
});

describe('cancel never strands a LIVE session on the officer it releases', () => {
  // The release flips pro_cpo_assignments to CANCELLED, and every officer-side
  // lookup requires ASSIGNED — so a live session riding that row would keep
  // streaming into a session its CPO can no longer see, with no end and no
  // transfer. Same principle as E2E-51: never kill (or orphan) a live detail.
  const LIVE = {id: 'sess-live', cpo_user_id: 'cpo-1'};

  it('ops cancel is REFUSED with a typed error, and nothing is written', async () => {
    const {svc, qCalls, qOneCalls} = mk({liveSession: LIVE});
    await expect(svc.opsCancelMission(ADMIN, 'app-1', 'msn-1'))
      .rejects.toMatchObject({response: expect.objectContaining({
        message: 'mission_has_live_session', session_id: 'sess-live',
      })});

    expect(qOneCalls.some(c => /UPDATE pro_plan_missions/.test(c.sql))).toBe(false);
    expect(qCalls.some(c => /UPDATE pro_cpo_assignments/.test(c.sql))).toBe(false);
  });

  it('the client cancel is refused the same way', async () => {
    const {svc, qOneCalls} = mk({liveSession: LIVE});
    await expect(svc.cancelMission('client-1', 'app-1', 'msn-1'))
      .rejects.toMatchObject({response: expect.objectContaining({message: 'mission_has_live_session'})});
    expect(qOneCalls.some(c => /UPDATE pro_plan_missions/.test(c.sql))).toBe(false);
  });

  it('the probe is scoped to THIS mission\'s rows and to the live status set', async () => {
    const {svc, qOneCalls} = mk({liveSession: LIVE});
    await svc.opsCancelMission(ADMIN, 'app-1', 'msn-1').catch(() => undefined);
    const probe = qOneCalls.find(c => /FROM public\.protection_sessions ps/.test(c.sql))!;
    // Scoped by mission_id, not application: a session riding the plan's
    // STANDING dedication is untouched by this cancel, so it must not block it.
    expect(probe.sql).toMatch(/pca\.mission_id = \$1/);
    expect(probe.sql).toMatch(/ps\.status IN \('REQUESTED','ACTIVE','ENDING'\)/);
    expect(probe.params).toEqual(['msn-1']);
  });

  it('with no live session the cancel proceeds normally', async () => {
    const {svc, qCalls} = mk({liveSession: null});
    const out = await svc.opsCancelMission(ADMIN, 'app-1', 'msn-1');
    expect(out.mission.status).toBe('CANCELLED');
    expect(qCalls.some(c => /UPDATE pro_cpo_assignments/.test(c.sql))).toBe(true);
  });
});

describe('a failed officer release is an ops signal, not a swallowed warn', () => {
  it('emits the alert + audit row so the blocked officer reaches a human', async () => {
    const {svc, opsAudit} = mk({releaseThrows: new Error('deadlock detected')});
    // The mission is already CANCELLED and the caller already has its 200 — the
    // officer stays ASSIGNED and keeps blocking the gist exclusion for everyone.
    const out = await svc.cancelMission('client-1', 'app-1', 'msn-1');
    expect(out.mission.status).toBe('CANCELLED');

    expect(opsAudit.emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'protection', severity: 'warn', subject: 'app-1',
      metadata: expect.objectContaining({reason: 'assignment_release_failed', mission_id: 'msn-1'}),
    }));
    expect(opsAudit.record).toHaveBeenCalledWith(expect.objectContaining({
      actor_role: 'SYSTEM', action: 'pro_mission.release_failed', subject_id: 'app-1',
    }));
  });
});

describe('ProApplicationsService.sweepExpired — plan expiry vs a live session (E2E-51)', () => {
  it('is LIMIT-ed — it runs on the getMine read path', async () => {
    const {svc, qCalls} = mk({expired: []});
    await svc.getMine('client-1');
    const sweep = qCalls.find(c => /WITH victims AS[\s\S]*pro_applications/.test(c.sql))!;
    expect(sweep.sql).toMatch(/LIMIT \d+/);
    expect(sweep.sql).toMatch(/WHERE id IN \(SELECT id FROM victims\) AND status = 'ACTIVE'/);
  });

  it('emits plan_expired_session_live and does NOT end the session', async () => {
    const {svc, qCalls, opsAudit} = mk({expired: [{id: 'app-9', live_sessions: 1}]});
    await svc.getMine('client-1');

    expect(opsAudit.emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'protection', severity: 'warn', subject: 'app-9',
      metadata: expect.objectContaining({reason: 'plan_expired_session_live'}),
    }));
    expect(opsAudit.record).toHaveBeenCalledWith(expect.objectContaining({
      actor_role: 'SYSTEM', action: 'pro_plan.expired_session_live',
    }));
    // The session is left running on purpose — the 12 h cap bounds it and a
    // human decides. Nothing in the sweep may write protection_sessions.
    expect(qCalls.some(c => /UPDATE public\.protection_sessions/.test(c.sql))).toBe(false);
  });

  it('stays silent when the expiring plan has no live session', async () => {
    const {svc, opsAudit} = mk({expired: [{id: 'app-9', live_sessions: 0}]});
    await svc.getMine('client-1');
    expect(opsAudit.emit).not.toHaveBeenCalled();
  });
});
