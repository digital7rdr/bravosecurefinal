/** Helpers of the single sign-on landing page (components/SsoLanding.tsx). No imports, so tests can load them. */

/** Only a same-site path: "/x" yes; "//evil.com", "/\\evil", "https://…" no. */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  return raw;
}

/** ops.bravosecure.cloud → https://bravosecure.cloud (the home site). */
export function homeSiteUrl(loc: {protocol: string; host: string}): string {
  const [host, port] = loc.host.split(':');
  // Local testing: web.localhost / provider.localhost → hub.localhost.
  if (host === 'localhost' || host.endsWith('.localhost')) return `${loc.protocol}//hub.localhost${port ? `:${port}` : ''}/`;
  const parts = host.split('.');
  const home = parts.length > 2 ? parts.slice(1).join('.') : host;
  return `${loc.protocol}//${home}${port ? `:${port}` : ''}/`;
}

/**
 * 2026-10-30 — a hand-off redirect from POST /hub/handoff is followed only
 * when it is the home site's own /sso page (same origin as `home`).
 */
export function isHomeSiteRedirect(redirect: unknown, home: string): redirect is string {
  if (typeof redirect !== 'string') return false;
  try {
    const r = new URL(redirect);
    const h = new URL(home);
    return r.origin === h.origin && r.pathname === '/sso';
  } catch { return false; }
}
