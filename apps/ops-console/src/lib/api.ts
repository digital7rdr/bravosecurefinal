/**
 * Bravo Ops Console — typed API client.
 *
 * Calls the `/ops/*` REST surface on the NestJS auth-service. All calls
 * go through `fetchJson` which:
 *   • reads `NEXT_PUBLIC_API_BASE_URL` (required in prod — see audit 4.1)
 *   • carries the cookie session via `credentials: 'include'`
 *   • echoes `X-CSRF-Token` from the `bravo_ops_csrf` cookie
 *   • throws `ApiError` for non-2xx with status + parsed body
 */

import {useRef} from 'react';
import useSWR, {type SWRConfiguration} from 'swr';
import type {AdminRole} from './rbac';
import type {OpsUserLocation} from './userLocation';
import {routes} from '@/lib/routes';
import {usePathname} from 'next/navigation';
import {isPublicPath} from './publicRoutes';
import {pollMs} from './pollCadence';

// Audit fix 4.1 — fail loudly if API base URL is missing in prod. Defaulting
// to localhost in prod meant every fetch silently 404'd against the wrong
// host and the user saw a generic "session expired" loop. In dev we still
// fall back so devs can `npm run dev` without an .env. The throw runs at
// module-eval time so a missing env crashes the build, not at first user
// click — easier to catch in CI.
const ENV_BASE = process.env.NEXT_PUBLIC_API_BASE_URL;
if (!ENV_BASE && process.env.NODE_ENV === 'production') {
  throw new Error('NEXT_PUBLIC_API_BASE_URL is required in production builds');
}
const BASE = ENV_BASE ?? 'http://localhost:3001';

/** One runtime-editable third-party setting, as the backend reports it. */
export interface IntegrationSetting {
  key: string;
  category: string;
  label: string;
  help?: string;
  secret: boolean;
  placeholder?: string;
  /** Closed choice — rendered as a select; the server rejects other values. */
  options?: {value: string; label: string}[];
  configured: boolean;
  /** db = set in this console · env = deployment env fallback · unset = neither */
  source: 'db' | 'env' | 'unset';
  /** Masked for secrets (••••1234), plain for non-secrets, null when unset. */
  preview: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}
export interface IntegrationSettingsResponse {
  encryptionAvailable: boolean;
  encryptionReason: string | null;
  categories: {id: string; label: string}[];
  settings: IntegrationSetting[];
}

/** Module Access — what GET /ops/module-access returns. */
export interface ModuleAccessMatrix {
  groups: {id: string; label: string; description: string}[];
  modules: {key: string; label: string; description: string; groups: string[]; serverGate: string}[];
  alwaysOn: {key: string; label: string; reason: string}[];
  notYet: {key: string; label: string; reason: string}[];
  cells: {group: string; module: string; applicable: boolean; enabled: boolean | null; updatedAt: string | null}[];
}
export interface UserModuleView {
  group: string;
  modules: {
    key: string; label: string; applicable: boolean;
    groupEnabled: boolean | null; override: boolean | null; enabled: boolean | null;
  }[];
}
export interface InviteStatus {
  pending: boolean;
  invited_at: string | null;
  expires_at: string | null;
  expired: boolean;
  claimed: boolean;
}
export type AppAccountType = 'individual' | 'agency' | 'cpo';
export interface CreateAppUserBody {
  account_type: AppAccountType;
  display_name: string;
  email: string;
  phone_e164: string;
  agency_user_id?: string;
  coverage_country?: string;
  call_sign?: string;
}
export interface CreateAppUserResult {
  user_id: string;
  account_type: AppAccountType;
  invite: InviteStatus;
  sms_sent: boolean;
}

export class ApiError extends Error {
  constructor(public status: number, public body: unknown, message: string) {
    super(message);
  }
}

// Audit fix 0.4 — cookies replace localStorage for the ops session.
// `credentials: 'include'` makes the browser ship `bravo_ops_token` and
// `bravo_ops_csrf` on every same-site fetch. We pull `bravo_ops_csrf`
// out of `document.cookie` and echo it as `X-CSRF-Token` so the
// backend's CsrfGuard can pair them (double-submit pattern).
function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const m = /(?:^|;\s*)bravo_ops_csrf=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * B-71 — terminal boot to /login on a genuinely-dead session.
 *
 * A bare `location.assign('/login')` was NOT enough to break the loop: both
 * the login page and the Shell treat the presence of the JS-readable
 * `bravo_ops_csrf` cookie as "still logged in" and auto-forward back to `/`.
 * With the session revoked server-side, that produced an infinite
 * /login⇄/dashboard redirect storm (3,300+ requests). Clear every client-side
 * "logged-in" signal FIRST — the csrf cookie (via the same shotgun
 * clearSession uses), the access-expiry marker, and the in-memory messenger
 * ticket — so /login stays put. Mirrors clearSession() minus the server
 * DELETE (the token is already gone server-side, so there's nothing to revoke).
 */
function bootToLogin(): void {
  if (typeof window === 'undefined') return;
  expireCsrfCookie();
  window.sessionStorage.removeItem('bravo_ops_access_expires_at');
  clearMessengerTicket();
  if (!window.location.pathname.startsWith('/login')) {
    window.location.assign(routes.login);
  }
}

/**
 * Audit PAGE-14 — only a real session loss counts. 401 = missing/expired/
 * revoked cookie; a bare 403 is authorization (RBAC) or a CSRF mismatch and
 * belongs to a validly-logged-in operator. Extracted so `useOpsMe` can ask the
 * same question about a caught error that `fetchJson` asks about a response —
 * two copies of this predicate is how the boot rule drifts.
 */
function isSessionLost(status: number, bodyCode: string | undefined): boolean {
  return status === 401
    || (status === 403 && (bodyCode === 'session_expired' || bodyCode === 'token_revoked'));
}

function isSessionLostStatus(e: ApiError): boolean {
  return isSessionLost(e.status, (e.body as {code?: string} | null | undefined)?.code);
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const csrf = readCsrfToken();
  // Audit fix 4.3 — Idempotency-Key. Every state-changing opsApi call
  // passes an `idempotencyKey` field as a custom init prop; we lift it
  // into the header and strip from the spread so `fetch` doesn't reject.
  // (auditPiiReveal is deliberately unkeyed — each reveal is its own
  // audit event and must log every time.)
  // OP-17 — `init.signal` rides the spread below: callers that poll outside
  // SWR pass an AbortController's signal so unmount aborts the request
  // instead of downloading a response only to discard it.
  const {idempotencyKey, noBoot, ...restInit} =
    (init ?? {}) as RequestInit & {idempotencyKey?: string; noBoot?: boolean};
  const res = await fetch(`${BASE}${path}`, {
    ...restInit,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(csrf ? {'X-CSRF-Token': csrf} : {}),
      ...(idempotencyKey ? {'Idempotency-Key': idempotencyKey} : {}),
      ...(restInit?.headers ?? {}),
    },
    cache: 'no-store',
  });
  const text = await res.text();
  const body = text ? safeParse(text) : null;
  if (!res.ok) {
    // Audit PAGE-14 — only a real session loss should boot to /login.
    // 401 = missing/expired/revoked cookie. A bare 403 is authorization
    // (RBAC) or a CSRF mismatch and belongs to a validly-logged-in
    // operator — booting them to /login (and discarding SWR cache) is
    // wrong; the page surfaces those inline. We still honour a 403 that
    // explicitly tags itself as a session issue.
    const sessionLost = isSessionLost(res.status, (body as {code?: string})?.code);
    // E2E-43 — `noBoot` opts a caller out of the automatic redirect (NOT out of
    // the error). Only `GET /ops/me` uses it: see useOpsMe, which polls in the
    // background and so must not turn one token-rotation-race 401 into a
    // `window.location` navigation that discards an open modal and whatever the
    // operator had typed into it.
    if (sessionLost && !noBoot) {
      // B-71 — clear stale csrf + expiry markers before redirecting so the
      // login page doesn't auto-forward straight back into the dead session
      // (the infinite /login⇄/dashboard loop).
      bootToLogin();
    }
    throw new ApiError(res.status, body, (body as {message?: string})?.message ?? res.statusText);
  }
  return body as T;
}

// ─── Auth (ops-console login) ───────────────────────────────────────

export interface TotpEnrolment {
  uri:         string;
  secret:      string;
  backupCodes: string[];
}
export interface LoginStartResult {
  userId:       string | null;
  otpSentTo:    string | null;
  challengeId:  string | null;
  secondFactor: 'sms' | 'totp' | 'totp_enrol' | null;
  enrol:        TotpEnrolment | null;
}

export const authApi = {
  /**
   * Step 1 — phone + password. What comes back depends on the server's
   * AUTH_SECOND_FACTOR:
   *   sms         → an OTP was sent to `otpSentTo`
   *   totp        → `challengeId`; user enters their authenticator code
   *   totp_enrol  → `challengeId` + `enrol` (otpauth URI, manual key, backup
   *                 codes) — the account has no verified authenticator yet,
   *                 so this login doubles as enrolment
   * A wrong password returns every field null (no account enumeration). An
   * older server omits the three new fields; they read as undefined → SMS.
   */
  loginStart: (phoneE164: string, password: string) =>
    fetchJson<LoginStartResult>(
      `/auth/login`,
      {method: 'POST', body: JSON.stringify({phoneE164, password})},
    ),

  /** Step 2 — code → tokens. `challengeId` is required in TOTP mode. */
  loginVerify: (userId: string, code: string, deviceId: string, challengeId?: string | null) =>
    fetchJson<{user: {id: string; role: string}; accessToken: string; refreshToken: string; expiresIn: number}>(
      `/auth/verify`,
      {method: 'POST', body: JSON.stringify({userId, code, deviceId, platform: 'web', ...(challengeId ? {challengeId} : {})})},
    ),

  // Audit fix 0.1 — registerStart + registerVerifyAdmin removed alongside
  // the deleted /register page. The matching backend route now returns
  // 403 unconditionally; an invite-only flow replaces it in a follow-up.

  /**
   * Audit fix 0.4 — fetch a short-lived (5-min) messenger ticket from the
   * cookie-authenticated /auth/messenger-ticket endpoint. The JS holds
   * this in memory only and passes it to socket.io / messenger-service
   * REST. NEVER stored in localStorage.
   */
  messengerTicket: () =>
    fetchJson<{ticket: string; expiresIn: number}>(
      `/auth/messenger-ticket`,
      {method: 'POST'},
    ),

  /**
   * Audit fix 4.1 — cookie-bound silent refresh. The refresh token
   * itself lives in the httpOnly `bravo_ops_refresh` cookie (set on
   * /auth/verify) and is invisible to JS. The browser ships it on this
   * endpoint only (path-scoped). Returns the new access-cookie's
   * `expiresIn` so the client can schedule the next refresh.
   */
  sessionRefresh: () =>
    fetchJson<{expiresIn: number}>(
      `/auth/session/refresh`,
      {method: 'POST'},
    ),

  /**
   * RS-09 — redeem a single-use admin invite (public, pre-auth). Role,
   * call sign, and email are baked into the invite server-side; the
   * invitee supplies only their own phone + password, then logs in via
   * the normal phone + password + OTP flow.
   */
  acceptAdminInvite: (dto: {token: string; phone_e164: string; password: string; display_name?: string}) =>
    // B-820 — `existing_account` = console access was added to a Bravo account
    // that already existed, whose password was left as it was.
    fetchJson<{ok: true; call_sign: string; role: string; existing_account: boolean}>(
      `/auth/admin/accept-invite`,
      {method: 'POST', body: JSON.stringify(dto)},
    ),
};

/**
 * Audit fix 0.4 — in-memory messenger ticket holder. Refreshed before
 * expiry by the messenger runtime. NEVER persisted to disk.
 */
let messengerTicketCache: {token: string; expiresAt: number} | null = null;

/**
 * Mint a messenger ticket WITHOUT the fetchJson login-redirect, so a 401
 * (stale access cookie / rotated jti) can be recovered by a silent session
 * refresh instead of bouncing the operator to /login mid-mission.
 */
async function mintTicketRaw(): Promise<{ticket: string; expiresIn: number} | 401> {
  const res = await fetch(`${BASE}/auth/messenger-ticket`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(readCsrfToken() ? {'X-CSRF-Token': readCsrfToken() as string} : {}),
    },
    cache: 'no-store',
  });
  if (res.status === 401) return 401;
  if (!res.ok) throw new ApiError(res.status, null, `messenger-ticket ${res.status}`);
  return (await res.json()) as {ticket: string; expiresIn: number};
}

export async function getMessengerTicket(forceRefresh = false): Promise<string> {
  const now = Date.now();
  // Refresh 30s before expiry so a slow request doesn't outlive the ticket.
  if (
    !forceRefresh &&
    messengerTicketCache &&
    messengerTicketCache.expiresAt - 30_000 > now
  ) {
    return messengerTicketCache.token;
  }
  // First attempt. On 401 the access cookie's jti has rotated (or expired)
  // out of the server allowlist — surfacing as `token_revoked` on the relay /
  // sender-cert. Silently rotate the session via the httpOnly refresh cookie,
  // then retry the mint ONCE. Only if that also 401s is the session truly gone
  // (→ let fetchJson's redirect take over so the operator re-logs in).
  let res = await mintTicketRaw();
  if (res === 401) {
    try { await authApi.sessionRefresh(); } catch { /* fall through to redirect */ }
    res = await mintTicketRaw();
  }
  if (res === 401) {
    // Definitive: cookie session is dead. Clear markers + route to /login
    // (mirrors fetchJson; B-71 — must clear csrf so /login doesn't bounce back).
    bootToLogin();
    throw new ApiError(401, {message: 'session_expired'}, 'session_expired');
  }
  messengerTicketCache = {
    token:     res.ticket,
    expiresAt: now + res.expiresIn * 1000,
  };
  return res.ticket;
}

export function clearMessengerTicket(): void {
  messengerTicketCache = null;
}

// Audit fix 0.4 — the old saveSession() is gone. The auth-service sets the
// httpOnly `bravo_ops_token` and JS-readable `bravo_ops_csrf` cookies on
// /auth/verify and /auth/refresh; nothing token-shaped is persisted by JS.

/**
 * Audit fix 0.4 — logout posts to DELETE /auth/session which clears the
 * cookies server-side. We can't clear httpOnly cookies from JS, so the
 * server is authoritative.
 */
export async function clearSession(): Promise<void> {
  try {
    await fetchJson('/auth/session', {method: 'DELETE', body: JSON.stringify({allDevices: false})});
  } catch {
    // Best-effort: even if the delete fails (already revoked, etc.),
    // we still want the redirect-to-login to fire. The middleware will
    // bounce the next request to /login because the cookie is absent.
  }
  // Sign-out must not depend on the server's Set-Cookie deletions
  // arriving. If the DELETE 401s (expired access token), fails CORS, or
  // the deletion attributes don't match, the JS-readable `bravo_ops_csrf`
  // cookie survives — and BOTH the login page and Shell treat its
  // presence as "still logged in", bouncing the user straight back into
  // the app (the "can't sign out" loop). Expire it directly from JS so
  // logout is authoritative regardless of the DELETE's outcome. (The
  // httpOnly token/refresh cookies can't be cleared here — the server
  // owns those — but the csrf cookie is the gate every client check reads.)
  expireCsrfCookie();
  // Audit fix #13 — drop the in-memory messenger ticket too. Without
  // this, a re-login as a different admin in the same tab would reuse
  // the previous admin's ticket until it naturally expired (~5 min).
  clearMessengerTicket();
  // B-71 — bravo_ops_device_id is deliberately NOT cleared here. It's a stable
  // per-browser device identity (like the mobile app's Keychain device id);
  // clearing it minted a brand-new web device on every re-login, churning
  // auth_devices and amplifying the takeover/token_revoked loop. Re-login now
  // reuses this browser's device row (INSERT ... ON CONFLICT).
}

/**
 * Expire the JS-readable `bravo_ops_csrf` cookie from the client. The
 * cookie may carry a `Domain` attribute (COOKIE_DOMAIN, e.g. the shared
 * parent of the auth + ops subdomains on staging/prod) or be host-only in
 * dev, so we clear every candidate: host-only, the current host, and each
 * parent suffix down to the registrable domain — with and without a
 * leading dot. A deletion only takes effect when name+path+domain match
 * how the cookie was set, hence the shotgun.
 */
function expireCsrfCookie(): void {
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
    document.cookie =
      `bravo_ops_csrf=; expires=${past}; max-age=0; path=/` + (d ? `; domain=${d}` : '');
  }
}

/** Generate / re-use a stable device id for this browser. */
export function deviceId(): string {
  if (typeof window === 'undefined') return 'ssr';
  let id = window.localStorage.getItem('bravo_ops_device_id');
  if (!id) {
    id = `web-${crypto.randomUUID()}`;
    window.localStorage.setItem('bravo_ops_device_id', id);
  }
  return id;
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * Audit fix 4.3 — fresh Idempotency-Key per call. Uses crypto.randomUUID
 * when available (every modern browser); falls back to a longer
 * random.toString(36) so we still meet the server's 8–128 char
 * [A-Za-z0-9_-] regex even if randomUUID is shimmed.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Audit L4 — keep the fallback UNGUESSABLE. Prefer crypto.getRandomValues
  // (present wherever randomUUID is merely shimmed away) so the key can't be
  // predicted by an observer; only drop to Math.random as a last resort in a
  // crypto-less runtime (not the browser ops-console ships to). The server
  // additionally scopes the cache key by admin id + route, so a guessed key
  // still can't collide with another operator's request — this is
  // defence-in-depth on top of that.
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return 'idem-' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  }
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

// ─── Types ─────────────────────────────────────────────────────────

export type BookingStatus =
  | 'DRAFT' | 'PENDING_OPS' | 'OPS_APPROVED' | 'PAYMENT_PENDING'
  // Auto-dispatch pipeline state + its two stall outcomes (SK-04).
  | 'DISPATCHING' | 'NO_PROVIDER' | 'AGENCY_NO_SHOW'
  | 'CONFIRMED' | 'LIVE' | 'COMPLETED' | 'CANCELLED';

export type MissionStatus =
  | 'CREWED' | 'DISPATCHED' | 'PICKUP' | 'LIVE' | 'SOS' | 'COMPLETED' | 'ABORTED';

export type JobStatus =
  | 'PUBLISHED' | 'REVIEW' | 'ASSIGNED' | 'DISPATCHED' | 'CANCELLED';

export type AgentStatus =
  | 'DRAFT' | 'PROFILE_COMPLETE' | 'KYC_PENDING' | 'DOCS_PENDING'
  | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'ACTIVE';

export interface ProductKpis {
  /** Everything in this product blocked on an operator right now. */
  waiting: number;
  pending_approval: number;
  dispatching: number;
  stalled: number;
  live: number;
  gmv_today_bc: number;
}

export interface ExecutiveKpis extends ProductKpis {
  /** Approved/confirmed details starting inside the next 24 hours. */
  upcoming_24h: number;
}

