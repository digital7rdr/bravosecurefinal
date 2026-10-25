/**
 * 2026-10-25 — owner: the inactivity sign-out kept logging people out of the
 * web screens, so it is OFF by default on every web surface (ops console,
 * provider console, hub, web messenger).
 *
 * To switch it back on without a code change, set
 * NEXT_PUBLIC_IDLE_SIGN_OUT_MINUTES (e.g. 15) at build time. Sessions still
 * end on an explicit sign-out, a revoked session, or an expired refresh token.
 */
export function idleSignOutMs(raw: string | undefined = process.env.NEXT_PUBLIC_IDLE_SIGN_OUT_MINUTES): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return 0;
  return Math.round(Math.min(n, 24 * 60) * 60_000);
}

/** 0 = the idle sign-out is off. */
export const IDLE_SIGN_OUT_MS = idleSignOutMs();
