/**
 * Browser session cookie names, one set per web console.
 *
 * Two consoles share the API host and the parent cookie domain
 * (COOKIE_DOMAIN=.bravosecure.cloud): the HQ ops console and the service
 * provider console. With one set of names, signing in to one console in a
 * browser would silently replace the other console's session, and a provider
 * page would ride on an HQ operator's cookie (or the reverse). Each console
 * therefore gets its own cookies, and the request's Origin header picks which
 * set a request reads and writes.
 *
 * Both consoles call the API cross-origin with `credentials: 'include'`, so
 * the browser sends Origin on every request, GETs included. A request with
 * no Origin, or with any origin not listed in PROVIDER_CONSOLE_ORIGINS, uses
 * the ops names: exactly the behaviour before the provider console existed.
 *
 * The Origin header only CHOOSES which cookie to read. It grants nothing: the
 * token inside the cookie is verified as before, and every provider route is
 * still behind OrgManagerGuard. A forged Origin from a non-browser client
 * would only make the server read a cookie that client could send anyway.
 */
export interface SessionCookieNames {
  console: 'ops' | 'provider';
  token: string;
  csrf: string;
  refresh: string;
}

export const OPS_SESSION_COOKIES: SessionCookieNames = Object.freeze({
  console: 'ops',
  token:   'bravo_ops_token',
  csrf:    'bravo_ops_csrf',
  refresh: 'bravo_ops_refresh',
});

export const PROVIDER_SESSION_COOKIES: SessionCookieNames = Object.freeze({
  console: 'provider',
  token:   'bravo_pv_token',
  csrf:    'bravo_pv_csrf',
  refresh: 'bravo_pv_refresh',
});

/** Exact origins of the provider console, e.g. "https://provider.bravosecure.cloud". */
export function providerConsoleOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.PROVIDER_CONSOLE_ORIGINS ?? '')
      .split(',')
      .map(s => s.trim().replace(/\/+$/, '').toLowerCase())
      .filter(Boolean),
  );
}

function originOf(req: {headers?: Record<string, unknown>} | undefined): string | null {
  const raw = req?.headers?.['origin'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' && v ? v.trim().replace(/\/+$/, '').toLowerCase() : null;
}

export function sessionCookiesFor(
  req: {headers?: Record<string, unknown>} | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SessionCookieNames {
  const origin = originOf(req);
  if (origin && providerConsoleOrigins(env).has(origin)) return PROVIDER_SESSION_COOKIES;
  return OPS_SESSION_COOKIES;
}
