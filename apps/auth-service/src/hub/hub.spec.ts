jest.mock('../auth/account-kind', () => ({
  resolveAccountKind: jest.fn(),
  resolveIsOrgManager: jest.fn(),
}));

import {BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException} from '@nestjs/common';
import {createHash} from 'node:crypto';
import {resolveAccountKind, resolveIsOrgManager} from '../auth/account-kind';
import {HubService, isAllowedAppUrl, splitAppUrl, type PlatformAppRow} from './hub.service';
import {SignupService} from './signup.service';
import {HubController, SsoController, SignupController} from './hub.controller';
import {
  HUB_SESSION_COOKIES, OPS_SESSION_COOKIES, WEB_SESSION_COOKIES, sessionCookiesFor,
} from '../common/http/session-cookies';

/**
 * Bravo Secure home site (2026-10-10): who may open which app, the one-time
 * single sign-on code, registration with phone + email codes, and the
 * Super Admin app editor's validation.
 */

const kind = resolveAccountKind as jest.Mock;
const manager = resolveIsOrgManager as jest.Mock;

const app = (o: Partial<PlatformAppRow>): PlatformAppRow => ({
  key: 'x', name: 'X', tagline: '', icon: 'chat', sort: 0, active: true, url: 'https://web.bravosecure.cloud/',
  agency_url: null, allowed_audiences: ['client'], requires_totp: false, updated_at: '', updated_by: null, ...o,
});

const APPS: PlatformAppRow[] = [
  app({key: 'secure_services', icon: 'shield', url: 'https://web.bravosecure.cloud/book', agency_url: 'https://provider.bravosecure.cloud', allowed_audiences: ['client', 'agency']}),
  app({key: 'messenger', allowed_audiences: ['client', 'officer', 'agency', 'ops']}),
  app({key: 'control', icon: 'chart', url: 'https://ops.bravosecure.cloud/', allowed_audiences: ['ops'], requires_totp: true}),
  app({key: 'georisk', icon: 'globe', active: false, url: null, allowed_audiences: ['client']}),
];

function makeHub(opts: {staff?: boolean; totp?: 'none' | 'pending' | 'verified'; apps?: PlatformAppRow[]} = {}) {
  const store = new Map<string, string>();
  const db = {
    q: jest.fn(async () => opts.apps ?? APPS),
    qOne: jest.fn(async (sql: string) => {
      if (/FROM admin_users/.test(sql)) return {n: opts.staff ? 1 : 0};
      if (/FROM public\.users/.test(sql)) return {id: 'u-1', email: 'a@b.c', display_name: 'A', role: 'individual', subscription_tier: 'lite', phone_e164: '+971500000000'};
      return null;
    }),
  };
  const redis = {
    set: jest.fn(async (k: string, v: string, _ttl?: number) => { store.set(k, v); }),
    takeOnce: jest.fn(async (k: string) => { const v = store.get(k) ?? null; store.delete(k); return v; }),
  };
  const totp = {status: jest.fn(async () => opts.totp ?? 'none')};
  return {hub: new HubService(db as never, redis as never, totp as never), db, redis, store};
}

