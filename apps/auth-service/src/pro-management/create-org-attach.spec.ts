import {ConflictException} from '@nestjs/common';
import {ProManagementService} from './pro-management.service';

/**
 * 2026-10-23 — "One number uniquely linked to one user; a user can be admin,
 * CPO or service provider." Ops "create organisation" on a number that
 * already has an account adds the provider company to THAT account.
 */
function build(opts: {byPhone?: {id: string; email: string | null} | null; byEmail?: {id: string} | null; agent?: {type: string; status: string} | null} = {}) {
  const txQ = jest.fn(async () => []);
  const txQOne = jest.fn(async () => ({id: 'new-user'}));
  const db = {
    qOne: jest.fn(async (sql: string) => {
      if (/WHERE phone_e164 = \$1/.test(sql)) {return opts.byPhone ?? null;}
      if (/WHERE email = \$1/.test(sql)) {return opts.byEmail ?? null;}
      if (/FROM agents WHERE user_id/.test(sql)) {return opts.agent ?? null;}
      return null;
    }),
    q: jest.fn(async () => []),
    withTransaction: jest.fn(async (fn: (t: unknown) => unknown) => fn({q: txQ, qOne: txQOne})),
  };
  const password = {hash: jest.fn(async () => 'hash')};
  const del = jest.fn(async () => 1);
  const svc = new ProManagementService(db as never, password as never, {} as never, {} as never, {} as never, {client: {del}} as never);
  return {svc, db, txQ, txQOne, password, del};
}
const admin = {user_id: 'adm-1', role: 'ADMIN', call_sign: 'A1', region: 'GLOBAL'} as never;
const dto = {display_name: 'Falcon Protection', email: 'ops@falcon.test', phone_e164: '+971500000001', temp_password: 'Temp-pass-123', coverage_country: 'AE'};

describe('ops create organisation on an existing account', () => {
  it('attaches: no new user, role becomes provider, password untouched, gate refreshed', async () => {
    const t = build({byPhone: {id: 'u-1', email: null}, byEmail: null});
    const {org} = await t.svc.createOrg(admin, dto as never);
    expect(org).toMatchObject({id: 'u-1', existing_account: true});
    expect(t.txQOne).not.toHaveBeenCalled();                 // no INSERT INTO users
    expect(t.password.hash).not.toHaveBeenCalled();
    const sqls = t.txQ.mock.calls.map(c => String((c as unknown[])[0]));
    expect(sqls.some(s => /UPDATE public\.users SET role = 'service_provider'/.test(s))).toBe(true);
    expect(sqls.some(s => /password/.test(s))).toBe(false);
    expect(sqls.some(s => /INSERT INTO agents \(user_id, type, status/.test(s))).toBe(true);
    expect(t.del).toHaveBeenCalledWith('acct-gate:u-1');
  });

  it('a brand-new number still creates the account with the temp password', async () => {
    const t = build();
    const {org} = await t.svc.createOrg(admin, dto as never);
    expect(org).toMatchObject({id: 'new-user', existing_account: false});
    expect(t.password.hash).toHaveBeenCalledWith('Temp-pass-123');
  });

  it('refuses when the email belongs to someone else, or the account already is a provider or a CPO', async () => {
    await expect(build({byPhone: {id: 'u-1', email: null}, byEmail: {id: 'u-2'}}).svc.createOrg(admin, dto as never)).rejects.toThrow('email_in_use');
    await expect(build({byPhone: null, byEmail: {id: 'u-2'}}).svc.createOrg(admin, dto as never)).rejects.toThrow('email_in_use');
    await expect(build({byPhone: {id: 'u-1', email: null}, agent: {type: 'company', status: 'ACTIVE'}}).svc.createOrg(admin, dto as never)).rejects.toThrow('already_a_provider');
    await expect(build({byPhone: {id: 'u-1', email: null}, agent: {type: 'cpo', status: 'ACTIVE'}}).svc.createOrg(admin, dto as never)).rejects.toBeInstanceOf(ConflictException);
  });
});
