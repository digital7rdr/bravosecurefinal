/**
 * One Next.js app serves two consoles, told apart by the host name:
 *
 *   ops.bravosecure.cloud       → the HQ ops console (every existing route)
 *   provider.bravosecure.cloud  → the service provider console
 *
 * On a provider host the middleware rewrites a clean path ("/jobs") to the
 * internal route group ("/provider/jobs"). The internal "/provider/*" paths
 * are never served directly on either host, so neither console's pages can be
 * opened on the other's address.
 */
export const PROVIDER_PREFIX = '/provider';

/** Paths on the provider host that need no session. */
export const PROVIDER_PUBLIC_PATHS = ['/login'] as const;

export function isProviderHost(host: string | null | undefined): boolean {
  const h = (host ?? '').split(':')[0].trim().toLowerCase();
  return h.startsWith('provider.');
}

export function isInternalProviderPath(pathname: string): boolean {
  return pathname === PROVIDER_PREFIX || pathname.startsWith(`${PROVIDER_PREFIX}/`);
}

/** "/" → "/provider", "/jobs/x" → "/provider/jobs/x". */
export function toInternalProviderPath(pathname: string): string {
  return pathname === '/' ? PROVIDER_PREFIX : `${PROVIDER_PREFIX}${pathname}`;
}
