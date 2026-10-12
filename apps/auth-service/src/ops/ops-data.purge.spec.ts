import {ConflictException} from '@nestjs/common';
import {OpsDataService} from './ops-data.service';

/**
 * 2026-10-12 — "Remove permanently" for already-deleted accounts, and the
 * Users list hiding deleted accounts unless asked for.
 */
function make(opts: {deleted?: boolean; fkTable?: string} = {}) {
  const sql: string[] = [];
  const tx = {
    qOne: jest.fn(async () => (opts.deleted === false ? null : {id: 'u-1'})),
    q: jest.fn(async (s: string) => {
      sql.push(s);
      if (opts.fkTable && /DELETE FROM public\.users/.test(s)) {
        throw Object.assign(new Error('fk'), {code: '23503', table: opts.fkTable});
      }
      return [];
    }),
  };
  const listParams: unknown[][] = [];
  const db = {
    withTransaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    q: jest.fn(async (_s: string, p: unknown[]) => { listParams.push(p); return []; }),
    qOne: jest.fn(),
  };
  return {svc: new OpsDataService(db as never), sql, listParams};
}

describe('purgeUser', () => {
  it('removes an erased account and its private rows', async () => {
    const t = make();
    await expect(t.svc.purgeUser('u-1')).resolves.toEqual({ok: true});
    expect(t.sql.join('\n')).toMatch(/message_envelopes[\s\S]*DELETE FROM admin_users[\s\S]*DELETE FROM public\.users/);
  });

  it('only an already-deleted account can be removed', async () => {
    await expect(make({deleted: false}).svc.purgeUser('u-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('records the business must keep → 409 saying what, and the entry stays', async () => {
    const err = await make({fkTable: 'wallet_transactions'}).svc.purgeUser('u-1').catch(e => e) as ConflictException;
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({error: 'has_records', table: 'wallet_transactions'});
    expect(String((err.getResponse() as {message: string}).message)).toMatch(/payment history/);
  });
});

describe('listUsers — deleted accounts', () => {
  it('hidden by default; "only" and "all" on request', async () => {
    const t = make();
    await t.svc.listUsers({});
    await t.svc.listUsers({deleted: 'only'});
    await t.svc.listUsers({deleted: 'all'});
    expect(t.listParams.map(p => p[6])).toEqual(['hide', 'only', 'all']);
  });
});
