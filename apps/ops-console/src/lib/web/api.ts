/**
 * Bravo Web App — API client (web.bravosecure.cloud, 2026-10-03).
 *
 * Messenger and online booking in the browser for every Bravo account. Same
 * auth-service and the same routes as the mobile app; the session is the web
 * app's own cookie set (`bravo_web_token` / `bravo_web_csrf` /
 * `bravo_web_refresh`), chosen by the server from the request Origin.
 *
 * Every mutating call echoes the `bravo_web_csrf` cookie as X-CSRF-Token: the
 * server refuses a web cookie session without it (JwtAuthGuard).
 */

import useSWR, {type SWRConfiguration} from 'swr';
import {deviceId, ApiError, type LoginStartResult} from '@/lib/api';
import {webRoutes} from '@/lib/web/routes';

export {ApiError};

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

export const WEB_CSRF_COOKIE = 'bravo_web_csrf';
export const WEB_EXPIRES_KEY = 'bravo_web_access_expires_at';
export const WEB_IDLE_KEY = 'bravo_web_idle_logout';
export const WEB_PW_CHANGED_KEY = 'bravo_web_password_changed';

/* ── Transport ───────────────────────────────────────────────────────── */

export function readWebCsrf(): string | null {
  if (typeof document === 'undefined') return null;
  const m = /(?:^|;\s*)bravo_web_csrf=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Expire the JS-readable csrf cookie on every domain it may have been set on. */
export function expireWebCsrf(): void {
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
    document.cookie = `${WEB_CSRF_COOKIE}=; expires=${past}; max-age=0; path=/` + (d ? `; domain=${d}` : '');
  }
}

