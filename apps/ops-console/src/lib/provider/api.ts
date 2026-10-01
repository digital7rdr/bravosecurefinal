/**
 * Service Provider Console — API client.
 *
 * Same auth-service as the ops console, different session: the provider
 * console's cookies are `bravo_pv_token` / `bravo_pv_csrf` / `bravo_pv_refresh`.
 * The server picks them from the request Origin (session-cookies.ts in the
 * auth-service), so an HQ operator and a provider can be signed in to their
 * own consoles in the same browser without one session replacing the other.
 *
 * Every /org/* and /dispatch/* call carries `X-Org-Context: <agency id>` for
 * the agency chosen in the top bar. The server only uses it to pick among the
 * caller's own memberships; it can never widen access.
 */

import useSWR, {type SWRConfiguration} from 'swr';
import {deviceId, ApiError, type LoginStartResult} from '@/lib/api';
import {pvRoutes} from '@/lib/provider/routes';

export {ApiError};

const ENV_BASE = process.env.NEXT_PUBLIC_API_BASE_URL;
const BASE = ENV_BASE ?? 'http://localhost:3001';

export const PV_CSRF_COOKIE = 'bravo_pv_csrf';
export const PV_EXPIRES_KEY = 'bravo_pv_access_expires_at';
export const PV_IDLE_KEY = 'bravo_pv_idle_logout';
const ORG_KEY = 'bravo_pv_org';

/* ── Selected agency ─────────────────────────────────────────────────── */

let currentOrg: string | null = null;

export function setCurrentOrg(id: string | null): void {
  currentOrg = id;
  try {
    if (id) window.localStorage.setItem(ORG_KEY, id);
    else window.localStorage.removeItem(ORG_KEY);
  } catch { /* storage blocked: the choice lasts for this tab only */ }
}

export function rememberedOrg(): string | null {
  try { return window.localStorage.getItem(ORG_KEY); } catch { return null; }
}

/* ── Transport ───────────────────────────────────────────────────────── */

export function readPvCsrf(): string | null {
  if (typeof document === 'undefined') return null;
  const m = /(?:^|;\s*)bravo_pv_csrf=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Expire the JS-readable csrf cookie on every domain it may have been set on. */
export function expirePvCsrf(): void {
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
    document.cookie = `${PV_CSRF_COOKIE}=; expires=${past}; max-age=0; path=/` + (d ? `; domain=${d}` : '');
  }
}

function bootToLogin(): void {
  if (typeof window === 'undefined') return;
  expirePvCsrf();
  window.sessionStorage.removeItem(PV_EXPIRES_KEY);
  if (!window.location.pathname.startsWith(pvRoutes.login)) window.location.assign(pvRoutes.login);
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

type Init = RequestInit & {idempotencyKey?: string; noBoot?: boolean};

async function pv<T>(path: string, init?: Init): Promise<T> {
  const {idempotencyKey, noBoot, ...rest} = init ?? {};
  const csrf = readPvCsrf();
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    credentials: 'include',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(csrf ? {'X-CSRF-Token': csrf} : {}),
      ...(currentOrg ? {'X-Org-Context': currentOrg} : {}),
      ...(idempotencyKey ? {'Idempotency-Key': idempotencyKey} : {}),
      ...(rest.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? safeParse(text) : null;
  if (!res.ok) {
    const code = (body as {code?: string; message?: string} | null)?.code;
    const lost = res.status === 401 || (res.status === 403 && (code === 'session_expired' || code === 'token_revoked'));
    if (lost && !noBoot) bootToLogin();
    const msg = (body as {message?: string | string[]} | null)?.message;
    throw new ApiError(res.status, body, Array.isArray(msg) ? msg[0] : msg ?? res.statusText);
  }
  return body as T;
}

const get = <T>(path: string) => pv<T>(path);
const send = <T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, idempotencyKey?: string) =>
  pv<T>(path, {method, body: body === undefined ? undefined : JSON.stringify(body), idempotencyKey});

/** A fresh key per user action; the server collapses retries of the same one. */
export function actionKey(prefix: string): string {
  const r = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random()).slice(2);
  return `${prefix}-${r}`;
}

/* ── Types (mirror the auth-service responses) ───────────────────────── */

export type ModuleKey =
  | 'jobs' | 'portal' | 'compliance' | 'roster' | 'orgChart' | 'dept' | 'earn'
  | 'msg' | 'intel' | 'region';

export interface ConsoleOrg {
  org_id: string;
  name: string;
  role: 'owner' | 'manager';
  modules: ModuleKey[];
  department: string | null;
}
export interface ConsoleContext {
  user: {id: string; display_name: string | null};
  orgs: ConsoleOrg[];
}

export interface OrgSummary {
  guards_total: number;
  guards_free: number;
  guards_on_duty: number;
  active_missions: number;
  org_rating: number | null;
  org_jobs_total: number;
}

export interface CrewSlot {user_id: string; call_sign: string | null; role: string; is_lead: boolean}

