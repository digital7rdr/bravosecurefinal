/**
 * B-820 (founder, 2026-09-07) — "on bravo acc it can be no problem, he can
 * still create for ops (ops is a separate thing)".
 *
 * Both provisioning paths INSERTed a brand-new `public.users` row, so a phone
 * that already had a Bravo app account hit `users.phone_e164`'s UNIQUE index:
 * the invite screen said "That phone or email is already registered" and the
 * founder could not make himself — or any of the team who already use the app —
 * an ops admin at all.
 *
 * RED-first: before the fix `redeemInvite` / `createAccount` always inserted,
 * so the "existing account" cases below threw 23505.
 *
 * The security rule these pin: attaching NEVER touches the existing account's
 * password. The console role is an ADDITION to an identity, not a takeover of
 * one — a silent password rewrite would let an invite holder (or a super admin
 * acting on a mistyped number) seize a live account and lock its owner out.
 */
import {Test, TestingModule} from '@nestjs/testing';
import {ConflictException} from '@nestjs/common';
import {AdminInvitesService} from './admin-invites.service';
import {DatabaseService} from '../database/database.service';
import {PasswordService} from '../common/services/password.service';
import {AuthService} from '../auth/auth.service';
import {OpsAuditService} from './ops-audit.service';
import type {AdminContext} from './admin.guard';

const SUPER: AdminContext = {user_id: 'admin-1', role: 'SUPER_ADMIN', call_sign: 'SUP-01', region: 'AE'};
const PHONE = '+8801799306165';

const mockDb = {q: jest.fn(), qOne: jest.fn(), withTransaction: jest.fn()};
const mockPw = {hash: jest.fn(), verify: jest.fn()};
const mockAuth = {revokeAllUserSessions: jest.fn()};
const mockAudit = {recordAdmin: jest.fn()};

const INVITE = {
  id: 'inv-1', email: 'ops7@bravo.test', display_name: 'Ops Seven', call_sign: 'OPS-07',
  role: 'RISK_ADMIN', region: 'AE', invited_by: 'admin-1',
};

/** A transaction double whose `qOne` answers by SQL shape, so the service's own
 *  branching is exercised rather than a fixed call order. */
function makeTx(opts: {userExists: boolean; alreadyAdmin?: boolean; invite?: object | null}) {
  const calls: Array<{sql: string; params: unknown[]}> = [];
  const qOne = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({sql, params});
    if (/UPDATE public\.admin_invites SET redeemed_at/.test(sql)) {
      return opts.invite === undefined ? INVITE : opts.invite;
    }
    if (/SELECT id FROM public\.users WHERE phone_e164/.test(sql)) {
      return opts.userExists ? {id: 'existing-user'} : null;
    }
    if (/SELECT user_id FROM admin_users WHERE user_id/.test(sql)) {
      return opts.alreadyAdmin ? {user_id: 'existing-user'} : null;
    }
    if (/INSERT INTO public\.users/.test(sql)) return {id: 'new-user'};
    return null;
  });
  const q = jest.fn(async (sql: string, params: unknown[] = []) => { calls.push({sql, params}); return []; });
  return {tx: {q, qOne}, calls};
}

async function build(): Promise<AdminInvitesService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AdminInvitesService,
      {provide: DatabaseService, useValue: mockDb},
      {provide: PasswordService, useValue: mockPw},
      {provide: AuthService, useValue: mockAuth},
      {provide: OpsAuditService, useValue: mockAudit},
    ],
  }).compile();
  return module.get(AdminInvitesService);
}

beforeEach(() => {
  jest.resetAllMocks();
  mockPw.hash.mockResolvedValue('$argon2id$mock');
  mockAudit.recordAdmin.mockResolvedValue(undefined);
  mockDb.q.mockResolvedValue([]);
});