function bootToLogin(): void {
  if (typeof window === 'undefined') return;
  expireWebCsrf();
  window.sessionStorage.removeItem(WEB_EXPIRES_KEY);
  if (!window.location.pathname.startsWith(webRoutes.login)) window.location.assign(webRoutes.login);
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

type Init = RequestInit & {idempotencyKey?: string; noBoot?: boolean};

async function web<T>(path: string, init?: Init): Promise<T> {
  const {idempotencyKey, noBoot, ...rest} = init ?? {};
  const csrf = readWebCsrf();
  const isForm = typeof FormData !== 'undefined' && rest.body instanceof FormData;
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    credentials: 'include',
    cache: 'no-store',
    headers: {
      // A FormData body sets its own multipart boundary.
      ...(isForm ? {} : {'Content-Type': 'application/json'}),
      ...(csrf ? {'X-CSRF-Token': csrf} : {}),
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

const get = <T>(path: string) => web<T>(path);
const send = <T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, idempotencyKey?: string) =>
  web<T>(path, {method, body: body === undefined ? undefined : JSON.stringify(body), idempotencyKey});

/**
 * A key for one user action. The server's idempotency gate accepts
 * [A-Za-z0-9_-]{8,128} only: never a colon.
 */
export function actionKey(prefix: string): string {
  const r = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    : Math.random().toString(36).slice(2, 14);
  return `${prefix}-${Date.now().toString(36)}-${r}`;
}

/* ── Types (mirror the auth-service responses the mobile app reads) ──── */

export {canBook, type AccountKind, type WebMe} from './access';
import type {WebMe} from './access';

export interface WalletBalance {bravo_credits: number; currency: string}

export interface IdentityDocumentFacts {
  status: 'missing' | 'submitted';
  required: boolean;
  doc_type: 'national_id' | 'passport' | null;
  submitted_at: string | null;
  has_back: boolean;
}

export interface RegionAvailability {
  code: string; name: string; cpos_available: number; cpos_total: number; available: boolean;
  utc_offset_hours?: number;
}

export interface AddOn {
  id: string; label: string; description: string | null;
  price_eur_per_hour: string; requires_ops_approval: boolean;
}

export interface Place {latitude: number; longitude: number; address?: string}

export interface Estimate {
  total: number;
  total_bc?: number;
  breakdown: Record<string, number>;
  duration_hours?: number;
  duration_rule?: {default: number; min: number; max: number; grid?: number[]};
  gross_bc?: number;
  referral?: {code: string; applied: boolean; message: string | null; reason: string | null};
}

export interface EstimateBody {
  type: 'transfer' | 'timeslot';
  service: 'secure_transfer' | 'executive_protection';
  duration_hours?: number;
  add_ons: string[];
  region: string;
  cpo_count: number;
  vehicle_count: number;
  driver_only: boolean;
  passengers: number;
  pickup_time?: string;
  pickup?: {latitude: number; longitude: number};
  referral_code?: string;
}

export interface CreateBody extends Omit<EstimateBody, 'pickup' | 'pickup_time'> {
  pickup: Place;
  dropoff?: Place;
  start_time: string;
  payment_method: 'bravo_credits';
  region_label?: string;
  booking_mode: 'now' | 'later';
  notes?: string;
  task_type?: string;
  exec_transport?: {
    mode: 'one_way' | 'return' | 'both_ways';
    pickup: Place; dropoff: Place; pickup_time?: string; passengers: number;
  };
  location_consent?: boolean;
  terms_accepted?: boolean;
  location_consent_version?: string;
  terms_accepted_version?: string;
}

export type BookingStatus =
  | 'DRAFT' | 'DISPATCHING' | 'PENDING_OPS' | 'OPS_APPROVED' | 'PAYMENT_PENDING'
  | 'CONFIRMED' | 'LIVE' | 'COMPLETED' | 'NO_PROVIDER' | 'AGENCY_NO_SHOW' | 'CANCELLED';

export interface Booking {
  id: string;
  status: BookingStatus;
  type: string;
  region: string;
  region_label: string;
  service: string;
  pickup: Place;
  dropoff: Place | null;
  start_time: string;
  passengers: number;
  cpo_count: number;
  vehicle_count: number;
  driver_only: boolean;
  add_ons: string[];
  duration_hours: number;
  total_eur: number;
  total_aed: number;
  created_at: string;
  mission_status?: string | null;
  stage?: string | null;
  dispatch_mode?: string | null;
  booking_mode?: 'now' | 'later' | null;
  task_type?: string | null;
  notes?: string | null;
  dispatched_at?: string | null;
  pickup_at?: string | null;
  client_received_at?: string | null;
  service_window_end_at?: string | null;
  no_provider_fallback?: {hotline_e164: string; can_widen: boolean; can_escalate: boolean} | null;
  exec_transport?: {mode: string; pickup: Place; dropoff: Place; pickup_time: string | null; passengers: number} | null;
}

export interface BookingTeam {
  cpos: Array<{call_sign: string; display_name: string; role: string; armed: boolean; female: boolean;
    avatar_url: string | null; company: string | null; verified: boolean; accepted: boolean}>;
  vehicle: {call_sign: string; make_model: string; plate: string; colour?: string | null; armored: boolean} | null;
}

export interface VerifyCode {
  code: string; rotates_at: string; arrival_code: string; arrival_rotates_at: string;
  lead: {display_name: string | null; call_sign: string | null};
}

export interface TelemetryFix {lat: number; lng: number; eta_minutes?: number; recorded_at: string}

export type ProStatus =
  | 'PENDING_PROPOSAL' | 'PROPOSAL_CREATED' | 'REVISION_REQUESTED' | 'ACCEPTED'
  | 'ACTIVE' | 'EXPIRED' | 'REJECTED' | 'CANCELLED';

export interface ProProposal {
  id: string; version: number; proposal_number: string; valid_until: string;
  coverage_start: string; coverage_end: string; total_credits: number;
  included_services: string[]; assigned_team: Array<{role: string; count: number; label?: string}>;
  terms: string | null; created_at: string;
}

export interface ProApplication {
  id: string;
  status: ProStatus;
  intended_use: string;
  duration_months: number | null;
  duration_note: string | null;
  start_date: string;
  coverage_area: string;
  cpo_count: number;
  driver_count: number;
  support_staff_count: number;
  gender_preference: string;
  services: string[];
  notes: string | null;
  rejected_reason: string | null;
  submitted_at: string;
  activated_at: string | null;
  current_period_end: string | null;
  covered_until?: string | null;
  proposal: ProProposal | null;
  via_owner?: {name: string} | null;
}

export interface ProCreateBody {
  intended_use: string;
  duration_months?: number;
  duration_note?: string;
  start_date: string;
  coverage_area: string;
  cpo_count: number;
  driver_count: number;
  support_staff_count: number;
  gender_preference: string;
  services: string[];
  notes?: string;
}

export interface ProMission {
  id: string; mission_dates: string[]; note: string | null;
  status: 'REQUESTED' | 'SCHEDULED' | 'DECLINED' | 'COMPLETED' | 'CANCELLED';
  ops_note: string | null; created_at: string; requested_by_name?: string | null;
}

export interface ProMessage {id: string; sender: 'client' | 'ops'; body: string; created_at: string}

/* ── Endpoints ───────────────────────────────────────────────────────── */

export const webAuth = {
  loginStart: (phoneE164: string, password: string) =>
    send<LoginStartResult>('POST', '/auth/login', {phoneE164, password}),
  loginVerify: (userId: string, code: string, challengeId?: string | null) =>
    send<{expiresIn: number}>('POST', '/auth/verify',
      {userId, code, deviceId: deviceId(), platform: 'web', ...(challengeId ? {challengeId} : {})}),
  sessionRefresh: () => send<{expiresIn: number}>('POST', '/auth/session/refresh'),
  me: () => web<WebMe>('/auth/me', {noBoot: true}),
  changePassword: (currentPassword: string, newPassword: string) =>
    web<{ok: true}>('/auth/me/password', {method: 'POST', body: JSON.stringify({currentPassword, newPassword}), noBoot: true}),
  async signOut(): Promise<void> {
    try {
      await web('/auth/session', {method: 'DELETE', body: JSON.stringify({deviceId: deviceId(), allDevices: false}), noBoot: true});
    } catch { /* best effort: the cookies below go regardless */ }
    expireWebCsrf();
    try { window.sessionStorage.removeItem(WEB_EXPIRES_KEY); } catch { /* ignore */ }
  },
};

export const webApi = {
  /* People (privacy-preserving: exact phone numbers only, like the app's contact match). */
  lookupPhones: (phones: string[]) =>
    send<{matches: Array<{phone: string; userId: string; displayName: string; avatarUrl: string | null}>}>(
      'POST', '/users/lookup', {phones}),
  profiles: (userIds: string[]) =>
    send<{profiles: Array<{userId: string; displayName: string; avatarUrl: string | null}>}>(
      'POST', '/users/profiles', {userIds}),

  /* Wallet + identity */
  balance: () => get<WalletBalance>('/wallet/balance'),
  identity: () => get<IdentityDocumentFacts>('/users/me/identity-document'),
  submitIdentity: (docType: 'national_id' | 'passport', front: File, back?: File | null) => {
    const form = new FormData();
    form.append('doc_type', docType);
    form.append('front', front);
    if (back) form.append('back', back);
    return web<IdentityDocumentFacts>('/users/me/identity-document', {method: 'POST', body: form});
  },

  /* Booking */
  regions: () => get<RegionAvailability[]>('/bookings/regions/availability'),
  addOns: (region: string) => get<AddOn[]>(`/bookings/add-ons?region=${encodeURIComponent(region)}`),
  estimate: (body: EstimateBody) => send<Estimate>('POST', '/bookings/estimate', body),
  /** Auto dispatch: create + start the provider search in one call. */
  requestAuto: (body: CreateBody, key: string) => send<{booking: Booking}>('POST', '/dispatch/request', body, key),
  /** HQ-approved flow: create → awaiting approval → pay with credits. */
  create: (body: CreateBody, key: string) => send<{booking: Booking}>('POST', '/bookings', body, key),
  bookings: () => get<{bookings: Booking[]; total: number}>('/bookings'),
  booking: (id: string) => get<Booking>(`/bookings/${encodeURIComponent(id)}`),
  team: (id: string) => get<BookingTeam>(`/bookings/${encodeURIComponent(id)}/team`),
  provider: (id: string) =>
    get<{display_name: string | null; call_sign: string | null; rating: number | null; jobs_total: number}>(
      `/bookings/${encodeURIComponent(id)}/provider`),
  verifyCode: (id: string) => get<VerifyCode>(`/bookings/${encodeURIComponent(id)}/verify-code`),
  latestFix: (id: string) => get<{latest: TelemetryFix | null}>(`/telemetry/${encodeURIComponent(id)}/latest`),
  cancel: (id: string) =>
    send<{id: string; status: string; refunded_credits?: number; already_ended?: boolean}>('POST', `/bookings/${encodeURIComponent(id)}/cancel`),
  /** Stable key per booking: a retry or a second tab can never charge twice. */
  payWithCredits: (id: string) =>
    send<{booking: Booking}>('POST', `/bookings/${encodeURIComponent(id)}/pay-with-credits`, {}, `paywc-${id}`),
  confirmComplete: (id: string) =>
    send<unknown>('POST', `/bookings/${encodeURIComponent(id)}/confirm-complete`, undefined, `confirm-${id}`),
  rate: (id: string, stars: number) =>
    send<unknown>('POST', `/bookings/${encodeURIComponent(id)}/rating`, {stars}, `rate-${id}`),

  /* Secure Pro */
  proMe: () => get<{application: ProApplication | null; history: Array<{id: string; status: ProStatus; submitted_at: string}>}>('/pro-applications/me'),
  proCreate: (body: ProCreateBody) => send<{application: ProApplication}>('POST', '/pro-applications', body),
  proAccept: (id: string) => send<{application: ProApplication}>('POST', `/pro-applications/${id}/accept`, {}),
  proRequestChanges: (id: string, message: string) =>
    send<{application: ProApplication}>('POST', `/pro-applications/${id}/request-changes`, {message}),
  proActivate: (id: string) =>
    send<{application: ProApplication}>('POST', `/pro-applications/${id}/activate`, {}, `proapp-activate-${id}`),
  proCancel: (id: string) => send<{application: ProApplication}>('POST', `/pro-applications/${id}/cancel`, {}),
  proMessages: (id: string) => get<{messages: ProMessage[]}>(`/pro-applications/${id}/messages`),
  proSendMessage: (id: string, body: string) =>
    send<{message: ProMessage}>('POST', `/pro-applications/${id}/messages`, {body}),
  proMissions: (id: string) => get<{missions: ProMission[]}>(`/pro-applications/${id}/missions`),
  proRequestDates: (id: string, dates: string[], note?: string) =>
    send<{mission: ProMission}>('POST', `/pro-applications/${id}/missions`, {dates, ...(note ? {note} : {})}),
  proCancelDates: (id: string, missionId: string) =>
    send<{mission: ProMission}>('POST', `/pro-applications/${id}/missions/${missionId}/cancel`, {}),
};

/* ── SWR hooks (keys start with 'web' so sign-out can clear them) ─────── */

const useWebSWR = <T>(key: unknown[] | null, fn: () => Promise<T>, opts?: SWRConfiguration<T>) =>
  useSWR<T>(key, fn, opts);

export const useWebMe = (enabled = true) =>
  useWebSWR(enabled ? ['web', 'me'] : null, webAuth.me, {refreshInterval: 120_000});
export const useBalance = (enabled = true) =>
  useWebSWR(enabled ? ['web', 'balance'] : null, webApi.balance, {refreshInterval: 60_000});
export const useBookings = (enabled = true) =>
  useWebSWR(enabled ? ['web', 'bookings'] : null, webApi.bookings, {refreshInterval: 20_000});
export const useBooking = (id: string | null) =>
  useWebSWR(id ? ['web', 'booking', id] : null, () => webApi.booking(id as string), {refreshInterval: 10_000});
export const useProMe = (enabled = true) =>
  useWebSWR(enabled ? ['web', 'pro'] : null, webApi.proMe, {refreshInterval: 60_000});
