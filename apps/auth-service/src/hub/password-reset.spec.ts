import {BadRequestException, ForbiddenException, HttpException, ServiceUnavailableException} from '@nestjs/common';
import {PasswordResetService} from './password-reset.service';

/**
 * "Forgot your password?" on the home site (2026-10-11): the same answer
 * whether or not an account exists, a real code by text or email, the
 * authenticator still asked for when the account has one, and every device
 * signed out after the change.
 */

type Opts = {
  user?: {id: string; email: string | null; phone_e164: string | null; email_verified_at: string | null} | null;
  sms?: boolean; email?: boolean; totp?: 'none' | 'verified'; staff?: boolean; codeOk?: boolean; totpOk?: boolean;
  samePassword?: boolean;
};

function make(o: Opts = {}) {
  const user = o.user === undefined ? {id: 'u-1', email: 'nadia@example.com', phone_e164: '+971501234567', email_verified_at: '2026-10-01'} : o.user;
  const store = new Map<string, string>();
  const updates: unknown[][] = [];
  const db = {
    qOne: jest.fn(async (sql: string) => {
      if (/FROM admin_users/.test(sql)) return o.staff ? {'?column?': 1} : null;
      if (/SELECT password_hash/.test(sql)) return user ? {password_hash: 'old-hash'} : null;
      if (/FROM public\.users/.test(sql)) return user;
      return null;
    }),
    q: jest.fn(async (_sql: string, params: unknown[]) => { updates.push(params); return []; }),
  };
  const redis = {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { store.set(k, v); }),
    takeOnce: jest.fn(async (k: string) => { const v = store.get(k) ?? null; store.delete(k); return v; }),
  };
  const audit = {emit: jest.fn(async () => undefined)};
  const password = {
    hash: jest.fn(async (p: string) => `hash:${p}`),
    verify: jest.fn(async () => !!o.samePassword),
  };
  const otp = {
    smsReady: jest.fn(() => o.sms ?? true),
    emailReady: jest.fn(() => o.email ?? true),
    send: jest.fn(async () => undefined),
    sendEmail: jest.fn(async () => undefined),
    issueStub: jest.fn(),
    check: jest.fn(async () => o.codeOk ?? true),
  };
  const totp = {
    status: jest.fn(async () => o.totp ?? 'none'),
    check: jest.fn(async () => { if (o.totpOk === false) throw new Error('totp_invalid'); }),
  };
  const auth = {revokeAllUserSessions: jest.fn(async () => 2)};
  const svc = new PasswordResetService(db as never, redis as never, audit as never, password as never, otp as never, totp as never, auth as never);
  return {svc, db, redis, otp, totp, auth, audit, store, updates};
}