export interface DashboardResponse {
  kpis: {
    pending_approval: number;
    active_missions: number;
    agents_on_duty: number;
    agents_total: number;
    open_jobs: number;
    gmv_today_aed: number;
    /** BC-denominated GMV (== SUM(total_eur), 1:1 peg). */
    gmv_today_bc: number;
    sos_active: number;
    /** IS-14 — Pro applications waiting on ops (PENDING_PROPOSAL + REVISION_REQUESTED). */
    pro_pending?: number;
      /** IS-14 — Pro protection-date requests awaiting officers (REQUESTED). */
    pro_requests?: number;
    /**
     * IA-10 — per-product segments. Optional: a console deployed ahead of the
     * server falls back to the flat keys above and shows no product badges.
     * `waiting` is the one number the rail badges and section landings use.
     */
    lite?: ProductKpis;
    executive?: ExecutiveKpis;
    enterprise?: {waiting: number; critical_incidents_24h: number};
  };
  activity: Array<{
    id: number; kind: string; severity: 'info' | 'ok' | 'warn' | 'err';
    actor: string | null; subject: string | null;
    message: string; created_at: string;
    /** B-817 — full ids (`booking_id`, `mission_id`, `job_id`, `user_id`, …)
     *  so a row can deep-link. Optional: rows from before the stamp have none. */
    metadata?: Record<string, unknown> | null;
  }>;
}

/**
 * E2E-48 — what `POST /ops/bookings/:id/approve` reports about the lane it
 * just committed the booking to.
 *
 * The toast used to assert "published to the job feed" unconditionally, which
 * is a lie on the whole auto lane: the server publishes a job only on the
 * legacy manual path and otherwise hands the booking to the offer cascade
 * (ops.service.ts:750-754 vs :805). It now says so outright.
 *
 * `job_published` is the load-bearing field, and it is NOT simply "was this
 * the manual lane": a legacy approve whose publish step THREW also returns
 * false, because the approval stays authoritative while the feed row does not
 * exist. That case needs an error toast, not a cheerful one — the old
 * `job: null` could not tell it apart from success.
 *
 * Fields stay optional so a console deployed ahead of the server degrades to
 * honest copy instead of asserting the wrong lane — see `approvalOutcome`.
 */
export type ApproveDispatchPath = 'auto_dispatch' | 'auto_scheduled' | 'job_feed';

export interface ApproveBookingResult {
  ok?: boolean;
  job?: unknown | null;
  /** Did this approval actually create an agent-feed job row? */
  job_published?: boolean | null;
  /** Which lane now owns the booking. */
  dispatch_path?: ApproveDispatchPath | null;
}

export interface BookingRow {
  id: string;
  status: BookingStatus;
  region_code: string;
  region_label: string;
  service: string;
  pickup_time: string;
  pickup_address: string;
  dropoff_address: string | null;
  cpo_count: number;
  vehicle_count: number;
  total_eur: string;
  total_aed: string;
  created_at: string;
  /** IS-11 — the actual client's display name (users join). */
  client_name?: string | null;
  /** Family-charged bookings only: the OWNER whose wallet paid (member "under" them). */
  payer_name?: string | null;
  /**
   * B-854 (A8) — the INTERMEDIARY on a chained charge: the wallet is the root's,
   * but the booking belongs to that member's own member. Optional and absent
   * today — `ops.service.ts`'s list projection does not select either column
   * yet, so the label degrades to the plain one-hop form until it does.
   */
  payer_via_user_id?: string | null;
  payer_via_name?: string | null;
  /**
   * IA-05 — which lane is working this booking. 'auto' = the dispatch engine
   * holds it (an offer exists), 'manual' = it is on the agent job feed only,
   * null = not approved yet. Optional so a console deployed ahead of the
   * server simply renders no lane chip.
   */
  lane?: 'auto' | 'manual' | null;
  /* IA-16 — Executive Protection columns. Null/defaults on Lite rows. */
  task_type?: string | null;
  duration_hours?: number | null;
  add_ons?: string[] | null;
  driver_only?: boolean | null;
  has_transfer_leg?: boolean | null;
}

/** IS-07 — one per-unit line of the executive-protection price composition. */
export interface PriceBreakdownItem {
  id: string;
  label: string;
  qty: number;
  rate_eur: number;
  subtotal_eur: number;
}

export interface PriceBreakdown {
  items: PriceBreakdownItem[];
  rate_eur_per_hour: number;
  duration_hours: number;
  total_eur: number;
}

export interface MissionRow {
  id: string;
  booking_id: string;
  /** IA-03 — the booking's service; decides Lite vs Executive routing. */
  service?: string | null;
  status: MissionStatus;
  short_code: string;
  started_at: string;
  ended_at: string | null;
  current_lat: number | null;
  current_lng: number | null;
  heading_deg: number | null;
  speed_kph: number | null;
  risk_level: string;
  comms_pct: number;
  gps_rtk_lock: boolean;
  vehicle_model: string | null;
  vehicle_plate: string | null;
  vehicle_armour: string | null;
  client_id: string | null;
  client_display_name: string | null;
  client_email: string | null;
  pickup_address: string | null;
  dropoff_address: string | null;
  region_code: string | null;
  region_label: string | null;
  route_distance_m: number | null;
  route_duration_s: number | null;
  route_polyline: string | null;
  /** Latest principal/client GPS fix (client app foreground push). Null
   *  until the client telemetry endpoint is wired and the client side
   *  starts pushing — the live page renders an "AWAITING" placeholder. */
  client_lat: number | null;
  client_lng: number | null;
  client_recorded_at: string | null;
  /** B-89 MG-15 — bumped on every CPO telemetry push; drives the lost-signal staleness badge. */
  updated_at: string | null;
  /** Conversation_id of the encrypted mission group (set at dispatch). */
  comms_channel_id: string | null;
}

export interface MissionDetail {
  mission: MissionRow;
  crew: Array<{
    mission_id: string; agent_id: string; slot: number;
    role: string; call_sign: string; armed: boolean;
    comms_ch: number; mic_hot: boolean; status: string;
    is_lead?: boolean; team_idx?: number;
  }>;
  waypoints: Array<{
    id: number; seq: number; tag: string; event: string; sub: string | null;
    state: 'pending' | 'current' | 'done' | 'sos';
    planned_at: string | null; settled_at: string | null;
  }>;
  principals: Array<{
    id: string; display_name: string; sub_label: string | null;
    phone: string | null; onboard: boolean; order_idx: number;
  }>;
  sos: Array<{
    id: string; reason: string; triggered_at: string;
    acknowledged_at: string | null; acknowledged_by: string | null;
    resolved_at: string | null; escalated_at: string | null;
    agent_call_sign: string | null;
  }>;
  audit: Array<{
    id: number; actor_role: string; actor_call: string | null;
    action: string; metadata: Record<string, unknown>; created_at: string;
  }>;
  booking: {
    id: string;
    client_id: string;
    pickup_address: string;
    pickup_lat: string | null; pickup_lng: string | null;
    dropoff_address: string | null;
    dropoff_lat: string | null; dropoff_lng: string | null;
    region_code: string; region_label: string;
    service: string; pickup_time: string;
    cpo_count: number; vehicle_count: number;
    total_eur: string; total_aed: string;
    dress_instructions: string | null;
    /** CA-07 — Executive Protection fields (mission.service getById projection). */
    task_type: string | null;
    duration_hours: number;
    exec_transport: unknown | null;
    client_display_name: string | null;
    client_email: string | null;
    client_phone: string | null;
  } | null;
  vehicle: {
    id: string; call_sign: string; make_model: string; plate: string;
    armored: boolean; armor_grade: string | null; capacity: number;
  } | null;
  /** CA-07 — Executive Protection hourly check-ins (empty for non-exec missions). */
  hourly_checkins: Array<{
    hour_index: number; status: string; comment: string | null; created_at: string;
  }>;
}

export interface JobRow {
  id: string;
  booking_id: string;
  short_code: string;
  status: JobStatus;
  region_code: string;
  route_label: string;
  dispatch_at: string;
  duration_hours: number;
  cpo_slots: number;
  slots_filled: number;
  published_at: string;
}

export interface AgentListRow {
  user_id: string;
  type: 'company' | 'cpo' | 'transport';
  status: AgentStatus;
  tier: number;
  call_sign: string | null;
  display_name: string | null;
  rate_aed_per_hour: string | null;
  rating: string | null;
  jobs_total: number;
  duty_hours_mtd: number;
  on_duty: boolean;
  submitted_at: string | null;
  approved_at: string | null;
  created_at: string;
  email: string | null;
  phone: string | null;
  coverage: {countries: Array<{code: string; on: boolean}>; services: Array<{key: string; on: boolean}>} | null;
}

export interface AgentDetail {
  agent: AgentListRow;
  profile: {
    company: Record<string, unknown>;
    contact: Record<string, unknown>;
    capabilities: string[];
    coverage: {countries: Array<{code: string; on: boolean}>; services: Array<{key: string; on: boolean}>};
    availability: {mode: string; loadout: string[]};
  };
  contact: {email: string | null; phone: string | null};
  kyc: Array<{
    kind: 'gov_id' | 'proof_address' | 'sia_licence' | 'police';
    state: 'queued' | 'running' | 'done' | 'failed';
    subject: string | null;
    file_url: string | null;
    uploaded_at: string | null;
    reviewed_at: string | null;
  }>;
  documents: Array<{
    id: string; slot: string; required: boolean; title: string;
    state: 'upload' | 'done' | 'rejected';
    file_url: string | null; uploaded_at: string | null;
    reviewed_at: string | null;
  }>;
  review: Array<{
    step: 'submit' | 'docs' | 'kyc' | 'ops' | 'partner';
    state: 'pending' | 'in_progress' | 'done' | 'rejected';
    notes: string | null; settled_at: string | null;
  }>;
  deployment: Array<{
    check_key: 'dress' | 'vehicle' | 'equip' | 'briefing';
    state: 'pending' | 'passed' | 'failed';
    notes: string | null; signed_at: string | null;
  }>;
  /** DC-08 — agent_audit lifecycle trail (status flips), newest first. */
  state_audit?: Array<{
    id: number; from_status: string | null; to_status: string;
    actor_id: string | null; actor_role: string | null;
    metadata: Record<string, unknown> | null; created_at: string;
  }>;
}

export interface AgentStats {
  activeMission: {
    id: string; short_code: string; status: string;
    current_lat: number | null; current_lng: number | null;
    started_at: string; risk_level: string;
    pickup_address: string | null; dropoff_address: string | null;
  } | null;
  recentMissions: Array<{
    id: string; short_code: string; status: string;
    started_at: string; ended_at: string | null;
    pickup_address: string | null; total_aed: string | null;
    /** BC value (== total_eur, 1:1 peg). */
    total_eur: string | null;
  }>;
  lastLocation: {lat: number; lng: number; recorded_at: string} | null;
}

export interface ApplicationRow {
  id: string;
  job_id: string;
  agent_id: string;
  agent_call_sign: string;
  status: 'PENDING' | 'SHORTLISTED' | 'ASSIGNED' | 'REJECTED' | 'WITHDRAWN';
  rank: number | null;
  fit_score: number | null;
  distance_km: string | null;
  rate_ccy: string;
  rate_per_hour: string | null;
  applied_at: string;
  // Dress pledge captured at apply-time. Audit field — compare against
  // the booking's dress_instructions on the job/applications view.
  dress_pledge: string | null;
  dress_pledged_at: string | null;
}

// ─── Endpoints ──────────────────────────────────────────────────────

export interface OpsMe {
  admin: {
    user_id: string; role: AdminRole;
    call_sign: string; region: string;
  };
}

export interface PoolCpo {
  id: string;
  call_sign: string;
  display_name: string;
  role: string;
}

export interface PoolVehicle {
  id: string;
  call_sign: string;
  make_model: string;
  plate: string;
  armored: boolean;
  armor_grade: string | null;
  capacity: number;
}

export type ApplicationStatus = 'PENDING' | 'SHORTLISTED' | 'ASSIGNED' | 'REJECTED' | 'WITHDRAWN';

export interface BookingApplicant {
  id: string;            // application id
  agent_id: string;
  agent_call_sign: string;
  display_name: string | null;
  status: ApplicationStatus;
  rating: string | null;
  jobs_total: number;
  tier: number;
  applied_at: string;
  dress_pledge: string | null;
  dress_pledged_at: string | null;
}

/** B-788a — the Areas & providers panel's single read. */
export interface DispatchAreasResponse {
  regions: Array<{code: string; name: string; launched: boolean; routing_mode: 'nearest' | 'assigned'}>;
  areas: Array<{
    id: string; region_code: string; code: string; name: string; is_default: boolean; active: boolean;
    min_lat: number | null; max_lat: number | null; min_lng: number | null; max_lng: number | null;
    updated_at: string;
    assignments: Array<{
      provider_user_id: string; priority: number; display_name: string | null; call_sign: string | null;
      provider_status: string; provider_region: string | null;
    }>;
  }>;
  providers: Array<{
    user_id: string; display_name: string | null; call_sign: string | null; region_code: string | null; on_duty: boolean;
  }>;
}

