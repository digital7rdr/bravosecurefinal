import {
  OPS_SESSION_COOKIES, PROVIDER_SESSION_COOKIES, WEB_SESSION_COOKIES, providerConsoleOrigins, sessionCookiesFor,
  webAppOrigins,
} from './session-cookies';

const env = {PROVIDER_CONSOLE_ORIGINS: 'https://provider.bravosecure.cloud, http://localhost:3005/'} as NodeJS.ProcessEnv;
const req = (origin?: unknown) => ({headers: origin === undefined ? {} : {origin}});

describe('session cookie names per console', () => {
  it('uses the provider names only for a listed provider origin', () => {
    expect(sessionCookiesFor(req('https://provider.bravosecure.cloud'), env)).toBe(PROVIDER_SESSION_COOKIES);
    expect(sessionCookiesFor(req('http://localhost:3005'), env)).toBe(PROVIDER_SESSION_COOKIES);
  });

  it('matches case-insensitively and ignores a trailing slash', () => {
    expect(sessionCookiesFor(req('HTTPS://Provider.BravoSecure.cloud/'), env)).toBe(PROVIDER_SESSION_COOKIES);
  });

  it('keeps the ops names for the ops console, unknown origins and no origin', () => {
    expect(sessionCookiesFor(req('https://ops.bravosecure.cloud'), env)).toBe(OPS_SESSION_COOKIES);
    expect(sessionCookiesFor(req('https://provider.bravosecure.cloud.evil.com'), env)).toBe(OPS_SESSION_COOKIES);
    expect(sessionCookiesFor(req(), env)).toBe(OPS_SESSION_COOKIES);
    expect(sessionCookiesFor(req(42), env)).toBe(OPS_SESSION_COOKIES);
  });

  it('behaves exactly as before when PROVIDER_CONSOLE_ORIGINS is unset', () => {
    expect(providerConsoleOrigins({} as NodeJS.ProcessEnv).size).toBe(0);
    expect(sessionCookiesFor(req('https://provider.bravosecure.cloud'), {} as NodeJS.ProcessEnv)).toBe(OPS_SESSION_COOKIES);
  });

  it('the two sets never share a name', () => {
    const ops = [OPS_SESSION_COOKIES.token, OPS_SESSION_COOKIES.csrf, OPS_SESSION_COOKIES.refresh];
    for (const n of [PROVIDER_SESSION_COOKIES.token, PROVIDER_SESSION_COOKIES.csrf, PROVIDER_SESSION_COOKIES.refresh]) {
      expect(ops).not.toContain(n);
    }
    expect(OPS_SESSION_COOKIES).toEqual({console: 'ops', token: 'bravo_ops_token', csrf: 'bravo_ops_csrf', refresh: 'bravo_ops_refresh'});
  });

  it('uses the web app names only for a listed web origin', () => {
    const both = {...env, WEB_APP_ORIGINS: 'https://web.bravosecure.cloud'} as NodeJS.ProcessEnv;
    expect(sessionCookiesFor(req('https://web.bravosecure.cloud/'), both)).toBe(WEB_SESSION_COOKIES);
    expect(sessionCookiesFor(req('https://provider.bravosecure.cloud'), both)).toBe(PROVIDER_SESSION_COOKIES);
    expect(sessionCookiesFor(req('https://web.bravosecure.cloud'), env)).toBe(OPS_SESSION_COOKIES);
    expect(webAppOrigins({} as NodeJS.ProcessEnv).size).toBe(0);
    expect(WEB_SESSION_COOKIES).toEqual({console: 'web', token: 'bravo_web_token', csrf: 'bravo_web_csrf', refresh: 'bravo_web_refresh'});
  });
});
