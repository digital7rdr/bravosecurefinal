import {MissionSweepsService} from './mission-sweeps.service';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import type {ConfigService} from '@nestjs/config';
import type {AgentService} from './agent.service';

/**
 * E2E-05 / E2E-13 / E2E-14 (SECURE_SERVICES_E2E_AUDIT_2026-09-03).
 *
 * Pass A is a MONEY path, so its double-work guard is modelled, not asserted against an
 * inert double: the claim UPDATE is conditional on `settle_attempts = <the value the
 * pass read>`, and the fake honours that. A mock that always returned a row would make
 * "two pods cannot both retry the same hold" pass vacuously.
 */

const HOUR = 3600_000;

interface Row {booking_id: string; mission_id: string; settle_attempts: number}

interface World {
  due: Row[];
  /** the live settle_attempts value per booking — the claim CAS reads this */
  attempts: Record<string, number>;
  exhausted: Array<{booking_id: string; settle_attempts: number}>;
  blocks: Array<{mission_id: string; booking_id: string}>;
  checkins: Array<{
    mission_id: string; booking_id: string; provider: string | null;
    pickup_time: Date | null; live_at: Date | null; duration_hours: number;
    confirmed_hours: number[];
  }>;
  markers: Set<string>;
  sql: string[];
}

function mk(over: Partial<World> = {}) {
  const w: World = {
    due: [], attempts: {}, exhausted: [], blocks: [], checkins: [],
    markers: new Set<string>(), sql: [],
    ...over,
  };

  const q = jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
    w.sql.push(sql);
    if (/JOIN missions m ON m\.booking_id = eh\.booking_id AND m\.status = 'COMPLETED'/.test(sql)) {
      return Promise.resolve(w.due);
    }
    if (/SET settle_attempts = settle_attempts \+ 1/.test(sql)) {
      const [bookingId, seen] = params as [string, number];
      // The CAS is derived FROM THE SQL, not assumed: without the
      // `AND settle_attempts = $2` predicate the real UPDATE would match the row
      // whatever another pod had already done to it, so the mock must bump
      // unconditionally too — otherwise the "already claimed" pin passes vacuously
      // against a claim that isn't conditional at all.
      const conditional = /AND settle_attempts = \$2/.test(sql);
      if (conditional && (w.attempts[bookingId] ?? 0) !== seen) {return Promise.resolve([]); }
      w.attempts[bookingId] = (w.attempts[bookingId] ?? 0) + 1;
      return Promise.resolve([{settle_attempts: w.attempts[bookingId]}]);
    }
    if (/settle_alerted_at IS NULL OR settle_alerted_at </.test(sql)) {
      return Promise.resolve(w.exhausted);
    }
    if (/SET settle_alerted_at = NOW\(\)/.test(sql)) {return Promise.resolve([]); }
    if (/make_interval\(hours => b\.duration_hours\)/.test(sql)) {return Promise.resolve(w.blocks); }
    if (/mission_hourly_checkins h ON h\.mission_id = m\.id/.test(sql)) {return Promise.resolve(w.checkins); }
    return Promise.resolve([]);
  });

  const db = {q, qOne: jest.fn(), withTransaction: jest.fn()} as unknown as DatabaseService;

  const client = {
    // The check-in marker is now a plain GET/SET pair (set only AFTER a successful
    // notify), so the mock models a real key store rather than SET NX.
    get: jest.fn().mockImplementation((key: string) =>
      Promise.resolve(w.markers.has(key) ? '1' : null)),
    set: jest.fn().mockImplementation((key: string, _v: string, mode: string, _ttl: number, nx?: string) => {
      if (mode === 'PX' && nx === 'NX') {return Promise.resolve('OK'); }        // the sweep lock
      if (key.startsWith('mission:checkin-overdue:')) {
        w.markers.add(key);
        return Promise.resolve('OK');
      }
      return Promise.resolve('OK');                                             // liveness
    }),
    eval: jest.fn().mockResolvedValue(1),
  };
  const redis = {client} as unknown as RedisService;

  const config = {get: jest.fn().mockReturnValue(undefined)} as unknown as ConfigService;

  const agents = {
    retryStrandedSettlement: jest.fn().mockResolvedValue({outcome: 'pending_release'}),
    completeMissionAsSystem: jest.fn().mockResolvedValue({completed: true}),
    notifyCheckinOverdue: jest.fn().mockResolvedValue(undefined),
  };

  const svc = new MissionSweepsService(db, redis, config, agents as unknown as AgentService);
  return {svc, w, q, client, agents};
}

