import type {RedisService} from '../../redis/redis.service';
import {ConfigVersionMirror, bumpConfigVersion, readConfigVersion} from './config-version';
import {bustAccountGate, bustTierGate} from './account-gate-cache';

/**
 * OP-02 / OP-03 / OP-05 — the cluster-wide invalidation primitives.
 *
 * Before this, the per-pod pricing/regions caches had no cross-pod signal and
 * the tier gate had no bust at all. These pin the primitives every write path
 * now leans on; the wiring (who calls them) is pinned in ops-propagation.spec.
 */
function fakeRedis(over: Partial<{get: jest.Mock; incr: jest.Mock; del: jest.Mock}> = {}) {
  const client = {get: jest.fn(), incr: jest.fn(), del: jest.fn(), ...over};
  return {redis: {client} as unknown as RedisService, client};
}

describe('config version — bump + read', () => {
  it('bump INCRs the namespaced key and never throws', async () => {
    const {redis, client} = fakeRedis();
    client.incr.mockResolvedValue(3);
    await bumpConfigVersion(redis, 'pricing');
    expect(client.incr).toHaveBeenCalledWith('cfgver:pricing');
    client.incr.mockRejectedValue(new Error('down'));
    await expect(bumpConfigVersion(redis, 'regions')).resolves.toBeUndefined();
  });

  it('read returns 0 for an absent key, the number for a set key, null without Redis / on error', async () => {
    const {redis, client} = fakeRedis();
    client.get.mockResolvedValueOnce(null);
    expect(await readConfigVersion(redis, 'pricing')).toBe(0);
    client.get.mockResolvedValueOnce('7');
    expect(await readConfigVersion(redis, 'pricing')).toBe(7);
    client.get.mockRejectedValueOnce(new Error('down'));
    expect(await readConfigVersion(redis, 'pricing')).toBeNull();
    expect(await readConfigVersion(undefined, 'pricing')).toBeNull();
  });
});

describe('ConfigVersionMirror — one Redis read per 2 s, fail-open', () => {
  it('re-reads only after the mirror TTL and keeps the last value on error', async () => {
    const {redis, client} = fakeRedis();
    const m = new ConfigVersionMirror('pricing', 2_000);
    client.get.mockResolvedValue('1');
    expect(await m.current(redis, 1_000)).toBe(1);
    expect(await m.current(redis, 2_500)).toBe(1);   // inside TTL — no read
    expect(client.get).toHaveBeenCalledTimes(1);
    client.get.mockResolvedValue('2');
    expect(await m.current(redis, 3_100)).toBe(2);   // TTL elapsed — re-read
    client.get.mockRejectedValue(new Error('down'));
    expect(await m.current(redis, 6_000)).toBe(2);   // error → last known, never null once known
  });

  it('is null when Redis is absent (a null never invalidates)', async () => {
    const m = new ConfigVersionMirror('regions');
    expect(await m.current(undefined)).toBeNull();
  });
});

describe('gate busts', () => {
  it('bustTierGate deletes tier-gate:<sub> (the key TierGuard reads); bustAccountGate deletes acct-gate:<sub>', async () => {
    const {redis, client} = fakeRedis();
    client.del.mockResolvedValue(1);
    await bustTierGate(redis, 'u1');
    await bustAccountGate(redis, 'u1');
    expect(client.del).toHaveBeenCalledWith('tier-gate:u1');
    expect(client.del).toHaveBeenCalledWith('acct-gate:u1');
  });

  it('both fail open', async () => {
    const {redis, client} = fakeRedis();
    client.del.mockRejectedValue(new Error('down'));
    await expect(bustTierGate(redis, 'u1')).resolves.toBeUndefined();
    await expect(bustTierGate(undefined, 'u1')).resolves.toBeUndefined();
  });
});
