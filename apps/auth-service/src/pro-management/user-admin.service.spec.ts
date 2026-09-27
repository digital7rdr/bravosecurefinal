import {ConflictException} from '@nestjs/common';
import {UserAdminService} from './user-admin.service';

const admin = {user_id: 'admin-1', role: 'SUPER_ADMIN', call_sign: 'A1', region: 'GLOBAL'} as never;
const base = {display_name: 'Pat Lee', email: 'pat@x.com', phone_e164: '+971500000002'};

function build(opts: {existing?: boolean; smsSent?: boolean; smsThrows?: boolean} = {}) {
  const pending = {invited_at: '2026-09-27 10:00:00+00', invite_expires_at: '2026-10-11 10:00:00+00', has_password: false, expired: false};
  const db = {
    q: jest.fn().mockResolvedValue([]),
    qOne: jest.fn(async (sql: string, _params?: unknown[]) => {
      if (/SELECT id FROM public\.users WHERE \(email/.test(sql)) {return opts.existing ? {id: 'taken'} : null;}
      if (/INSERT INTO public\.users/.test(sql)) {return {id: 'new-individual'};}
      if (/invited_at::text AS invited_at/.test(sql)) {return pending;}
      if (/SET invite_expires_at = now\(\)/.test(sql)) {return null;} // resend on a non-pending row
      return null;
    }),
  };
  const proMgmt = {
    createOrg: jest.fn().mockResolvedValue({org: {id: 'new-agency'}}),
    createCpo: jest.fn().mockResolvedValue({member: {member_user_id: 'new-cpo'}}),
  };
  const sms = {sendSms: opts.smsThrows
    ? jest.fn().mockRejectedValue(new Error('twilio down'))
    : jest.fn().mockResolvedValue({sent: opts.smsSent ?? true})};
  return {svc: new UserAdminService(db as never, proMgmt as never, sms as never), db, proMgmt, sms};
}

describe('UserAdminService — accounts as SMS invites, no admin passwords', () => {
  it('individual: inserted with NO password and invite fields, then SMS-invited', async () => {
    const {svc, db, sms} = build();
    const out = await svc.createUser(admin, {account_type: 'individual', ...base});
    const insert = db.qOne.mock.calls.find(c => /INSERT INTO public\.users/.test(String(c[0])))!;
    expect(String(insert[0])).toMatch(/'individual', 'lite', NULL, 'approved'/); // password_hash NULL
    expect(String(insert[0])).toMatch(/invited_at, invited_by, invite_expires_at/);
    expect(insert[1]).toEqual([base.email, base.phone_e164, base.display_name, 'admin-1', 14]);
    expect(sms.sendSms).toHaveBeenCalledWith(base.phone_e164, expect.stringMatching(/sign up with this number/));
    expect(out).toMatchObject({user_id: 'new-individual', account_type: 'individual', sms_sent: true, invite: {pending: true}});
  });

  it('agency: reuses createOrg with a throwaway password, then nulls it into an invite', async () => {
    const {svc, db, proMgmt} = build();
    await svc.createUser(admin, {account_type: 'agency', ...base, coverage_country: 'SA'});
    const arg = proMgmt.createOrg.mock.calls[0][1];
    expect(arg).toMatchObject({display_name: base.display_name, email: base.email, phone_e164: base.phone_e164, coverage_country: 'SA'});
    expect(typeof arg.temp_password).toBe('string');
    expect(arg.temp_password.length).toBeGreaterThanOrEqual(24);
    const convert = db.q.mock.calls.find(c => /SET password_hash = NULL, password_set_at = NULL/.test(String(c[0])))!;
    expect(convert[1]).toEqual(['new-agency', 'admin-1', 14]);
  });

  it('two agencies never get the same throwaway password', async () => {
    const {svc, proMgmt} = build();
    await svc.createUser(admin, {account_type: 'agency', ...base});
    await svc.createUser(admin, {account_type: 'agency', ...base});
    expect(proMgmt.createOrg.mock.calls[0][1].temp_password).not.toBe(proMgmt.createOrg.mock.calls[1][1].temp_password);
  });

  it('cpo: needs an agency, reuses createCpo, then converts to an invite', async () => {
    const {svc, db, proMgmt} = build();
    await expect(svc.createUser(admin, {account_type: 'cpo', ...base})).rejects.toThrow('agency_required');
    await svc.createUser(admin, {account_type: 'cpo', ...base, agency_user_id: 'agency-9', call_sign: 'K9'});
    expect(proMgmt.createCpo.mock.calls[0][1]).toMatchObject({org_user_id: 'agency-9', call_sign: 'K9'});
    expect(db.q.mock.calls.some(c => /SET password_hash = NULL/.test(String(c[0])) && (c[1] as string[])[0] === 'new-cpo')).toBe(true);
  });

  it('an email or phone already in use is refused before anything is written', async () => {
    const {svc, db, proMgmt} = build({existing: true});
    await expect(svc.createUser(admin, {account_type: 'individual', ...base})).rejects.toBeInstanceOf(ConflictException);
    expect(db.qOne.mock.calls.some(c => /INSERT/.test(String(c[0])))).toBe(false);
    expect(proMgmt.createOrg).not.toHaveBeenCalled();
  });

  it('an SMS failure never fails the creation — the console says it was not sent', async () => {
    const {svc} = build({smsThrows: true});
    await expect(svc.createUser(admin, {account_type: 'individual', ...base})).resolves.toMatchObject({sms_sent: false});
  });

  it('resend refuses an account that is not a pending invite', async () => {
    const {svc} = build();
    await expect(svc.resendInvite(admin, 'u-claimed')).rejects.toThrow('not_a_pending_invite');
  });
});