export interface OrgMission {
  booking_id: string;
  booking_status: string;
  service: string;
  region_label: string;
  pickup_time: string;
  pickup_address: string;
  pickup_lat: string | null;
  pickup_lng: string | null;
  dropoff_address: string | null;
  dropoff_lat: string | null;
  dropoff_lng: string | null;
  cpo_count: number;
  armed_required: boolean;
  task_type?: string | null;
  duration_hours?: number;
  has_transport?: boolean;
  mission_id: string | null;
  mission_status: string | null;
  short_code: string | null;
  dispatched_at?: string | null;
  live_at?: string | null;
  crew: CrewSlot[];
}

export interface MissionBoard {needs_crew: OrgMission[]; active: OrgMission[]; recent: OrgMission[]}

export interface CoarseOffer {
  offer_id: string;
  expires_at: string;
  region_code: string;
  region_label: string;
  service: string;
  pickup_time: string;
  duration_hours: number;
  distance_bucket: string;
  cpo_count: number;
  vehicle_count: number;
  price: {eur: string; aed: string};
  requirements: {armed: boolean; driver_only: boolean; add_ons: string[]; flags: Record<string, boolean>};
  task_type?: string | null;
  has_transport?: boolean;
  source?: string | null;
  distance_km?: number | null;
  offered_at?: string;
  booking_mode?: 'now' | 'later' | null;
}

export interface RosterMember {
  member_user_id: string;
  display_name: string | null;
  email: string | null;
  call_sign: string | null;
  member_role: 'cpo' | 'manager' | 'employee';
  status: 'invited' | 'active' | 'suspended' | 'removed';
  department: string | null;
  agent_status: string | null;
  missions_completed: number;
  created_at: string;
  on_duty: boolean;
  on_mission: boolean;
  armed_authorized: boolean;
  avatar_url: string | null;
  suspended_from: string | null;
  suspended_until: string | null;
  suspend_reason: string | null;
}

export interface ProviderInvite {
  code: string;
  member_role: 'cpo' | 'manager' | string;
  call_sign: string | null;
  status: 'open' | 'redeemed' | 'revoked' | 'expired';
  expires_at: string | null;
  created_at: string;
  redeemed_at: string | null;
  revoked_at: string | null;
  redeemed_by_name: string | null;
}

export interface OrgManager {
  user_id: string; display_name: string | null; email: string | null;
  avatar_url: string | null; call_sign: string | null; status: string;
  permitted_modules: string[];
}

export interface OrgEarnings {
  total_missions: number;
  total_gross_credits: number;
  total_fee_credits: number;
  total_net_credits: number;
  pending_credits: number;
  rows: Array<{
    booking_id: string; short_code: string | null; service: string;
    region_label: string; ended_at: string | null; hold_status: string;
    gross_credits: number; platform_fee_credits: number | null; to_provider_credits: number | null;
  }>;
}

export interface MissionLive {
  mission: {
    short_code: string; status: string; booking_id: string;
    route_polyline: string | null;
    current_lat: number | null; current_lng: number | null;
    client_lat: number | null; client_lng: number | null;
    client_recorded_at: string | null;
    live_at?: string | null;
  } | null;
  waypoints: Array<{seq: number; tag: string; event: string; state: string; settled_at: string | null}>;
  booking: {
    pickup_address: string; pickup_lat: string | null; pickup_lng: string | null;
    dropoff_address: string | null; dropoff_lat: string | null; dropoff_lng: string | null;
    booking_status: string; service?: string; task_type?: string | null; duration_hours?: number;
  } | null;
}

export interface MissionEscrow {
  status: string; basis: string | null; currency: string | null;
  gross_credits: number; to_provider_credits: number | null; platform_fee_credits: number | null;
}

/* ── Endpoints ───────────────────────────────────────────────────────── */

export const pvAuth = {
  loginStart: (phoneE164: string, password: string) =>
    send<LoginStartResult>('POST', '/auth/login', {phoneE164, password}),
  loginVerify: (userId: string, code: string, challengeId?: string | null) =>
    send<{user: {id: string; role: string}; accessToken: string; refreshToken: string; expiresIn: number}>(
      'POST', '/auth/verify',
      {userId, code, deviceId: deviceId(), platform: 'web', ...(challengeId ? {challengeId} : {})}),
  sessionRefresh: () => send<{expiresIn: number}>('POST', '/auth/session/refresh'),
  context: () => pv<ConsoleContext>('/org/console/context', {noBoot: true}),
  /** Revoke this browser's session, then drop every client-side signal. */
  async signOut(): Promise<void> {
    try {
      await pv('/auth/session', {method: 'DELETE', body: JSON.stringify({deviceId: deviceId(), allDevices: false}), noBoot: true});
    } catch { /* best effort: the cookies below go regardless */ }
    expirePvCsrf();
    try { window.sessionStorage.removeItem(PV_EXPIRES_KEY); } catch { /* ignore */ }
  },
};