describe('MissionSweepsService — the fenced-lock contract', () => {
  it('does NO work when another pod holds the lock', async () => {
    const {svc, client, q, agents} = mk({due: [{booking_id: 'b1', mission_id: 'm1', settle_attempts: 0}]});
    client.set.mockResolvedValueOnce(null); // lock not acquired
    const r = await svc.sweepOnce();
    expect(r.skipped_lock).toBe(true);
    expect(q).not.toHaveBeenCalled();
    expect(agents.retryStrandedSettlement).not.toHaveBeenCalled();
    expect(client.eval).not.toHaveBeenCalled();
  });

  it('releases the fenced lock with the compare-and-delete script', async () => {
    const {svc, client} = mk();
    await svc.sweepOnce();
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, 'lock:mission-sweeps', expect.any(String));
  });

  it('one failing pass does not skip the others', async () => {
    const {svc, q, agents} = mk({blocks: [{mission_id: 'm9', booking_id: 'b9'}]});
    q.mockImplementationOnce(() => Promise.reject(new Error('pg timeout'))); // pass A's SELECT
    const r = await svc.sweepOnce();
    expect(r.settled).toBe(0);
    expect(agents.completeMissionAsSystem).toHaveBeenCalledWith('m9', 'system_block_end');
    expect(r.blocks_closed).toBe(1);
  });
});

describe('E2E-05 — stranded settlement retry', () => {
  it('re-runs the SAME settle path for a COMPLETED mission whose escrow is still HELD', async () => {
    const {svc, agents} = mk({
      due: [{booking_id: 'b1', mission_id: 'm1', settle_attempts: 0}],
      attempts: {b1: 0},
    });
    const r = await svc.sweepOnce();
    expect(agents.retryStrandedSettlement).toHaveBeenCalledWith('b1', 'm1');
    expect(r.settled).toBe(1);
  });

  it('a row already claimed by another pod is SKIPPED — no second retry, no double-pay risk', async () => {
    // The pass read settle_attempts = 0; another pod has since bumped it to 1, so the
    // conditional claim matches nothing.
    const {svc, agents} = mk({
      due: [{booking_id: 'b1', mission_id: 'm1', settle_attempts: 0}],
      attempts: {b1: 1},
    });
    const r = await svc.sweepOnce();
    expect(agents.retryStrandedSettlement).not.toHaveBeenCalled();
    expect(r.settled).toBe(0);
  });

  it('claims BEFORE it settles, so a throw inside the settle still burns an attempt', async () => {
    const {svc, w, agents} = mk({
      due: [{booking_id: 'b1', mission_id: 'm1', settle_attempts: 2}],
      attempts: {b1: 2},
    });
    agents.retryStrandedSettlement.mockRejectedValueOnce(new Error('PostGIS timeout'));
    const r = await svc.sweepOnce();
    expect(r.settled).toBe(0);
    expect(w.attempts.b1).toBe(3); // bounded — this row cannot spin forever
  });

  it('does not count a retry whose settle reported failure', async () => {
    const {svc, agents} = mk({
      due: [{booking_id: 'b1', mission_id: 'm1', settle_attempts: 0}],
      attempts: {b1: 0},
    });
    agents.retryStrandedSettlement.mockResolvedValueOnce({outcome: 'failed'});
    expect((await svc.sweepOnce()).settled).toBe(0);
  });

  it('P2-11 — review_required is counted as REVIEWED, never as recovered money', async () => {
    // The hold left HELD but now waits on an operator rather than the release sweep;
    // counting it as recovered makes the metric read healthy for money going nowhere.
    const {svc, agents} = mk({
      due: [{booking_id: 'b1', mission_id: 'm1', settle_attempts: 0}],
      attempts: {b1: 0},
    });
    agents.retryStrandedSettlement.mockResolvedValueOnce({outcome: 'review_required'});
    const r = await svc.sweepOnce();
    expect(r.settled).toBe(0);
    expect(r.reviewed).toBe(1);
  });

  it('the due query excludes review_required and no-show holds', async () => {
    // A HELD hold with review_required is a proof-gate FAIL awaiting an operator, not a
    // stranded settlement; retrying it would re-run the gate every minute forever. A
    // no_show_at hold never passes through this state at all.
    const {svc, w} = mk();
    await svc.sweepOnce();
    const due = w.sql.find(s => /m\.status = 'COMPLETED'/.test(s)) ?? '';
    expect(due).toMatch(/NOT eh\.review_required/);
    expect(due).toMatch(/eh\.no_show_at IS NULL/);
    expect(due).toMatch(/eh\.status = 'HELD'/);
    expect(due).toMatch(/LIMIT \d+/);
  });

  it('alerts (once per window) on a hold that has burned its attempt budget instead of retrying forever', async () => {
    const {svc, w} = mk({exhausted: [{booking_id: 'b7', settle_attempts: 5}]});
    const r = await svc.sweepOnce();
    expect(r.stranded_alerted).toBe(1);
    expect(w.sql.some(s => /SET settle_alerted_at = NOW\(\)/.test(s))).toBe(true);
  });
});

