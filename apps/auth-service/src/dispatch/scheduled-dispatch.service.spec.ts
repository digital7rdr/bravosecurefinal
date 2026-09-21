import {ScheduledDispatchService} from './scheduled-dispatch.service';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import type {ConfigService} from '@nestjs/config';
import type {DispatchService} from './dispatch.service';

const db = {q: jest.fn()};
const client = {set: jest.fn(), del: jest.fn(), eval: jest.fn().mockResolvedValue(1)};
const redis = {client};
const config = {get: jest.fn()};
const dispatch = {start: jest.fn(), expireStaleScheduled: jest.fn(), offerNext: jest.fn()};

function svc(): ScheduledDispatchService {
  return new ScheduledDispatchService(
    db as unknown as DatabaseService,
    redis as unknown as RedisService,
    config as unknown as ConfigService,
    dispatch as unknown as DispatchService,
  );
}

/**
 * The sweep issues FOUR selects per tick, in this fixed order:
 *   [0] DUE   — parked rows inside the service-aware lead window (with a floor)
 *   [1] STUCK — INFRA-2 'now' recovery
 *   [2] STALE — E2E-04: parked rows PAST the floor
 *   [3] RETRY — E2E-11: scheduled searches stalled with runway left
 * `queue` returns them positionally so a test can wire one pass and leave the
 * others empty (a blanket mockResolvedValue would feed the same rows to all four).
 */
function queue(...results: Array<Array<{id: string}>>): void {
  let i = 0;
  db.q.mockImplementation(() => Promise.resolve(results[i++] ?? []));
}
const NONE: Array<{id: string}> = [];

