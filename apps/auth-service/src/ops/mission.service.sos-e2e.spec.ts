/**
 * SECURE_SERVICES_E2E_AUDIT_2026-09-03 — MissionService half.
 *
 *  E2E-03 (P0) ops could not resolve a client/VBG panic SOS, and the row
 *              resolved anyway: `resolveSos` UPDATEd `sos_events` and THEN called
 *              `requireMission(sos.mission_id)`, which throws NotFound for a NULL
 *              mission_id — outside any transaction. Operator saw a 404, SWR
 *              rolled the optimistic row back, the DB said resolved.
 *  E2E-40 (P2) SOS escalate was write-only: row + audit, no ops-room card, no
 *              event frame, no push — the crew never learned police were called.
 *  E2E-41 (P2) `advanceWaypoint` mutated the client-visible timeline and emitted
 *              nothing.
 *
 * The transaction mock below MODELS ROLLBACK: writes issued on `tx` are staged
 * and only land in `applied` when the callback resolves. A mock that committed
 * unconditionally could not tell the fix from the bug.
 */
import {NotFoundException} from '@nestjs/common';
import {MissionService} from './mission.service';
import {MissionStateMachine} from './mission-state-machine.service';
import {OpsAuditService} from './ops-audit.service';
import {SystemMessengerService} from './system-messenger.service';
import type {AdminContext} from './admin.guard';

const SUPERVISOR: AdminContext = {
  user_id: 'u-sup', role: 'SUPERVISOR', call_sign: 'SUP-01', region: 'AE',
};
const GLOBAL_ADMIN: AdminContext = {
  user_id: 'u-adm', role: 'ADMIN', call_sign: 'ADM-01', region: 'AE',
};

type Write = {sql: string; params?: unknown[]};

function makeService() {
  /** Writes ISSUED INSIDE a transaction (committed or not). */
  const attempted: Write[] = [];
  /** Writes that actually COMMITTED (a rolled-back txn contributes nothing). */
  const applied: Write[] = [];
  const q = jest.fn().mockResolvedValue([]);
  const qOne = jest.fn().mockResolvedValue(null);
  const withTransaction = jest.fn(async (fn: (tx: {q: jest.Mock; qOne: jest.Mock}) => unknown) => {
    const staged: Write[] = [];
    const txQ = jest.fn(async (sql: string, params?: unknown[]) => {
      staged.push({sql, params});
      attempted.push({sql, params});
      return q(sql, params);
    });
    const txQOne = jest.fn(async (sql: string, params?: unknown[]) => qOne(sql, params));
    const out = await fn({q: txQ, qOne: txQOne});   // a throw here never reaches the push below
    applied.push(...staged);                        // COMMIT
    return out;
  });
  const db = {q, qOne, withTransaction};

  const audit = {
    record: jest.fn().mockResolvedValue(undefined),
    recordAdmin: jest.fn().mockResolvedValue(undefined),
    emit: jest.fn().mockResolvedValue(undefined),
    listForSubject: jest.fn().mockResolvedValue([]),
  };
  const systemMsg = {
    sendMissionEvent: jest.fn().mockResolvedValue(undefined),
    deleteMissionRoom: jest.fn().mockResolvedValue(undefined),
    broadcast: jest.fn().mockResolvedValue({id: 'bc'}),
  };
  const events = {
    broadcast: jest.fn().mockResolvedValue(undefined),
    broadcastBoth: jest.fn().mockResolvedValue(undefined),
    statusChanged: jest.fn().mockResolvedValue(undefined),
    teamChanged: jest.fn().mockResolvedValue(undefined),
    telemetryFix: jest.fn().mockResolvedValue(undefined),
  };
  const bookingPush = {
    sosAlert: jest.fn().mockResolvedValue(undefined),
    missionAborted: jest.fn().mockResolvedValue(undefined),
    refundIssued: jest.fn().mockResolvedValue(undefined),
  };

  const svc = new MissionService(
    db as never,
    new MissionStateMachine(),
    audit as unknown as OpsAuditService,
    systemMsg as unknown as SystemMessengerService,
    {getRoute: jest.fn(), getRouteAlternatives: jest.fn()} as never,
    {refundForBooking: jest.fn().mockResolvedValue({refunded: false, credits: 0})} as never,
    {get: () => 0} as never,
    events as never,
    bookingPush as never,
  );
  return {svc, db, q, qOne, applied, attempted, audit, systemMsg, events, bookingPush, withTransaction};
}

