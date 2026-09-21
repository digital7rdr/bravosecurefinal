import {BadRequestException, ConflictException, NotFoundException} from '@nestjs/common';
import {AgentService} from './agent.service';
import {AgentStateMachine} from './state-machine.service';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import type {CpoAssignmentService} from '../booking/assignment/cpo-assignment.service';
import type {WalletService} from '../wallet/wallet.service';
import type {DepartmentService} from '../department/department.service';
import type {ProofOfCompletionService} from './proof-of-completion.service';
import type {ConfigService} from '@nestjs/config';
import type {MissionEventsService} from '../ops/mission-events.service';
import type {BookingPushBridge} from '../ops/booking-push-bridge.service';

/**
 * 2026-09-04 — the explicit Dispatched action (mission CREWED → DISPATCHED).
 *
 * "Accepted is not Dispatched": the agency or the lead presses Dispatched when
 * the team actually moves. This suite pins the race / idempotency contract:
 *   - exactly-once by construction — one conditional UPDATE, WHERE status='CREWED';
 *   - a duplicate (double-tap, retry, other device, other door) is a side-effect-free
 *     replay that reports the current state; nothing fires twice;
 *   - a stale screen on an ENDED mission is refused (409), never a silent success;
 *   - the lead door is lead-only; the org door is scoped to the assigned provider;
 *   - dispatched_at is written once (COALESCE) and never moved;
 *   - the client wake fires ONLY on the row that flipped; the crew wake only when
 *     the AGENCY pressed it (the lead already knows).
 */
const db = {q: jest.fn(), qOne: jest.fn(), withTransaction: jest.fn()};
const events = {statusChanged: jest.fn()};
const push = {teamDispatched: jest.fn(), crewMoveOut: jest.fn()};

function svc(): AgentService {
  return new AgentService(
    db as unknown as DatabaseService,
    new AgentStateMachine(),
    {} as unknown as RedisService,
    {} as unknown as CpoAssignmentService,
    {} as unknown as WalletService,
    {} as unknown as DepartmentService,
    {} as unknown as ProofOfCompletionService,
    {get: jest.fn()} as unknown as ConfigService,
    events as unknown as MissionEventsService,
    push as unknown as BookingPushBridge,
  );
}

interface Wire {
  /** mission_crew row for the caller: null = not on the crew. */
  crew?: {is_lead: boolean} | null;
  /** The conditional UPDATE matched (fresh dispatch) → RETURNING row. */
  flipped?: {booking_id: string; dispatched_at: Date} | null;
  /** Current row when the UPDATE matched nothing. */
  current?: {status: string; dispatched_at: Date | null} | null;
  /** Org-door ownership lookup. */
  owned?: boolean;
  crewIds?: string[];
  bookingStatus?: string;
}

const T0 = new Date('2026-09-04T10:07:00.000Z');

function wire(w: Wire): void {
  db.qOne.mockImplementation((sql: string) => {
    if (/SELECT is_lead FROM mission_crew/.test(sql)) return Promise.resolve(w.crew === undefined ? {is_lead: true} : w.crew);
    if (/SET status = 'DISPATCHED'/.test(sql)) return Promise.resolve(w.flipped === undefined ? {booking_id: 'b1', dispatched_at: T0} : w.flipped);
    if (/SELECT status, dispatched_at FROM missions/.test(sql)) return Promise.resolve(w.current ?? null);
    if (/b\.assigned_provider_user_id = \$2/.test(sql)) return Promise.resolve(w.owned === false ? null : {id: 'm1'});
    if (/SELECT client_id, status FROM lite_bookings/.test(sql)) return Promise.resolve({client_id: 'client-1', status: w.bookingStatus ?? 'CONFIRMED'});
    return Promise.resolve(null);
  });
  db.q.mockImplementation((sql: string) => {
    if (/SELECT agent_id FROM mission_crew/.test(sql)) return Promise.resolve((w.crewIds ?? ['cpo-1', 'cpo-2']).map(agent_id => ({agent_id})));
    return Promise.resolve([]);
  });
  push.teamDispatched.mockResolvedValue(undefined);
  push.crewMoveOut.mockResolvedValue(undefined);
  events.statusChanged.mockResolvedValue(undefined);
}

const flush = () => new Promise(r => setImmediate(r));

