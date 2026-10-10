import {ConflictException, NotFoundException} from '@nestjs/common';
import {applyIdentityEdit, normaliseIdentityPatch} from './identity-edit';
import {UpdateUserProfileDto, UserAdminController} from './user-admin.controller';
import {UpdateAdminDto} from '../ops/dto/ops.dto';
import {validate} from 'class-validator';
import {plainToInstance} from 'class-transformer';

/**
 * Edit user / admin details from the ops console (2026-10-10). Verified
 * against Postgres 16 during development; these pin the rules without a DB.
 */
const CUR = {display_name: 'Old', email: 'old@x.com', phone_e164: '+971500000001'};

function fakeTx(over: {cur?: unknown; clash?: boolean; updateErr?: unknown} = {}) {
  const calls: Array<[string, unknown[]]> = [];
  return {
    calls,
    qOne: jest.fn(async (sql: string, args: unknown[]) => {
      calls.push([sql, args]);
      if (/FOR UPDATE/.test(sql)) return over.cur === undefined ? CUR : over.cur;
      return over.clash ? {'?column?': 1} : null;
    }),
    q: jest.fn(async (sql: string, args: unknown[]) => {
      calls.push([sql, args]);
      if (over.updateErr && /UPDATE public\.users/.test(sql)) throw over.updateErr;
      return [];
    }),
  };
}

describe('applyIdentityEdit', () => {
  it('normalises: trims the name, lower-cases the email, strips phone spacing', () => {
    expect(normaliseIdentityPatch({display_name: '  A B ', email: ' A@B.COM ', phone_e164: '+971 50-123 (4567)'}))
      .toEqual({display_name: 'A B', email: 'a@b.com', phone_e164: '+971501234567'});
  });

  it('an erased account cannot be edited', async () => {
    await expect(applyIdentityEdit(fakeTx({cur: null}) as never, 'u', {display_name: 'X'})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('nothing changed → no write, nothing to audit', async () => {
    const tx = fakeTx();
    const out = await applyIdentityEdit(tx as never, 'u', {display_name: 'Old', email: 'OLD@x.com'});
    expect(out).toEqual({changed: [], audit: {}});
    expect(tx.q).not.toHaveBeenCalled();
  });

  it('a new email/phone resets its verification and is audited masked', async () => {
    const tx = fakeTx();
    const out = await applyIdentityEdit(tx as never, 'u', {email: 'new.person@x.com', phone_e164: '+971509999988'});
    expect(out.changed).toEqual(['email', 'phone_e164']);
    const upd = tx.calls.find(([s]) => /UPDATE public\.users/.test(s))!;
    expect(upd[1]).toEqual(['u', 'Old', 'new.person@x.com', '+971509999988', true, true]);
    expect(JSON.stringify(out.audit)).not.toMatch(/new\.person|509999988/);
    expect(tx.calls.some(([s]) => /UPDATE admin_users/.test(s))).toBe(true);
  });

  it('a taken email or phone is a 409, also when the database catches the race', async () => {
    await expect(applyIdentityEdit(fakeTx({clash: true}) as never, 'u', {email: 'b@x.com'})).rejects.toThrow('email_taken');
    await expect(applyIdentityEdit(fakeTx({clash: true}) as never, 'u', {phone_e164: '+971500000002'})).rejects.toThrow('phone_taken');
    const race = Object.assign(new Error('dup'), {code: '23505', constraint: 'users_email_key'});
    await expect(applyIdentityEdit(fakeTx({updateErr: race}) as never, 'u', {email: 'b@x.com'})).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('edit endpoints', () => {
  it('validate their input', async () => {
    const bad = await validate(plainToInstance(UpdateUserProfileDto, {display_name: 'A', email: 'nope', phone_e164: '0501234567'}));
    expect(bad.map(e => e.property).sort()).toEqual(['display_name', 'email', 'phone_e164']);
    expect(await validate(plainToInstance(UpdateUserProfileDto, {display_name: 'Nadia H', email: 'n@x.com', phone_e164: '+971501234567'}))).toEqual([]);
    const badAdmin = await validate(plainToInstance(UpdateAdminDto, {call_sign: '-x', region: 'uae'}));
    expect(badAdmin.map(e => e.property).sort()).toEqual(['call_sign', 'region']);
    expect(await validate(plainToInstance(UpdateAdminDto, {call_sign: 'RISK-01', region: 'AE'}))).toEqual([]);
  });

  it('the user edit is audited only when something changed', async () => {
    const audit = {recordAdmin: jest.fn()};
    const tx = fakeTx();
    const db = {withTransaction: (fn: (t: unknown) => unknown) => fn(tx)};
    const ctl = new UserAdminController({} as never, audit as never, db as never);
    const req = {admin: {user_id: 'a'}} as unknown as {admin: {user_id: string}};
    await ctl.updateProfile('11111111-1111-4111-8111-111111111111', {display_name: 'Old'}, req as never);
    expect(audit.recordAdmin).not.toHaveBeenCalled();
    await ctl.updateProfile('11111111-1111-4111-8111-111111111111', {display_name: 'New'}, req as never);
    expect(audit.recordAdmin).toHaveBeenCalledWith(req.admin, 'user.profile.update', 'user', '11111111-1111-4111-8111-111111111111',
      {changed: {display_name: {from: 'Old', to: 'New'}}});
  });
});