const sosResolveWrites = (writes: Write[]) =>
  writes.filter(w => /UPDATE sos_events[\s\S]*resolved_at = NOW/.test(w.sql));
const committedSosResolve = sosResolveWrites;

describe('E2E-03 — resolving an SOS is transactional and mission-optional', () => {
  it('a client panic with NO mission resolves the row and never asks for a mission', async () => {
    const {svc, qOne, applied, q} = makeService();
    // The exact row `sos.service.ts` writes for a panic press with no owned
    // live booking: mission_id NULL.
    qOne.mockResolvedValueOnce({id: 'sos-1', mission_id: null, acknowledged_at: null});
    // CRITIC P1 — a mission-less panic is now region-resolved from its own
    // booking / the raiser, so the scoped SUPERVISOR must match. This assertion
    // was previously "no region read happens", which is exactly the hole.
    qOne.mockResolvedValueOnce({region_code: 'AE'});

    await expect(svc.resolveSos('sos-1', SUPERVISOR, 'false_alarm', true)).resolves.toBeUndefined();

    // The resolve COMMITTED …
    expect(committedSosResolve(applied)).toHaveLength(1);
    expect(committedSosResolve(applied)[0].params).toEqual(['sos-1', 'false_alarm', SUPERVISOR.user_id]);
    // … the region WAS checked, against the SOS row's own booking/raiser …
    const regionRead = qOne.mock.calls.find(([sql]: [string]) => /FROM public\.sos_events s/.test(sql));
    expect(regionRead).toBeDefined();
    expect(regionRead?.[0]).toMatch(/home_region/);
    expect(regionRead?.[1]).toEqual(['sos-1']);
    // … and nothing ever went looking for a mission row, so no 404 to roll back.
    const missionReads = qOne.mock.calls.filter(([sql]: [string]) => /FROM missions/.test(sql));
    expect(missionReads).toHaveLength(0);
    const liveFlips = q.mock.calls.filter(([sql]: [string]) => /SET status = 'LIVE'/.test(sql));
    expect(liveFlips).toHaveLength(0);
  });

  it('CRITIC P1 — a mission-less panic from ANOTHER region is refused, with no write', async () => {
    const {svc, qOne, applied} = makeService();
    qOne.mockResolvedValueOnce({id: 'sos-1', mission_id: null});
    qOne.mockResolvedValueOnce({region_code: 'SA'});   // SUPERVISOR is AE
    await expect(svc.resolveSos('sos-1', SUPERVISOR, 'false_alarm', true)).rejects.toThrow();
    expect(committedSosResolve(applied)).toHaveLength(0);
  });

  it('CRITIC P1 — an unplaceable panic fails CLOSED for a scoped admin, OPEN for a global ADMIN', async () => {
    // No booking, no home_region, no country_code: nothing to compare against.
    const scoped = makeService();
    scoped.qOne.mockResolvedValueOnce({id: 'sos-1', mission_id: null});
    scoped.qOne.mockResolvedValueOnce({region_code: null});
    await expect(scoped.svc.resolveSos('sos-1', SUPERVISOR, 'x', true)).rejects.toThrow();
    expect(committedSosResolve(scoped.applied)).toHaveLength(0);

    // A global ADMIN bypasses, so the alert is never unactionable by the platform —
    // which is what makes failing closed above safe rather than a swallowed alert.
    const global = makeService();
    global.qOne.mockResolvedValueOnce({id: 'sos-1', mission_id: null});
    await expect(global.svc.resolveSos('sos-1', GLOBAL_ADMIN, 'x', true)).resolves.toBeUndefined();
    expect(committedSosResolve(global.applied)).toHaveLength(1);
  });

  it('CRITIC P1 — the resolve clears BOTH alert artefacts inside the txn', async () => {
    const {svc, qOne, applied} = makeService();
    qOne.mockResolvedValueOnce({id: 'sos-1', mission_id: null});
    qOne.mockResolvedValueOnce({region_code: 'AE'});

    await svc.resolveSos('sos-1', SUPERVISOR, 'stood_down', true);

    // `status` — the KPI clears on resolved_at, but `sos_active_idx` is a PARTIAL
    // index on status='active', so leaving it kept the row in the live set forever.
    const statusWrite = applied.find(w => /UPDATE sos_events/.test(w.sql));
    expect(statusWrite?.sql).toMatch(/status = 'resolved'/);
    // `protection_sessions.sos_active` — set by sos.service.ts, previously cleared
    // by nothing, so the Pro live screen kept its SOS banner for the session's life.
    const sessionWrite = applied.find(w => /protection_sessions/.test(w.sql));
    expect(sessionWrite).toBeDefined();
    expect(sessionWrite?.sql).toMatch(/sos_active = false/);
    expect(sessionWrite?.params).toEqual(['sos-1']);
  });

  it('a mission-bound SOS still returns the mission to LIVE — behaviour unchanged', async () => {
    const {svc, qOne, applied} = makeService();
    qOne
      .mockResolvedValueOnce({id: 'sos-1', mission_id: 'm1'})                       // sos load
      .mockResolvedValueOnce({region_code: 'AE'})                                   // AUTHZ-2 region
      .mockResolvedValueOnce({id: 'm1', booking_id: 'b1', status: 'SOS', short_code: 'MSN-1'});

    await svc.resolveSos('sos-1', SUPERVISOR, 'false_alarm', true);

    expect(committedSosResolve(applied)).toHaveLength(1);
    const liveFlip = applied.find(w => /SET status = 'LIVE'/.test(w.sql));
    expect(liveFlip).toBeDefined();
    expect(liveFlip?.sql).toMatch(/WHERE id = \$1 AND status = 'SOS'/);
    expect(liveFlip?.params).toEqual(['m1']);
  });

  it('a throw inside the resolve rolls the resolve BACK — never a half-applied resolve', async () => {
    const {svc, qOne, applied, attempted} = makeService();
    qOne
      .mockResolvedValueOnce({id: 'sos-1', mission_id: 'm-gone'})
      .mockResolvedValueOnce({region_code: 'AE'})
      .mockResolvedValueOnce(null);   // the mission row is gone — requireMission's 404 case

    await expect(svc.resolveSos('sos-1', SUPERVISOR, 'false_alarm', true))
      .rejects.toBeInstanceOf(NotFoundException);

    // THE E2E-03 ASSERTION, in two halves so it cannot pass vacuously:
    //   the write WAS issued inside a transaction …
    expect(sosResolveWrites(attempted)).toHaveLength(1);
    //   … and that transaction did NOT commit. Before the fix the UPDATE ran
    //   through `db.q` OUTSIDE any txn, so `attempted` would be empty here.
    expect(committedSosResolve(applied)).toHaveLength(0);
  });

  it('the resolve and the return-to-LIVE are ONE critical section', async () => {
    const {svc, qOne, withTransaction, applied} = makeService();
    qOne
      .mockResolvedValueOnce({id: 'sos-1', mission_id: 'm1'})
      .mockResolvedValueOnce({region_code: 'AE'})
      .mockResolvedValueOnce({id: 'm1', booking_id: 'b1', status: 'SOS', short_code: 'MSN-1'});

    await svc.resolveSos('sos-1', SUPERVISOR, 'false_alarm', true);

    expect(withTransaction).toHaveBeenCalledTimes(1);
    // Both writes are staged writes of that one transaction.
    expect(applied.filter(w => /UPDATE sos_events|SET status = 'LIVE'/.test(w.sql))).toHaveLength(2);
  });

  it('returnToLive=false still resolves the row without touching the mission', async () => {
    const {svc, qOne, applied} = makeService();
    qOne
      .mockResolvedValueOnce({id: 'sos-1', mission_id: 'm1'})
      .mockResolvedValueOnce({region_code: 'AE'});

    await svc.resolveSos('sos-1', SUPERVISOR, 'stood_down', false);

    expect(committedSosResolve(applied)).toHaveLength(1);
    expect(applied.some(w => /SET status = 'LIVE'/.test(w.sql))).toBe(false);
  });
});