describe('start', () => {
  it('texts a code to a known number (never the testing stub)', async () => {
    const t = make();
    const {resetId} = await t.svc.start('+971 50 123 4567', '1.2.3.4');
    expect(resetId).toMatch(/^[A-Za-z0-9_-]{30,}$/);
    expect(t.otp.send).toHaveBeenCalledWith('+971501234567', '');
    expect(t.otp.issueStub).not.toHaveBeenCalled();
  });

  it('emails a code when an email is typed', async () => {
    const t = make();
    await t.svc.start('Nadia@Example.com', 'ip');
    expect(t.otp.sendEmail).toHaveBeenCalledWith('nadia@example.com');
    expect(t.otp.send).not.toHaveBeenCalled();
  });

  it('a number with no SMS set up falls back to the account\'s VERIFIED email', async () => {
    const t = make({sms: false});
    await t.svc.start('+971501234567', 'ip');
    expect(t.otp.sendEmail).toHaveBeenCalledWith('nadia@example.com');
    const t2 = make({sms: false, user: {id: 'u-2', email: 'x@y.z', phone_e164: '+971501234567', email_verified_at: null}});
    await t2.svc.start('+971501234567', 'ip');
    expect(t2.otp.sendEmail).not.toHaveBeenCalled();
  });

  it('answers the same for an unknown account, and sends nothing', async () => {
    const t = make({user: null});
    const out = await t.svc.start('+971509999999', 'ip');
    expect(Object.keys(out)).toEqual(['resetId']);
    expect(t.otp.send).not.toHaveBeenCalled();
    expect(t.otp.sendEmail).not.toHaveBeenCalled();
    await expect(t.svc.complete(out.resetId, {code: '123456', newPassword: 'a long new password'}, 'ip'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(t.otp.check).not.toHaveBeenCalled();
  });

  it('closed when neither text nor email is set up; rejects a malformed number', async () => {
    await expect(make({sms: false, email: false}).svc.start('+971501234567', 'ip')).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(make().svc.start('0501234567', 'ip')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a send cap is reported; other delivery failures look like success', async () => {
    const t = make();
    t.otp.send.mockRejectedValueOnce(new HttpException('otp_send_rate_limited', 429));
    await expect(t.svc.start('+971501234567', 'ip')).rejects.toMatchObject({status: 429});
    t.otp.send.mockRejectedValueOnce(new Error('twilio down'));
    await expect(t.svc.start('+971501234567', 'ip')).resolves.toHaveProperty('resetId');
  });
});

describe('complete', () => {
  it('right code → new password saved, phone marked verified, every device signed out', async () => {
    const t = make();
    const {resetId} = await t.svc.start('+971501234567', 'ip');
    await expect(t.svc.complete(resetId, {code: '123456', newPassword: 'a long new password'}, 'ip')).resolves.toEqual({done: true});
    expect(t.otp.check).toHaveBeenCalledWith('+971501234567', '123456');
    expect(t.updates.at(-1)).toEqual(['u-1', 'hash:a long new password', 'sms']);
    expect(t.auth.revokeAllUserSessions).toHaveBeenCalledWith('u-1', 'ip');
    // Spent: it cannot be used twice.
    await expect(t.svc.complete(resetId, {code: '123456', newPassword: 'another password!'}, 'ip')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('wrong code → 400, and the reset locks after six tries', async () => {
    const t = make({codeOk: false});
    const {resetId} = await t.svc.start('+971501234567', 'ip');
    for (let i = 0; i < 6; i++) {
      await expect(t.svc.complete(resetId, {code: '000000', newPassword: 'a long new password'}, 'ip')).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(t.svc.complete(resetId, {code: '000000', newPassword: 'a long new password'}, 'ip')).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.updates).toHaveLength(0);
  });

  it('an account with an authenticator must also give its code', async () => {
    const t = make({totp: 'verified'});
    const {resetId} = await t.svc.start('+971501234567', 'ip');
    await expect(t.svc.complete(resetId, {code: '123456', newPassword: 'a long new password'}, 'ip')).resolves.toEqual({done: false, needTotp: true});
    expect(t.updates).toHaveLength(0);
    await expect(t.svc.complete(resetId, {code: '123456', newPassword: 'a long new password', totpCode: '654 321'}, 'ip')).resolves.toEqual({done: true});
    expect(t.totp.check).toHaveBeenCalledWith('u-1', '654321', null, 'ip');
    expect(t.otp.check).toHaveBeenCalledTimes(1);   // the text code is remembered, not re-checked
  });

  it('a wrong authenticator code changes nothing', async () => {
    const t = make({totp: 'verified', totpOk: false});
    const {resetId} = await t.svc.start('+971501234567', 'ip');
    await expect(t.svc.complete(resetId, {code: '123456', newPassword: 'a long new password', totpCode: '111111'}, 'ip')).rejects.toBeInstanceOf(BadRequestException);
    expect(t.updates).toHaveLength(0);
  });

  it('HQ staff without an authenticator are sent to an administrator', async () => {
    const t = make({staff: true});
    const {resetId} = await t.svc.start('+971501234567', 'ip');
    await expect(t.svc.complete(resetId, {code: '123456', newPassword: 'a long new password'}, 'ip')).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.updates).toHaveLength(0);
  });

  it('the new password must differ from the current one', async () => {
    const t = make({samePassword: true});
    const {resetId} = await t.svc.start('nadia@example.com', 'ip');
    await expect(t.svc.complete(resetId, {code: '123456', newPassword: 'the same password'}, 'ip')).rejects.toBeInstanceOf(BadRequestException);
    expect(t.updates).toHaveLength(0);
  });
});
