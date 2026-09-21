/**
 * E2E-01/08/35 — the reserved date must actually activate.
 *
 * Before this sweeper nothing in the backend read pro_plan_missions on a date
 * trigger: the calendar said "booked" and no session was ever created. Pinned
 * here, in order of what a regression would cost:
 *   1. a SCHEDULED reservation whose dates include the GULF today opens a real
 *      protection session through ProtectionService (not a bypass of it),
 *   2. the claim is per (mission, DAY) — a second tick the same day is silent,
 *      the next day fires again (mission_dates is an ARRAY),
 *   3. an activation failure still leaves an ops signal (the claim is burned),
 *   4. the end-of-day pass writes COMPLETED (a status with zero writers until now),
 *   5. a REQUESTED date near its start with no team escalates ONCE,
 *   6. every tick is fenced and drives the four protection sweeps (E2E-35).
 *
 * The DatabaseService mock MODELS the conditional claim — a claim that always
 * returns a row could not tell test 2 from a broken one.
 */
import {ProMissionActivationService} from './pro-mission-activation.service';
import type {DatabaseService} from '../database/database.service';
import {todayGulf} from '../pro-applications/gulf-day';

type Row = Record<string, unknown>;

function mk(opts: {
  due?: Row[];
  escalate?: Row[];
  completed?: Row[];
  lock?: string | null;
  openThrows?: Error | {response: {message: string}};
} = {}) {
  const qCalls: Array<{sql: string; params?: unknown[]}> = [];
  // The REAL side effect: pro_plan_missions.(activated_at, activated_for_date).
  const claims = new Map<string, string>();

  const db = {
    q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qCalls.push({sql, params});
      // Both handlers below READ THE SQL to decide what the row store does, so a
      // regression to a bare `activated_at IS NULL` changes the mock's answers
      // rather than sailing past an inert double. Per-day is the shipped shape.
      if (/SELECT pm\.id, pm\.application_id, pm\.requested_by/.test(sql)) {
        const today = String(params?.[0]);
        const perDay = /activated_for_date IS DISTINCT FROM/.test(sql);
        return Promise.resolve((opts.due ?? []).filter(r => {
          const claimed = claims.get(String(r.id));
          return perDay ? claimed !== today : claimed === undefined;
        }));
      }
      if (/SET activated_at = now\(\)/.test(sql)) {
        const [id, day] = [String(params?.[0]), String(params?.[1])];
        const perDay = /activated_for_date IS DISTINCT FROM/.test(sql);
        const claimed = claims.get(id);
        if (perDay ? claimed === day : claimed !== undefined) {return Promise.resolve([]);}
        claims.set(id, day);
        return Promise.resolve([{id}]);
      }
      if (/status = 'COMPLETED'/.test(sql)) {return Promise.resolve(opts.completed ?? []);}
      if (/SET escalated_at = now\(\)/.test(sql)) {return Promise.resolve(opts.escalate ?? []);}
      return Promise.resolve([]);
    }),
    qOne: jest.fn().mockResolvedValue(null),
  } as unknown as DatabaseService;

  const redis = {
    client: {
      set: jest.fn().mockResolvedValue('lock' in opts ? opts.lock : 'OK'),
      eval: jest.fn().mockResolvedValue(1),
    },
  };
  const protection = {
    openForScheduledMission: opts.openThrows
      ? jest.fn().mockRejectedValue(opts.openThrows)
      : jest.fn().mockResolvedValue({session: {id: 'sess-1'}, already_active: false}),
    sweepActivationEscalations: jest.fn().mockResolvedValue(0),
    sweepStaleActivations: jest.fn().mockResolvedValue(0),
    sweepMaxDuration: jest.fn().mockResolvedValue(0),
    sweepRetention: jest.fn().mockResolvedValue(0),
  };
  const opsAudit = {
    emit: jest.fn().mockResolvedValue(undefined),
    record: jest.fn().mockResolvedValue(undefined),
  };
  const push = {
    proMissionLive: jest.fn().mockResolvedValue(undefined),
    proMissionUpdate: jest.fn().mockResolvedValue(undefined),
  };

  const svc = new ProMissionActivationService(
    db, redis as never, protection as never, opsAudit as never, push as never,
  );
  return {svc, qCalls, claims, redis, protection, opsAudit, push};
}

const MISSION = {id: 'msn-1', application_id: 'app-1', requested_by: 'client-1'};