export const pvApi = {
  summary:        () => get<OrgSummary>('/org/summary'),
  missions:       () => get<MissionBoard>('/org/missions'),
  completed:      () => get<{completed_count: number; missions: OrgMission[]}>('/org/missions/completed'),
  missionLive:    (missionId: string) => get<MissionLive>(`/org/missions/${missionId}/live`),
  escrow:         (bookingId: string) => get<MissionEscrow | null>(`/org/bookings/${bookingId}/escrow`),
  assignCrew:     (bookingId: string, body: {cpo_user_ids: string[]; lead_user_id: string}) =>
    send<{ok: true; mission_id: string; short_code: string}>('POST', `/org/bookings/${bookingId}/crew`, body, `crew-${bookingId}`),
  dispatch:       (missionId: string) =>
    send<{ok: true; already: boolean; status: string}>('POST', `/org/missions/${missionId}/dispatch`, undefined, `orgdispatch-${missionId}`),
  complete:       (missionId: string) =>
    send<{ok: true; completed: boolean}>('POST', `/org/missions/${missionId}/complete`, undefined, `orgcomplete-${missionId}`),
  withdraw:       (bookingId: string) =>
    send<{booking_id: string; status: string}>('POST', `/dispatch/bookings/${bookingId}/withdraw`, {reason: 'agency_withdraw'}, actionKey(`withdraw-bk-${bookingId}`)),

  currentOffer:   () => get<CoarseOffer | null>('/dispatch/offers/current'),
  acceptOffer:    (offerId: string) =>
    send<{offer_id: string; booking_id: string; status: 'CONFIRMED'}>('POST', `/dispatch/offers/${offerId}/accept`, undefined, `accept-${offerId}`),
  rejectOffer:    (offerId: string, reason?: string) =>
    send<{ok: true}>('POST', `/dispatch/offers/${offerId}/reject`, reason ? {reason} : {}),

  roster:         () => get<RosterMember[]>('/org/cpos'),
  createCpo:      (dto: {display_name: string; email: string; phone_e164: string; temp_password: string; call_sign?: string; member_role?: 'cpo' | 'manager'}) =>
    send<RosterMember>('POST', '/org/cpos', dto),
  setStatus:      (id: string, status: 'active' | 'suspended' | 'removed', extra?: {suspended_until?: string | null; suspend_reason?: string}) =>
    send<{ok: true}>('PATCH', `/org/cpos/${id}/status`, {status, ...extra}),
  setRole:        (id: string, member_role: 'cpo' | 'manager') =>
    send<{ok: true; member_role: string}>('PATCH', `/org/cpos/${id}/role`, {member_role}),
  invites:        () => get<ProviderInvite[]>('/org/invites'),
  mintInvite:     (dto: {member_role?: 'cpo' | 'manager'; call_sign?: string; expires_in_days?: number}) =>
    send<{code: string; expires_at: string}>('POST', '/org/invites', dto),
  revokeInvite:   (code: string) => send<{ok: true}>('POST', `/org/invites/${encodeURIComponent(code)}/revoke`, {}),
  managers:       () => get<OrgManager[]>('/org/managers'),
  setPermissions: (id: string, modules: string[]) =>
    send<{ok: true; permitted_modules: string[]}>('PATCH', `/org/managers/${id}/permissions`, {modules}),

  earnings:       () => get<OrgEarnings>('/org/earnings'),
};

/* ── SWR hooks ───────────────────────────────────────────────────────── */

const POLL = 15_000;

/** Keys include the agency so switching agency never shows the previous one's data. */
function useOrgSWR<T>(name: string | null, org: string | null, fetcher: () => Promise<T>, cfg?: SWRConfiguration<T>) {
  return useSWR<T>(name && org ? ['pv', org, name] : null, fetcher, {refreshInterval: POLL, ...cfg});
}

export const usePvSummary  = (org: string | null) => useOrgSWR('summary', org, pvApi.summary);
export const usePvMissions = (org: string | null, on = true) => useOrgSWR(on ? 'missions' : null, org, pvApi.missions);
export const usePvCompleted = (org: string | null, on = true) => useOrgSWR(on ? 'completed' : null, org, pvApi.completed, {refreshInterval: 60_000});
export const usePvOffer    = (org: string | null, on = true) => useOrgSWR(on ? 'offer' : null, org, pvApi.currentOffer, {refreshInterval: 8_000});
export const usePvRoster   = (org: string | null, on = true) => useOrgSWR(on ? 'roster' : null, org, pvApi.roster);
export const usePvInvites  = (org: string | null, on = true) => useOrgSWR(on ? 'invites' : null, org, pvApi.invites, {refreshInterval: 60_000});
export const usePvManagers = (org: string | null, on = true) => useOrgSWR(on ? 'managers' : null, org, pvApi.managers, {refreshInterval: 60_000});
export const usePvEarnings = (org: string | null, on = true) => useOrgSWR(on ? 'earnings' : null, org, pvApi.earnings, {refreshInterval: 60_000});
export const usePvLive     = (org: string | null, missionId: string | null) =>
  useOrgSWR(missionId ? `live:${missionId}` : null, org, () => pvApi.missionLive(missionId as string), {refreshInterval: 5_000});