describe('ScheduledDispatchService', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    config.get.mockReturnValue(true);   // AUTO_DISPATCH_ENABLED on
    client.set.mockResolvedValue('OK'); // lock acquired
    client.del.mockResolvedValue(1);
    dispatch.start.mockResolvedValue(undefined);
    dispatch.expireStaleScheduled.mockResolvedValue(true);
    dispatch.offerNext.mockResolvedValue(undefined);
    queue();
  });

  it('no-ops when AUTO_DISPATCH_ENABLED is off (ships dark)', async () => {
    config.get.mockReturnValue(false);
    const r = await svc().sweepOnce();
    expect(r).toEqual({started: 0, expired_stale: 0, retried: 0, skipped_lock: false, skipped_flag: true});
    expect(client.set).not.toHaveBeenCalled();
    expect(db.q).not.toHaveBeenCalled();
  });

  it('does NO work when another pod holds the lock (multi-pod safe)', async () => {
    client.set.mockResolvedValue(null);
    const r = await svc().sweepOnce();
    expect(r.skipped_lock).toBe(true);
    expect(db.q).not.toHaveBeenCalled();
    expect(dispatch.start).not.toHaveBeenCalled();
    expect(dispatch.expireStaleScheduled).not.toHaveBeenCalled();
    expect(dispatch.offerNext).not.toHaveBeenCalled();
  });

  it('starts each due "later" booking once and releases the lock', async () => {
    queue([{id: 'b1'}, {id: 'b2'}], NONE, NONE, NONE);
    const r = await svc().sweepOnce();
    expect(dispatch.start).toHaveBeenCalledTimes(2);
    expect(dispatch.start).toHaveBeenCalledWith('b1');
    expect(dispatch.start).toHaveBeenCalledWith('b2');
    expect(r).toEqual({started: 2, expired_stale: 0, retried: 0, skipped_lock: false, skipped_flag: false});
    // Ops-gated: the query targets APPROVED auto "later" bookings inside the lead
    // window (plus legacy in-flight DRAFT rows from the pre-gate flow).
    expect(db.q.mock.calls[0][0]).toMatch(/booking_mode = 'later'[\s\S]*status IN \('OPS_APPROVED', 'DRAFT'\)/);
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, 'lock:scheduled-dispatch', expect.any(String));
  });

  it('dispatches OPS_APPROVED(later) but NEVER an unapproved PENDING_OPS row (ops approval is the gate)', async () => {
    queue();
    await svc().sweepOnce();
    const sql = db.q.mock.calls[0][0] as string;
    expect(sql).toMatch(/'OPS_APPROVED'/);
    expect(sql).not.toMatch(/PENDING_OPS/);
    // Auto-scoped: legacy admin-flow bookings can never be swept into the matchmaker.
    expect(sql).toMatch(/dispatch_mode = 'auto'/);
  });

  it('INFRA-2: recovers a stuck approved "now" booking whose ops-approved pub/sub frame was lost', async () => {
    queue(NONE, [{id: 'now-1'}], NONE, NONE);
    const r = await svc().sweepOnce();
    expect(dispatch.start).toHaveBeenCalledWith('now-1');
    expect(r.started).toBe(1);
    // The recovery query targets approved 'now' bookings never started past the grace.
    const stuckSql = db.q.mock.calls[1][0] as string;
    expect(stuckSql).toMatch(/booking_mode = 'now'[\s\S]*status = 'OPS_APPROVED'[\s\S]*dispatch_started_at IS NULL/);
    expect(stuckSql).toMatch(/updated_at < NOW\(\)/);
  });

  it('a single failing start does not abort the sweep, and the lock is still released', async () => {
    queue([{id: 'bad'}, {id: 'b2'}], NONE, NONE, NONE);
    dispatch.start.mockRejectedValueOnce(new Error('raced'));
    const r = await svc().sweepOnce();
    expect(dispatch.start).toHaveBeenCalledTimes(2);
    expect(r.started).toBe(1); // bad one didn't count
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, 'lock:scheduled-dispatch', expect.any(String));
  });

  // ─── E2E-11 — the lead window is SERVICE-AWARE ────────────────────────────
  describe('E2E-11: Executive Protection searches far earlier than a transfer', () => {
    it('the DUE query picks the lead window per service, not one window for all', async () => {
      queue();
      await svc().sweepOnce();
      const sql = db.q.mock.calls[0][0] as string;
      // EP takes $2 (default 24 h), everything else keeps $1 (default 15 min).
      expect(sql).toMatch(/CASE WHEN service = 'executive_protection'\s+THEN \$2::text ELSE \$1::text END/);
      const params = db.q.mock.calls[0][1] as number[];
      expect(params[0]).toBe(15);
      expect(params[1]).toBe(1440);
      // The casts are load-bearing: without ::text on BOTH arms Postgres cannot
      // resolve the CASE result type for the `|| ' minutes'` concat.
      expect(sql).not.toMatch(/THEN \$2 ELSE \$1 END/);
    });

    it('re-drives a scheduled search that stalled with NO live offer and runway left', async () => {
      queue(NONE, NONE, NONE, [{id: 'stalled-1'}]);
      const r = await svc().sweepOnce();
      expect(dispatch.offerNext).toHaveBeenCalledWith('stalled-1');
      expect(r.retried).toBe(1);
      const sql = db.q.mock.calls[3][0] as string;
      // Only DISPATCHING rows with runway and no live offer — never a terminal one.
      expect(sql).toMatch(/status = 'DISPATCHING'/);
      expect(sql).toMatch(/pickup_time > NOW\(\)/);
      expect(sql).toMatch(/NOT EXISTS[\s\S]*o\.status = 'OFFERED'/);
      // A retry must never resurrect a terminal booking — that is arch-gated.
      expect(sql).not.toMatch(/NO_PROVIDER/);
    });

    it('a failing retry does not abort the sweep', async () => {
      queue(NONE, NONE, NONE, [{id: 'x'}, {id: 'y'}]);
      dispatch.offerNext.mockRejectedValueOnce(new Error('boom'));
      const r = await svc().sweepOnce();
      expect(dispatch.offerNext).toHaveBeenCalledTimes(2);
      expect(r.retried).toBe(1);
      expect(client.eval).toHaveBeenCalled();
    });
  });

  // ─── E2E-04 — the sweep now has a LOWER bound ─────────────────────────────
  describe('E2E-04: a booking whose start is already past is closed out, never dispatched', () => {
    it('the DUE query has a FLOOR, so a stale row cannot be selected for dispatch', async () => {
      queue();
      await svc().sweepOnce();
      const sql = db.q.mock.calls[0][0] as string;
      expect(sql).toMatch(/pickup_time <= NOW\(\) \+/);
      // The half this used to be missing entirely.
      expect(sql).toMatch(/pickup_time > NOW\(\) - \(\$3::text \|\| ' minutes'\)::interval/);
      expect((db.q.mock.calls[0][1] as number[])[2]).toBe(30);
    });

    it('routes rows past the floor to expireStaleScheduled — NOT to start()', async () => {
      queue(NONE, NONE, [{id: 'old-1'}, {id: 'old-2'}], NONE);
      const r = await svc().sweepOnce();
      expect(dispatch.expireStaleScheduled).toHaveBeenCalledTimes(2);
      expect(dispatch.expireStaleScheduled).toHaveBeenCalledWith('old-1');
      expect(dispatch.start).not.toHaveBeenCalled();
      expect(r.expired_stale).toBe(2);
      const sql = db.q.mock.calls[2][0] as string;
      // Same PARKED cohort as the due pass, on the other side of the floor. A
      // DISPATCHING/CONFIRMED row belongs to the relist/crew-SLA sweeps — closing
      // one here could strand an accepted agency's escrow.
      expect(sql).toMatch(/status IN \('OPS_APPROVED', 'DRAFT'\)/);
      expect(sql).toMatch(/dispatch_started_at IS NULL/);
      expect(sql).toMatch(/pickup_time <= NOW\(\) - /);
    });

    it('counts only the rows THIS pod actually flipped (a raced row returns false)', async () => {
      queue(NONE, NONE, [{id: 'a'}, {id: 'b'}], NONE);
      dispatch.expireStaleScheduled.mockResolvedValueOnce(false); // another pod won
      const r = await svc().sweepOnce();
      expect(r.expired_stale).toBe(1);
    });

    it('a failing close-out does not abort the sweep or skip the retry pass', async () => {
      queue(NONE, NONE, [{id: 'bad'}], [{id: 'stalled'}]);
      dispatch.expireStaleScheduled.mockRejectedValueOnce(new Error('boom'));
      const r = await svc().sweepOnce();
      expect(r.expired_stale).toBe(0);
      expect(dispatch.offerNext).toHaveBeenCalledWith('stalled');
      expect(client.eval).toHaveBeenCalled();
    });
  });
});