describe('E2E-40 — escalating an SOS reaches the crew', () => {
  function primeEscalate(qOne: jest.Mock, q: jest.Mock) {
    qOne
      .mockResolvedValueOnce({id: 'sos-1', mission_id: 'm1'})                                   // sos load
      .mockResolvedValueOnce({region_code: 'AE'})                                               // AUTHZ-2 region
      .mockResolvedValueOnce({id: 'm1', booking_id: 'b1', status: 'SOS', short_code: 'MSN-1', comms_channel_id: 'cm-1'})
      .mockResolvedValueOnce({assigned_provider_user_id: 'org-9'});                             // agency desk
    q.mockImplementation(async (sql: string) =>
      /FROM mission_crew/.test(sql) ? [{agent_id: 'cpo-1'}, {agent_id: 'cpo-2'}] : []);
  }

  it('posts the ops-room card, emits the mission frame and wakes crew + agency', async () => {
    const {svc, qOne, q, systemMsg, events, bookingPush, audit} = makeService();
    primeEscalate(qOne, q);

    await svc.escalateSos('sos-1', SUPERVISOR, 'POLICE', 'local chief notified');

    // The row + audit (unchanged) …
    expect(q).toHaveBeenCalledWith(
      expect.stringMatching(/SET escalated_at = NOW\(\)/s), ['sos-1', 'POLICE'],
    );
    expect(audit.recordAdmin).toHaveBeenCalledWith(
      SUPERVISOR, 'sos.escalate', 'sos', 'sos-1', expect.objectContaining({escalated_to: 'POLICE'}),
    );
    // … plus the three mechanisms ack already owned.
    expect(systemMsg.sendMissionEvent).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: 'cm-1', kind: 'mission_sos_escalated', severity: 'err',
    }));
    // CRITIC P2 — the frame is SPLIT. The mission room (crew + ops) gets the
    // detail; the client's booking room gets a neutral flag, because `escalated_to`
    // is operator free text and `broadcastBoth` would have put it on the
    // principal's channel verbatim.
    expect(events.broadcast).toHaveBeenCalledWith(
      'm1', 'mission.status',
      expect.objectContaining({sosEscalated: true, escalatedTo: 'POLICE'}),
    );
    expect(events.broadcast).toHaveBeenCalledWith('b1', 'mission.status', {sosEscalated: true});
    // The client frame carries NO free text.
    const clientFrame = events.broadcast.mock.calls.find(([key]: [string]) => key === 'b1');
    expect(JSON.stringify(clientFrame?.[2])).not.toContain('POLICE');
    expect(events.broadcastBoth).not.toHaveBeenCalled();
    // Opaque SOS wake — crew still on the roster PLUS the agency monitoring desk.
    expect(bookingPush.sosAlert).toHaveBeenCalledWith(['cpo-1', 'cpo-2', 'org-9'], 'm1', 'b1');
    // Stood-down crew are excluded at the query, not in JS.
    const crewSql = q.mock.calls.find(([sql]: [string]) => /FROM mission_crew/.test(sql))?.[0] ?? '';
    expect(crewSql).toMatch(/status <> 'off'/);
  });

  it('a mission-less panic escalation records and pushes nothing (no crash, no crew to wake)', async () => {
    const {svc, qOne, systemMsg, bookingPush, audit} = makeService();
    qOne.mockResolvedValueOnce({id: 'sos-2', mission_id: null});
    qOne.mockResolvedValueOnce({region_code: 'AE'});   // CRITIC P1 — now region-resolved

    await expect(svc.escalateSos('sos-2', SUPERVISOR, 'EMBASSY')).resolves.toBeUndefined();

    expect(audit.recordAdmin).toHaveBeenCalledWith(
      SUPERVISOR, 'sos.escalate', 'sos', 'sos-2', expect.objectContaining({escalated_to: 'EMBASSY'}),
    );
    expect(systemMsg.sendMissionEvent).not.toHaveBeenCalled();
    expect(bookingPush.sosAlert).not.toHaveBeenCalled();
  });

  it('a push failure never fails the escalation (best-effort, like ack)', async () => {
    const {svc, qOne, q, bookingPush} = makeService();
    primeEscalate(qOne, q);
    bookingPush.sosAlert.mockRejectedValueOnce(new Error('redis down'));

    await expect(svc.escalateSos('sos-1', SUPERVISOR, 'POLICE')).resolves.toBeUndefined();
    expect(bookingPush.sosAlert).toHaveBeenCalled();
  });
});

describe('E2E-41 — advanceWaypoint emits', () => {
  it('broadcasts the timeline change on the mission AND booking rooms', async () => {
    const {svc, qOne, events} = makeService();
    qOne.mockResolvedValueOnce({id: 'm1', booking_id: 'b1', status: 'LIVE', short_code: 'MSN-1'});

    await svc.advanceWaypoint('m1', 3, 'done');

    expect(events.broadcastBoth).toHaveBeenCalledWith(
      'm1', 'b1', 'mission.status',
      {waypointAdvanced: 3, waypointState: 'done'},
    );
  });
});
