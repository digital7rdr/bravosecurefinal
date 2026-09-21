/**
 * E2E-35 — the protection sweeps come off the ops poll and get bounds.
 *
 * They used to run inline on getCurrent, cpoOverview AND opsListSessions with
 * no Redis lock and no LIMIT — i.e. once per operator per 2 s SWR tick — while
 * the retention DELETE over protection_session_locations ran unbounded on
 * create() and SWALLOWED its own failure, so the day it crossed
 * statement_timeout it would silently stop pruning for good.
 *
 * Pinned here: every sweep is bounded, the retention DELETE is batched with a
 * per-tick cap, a failure is reported at ERROR with the row count, and the 2 s
 * read path runs no sweep at all.
 */
import {ProtectionService} from './protection.service';
import type {DatabaseService} from '../database/database.service';
import {GULF_TODAY_SQL} from '../pro-applications/gulf-day';

function mk(opts: {deleteRows?: number[]; failDeleteAt?: number} = {}) {
  const qCalls: Array<{sql: string; params?: unknown[]}> = [];
  let deleteIx = 0;
  const db = {
    q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qCalls.push({sql, params});
      if (/DELETE FROM public\.protection_session_locations/.test(sql)) {
        const i = deleteIx++;
        if (opts.failDeleteAt === i) {return Promise.reject(new Error('canceling statement due to statement timeout'));}
        const n = opts.deleteRows?.[i] ?? 0;
        return Promise.resolve(Array.from({length: n}, (_, k) => ({id: String(k)})));
      }
      return Promise.resolve([]);
    }),
    qOne: jest.fn().mockResolvedValue(null),
  } as unknown as DatabaseService;
  const log = {error: jest.fn(), warn: jest.fn(), log: jest.fn()};
  const svc = new ProtectionService(
    db,
    {emit: jest.fn().mockResolvedValue(undefined)} as never,
    {broadcast: jest.fn().mockResolvedValue(undefined)} as never,
    {psessionNew: jest.fn().mockResolvedValue(undefined)} as never,
  );
  (svc as unknown as {log: typeof log}).log = log;
  return {svc, qCalls, log};
}

describe('ProtectionService sweeps — bounded (E2E-35)', () => {
  it('the stale-activation sweep picks its victims through a LIMIT', async () => {
    const {svc, qCalls} = mk();
    await svc.sweepStaleActivations(25);
    const sql = qCalls[0].sql;
    expect(sql).toMatch(/WITH victims AS \(/);
    expect(sql).toMatch(/LIMIT 25/);
    expect(sql).toMatch(/make_interval\(mins => 10\)/);
    // The guard is re-asserted on the UPDATE, so a row that moved between the
    // pick and the write is not flipped anyway.
    expect(sql).toMatch(/WHERE id IN \(SELECT id FROM victims\) AND status = 'REQUESTED'/);
  });

  it('the max-duration sweep picks its victims through a LIMIT', async () => {
    const {svc, qCalls} = mk();
    await svc.sweepMaxDuration(25);
    const sql = qCalls[0].sql;
    expect(sql).toMatch(/LIMIT 25/);
    expect(sql).toMatch(/make_interval\(hours => 12\)/);
    expect(sql).toMatch(/WHERE id IN \(SELECT id FROM victims\) AND status = 'ACTIVE'/);
  });

  it('a caller-supplied LIMIT can never escape the interpolation cap', async () => {
    const {svc, qCalls} = mk();
    await svc.sweepStaleActivations(Number.POSITIVE_INFINITY);
    await svc.sweepMaxDuration(-5);
    expect(qCalls[0].sql).toMatch(/LIMIT 500/);
    expect(qCalls[1].sql).toMatch(/LIMIT 1/);
  });

  it('a sweep failure is reported at ERROR, never swallowed at warn', async () => {
    const {svc, log} = mk();
    (svc as unknown as {db: {q: jest.Mock}}).db.q = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(svc.sweepMaxDuration()).resolves.toBe(0);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('max-duration sweep failed'));
  });
});

describe('ProtectionService.sweepRetention — batched (E2E-35)', () => {
  it('loops until the batch comes back short, and stops there', async () => {
    const {svc, qCalls} = mk({deleteRows: [500, 500, 120]});
    const deleted = await svc.sweepRetention(500, 20);
    expect(deleted).toBe(1120);
    expect(qCalls).toHaveLength(3);
    expect(qCalls[0].sql).toMatch(/LIMIT 500/);
    expect(qCalls[0].sql).toMatch(/make_interval\(days => 30\)/);
  });

  it('honours the per-tick cap when the backlog never drains', async () => {
    const {svc, qCalls} = mk({deleteRows: Array.from({length: 40}, () => 500)});
    const deleted = await svc.sweepRetention(500, 5);
    expect(qCalls).toHaveLength(5);
    expect(deleted).toBe(2500);
  });

  it('reports a mid-batch failure at ERROR with the row count and stops', async () => {
    const {svc, log, qCalls} = mk({deleteRows: [500, 500], failDeleteAt: 2});
    const deleted = await svc.sweepRetention(500, 20);
    expect(deleted).toBe(1000);
    expect(qCalls).toHaveLength(3);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('retention sweep failed after 1000 row(s)'));
  });
});

describe('ProtectionService.sweepActivationEscalations — the E2E-08 session half', () => {
  it('claims each session once and raises an ops feed warn', async () => {
    const {svc, qCalls} = mk();
    await svc.sweepActivationEscalations(15, 30);
    const sql = qCalls[0].sql;
    expect(sql).toMatch(/status = 'REQUESTED' AND escalated_at IS NULL/);
    expect(sql).toMatch(/make_interval\(mins => 15\)/);
    expect(sql).toMatch(/LIMIT 30/);
    expect(sql).toMatch(/INSERT INTO public\.live_feed_events/);
    // No state change: the session is still legitimately openable.
    expect(sql).not.toMatch(/SET status =/);
  });

  it('a bad minutes value falls back to 15 rather than erroring every tick', async () => {
    const {svc, qCalls} = mk();
    await svc.sweepActivationEscalations(Number.NaN);
    expect(qCalls[0].sql).toMatch(/make_interval\(mins => 15\)/);
  });
});

describe('ProtectionService — coverage reads on the canonical day (E2E-09)', () => {
  it('cpoOverview scopes today by the Gulf day and sweeps nothing', async () => {
    const {svc, qCalls} = mk();
    await svc.cpoOverview('cpo-1');
    const sql = qCalls.find(c => /FROM public\.pro_cpo_assignments pca/.test(c.sql))!.sql;
    expect(sql).toContain(`${GULF_TODAY_SQL} BETWEEN pca.starts_on AND pca.ends_on`);
    expect(qCalls.every(c => !/make_interval/.test(c.sql))).toBe(true);
  });

  it('opsListSessions (the 2 s poll) runs no sweep at all', async () => {
    const {svc, qCalls} = mk();
    await svc.opsListSessions({});
    expect(qCalls.some(c => /make_interval/.test(c.sql))).toBe(false);
    expect(qCalls.some(c => /DELETE FROM public\.protection_session_locations/.test(c.sql))).toBe(false);
  });
});