export const opsApi = {
  // E2E-43 — `noBoot`: this is the only endpoint the console polls purely to
  // re-check identity, so a single 401 here must not navigate the operator
  // away. useOpsMe decides when a boot is warranted (two in a row).
  me:              () => fetchJson<OpsMe>(`/ops/me`, {noBoot: true} as RequestInit & {noBoot?: boolean}),

  dashboard:       (region?: string) =>
    fetchJson<DashboardResponse>(`/ops/dashboard${region ? `?region=${region}` : ''}`),

  activity:        (limit = 50) => fetchJson<DashboardResponse['activity']>(`/ops/activity?limit=${limit}`),

  // Bookings
  // OP-13 — `q` is a server-side ILIKE over id / client name / pickup /
  // dropoff; OP-17 — `offset` pages by index (see usePagedList);
  // IA-03 — `service` is the product boundary (comma list).
  listBookings:    (q?: {status?: BookingStatus; region?: string; q?: string; limit?: number; offset?: number; service?: string}) => {
    const p = new URLSearchParams();
    if (q?.status) p.set('status', q.status);
    if (q?.region) p.set('region', q.region);
    if (q?.q)      p.set('q', q.q);
    if (q?.limit)  p.set('limit', String(q.limit));
    if (q?.offset) p.set('offset', String(q.offset));
    // IA-03 — comma list of booking service keys; the product boundary.
    if (q?.service) p.set('service', q.service);
    const qs = p.toString();
    return fetchJson<BookingRow[]>(`/ops/bookings${qs ? `?${qs}` : ''}`);
  },
  getBooking:      (id: string) =>
    fetchJson<{
      booking: BookingRow & {
        client_id: string;
        booking_mode: string;
        passengers: number;
        driver_only: boolean;
        add_ons: Array<string | {id: string; label?: string}>;
        duration_hours: number;
        rate_eur_per_hour: string;
        rate_aed_per_hour: string;
        payment_method: string;
        payment_captured: boolean;
        /** SK-12 — stamped at the CONFIRMED flip; null on pre-B-386 rows. */
        confirmed_at?: string | null;
        /**
         * E2E-48 — 'auto' = the dispatch engine works this booking (approval
         * publishes NOTHING to the agent job feed); null = the legacy manual
         * lane, where approval does publish a job. The server sends the whole
         * `lite_bookings` row, so this has always been on the wire — it was
         * simply not typed, which is why the approve toast could not tell the
         * two lanes apart. Optional: a console ahead of the server degrades to
         * the neutral copy rather than asserting the wrong one.
         */
        dispatch_mode?: string | null;
        notes: string | null;
        pickup_lat: string | null;
        pickup_lng: string | null;
        dropoff_lat: string | null;
        dropoff_lng: string | null;
        /** Executive Protection (service 'executive_protection') — task + optional secure-transfer leg. */
        task_type?: string | null;
        exec_transport?: {
          mode?: string;
          pickup?: {address?: string; latitude?: number; longitude?: number};
          dropoff?: {address?: string; latitude?: number; longitude?: number};
          pickup_time?: string | null;
          passengers?: number;
        } | null;
        /** SK-05 — client rating, present once submitted on a COMPLETED booking. */
        rating?: number | null;
        rating_tags?: string[] | null;
        rating_remarks?: string | null;
      };
      audit: unknown[];
      job: JobRow | null;
      team: {cpos: PoolCpo[]; vehicle: PoolVehicle | null};
      client: {
        id: string;
        display_name: string;
        email: string | null;
        phone: string | null;
        subscription_tier: string;
        country_code: string | null;
        kyc_status: string;
        avatar_url: string | null;
        created_at: string;
      } | null;
      mission: {id: string; short_code: string; status: string} | null;
      /** Set when a family member booked under an owner's wallet. */
      payer: {id: string; display_name: string | null} | null;
      /** IS-07 — per-unit exec price composition; null for non-exec services. */
      price_breakdown?: PriceBreakdown | null;
    }>(`/ops/bookings/${id}`),
  /**
   * Audit fix 4.3 — Idempotency-Key auto-issued per call. A double-click
   * or network retry inside 24h returns the cached first response from
   * Redis (handler is never re-invoked).
   *
   * E2E-04 — `approveLate` maps to `ApproveBookingDto.approve_late` and
   * overrides ONLY a `booking_insufficient_lead_time` refusal.
   *
   * `idempotencyKey` is a CALLER-supplied key so the booking detail can mint
   * ONE per modal-open and reuse it across the refusal → override → retry
   * sequence. Minting per call was wrong in a specific, reachable way: when an
   * approve SUCCEEDS but its response is lost (dropped connection, tab sleep),
   * the modal re-enables and the operator clicks again — with a fresh key that
   * is a genuinely new request, so the server executes it against an already
   * OPS_APPROVED booking and answers `booking_not_pending`. One key per modal
   * replays the cached success instead.
   *
   * Safe because the interceptor RELEASES its reservation when the handler
   * throws (idempotency.interceptor.ts:38-42): the first attempt's 400 refusal
   * does not poison the key, so the deliberate `approve_late` retry still
   * reaches the handler. Falls back to a fresh key when the caller passes none.
   */
  approveBooking:  (
    id: string, dressInstructions: string, notes?: string,
    approveLate?: boolean, idempotencyKey?: string,
  ) =>
    fetchJson<ApproveBookingResult>(`/ops/bookings/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({
        dress_instructions: dressInstructions,
        notes,
        ...(approveLate ? {approve_late: true} : {}),
      }),
      idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  rejectBooking:   (id: string, reason: string, notes?: string) =>
    fetchJson(`/ops/bookings/${id}/reject`, {
      method: 'POST', body: JSON.stringify({reason, notes}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  // vehicleId is omitted for driver-only / exec protection-only bookings —
  // the server rejects a vehicle pick there (driver_only_no_vehicle).
  dispatchBooking: (id: string, body: {applicationIds: string[]; vehicleId?: string; dressInstructions?: string | null; leadAgentId?: string | null}) =>
    fetchJson<{ok: true; status: 'LIVE'; conversation_id: string | null; mission_id: string}>(`/ops/bookings/${id}/dispatch`, {
      method: 'POST', body: JSON.stringify(body),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  getProposedPayouts: (id: string) =>
    fetchJson<{
      booking_id: string;
      escrow_credits: number;
      cpo_count: number;
      even_split: number;
      platform_remainder: number;
      proposed: Array<{user_id: string; call_sign: string; display_name: string; proposed_credits: number}>;
    }>(`/ops/bookings/${id}/proposed-payouts`),

  completeBooking: (
    id: string,
    body?: {payouts?: Array<{user_id: string; credits: number; deduction_reason?: string | null}>},
  ) =>
    fetchJson<{
      ok: true; status: 'COMPLETED';
      payouts: Array<{user_id: string; credits: number; deduction_reason: string | null}>;
      platform_fee: number;
      group_purged: boolean;
    }>(`/ops/bookings/${id}/complete`, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  // Manual BC grant (+) / deduction (−) on a user wallet. SUPERVISOR/ADMIN
  // only (backend @RequireRoles). Keyed so a double-click or network retry
  // can't credit the wallet twice.
  adjustWallet: (userId: string, body: {credits: number; reason: string}) =>
    fetchJson<{
      balance: {bravo_credits: number; currency: string};
      transaction_id: string;
    }>(`/ops/wallets/${userId}/adjust`, {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  listBookingApplicants: (id: string, signal?: AbortSignal) =>
    fetchJson<{
      job: {id: string; cpo_slots: number; status: string} | null;
      applicants: BookingApplicant[];
    }>(`/ops/bookings/${id}/applicants`, {signal}),
  listAvailableVehicles: (region: string, signal?: AbortSignal) =>
    fetchJson<PoolVehicle[]>(`/ops/pool/vehicles?region=${encodeURIComponent(region)}`, {signal}),

  // Department Channels (admin oversight). OP-14 — keyset-paged server-side:
  // `cursor` is the previous page's last row as `<created_at>|<id>`.
  listDepartments: (page?: {limit?: number; cursor?: string}) =>
    fetchJson<DepartmentChannelRow[]>(`/ops/departments${qs({limit: page?.limit, cursor: page?.cursor})}`),

  // Jobs
  listJobs:        (status?: JobStatus) =>
    fetchJson<JobRow[]>(`/ops/jobs${status ? `?status=${status}` : ''}`),
  getJob:          (id: string) =>
    fetchJson<{job: JobRow; applications: ApplicationRow[]}>(`/ops/jobs/${id}`),
  // Job + application mutations carry an Idempotency-Key too — a retried
  // dispatch must not mint two missions, and a double-clicked assign must
  // not consume two slots.
  cancelJob:       (id: string, reason: string) =>
    fetchJson(`/ops/jobs/${id}/cancel`, {
      method: 'POST', body: JSON.stringify({reason}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  dispatchJob:     (id: string) =>
    fetchJson<{mission_id: string}>(`/ops/jobs/${id}/dispatch`, {
      method: 'POST',
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  // Applications
  shortlistApp:    (id: string) =>
    fetchJson(`/ops/applications/${id}/shortlist`, {
      method: 'POST',
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  assignApp:       (id: string) =>
    fetchJson(`/ops/applications/${id}/assign`, {
      method: 'POST',
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  rejectApp:       (id: string, notes?: string) =>
    fetchJson(`/ops/applications/${id}/reject`, {
      method: 'POST', body: JSON.stringify({notes}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  // Agents
  listAgents:      (q?: {status?: string; type?: string; limit?: number; offset?: number}) => {
    const p = new URLSearchParams();
    if (q?.status) p.set('status', q.status);
    if (q?.type)   p.set('type', q.type);
    if (q?.limit)  p.set('limit', String(q.limit));
    if (q?.offset) p.set('offset', String(q.offset));
    const qs = p.toString();
    return fetchJson<AgentListRow[]>(`/ops/agents${qs ? `?${qs}` : ''}`);
  },
  getAgent:        (id: string) =>
    fetchJson<AgentDetail>(`/ops/agents/${id}`),
  decideAgent:     (id: string, decision: 'APPROVED' | 'REJECTED', notes?: string) =>
    fetchJson(`/ops/agents/${id}/decide`, {
      method: 'POST', body: JSON.stringify({decision, notes}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  reviewDoc:       (agentId: string, slot: string) =>
    fetchJson(`/ops/agents/${agentId}/docs/${slot}/review`, {
      method: 'POST',
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  reviewKyc:       (agentId: string, kind: string) =>
    fetchJson(`/ops/agents/${agentId}/kyc/${kind}/review`, {
      method: 'POST',
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  agentStats:      (id: string) => fetchJson<AgentStats>(`/ops/agents/${id}/stats`),
  terminateAgent:  (id: string, notes?: string) =>
    fetchJson(`/ops/agents/${id}/terminate`, {
      method: 'POST', body: JSON.stringify({notes}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  // Audit fix 4.2 — log every click-to-reveal of customer PII. Best-effort:
  // failure to log shouldn't refuse the reveal (the admin already has the
  // value in memory from the parent fetch).
  auditPiiReveal: (body: {kind: 'phone' | 'email' | 'address'; subject: string}) =>
    fetchJson(`/ops/audit/pii-reveal`, {method: 'POST', body: JSON.stringify(body)}),

  // Mission deployment checklist
  getMissionDeployment: (missionId: string, signal?: AbortSignal) =>
    fetchJson<{
      crew: Array<{agent_id: string; call_sign: string; role: string}>;
      checks: Array<{user_id: string; check_key: string; state: string; signed_at: string | null; notes: string | null}>;
    }>(`/ops/missions/${missionId}/deployment`, {signal}),
  signoffMissionDeploy: (missionId: string, agent_id: string, check_key: string, state: 'passed' | 'failed') =>
    fetchJson(`/ops/missions/${missionId}/deployment/signoff`, {
      method: 'POST', body: JSON.stringify({agent_id, check_key, state}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  // Missions — status='active' (default, omitted) returns LIVE/DISPATCHED/PICKUP/SOS,
  // status='completed' returns COMPLETED/ABORTED for the closed-history tab.
  // OP-13 — `q` is a server-side ILIKE over id / client / CPO name;
  // IA-03 — `service` scopes the board to one product.
  listMissions:    (region?: string, status?: 'active' | 'completed', limit?: number, q?: string, service?: string) => {
    const qs = new URLSearchParams();
    if (region) qs.set('region', region);
    if (status) qs.set('status', status);
    if (limit)  qs.set('limit', String(limit));
    if (q)      qs.set('q', q);
    if (service) qs.set('service', service);
    const tail = qs.toString();
    return fetchJson<MissionRow[]>(`/ops/missions${tail ? `?${tail}` : ''}`);
  },
  getMission:      (id: string) => fetchJson<MissionDetail>(`/ops/missions/${id}`),
  // Audit H4 — destructive mission/SOS mutations carry an Idempotency-Key
  // so a double-click or network retry collapses to one server action
  // instead of two audit rows / duplicate state changes. Pairs with the
  // IdempotencyInterceptor now mounted on these endpoints server-side.
  // 2026-09-04 — send a crewed-but-never-dispatched team; same flip as the agency button.
  dispatchMission: (id: string) =>
    fetchJson(`/ops/missions/${id}/dispatch`, {
      method: 'POST',
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  abortMission:    (id: string, reason: string, notes?: string) =>
    fetchJson(`/ops/missions/${id}/abort`, {
      method: 'POST', body: JSON.stringify({reason, notes}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  // SOS
  ackSos:          (id: string, notes?: string) =>
    fetchJson(`/ops/sos/${id}/ack`, {
      method: 'POST', body: JSON.stringify({notes}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  escalateSos:     (id: string, escalated_to: string, notes?: string) =>
    fetchJson(`/ops/sos/${id}/escalate`, {
      method: 'POST', body: JSON.stringify({escalated_to, notes}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  resolveSos:      (id: string, resolution: string) =>
    fetchJson(`/ops/sos/${id}/resolve`, {
      method: 'POST', body: JSON.stringify({resolution}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  // Conversation roster — used by the Mission Group panel to know who
  // it should encrypt envelopes for. Returns members + my admin role.
  getConversation: (id: string) =>
    fetchJson<{
      id: string; kind: 'direct' | 'group'; title: string | null;
      createdAt: string; createdBy: string;
      members: Array<{userId: string; displayName: string; role: 'admin' | 'member'; joinedAt: string}>;
      myRole: 'admin' | 'member';
    }>(`/conversations/${id}`),

  // Mission RE-ROUTE picker — fetch up to 3 driving alternatives between
  // the booking's pickup and dropoff, then persist the chosen polyline.
  // The CPO mobile app polls the mission row and switches roads within
  // one cycle, so no agent-side changes are needed.
  getRouteOptions: (missionId: string, signal?: AbortSignal) =>
    fetchJson<{
      options: Array<{
        key: string; distance_m: number; duration_s: number;
        polyline: string | null; is_current: boolean;
      }>;
      pickup:  {lat: number; lng: number} | null;
      dropoff: {lat: number; lng: number} | null;
    }>(`/ops/missions/${missionId}/route-options`, {signal}),
  selectRoute: (missionId: string, body: {polyline: string; distance_m: number; duration_s: number}) =>
    fetchJson<void>(`/ops/missions/${missionId}/route-select`, {
      method: 'POST', body: JSON.stringify(body),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  // Mission ops-room messaging — free-form ops ↔ CPO/principal text.
  // Messages are stored as system_broadcasts on the mission's
  // comms_channel_id, so CPOs see them inline in their messenger feed.
  listMissionMessages: (id: string) =>
    fetchJson<{
      messages: Array<{
        id: string; kind: string; title: string; body: string;
        severity: string; created_at: string;
        payload?: {sender_label?: string; mission_short_code?: string};
      }>;
      conversation_id?: string;
    }>(`/ops/missions/${id}/messages`),
  sendMissionMessage: (id: string, text: string) =>
    // Keyed so a retried send doesn't broadcast the same ops message to
    // the mission channel twice.
    fetchJson<{ok: boolean; id?: string; reason?: string}>(
      `/ops/missions/${id}/messages`,
      {
        method: 'POST', body: JSON.stringify({text}),
        idempotencyKey: newIdempotencyKey(),
      } as RequestInit & {idempotencyKey?: string},
    ),

  // ─── Auto-dispatch monitor (watch the matchmaker work) ───────────────
  dispatchMonitor: () => fetchJson<DispatchMonitor>(`/ops/dispatch/monitor`),
  // Audit PAGE-17 — keyed so a network retry can't mint two real
  // DISPATCHING bookings cascading offers to live agencies.
  fireTestDispatch: (args: FireTestDispatchArgs) =>
    fetchJson<{booking_id: string}>(`/ops/dispatch/test`, {
      method: 'POST', body: JSON.stringify(args),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  // Step 26 — runtime kill-switch state + admin overrides (idempotent, attributable).
  killswitchState: () =>
    fetchJson<{runtime: 'true' | 'false' | 'unset'; enabled: boolean}>(`/ops/dispatch/killswitch`),
  setKillswitch: (enabled: boolean) =>
    fetchJson<{ok: true; enabled: boolean}>(`/ops/dispatch/killswitch`, {
      method: 'PUT', body: JSON.stringify({enabled}),
    }),
  // 2026-09-27 — runtime third-party integration settings (Integrations tab).
  // SUPER_ADMIN only. Secrets are write-only: reads return a masked preview.
  integrationSettings: () => fetchJson<IntegrationSettingsResponse>(`/ops/settings`),
  setIntegrationSetting: (key: string, value: string) =>
    fetchJson<{ok: true; setting: IntegrationSetting | null}>(`/ops/settings/${encodeURIComponent(key)}`, {
      method: 'PUT', body: JSON.stringify({value}),
    }),
  clearIntegrationSetting: (key: string) =>
    fetchJson<{ok: true; setting: IntegrationSetting | null}>(`/ops/settings/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    }),
  /** One test SMS with the saved Twilio credentials. */
  testSms: (to: string) =>
    fetchJson<{ok: boolean; error: string | null}>(`/ops/settings/sms/test`, {
      method: 'POST', body: JSON.stringify({to}),
    }),
  // 2026-09-27 — Module Access (group × module matrix + per-user overrides) and
  // ops-created app accounts as SMS invites. All SUPER_ADMIN (rank 3).
  moduleAccess: () => fetchJson<ModuleAccessMatrix>(`/ops/module-access`),
  setGroupModule: (group: string, module: string, enabled: boolean) =>
    fetchJson<{ok: true}>(`/ops/module-access/groups/${encodeURIComponent(group)}/${encodeURIComponent(module)}`, {
      method: 'PUT', body: JSON.stringify({enabled}),
    }),
  userModules: (userId: string) =>
    fetchJson<UserModuleView>(`/ops/module-access/users/${encodeURIComponent(userId)}`),
  setUserModule: (userId: string, module: string, enabled: boolean | null) =>
    fetchJson<{ok: true; view: UserModuleView}>(
      `/ops/module-access/users/${encodeURIComponent(userId)}/${encodeURIComponent(module)}`,
      {method: 'PUT', body: JSON.stringify({enabled})},
    ),
  createAppUser: (body: CreateAppUserBody) =>
    fetchJson<CreateAppUserResult>(`/ops/users`, {method: 'POST', body: JSON.stringify(body)}),
  userInvite: (userId: string) => fetchJson<InviteStatus>(`/ops/users/${encodeURIComponent(userId)}/invite`),
  resendInvite: (userId: string) =>
    fetchJson<{user_id: string; invite: InviteStatus; sms_sent: boolean}>(
      `/ops/users/${encodeURIComponent(userId)}/invite/resend`, {method: 'POST'},
    ),
  // B-788a — Dispatch v2: operational areas, provider ladders, the routing switch.
  dispatchAreas: () => fetchJson<DispatchAreasResponse>(`/ops/dispatch/areas`),
  createDispatchArea: (body: {
    region_code: string; code: string; name: string;
    min_lat?: number; max_lat?: number; min_lng?: number; max_lng?: number;
  }) => fetchJson<{id: string; ok: true}>(`/ops/dispatch/areas`, {method: 'POST', body: JSON.stringify(body)}),
  updateDispatchArea: (id: string, body: {name?: string; active?: boolean;
    min_lat?: number; max_lat?: number; min_lng?: number; max_lng?: number}) =>
    fetchJson<{ok: true}>(`/ops/dispatch/areas/${id}`, {method: 'PATCH', body: JSON.stringify(body)}),
  setAreaAssignments: (id: string, assignments: Array<{provider_user_id: string; priority: number}>) =>
    fetchJson<{ok: true}>(`/ops/dispatch/areas/${id}/assignments`, {method: 'PUT', body: JSON.stringify({assignments})}),
  setRegionRoutingMode: (code: string, routing_mode: 'nearest' | 'assigned') =>
    fetchJson<{code: string; routing_mode: string; ok: true}>(`/ops/dispatch/areas/routing-mode/${code}`, {
      method: 'PATCH', body: JSON.stringify({routing_mode}),
    }),
  cancelDispatch: (bookingId: string) =>
    fetchJson<{ok: true; cancelled: true}>(`/ops/dispatch/${bookingId}/cancel`, {
      method: 'POST', idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  forceAssign: (bookingId: string) =>
    fetchJson<{ok: true; offer_id: string; provider_user_id: string; booking_id: string}>(`/ops/dispatch/${bookingId}/force-assign`, {
      method: 'POST', idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  // ─── Dispatch Inspector (read-only audit of every dispatch request) ──
  // OP-14 — the server pages with `limit` (default 50 / max 200) + `offset`.
  dispatchRequests: (q?: {status?: string; limit?: number; offset?: number}) =>
    fetchJson<DispatchRequestRow[]>(`/ops/dispatch/requests${qs({status: q?.status, limit: q?.limit, offset: q?.offset})}`),
  dispatchRequestDetail: (id: string) =>
    fetchJson<DispatchRequestDetail>(`/ops/dispatch/requests/${id}`),

  // ─── Provider compliance review (vetting gate, Step 15) ──────────────
  compliancePending: () => fetchJson<CompliancePendingRow[]>(`/ops/compliance/pending`),
  // Audit PAGE-18 — keyed like every other decision mutation so a retry can't double-apply.
  verifyCompliance: (id: string) => fetchJson<{ok: true}>(`/ops/compliance/${id}/verify`, {
    method: 'POST', idempotencyKey: newIdempotencyKey(),
  } as RequestInit & {idempotencyKey?: string}),
  rejectCompliance: (id: string, reason: string) =>
    fetchJson<{ok: true}>(`/ops/compliance/${id}/reject`, {
      method: 'POST', body: JSON.stringify({reason}), idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  // ── Dept Chat v2 oversight (Step 15; AdminGuard tier) ──
  deptIncidents: (params?: {org_id?: string; status?: string; severity?: string}) => {
    const qs = new URLSearchParams(
      Object.entries(params ?? {}).filter(([, v]) => Boolean(v)) as [string, string][],
    ).toString();
    return fetchJson<DeptIncidentRow[]>(`/ops/deptchat/incidents${qs ? `?${qs}` : ''}`);
  },
  deptAttendanceSummary: (orgId: string, from?: string, to?: string, signal?: AbortSignal) => {
    const qs = new URLSearchParams({
      org_id: orgId, ...(from ? {from} : {}), ...(to ? {to} : {}),
    }).toString();
    return fetchJson<DeptAttendanceSummary>(`/ops/deptchat/attendance/summary?${qs}`, {signal});
  },
  // Export returns text/csv (not JSON) → raw fetch so we can hand back the body
  // for a client-side Blob download. SUPERVISOR/ADMIN only (backend @RequireRoles).
  deptAttendanceExport: async (orgId: string, from?: string, to?: string, signal?: AbortSignal): Promise<string> => {
    const csrf = readCsrfToken();
    const res = await fetch(`${BASE}/ops/deptchat/attendance/export`, {
      method: 'POST',
      credentials: 'include',
      headers: {'Content-Type': 'application/json', ...(csrf ? {'X-CSRF-Token': csrf} : {})},
      body: JSON.stringify({org_id: orgId, from, to}),
      cache: 'no-store',
      signal,
    });
    if (!res.ok) {throw new ApiError(res.status, null, res.statusText);}
    return res.text();
  },

  // ── RS-09 — admin lifecycle (ADMIN-only, backend class-wide gate) ──
  listAdmins: () => fetchJson<AdminAccountRow[]>(`/ops/admins`),
  setAdminRole: (userId: string, role: AdminRole) =>
    fetchJson<{role: string}>(`/ops/admins/${userId}/role`, {
      method: 'PATCH', body: JSON.stringify({role}),
    }),
  // OC-09 — offboard/reinstate an operator (sets admin_users.active).
  setAdminActive: (userId: string, active: boolean) =>
    fetchJson<{active: boolean}>(`/ops/admins/${userId}/active`, {
      method: 'PATCH', body: JSON.stringify({active}),
    }),
  // B-818 — direct provisioning (id + password) by a SUPER_ADMIN; never returns the password.
  createAdminAccount: (dto: {
    display_name: string; call_sign: string; role: AdminRole;
    phone_e164: string; password: string; email?: string; region?: string;
  }) =>
    fetchJson<{ok: true; user_id: string; call_sign: string; role: AdminRole; existing_account: boolean}>(`/ops/admins`, {
      method: 'POST', body: JSON.stringify(dto),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  listAdminInvites: () => fetchJson<AdminInviteRow[]>(`/ops/admins/invites`),
  createAdminInvite: (dto: {
    email: string; display_name: string; call_sign: string;
    role?: AdminRole; region?: string;
  }) =>
    // CA-18 — keyed like every sibling POST: a retried create must not mint
    // two live invite tokens for the same admin.
    fetchJson<{invite: AdminInviteRow; token: string}>(`/ops/admins/invites`, {
      method: 'POST', body: JSON.stringify(dto),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  revokeAdminInvite: (id: string) =>
    fetchJson<{ok: true}>(`/ops/admins/invites/${id}`, {method: 'DELETE'}),

  // ── Issue 28 — partner / referral code mint + deactivate ──
  // ── Referral / discount campaigns (2026-09-05) ──
  listReferralCampaigns: () => fetchJson<ReferralCampaignRow[]>(`/ops/referral-campaigns`),
  referralCampaignsOverview: () => fetchJson<ReferralCampaignsOverview>(`/ops/referral-campaigns/overview`),
  getReferralCampaign: (id: string) => fetchJson<ReferralCampaignDetail>(`/ops/referral-campaigns/${id}`),
  createReferralCampaign: (dto: CreateReferralCampaignBody) =>
    fetchJson<ReferralCampaignRow & {eligible_clients: number}>(`/ops/referral-campaigns`, {
      method: 'POST', body: JSON.stringify(dto), idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  /** (Re)send the offer push to every eligible client — 24 h cooldown unless forced. */
  notifyReferralCampaign: (id: string, force = false) =>
    fetchJson<{queued: boolean; skipped: 'not_live' | 'cooldown' | 'no_push' | null; eligible: number}>(
      `/ops/referral-campaigns/${id}/notify`, {
        method: 'POST', body: JSON.stringify({force}), idempotencyKey: newIdempotencyKey(),
      } as RequestInit & {idempotencyKey?: string}),
  updateReferralCampaign: (id: string, patch: UpdateReferralCampaignBody) =>
    fetchJson<ReferralCampaignRow>(`/ops/referral-campaigns/${id}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    }),
  /** Public (no session) — the landing page's resolve. */
  publicReferral: (code: string) =>
    fetchJson<PublicReferral>(`/referrals/public/${encodeURIComponent(code)}`),

  listReferralCodes: () => fetchJson<ReferralCodeRow[]>(`/ops/referral-codes`),
  createReferralCode: (dto: {
    code: string; owner_user_id?: string; partner_name?: string;
    purpose?: string; expires_at?: string;
  }) =>
    // Keyed like every sibling POST: a transport-level replay of this exact
    // request is deduped (the key is per click, so a fresh click is a fresh
    // create — the unique code constraint catches real duplicates with a 409).
    fetchJson<ReferralCodeRow>(`/ops/referral-codes`, {
      method: 'POST', body: JSON.stringify(dto),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  setReferralCodeActive: (id: string, active: boolean) =>
    fetchJson<{id: string; code: string; active: boolean; expires_at: string | null}>(
      `/ops/referral-codes/${id}/active`, {
        method: 'PATCH', body: JSON.stringify({active}),
      }),
};

export interface AdminAccountRow {
  user_id: string;
  display_name: string;
  call_sign: string;
  role: AdminRole;
  region: string;
  active: boolean;
  last_active_at: string | null;
  created_at: string;
  email: string | null;
}

export interface AdminInviteRow {
  id: string;
  email: string;
  display_name: string;
  call_sign: string;
  role: AdminRole;
  region: string;
  invited_by: string;
  expires_at: string;
  redeemed_at: string | null;
  revoked_at: string | null;
  created_at: string;
  status: 'pending' | 'redeemed' | 'revoked' | 'expired';
}

/* ── Referral / discount campaigns (2026-09-05) ───────────────────────── */

export type ReferralCampaignStatus = 'active' | 'scheduled' | 'expired' | 'inactive' | 'exhausted';

export interface ReferralCampaignRow {
  id: string;
  code: string;
  name: string;
  scope: 'universal' | 'region';
  region_code: string | null;
  discount_type: 'percent' | 'fixed_bc';
  discount_value: string | number;
  max_discount_bc: number | null;
  services: string[] | null;
  max_redemptions: number | null;
  per_user_limit: number;
  starts_at: string | null;
  expires_at: string | null;
  active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
  /** Eligible-client push fan-out: last run + how many it reached. */
  notified_at?: string | null;
  notified_count?: number;
  /** Usage + money, from the redemption ledger (EUR strings; BC at the 1:1 peg). */
  redemptions: number;
  unique_users: number;
  gross_eur: string;
  discount_eur: string;
  net_eur: string;
  paid_bookings: number;
  paid_net_eur: string;
  status: ReferralCampaignStatus;
}

export interface ReferralRedemptionRow {
  id: string;
  booking_id: string;
  user_id: string;
  user_name: string | null;
  region_code: string | null;
  service: string | null;
  gross_eur: string;
  discount_eur: string;
  net_eur: string;
  created_at: string;
  booking_status: string | null;
  region_label: string | null;
  pickup_time: string | null;
  total_eur: string | null;
}

export interface ReferralCampaignDetail {
  campaign: ReferralCampaignRow;
  history: ReferralRedemptionRow[];
  by_status: Array<{status: string | null; n: string; net: string}>;
  by_day: Array<{day: string; n: string; discount: string; net: string}>;
}

export interface ReferralCampaignsOverview {
  campaigns: number;
  active: number;
  redemptions: number;
  unique_users: number;
  discount_eur: string;
  net_eur: string;
  redemptions_7d: number;
}

export interface CreateReferralCampaignBody {
  code: string;
  name: string;
  scope: 'universal' | 'region';
  region_code?: string;
  discount_type: 'percent' | 'fixed_bc';
  discount_value: number;
  max_discount_bc?: number;
  services?: string[];
  max_redemptions?: number;
  per_user_limit?: number;
  starts_at?: string;
  expires_at?: string;
  notes?: string;
}

export interface UpdateReferralCampaignBody {
  name?: string;
  active?: boolean;
  expires_at?: string | null;
  starts_at?: string | null;
  max_redemptions?: number | null;
  per_user_limit?: number;
  notes?: string | null;
}

export type PublicReferral =
  | {valid: false}
  | {valid: true; code: string; name: string; label: string; scope: 'universal' | 'region';
     region_code: string | null; expires_at: string | null};

export function useReferralCampaigns() {
  return useSWR<ReferralCampaignRow[]>('ops-referral-campaigns', () => opsApi.listReferralCampaigns(), {
    refreshInterval: POLL_DASH,
  });
}

export function useReferralCampaignsOverview() {
  return useSWR<ReferralCampaignsOverview>('ops-referral-campaigns-overview', () => opsApi.referralCampaignsOverview(), {
    refreshInterval: POLL_DASH,
  });
}

export function useReferralCampaign(id: string | null) {
  return useSWR<ReferralCampaignDetail | null>(
    id ? ['ops-referral-campaign', id] : null,
    () => (id ? opsApi.getReferralCampaign(id) : Promise.resolve(null)),
    {refreshInterval: POLL_DASH},
  );
}

export interface ReferralCodeRow {
  id: string;
  code: string;
  owner_user_id: string | null;
  owner_name: string | null;
  partner_name: string | null;
  purpose: string | null;
  active: boolean;
  expires_at: string | null;
  redeemed_count: number;
  booking_count: number;
  created_at: string;
  status: 'active' | 'inactive' | 'expired';
}

export interface DeptIncidentRow {
  id: string;
  ref: string | null;
  org_user_id: string;
  /** IS-09 — org display name joined server-side. */
  org_name?: string | null;
  submitter_id: string;
  category: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'submitted' | 'received' | 'under_review' | 'action_assigned' | 'resolved' | 'closed';
  created_at: string;
  updated_at: string;
}

export interface DeptAttendanceSummary {
  counts: Record<string, number>;
  total: number;
  pendingReview: number;
}

export interface CompliancePendingRow {
  id: string; doc_type: string; subject_user_id: string; region_code: string;
  reference: string | null; expires_at: string; created_at: string;
  /** DC-03 — armed permits ride the same queue; verify/reject route to /ops/armed/:id/*. */
  armed: boolean;
  /** IS-06 — reviewer context: who submitted + the doc itself (armed rows have no file). */
  provider_name?: string | null;
  file_url?: string | null;
}

export interface DispatchOfferRow {
  offer_id: string; provider_user_id: string; provider_email: string | null;
  status: string; rank: number; distance_km: string | null;
  offered_at: string; expires_at: string; reject_reason: string | null;
}
export interface DispatchMonitor {
  dispatching: Array<{
    booking_id: string; region_code: string; region_label: string; service: string;
    cpo_count: number; armed_required: boolean; dispatch_started_at: string | null;
    offers: DispatchOfferRow[];
  }>;
  recent: Array<{
    booking_id: string; status: string; region_code: string; service: string; cpo_count: number;
    assigned_provider_user_id: string | null; provider_email: string | null;
    dispatch_started_at: string | null; dispatch_settled_at: string | null; updated_at: string;
  }>;
}
export interface FireTestDispatchArgs {
  region_code: string; region_label?: string; pickup_lat: number; pickup_lng: number;
  pickup_address?: string; cpo_count?: number; duration_hours?: number; armed?: boolean; total_eur?: number;
}

// ─── Dispatch Inspector (read-only) ──────────────────────────────────
// Field names mirror the backend JSON exactly. DECIMAL columns (distance_km,
// rating, total_eur/aed) arrive as strings — coerce with Number(...) at render.
export interface DispatchRequestRow {
  booking_id: string; status: string; region_code: string; region_label: string;
  service: string; cpo_count: number; armed_required: boolean; dispatch_mode: string | null;
  dispatch_started_at: string | null; dispatch_settled_at: string | null;
  created_at: string; updated_at: string; assigned_provider_user_id: string | null;
  accepting_agency_name: string | null; accepting_agency_call_sign: string | null;
  offers_count: number; crew_count: number;
  escrow_status: string | null; escrow_gross_credits: number | null;
  mission_status: string | null; mission_short_code: string | null; last_activity_at: string;
}
export interface DispatchRequestDetailOffer {
  offer_id: string; provider_user_id: string;
  agency_name: string | null; agency_call_sign: string | null; agency_email: string | null;
  agency_rating: string | null; agency_region: string | null;
  rank: number; status: string; distance_km: string | null;
  offered_at: string; expires_at: string; responded_at: string | null; reject_reason: string | null;
}
export interface DispatchRequestCrew {
  agent_id: string; agent_name: string | null; agent_rating: string | null;
  call_sign: string; role: string; is_lead: boolean; slot: number; team_idx: number;
  armed: boolean; status: string;
}
export interface DispatchRequestEscrow {
  escrow_id: string; status: string; gross_credits: number; currency: string;
  to_provider_credits: number | null; to_client_credits: number | null; platform_fee_credits: number | null;
  basis: string | null; review_required: boolean;
  held_at: string; completed_at: string | null; release_eligible_at: string | null; settled_at: string | null;
  offer_id: string | null;
}
export interface DispatchRequestMission {
  mission_id: string; status: string; short_code: string;
  started_at: string; created_at: string; pickup_at: string | null; live_at: string | null;
  ended_at: string | null; end_reason: string | null; comms_channel_id: string | null;
}
export interface DispatchTimelineEntry {
  at: string; source: string; label: string;
  actor_role: string | null; actor_call: string | null; metadata: Record<string, unknown>;
}
export interface DispatchRequestDetail {
  booking: {
    booking_id: string; status: string; dispatch_mode: string | null;
    region_code: string; region_label: string; service: string;
    cpo_count: number; armed_required: boolean; requirements: Record<string, unknown> | null;
    client_id: string; assigned_provider_user_id: string | null;
    agency_name: string | null; agency_call_sign: string | null; agency_rating: string | null; agency_email: string | null;
    pickup_address: string | null; pickup_time: string | null; duration_hours: number | null;
    total_eur: string | null; total_aed: string | null;
    dispatch_started_at: string | null; dispatch_settled_at: string | null;
    crew_deadline_at: string | null; arrival_deadline_at: string | null;
    created_at: string; updated_at: string;
  };
  offers: DispatchRequestDetailOffer[];
  escrow: DispatchRequestEscrow | null;
  mission: DispatchRequestMission | null;
  crew: DispatchRequestCrew[];
  timeline: DispatchTimelineEntry[];
}

// ─── SWR hooks (real-time feel via polling) ─────────────────────────

/**
 * E2E-43 — the console's poll cadences, and the ONLY place any of them is
 * written down.
 *
 * Every `/ops/*` request makes `AdminGuard` run
 * `UPDATE admin_users SET last_active_at = NOW()` (admin.guard.ts:92-95), so a
 * hook's `refreshInterval` is a row-locking write rate, multiplied by open
 * tabs × seated operators. Four hooks had bare `2000`/`3000`/`60_000` literals
 * that no longer matched the tier their surface belonged to; a cadence that
 * lives in a hook body is a cadence nobody can audit.
 *
 * Four tiers, and the rule for choosing one:
 *   LIVE  (2 s)  something is happening RIGHT NOW that an operator acts on
 *                within seconds — a dispatch cascade (30 s offer TTL), a
 *                mission on the board, an ops-room message, an SOS.
 *   DASH  (5 s)  operational but not second-critical: lists, detail panels,
 *                queues measured in minutes.
 *   AMBER (10 s) the console-wide "look soon" sweeps in SosAlertBar — paid on
 *                EVERY page, so it is the most expensive cadence per tick.
 *   SLOW  (60 s) config/catalogue surfaces an operator changes by hand.
 *
 * The env overrides stay on the two original knobs so a deployment can still
 * dial the whole console up or down without a rebuild.
 */
// A malformed env override costs the OVERRIDE, not the polling — `pollMs` and
// the full rationale live in lib/pollCadence.ts (kept there so the node test
// project, which cannot import this module, can spec it).
// Exported: the Shell's freshness pill derives its STALE threshold (3× DASH)
// and the usePagedList callers reuse the same cadences.
export const POLL_DASH = pollMs(process.env.NEXT_PUBLIC_DASHBOARD_POLL_MS, 5000);
export const POLL_MSN  = pollMs(process.env.NEXT_PUBLIC_MISSION_POLL_MS, 2000);
/** Console-wide amber sweeps (SosAlertBar). Was a private const in that file. */
export const POLL_AMBER = POLL_DASH * 2;
/** Config/catalogue reads — replaces three bare `60_000` literals. */
export const POLL_SLOW = 60_000;
/**
 * E2E-43 — `useOpsMe` had NO revalidation at all (no interval, and
 * `revalidateOnFocus: false`), so a role change or a deactivation stayed
 * invisible for the life of the tab: the rail kept rendering SUPERVISOR items
 * and every gate below kept answering from a stale role. Session identity is
 * not a live surface, so it revalidates on the slow tier — plus on focus,
 * which is when an operator returning to a parked tab most needs the answer to
 * be current.
 */
export const POLL_ME = POLL_SLOW;

export function useDashboard(region?: string, opts?: SWRConfiguration) {
  return useSWR<DashboardResponse>(
    ['dashboard', region ?? 'all'],
    () => opsApi.dashboard(region),
    {refreshInterval: POLL_DASH, ...opts},
  );
}

/**
 * B-817 — the live feed for the notification centre + popups. Polls at the
 * dashboard cadence and KEEPS polling while the tab is hidden: the browser
 * overlay for a new booking is the whole point of a backgrounded console.
 * One key console-wide (Shell mounts it; the bell and the notifier share it).
 */
export function useActivity(limit = 50, opts?: SWRConfiguration) {
  return useSWR<DashboardResponse['activity']>(
    ['activity', limit],
    () => opsApi.activity(limit),
    {refreshInterval: POLL_DASH, refreshWhenHidden: true, ...opts},
  );
}

// OP-15 — `opts` lets the alert bar mount the SAME key as the page with its
// own interval/hidden-tab policy instead of a duplicate 'alert-*' key.
export function useDispatchMonitor(opts?: SWRConfiguration) {
  return useSWR<DispatchMonitor>('dispatch-monitor', () => opsApi.dispatchMonitor(), {refreshInterval: POLL_MSN, ...opts});
}

export function useDispatchRequest(id: string | null) {
  return useSWR(
    id ? ['dispatch-request', id] : null,
    () => (id ? opsApi.dispatchRequestDetail(id) : Promise.resolve(null)),
    {refreshInterval: POLL_MSN},
  );
}

export function useCompliancePending() {
  return useSWR<CompliancePendingRow[]>('compliance-pending', () => opsApi.compliancePending(), {refreshInterval: POLL_DASH});
}

export function useDeptIncidents(params?: {org_id?: string; status?: string; severity?: string}, opts?: SWRConfiguration) {
  return useSWR<DeptIncidentRow[]>(
    ['dept-incidents', params?.org_id ?? 'all', params?.status ?? 'all', params?.severity ?? 'all'],
    () => opsApi.deptIncidents(params),
    {refreshInterval: POLL_DASH, ...opts},
  );
}

/**
 * IA-03 — `service` is a SERVER filter (comma list), not a client-side one.
 * The Lite and Executive lists are the same component with a different product
 * scope; filtering the loaded window in the browser meant an Executive booking
 * past row 50 was missing from its own list and present in the other one.
 */
export function useBookings(
  q?: {status?: BookingStatus; region?: string; limit?: number; service?: string},
) {
  const {status, region, limit, service} = q ?? {};
  return useSWR<BookingRow[]>(
    ['bookings', status ?? 'all', region ?? 'all', limit ?? 50, service ?? 'all'],
    () => opsApi.listBookings({status, region, limit, service}),
    {refreshInterval: POLL_DASH},
  );
}

export function useBookingDetail(id: string | null) {
  return useSWR(
    id ? ['booking', id] : null,
    () => (id ? opsApi.getBooking(id) : Promise.resolve(null)),
    {refreshInterval: POLL_DASH},
  );
}

export function useJobs(status?: JobStatus) {
  return useSWR<JobRow[]>(
    ['jobs', status ?? 'all'],
    () => opsApi.listJobs(status),
    {refreshInterval: POLL_DASH},
  );
}

// ─── Bravo Secure Pro applications (request-and-approval custom plans) ──────
// NOT the agent job `ApplicationRow` above — this is the client-facing Pro
// plan pipeline (pro_applications tables, /ops/pro-applications surface).

export type ProApplicationStatus =
  | 'PENDING_PROPOSAL' | 'PROPOSAL_CREATED' | 'REVISION_REQUESTED'
  | 'ACCEPTED' | 'ACTIVE' | 'EXPIRED' | 'REJECTED' | 'CANCELLED';

export interface ProHistoryEntry {
  id: string;
  status: ProApplicationStatus;
  intended_use: string;
  submitted_at: string;
  activated_at: string | null;
  current_period_end: string | null;
  total_credits: number | null;
  coverage_start: string | null;
  coverage_end: string | null;
}

export interface ProApplicationRow {
  id: string;
  status: ProApplicationStatus;
  intended_use: string;
  intended_use_note: string | null;
  duration_months: number | null;
  duration_note: string | null;
  start_date: string;
  coverage_area: string;
  cpo_count: number;
  driver_count: number;
  support_staff_count: number;
  gender_preference: string;
  services: string[];
  submitted_at: string;
  updated_at: string;
  client_name: string | null;
  client_email: string;
  client_phone: string | null;
  /** Latest proposal's TOTAL credits for the whole coverage period. */
  total_credits: number | null;
  proposal_version: number | null;
  activated_at?: string | null;
  current_period_end?: string | null;
  /** Last COVERED day (period end − 1 day) — render THIS, not current_period_end. */
  covered_until?: string | null;
}

/**
 * SK-07/IS-03 — a linked member riding (or held off) the owner's plan.
 * B-833 — `relationship` is gone: members are neutrally named, no badge.
 */
export interface ProFamilyMember {
  id: string;
  member_id: string | null;
  member_name: string | null;
  member_email: string | null;
  status: 'pending' | 'active';
  held_until: string | null;
  spend_limit_credits: number | null;
  spent_credits: number;
  invited_at: string;
  accepted_at: string | null;
}

export interface ProProposalRecord {
  id: string;
  application_id: string;
  version: number;
  proposal_number: string;
  valid_until: string;
  coverage_start: string;
  coverage_end: string;
  /** Total BC for the whole coverage period (debited once at activation). */
  total_credits: number;
  included_services: string[];
  assigned_team: Array<{role: string; count: number; label?: string}>;
  terms: string | null;
  created_at: string;
}

export interface ProAppEvent {
  id: string;
  event: string;
  actor: 'client' | 'ops' | 'system';
  message: string | null;
  created_at: string;
}

export interface ProAppMessage {
  id: string;
  sender: 'client' | 'ops';
  body: string;
  created_at: string;
}

export interface ProMissionRecord {
  id: string;
  application_id: string;
  requested_by: string;
  requested_by_name?: string | null;
  mission_dates: string[];
  note: string | null;
  // E2E-07 — CANCELLED is an ops release of a reserved date (the only decision
  // that may unwind an already-SCHEDULED one).
  status: 'REQUESTED' | 'SCHEDULED' | 'DECLINED' | 'COMPLETED' | 'CANCELLED';
  assigned_team: Array<{role: string; count: number; label?: string}>;
  ops_note: string | null;
  created_at: string;
}

export interface ProApplicationDetail {
  application: ProApplicationRow & {
    user_id: string;
    notes: string | null;
    service_other_note: string | null;
    internal_notes: string | null;
    rejected_reason: string | null;
    decided_at: string | null;
    activated_at: string | null;
    current_period_end: string | null;
    /** Last COVERED day (period end - 1 day) - render THIS, not current_period_end. */
    covered_until?: string | null;
    /** IS-02 — resolved identity of the deciding admin (reject / cancel). */
    decided_by?: string | null;
    decided_by_name?: string | null;
    decided_by_email?: string | null;
  };
  proposals: ProProposalRecord[];
  events: ProAppEvent[];
  messages: ProAppMessage[];
  missions: ProMissionRecord[];
  /** The client's other applications — full past + present at a glance. */
  history: ProHistoryEntry[];
  /**
   * SK-07/IS-03 — the applicant's linked members (plan riders).
   * B-835 — capped at 50 rows server-side; `family_total` is the real count, so
   * the card says "Showing n of N" and sends ops to the full roster.
   */
  family?: ProFamilyMember[];
  family_total?: number;
}

export interface CreateProProposalBody {
  total_credits: number;
  valid_until: string;
  coverage_start: string;
  coverage_end: string;
  included_services: string[];
  assigned_team: Array<{role: string; count: number; label?: string}>;
  terms?: string;
  note?: string;
}

export const proAppsApi = {
  list: (status?: string, limit?: number, offset?: number) => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (limit) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    const query = params.toString();
    return fetchJson<{applications: ProApplicationRow[]}>(
      `/ops/pro-applications${query ? `?${query}` : ''}`);
  },
  get: (id: string) =>
    fetchJson<ProApplicationDetail>(`/ops/pro-applications/${id}`),
  createProposal: (id: string, body: CreateProProposalBody) =>
    fetchJson<{application: ProApplicationRow; proposal: ProProposalRecord}>(
      `/ops/pro-applications/${id}/proposal`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string},
    ),
  reject: (id: string, reason: string) =>
    fetchJson<{application: ProApplicationRow}>(
      `/ops/pro-applications/${id}/reject`,
      {method: 'POST', body: JSON.stringify({reason}), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string},
    ),
  cancel: (id: string, note?: string) =>
    fetchJson<{application: ProApplicationRow}>(
      `/ops/pro-applications/${id}/cancel`,
      {method: 'POST', body: JSON.stringify(note?.trim() ? {note: note.trim()} : {}), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string},
    ),
  setInternalNotes: (id: string, notes: string) =>
    fetchJson<{ok: true}>(
      `/ops/pro-applications/${id}/internal-notes`,
      {method: 'PUT', body: JSON.stringify({notes})},
    ),
  sendMessage: (id: string, body: string) =>
    // CA-05 — keyed so a double-send (Enter + click race) collapses server-side.
    fetchJson<{message: ProAppMessage}>(
      `/ops/pro-applications/${id}/messages`,
      {method: 'POST', body: JSON.stringify({body}), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string},
    ),
  scheduleMission: (id: string, missionId: string, body: {assigned_team?: Array<{role: string; count: number; label?: string}>; ops_note?: string}) =>
    fetchJson<{mission: ProMissionRecord}>(
      `/ops/pro-applications/${id}/missions/${missionId}/schedule`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string},
    ),
  declineMission: (id: string, missionId: string, opsNote?: string) =>
    fetchJson<{mission: ProMissionRecord}>(
      `/ops/pro-applications/${id}/missions/${missionId}/decline`,
      {method: 'POST', body: JSON.stringify({ops_note: opsNote}), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string},
    ),
  /**
   * E2E-07 — release a reserved date. DECLINE and CANCEL are different doors on
   * purpose: decline refuses a REQUESTED date that was never granted, cancel
   * unwinds one that WAS (the server's `MISSION_DECIDE_FROM` allows CANCELLED
   * from `['REQUESTED','SCHEDULED']` and DECLINED only from `['REQUESTED']`).
   * Before this, a SCHEDULED date was uncancellable by anyone — client, ops or
   * officer — and the client's calendar kept painting it booked forever.
   */
  cancelMission: (id: string, missionId: string, opsNote?: string) =>
    fetchJson<{mission: ProMissionRecord}>(
      `/ops/pro-applications/${id}/missions/${missionId}/cancel`,
      {method: 'POST', body: JSON.stringify({ops_note: opsNote}), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string},
    ),
};

// ─── Pro management (orgs / CPOs / assignments / mission codes) ─────────────

export interface ProOrgRow {
  id: string;
  display_name: string;
  status: string;
  internal: boolean;
  email: string;
  phone_e164: string | null;
  created_at: string;
  cpo_count: number;
  live_assignments: number;
}

export interface ProPoolCpo {
  id: string;
  display_name: string;
  avatar_url: string | null;
  agent_status: string;
  org_user_id: string | null;
  org_name: string | null;
  member_status: string;
  call_sign: string | null;
  internal: boolean;
  busy_in_window: boolean;
  /** ASSIGNED window on the requesting application covers the whole window —
   *  the member's own dedicated officer (selectable even though "busy"). */
  dedicated?: boolean;
  suspended_now: boolean;
  available: boolean;
  next_assignment_start: string | null;
}

export interface ProAssignmentRecord {
  id: string;
  application_id: string;
  mission_id: string | null;
  cpo_user_id: string;
  org_user_id: string | null;
  starts_on: string;
  ends_on: string;
  status: 'ASSIGNED' | 'COMPLETED' | 'CANCELLED';
  mission_code: string;
  note: string | null;
  created_at: string;
  cpo_name: string | null;
  org_name: string | null;
  member_name: string | null;
}

export interface ProMissionRequestRow {
  id: string;
  application_id: string;
  mission_dates: string[];
  note: string | null;
  status: string;
  created_at: string;
  member_name: string | null;
  requested_by_name: string | null;
}

/**
 * E2E-08 — a SCHEDULED protection date landing today or tomorrow.
 *
 * A SIBLING of `requests`, never merged into it: that list renders every row
 * as "AWAITING OFFICERS" with ASSIGN/DECLINE, so a SCHEDULED row placed there
 * would be mislabelled and would offer actions the server refuses.
 *
 * The fields that carry the whole point of the fix:
 *   `date`              THE date that put this row in the set — the earliest
 *                       mission date falling inside [today, tomorrow]
 *                       (pro-management.service.ts:419-423). Use this, never
 *                       `first_date`, for anything the operator reads: the
 *                       latter is the min over ALL dates and sits in the PAST
 *                       on a multi-date reservation.
 *   `officers_on_date`  ASSIGNED assignments covering THIS ROW'S date. **0 is
 *                       the failure** the founder asked about — a date the
 *                       client's calendar paints as booked with nobody
 *                       actually covering it. This is the alert basis.
 *   `officers_today`    the same count against TODAY. Kept for compatibility;
 *                       it reads 0 on a correctly-staffed tomorrow row, so it
 *                       must not drive an alert (see `reservedDateAlert`).
 *   `activated_at`      when the date's mission actually activated. Null on a
 *                       row that is TODAY is the second failure: the day came
 *                       and nothing started.
 */
export interface ProReservedTodayRow extends ProMissionRequestRow {
  /** The row's own Gulf date (YYYY-MM-DD) — always present. */
  date: string;
  /** Min over ALL mission dates; may be in the past. Prefer `date`. */
  first_date: string | null;
  /** True when `date` is today (Gulf) — else this row lands tomorrow. */
  is_today: boolean;
  /** Cover on THIS row's date. The alert basis. */
  officers_on_date: number;
  /** Cover on today. Compatibility only — see the docblock. */
  officers_today: number;
  activated_at: string | null;
}

export const proMgmtApi = {
  // `reserved_today` is optional in the TYPE so a console running against a
  // server that predates E2E-08 renders the requests queue exactly as before
  // instead of crashing on an undefined array.
  requests: () => fetchJson<{requests: ProMissionRequestRow[]; reserved_today?: ProReservedTodayRow[]}>(`/ops/pro-management/requests`),
  listOrgs: () => fetchJson<{orgs: ProOrgRow[]}>(`/ops/pro-management/orgs`),
  createOrg: (body: {display_name: string; email: string; phone_e164: string; temp_password: string; coverage_country?: string}) =>
    fetchJson<{org: ProOrgRow}>(`/ops/pro-management/orgs`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
  orgDetail: (id: string) =>
    fetchJson<{org: ProOrgRow; roster: Array<{user_id: string; display_name: string; member_role: string; status: string; call_sign: string | null; agent_status: string | null}>; protected_members: Array<{application_id: string; member_name: string; application_status: string}>}>(
      `/ops/pro-management/orgs/${id}`),
  createCpo: (body: {org_user_id: string; display_name: string; email: string; phone_e164: string; temp_password: string; call_sign?: string}) =>
    fetchJson<{member: unknown}>(`/ops/pro-management/cpos`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
  suspendCpo: (userId: string, body: {suspend: boolean; days?: number; reason?: string}) =>
    fetchJson<{ok: true}>(`/ops/pro-management/cpos/${userId}/suspension`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
  pool: (from?: string, to?: string, applicationId?: string) => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (applicationId) p.set('application_id', applicationId);
    const q = p.toString();
    return fetchJson<{cpos: ProPoolCpo[]}>(`/ops/pro-management/pool${q ? `?${q}` : ''}`);
  },
  assignments: (filter?: {application_id?: string; cpo_user_id?: string; status?: string}) => {
    const p = new URLSearchParams();
    if (filter?.application_id) p.set('application_id', filter.application_id);
    if (filter?.cpo_user_id) p.set('cpo_user_id', filter.cpo_user_id);
    if (filter?.status) p.set('status', filter.status);
    const q = p.toString();
    return fetchJson<{assignments: ProAssignmentRecord[]}>(`/ops/pro-management/assignments${q ? `?${q}` : ''}`);
  },
  createAssignment: (body: {application_id: string; cpo_user_id: string; starts_on: string; ends_on: string; note?: string; mission_id?: string}) =>
    fetchJson<{assignment: ProAssignmentRecord}>(`/ops/pro-management/assignments`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
  cancelAssignment: (id: string) =>
    fetchJson<{assignment: ProAssignmentRecord}>(`/ops/pro-management/assignments/${id}/cancel`,
      {method: 'POST', body: '{}', idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
  completeAssignment: (id: string) =>
    fetchJson<{assignment: ProAssignmentRecord}>(`/ops/pro-management/assignments/${id}/complete`,
      {method: 'POST', body: '{}', idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
  scheduleWithCpos: (applicationId: string, missionId: string, body: {cpo_user_ids: string[]; ops_note?: string}) =>
    fetchJson<{mission: unknown; assignments: ProAssignmentRecord[]}>(
      `/ops/pro-management/applications/${applicationId}/missions/${missionId}/schedule-cpos`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
};

// ─── Issue 30 — Pro fleet + resources (vehicle/resource catalogs + assignments) ──
// The separate Pro vehicle fleet (NOT the Lite vehicle_pool) and an assignable
// resources inventory, plus their plan-scoped link tables. Ops sees the full
// catalog INCLUDING a resource's `identifier` (ops-internal serial) — the client
// projection (listTeam) withholds it. Base path /ops/pro-management (Layer 1).

export type ProResourceKind = 'comms' | 'medical' | 'tactical' | 'other';

export interface ProFleetVehicle {
  id: string;
  call_sign: string;
  make_model: string;
  plate: string;
  colour: string | null;
  armored: boolean;
  armor_grade: string | null;
  capacity: number;
  region_code: string | null;
  active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProResource {
  id: string;
  kind: ProResourceKind;
  label: string;
  /** Ops-internal serial — shown to OPS here; withheld from the client projection. */
  identifier: string | null;
  active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** A plan-scoped vehicle assignment. Joined catalog fields are present on the
 *  list row; absent on the assign/release return (which the UI only revalidates). */
export interface ProVehicleAssignment {
  id: string;
  application_id: string;
  vehicle_id: string;
  assignment_id: string | null;
  starts_on: string;
  ends_on: string;
  status: 'ASSIGNED' | 'RELEASED';
  note: string | null;
  created_at: string;
  released_at: string | null;
  call_sign?: string;
  make_model?: string;
  plate?: string;
  colour?: string | null;
  armored?: boolean;
  armor_grade?: string | null;
  capacity?: number;
}

export interface ProResourceAssignment {
  id: string;
  application_id: string;
  resource_id: string;
  assignment_id: string | null;
  qty: number;
  starts_on: string;
  ends_on: string;
  status: 'ASSIGNED' | 'RELEASED';
  note: string | null;
  created_at: string;
  released_at: string | null;
  kind?: ProResourceKind;
  label?: string;
  identifier?: string | null;
}

export interface CreateProFleetVehicleBody {
  call_sign: string;
  make_model: string;
  plate: string;
  colour?: string;
  armored?: boolean;
  armor_grade?: string;
  capacity?: number;
  region_code?: string;
  notes?: string;
}
/** Partial update / retire (active=false). */
export type UpdateProFleetVehicleBody = Partial<CreateProFleetVehicleBody> & {active?: boolean};

export interface CreateProResourceBody {
  kind: ProResourceKind;
  label: string;
  identifier?: string;
  notes?: string;
}
export type UpdateProResourceBody = Partial<CreateProResourceBody> & {active?: boolean};

export interface AssignProVehicleBody {
  vehicle_id: string;
  starts_on: string;
  ends_on: string;
  assignment_id?: string;
  note?: string;
}
export interface AssignProResourceBody {
  resource_id: string;
  qty?: number;
  starts_on: string;
  ends_on: string;
  assignment_id?: string;
  note?: string;
}

export const proFleetApi = {
  // ── Vehicle catalog ──
  listFleet: (includeInactive?: boolean) =>
    fetchJson<{vehicles: ProFleetVehicle[]}>(
      `/ops/pro-management/fleet${includeInactive ? '?include_inactive=true' : ''}`),
  createFleet: (body: CreateProFleetVehicleBody) =>
    fetchJson<{vehicle: ProFleetVehicle}>(`/ops/pro-management/fleet`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
  updateFleet: (id: string, body: UpdateProFleetVehicleBody) =>
    fetchJson<{vehicle: ProFleetVehicle}>(`/ops/pro-management/fleet/${id}`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),

  // ── Resource catalog ──
  listResources: (includeInactive?: boolean) =>
    fetchJson<{resources: ProResource[]}>(
      `/ops/pro-management/resources${includeInactive ? '?include_inactive=true' : ''}`),
  createResource: (body: CreateProResourceBody) =>
    fetchJson<{resource: ProResource}>(`/ops/pro-management/resources`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
  updateResource: (id: string, body: UpdateProResourceBody) =>
    fetchJson<{resource: ProResource}>(`/ops/pro-management/resources/${id}`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),

  // ── Vehicle assignments (plan-scoped) ──
  applicationVehicles: (appId: string) =>
    fetchJson<{assignments: ProVehicleAssignment[]}>(`/ops/pro-management/applications/${appId}/vehicles`),
  assignVehicle: (appId: string, body: AssignProVehicleBody) =>
    fetchJson<{assignment: ProVehicleAssignment}>(`/ops/pro-management/applications/${appId}/vehicles`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
  releaseVehicle: (id: string) =>
    fetchJson<{assignment: ProVehicleAssignment}>(`/ops/pro-management/vehicle-assignments/${id}/release`,
      {method: 'POST', body: '{}', idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),

  // ── Resource assignments (plan-scoped) ──
  applicationResources: (appId: string) =>
    fetchJson<{assignments: ProResourceAssignment[]}>(`/ops/pro-management/applications/${appId}/resources`),
  assignResource: (appId: string, body: AssignProResourceBody) =>
    fetchJson<{assignment: ProResourceAssignment}>(`/ops/pro-management/applications/${appId}/resources`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
  releaseResource: (id: string) =>
    fetchJson<{assignment: ProResourceAssignment}>(`/ops/pro-management/resource-assignments/${id}/release`,
      {method: 'POST', body: '{}', idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
};

export function useProFleet(includeInactive?: boolean) {
  return useSWR<{vehicles: ProFleetVehicle[]}>(
    ['pro-fleet', includeInactive ? 'all' : 'active'],
    () => proFleetApi.listFleet(includeInactive),
    {refreshInterval: POLL_DASH},
  );
}

export function useProResources(includeInactive?: boolean) {
  return useSWR<{resources: ProResource[]}>(
    ['pro-resources', includeInactive ? 'all' : 'active'],
    () => proFleetApi.listResources(includeInactive),
    {refreshInterval: POLL_DASH},
  );
}

export function useProApplicationVehicles(id: string | null) {
  return useSWR<{assignments: ProVehicleAssignment[]}>(
    id ? ['pro-app-vehicles', id] : null,
    () => (id ? proFleetApi.applicationVehicles(id) : Promise.resolve({assignments: []})),
    {refreshInterval: POLL_DASH},
  );
}

export function useProApplicationResources(id: string | null) {
  return useSWR<{assignments: ProResourceAssignment[]}>(
    id ? ['pro-app-resources', id] : null,
    () => (id ? proFleetApi.applicationResources(id) : Promise.resolve({assignments: []})),
    {refreshInterval: POLL_DASH},
  );
}

// ─── Protection sessions monitoring (spec §8) ────────────────────────────────

export type ProtectionStalenessState = 'idle' | 'live' | 'delayed' | 'unavailable';
export interface ProtectionStaleness {
  age_seconds: number | null;
  state: ProtectionStalenessState;
}
export interface ProtectionSessionRow {
  id: string;
  application_id: string;
  status: string;
  customer_id: string;
  cpo_user_id: string;
  requested_at: string;
  activated_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  last_fix_at: string | null;
  sos_active: boolean;
  protect_activated_at?: string | null;
  protection_status?: 'not_activated' | 'active' | 'ended';
  customer_name: string | null;
  cpo_name: string | null;
  staleness: ProtectionStaleness;
}
export interface ProtectionTrailFix {
  lat: number;
  lng: number;
  accuracy_m: number | null;
  recorded_at: string;
  received_at: string;
}
export interface ProtectionNote {
  id: string;
  sender: 'customer' | 'cpo';
  body: string;
  created_at: string;
}
export interface ProtectionSessionDetail {
  session: Record<string, unknown> & {customer_name?: string | null; cpo_name?: string | null; protect_activated_at?: string | null};
  staleness: ProtectionStaleness;
  trail: ProtectionTrailFix[];
  cpo_trail: ProtectionTrailFix[];
  notes: ProtectionNote[];
  server_now: string;
}

export const opsProtectionApi = {
  list: (status?: string) =>
    fetchJson<{sessions: ProtectionSessionRow[]; server_now: string}>(
      `/ops/protection/sessions${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  detail: (id: string) =>
    fetchJson<ProtectionSessionDetail>(`/ops/protection/sessions/${id}`),
  end: (id: string, reason: string) =>
    fetchJson<{session: unknown}>(`/ops/protection/sessions/${id}/end`,
      {method: 'POST', body: JSON.stringify({reason})}),
  transfer: (id: string, newCpoUserId: string) =>
    fetchJson<{session: unknown; previous_cpo_user_id: string}>(`/ops/protection/sessions/${id}/transfer`,
      {method: 'POST', body: JSON.stringify({new_cpo_user_id: newCpoUserId})}),
};

/**
 * E2E-35/E2E-43 — the monitor LIST backs off to the dashboard tier.
 *
 * Every `GET /ops/protection/sessions` runs two lazy sweeps inline
 * (`sweepStaleActivations` / `sweepMaxDuration`, protection.service.ts:517),
 * with no Redis lock and no LIMIT, on top of the AdminGuard write. At the old
 * hardcoded 2 s that was ~30 unlocked sweep pairs a minute per open monitor
 * tab. A roster of live sessions does not change second to second — the
 * per-session DETAIL below is the surface an operator actually watches, and
 * that one keeps the live cadence.
 */
export function useProtectionSessions(status?: string) {
  return useSWR<{sessions: ProtectionSessionRow[]; server_now: string}>(
    ['protection-sessions', status ?? 'live'],
    () => opsProtectionApi.list(status),
    {refreshInterval: POLL_DASH},
  );
}
export function useProtectionSession(id: string | null) {
  return useSWR<ProtectionSessionDetail>(
    id ? ['protection-session', id] : null,
    () => opsProtectionApi.detail(id as string),
    {refreshInterval: POLL_MSN},
  );
}

export interface ProtectionEvent {
  id: string;
  seq: string;
  event_type: string;
  actor_role: string;
  prev_status: string | null;
  new_status: string | null;
  comment: string | null;
  created_at: string;
}
export function useProtectionTimeline(id: string | null) {
  return useSWR<{events: ProtectionEvent[]; mission_status: string; protection_status: string}>(
    id ? ['protection-timeline', id] : null,
    () => fetchJson(`/ops/protection/sessions/${id as string}/timeline`),
    // E2E-43 — an append-only event log; it had its own bare 3000 belonging to
    // no tier. Dashboard cadence, alongside the rest of the session page.
    {refreshInterval: POLL_DASH},
  );
}

/**
 * E2E-43 — dashboard cadence, not mission cadence. A Secure Pro date request
 * is for a date days out; "instant" bought nothing and cost a 2 s guard write
 * per open tab.
 */
export function useProMissionRequests() {
  return useSWR<{requests: ProMissionRequestRow[]; reserved_today?: ProReservedTodayRow[]}>(
    'pro-mission-requests', () => proMgmtApi.requests(), {refreshInterval: POLL_DASH});
}

export function useProOrgs() {
  return useSWR<{orgs: ProOrgRow[]}>('pro-orgs', () => proMgmtApi.listOrgs(), {refreshInterval: POLL_DASH});
}

export function useProPool(from?: string, to?: string) {
  return useSWR<{cpos: ProPoolCpo[]}>(
    ['pro-pool', from ?? 'today', to ?? 'today'],
    () => proMgmtApi.pool(from, to),
    {refreshInterval: POLL_DASH},
  );
}

export function useProAssignments(status?: string) {
  return useSWR<{assignments: ProAssignmentRecord[]}>(
    ['pro-assignments', status ?? 'all'],
    () => proMgmtApi.assignments(status && status !== 'all' ? {status} : undefined),
    {refreshInterval: POLL_DASH},
  );
}

/**
 * E2E-43 — dashboard cadence. CA-11 already backed the DETAIL hook off because
 * every GET runs the server's `sweepExpired` UPDATE; the LIST hook kept 2 s on
 * the "must feel instant" argument, but a Pro application is reviewed over
 * hours and this is one of the pages an operator leaves open all day.
 */
export function useProApplications(status?: string, limit?: number) {
  return useSWR<{applications: ProApplicationRow[]}>(
    ['pro-applications', status ?? 'all', limit ?? 50],
    () => proAppsApi.list(status, limit),
    {refreshInterval: POLL_DASH},
  );
}

export function useProApplication(id: string | null) {
  // CA-11 — dashboard cadence, not mission cadence: every detail GET runs the
  // server's sweepExpired UPDATE, so a 2s poll was write-amplifying per open
  // tab. The 2s cadence stays on the LIST hook where "instant" matters.
  return useSWR<ProApplicationDetail | null>(
    id ? ['pro-application', id] : null,
    () => (id ? proAppsApi.get(id) : Promise.resolve(null)),
    {refreshInterval: POLL_DASH},
  );
}

export interface DepartmentChannelRow {
  /** OP-14 — the server's exact keyset cursor, present on a page's last row. */
  _cursor?: string;
  id: string;
  name: string;
  department: string | null;
  description: string | null;
  /** SK-06 — hierarchy + policy fields the server already returned. */
  channel_type: 'board' | 'department' | 'incident';
  access: 'standard' | 'read_only' | 'restricted';
  parent_id: string | null;
  level: number;
  member_count: number;
  /** True once an admin device has bootstrapped the channel's E2EE group.
   *  Post content is end-to-end encrypted on the relay, not visible to ops. */
  provisioned: boolean;
  created_at: string;
}

export function useJobDetail(id: string | null) {
  return useSWR(
    id ? ['job', id] : null,
    () => (id ? opsApi.getJob(id) : Promise.resolve(null)),
    {refreshInterval: POLL_DASH},
  );
}

export function useMissions(
  f?: {region?: string; status?: 'active' | 'completed'; limit?: number; q?: string; service?: string},
  opts?: SWRConfiguration,
) {
  return useSWR<MissionRow[]>(
    ['missions', f?.region ?? 'all', f?.status ?? 'active', f?.limit ?? 0, f?.q ?? '', f?.service ?? 'all'],
    () => opsApi.listMissions(f?.region, f?.status, f?.limit, f?.q, f?.service),
    {refreshInterval: POLL_MSN, ...opts},
  );
}

export function useMissionDetail(id: string | null) {
  return useSWR(
    id ? ['mission', id] : null,
    () => (id ? opsApi.getMission(id) : Promise.resolve(null)),
    {refreshInterval: POLL_MSN},
  );
}

export function useMissionMessages(id: string | null) {
  return useSWR(
    id ? ['mission-messages', id] : null,
    () => (id ? opsApi.listMissionMessages(id) : Promise.resolve(null)),
    {refreshInterval: POLL_MSN},
  );
}

export function useOpsMe() {
  // OP-18 — a pre-auth page (/login, /accept-invite) has no session: a null
  // key means the layout-level MessengerProvider never fires GET /ops/me
  // there, so the public routes stop producing a guaranteed 401.
  const pathname = usePathname();
  // E2E-43 — see POLL_ME. `revalidateOnFocus` was explicitly off here, which
  // (with no interval) made this the one key in the console that never
  // refreshed; a suspended operator kept their buttons until they hard-reloaded.
  //
  // Polling it, though, made it the one endpoint whose 401 fires a
  // `window.location` redirect on a timer rather than on an operator action.
  // A single token-rotation-race 401 would then discard an open approve modal,
  // a typed reject reason, or a half-written SOS resolution — work the operator
  // cannot get back. So `opsApi.me` sets `noBoot` and the decision lands here:
  // ONE 401 is treated as a blip (SWR keeps the last data, every gate keeps
  // answering from it), TWO IN A ROW is a dead session and boots.
  //
  // This does not keep a revoked operator working: any other ops call —
  // i.e. anything they actually try to do — still boots on its first 401. What
  // it removes is the background timer's ability to do it underneath them.
  const consecutiveSessionLoss = useRef(0);
  return useSWR<OpsMe>(
    isPublicPath(pathname) ? null : 'me',
    async () => {
      try {
        const me = await opsApi.me();
        consecutiveSessionLoss.current = 0;
        return me;
      } catch (e) {
        if (e instanceof ApiError && isSessionLostStatus(e)) {
          consecutiveSessionLoss.current += 1;
          if (consecutiveSessionLoss.current >= 2) bootToLogin();
        } else {
          // A network failure is NOT a session loss — SWR keeps the last data
          // and the operator keeps working offline. Don't let a flaky link
          // accumulate toward a boot.
          consecutiveSessionLoss.current = 0;
        }
        throw e;
      }
    },
    {refreshInterval: POLL_ME, revalidateOnFocus: true},
  );
}

export function useAgentDetail(id: string | null) {
  return useSWR<AgentDetail | null>(
    id ? ['agent', id] : null,
    () => (id ? opsApi.getAgent(id) : Promise.resolve(null)),
    {refreshInterval: POLL_DASH},
  );
}

export function useAgentStats(id: string | null) {
  return useSWR<AgentStats | null>(
    id ? ['agent-stats', id] : null,
    () => (id ? opsApi.agentStats(id) : Promise.resolve(null)),
    // E2E-43 — lifetime counters on a profile page. Nothing here moves in 2 s.
    {refreshInterval: POLL_DASH},
  );
}

// ═══ 2026-07-07 data-coverage audit surfaces (opsDataApi) ════════════
// Read endpoints added by DC-01..DC-20 remediation. Finance / users /
// audit reads are SUPERVISOR+ on the server — pages must handle 403.

export interface DisputeRow {
  id: string; booking_id: string; category: string | null; reason: string | null;
  status: string; to_client_credits: number | null; to_provider_credits: number | null;
  raised_by: string | null; raised_by_name: string | null;
  decided_by: string | null; created_at: string; decided_at: string | null;
  region_code: string; region_label: string; service: string;
  total_eur: string; booking_status: string;
  escrow_status: string | null; gross_credits: number | null; review_required: boolean | null;
  /**
   * B-807 — the HOLD's executed split and terminal markers (prefixed so they
   * cannot be confused with the dispute's own decided to_client/to_provider
   * above). What the resolve dialog reads to say whether a resolution settles
   * money still in escrow or claws back money already paid out.
   */
  hold_basis: string | null;
  hold_to_provider_credits: number | null; hold_to_client_credits: number | null;
  hold_platform_fee_credits: number | null;
  hold_no_show_at: string | null; hold_settled_at: string | null;
}

export interface FinanceTxRow {
  id: string; user_id: string; display_name: string | null; user_role: string | null;
  type: string; status: string; amount_credits: number;
  amount_fiat_cents: number | null; fiat_currency: string | null;
  description: string | null; booking_id: string | null;
  created_at: string; settled_at: string | null;
  /**
   * B-854 (A14) — a family charge lands on the ROOT's wallet, so without the
   * actor this list reads a member's (or, chained, a sub-member's) spend as the
   * root's own. `via_user_id` is what tells a chained charge from a direct one,
   * and `via_name` (the server's `vu.display_name` join) is what makes it
   * legible — an id renders as nothing.
   * Optional: a console ahead of auth-service simply renders no actor.
   */
  actor_user_id?: string | null;
  actor_name?: string | null;
  via_user_id?: string | null;
  via_name?: string | null;
}

export interface EscrowRow {
  id: string; booking_id: string; status: string; basis: string | null;
  review_required: boolean; gross_credits: number;
  /** B-807 — the proof-of-completion check ids that parked this hold (null on a hold never parked). */
  review_reasons: string[] | null;
  /** E2E-06 — set when a PARTIAL came from a lead-declared client no-show (vs a client cancellation). */
  no_show_at: string | null;
  to_provider_credits: number | null; to_client_credits: number | null;
  platform_fee_credits: number | null;
  held_at: string; completed_at: string | null;
  release_eligible_at: string | null; settled_at: string | null;
  client_id: string | null; client_name: string | null;
  provider_user_id: string | null; provider_name: string | null;
  region_code: string; region_label: string; service: string; booking_status: string;
}

export interface PayoutRow {
  id: string; mission_id: string | null; booking_id: string | null;
  agent_user_id: string | null; call_sign: string | null;
  proposed_credits: number | null; paid_credits: number | null;
  deduction_credits: number | null; deduction_reason: string | null;
  decided_by: string | null; decided_at: string | null;
  payee_user_id: string | null; payee_name: string | null;
  mission_short_code: string | null; region_code: string | null; region_label: string | null;
}

export interface InvoiceRow {
  id: string; invoice_number: string; booking_id: string | null; kind: string;
  issued_at: string; currency: string; subtotal_credits: number;
  tax_rate_pct: string | null; tax_credits: number; total_credits: number;
  pdf_url: string | null; region_code: string | null; region_label: string | null;
  service: string | null;
}

export interface PromoRow {
  id: string; code: string; credits: number; max_redemptions: number | null;
  redeemed_count: number; redemptions: number; expires_at: string | null;
  active: boolean; created_at: string;
}

export interface WalletOverview {
  user: {id: string; display_name: string | null; role: string; kyc_status: string; subscription_tier: string};
  balance: {bravo_credits: number; currency: string; updated_at: string | null};
  batches: Array<{id: string; amount_credits: number; consumed_credits: number; issued_at: string; expires_at: string | null; expired_at: string | null}>;
  transactions: FinanceTxRow[];
}

export interface OpsUserRow {
  id: string; display_name: string | null; phone_e164: string | null;
  email: string | null; role: string; subscription_tier: string;
  kyc_status: string; country_code: string | null; home_region: string | null;
  created_at: string; deleted_at: string | null; bravo_credits: number | null;
  /** B-867 — ID / passport on file. OPTIONAL: a console shipped ahead of the API
   *  never receives it; render "—", never "no". */
  identity_document_submitted?: boolean | null;
}

export interface OpsUserDetail {
  user: OpsUserRow & {
    bio: string | null; language: string | null; currency: string | null;
    avatar_url: string | null; pro_active_until: string | null;
    pro_renew_status: string | null; app_lock: boolean | null;
    location_scope: string | null; updated_at: string; password_set_at: string | null;
    suspended_at: string | null; suspended_reason: string | null; suspended_by: string | null;
  };
  devices: Array<{
    id: string; device_id: string; platform: string | null; signal_device_id: number | null;
    created_at: string; last_used_at: string | null; expires_at: string | null; revoked_at: string | null;
    // B-794 — client-reported, all nullable: rows created before the capture
    // shipped, web sessions and iOS (no hardware model without expo-device)
    // legitimately have none. NULL means "not reported", never "unknown model".
    device_model: string | null; device_brand: string | null;
    os_version: string | null; app_version: string | null;
    /** Server-derived: an unrevoked, unexpired session holding a live token. */
    is_live: boolean | null;
  }>;
  /**
   * B-794 — freshest position ops is allowed to see, or WHY there isn't one.
   * Each source re-checks the consent basis that governs its own write path, so
   * narrowing Settings -> Location removes the user from here too.
   *
   * OPTIONAL on purpose: the console and auth-service deploy separately, so a
   * console that ships first talks to an API that has never heard of this
   * field. Callers must go through `resolveUserLocation`.
   */
  location?: OpsUserLocation | null;
  /**
   * B-867 — ID / passport FACTS (status / type / date / back side). The images
   * are NOT here: they come from `getUserIdentityDocument`, which audits every
   * read. OPTIONAL for the same deploy-ordering reason as `location`; readers
   * go through `resolveIdentityDocument`.
   */
  identity_document?: unknown;
  balance: {bravo_credits: number; currency: string; updated_at: string} | null;
  bookings: Array<{id: string; status: string; region_code: string; service: string; pickup_time: string; total_eur: string; created_at: string}>;
  agent: {user_id: string; type: string; status: string; call_sign: string | null; tier: number; on_duty: boolean} | null;
}

// api.ts stays the barrel every feature imports from; the shape and its guard
// live in userLocation.ts so they can be unit-tested without the fetch stack.
export {resolveUserLocation, type OpsUserLocation} from './userLocation';

/** B-867 — one audited read of the submitted ID / passport (SUPERVISOR+). */
export interface OpsIdentityDocumentRead {
  doc_type: 'national_id' | 'passport';
  submitted_at: string;
  view_count: number;
  images: Array<{side: 'front' | 'back'; mime: string; data_url: string}>;
}

/** SK-07/IS-03 — one row of a holder's roster, as the console sees it. */
export interface OpsFamilyRow {
  id: string;
  member_id: string | null;
  member_name: string | null;
  member_email: string | null;
  member_phone: string | null;
  status: 'pending' | 'active';
  held_until: string | null;
  spend_limit_credits: number | null;
  spent_credits: number;
  invited_at: string;
  accepted_at: string | null;
  /**
   * B-854 — chained credit. Optional because the console can deploy ahead of
   * auth-service; the snake_case spellings are the server's own
   * (`toOpsFamilyRow`, ops-data.controller.ts), not a camelCase reading of the
   * app DTO — that invention is the B-832 trap.
   *
   * `funds_sub_members` is the AUTHORITY on whether the chain is on;
   * `funding_request` is the latest ask in whatever state it landed in, which
   * is what makes a DECLINE distinguishable from never having asked.
   */
  funds_sub_members?: boolean;
  /** How many members this member holds of their own — a count, never an entitlement. */
  holds_members_count?: number;
  /** What this member's OWN members have spent against this allocation. */
  spent_by_members?: number;
  funding_request?: {id: string; status: FundingRequestStatus; created_at: string} | null;
}

/** B-854 — `family_funding_requests.status`, swept lazily server-side. */
export type FundingRequestStatus = 'pending' | 'approved' | 'declined' | 'cancelled' | 'expired';

/**
 * B-854 — one "may my members spend your allowance?" ask.
 * Mirrors `FundingRequestDto` (family.service.ts) — camelCase, because the ops
 * route returns the service DTO unmapped.
 */
export interface FamilyFundingRequest {
  id: string;
  familyRowId: string;
  holderId: string;
  holderName: string | null;
  memberId: string;
  memberName: string | null;
  status: FundingRequestStatus;
  reason: string | null;
  decisionReason: string | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
}

/**
 * SK-07/IS-03 — memberships around one user, both directions.
 * B-833 no `relationship`; B-835/B-836 the owner_of side is PAGED.
 */
export interface OpsUserFamily {
  owner_of: OpsFamilyRow[];
  member_of: Array<{
    id: string; holder_id: string; holder_name: string | null; holder_email: string | null;
    status: 'pending' | 'active'; held_until: string | null;
    spend_limit_credits: number | null; spent_credits: number;
    invited_at: string; accepted_at: string | null;
  }>;
  /** Rows matching the caller's `{q, status}` filter — this is what drives paging. */
  total: number;
  /**
   * UNFILTERED per-status counts for the header chips. `active` INCLUDES held
   * rows; `held` is the subset whose `held_until` is still in the future (plan
   * A10) — so the three chips are not a partition and must not be summed.
   */
  counts: {active: number; pending: number; held: number};
  /**
   * The server's own answer to "may ops manage this holder's roster?" —
   * an individual account that is not an admin (plan A2/A8). The card
   * null-returns on THIS, never on an empty list, or ops could never add the
   * first member.
   */
  manageable: boolean;
}

/**
 * B-836 — one member's spend breakdown. Mirrors `FamilyMemberSpendDto`
 * (apps/auth-service/src/family/family.service.ts) field for field; the ops
 * route is a thin wrapper over the same service method.
 */
export interface FamilyMemberSpend {
  member: {id: string; name: string; spent: number; spendLimit: number | null};
  byFeature: Array<{feature: string; spent: number; refunded: number; count: number}>;
  transactions: Array<{
    id: string;
    type: 'payment' | 'refund';
    feature: string | null;
    description: string;
    /** Signed credits — negative = spent from the owner's wallet, positive = refunded back. */
    amount: number;
    bookingId: string | null;
    at: string;
    /**
     * B-854 (A6) — WHO spent it, and the member they spent THROUGH. On a
     * chained charge the actor is the sub-member and `viaUserId` the
     * intermediary, so the sheet reads "C via B" instead of crediting it to B.
     * camelCase because the ops route returns `FamilyMemberSpendDto` unmapped.
     */
    actorUserId?: string | null;
    actorName?: string | null;
    viaUserId?: string | null;
  }>;
}

/** B-836 — one row's outcome from the batch add; `code` is set iff `ok` is false. */
export interface FamilyBatchResult {
  phone: string;
  ok: boolean;
  id?: string;
  code?: string;
}

export interface SosEventRow {
  id: string; mission_id: string | null; booking_id: string | null;
  agent_id: string | null; user_id: string | null;
  agent_call_sign: string | null; reason: string | null; status: string | null;
  lat: number | null; lng: number | null;
  triggered_at: string; acknowledged_at: string | null; acknowledged_by: string | null;
  escalated_at: string | null; escalated_to: string | null;
  resolved_at: string | null; resolved_by: string | null; resolution: string | null;
  mission_short_code: string | null; region_code: string | null; region_label: string | null;
  user_display_name: string | null;
}

export interface VbgMonitoringRow {
  user_id: string; display_name: string | null; phone_e164: string | null;
  home_region: string | null; status: string; interval_min: number;
  enrolled_at: string | null; last_heartbeat_at: string | null;
  missed_count: number; consecutive_fails: number;
  last_zone_state: string | null; escalated_at: string | null;
  lat: number | null; lng: number | null;
  last_lat: number | null; last_lng: number | null; last_telemetry_at: string | null;
  risk_score: number | null; sra_level: string | null; sra_at: string | null;
}

export interface OpsAuditRow {
  id: number; actor_id: string | null; actor_role: string | null;
  actor_call: string | null; action: string;
  subject_type: string | null; subject_id: string | null;
  metadata: Record<string, unknown> | null; ip_address: string | null;
  created_at: string;
}

export interface BroadcastRow {
  id: string; conversation_id: string | null; kind: string;
  title: string | null; body: string | null; severity: string | null;
  subject_type: string | null; subject_id: string | null;
  created_by: string | null; created_at: string;
}

export interface TelemetryPoint {
  agent_id: string; lat: number; lng: number;
  heading_deg: number | null; speed_kph: number | null; accuracy_m: number | null;
  distance_to_dropoff_m: number | null; battery_pct: number | null; recorded_at: string;
}

export interface AnalyticsResponse {
  window_days: number;
  region: string;
  bookings_by_day: Array<{day: string; bookings: number; gmv_bc: string}>;
  bookings_by_status: Array<{status: string; count: number}>;
  dispatch_offers: Array<{status: string; count: number}>;
  missions: {completed: number; aborted: number; avg_duration_s: number; sos_events: number} | null;
  wallet_flows: Array<{type: string; count: number; credits: string}>;
  regions: Array<{region_code: string; bookings: number; gmv_bc: string}>;
  signal_prekeys: {low: number; total_devices: number};
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const opsDataApi = {
  // DC-02 — disputes are finally discoverable (resolve stays on opsApi flow: POST /ops/disputes/:id/resolve).
  listDisputes: (q?: {status?: string; limit?: number}) =>
    fetchJson<DisputeRow[]>(`/ops/disputes${qs({status: q?.status, limit: q?.limit})}`),
  resolveDispute: (id: string, body: {to_client: number; to_provider: number; resolution: string}) =>
    fetchJson<{ok: true}>(`/ops/disputes/${id}/resolve`, {
      method: 'POST', body: JSON.stringify(body),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  // DC-01 — finance ledger reads (SUPERVISOR+).
  financeTransactions: (q?: {user_id?: string; type?: string; status?: string; before?: string; before_id?: string; limit?: number}) =>
    fetchJson<FinanceTxRow[]>(`/ops/finance/transactions${qs({...q})}`),
  financeEscrows: (q?: {status?: string; limit?: number; booking?: string}) =>
    fetchJson<EscrowRow[]>(`/ops/finance/escrows${qs({status: q?.status, limit: q?.limit, booking: q?.booking})}`),
  financePayouts: (limit?: number) =>
    fetchJson<PayoutRow[]>(`/ops/finance/payouts${qs({limit})}`),
  financeInvoices: (limit?: number) =>
    fetchJson<InvoiceRow[]>(`/ops/finance/invoices${qs({limit})}`),
  // OP-16 — bounded server-side (`limit`, default 100 / max 500).
  financePromos: (limit?: number) => fetchJson<PromoRow[]>(`/ops/finance/promos${qs({limit})}`),
  financeWallet: (userId: string) =>
    fetchJson<WalletOverview>(`/ops/finance/wallet/${userId}`),

  // DC-04 — user directory (SUPERVISOR+).
  listUsers: (q?: {q?: string; role?: string; kyc?: string; tier?: string; limit?: number; offset?: number}) =>
    fetchJson<OpsUserRow[]>(`/ops/users${qs({...q})}`),
  getUser: (id: string) => fetchJson<OpsUserDetail>(`/ops/users/${id}`),
  // B-867 — deliberately unkeyed and never polled: each call is its own audit
  // event on the server (identity_document.view), exactly like auditPiiReveal.
  getUserIdentityDocument: (id: string) => fetchJson<OpsIdentityDocumentRead>(`/ops/users/${id}/identity-document`),
  // B-835/B-836 — the roster read is paged + searchable; every mutation below
  // is @RequireRoles('SUPERVISOR','ADMIN') and audited server-side.
  //
  // Why: the Idempotency-Key these POSTs carry is DECORATIVE (plan A16) —
  // ops-data.controller.ts binds no IdempotencyInterceptor. It is sent for
  // consistency with mintProviderInvite; real idempotence comes from
  // `invite_already_pending`, and limit/hold/revoke are idempotent by
  // construction. Do not build a retry on it.
  getUserFamily: (id: string, params?: {q?: string; status?: 'active' | 'pending' | 'held' | 'all'; limit?: number; offset?: number}) =>
    fetchJson<OpsUserFamily>(`/ops/users/${id}/family${qs({
      q: params?.q, status: params?.status, limit: params?.limit, offset: params?.offset,
    })}`),
  inviteFamilyMember: (userId: string, body: {phoneE164: string; spendLimitCredits?: number | null}) =>
    fetchJson<{id: string; status: 'pending'}>(`/ops/users/${userId}/family/members`, {
      method: 'POST', body: JSON.stringify(body),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  inviteFamilyMembersBatch: (userId: string, body: {phones: string[]; spendLimitCredits?: number | null}) =>
    fetchJson<{results: FamilyBatchResult[]; added: number; failed: number}>(`/ops/users/${userId}/family/members/batch`, {
      method: 'POST', body: JSON.stringify(body),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  setFamilyMemberLimit: (userId: string, rowId: string, body: {spendLimitCredits: number | null; reason?: string}) =>
    fetchJson<{ok: true; previousLimit: number | null; newLimit: number | null; spent: number; remaining: number | null}>(
      `/ops/users/${userId}/family/members/${rowId}/limit`, {
        method: 'PATCH', body: JSON.stringify(body),
        idempotencyKey: newIdempotencyKey(),
      } as RequestInit & {idempotencyKey?: string}),
  setFamilyMemberHold: (userId: string, rowId: string, body: {heldUntilIso: string | null}) =>
    fetchJson<{ok: true}>(`/ops/users/${userId}/family/members/${rowId}/hold`, {
      method: 'PATCH', body: JSON.stringify(body),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  revokeFamilyMember: (userId: string, rowId: string) =>
    fetchJson<{ok: true}>(`/ops/users/${userId}/family/members/${rowId}`, {
      method: 'DELETE',
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  familyMemberSpend: (userId: string, rowId: string) =>
    fetchJson<FamilyMemberSpend>(`/ops/users/${userId}/family/members/${rowId}/spend`),
  // ─── B-854 (A11/A14) — chained credit, from the support desk ─────────────
  //
  // Same service methods the root's own app calls, so every eligibility rule
  // (one funding root, no reciprocal row, the member must actually hold
  // members, the row must be ACTIVE) applies identically to an ops flip. The
  // operator's REAL role rides into the audit server-side.
  //
  // Turning it ON is the APPROVE route alone: the PATCH's DTO is
  // `@IsIn([false])`, deliberately, so there is no second weaker door to the
  // same grant. Do not "simplify" these three into one toggle.
  familyFundingRequests: (userId: string) =>
    fetchJson<{requests: FamilyFundingRequest[]}>(`/ops/users/${userId}/family/funding-requests`),
  approveFundMembers: (userId: string, rowId: string, reason?: string) =>
    fetchJson<{ok: true; fundsSubMembers: true; requestId: string | null}>(
      `/ops/users/${userId}/family/members/${rowId}/fund-members/approve`, {
        method: 'POST', body: JSON.stringify({reason}),
        idempotencyKey: newIdempotencyKey(),
      } as RequestInit & {idempotencyKey?: string}),
  declineFundMembers: (userId: string, rowId: string, reason?: string) =>
    fetchJson<{ok: true}>(
      `/ops/users/${userId}/family/members/${rowId}/fund-members/decline`, {
        method: 'POST', body: JSON.stringify({reason}),
        idempotencyKey: newIdempotencyKey(),
      } as RequestInit & {idempotencyKey?: string}),
  /**
   * A10 — ops is the ONLY caller that may force the switch off while chained
   * bookings are still in flight; without `force` the server answers 409
   * `chained_bookings_in_flight {count}`. Forcing cancels those bookings at
   * accept, hours later, which is why it is opt-in per call and audited.
   */
  setFundMembers: (userId: string, rowId: string, enabled: false, force?: boolean) =>
    fetchJson<{ok: true; fundsSubMembers: false}>(
      `/ops/users/${userId}/family/members/${rowId}/fund-members`, {
        method: 'PATCH', body: JSON.stringify({enabled, force: force === true}),
        idempotencyKey: newIdempotencyKey(),
      } as RequestInit & {idempotencyKey?: string}),
  // B-812 — a provider's roster invitation codes (support-desk mint / revoke).
  providerInvites: (userId: string) =>
    fetchJson<{provider: boolean; invites: ProviderInviteRow[]}>(`/ops/users/${userId}/provider-invites`),
  mintProviderInvite: (userId: string, body: {member_role?: 'cpo' | 'manager'; call_sign?: string; expires_in_days?: number}) =>
    fetchJson<{code: string; member_role: string; call_sign: string | null; expires_at: string; created_at: string}>(`/ops/users/${userId}/provider-invites`, {
      method: 'POST', body: JSON.stringify(body),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  revokeProviderInvite: (userId: string, code: string) =>
    fetchJson<{ok: true; code: string}>(`/ops/users/${userId}/provider-invites/${encodeURIComponent(code)}/revoke`, {
      method: 'POST',
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  revokeUserDevice: (userId: string, deviceRowId: string) =>
    fetchJson<{ok: true; device_row_id: string}>(`/ops/users/${userId}/devices/${deviceRowId}/revoke`, {
      method: 'POST',
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  suspendUser: (userId: string, reason: string) =>
    fetchJson<{ok: true; revoked_sessions: number}>(`/ops/users/${userId}/suspend`, {
      method: 'POST', body: JSON.stringify({reason}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  restoreUser: (userId: string) =>
    fetchJson<{ok: true}>(`/ops/users/${userId}/restore`, {
      method: 'POST', idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  eraseUser: (userId: string, reason: string) =>
    fetchJson<{ok: true; revoked_sessions: number}>(`/ops/users/${userId}/erase`, {
      method: 'POST', body: JSON.stringify({reason}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  // M1A/S9 — subscription pricing (charged at charge time: a change here
  // applies to every subscribe/renewal after it) + the user tier editor
  // (comp grants / support fixes; RS-17 NULL expiry = permanent).
  subscriptionPrices: () =>
    fetchJson<{prices: Array<{tier: 'pro' | 'enterprise'; price_bc: number; updated_at: string}>}>(
      `/ops/subscription/prices`),
  setSubscriptionPrice: (tier: 'pro' | 'enterprise', price_bc: number) =>
    fetchJson<{tier: string; price_bc: number}>(`/ops/subscription/prices`, {
      method: 'PATCH', body: JSON.stringify({tier, price_bc}),
    }),
  // Founder 2026-08-26 — every package card's NAME + DESCRIPTION are
  // ops-editable (plan_catalog). Prices stay on the endpoint above: one
  // charge-time source, never a display fork.
  // Founder 2026-08-26 — SERVICE pricing board (transfer/executive rates,
  // factors, add-ons, and the eur_per_bc root). Charged at charge time.
  // Client 2026-09-01 — per-REGION pricing. `region` omitted = GLOBAL, the values
  // every region inherits unless it has deliberately diverged on a key.
  servicePricing: (region?: string) =>
    fetchJson<{region: string; pricing: Array<{
      key: string; value: number; default_value: number; global_value: number;
      inherited: boolean; updated_at: string | null; min: number; max: number;
    }>}>(`/ops/service-pricing${region && region !== 'GLOBAL' ? `?region=${encodeURIComponent(region)}` : ''}`),
  setServicePrice: (key: string, value: number, region?: string) =>
    fetchJson<{key: string; value: number; region: string}>(`/ops/service-pricing`, {
      method: 'PATCH', body: JSON.stringify({key, value, region_code: region}),
    }),
  /** Drop a region's own value for one key so it follows GLOBAL again. */
  clearServicePrice: (key: string, region: string) =>
    fetchJson<{key: string; region: string; inherited: boolean}>(
      `/ops/service-pricing/${encodeURIComponent(key)}?region=${encodeURIComponent(region)}`,
      {method: 'DELETE'}),

  // Client 2026-09-01 — regions are ops-managed rows, so a provider in a new
  // country no longer needs a deploy.
  regions: () =>
    fetchJson<{regions: Array<{
      code: string; name: string; currency: string; utc_offset_hours: number;
      launched: boolean; min_lat: number | null; max_lat: number | null;
      min_lng: number | null; max_lng: number | null;
      updated_at: string | null; seeded: boolean;
    }>}>(`/ops/regions`),
  createRegion: (body: {
    code: string; name: string; currency: string; utc_offset_hours?: number;
    launched?: boolean; min_lat?: number; max_lat?: number; min_lng?: number; max_lng?: number;
  }) => fetchJson<{code: string; ok: true}>(`/ops/regions`, {
    method: 'POST', body: JSON.stringify(body),
  }),
  updateRegion: (code: string, body: Record<string, unknown>) =>
    fetchJson<{code: string; ok: true}>(`/ops/regions/${encodeURIComponent(code)}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }),
  closeRegion: (code: string) =>
    fetchJson<{code: string; launched: boolean}>(`/ops/regions/${encodeURIComponent(code)}`, {
      method: 'DELETE',
    }),
  subscriptionCatalog: () =>
    fetchJson<{catalog: Array<{key: string; display_name: string; description: string; updated_at: string}>}>(
      `/ops/subscription/catalog`),
  setSubscriptionCatalogEntry: (body: {key: string; display_name?: string; description?: string}) =>
    fetchJson<{key: string; display_name: string; description: string}>(`/ops/subscription/catalog`, {
      method: 'PATCH', body: JSON.stringify(body),
    }),
  setUserTier: (userId: string, body: {tier: 'lite' | 'pro' | 'enterprise'; days?: number | null; clear_auto_renew?: boolean}) =>
    fetchJson<{id: string; subscription_tier: string; pro_active_until: string | null}>(
      `/ops/subscription/users/${userId}/tier`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),

  // DC-06 — full SOS log incl. mission-less client/VBG panics.
  listSosEvents: (q?: {status?: 'active' | 'resolved' | 'all'; limit?: number}) =>
    fetchJson<SosEventRow[]>(`/ops/sos${qs({status: q?.status, limit: q?.limit})}`),

  // DC-07 — VBG enrollment health + escalation queue.
  // OP-16 — bounded server-side (`limit`, default 200 / max 500).
  vbgMonitoring: (limit?: number) => fetchJson<VbgMonitoringRow[]>(`/ops/vbg/monitoring${qs({limit})}`),

  // DC-08 — global audit browser (SUPERVISOR+), keyset-paginated via `before`.
  browseAudit: (q?: {actor_id?: string; action?: string; subject_type?: string; from?: string; to?: string; before?: string; limit?: number}, signal?: AbortSignal) =>
    fetchJson<OpsAuditRow[]>(`/ops/audit${qs({...q})}`, {signal}),
  // SK-08 — moved off the shadowed `/ops/audit/org/…` path (see ops-data.controller).
  orgAudit: (orgUserId: string, limit?: number) =>
    fetchJson<Array<{id: string; org_user_id: string; actor_id: string | null; action: string; target_kind: string | null; target_id: string | null; metadata: Record<string, unknown> | null; created_at: string}>>(
      `/ops/audit-log/org/${orgUserId}${qs({limit})}`),

  // DC-16 — post-mission route replay.
  missionTelemetry: (missionId: string) =>
    fetchJson<{mission_id: string; points: TelemetryPoint[]}>(`/ops/missions/${missionId}/telemetry`),

  // DC-20 — broadcast log.
  broadcastsRecent: (q?: {kind?: string; limit?: number}) =>
    fetchJson<BroadcastRow[]>(`/ops/broadcasts/recent${qs({kind: q?.kind, limit: q?.limit})}`),

  // DC-10 — analytics rollups.
  analytics: (q?: {days?: number; region?: string}) =>
    fetchJson<AnalyticsResponse>(`/ops/analytics${qs({days: q?.days, region: q?.region})}`),

  // DC-03 — armed permit decisions (queue rows arrive with armed:true).
  verifyArmed: (id: string) =>
    fetchJson<{ok: true}>(`/ops/armed/${id}/verify`, {
      method: 'POST', idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  rejectArmed: (id: string, reason: string) =>
    fetchJson<{ok: true}>(`/ops/armed/${id}/reject`, {
      method: 'POST', body: JSON.stringify({reason}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
};

export function useDisputes(status?: string) {
  return useSWR<DisputeRow[]>(
    ['disputes', status ?? 'all'],
    () => opsDataApi.listDisputes({status}),
    {refreshInterval: POLL_DASH},
  );
}

export function useFinanceEscrows(status?: string) {
  return useSWR<EscrowRow[]>(
    ['finance-escrows', status ?? 'all'],
    () => opsDataApi.financeEscrows({status}),
    {refreshInterval: POLL_DASH},
  );
}

export function useFinancePayouts() {
  return useSWR<PayoutRow[]>('finance-payouts', () => opsDataApi.financePayouts(), {refreshInterval: POLL_DASH});
}

export function useFinanceInvoices() {
  return useSWR<InvoiceRow[]>('finance-invoices', () => opsDataApi.financeInvoices(), {refreshInterval: POLL_DASH});
}

export function useFinancePromos() {
  return useSWR<PromoRow[]>('finance-promos', () => opsDataApi.financePromos(100), {refreshInterval: POLL_DASH});
}

export function useWalletOverview(userId: string | null) {
  return useSWR<WalletOverview | null>(
    userId ? ['wallet-overview', userId] : null,
    () => (userId ? opsDataApi.financeWallet(userId) : Promise.resolve(null)),
  );
}

export function useOpsUserDetail(id: string | null) {
  return useSWR<OpsUserDetail | null>(
    id ? ['ops-user', id] : null,
    () => (id ? opsDataApi.getUser(id) : Promise.resolve(null)),
    {refreshInterval: POLL_DASH},
  );
}

/** B-812 — one roster invitation code as the console sees it. */
export interface ProviderInviteRow {
  code: string; member_role: string; call_sign: string | null;
  status: 'open' | 'redeemed' | 'revoked' | 'expired';
  expires_at: string | null; created_at: string; redeemed_at: string | null; revoked_at: string | null;
  redeemed_by_name: string | null; created_by_name: string | null;
}

export function useProviderInvites(id: string | null) {
  return useSWR<{provider: boolean; invites: ProviderInviteRow[]} | null>(
    id ? ['ops-provider-invites', id] : null,
    () => (id ? opsDataApi.providerInvites(id) : Promise.resolve(null)),
  );
}

/**
 * B-835/B-836 — the roster read, keyed on its own filter.
 *
 * Every parameter is part of the SWR key: a search or a page turn must fetch
 * rather than re-render the previous page's rows under a new label. The poll
 * stays (a member accepting an invite flips a row to ACTIVE without the
 * operator doing anything), and it re-issues the CURRENT key, so a polled
 * refresh never silently walks the operator back to page 0.
 */
export function useUserFamily(
  id: string | null,
  params?: {q?: string; status?: 'active' | 'pending' | 'held' | 'all'; limit?: number; offset?: number},
) {
  const q = params?.q ?? '';
  const status = params?.status ?? 'all';
  const limit = params?.limit ?? 0;
  const offset = params?.offset ?? 0;
  return useSWR<OpsUserFamily | null>(
    id ? ['ops-user-family', id, q, status, limit, offset] : null,
    () => (id ? opsDataApi.getUserFamily(id, params) : Promise.resolve(null)),
    {refreshInterval: POLL_DASH},
  );
}

/**
 * E2E-42 — `limit` is OPT-IN, and deliberately not defaulted.
 *
 * `GET /ops/sos` accepts `limit` (default 200, max 500) but no `offset`, so
 * `usePagedList` does not apply — the /sos page raises the window instead.
 * The limit is part of the SWR key, and callers that pass nothing keep the
 * key they have always had: SosAlertBar, the Shell badge and the /sos page's
 * first screen all share `['sos-events','active',0]`, which is what lets an
 * ACK on the page silence the console-wide chime optimistically without a
 * round trip. Only an operator who asks for more rows forks onto their own key.
 */
export function useSosEvents(status?: 'active' | 'resolved' | 'all', limit?: number, opts?: SWRConfiguration) {
  return useSWR<SosEventRow[]>(
    ['sos-events', status ?? 'all', limit ?? 0],
    () => opsDataApi.listSosEvents({status, limit}),
    // OC-01 — SWR's default refreshWhenHidden:false made the SOS bar go blind
    // the moment the tab was backgrounded: a control room running the console
    // behind another window detected nothing. The life-safety poll is the one
    // poll that must keep running while hidden.
    //
    // E2E-42 — `keepPreviousData` because LOAD MORE changes the KEY (the limit
    // is part of it). Without this the SOS log blanks the instant it is
    // clicked: rows go undefined, the table and the notice unmount, and the
    // operator is looking at an empty emergency board mid-request. The global
    // SwrProvider sets it, but this hook must not depend on that — a safety
    // surface should carry its own guarantee.
    // B-818 — `opts` lets a domain-scoped console PAUSE this poll (a
    // Communication Admin is refused /ops/sos on every tick otherwise).
    {refreshInterval: POLL_MSN, refreshWhenHidden: true, keepPreviousData: true, ...opts},
  );
}

// OP-15/OP-16 — the /vbg page asks for 200 rows; the console-wide alert bar
// asks for 100 under its own hidden-tab policy. The limit is part of the key,
// so on /vbg itself both windows are fetched (the bar's 100 is the cost paid
// on EVERY page; the page's 200 only while /vbg is open).
export function useVbgMonitoring(limit = 200, opts?: SWRConfiguration) {
  return useSWR<VbgMonitoringRow[]>(
    ['vbg-monitoring', limit],
    () => opsDataApi.vbgMonitoring(limit),
    {refreshInterval: POLL_DASH, ...opts},
  );
}

export function useAuditBrowse(f?: {actor_id?: string; action?: string; subject_type?: string; from?: string; to?: string; limit?: number}) {
  return useSWR<OpsAuditRow[]>(
    ['audit-browse', f?.actor_id ?? '', f?.action ?? '', f?.subject_type ?? '', f?.from ?? '', f?.to ?? '', f?.limit ?? 100],
    () => opsDataApi.browseAudit(f),
    {refreshInterval: POLL_DASH},
  );
}

export function useBroadcastsRecent(kind?: string) {
  return useSWR<BroadcastRow[]>(
    ['broadcasts-recent', kind ?? 'all'],
    () => opsDataApi.broadcastsRecent({kind}),
    {refreshInterval: POLL_DASH},
  );
}

export function useAnalytics(days?: number, region?: string) {
  return useSWR<AnalyticsResponse>(
    ['analytics', days ?? 30, region ?? 'all'],
    () => opsDataApi.analytics({days, region}),
    {refreshInterval: POLL_SLOW},
  );
}

export function useMissionTelemetry(missionId: string | null) {
  return useSWR<{mission_id: string; points: TelemetryPoint[]} | null>(
    missionId ? ['mission-telemetry', missionId] : null,
    () => (missionId ? opsDataApi.missionTelemetry(missionId) : Promise.resolve(null)),
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   2026-09-03 IA restructure — the surfaces the re-sectioned console needs.
   IA-06 review-hold exit · IA-07 App Configuration · IA-08 provider agencies ·
   SK-06(b) enterprise queue.
   ═══════════════════════════════════════════════════════════════════════════ */

export interface ConfigStatusRow {
  key: string;
  rows: number;
  last_changed_at: string | null;
  last_changed_by: string | null;
}

export interface AgencyRow {
  id: string;
  display_name: string;
  email: string | null;
  phone_e164: string | null;
  home_region: string | null;
  created_at: string;
  suspended_at: string | null;
  cpo_count: number;
  docs_valid: number;
  docs_expiring: number;
  docs_problem: number;
  offers_30d: number;
  accepted_30d: number;
  no_show_30d: number;
}

export interface AgencyDetail {
  agency: {
    id: string; display_name: string; email: string | null; phone_e164: string | null;
    home_region: string | null; country_code: string | null; created_at: string;
    suspended_at: string | null; suspended_reason: string | null;
  };
  credentials: Array<{
    id: string; kind: string; region_code: string; reference: string | null;
    issued_at: string | null; expires_at: string; verified: boolean; created_at: string;
  }>;
  armed: Array<{
    id: string; cpo_user_id: string; cpo_name: string | null; region_code: string;
    permit_ref: string | null; expires_at: string | null; authorized: boolean; created_at: string;
  }>;
  roster: Array<{
    user_id: string; display_name: string | null; phone_e164: string | null;
    status: string; created_at: string; agent_status: string | null; on_duty: boolean | null;
  }>;
  offers: Array<{
    id: string; booking_id: string; rank: number; distance_km: string | null; status: string;
    offered_at: string; responded_at: string | null; reject_reason: string | null;
    booking_status: string | null; region_label: string | null; pickup_time: string | null;
    service: string | null;
  }>;
}

export interface JoinRequestRow {
  id: string; status: string; created_at: string; decided_at: string | null;
  applicant_name: string | null; applicant_email: string | null; applicant_phone: string | null;
  message: string | null; workspace_name: string | null; workspace_id: string | null;
  referrer_name: string | null; team_name: string | null; decided_by_name: string | null;
}

export interface TierGrantRow {
  id: string; display_name: string; email: string | null; subscription_tier: string;
  pro_active_until: string | null; pro_renew_status: string | null; created_at: string;
  granted_at: string | null; granted_by: string | null; granted_from: string | null;
}

export const opsSectionsApi = {
  /**
   * IA-06 — the MON-2 review-hold exit. The endpoint has existed since the
   * proof-of-completion gate shipped and is the ONLY operator exit for a HELD +
   * review_required escrow, but no client method or button ever reached it: the
   * escrow tab rendered a "REVIEW" badge and stopped there.
   * DTO verified server-side: {action: 'release' | 'refund', reason}.
   * SUPERVISOR+ and idempotency-keyed, exactly like approve/complete.
   */
  resolveReviewHold: (bookingId: string, body: {action: 'release' | 'refund'; reason: string}) =>
    fetchJson<{ok: true}>(`/ops/bookings/${bookingId}/resolve-review`, {
      method: 'POST', body: JSON.stringify(body),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  configStatus: () =>
    fetchJson<{configs: ConfigStatusRow[]; server_now: string}>('/ops/config/status'),

  listAgencies: (q?: {q?: string; limit?: number}) =>
    fetchJson<AgencyRow[]>(`/ops/agencies${qs({q: q?.q, limit: q?.limit})}`),
  getAgency: (id: string) => fetchJson<AgencyDetail>(`/ops/agencies/${id}`),

  enterpriseSummary: () =>
    fetchJson<{workspaces: number; join_pending: number; incidents_open: number; incidents_critical_24h: number}>(
      '/ops/enterprise/summary'),
  joinRequests: (status?: string) =>
    fetchJson<JoinRequestRow[]>(`/ops/enterprise/join-requests${qs({status})}`),
  listEnterpriseOrgs: (q?: {q?: string; limit?: number}) =>
    fetchJson<EnterpriseOrgRow[]>(`/ops/enterprise/orgs${qs({q: q?.q, limit: q?.limit})}`),
  getEnterpriseOrg: (id: string) => fetchJson<EnterpriseOrgDetail>(`/ops/enterprise/orgs/${id}`),

  tierGrants: () => fetchJson<{grants: TierGrantRow[]}>('/ops/subscription/grants'),
};

/* ── Enterprise organisations (departments list + detail) ───────────── */

export interface EnterpriseOrgRow {
  id: string;
  display_name: string;
  workspace_name: string | null;
  email: string | null;
  phone_e164: string | null;
  home_region: string | null;
  country_code: string | null;
  subscription_tier: 'lite' | 'pro' | 'enterprise';
  is_workspace: boolean;
  is_agency: boolean;
  created_at: string;
  suspended_at: string | null;
  channels: number;
  channels_provisioned: number;
  departments: number;
  members: number;
  incidents_open: number;
  join_pending: number;
  last_activity_at: string | null;
}

export interface EnterpriseOrgChannel {
  id: string;
  name: string;
  description: string | null;
  department: string | null;
  channel_type: 'board' | 'department' | 'incident';
  access: 'standard' | 'read_only' | 'restricted';
  parent_id: string | null;
  level: number;
  post_mode: 'open' | 'read_only' | 'announcement' | 'admin_only';
  is_broadcast: boolean;
  is_lateral: boolean;
  created_at: string;
  name_changed_at: string | null;
  created_by_name: string | null;
  provisioned: boolean;
  member_count: number;
  admin_count: number;
  last_read_at: string | null;
}

export interface EnterpriseOrgMember {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  member_role: 'cpo' | 'manager' | 'employee';
  status: 'invited' | 'active' | 'suspended' | 'removed';
  department: string | null;
  call_sign: string | null;
  created_at: string;
  suspended_until: string | null;
  agent_status: string | null;
  on_duty: boolean | null;
}

export interface EnterpriseOrgIncident {
  id: string;
  ref: string | null;
  category: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'submitted' | 'received' | 'under_review' | 'action_assigned' | 'resolved' | 'closed';
  department: string | null;
  created_at: string;
  updated_at: string;
  submitter_name: string | null;
  assigned_to_name: string | null;
}

export interface EnterpriseOrgJoinRequest {
  id: string;
  status: 'pending' | 'approved' | 'declined';
  applicant_name: string | null;
  applicant_email: string | null;
  applicant_phone: string | null;
  created_at: string;
  decided_at: string | null;
  team_name: string | null;
  referrer_name: string | null;
  decided_by_name: string | null;
}

export interface EnterpriseOrgActivity {
  id: string;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  actor_name: string | null;
}

export interface EnterpriseOrgDetail {
  org: EnterpriseOrgRow & {
    role: string;
    level_names: string[] | null;
    hidden_modules: string[] | null;
    settings_updated_at: string | null;
    agency_status: string | null;
    suspended_reason: string | null;
    channels_archived: number;
  };
  channels: EnterpriseOrgChannel[];
  members: EnterpriseOrgMember[];
  incidents: EnterpriseOrgIncident[];
  join_requests: EnterpriseOrgJoinRequest[];
  invites: {total: number; active: number; accepted: number; revoked: number};
  attendance_30d: {
    counts: Record<string, number>;
    total: number;
    pending_review: number;
    shifts_upcoming: number;
    sessions_open: number;
  };
  activity: EnterpriseOrgActivity[];
}

export function useEnterpriseOrgs(q?: string) {
  return useSWR<EnterpriseOrgRow[]>(
    ['enterprise-orgs', q ?? ''],
    () => opsSectionsApi.listEnterpriseOrgs({q}),
    {refreshInterval: POLL_DASH, keepPreviousData: true},
  );
}

export function useEnterpriseOrg(id: string | null) {
  return useSWR<EnterpriseOrgDetail | null>(
    id ? ['enterprise-org', id] : null,
    () => (id ? opsSectionsApi.getEnterpriseOrg(id) : Promise.resolve(null)),
    {refreshInterval: POLL_DASH},
  );
}

export function useConfigStatus() {
  return useSWR(['config-status'], () => opsSectionsApi.configStatus(), {refreshInterval: POLL_SLOW});
}

export function useAgencies(q?: string) {
  return useSWR<AgencyRow[]>(['agencies', q ?? ''], () => opsSectionsApi.listAgencies({q}), {
    refreshInterval: POLL_DASH,
  });
}

export function useAgency(id: string | null) {
  return useSWR<AgencyDetail | null>(
    id ? ['agency', id] : null,
    () => (id ? opsSectionsApi.getAgency(id) : Promise.resolve(null)),
  );
}

export function useEnterpriseSummary() {
  return useSWR(['enterprise-summary'], () => opsSectionsApi.enterpriseSummary(), {
    refreshInterval: POLL_DASH,
  });
}

export function useJoinRequests(status?: string) {
  return useSWR<JoinRequestRow[]>(
    ['enterprise-join-requests', status ?? 'pending'],
    () => opsSectionsApi.joinRequests(status),
    {refreshInterval: POLL_DASH},
  );
}

export function useTierGrants() {
  return useSWR(['tier-grants'], () => opsSectionsApi.tierGrants(), {refreshInterval: POLL_SLOW});
}

/** IA-06 — the escrow hold(s) for ONE booking, for the detail Money panel. */
export function useBookingEscrow(bookingId: string | null) {
  return useSWR<EscrowRow[]>(
    bookingId ? ['booking-escrow', bookingId] : null,
    () => (bookingId ? opsDataApi.financeEscrows({booking: bookingId}) : Promise.resolve([])),
    {refreshInterval: POLL_DASH},
  );
}
