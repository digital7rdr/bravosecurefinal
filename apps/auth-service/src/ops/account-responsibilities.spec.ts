import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ConflictException} from '@nestjs/common';
import {OpsDataService} from './ops-data.service';
import {BLOCKERS, KEPT_RECORDS, RESPONSIBILITY_STEPS, previewResponsibilities} from './account-responsibilities';

/**
 * Owner, 2026-10-23: one number = one account, which can be admin, CPO and
 * service provider at once; deleting it removes every linked responsibility,
 * and the console warns first that this cannot be restored.
 */
function make(opts: {blocker?: string; linked?: string[]} = {}) {
  const sql: Array<{s: string; p: unknown[]}> = [];
  const tx = {
    qOne: jest.fn(async (s: string) => (/deleted_at IS NULL FOR UPDATE/.test(s) ? {id: 'u-1'} : null)),
    q: jest.fn(async (s: string, p: unknown[]) => {
      sql.push({s, p});
      if (opts.blocker && s === BLOCKERS.find(b => b.key === opts.blocker)?.count) {return [{n: 2}];}
      if (/UNION SELECT user_id FROM public\.agents WHERE managed_by_org_id/.test(s)) {return (opts.linked ?? []).map(id => ({id}));}
      return [];
    }),
  };
  const del = jest.fn(async () => 1);
  const db = {
    q: jest.fn(async () => []),
    qOne: jest.fn(),
    withTransaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return {svc: new OpsDataService(db as never, {client: {del}} as never), sql, del, tx};
}

describe('deleting an account releases every role and responsibility', () => {
  it('runs every release statement for that account, after the tombstone, in one transaction', async () => {
    const t = make();
    const r = await t.svc.eraseUser('adm-1', 'u-1', 'asked to close');
    expect(r.ok).toBe(true);
    const ran = t.sql.map(x => x.s);
    const tomb = ran.findIndex(s => /SET deleted_at = NOW\(\)/.test(s));
    expect(tomb).toBeGreaterThan(-1);
    for (const step of RESPONSIBILITY_STEPS) {
      for (const stmt of step.release) {
        const at = ran.indexOf(stmt);
        expect([step.key, at > tomb]).toEqual([step.key, true]);
        expect(t.sql[at].p).toEqual(['u-1']);
      }
    }
  });

  it('covers every role: admin, CPO, provider company and its roster, workspace', () => {
    const keys = RESPONSIBILITY_STEPS.map(s => s.key);
    expect(keys).toEqual(expect.arrayContaining(['admin', 'cpo', 'provider', 'workspace', 'roster', 'memberships']));
    const all = RESPONSIBILITY_STEPS.flatMap(s => s.release).join('\n');
    expect(all).toMatch(/UPDATE public\.admin_users SET active = FALSE, phone_e164 = NULL/);
    expect(all).toMatch(/SET status = 'REJECTED', on_duty = FALSE, managed_by_org_id = NULL/);
    // Owner decision: a deleted provider's CPOs keep their accounts, unlinked.
    expect(all).toMatch(/UPDATE public\.agents SET managed_by_org_id = NULL WHERE managed_by_org_id = \$1 AND user_id <> \$1/);
    expect(all).not.toMatch(/DELETE FROM public\.agents/);
    expect(all).not.toMatch(/DELETE FROM public\.users/);
  });

  it('keeps business records — no payment, booking, mission or audit row is touched', () => {
    const all = RESPONSIBILITY_STEPS.flatMap(s => s.release).join('\n');
    for (const t of ['wallet_transactions', 'lite_bookings', 'mission_crew', 'missions', 'mission_payouts', 'audit_events', 'ops_audit']) {
      expect([t, new RegExp(`(DELETE FROM|UPDATE) public\\.${t}\\b`).test(all)]).toEqual([t, false]);
    }
  });

  it('refuses while the account is on a mission in progress, and writes nothing', async () => {
    const t = make({blocker: 'crew_on_active_mission'});
    const err = await t.svc.eraseUser('adm-1', 'u-1', 'x').catch(e => e) as ConflictException;
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({error: 'has_active_work'});
    expect(t.sql.some(x => /SET deleted_at/.test(x.s))).toBe(false);
    expect(t.del).not.toHaveBeenCalled();
  });

  it('refreshes the cached access of everyone it unlinked', async () => {
    const t = make({linked: ['cpo-1', 'cpo-2']});
    const r = await t.svc.eraseUser('adm-1', 'u-1', 'x');
    expect(r.unlinked_members).toBe(2);
    expect(t.del).toHaveBeenCalledWith('acct-gate:u-1');
    expect(t.del).toHaveBeenCalledWith('acct-gate:cpo-1');
    expect(t.del).toHaveBeenCalledWith('acct-gate:cpo-2');
  });
});

describe('the warning shown before deleting', () => {
  it('lists what it holds, what stays and what blocks — only non-zero lines', async () => {
    const counts: Record<string, number> = {admin: 1, provider: 1, roster: 3, documents: 4};
    const q = jest.fn(async (sql: string) => {
      const step = RESPONSIBILITY_STEPS.find(s => s.count === sql);
      if (step) {return [{n: counts[step.key] ?? 0}];}
      if (sql === KEPT_RECORDS.find(k => k.key === 'payments')?.count) {return [{n: 7}];}
      if (/wallet_balances/.test(sql)) {return [{c: 120}];}
      if (/auth_devices/.test(sql)) {return [{n: 2}];}
      return [{n: 0}];
    });
    const p = await previewResponsibilities(q, 'u-1', {display_name: 'Falcon', deleted: false});
    expect(p.roles.map(r => r.key)).toEqual(['admin', 'provider']);
    expect(p.responsibilities).toEqual([expect.objectContaining({key: 'roster', count: 3, label: '3 people on its roster or team unlinked (their own accounts stay)'})]);
    expect(p.data).toEqual([expect.objectContaining({key: 'documents', count: 4})]);
    expect(p.kept).toEqual([{key: 'payments', label: '7 payment records', count: 7}]);
    expect(p.blockers).toEqual([]);
    expect(p.wallet_credits).toBe(120);
    expect(p.devices).toBe(2);
  });
});

describe('every table it touches still exists after the last migration', () => {
  it('no statement names a dropped or never-created table', () => {
    const dir = join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations');
    const live = new Set<string>();
    for (const f of readdirSync(dir).filter(x => x.endsWith('.sql')).sort()) {
      const sql = readFileSync(join(dir, f), 'utf8').toLowerCase()
        .replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''); // comments are not statements
      for (const m of sql.matchAll(/(create|drop) table (?:if (?:not )?exists )?(?:public\.)?([a-z_]+)/g)) {
        if (m[1] === 'create') {live.add(m[2]);} else {live.delete(m[2]);}
      }
    }
    const sqls = [
      ...RESPONSIBILITY_STEPS.flatMap(s => [s.count, ...s.release]),
      ...KEPT_RECORDS.map(k => k.count), ...BLOCKERS.map(b => b.count),
    ];
    const tables = new Set(sqls.flatMap(s => [...s.matchAll(/(?:FROM|UPDATE|JOIN|USING) public\.([a-z_]+)/g)].map(m => m[1])));
    expect(tables.size).toBeGreaterThan(30);
    for (const t of tables) {expect([t, live.has(t)]).toEqual([t, true]);}
  });
});