describe('ProMissionActivationService — the reserved date activates (E2E-01)', () => {
  it('opens a session through ProtectionService and wakes the client', async () => {
    const {svc, protection, push} = mk({due: [MISSION]});
    const out = await svc.sweepOnce();

    expect(out.activated).toBe(1);
    // Through the service's own creation path — assertPlanAccess / plan-ACTIVE /
    // covering-officer all still run. A direct INSERT here would be the bypass.
    expect(protection.openForScheduledMission).toHaveBeenCalledWith('client-1', 'app-1');

    // The flagship signal of the whole fix, so it gets its OWN kind: it must
    // carry the session id (the tap opens the live map on that session) and it
    // must NOT reuse pro-mission-update, whose copy answers a request the client
    // did not just make and whose route lands on the missions list.
    expect(push.proMissionLive).toHaveBeenCalledWith('client-1', 'app-1', 'sess-1');
    expect(push.proMissionUpdate).not.toHaveBeenCalled();
  });

  it('selects on the GULF day, not UTC or CURRENT_DATE (E2E-09)', async () => {
    const {svc, qCalls} = mk({due: [MISSION]});
    await svc.sweepOnce();
    const sel = qCalls.find(c => /SELECT pm\.id, pm\.application_id, pm\.requested_by/.test(c.sql))!;
    expect(sel.params).toEqual([todayGulf()]);
    expect(sel.sql).toMatch(/\$1::date = ANY\(pm\.mission_dates\)/);
    expect(sel.sql).not.toMatch(/CURRENT_DATE/);
  });

  it('claims per (mission, DAY): a second tick today is silent, tomorrow fires again', async () => {
    const {svc, protection, claims} = mk({due: [MISSION]});
    await svc.sweepOnce();
    const second = await svc.sweepOnce();
    expect(second.activated).toBe(0);
    expect(protection.openForScheduledMission).toHaveBeenCalledTimes(1);

    // A multi-date reservation must fire again on its NEXT date — the whole
    // reason the claim is (activated_at, activated_for_date) and not a bare
    // activated_at IS NULL.
    claims.set('msn-1', '1999-01-01');
    const nextDay = await svc.sweepOnce();
    expect(nextDay.activated).toBe(1);
    expect(protection.openForScheduledMission).toHaveBeenCalledTimes(2);
  });

  it('claims BEFORE opening the session (at-most-once beats a retry storm)', async () => {
    const {svc, qCalls} = mk({due: [MISSION]});
    await svc.sweepOnce();
    const claimIx = qCalls.findIndex(c => /SET activated_at = now\(\)/.test(c.sql));
    expect(claimIx).toBeGreaterThanOrEqual(0);
    const claim = qCalls[claimIx];
    expect(claim.sql).toMatch(/activated_at IS NULL OR activated_for_date IS DISTINCT FROM/);
    expect(claim.sql).toMatch(/status = 'SCHEDULED'/);
  });

  it('a failed activation still reaches ops (the claim is already burned)', async () => {
    const {svc, opsAudit} = mk({due: [MISSION], openThrows: {response: {message: 'no_cpo_assigned'}}});
    const out = await svc.sweepOnce();

    expect(out.activated).toBe(0);
    expect(opsAudit.emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'protection', severity: 'warn', subject: 'app-1',
    }));
    expect(opsAudit.record).toHaveBeenCalledWith(expect.objectContaining({
      actor_role: 'SYSTEM', action: 'pro_mission.activation_failed', subject_id: 'app-1',
    }));
  });
});

describe('ProMissionActivationService — lifecycle + escalation', () => {
  it('closes reservations whose last date has passed (COMPLETED had no writer)', async () => {
    const {svc, qCalls} = mk({completed: [{id: 'msn-old', application_id: 'app-1'}]});
    const out = await svc.sweepOnce();

    expect(out.completed).toBe(1);
    const close = qCalls.find(c => /status = 'COMPLETED'/.test(c.sql))!;
    expect(close.sql).toMatch(/max\(d\) FROM unnest\(mission_dates\) d\) </);
    expect(close.sql).toMatch(/LIMIT 50/);
  });

  it('escalates a REQUESTED date near its start with no team, ONCE (E2E-08)', async () => {
    const {svc, qCalls, opsAudit} = mk({
      escalate: [{id: 'msn-2', application_id: 'app-2', first_date: '2030-02-02'}],
    });
    const out = await svc.sweepOnce();

    expect(out.escalated).toBe(1);
    const claim = qCalls.find(c => /SET escalated_at = now\(\)/.test(c.sql))!;
    // escalated_at IS NULL is what stops a warn every 60 s for the same row.
    expect(claim.sql).toMatch(/escalated_at IS NULL/);
    expect(opsAudit.emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'protection', severity: 'warn', subject: 'app-2',
    }));
    expect(opsAudit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'pro_mission.unassigned', actor_role: 'SYSTEM',
    }));
  });
});

describe('ProMissionActivationService — fencing + the E2E-35 sweeps', () => {
  it('drives all four protection sweeps inside the lock', async () => {
    const {svc, protection, redis} = mk({due: []});
    await svc.sweepOnce();

    expect(protection.sweepStaleActivations).toHaveBeenCalledTimes(1);
    expect(protection.sweepMaxDuration).toHaveBeenCalledTimes(1);
    expect(protection.sweepRetention).toHaveBeenCalledTimes(1);
    expect(protection.sweepActivationEscalations).toHaveBeenCalledTimes(1);
    // Fenced: SET NX PX to take it, the compare-and-delete Lua to release it.
    expect(redis.client.set).toHaveBeenCalledWith(
      'lock:pro-mission-activation', expect.any(String), 'PX', expect.any(Number), 'NX');
    expect(redis.client.eval).toHaveBeenCalled();
  });

  it('another pod holds the lock → this tick does nothing at all', async () => {
    const {svc, protection, qCalls} = mk({due: [MISSION], lock: null});
    const out = await svc.sweepOnce();

    expect(out.skipped_lock).toBe(true);
    expect(out.activated).toBe(0);
    expect(protection.openForScheduledMission).not.toHaveBeenCalled();
    expect(protection.sweepRetention).not.toHaveBeenCalled();
    expect(qCalls).toHaveLength(0);
  });

  it('never throws — a rejection here is an unhandledRejection that kills the pod', async () => {
    const {svc} = mk({due: [MISSION]});
    (svc as unknown as {db: {q: jest.Mock}}).db.q =
      jest.fn().mockRejectedValue(new Error('relation "pro_plan_missions" does not exist'));
    await expect(svc.sweepOnce()).resolves.toMatchObject({activated: 0, completed: 0});
  });
});
