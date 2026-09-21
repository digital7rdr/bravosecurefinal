/**
 * Routes reachable without a session. One list, two consumers: the edge
 * middleware (skips the cookie gate) and `useOpsMe` (passes a null SWR key so
 * a pre-auth page never fires an authenticated GET /ops/me that 401s — OP-18).
 *
 * /accept-invite is the RS-09 admin-invite redemption page: the invitee has
 * no session yet by definition, so it must be reachable pre-auth.
 */
// /r is the referral-link landing (2026-09-05): a shared code opens it on a
// phone that has no ops session and, usually, no app yet.
export const PUBLIC_PATHS = ['/login', '/accept-invite', '/r'] as const;

/**
 * Brand/icon files in `public/` that must be servable WITHOUT a session.
 *
 * Why: the middleware matcher only ever exempted `/_next/*` and the exact
 * path `/favicon.ico`, so every other file in `public/` — the Bravo logo and
 * the whole favicon set — was caught by the auth gate and 307'd to /login.
 * That is why the console rendered with the default framework favicon and no
 * brand mark: the assets shipped, but were never reachable. The login page
 * itself is pre-auth, so its logo MUST be too.
 *
 * Deliberately an exact-match allowlist, not an extension rule: `public/` is
 * served verbatim, and a blanket "anything with a file extension is public"
 * would silently expose whatever is dropped there later.
 */
export const PUBLIC_ASSETS: readonly string[] = [
  '/favicon.ico',
  '/favicon.png',
  '/favicon-16.png',
  '/favicon-32.png',
  '/favicon-48.png',
  '/favicon-192.png',
  '/favicon-512.png',
  '/apple-touch-icon.png',
  '/bravo-logo.svg',
  '/bravo-logo-light.svg',
  '/bravo-mark.svg',
  '/bravo-mark-light.svg',
] as const;

export function isPublicAsset(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return PUBLIC_ASSETS.includes(pathname);
}

export function isPublicPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'));
}