describe('redeemInvite — an existing Bravo account can take a console role', () => {
  it('ATTACHES the admin row and never writes the existing user’s password', async () => {
    const {tx, calls} = makeTx({userExists: true});
    mockDb.withTransaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    const svc = await build();

    const res = await svc.redeemInvite({token: 't', phone_e164: PHONE, password: 'a-new-password'});
    expect(res).toMatchObject({ok: true, call_sign: 'OPS-07', role: 'RISK_ADMIN', existing_account: true});

    // THE BUG: this INSERT is what raised 23505 on a phone already in use.
    expect(calls.some(c => /INSERT INTO public\.users/.test(c.sql))).toBe(false);
    // …and nothing rewrote the account's credentials.
    expect(calls.some(c => /UPDATE public\.users/.test(c.sql))).toBe(false);
    expect(JSON.stringify(calls)).not.toContain('a-new-password');

    const grant = calls.find(c => /INSERT INTO admin_users/.test(c.sql));
    expect(grant?.params[0]).toBe('existing-user');
    expect(grant?.params).toContain('RISK_ADMIN');
    // The invite is consumed against the account that actually got the role.
    const link = calls.find(c => /SET redeemed_user_id/.test(c.sql));
    expect(link?.params).toEqual(['inv-1', 'existing-user']);
  });

  it('still CREATES the account when the phone is new, and applies the password', async () => {
    const {tx, calls} = makeTx({userExists: false});
    mockDb.withTransaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    const svc = await build();

    const res = await svc.redeemInvite({token: 't', phone_e164: '+971500000009', password: 'pw-12345678'});
    expect(res.existing_account).toBe(false);
    const ins = calls.find(c => /INSERT INTO public\.users/.test(c.sql));
    expect(ins?.params).toEqual(['ops7@bravo.test', '+971500000009', 'Ops Seven', '$argon2id$mock']);
  });

  it('refuses a SECOND admin row for the same person — that is a duplicate identity, not a grant', async () => {
    const {tx} = makeTx({userExists: true, alreadyAdmin: true});
    mockDb.withTransaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    const svc = await build();
    await expect(svc.redeemInvite({token: 't', phone_e164: PHONE, password: 'pw-12345678'}))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('an invalid or expired token is still refused before any user is touched', async () => {
    const {tx, calls} = makeTx({userExists: false, invite: null});
    mockDb.withTransaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    const svc = await build();
    await expect(svc.redeemInvite({token: 'bad', phone_e164: PHONE, password: 'pw-12345678'}))
      .rejects.toThrow('invite_invalid_or_expired');
    expect(calls.some(c => /INSERT INTO/.test(c.sql))).toBe(false);
  });
});

describe('createAccount — a super admin can grant console access to an existing Bravo user', () => {
  const DTO = {
    display_name: 'Ranak', call_sign: 'RISK-02', role: 'RISK_ADMIN' as const,
    phone_e164: PHONE, password: 'typed-by-the-super-admin',
  };

  it('ATTACHES rather than failing on the phone’s UNIQUE index, and leaves the password alone', async () => {
    const {tx, calls} = makeTx({userExists: true});
    mockDb.withTransaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    const svc = await build();

    const res = await svc.createAccount(SUPER, DTO);
    expect(res).toMatchObject({ok: true, user_id: 'existing-user', existing_account: true});
    expect(calls.some(c => /INSERT INTO public\.users/.test(c.sql))).toBe(false);
    expect(JSON.stringify(calls)).not.toContain('typed-by-the-super-admin');

    // The audit says which lane it took, so "why is their password unchanged?"
    // is answerable months later.
    const audit = calls.find(c => /INSERT INTO ops_audit/.test(c.sql));
    expect(JSON.parse(String(audit?.params[4])).existing_account).toBe(true);
  });

  it('creates a fresh account when the phone is unknown', async () => {
    const {tx, calls} = makeTx({userExists: false});
    mockDb.withTransaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    const svc = await build();

    const res = await svc.createAccount(SUPER, {...DTO, phone_e164: '+971500000010'});
    expect(res.existing_account).toBe(false);
    expect(calls.some(c => /INSERT INTO public\.users/.test(c.sql))).toBe(true);
    const audit = calls.find(c => /INSERT INTO ops_audit/.test(c.sql));
    expect(JSON.parse(String(audit?.params[4])).existing_account).toBe(false);
  });

  it('refuses when that person already holds a console account', async () => {
    const {tx} = makeTx({userExists: true, alreadyAdmin: true});
    mockDb.withTransaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    const svc = await build();
    await expect(svc.createAccount(SUPER, DTO)).rejects.toBeInstanceOf(ConflictException);
  });
});