describe('E2E-13 — the EP block finally ends', () => {
  it('closes a LIVE EP mission past its contracted block through the SHARED completion funnel', async () => {
    const {svc, agents} = mk({blocks: [{mission_id: 'm2', booking_id: 'b2'}]});
    const r = await svc.sweepOnce();
    // completeMissionAsSystem routes into completeMissionCore, so the proof gate, the
    // escrow settlement and the pushes all still run — this is not a bespoke closer.
    expect(agents.completeMissionAsSystem).toHaveBeenCalledWith('m2', 'system_block_end');
    expect(r.blocks_closed).toBe(1);
  });

  it('is idempotent — a mission the core reports as already closed is not counted', async () => {
    const {svc, agents} = mk({blocks: [{mission_id: 'm2', booking_id: 'b2'}]});
    agents.completeMissionAsSystem.mockResolvedValueOnce({completed: false});
    expect((await svc.sweepOnce()).blocks_closed).toBe(0);
  });

  it('selects LIVE only — a timer may never quietly close a mission in SOS', async () => {
    const {svc, w} = mk();
    await svc.sweepOnce();
    const sql = w.sql.find(s => /make_interval\(hours => b\.duration_hours\)/.test(s)) ?? '';
    expect(sql).toMatch(/m\.status = 'LIVE'/);
    expect(sql).not.toMatch(/'SOS'/);
    expect(sql).toMatch(/b\.service = 'executive_protection'/);
  });
});

