/**
 * SECURE_SERVICES_E2E_AUDIT_2026-09-03 — E2E-39.
 *
 * `suspendUser` / `restoreUser` skipped the 30 s account-gate bust that the
 * terminate path already performs (`ops.service.ts` revertRoleOnAgentExit), so a
 * cached account_kind / membership_status could outlive the write by up to the
 * whole TTL. `eraseUser` had the same hole and is covered here too — it is the
 * strongest of the three, and the only one the cache can genuinely contradict
 * (`deleted_at` sits in ACCOUNT_KIND_SQL's own WHERE, so a fresh read fails
 * closed while a stale entry still answers with the old account_kind).
 *
 * The Redis double below MODELS the cache: `bustAccountGate` issues a DEL on
 * `acct-gate:<sub>`, so the assertion is on the key that was actually deleted —
 * a mock that only counted calls could not tell a bust of the RIGHT user from a
 * bust of the wrong one.
 */
import {NotFoundException} from '@nestjs/common';
import {OpsDataService} from './ops-data.service';

function makeSvc(opts: {
  suspendable?: boolean; suspended?: boolean; erasable?: boolean; delThrows?: boolean;
} = {}) {
  const cache = new Map<string, string>([
    ['acct-gate:u-1', JSON.stringify({account_kind: 'cpo', membership_status: 'active'})],
    ['acct-gate:u-other', JSON.stringify({account_kind: 'cpo', membership_status: 'active'})],
  ]);
  const del = jest.fn(async (key: string) => {
    if (opts.delThrows) throw new Error('redis down');
    return cache.delete(key) ? 1 : 0;
  });
  const db = {
    q: jest.fn().mockResolvedValue([]),
    qOne: jest.fn(async (sql: string) => {
      if (/SET suspended_at = NOW\(\)/.test(sql)) return opts.suspendable === false ? null : {id: 'u-1'};
      if (/SET suspended_at = NULL/.test(sql)) return opts.suspended === false ? null : {id: 'u-1'};
      if (/SET deleted_at = NOW\(\)/.test(sql)) return opts.erasable === false ? null : {id: 'u-1'};
      return null;
    }),
  };
  const svc = new OpsDataService(db as never, {client: {del}} as never);
  return {svc, db, del, cache};
}

describe('E2E-39 — suspend/restore bust the account gate', () => {
  it('suspendUser deletes the suspended user\'s cached gate (and only theirs)', async () => {
    const {svc, del, cache} = makeSvc();
    const r = await svc.suspendUser('adm-1', 'u-1', 'fraud review');
    expect(r.ok).toBe(true);
    expect(del).toHaveBeenCalledWith('acct-gate:u-1');
    expect(cache.has('acct-gate:u-1')).toBe(false);
    expect(cache.has('acct-gate:u-other')).toBe(true);
  });

  it('the bust runs AFTER the write — a bust that lands first can be refilled', async () => {
    const {svc, db, del} = makeSvc();
    await svc.suspendUser('adm-1', 'u-1', 'fraud review');
    const suspendWrite = db.qOne.mock.invocationCallOrder[0];
    expect(del.mock.invocationCallOrder[0]).toBeGreaterThan(suspendWrite);
  });

  it('restoreUser busts too — a restored user must not keep the locked-out gate', async () => {
    const {svc, del, cache} = makeSvc();
    await svc.restoreUser('u-1');
    expect(del).toHaveBeenCalledWith('acct-gate:u-1');
    expect(cache.has('acct-gate:u-1')).toBe(false);
  });

  it('eraseUser busts too — the strongest action must not be the one that leaves a stale gate', async () => {
    const {svc, del, cache} = makeSvc();
    const r = await svc.eraseUser('adm-1', 'u-1', 'gdpr request');
    expect(r.ok).toBe(true);
    expect(del).toHaveBeenCalledWith('acct-gate:u-1');
    expect(cache.has('acct-gate:u-1')).toBe(false);
    expect(cache.has('acct-gate:u-other')).toBe(true);
  });

  it('the erase bust runs AFTER the write, like the other two', async () => {
    const {svc, db, del} = makeSvc();
    await svc.eraseUser('adm-1', 'u-1', 'gdpr request');
    expect(del.mock.invocationCallOrder[0]).toBeGreaterThan(db.qOne.mock.invocationCallOrder[0]);
  });

  it('a refused suspend/restore/erase busts nothing (no write, no invalidation)', async () => {
    const a = makeSvc({suspendable: false});
    await expect(a.svc.suspendUser('adm-1', 'u-1', 'x')).rejects.toBeInstanceOf(NotFoundException);
    expect(a.del).not.toHaveBeenCalled();

    const b = makeSvc({suspended: false});
    await expect(b.svc.restoreUser('u-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(b.del).not.toHaveBeenCalled();

    // An already-erased user is a no-op: no second tombstone write, no bust.
    const c = makeSvc({erasable: false});
    await expect(c.svc.eraseUser('adm-1', 'u-1', 'x')).rejects.toBeInstanceOf(NotFoundException);
    expect(c.del).not.toHaveBeenCalled();
  });

  it('a Redis failure never fails the erasure either — GDPR erasure must not 500 on a cache DEL', async () => {
    const {svc} = makeSvc({delThrows: true});
    await expect(svc.eraseUser('adm-1', 'u-1', 'gdpr request')).resolves.toEqual(
      expect.objectContaining({ok: true}));
  });

  it('a Redis failure never fails the suspension — the 30 s TTL is the backstop', async () => {
    const {svc} = makeSvc({delThrows: true});
    await expect(svc.suspendUser('adm-1', 'u-1', 'fraud review')).resolves.toEqual(
      expect.objectContaining({ok: true}));
  });

  it('no Redis at all (positional spec construction) still suspends', async () => {
    const db = {
      q: jest.fn().mockResolvedValue([]),
      qOne: jest.fn().mockResolvedValue({id: 'u-1'}),
    };
    const svc = new OpsDataService(db as never);
    await expect(svc.suspendUser('adm-1', 'u-1', 'x')).resolves.toEqual(
      expect.objectContaining({ok: true}));
  });
});