const codeOf = (redirect: string) => decodeURIComponent(/#code=([^&]+)/.exec(redirect)![1]);

beforeEach(() => {
  kind.mockReset(); manager.mockReset();
  kind.mockResolvedValue({account_kind: 'individual'});
  manager.mockResolvedValue(false);
});

describe('who may open what', () => {
  it('derives the kinds of account on the server', async () => {
    const {hub} = makeHub({staff: true});
    expect([...(await hub.audiences('u-1'))].sort()).toEqual(['client', 'ops']);
    kind.mockResolvedValue({account_kind: 'cpo'});
    expect([...(await makeHub().hub.audiences('u-1'))]).toEqual(['officer']);
    kind.mockResolvedValue({account_kind: 'individual'}); manager.mockResolvedValue(true);
    expect([...(await makeHub().hub.audiences('u-1'))]).toEqual(['agency']);
  });

  it('tiles: inactive apps fade, others are open or explain why not', async () => {
    const {apps} = await makeHub().hub.tiles('u-1');
    expect(Object.fromEntries(apps.map(a => [a.key, a.state]))).toEqual({
      secure_services: 'open', messenger: 'open', control: 'not_allowed', georisk: 'inactive',
    });
    const staff = await makeHub({staff: true}).hub.tiles('u-1');
    expect(staff.apps.find(a => a.key === 'control')!.state).toBe('needs_totp');
    const staffTotp = await makeHub({staff: true, totp: 'verified'}).hub.tiles('u-1');
    expect(staffTotp.apps.find(a => a.key === 'control')!.state).toBe('open');
  });

  it('launch refuses anything that is not open', async () => {
    await expect(makeHub().hub.launch('u-1', 'georisk')).rejects.toThrow('app_inactive');
    await expect(makeHub().hub.launch('u-1', 'control')).rejects.toThrow('app_not_allowed');
    await expect(makeHub({staff: true}).hub.launch('u-1', 'control')).rejects.toThrow('app_needs_totp');
    await expect(makeHub().hub.launch('u-1', 'nope')).rejects.toThrow('app_not_found');
  });

  it('Secure Services sends clients to booking and agencies to the provider console', async () => {
    const client = await makeHub().hub.launch('u-1', 'secure_services');
    expect(client.redirect).toMatch(/^https:\/\/web\.bravosecure\.cloud\/sso#code=[A-Za-z0-9_-]{43}&next=%2Fbook$/);
    manager.mockResolvedValue(true);
    const agency = await makeHub().hub.launch('u-1', 'secure_services');
    expect(agency.redirect).toMatch(/^https:\/\/provider\.bravosecure\.cloud\/sso#code=.+&next=%2F$/);
  });
});

describe('single sign-on code', () => {
  it('stores only a hash of the code, for 60 seconds', async () => {
    const {hub, redis} = makeHub();
    const {redirect} = await hub.launch('u-1', 'messenger');
    const code = codeOf(redirect);
    const key = redis.set.mock.calls[0][0] as string;
    expect(key).toBe(`sso-code:${createHash('sha256').update(code).digest('hex')}`);
    expect(key).not.toContain(code);
    expect(redis.set.mock.calls[0][2]).toBe(60);
  });

  it('works once, only from the origin it was minted for', async () => {
    const {hub} = makeHub();
    const code = codeOf((await hub.launch('u-1', 'messenger')).redirect);
    await expect(hub.exchange(code, 'https://ops.bravosecure.cloud')).rejects.toBeInstanceOf(ForbiddenException);
    // A wrong-origin attempt consumed it too: a stolen code is worth one try.
    await expect(hub.exchange(code, 'https://web.bravosecure.cloud')).rejects.toThrow('sso_code_invalid');

    const code2 = codeOf((await hub.launch('u-1', 'messenger')).redirect);
    await expect(hub.exchange(code2, 'https://WEB.bravosecure.cloud/')).resolves.toMatchObject({app: 'messenger', user: {id: 'u-1'}});
    await expect(hub.exchange(code2, 'https://web.bravosecure.cloud')).rejects.toThrow('sso_code_invalid');
    await expect(hub.exchange('x'.repeat(43), null)).rejects.toThrow('sso_origin_required');
  });

  it('re-checks access at exchange: an app switched off in between does not open', async () => {
    const apps = APPS.map(a => ({...a}));
    const {hub} = makeHub({apps});
    const code = codeOf((await hub.launch('u-1', 'messenger')).redirect);
    apps.find(a => a.key === 'messenger')!.active = false;
    await expect(hub.exchange(code, 'https://web.bravosecure.cloud')).rejects.toThrow('sso_code_invalid');
  });
});

describe('Super Admin app editor', () => {
  it('only https addresses (http only for localhost outside production)', () => {
    expect(isAllowedAppUrl('https://ops.bravosecure.cloud/', true)).toBe(true);
    expect(isAllowedAppUrl('http://ops.bravosecure.cloud/', true)).toBe(false);
    expect(isAllowedAppUrl('http://web.localhost:3033/', false)).toBe(true);
    expect(isAllowedAppUrl('http://web.localhost:3033/', true)).toBe(false);
    expect(isAllowedAppUrl('javascript:alert(1)', false)).toBe(false);
    expect(isAllowedAppUrl('https://user:pw@evil.com/', false)).toBe(false);
    expect(splitAppUrl('https://web.bravosecure.cloud/book?x=1')).toEqual({origin: 'https://web.bravosecure.cloud', path: '/book?x=1'});
  });

  it('refuses bad input and an active app without an address', async () => {
    const {hub} = makeHub();
    await expect(hub.updateApp('georisk', {url: 'http://evil.com'}, 'a')).rejects.toThrow('url_invalid');
    await expect(hub.updateApp('georisk', {allowed_audiences: ['everyone']}, 'a')).rejects.toThrow('audience_invalid');
    await expect(hub.updateApp('georisk', {icon: 'skull'}, 'a')).rejects.toThrow('icon_invalid');
    await expect(hub.updateApp('georisk', {active: true}, 'a')).rejects.toThrow('url_required_to_activate');
    await expect(hub.updateApp('nope', {active: true}, 'a')).rejects.toThrow('app_not_found');
  });
});

describe('registration (phone + email codes)', () => {
  function makeSignup(opts: {sms?: boolean; email?: boolean; existing?: boolean; invite?: string | null; stub?: boolean} = {}) {
    const store = new Map<string, string>();
    const redis = {
      set: jest.fn(async (k: string, v: string, _ttl?: number) => { store.set(k, v); }),
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      takeOnce: jest.fn(async (k: string) => { const v = store.get(k) ?? null; store.delete(k); return v; }),
    };
    const db = {
      q: jest.fn(),
      qOne: jest.fn(async (sql: string, _args?: unknown[]) => {
        if (/^SELECT id FROM public\.users WHERE \(email/.test(sql)) return opts.existing ? {id: 'old'} : null;
        if (/INSERT INTO public\.users/.test(sql)) return {id: 'new-user'};
        if (/SELECT id,email/.test(sql)) return {id: 'new-user', email: 'n@x.com'};
        return null;
      }),
    };
    const otp = {
      smsReady: jest.fn(() => opts.sms ?? true), emailReady: jest.fn(() => opts.email ?? true),
      send: jest.fn(), sendEmail: jest.fn(), check: jest.fn(), issueStub: jest.fn(async () => '424242'),
    };
    const auth = {claimableInvite: jest.fn(async () => opts.invite ?? null)};
    const svc = new SignupService(db as never, redis as never, {emit: jest.fn()} as never,
      {hash: jest.fn(async () => '$argon2id$h')} as never, otp as never, auth as never,
      {get: (k: string) => (k === 'auth.registerPhoneProof' && opts.stub ? 'stub' : undefined)} as never);
    return {svc, db, otp, store};
  }
  const DTO = {displayName: 'Nadia', email: 'Nadia@Example.com', phoneE164: '+971501234567', password: 'long enough pw'};

  it('closed until both SMS and email can be sent', async () => {
    await expect(makeSignup({email: false}).svc.start(DTO, 'ip')).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(makeSignup({sms: false}).svc.start(DTO, 'ip')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('an existing account is refused (an invite for this phone is claimed instead)', async () => {
    await expect(makeSignup({existing: true}).svc.start(DTO, 'ip')).rejects.toBeInstanceOf(ConflictException);
    await expect(makeSignup({existing: true, invite: 'inv'}).svc.start(DTO, 'ip')).resolves.toHaveProperty('signupId');
  });

  it('start texts and emails a code and writes nothing to the database', async () => {
    const {svc, otp, db, store} = makeSignup();
    const out = await svc.start(DTO, 'ip');
    expect(otp.send).toHaveBeenCalledWith('+971501234567', '');
    expect(otp.sendEmail).toHaveBeenCalledWith('nadia@example.com');
    expect(out).toMatchObject({phone: '+971•••67', email: 'na•••@example.com'});
    expect(db.qOne.mock.calls.some(([sql]) => /INSERT/.test(sql))).toBe(false);
    const pending = JSON.parse([...store.values()][0]);
    expect(pending.pwHash).toBe('$argon2id$h');
    expect(JSON.stringify(pending)).not.toContain(DTO.password);
  });

  it('a wrong phone code does not burn a right email code; both right → account with both verified', async () => {
    const {svc, otp, db} = makeSignup();
    const {signupId} = await svc.start(DTO, 'ip');
    otp.check.mockImplementation(async (to: string, code: string) => (to.includes('@') ? code === '222222' : code === '111111'));
    await expect(svc.complete(signupId, {phoneCode: '999999', emailCode: '222222'}, 'ip'))
      .resolves.toEqual({done: false, phoneOk: false, emailOk: true});
    const done = await svc.complete(signupId, {phoneCode: '111111'}, 'ip');
    expect(done).toMatchObject({done: true, user: {id: 'new-user'}});
    const insert = db.qOne.mock.calls.find(([sql]) => /INSERT INTO public\.users/.test(sql))!;
    expect(insert[0]).toMatch(/email_verified_at, phone_verified_at/);
    expect(insert[1]).toEqual(['nadia@example.com', '+971501234567', 'Nadia', '$argon2id$h']);
    // Spent: the same sign-up cannot create a second account.
    await expect(svc.complete(signupId, {phoneCode: '111111', emailCode: '222222'}, 'ip')).rejects.toThrow('signup_expired');
  });

  it('locks after too many wrong tries', async () => {
    const {svc, otp} = makeSignup();
    const {signupId} = await svc.start(DTO, 'ip');
    otp.check.mockResolvedValue(false);
    for (let i = 0; i < 6; i++) await svc.complete(signupId, {phoneCode: '000000', emailCode: '000000'}, 'ip');
    await expect(svc.complete(signupId, {phoneCode: '000000'}, 'ip')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.complete(signupId, {phoneCode: '000000'}, 'ip')).rejects.toThrow('signup_expired');
  });

  it('REGISTER_PHONE_PROOF=stub (testing): opens without Twilio, returns the phone code instead of texting it', async () => {
    const {svc, otp} = makeSignup({sms: false, stub: true});
    expect(svc.available()).toBe(true);
    const out = await svc.start(DTO, 'ip');
    expect(out.devPhoneCode).toBe('424242');
    expect(otp.send).not.toHaveBeenCalled();
    expect(otp.sendEmail).toHaveBeenCalled();
    expect(makeSignup({sms: false, stub: true, email: false}).svc.available()).toBe(false);
  });

  it('rejects a malformed sign-up id before touching Redis', async () => {
    await expect(makeSignup().svc.complete('../../etc', {}, 'ip')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('home-site sessions and the hand-off endpoints', () => {
  const env = {WEB_APP_ORIGINS: 'https://web.bravosecure.cloud', HUB_ORIGINS: 'https://bravosecure.cloud,https://www.bravosecure.cloud'} as NodeJS.ProcessEnv;
  it('the home site has its own cookies', () => {
    expect(sessionCookiesFor({headers: {origin: 'https://bravosecure.cloud'}}, env)).toBe(HUB_SESSION_COOKIES);
    expect(sessionCookiesFor({headers: {origin: 'https://www.bravosecure.cloud/'}}, env)).toBe(HUB_SESSION_COOKIES);
    expect(sessionCookiesFor({headers: {origin: 'https://web.bravosecure.cloud'}}, env)).toBe(WEB_SESSION_COOKIES);
    expect(sessionCookiesFor({headers: {}}, env)).toBe(OPS_SESSION_COOKIES);
    expect(HUB_SESSION_COOKIES).toEqual({console: 'hub', token: 'bravo_hub_token', csrf: 'bravo_hub_csrf', refresh: 'bravo_hub_refresh'});
  });

  const prev = {...process.env};
  beforeAll(() => { process.env.HUB_ORIGINS = 'https://bravosecure.cloud'; process.env.WEB_APP_ORIGINS = 'https://web.bravosecure.cloud'; });
  afterAll(() => { process.env.HUB_ORIGINS = prev.HUB_ORIGINS; process.env.WEB_APP_ORIGINS = prev.WEB_APP_ORIGINS; });

  it('launch works only from the home site cookie session', async () => {
    const hub = {launch: jest.fn(async () => ({redirect: 'r'}))};
    const ctl = new HubController(hub as never, {} as never, {} as never, {emit: jest.fn()} as never);
    const user = {sub: 'u-1', deviceId: 'd'} as never;
    await expect(ctl.launch(user, {app: 'messenger'}, {headers: {origin: 'https://web.bravosecure.cloud'}, cookies: {bravo_web_token: 't'}} as never))
      .rejects.toThrow('launch_requires_home_session');
    await expect(ctl.launch(user, {app: 'messenger'}, {headers: {origin: 'https://bravosecure.cloud', authorization: 'Bearer x'}} as never))
      .rejects.toThrow('launch_requires_home_session');
    await expect(ctl.launch(user, {app: 'messenger'}, {headers: {origin: 'https://bravosecure.cloud'}, cookies: {bravo_hub_token: 't'}} as never))
      .resolves.toEqual({redirect: 'r'});
  });

  it('exchange sets the TARGET app cookies and is refused on the home site itself', async () => {
    const hub = {exchange: jest.fn(async () => ({user: {id: 'u-1'}, app: 'messenger'}))};
    const auth = {issueSession: jest.fn(async () => ({accessToken: 'a', refreshToken: 'r', expiresIn: 900}))};
    const jwt = {ttlToSeconds: jest.fn(() => 2_592_000)};
    const ctl = new SsoController(hub as never, auth as never, jwt as never, {emit: jest.fn()} as never);
    const cookies: string[] = [];
    const res = {cookie: (n: string) => cookies.push(n), setHeader: jest.fn()} as never;
    await expect(ctl.exchange({code: 'c'.repeat(43), deviceId: 'd'}, {headers: {origin: 'https://bravosecure.cloud'}} as never, res))
      .rejects.toThrow('sso_origin_invalid');
    await ctl.exchange({code: 'c'.repeat(43), deviceId: 'd'}, {headers: {origin: 'https://web.bravosecure.cloud'}} as never, res);
    expect(cookies).toEqual(['bravo_web_token', 'bravo_web_csrf', 'bravo_web_refresh']);
    expect(auth.issueSession).toHaveBeenCalledWith({id: 'u-1'}, 'd', 'web', false);
  });

  it('sign-up only signs in on the home site', async () => {
    const signup = {complete: jest.fn(async () => ({done: true, user: {id: 'u'}}))};
    const auth = {issueSession: jest.fn(async () => ({accessToken: 'a', refreshToken: 'r', expiresIn: 900}))};
    const ctl = new SignupController(signup as never, auth as never, {ttlToSeconds: () => 1} as never);
    const res = {cookie: jest.fn(), setHeader: jest.fn()} as never;
    const body = {signupId: 's'.repeat(32), deviceId: 'd'};
    await expect(ctl.complete(body, {headers: {}} as never, res)).resolves.toEqual({done: true, signedIn: false});
    await expect(ctl.complete(body, {headers: {origin: 'https://bravosecure.cloud'}} as never, res))
      .resolves.toEqual({done: true, signedIn: true, expiresIn: 900});
  });
});
