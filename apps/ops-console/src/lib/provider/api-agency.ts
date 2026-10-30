/**
 * Service provider console — agency self-service (2026-10-31).
 *
 * The app's agency dashboard rows Job Portal, Compliance and Region on the web
 * (owner: "the Service provider, agent web portal should have the same
 * functions as the Mobile app"). Same server routes as the app
 * (src/services/api.ts agentApi / complianceApi), on the provider cookie
 * session built in lib/provider/api.ts.
 *
 * WHO the server acts for (read before changing a page):
 *   - /agents/me/* and /compliance/* act on the SIGNED-IN account (user.sub),
 *     not on X-Org-Context. That is the agency only when the agency owner is
 *     signed in (the owner's account IS the agency: org_id === user id).
 *       GET  /agents/me/open-jobs   company accounts only (403 provider_only)
 *       GET/POST /compliance[/me]    the caller's own documents
 *       POST /agents/me/upload       stored under the caller's own folder
 *       GET  /agents/me              the caller's own agent row
 *   - PATCH /agents/me/agency-profile resolves the agency for a manager too:
 *     the company account itself, else the OLDEST agency the caller actively
 *     manages (it ignores X-Org-Context).
 *   - POST /dispatch/open-jobs/:id/claim is org-scoped (OrgManagerGuard +
 *     @OrgModules('portal','jobs')): owner, or a manager granted either.
 */

import {ApiError, actionKey, get, readPvCsrf, send, useOrgSWR, type ConsoleContext} from '@/lib/provider/api';
import {errorText} from '@/lib/provider/labels';

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';
const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';

/* ── Types (mirror the auth-service responses) ───────────────────────── */

/** GET /agents/me/open-jobs row. Coarse only: no address, no client. */
export interface OpenJob {
  booking_id: string;
  status: string;
  region_code: string;
  region_label: string;
  service: string;
  pickup_area: string | null;
  pickup_time: string;
  duration_hours: number;
  cpo_count: number;
  armed_required: boolean;
  total_eur: string;
  total_aed: string;
  created_at: string;
  /** Only 'auto' bookings can be claimed; absent = older server, treat as auto. */
  dispatch_mode?: string | null;
}

export interface ComplianceDoc {
  id: string;
  doc_type: string;
  region_code: string;
  reference: string | null;
  /** '' for an armed permit with no expiry. */
  expires_at: string;
  state: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';
  reject_reason: string | null;
}

export type AgencyDocType = 'licence' | 'insurance';

/** The slice of GET /agents/me these pages read. */
export interface AgentMe {
  agent: {
    user_id: string;
    type: string;
    status: string;
    display_name: string | null;
    region_code?: string | null;
    dpa_accepted_at?: string | null;
  };
}

export interface AgencyProfileResult {region_code: string | null; dpa_accepted_at: string | null}

/* ── Regions (the five dispatch regions, same list as the app) ────────── */

export interface RegionRow {code: string; name: string; currency: string}

/** Mirror of the server's DEFAULT_REGIONS codes (common/regions.ts) and the app's utils/regions.ts. */
export const REGIONS: ReadonlyArray<RegionRow> = [
  {code: 'AE', name: 'United Arab Emirates', currency: 'AED'},
  {code: 'SA', name: 'Saudi Arabia', currency: 'SAR'},
  {code: 'BD', name: 'Bangladesh', currency: 'BDT'},
  {code: 'GB', name: 'United Kingdom', currency: 'GBP'},
  {code: 'ZA', name: 'South Africa', currency: 'ZAR'},
];

export function regionName(code: string | null | undefined): string {
  if (!code) return 'Not set';
  const c = code.trim().toUpperCase();
  return REGIONS.find(r => r.code === c)?.name ?? c;
}

export function isSupportedRegion(code: string | null | undefined): boolean {
  return !!code && REGIONS.some(r => r.code === code.trim().toUpperCase());
}

/** Outside every supported region. */
export const REGION_NONE = 'N/A';

/** Offline fallback boxes [minLat, maxLat, minLng, maxLng], most specific first (same as the app). */
const REGION_BBOX: ReadonlyArray<{code: string; box: [number, number, number, number]}> = [
  {code: 'AE', box: [22.5, 26.5, 51.0, 56.6]},
  {code: 'BD', box: [20.5, 26.7, 88.0, 92.8]},
  {code: 'GB', box: [49.8, 61.1, -8.7, 1.9]},
  {code: 'ZA', box: [-35.1, -22.0, 16.3, 33.1]},
  {code: 'SA', box: [16.0, 32.6, 34.4, 55.7]},
];

