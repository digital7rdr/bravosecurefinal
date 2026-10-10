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