describe('E2E-14 — a missed hourly check-in has a consequence', () => {
  const liveBlock = (over: Partial<World['checkins'][number]> = {}) => ([{
    mission_id: 'm3', booking_id: 'b3', provider: 'org1',
    pickup_time: new Date(Date.now() - 3 * HOUR), live_at: new Date(Date.now() - 3 * HOUR),
    duration_hours: 6, confirmed_hours: [] as number[],
    ...over,
  }]);

  it('flags the next unconfirmed hour once it is overdue past the grace', async () => {
    const {svc, agents} = mk({checkins: liveBlock()});
    const r = await svc.sweepOnce();
    expect(r.checkins_overdue).toBe(1);
    expect(agents.notifyCheckinOverdue).toHaveBeenCalledWith(expect.objectContaining({
      missionId: 'm3', bookingId: 'b3', providerUserId: 'org1', hourIndex: 1,
    }));
  });

  it('does NOT re-page every tick — the (mission, hour) marker dedupes it', async () => {
    const {svc, agents} = mk({checkins: liveBlock()});
    await svc.sweepOnce();
    await svc.sweepOnce();
    expect(agents.notifyCheckinOverdue).toHaveBeenCalledTimes(1);
  });

  it('says nothing while the hour is still inside its grace', async () => {
    // Hour 1 came due 5 minutes ago; the grace is 20.
    const {svc, agents} = mk({
      checkins: liveBlock({pickup_time: new Date(Date.now() - HOUR - 5 * 60_000)}),
    });
    expect((await svc.sweepOnce()).checkins_overdue).toBe(0);
    expect(agents.notifyCheckinOverdue).not.toHaveBeenCalled();
  });

  it('says nothing once every contracted hour is confirmed', async () => {
    const {svc, agents} = mk({checkins: liveBlock({duration_hours: 2, confirmed_hours: [1, 2]})});
    expect((await svc.sweepOnce()).checkins_overdue).toBe(0);
    expect(agents.notifyCheckinOverdue).not.toHaveBeenCalled();
  });

  it('P2-8 — finds an INTERIOR gap: confirming hour 3 must not bury a skipped hour 2', async () => {
    // With MAX(hour_index)+1 the "next" hour was 4, so the one hour that was genuinely
    // never confirmed became invisible FOREVER — the exact case the detector exists for.
    const {svc, agents} = mk({checkins: liveBlock({confirmed_hours: [1, 3]})});
    expect((await svc.sweepOnce()).checkins_overdue).toBe(1);
    expect(agents.notifyCheckinOverdue).toHaveBeenCalledWith(
      expect.objectContaining({hourIndex: 2}),
    );
  });

  it('reports the LOWEST missing hour, not merely any missing one', async () => {
    const {svc, agents} = mk({checkins: liveBlock({confirmed_hours: [2, 3]})});
    await svc.sweepOnce();
    expect(agents.notifyCheckinOverdue).toHaveBeenCalledWith(
      expect.objectContaining({hourIndex: 1}),
    );
  });

  it('P2-9 — a notify that throws does NOT burn the marker into six hours of silence', async () => {
    const {svc, agents} = mk({checkins: liveBlock()});
    agents.notifyCheckinOverdue.mockRejectedValueOnce(new Error('redis down'));
    await svc.sweepOnce();          // first tick: notify throws, marker must NOT be set
    await svc.sweepOnce();          // second tick: it must try again
    expect(agents.notifyCheckinOverdue).toHaveBeenCalledTimes(2);
  });

  it('measures overdue on the CONTRACTED anchor, matching the check-in endpoint (E2E-16)', async () => {
    // Went live 10 minutes ago but the contracted block started 3h ago: hour 1 is
    // overdue. Under a live_at anchor this would look perfectly on time.
    const {svc, agents} = mk({
      checkins: liveBlock({live_at: new Date(Date.now() - 10 * 60_000)}),
    });
    expect((await svc.sweepOnce()).checkins_overdue).toBe(1);
    expect(agents.notifyCheckinOverdue).toHaveBeenCalledWith(
      expect.objectContaining({hourIndex: 1}),
    );
  });

  it('never moves money or a mission status — it is a detector', async () => {
    const {svc, agents} = mk({checkins: liveBlock()});
    await svc.sweepOnce();
    expect(agents.completeMissionAsSystem).not.toHaveBeenCalled();
    expect(agents.retryStrandedSettlement).not.toHaveBeenCalled();
  });
});