/** Region for a fix: the reverse-geocoded country wins; the bounding box is the fallback. */
export function regionForPoint(country: string | null, lat: number, lng: number): string {
  if (country) {
    const c = country.trim().toUpperCase();
    return isSupportedRegion(c) ? c : REGION_NONE;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return REGION_NONE;
  for (const {code, box} of REGION_BBOX) {
    if (lat >= box[0] && lat <= box[1] && lng >= box[2] && lng <= box[3]) return code;
  }
  return REGION_NONE;
}

async function reverseCountry(lat: number, lng: number): Promise<string | null> {
  if (!MAPBOX_TOKEN) return null;
  try {
    const res = await fetch(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?types=country&limit=1&access_token=${MAPBOX_TOKEN}`,
    );
    if (!res.ok) return null;
    const body = await res.json() as {features?: Array<{properties?: {short_code?: string}}>};
    const code = body.features?.[0]?.properties?.short_code;
    return code ? code.toUpperCase() : null;
  } catch { return null; }
}

/**
 * Where is this browser now? Resolves to a region code, REGION_NONE, or null
 * when the location cannot be read (blocked, unavailable, timed out).
 */
export function locateRegion(): Promise<string | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null);
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos => {
        const {latitude: lat, longitude: lng} = pos.coords;
        void reverseCountry(lat, lng).then(c => resolve(regionForPoint(c, lat, lng)));
      },
      () => resolve(null),
      {enableHighAccuracy: false, timeout: 15_000, maximumAge: 60_000},
    );
  });
}

/* ── Who the /agents/me routes act for ───────────────────────────────── */

/**
 * True when the signed-in account IS the selected agency (its owner), so the
 * caller-scoped routes (/agents/me/*, /compliance/*) read and write this agency.
 */
export function actsAsAgency(context: Pick<ConsoleContext, 'user' | 'orgs'>, orgId: string): boolean {
  const org = context.orgs.find(o => o.org_id === orgId);
  return !!org && org.role === 'owner' && org.org_id === context.user.id;
}

/**
 * PATCH /agents/me/agency-profile writes, for a manager, the oldest agency they
 * manage. The console can only be sure that is the selected one when this
 * person runs exactly one agency, as a manager.
 */
export function managerRegionTarget(context: Pick<ConsoleContext, 'user' | 'orgs'>, orgId: string): boolean {
  return context.orgs.length === 1 && context.orgs[0].role === 'manager' && context.orgs[0].org_id === orgId;
}

/* ── Job portal rules ────────────────────────────────────────────────── */

export type JobAvailability = 'claimable' | 'awaiting_approval' | 'assigned_by_bravo';

export function jobAvailability(job: Pick<OpenJob, 'status' | 'dispatch_mode'>): JobAvailability {
  const auto = job.dispatch_mode === undefined || job.dispatch_mode === null || job.dispatch_mode === 'auto';
  if (!auto) return 'assigned_by_bravo';
  return job.status === 'OPS_APPROVED' || job.status === 'DISPATCHING' ? 'claimable' : 'awaiting_approval';
}

const CLAIM_ERRORS: Record<string, string> = {
  job_taken: 'Another agency took this job. The list has been refreshed.',
  booking_state_changed_concurrently: 'Another agency took this job. The list has been refreshed.',
  job_not_approved: 'Bravo Secure has not approved this job yet.',
  job_not_claimable: 'Bravo Secure assigns this job directly. It cannot be accepted here.',
  job_unavailable: 'This job is no longer available.',
  job_not_found: 'This job is no longer available.',
  provider_excluded: 'Your agency already passed on or returned this job.',
  provider_on_cooldown: 'Your agency is paused from taking new jobs for now.',
  no_free_cpo_capacity: 'Not enough free officers. Crew or finish your current jobs first.',
  provider_not_eligible: 'Your agency is not verified for this region yet (licence, insurance or armed permit).',
  agent_not_approved: 'Your agency account is not active yet.',
  provider_only: 'Only agency accounts can accept jobs from the portal.',
};

const AGENCY_ERRORS: Record<string, string> = {
  provider_only: 'Only the agency owner account can open the job list.',
  unsupported_region: 'That region is not supported yet.',
  agency_profile_is_company_only: 'Only the agency owner or one of its managers can set the dispatch region.',
  expiry_in_past: 'The expiry date must be in the future.',
  file_url_not_own_upload: 'The file could not be linked. Attach it again and resubmit.',
  invalid_doc_type: 'Choose licence or insurance.',
  no_file: 'Choose a file to upload.',
  agent_not_found: 'This account has no agency profile.',
};

function code(e: unknown): string {
  const body = (e as {body?: {message?: string | string[]; error?: string}})?.body;
  const m = Array.isArray(body?.message) ? body?.message[0] : body?.message;
  return m ?? (e as Error)?.message ?? '';
}

export function claimErrorText(e: unknown): string {
  return CLAIM_ERRORS[code(e)] ?? agencyErrorText(e);
}

export function agencyErrorText(e: unknown): string {
  const c = code(e);
  if (AGENCY_ERRORS[c]) return AGENCY_ERRORS[c];
  if ((e as {status?: number})?.status === 413) return 'That file is too large. The limit is 25 MB.';
  return errorText(e);
}

/* ── Uploads ─────────────────────────────────────────────────────────── */

/** Photos and PDFs, as in the app's document picker. */
export const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'application/pdf'] as const;
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export function uploadProblem(file: {type: string; size: number} | null): string | null {
  if (!file) return 'Attach a photo or PDF of the document.';
  if (file.type && !(UPLOAD_TYPES as readonly string[]).includes(file.type)) return 'Use a photo (JPEG, PNG, HEIC, WebP) or a PDF.';
  if (file.size > UPLOAD_MAX_BYTES) return 'That file is too large. The limit is 25 MB.';
  if (file.size === 0) return 'That file is empty.';
  return null;
}

/**
 * POST /agents/me/upload as multipart/form-data (field "file"), the browser
 * equivalent of agentApi.uploadFile. Not through pv(): that forces a JSON
 * Content-Type, and the browser must set the multipart boundary itself.
 */
export async function uploadFile(file: Blob & {name?: string}): Promise<string> {
  const fd = new FormData();
  fd.append('file', file, file.name ?? 'document');
  const csrf = readPvCsrf();
  const res = await fetch(`${BASE}/agents/me/upload`, {
    method: 'POST',
    body: fd,
    credentials: 'include',
    cache: 'no-store',
    headers: csrf ? {'X-CSRF-Token': csrf} : {},
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = (body as {message?: string | string[]} | null)?.message;
    throw new ApiError(res.status, body, Array.isArray(msg) ? msg[0] : msg ?? res.statusText);
  }
  const url = (body as {file_url?: string} | null)?.file_url;
  if (!url) throw new ApiError(500, body, 'upload_failed');
  return url;
}

/* ── Endpoints ───────────────────────────────────────────────────────── */

export const agencyApi = {
  me: () => get<AgentMe>('/agents/me'),
  /** 'ALL' or empty = every region. */
  openJobs: (region?: string) =>
    get<{jobs: OpenJob[]}>(`/agents/me/open-jobs${region && region !== 'ALL' ? `?region=${encodeURIComponent(region)}` : ''}`),
  /** First agency to accept wins. A fresh key per tap: a booking can be relisted
   *  after a withdraw, and a fixed key would replay the old success. */
  claimOpenJob: (bookingId: string) =>
    send<{offer_id: string; booking_id: string; status: 'CONFIRMED'}>(
      'POST', `/dispatch/open-jobs/${encodeURIComponent(bookingId)}/claim`, undefined, actionKey(`claim-${bookingId}`)),
  /** dpa_accepted false never withdraws an earlier acceptance (the server keeps the first). */
  setAgencyProfile: (dto: {region_code: string; dpa_accepted: boolean; dpa_version?: string}) =>
    send<AgencyProfileResult>('PATCH', '/agents/me/agency-profile', {dpa_version: 'v1', ...dto}),
  complianceDocs: () => get<ComplianceDoc[]>('/compliance/me'),
  submitCompliance: (body: {doc_type: AgencyDocType; region_code: string; expires_at: string; reference?: string; file_url: string}) =>
    send<{id: string; doc_type: string; state: 'PENDING'}>('POST', '/compliance', body),
  uploadFile,
};

/* ── SWR hooks (keys carry the agency, like usePv*) ──────────────────── */

export const useAgentMe = (org: string | null, on = true) =>
  useOrgSWR(on ? 'agent-me' : null, org, agencyApi.me, {refreshInterval: 60_000});
export const useOpenJobs = (org: string | null, region: string, on = true) =>
  useOrgSWR(on ? `open-jobs:${region}` : null, org, () => agencyApi.openJobs(region), {refreshInterval: 10_000});
export const useComplianceDocs = (org: string | null, on = true) =>
  useOrgSWR(on ? 'compliance-docs' : null, org, agencyApi.complianceDocs, {refreshInterval: 60_000});
