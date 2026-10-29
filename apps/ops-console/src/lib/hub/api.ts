/**
 * Bravo Secure home site — API client (bravosecure.cloud, 2026-10-10).
 *
 * Own session: `bravo_hub_token` / `bravo_hub_csrf` / `bravo_hub_refresh`,
 * chosen by the auth-service from the request Origin. That session only opens
 * the launcher; every app gets its own session through the single sign-on
 * hand-off (POST /hub/launch here → the app's /sso page).
 */
import {deviceId, ApiError, type LoginStartResult} from '@/lib/api';
import {hubRoutes} from './routes';

export {ApiError};

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

export const HUB_CSRF_COOKIE = 'bravo_hub_csrf';
export const HUB_EXPIRES_KEY = 'bravo_hub_access_expires_at';
export const HUB_IDLE_KEY = 'bravo_hub_idle_logout';
export const HUB_WELCOME_KEY = 'bravo_hub_registered';

export function readHubCsrf(): string | null {
  if (typeof document === 'undefined') return null;
  const m = /(?:^|;\s*)bravo_hub_csrf=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]) : null;
}

export function expireHubCsrf(): void {
  if (typeof document === 'undefined') return;
  const past = 'Thu, 01 Jan 1970 00:00:00 GMT';
  const host = window.location.hostname;
  const parts = host.split('.');
  const domains: Array<string | null> = [null, host];
  for (let i = 1; i < parts.length - 1; i++) {
    const suffix = parts.slice(i).join('.');
    domains.push(suffix, '.' + suffix);
  }
  for (const d of domains) {
    document.cookie = `${HUB_CSRF_COOKIE}=; expires=${past}; max-age=0; path=/` + (d ? `; domain=${d}` : '');
  }
}

function bootToLogin(): void {
  if (typeof window === 'undefined') return;
  expireHubCsrf();
  window.sessionStorage.removeItem(HUB_EXPIRES_KEY);
  const p = window.location.pathname;
  if (p !== hubRoutes.login && p !== hubRoutes.register) window.location.assign(hubRoutes.login);
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

type Init = RequestInit & {noBoot?: boolean};

async function hub<T>(path: string, init?: Init): Promise<T> {
  const {noBoot, ...rest} = init ?? {};
  const csrf = readHubCsrf();
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    credentials: 'include',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(csrf ? {'X-CSRF-Token': csrf} : {}),
      ...(rest.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? safeParse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && !noBoot) bootToLogin();
    const b = body as {message?: string | string[]; error?: string} | null;
    const msg = Array.isArray(b?.message) ? b?.message[0] : b?.message;
    throw new ApiError(res.status, body, msg ?? b?.error ?? res.statusText);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown, init?: Init) =>
  hub<T>(path, {method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), ...init});

/* ── Types ───────────────────────────────────────────────────────────── */

export type TileState = 'open' | 'inactive' | 'not_allowed' | 'needs_totp' | 'upgrade';
export interface AppTile {key: string; name: string; tagline: string; icon: string; state: TileState}
export interface HubApps {
  user: {id: string; display_name: string | null; email_verified: boolean; phone_verified: boolean};
  apps: AppTile[];
  audiences: string[];
  totp: 'none' | 'pending' | 'verified';
}
export interface TotpSetup {uri: string; secret: string; backupCodes: string[]}

/* ── Endpoints ───────────────────────────────────────────────────────── */

export const hubAuth = {
  loginStart: (phoneE164: string, password: string) =>
    post<LoginStartResult>('/auth/login', {phoneE164, password}),
  loginVerify: (userId: string, code: string, challengeId?: string | null) =>
    post<{expiresIn: number}>('/auth/verify',
      {userId, code, deviceId: deviceId(), platform: 'web', ...(challengeId ? {challengeId} : {})}),
  sessionRefresh: () => post<{expiresIn: number}>('/auth/session/refresh'),
  async signOut(): Promise<void> {
    try {
      await hub('/auth/session', {method: 'DELETE', body: JSON.stringify({deviceId: deviceId(), allDevices: false}), noBoot: true});
    } catch { /* best effort: the cookies below go regardless */ }
    expireHubCsrf();
    try { window.sessionStorage.removeItem(HUB_EXPIRES_KEY); } catch { /* ignore */ }
  },
};

export const hubSignup = {
  status: () => hub<{available: boolean}>('/auth/signup/status', {noBoot: true}),
  start: (b: {displayName: string; email: string; phoneE164: string; password: string; acceptTerms: true}) =>
    post<{signupId: string; phone: string; email: string; devPhoneCode?: string}>('/auth/signup/start', b, {noBoot: true}),
  resend: (signupId: string, channel: 'phone' | 'email') =>
    post<{ok: true; devPhoneCode?: string}>('/auth/signup/resend', {signupId, channel}, {noBoot: true}),
  complete: (signupId: string, codes: {phoneCode?: string; emailCode?: string}) =>
    post<{done: false; phoneOk: boolean; emailOk: boolean} | {done: true; signedIn: boolean; expiresIn?: number}>(
      '/auth/signup/complete', {signupId, ...codes, deviceId: deviceId()}, {noBoot: true}),
};

// "Forgot your password?" (2026-10-11). The same answer whether or not an account matches.
export const hubPasswordReset = {
  // `sms` / `email` (2026-10-30): which ways a code can be sent; absent on an older server.
  status: () => hub<{available: boolean; sms?: boolean; email?: boolean}>('/auth/password/reset/status', {noBoot: true}),
  start: (identifier: string) => post<{resetId: string}>('/auth/password/reset/start', {identifier}, {noBoot: true}),
  complete: (resetId: string, b: {code: string; newPassword: string; totpCode?: string}) =>
    post<{done: true} | {done: false; needTotp: true}>('/auth/password/reset/complete', {resetId, ...b}, {noBoot: true}),
};

export const hubApi = {
  apps: () => hub<HubApps>('/hub/apps'),
  launch: (app: string) => post<{redirect: string}>('/hub/launch', {app}),
  totpStart: () => post<TotpSetup>('/hub/security/totp/start'),
  totpConfirm: (code: string) => post<{ok: true}>('/hub/security/totp/confirm', {code}),
  // 2026-10-11 — signs out every device (the server clears this session's cookies too).
  changePassword: (currentPassword: string, newPassword: string) =>
    post<{ok: true}>('/auth/me/password', {currentPassword, newPassword}),
};