describe('AgentService.missionDispatch — the lead door', () => {
  beforeEach(() => jest.resetAllMocks());

  it('flips CREWED → DISPATCHED with ONE conditional UPDATE, stamps dispatched_at once, wakes the client', async () => {
    wire({});
    const res = await svc().missionDispatch('lead-1', 'm1', {lat: 25.2, lng: 55.3});
    expect(res).toEqual({ok: true, already: false, status: 'DISPATCHED', dispatched_at: T0.toISOString()});
    const upd = db.qOne.mock.calls.find(c => /SET status = 'DISPATCHED'/.test(String(c[0])));
    expect(upd).toBeDefined();
    expect(String(upd![0])).toMatch(/dispatched_at = COALESCE\(dispatched_at, NOW\(\)\)/);
    expect(String(upd![0])).toMatch(/WHERE id = \$1 AND status = 'CREWED'/);
    expect(upd![1]).toEqual(['m1']);
    await flush();
    expect(push.teamDispatched).toHaveBeenCalledTimes(1);
    expect(push.teamDispatched).toHaveBeenCalledWith('client-1', 'b1');
    expect(events.statusChanged).toHaveBeenCalledWith('m1', 'DISPATCHED', 'b1');
    // The lead pressed it themselves — no "move out" wake to the crew.
    expect(push.crewMoveOut).not.toHaveBeenCalled();
    // The audit row carries the fix and the door.
    const audit = db.q.mock.calls.find(c => /INSERT INTO ops_audit/.test(String(c[0])));
    expect(audit).toBeDefined();
    expect(JSON.parse(String(audit![1][2]))).toMatchObject({booking_id: 'b1', via: 'lead', lat: 25.2, lng: 55.3, has_fix: true});
  });

  it('a duplicate press / network retry (already DISPATCHED) is an idempotent replay — no push, no audit, no event', async () => {
    wire({flipped: null, current: {status: 'DISPATCHED', dispatched_at: T0}});
    const res = await svc().missionDispatch('lead-1', 'm1');
    expect(res).toEqual({ok: true, already: true, status: 'DISPATCHED', dispatched_at: T0.toISOString()});
    await flush();
    expect(push.teamDispatched).not.toHaveBeenCalled();
    expect(events.statusChanged).not.toHaveBeenCalled();
    expect(db.q.mock.calls.some(c => /INSERT INTO ops_audit/.test(String(c[0])))).toBe(false);
  });

  it.each(['PICKUP', 'LIVE', 'SOS'])('a stale screen pressing Dispatched on a %s mission reports the truth and fires nothing', async (status) => {
    wire({flipped: null, current: {status, dispatched_at: T0}});
    const res = await svc().missionDispatch('lead-1', 'm1');
    expect(res.already).toBe(true);
    expect(res.status).toBe(status);
    await flush();
    expect(push.teamDispatched).not.toHaveBeenCalled();
  });

  it.each(['ABORTED', 'COMPLETED'])('a stale screen pressing Dispatched on an ENDED (%s) mission is REFUSED with 409, not a silent success', async (status) => {
    wire({flipped: null, current: {status, dispatched_at: null}});
    await expect(svc().missionDispatch('lead-1', 'm1')).rejects.toBeInstanceOf(ConflictException);
    await expect(svc().missionDispatch('lead-1', 'm1')).rejects.toMatchObject({
      response: expect.objectContaining({code: 'mission_not_dispatchable', status}),
    });
    expect(push.teamDispatched).not.toHaveBeenCalled();
  });

  it('a legacy DISPATCHED row with no dispatched_at replays with dispatched_at null (never fabricates a time)', async () => {
    wire({flipped: null, current: {status: 'DISPATCHED', dispatched_at: null}});
    const res = await svc().missionDispatch('lead-1', 'm1');
    expect(res).toEqual({ok: true, already: true, status: 'DISPATCHED', dispatched_at: null});
  });

  it('is lead-only: a non-lead crew member gets 400 lead_only, a stranger 404', async () => {
    wire({crew: {is_lead: false}});
    await expect(svc().missionDispatch('cpo-2', 'm1')).rejects.toBeInstanceOf(BadRequestException);
    wire({crew: null});
    await expect(svc().missionDispatch('nobody', 'm1')).rejects.toBeInstanceOf(NotFoundException);
    expect(db.qOne.mock.calls.some(c => /SET status = 'DISPATCHED'/.test(String(c[0])))).toBe(false);
  });

  it('a stood-down crew row (status off) cannot dispatch', async () => {
    wire({});
    await svc().missionDispatch('lead-1', 'm1');
    const crewSel = db.qOne.mock.calls.find(c => /SELECT is_lead FROM mission_crew/.test(String(c[0])));
    expect(String(crewSel![0])).toMatch(/status <> 'off'/);
  });

  it('an unknown mission id is 404, never a fabricated dispatch', async () => {
    wire({flipped: null, current: null});
    await expect(svc().missionDispatch('lead-1', 'ghost')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AgentService.dispatchMissionAsOrg — the agency door', () => {
  beforeEach(() => jest.resetAllMocks());

  it('is scoped to the ASSIGNED provider; another agency gets 404', async () => {
    wire({owned: false});
    await expect(svc().dispatchMissionAsOrg('org-B', 'mgr-B', 'm1')).rejects.toBeInstanceOf(NotFoundException);
    expect(db.qOne.mock.calls.some(c => /SET status = 'DISPATCHED'/.test(String(c[0])))).toBe(false);
  });

  it('flips the same conditional UPDATE and ALSO wakes every crew member except the presser', async () => {
    wire({crewIds: ['cpo-1', 'cpo-2', 'mgr-A']});
    const res = await svc().dispatchMissionAsOrg('org-A', 'mgr-A', 'm1');
    expect(res.already).toBe(false);
    await flush();
    expect(push.teamDispatched).toHaveBeenCalledWith('client-1', 'b1');
    expect(push.crewMoveOut).toHaveBeenCalledTimes(2);
    expect(push.crewMoveOut).toHaveBeenCalledWith('cpo-1', 'm1', 'b1');
    expect(push.crewMoveOut).toHaveBeenCalledWith('cpo-2', 'm1', 'b1');
    expect(push.crewMoveOut).not.toHaveBeenCalledWith('mgr-A', 'm1', 'b1');
    const audit = db.q.mock.calls.find(c => /INSERT INTO ops_audit/.test(String(c[0])));
    expect(JSON.parse(String(audit![1][2]))).toMatchObject({via: 'org', has_fix: false});
  });

  it('the org and lead doors racing each other: the loser sees the winner\'s state, wakes nobody', async () => {
    // Winner already flipped it — the loser's UPDATE matches 0 rows.
    wire({flipped: null, current: {status: 'DISPATCHED', dispatched_at: T0}});
    const res = await svc().dispatchMissionAsOrg('org-A', 'mgr-A', 'm1');
    expect(res).toEqual({ok: true, already: true, status: 'DISPATCHED', dispatched_at: T0.toISOString()});
    await flush();
    expect(push.teamDispatched).not.toHaveBeenCalled();
    expect(push.crewMoveOut).not.toHaveBeenCalled();
  });

  it('a failed push never fails the dispatch', async () => {
    wire({});
    push.teamDispatched.mockRejectedValue(new Error('fcm down'));
    await expect(svc().dispatchMissionAsOrg('org-A', 'mgr-A', 'm1')).resolves.toMatchObject({already: false});
  });
});

describe('B-795 — no "your team is on the way" after the customer cancelled', () => {
  beforeEach(() => jest.resetAllMocks());

  it('the flip stands (the cancel aborts it, not us) but the client push is silenced when the booking already ended', async () => {
    wire({bookingStatus: 'CANCELLED'});
    const res = await svc().missionDispatch('lead-1', 'm1');
    expect(res.already).toBe(false);
    await flush();
    expect(push.teamDispatched).not.toHaveBeenCalled();
  });

  it('an open booking still gets the wake (the status read is the gate, not the client_id)', async () => {
    wire({bookingStatus: 'CONFIRMED'});
    await svc().missionDispatch('lead-1', 'm1');
    await flush();
    expect(push.teamDispatched).toHaveBeenCalledWith('client-1', 'b1');
  });
});

describe('B-795 critic round — ops door, arrival clock, actor role', () => {
  beforeEach(() => jest.resetAllMocks());

  it('a fresh dispatch resets the arrival clock from NOW (GREATEST keeps a later Book Later deadline)', async () => {
    wire({});
    await svc().missionDispatch('lead-1', 'm1');
    const clk = db.q.mock.calls.find(c => /UPDATE lite_bookings\s+SET arrival_deadline_at = GREATEST/.test(String(c[0])));
    expect(clk).toBeDefined();
    expect(String(clk![0])).toMatch(/GREATEST\(COALESCE\(arrival_deadline_at, NOW\(\)\), NOW\(\) \+ \(\$2 \|\| ' minutes'\)::interval\)/);
    expect(clk![1]).toEqual(['b1', '20']);
  });

  it('a replay never touches the clock', async () => {
    wire({flipped: null, current: {status: 'DISPATCHED', dispatched_at: T0}});
    await svc().missionDispatch('lead-1', 'm1');
    expect(db.q.mock.calls.some(c => /arrival_deadline_at = GREATEST/.test(String(c[0])))).toBe(false);
  });

  it('the OPS door flips the same UPDATE, wakes the whole crew, and audits as OPS', async () => {
    wire({});
    const res = await svc().dispatchMissionAsOps('ops-1', 'm1');
    expect(res).toEqual({ok: true, already: false, status: 'DISPATCHED', dispatched_at: T0.toISOString()});
    await flush();
    expect(push.teamDispatched).toHaveBeenCalledWith('client-1', 'b1');
    expect(push.crewMoveOut).toHaveBeenCalledWith('cpo-1', 'm1', 'b1');
    expect(push.crewMoveOut).toHaveBeenCalledWith('cpo-2', 'm1', 'b1');
    const audit = db.q.mock.calls.find(c => /INSERT INTO ops_audit/.test(String(c[0])));
    expect(audit).toBeDefined();
    expect(String(audit![0])).toMatch(/VALUES \(\$1, \$4, 'mission.dispatched'/);
    expect(audit![1][3]).toBe('OPS');
    expect(JSON.parse(String(audit![1][2]))).toMatchObject({via: 'ops'});
  });

  it('the lead and agency doors still audit as AGENT', async () => {
    wire({});
    await svc().missionDispatch('lead-1', 'm1');
    const audit = db.q.mock.calls.find(c => /INSERT INTO ops_audit/.test(String(c[0])));
    expect(audit![1][3]).toBe('AGENT');
  });
});
