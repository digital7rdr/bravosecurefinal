import {OfferExpiryService} from './offer-expiry.service';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import type {ConfigService} from '@nestjs/config';
import type {DispatchService} from './dispatch.service';

const db = {q: jest.fn()};
const client = {set: jest.fn(), del: jest.fn(), eval: jest.fn().mockResolvedValue(1)};
const redis = {client};
const config = {get: jest.fn()};
const dispatch = {expire: jest.fn()};

function svc(): OfferExpiryService {
  return new OfferExpiryService(
    db as unknown as DatabaseService,
    redis as unknown as RedisService,
    config as unknown as ConfigService,
    dispatch as unknown as DispatchService,
  );
}

describe('OfferExpiryService', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    config.get.mockReturnValue(true);    // AUTO_DISPATCH_ENABLED on
    client.set.mockResolvedValue('OK');  // lock acquired
    client.del.mockResolvedValue(1);
    dispatch.expire.mockResolvedValue(undefined);
  });

  it('no-ops (no lock, no DB) when AUTO_DISPATCH_ENABLED is off', async () => {
    config.get.mockReturnValue(false);
    const r = await svc().sweepOnce();
    expect(r).toEqual({expired: 0, skipped_lock: false, skipped_flag: true});
    expect(client.set).not.toHaveBeenCalled();
    expect(db.q).not.toHaveBeenCalled();
  });

  it('does NO work when another pod holds the lock — multi-pod double-cascade guard (LB9)', async () => {
    client.set.mockResolvedValue(null); // SET NX failed
    const r = await svc().sweepOnce();
    expect(r.skipped_lock).toBe(true);
    expect(db.q).not.toHaveBeenCalled();
    expect(dispatch.expire).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled(); // never acquired → never released
  });

  it('expires each due offer once, writes the liveness key, and releases the lock', async () => {
    db.q.mockResolvedValue([{id: 'o1'}, {id: 'o2'}]);
    const r = await svc().sweepOnce();
    expect(dispatch.expire).toHaveBeenCalledTimes(2);
    expect(dispatch.expire).toHaveBeenCalledWith('o1');
    expect(dispatch.expire).toHaveBeenCalledWith('o2');
    expect(r).toEqual({expired: 2, skipped_lock: false, skipped_flag: false});
    expect(client.set).toHaveBeenCalledWith('dispatch:watchdog:offer:last_run', expect.any(String), 'EX', 600);
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, 'lock:dispatch-offer-expiry', expect.any(String));
  });

  it('B-788a — the duty / stale-fix disjuncts apply to RADIUS offers only; an assigned offer lives to its expires_at', async () => {
    db.q.mockResolvedValue([]);
    await svc().sweepOnce();
    const sql = String(db.q.mock.calls[0][0]);
    expect(sql).toMatch(/o\.expires_at < NOW\(\) - \(\$1 \|\| ' seconds'\)::interval/);
    // The gate must WRAP both non-TTL reasons — a bare `OR a.on_duty = FALSE` is the P0.
    expect(sql).toMatch(/\(\(o\.source IS NULL OR o\.source = 'nearest'\)\s+AND \(a\.on_duty = FALSE\s+OR a\.last_location_at < NOW\(\)/);
    expect(sql).not.toMatch(/\n\s*OR a\.on_duty = FALSE/);
  });

  it('a single failing expire does not abort the sweep and the lock is still released', async () => {
    db.q.mockResolvedValue([{id: 'bad'}, {id: 'o2'}]);
    dispatch.expire.mockRejectedValueOnce(new Error('boom'));
    const r = await svc().sweepOnce();
    expect(dispatch.expire).toHaveBeenCalledTimes(2); // continued past the failure
    expect(r.expired).toBe(2);
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, 'lock:dispatch-offer-expiry', expect.any(String));
  });

  // ─── E2E-24 (audit 2026-09-03) — the lock must outlive its own batch ───────
  describe('E2E-24: the batch can never outrun the lock', () => {
    it('acquires a TTL LONGER than the interval, not the old 7 s < 8 s', async () => {
      db.q.mockResolvedValue([]);
      await svc().sweepOnce();
      const [, , mode, ttl, nx] = client.set.mock.calls[0] as [string, string, string, number, string];
      expect(mode).toBe('PX');
      expect(nx).toBe('NX');
      // 7_000 was SHORTER than one worst-case batch (50 rows x a transaction +
      // a full PostGIS ranking pass each), so the lock lapsed mid-batch and two
      // ticks ran the same cascade. Must comfortably exceed the batch, and the
      // 8 s interval with it.
      expect(ttl).toBeGreaterThan(8_000);
      expect(ttl).toBe(30_000);
    });

    it('keeps the batch at 50 — the BUDGET bounds the tick, not the row count', async () => {
      // Cutting BATCH would cut throughput (BATCH per 8 s tick = ~375/min at 50,
      // ~75/min at 10) without buying safety the time-based guard does not
      // already give. Pinned so the "make the batch smaller" reflex costs a test.
      db.q.mockResolvedValue([]);
      await svc().sweepOnce();
      expect(db.q.mock.calls[0][0] as string).toMatch(/LIMIT 50\s*$/m);
    });

    it('stops early and defers the remainder once the tick burns its lock budget', async () => {
      const rows = Array.from({length: 10}, (_, i) => ({id: `o${i}`}));
      db.q.mockResolvedValue(rows);
      // Each expire() advances the clock past the 20 s budget on the 3rd row.
      let now = 1_000_000;
      const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
      dispatch.expire.mockImplementation(() => { now += 9_000; return Promise.resolve(undefined); });
      try {
        const r = await svc().sweepOnce();
        // rows 1,2,3 run (budget is checked BEFORE each row, so the 3rd starts at
        // 18 s); the 4th sees 27 s > 20 s and the batch defers.
        expect(dispatch.expire).toHaveBeenCalledTimes(3);
        expect(r.expired).toBe(3);
        // Deferred, never run unlocked — and the lock is still released cleanly.
        expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, 'lock:dispatch-offer-expiry', expect.any(String));
      } finally {
        spy.mockRestore();
      }
    });
  });
});
