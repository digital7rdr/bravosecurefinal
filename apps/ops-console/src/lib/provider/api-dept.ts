/**
 * Service Provider Console — Departmental client (2026-10-31).
 *
 * Owner: "The Service provider, agent web portal should have the same
 * functions as the Mobile app." These are the manager-side calls behind the
 * app's Departmental rows (src/screens/deptchat: AdminAttendanceScreen,
 * AttendanceDayScreen, CorrectionsScreen, IncidentQueueScreen,
 * IncidentDetailScreen, ApprovalsScreen), sent through the provider session
 * transport in ./api (cookie session, CSRF header, X-Org-Context).
 *
 * Server (apps/auth-service), every route below:
 *   - JwtAuthGuard (the provider cookie session is accepted),
 *   - OrgManagerGuard (the agency itself, a workspace owner, or an ACTIVE
 *     member_role='manager' membership; X-Org-Context picks among the caller's
 *     own memberships), whose `department` is a FORCED branch filter,
 *   - /attendance/* and /incidents/* and /attendance/roster/*: also
 *     @ModuleGate('departmental') (HQ's per-account switch) and DeptChatV2Guard
 *     (404 while the rollout flag is off).
 * None of them carries @OrgModules('dept'): the owner's "Departmental" grant
 * is enforced on the web by the page gate (`can('dept')`), exactly as the app
 * hides the rows. The roster read used for names (GET /org/cpos) does carry
 * @OrgModules(…, 'dept', …).
 *
 * Not here on purpose: incident evidence bytes. They are end-to-end encrypted
 * to the managers' phones (sealed per device), so the console only counts the
 * attachments and sends people to the app to open them.
 */

import {get, send, useOrgSWR} from './api';
import {errorText} from './labels';

/* ── Helpers ─────────────────────────────────────────────────────────── */

type Params = Record<string, string | null | undefined>;

/** `?a=1&b=2`, dropping empty values; '' when nothing is left. */
export function qs(params?: Params): string {
  if (!params) return '';
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

const enc = encodeURIComponent;

/* ── Types (mirror the auth-service responses / src/services/api.ts) ── */

export type AttendanceStatus =
  | 'present' | 'late' | 'absent' | 'early_checkout'
  | 'leave' | 'sick_leave' | 'off_duty' | 'pending_review'
  | 'emergency_leave' | 'mission';
export type ReviewStatus = 'none' | 'pending' | 'approved' | 'rejected';
export type ReviewReason =
  | 'face_mismatch' | 'out_of_radius' | 'permission_denied' | 'offline'
  | 'camera_unavailable' | 'disputed';

export interface ShiftSession {
  id: string;
  org_user_id: string;
  cpo_user_id: string;
  status: 'open' | 'closed' | 'edited';
  clock_in_at: string;
  clock_in_lat: number | null;
  clock_in_lng: number | null;
  clock_out_at: string | null;
  clock_in_place?: string | null;
  clock_out_place?: string | null;
  display_name?: string | null;
  call_sign?: string | null;
  department?: string | null;
  shift_start_at?: string | null;
  shift_end_at?: string | null;
  site_label?: string | null;
  approved_radius_m?: number | null;
  has_photo?: boolean;
  shift_id?: string | null;
  face_verified?: boolean | null;
  within_radius?: boolean | null;
  distance_m?: number | null;
  attendance_status?: AttendanceStatus | null;
  review_status?: ReviewStatus;
  review_reason?: ReviewReason | null;
  reviewed_at?: string | null;
  admin_notes?: string | null;
  dispute_note?: string | null;
}

export interface AttendanceSummary {counts: Record<string, number>; total: number; pendingReview: number}

export interface Shift {
  id: string;
  department: string | null;
  site_label: string | null;
  site_lat: number | null;
  site_lng: number | null;
  approved_radius_m: number;
  start_at: string;
  end_at: string;
  archived_at: string | null;
  assigned_count?: number;
}

export interface CorrectionRow {
  id: string;
  session_id: string;
  corrected_by: string;
  corrected_at: string;
  reason: string;
  before_value: Record<string, unknown>;
  after_value: Record<string, unknown>;
}

export type IncidentCategory =
  | 'security_concern' | 'safety_issue' | 'medical_incident' | 'suspicious_activity'
  | 'access_control' | 'property_damage' | 'vehicle_issue' | 'staff_misconduct'
  | 'visitor_contractor' | 'equipment_failure' | 'operational_disruption'
  | 'harassment_workplace' | 'lost_property' | 'fire_hazard' | 'other';
export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IncidentStatus =
  | 'submitted' | 'received' | 'under_review' | 'action_assigned' | 'resolved' | 'closed';

export interface IncidentReport {
  id: string;
  ref: string | null;
  org_user_id: string;
  submitter_id: string;
  department: string | null;
  category: IncidentCategory;
  severity: IncidentSeverity;
  description: string;
  location_label: string | null;
  location_lat: number | null;
  location_lng: number | null;
  status: IncidentStatus;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
}

export interface IncidentEvent {
  id: string;
  incident_id: string;
  actor_id: string;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  note_internal: boolean;
  created_at: string;
}

export interface IncidentAttachment {id: string; incident_id: string; storage_key: string; created_by: string; created_at: string}

export interface JoinRequest {
  id: string;
  applicant_user_id: string;
  applicant_name: string | null;
  applicant_phone: string | null;
  applicant_email: string | null;
  referrer_name: string | null;
  team_name: string | null;
  message: string | null;
  created_at: string;
}

export interface MemberInvite {
  code: string;
  contact: string;
  contact_kind: 'phone' | 'email';
  invited_name: string | null;
  invited_role: string;
  team_name: string | null;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  expires_at: string | null;
  created_at: string;
}

export interface IncidentFilters {
  status?: string; severity?: string; category?: string;
  from?: string; to?: string; department?: string;
}

/* ── Endpoints ───────────────────────────────────────────────────────── */

export const pvAttendanceApi = {
  /** Present / late / absent counts + how many wait for review. */
  summary: (p: {from?: string; to?: string; department?: string}) =>
    get<AttendanceSummary>(`/attendance/org/summary${qs(p)}`),
  /** Check-ins flagged for a manager's decision. */
  pending: (department?: string) => get<ShiftSession[]>(`/attendance/org/pending${qs({department})}`),
  /** The people behind a Present / Late / Absent number. */
  day: (p: {from?: string; to?: string; status?: string; department?: string}) =>
    get<ShiftSession[]>(`/attendance/org/day${qs(p)}`),
  shifts: () => get<Shift[]>('/attendance/shifts'),
  /** Recent sessions (the corrections picker). No names: the page joins the roster. */
  sessions: () => get<ShiftSession[]>('/attendance/org/sessions'),
  /** Approve or reject a flagged check-in. Notes are 1–500 chars or absent. */
  review: (id: string, decision: 'approve' | 'reject', notes?: string) => {
    const n = notes?.trim();
    return send<ShiftSession>('PATCH', `/attendance/sessions/${enc(id)}/review`, n ? {decision, notes: n} : {decision});
  },
  /** The check-in face photo while the review is open. Audited server-side on every read. */
  photo: (id: string) =>
    get<{mime: string; captured_at: string; data_url: string}>(`/attendance/sessions/${enc(id)}/photo`),
  corrections: (sessionId: string) =>
    get<{corrections: CorrectionRow[]}>(`/attendance/roster/corrections/${enc(sessionId)}`),
  recordCorrection: (body: {session_id: string; reason: string; after: Record<string, unknown>}) =>
    send<CorrectionRow>('POST', '/attendance/roster/corrections', body),
};

export const pvIncidentApi = {
  queue: (f?: IncidentFilters) => get<IncidentReport[]>(`/incidents/queue${qs(f as Params)}`),
  detail: (id: string) => get<{report: IncidentReport; events: IncidentEvent[]}>(`/incidents/${enc(id)}`),
  updateStatus: (id: string, to: IncidentStatus, note?: string) => {
    const n = note?.trim();
    return send<{id: string; status: IncidentStatus}>('PATCH', `/incidents/${enc(id)}/status`, n ? {to, note: n} : {to});
  },
  assign: (id: string, assigneeUserId: string) =>
    send<{id: string; assigned_to: string}>('POST', `/incidents/${enc(id)}/assign`, {assignee_user_id: assigneeUserId}),
  /** Internal by default: managers only, never shown to the reporter. */
  addNote: (id: string, note: string, internal = true) =>
    send<{ok: true}>('POST', `/incidents/${enc(id)}/note`, {note, internal}),
  /** Pointers only. The files are end-to-end encrypted to phones. */
  attachments: (id: string) => get<IncidentAttachment[]>(`/incidents/${enc(id)}/attachments`),
};

export const pvJoinApi = {
  requests: () => get<{requests: JoinRequest[]}>('/enterprise/join-requests'),
  approve: (id: string) => send<{ok: true; decision: 'approved'}>('POST', `/enterprise/join-requests/${enc(id)}/approve`),
  decline: (id: string) => send<{ok: true; decision: 'declined'}>('POST', `/enterprise/join-requests/${enc(id)}/decline`),
  invites: () => get<{invites: MemberInvite[]}>('/enterprise/invites'),
  revokeInvite: (code: string) => send<{ok: true}>('POST', `/enterprise/invites/${enc(code)}/revoke`),
};

/* ── SWR hooks (keys carry the agency; every key starts 'dept:') ─────── */

export const DEPT_KEY_PREFIX = 'dept:';

/** Matcher for `mutate(...)`: every Departmental key of every agency. */
export const isDeptKey = (k: unknown): boolean =>
  Array.isArray(k) && k[0] === 'pv' && typeof k[2] === 'string' && k[2].startsWith(DEPT_KEY_PREFIX);

export const usePvAttSummary = (org: string | null, p: {from?: string; to?: string; department?: string}, on = true) =>
  useOrgSWR(on ? `dept:att:summary:${p.from ?? ''}:${p.to ?? ''}:${p.department ?? ''}` : null, org,
    () => pvAttendanceApi.summary(p), {refreshInterval: 30_000});
export const usePvAttPending = (org: string | null, department: string | undefined, on = true) =>
  useOrgSWR(on ? `dept:att:pending:${department ?? ''}` : null, org, () => pvAttendanceApi.pending(department), {refreshInterval: 30_000});
export const usePvAttDay = (org: string | null, p: {from?: string; to?: string; status: string; department?: string}, on = true) =>
  useOrgSWR(on ? `dept:att:day:${p.status}:${p.from ?? ''}:${p.to ?? ''}:${p.department ?? ''}` : null, org,
    () => pvAttendanceApi.day(p), {refreshInterval: 60_000});
export const usePvAttShifts = (org: string | null, on = true) =>
  useOrgSWR(on ? 'dept:att:shifts' : null, org, pvAttendanceApi.shifts, {refreshInterval: 60_000});
export const usePvAttSessions = (org: string | null, on = true) =>
  useOrgSWR(on ? 'dept:att:sessions' : null, org, pvAttendanceApi.sessions, {refreshInterval: 60_000});
export const usePvCorrections = (org: string | null, sessionId: string | null) =>
  useOrgSWR(sessionId ? `dept:att:corrections:${sessionId}` : null, org,
    () => pvAttendanceApi.corrections(sessionId as string), {refreshInterval: 0});

export const usePvIncidents = (org: string | null, f: IncidentFilters, on = true) =>
  useOrgSWR(on ? `dept:inc:queue:${JSON.stringify(f)}` : null, org, () => pvIncidentApi.queue(f), {refreshInterval: 30_000});
export const usePvIncident = (org: string | null, id: string | null) =>
  useOrgSWR(id ? `dept:inc:detail:${id}` : null, org, () => pvIncidentApi.detail(id as string), {refreshInterval: 30_000});
export const usePvIncidentFiles = (org: string | null, id: string | null) =>
  useOrgSWR(id ? `dept:inc:files:${id}` : null, org, () => pvIncidentApi.attachments(id as string), {refreshInterval: 0});

export const usePvJoinRequests = (org: string | null, on = true) =>
  useOrgSWR(on ? 'dept:join:requests' : null, org, pvJoinApi.requests, {refreshInterval: 30_000});
export const usePvMemberInvites = (org: string | null, on = true) =>
  useOrgSWR(on ? 'dept:join:invites' : null, org, pvJoinApi.invites, {refreshInterval: 60_000});

/* ── Labels (plain English, same words as the app) ───────────────────── */

export type PillTone = 'ok' | 'warn' | 'err' | 'info' | 'muted';

export const ATTENDANCE_LABEL: Record<AttendanceStatus, {label: string; tone: PillTone}> = {
  present:         {label: 'Present', tone: 'ok'},
  late:            {label: 'Late', tone: 'warn'},
  early_checkout:  {label: 'Left early', tone: 'warn'},
  absent:          {label: 'Absent', tone: 'err'},
  leave:           {label: 'Leave', tone: 'info'},
  sick_leave:      {label: 'Sick leave', tone: 'info'},
  off_duty:        {label: 'Off duty', tone: 'muted'},
  emergency_leave: {label: 'Emergency leave', tone: 'err'},
  mission:         {label: 'On a mission', tone: 'info'},
  pending_review:  {label: 'Waiting for review', tone: 'warn'},
};
export function attendanceLabel(s?: string | null): {label: string; tone: PillTone} {
  return (s && ATTENDANCE_LABEL[s as AttendanceStatus]) || {label: 'Checked in', tone: 'info'};
}
export const CORRECTABLE_STATUSES = Object.keys(ATTENDANCE_LABEL) as AttendanceStatus[];

export function reviewReasonLabel(r?: string | null): string | null {
  switch (r) {
    case 'face_mismatch':      return 'Face check could not be confirmed';
    case 'camera_unavailable': return 'Camera unavailable or not allowed';
    case 'out_of_radius':      return 'Outside the approved site radius';
    case 'permission_denied':  return 'Location was not shared';
    case 'offline':            return 'Submitted offline';
    case 'disputed':           return 'Disputed by the member';
    default:                   return null;
  }
}

/** Where they checked in: the place name, else the coordinates, else the site. */
export function placeLabel(s: Pick<ShiftSession, 'clock_in_place' | 'clock_in_lat' | 'clock_in_lng' | 'site_label'>): string {
  const place = s.clock_in_place?.trim();
  if (place) return place;
  const {clock_in_lat: lat, clock_in_lng: lng} = s;
  if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) {
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }
  return s.site_label?.trim() || 'Location not recorded';
}

export const INCIDENT_CATEGORY_LABEL: Record<IncidentCategory, string> = {
  security_concern: 'Safety concern',
  safety_issue: 'Safety issue',
  medical_incident: 'Medical incident',
  suspicious_activity: 'Suspicious activity',
  access_control: 'Access control',
  property_damage: 'Property damage',
  vehicle_issue: 'Vehicle issue',
  staff_misconduct: 'Staff misconduct',
  visitor_contractor: 'Visitor or contractor',
  equipment_failure: 'Equipment failure',
  operational_disruption: 'Operational disruption',
  harassment_workplace: 'Workplace harassment',
  lost_property: 'Lost property',
  fire_hazard: 'Fire hazard',
  other: 'Other',
};
export const INCIDENT_CATEGORIES = Object.keys(INCIDENT_CATEGORY_LABEL) as IncidentCategory[];

export const SEVERITY_LABEL: Record<IncidentSeverity, {label: string; tone: PillTone}> = {
  low: {label: 'Low', tone: 'ok'},
  medium: {label: 'Medium', tone: 'info'},
  high: {label: 'High', tone: 'warn'},
  critical: {label: 'Critical', tone: 'err'},
};

export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, {label: string; tone: PillTone}> = {
  submitted:       {label: 'Submitted', tone: 'info'},
  received:        {label: 'Received', tone: 'info'},
  under_review:    {label: 'Under review', tone: 'warn'},
  action_assigned: {label: 'Action assigned', tone: 'warn'},
  resolved:        {label: 'Resolved', tone: 'ok'},
  closed:          {label: 'Closed', tone: 'muted'},
};
export const INCIDENT_STATUSES = Object.keys(INCIDENT_STATUS_LABEL) as IncidentStatus[];

/**
 * The next steps a manager can take (mirror of the server's incident-fsm.ts).
 * Reopening a CLOSED incident is the agency owner's call only, so a manager is
 * not offered it.
 */
export function incidentNextSteps(status: IncidentStatus, isOwner: boolean): IncidentStatus[] {
  switch (status) {
    case 'submitted':       return ['received'];
    case 'received':        return ['under_review'];
    case 'under_review':    return ['action_assigned'];
    case 'action_assigned': return ['resolved'];
    case 'resolved':        return ['closed', 'under_review'];
    case 'closed':          return isOwner ? ['under_review'] : [];
    default:                return [];
  }
}

/** Assignment is refused once an incident is resolved or closed. */
export const canAssignIncident = (status: IncidentStatus) => status !== 'resolved' && status !== 'closed';

/* ── Date windows ────────────────────────────────────────────────────── */

export type DayPreset = 'all' | 'today' | '7d' | '30d';
export const DAY_PRESETS: Array<[DayPreset, string]> = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All']];

/** [from, to) in local midnights, the window the app's attendance tiles use. */
export function dayWindow(key: DayPreset, now: Date = new Date()): {from?: string; to?: string} {
  const days = key === 'today' ? 1 : key === '7d' ? 7 : key === '30d' ? 30 : null;
  if (!days) return {};
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 1);
  return {from: start.toISOString(), to: end.toISOString()};
}

export type IncidentRange = 'all' | '7d' | '30d' | '90d';
export const INCIDENT_RANGES: Array<[IncidentRange, string]> = [['all', 'All time'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days']];
export function incidentFrom(key: IncidentRange, now: number = Date.now()): string | undefined {
  const days = key === '7d' ? 7 : key === '30d' ? 30 : key === '90d' ? 90 : 0;
  return days ? new Date(now - days * 86_400_000).toISOString() : undefined;
}

/* ── Corrections ─────────────────────────────────────────────────────── */

export const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function toHHMM(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function hhmmOn(hhmm: string, anchorIso: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(anchorIso);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

/**
 * What a correction would change (same rules as the app's CorrectionsScreen):
 * only fields that differ; times are HH:MM on the session's own day; a
 * check-out at or before the check-in rolls to the next day, so a shift can
 * never come out negative. `{}` means nothing changed.
 */
export function correctionAfter(
  session: Pick<ShiftSession, 'attendance_status' | 'clock_in_at' | 'clock_out_at'>,
  input: {status: AttendanceStatus | '' | null; inTime: string; outTime: string},
): Record<string, unknown> {
  const after: Record<string, unknown> = {};
  if (input.status && input.status !== (session.attendance_status ?? null)) after.attendance_status = input.status;
  const inT = input.inTime.trim();
  if (inT && HHMM.test(inT) && inT !== toHHMM(session.clock_in_at)) after.clock_in_at = hhmmOn(inT, session.clock_in_at);
  const outT = input.outTime.trim();
  if (outT && HHMM.test(outT) && outT !== toHHMM(session.clock_out_at)) {
    const effIn = (after.clock_in_at as string | undefined) ?? session.clock_in_at;
    let iso = hhmmOn(outT, effIn);
    if (Date.parse(iso) <= Date.parse(effIn)) {
      const d = new Date(iso);
      d.setDate(d.getDate() + 1);
      iso = d.toISOString();
    }
    after.clock_out_at = iso;
  }
  return after;
}

/* ── Errors ──────────────────────────────────────────────────────────── */

const DEPT_ERRORS: Record<string, string> = {
  // attendance
  not_pending_review: 'This check-in has already been reviewed.',
  session_not_found_in_org: 'This record is outside your department or no longer exists.',
  photo_not_found: 'There is no face photo for this check-in.',
  photo_purged: 'The face photo has been deleted now that the review is closed.',
  correction_changes_nothing: 'Nothing changed. The values you entered match the current record.',
  cannot_correct_open_session: 'This session is still open. It can be corrected once it closes.',
  correction_reason_required: 'A reason is required.',
  invalid_attendance_status: 'That status is not a valid attendance value.',
  invalid_clock_in_at: 'The check-in time could not be understood.',
  invalid_clock_out_at: 'The check-out time could not be understood.',
  correction_out_before_in: 'That would put the check-out before the check-in. Check both times.',
  // incidents
  incident_not_found_in_org: 'This incident is outside your department or no longer exists.',
  incident_not_found: 'This incident no longer exists.',
  assignee_must_be_manager: 'Only the agency owner or a manager can own an incident.',
  incident_not_assignable: 'Resolved and closed incidents cannot be reassigned.',
  not_authorized_for_incident_evidence: 'You cannot see the evidence for this incident.',
  // join requests + invites
  join_request_already_decided: 'Another manager has already approved or declined this request.',
  join_request_not_found: 'This request no longer exists.',
  member_suspended_use_roster_status: 'This person is a suspended member. Lift the suspension from the roster instead.',
  member_exists_use_roster_status: 'This person already has a history on your roster. Reinstate them from the roster instead.',
  already_active_in_another_org: 'This person is already an active member of another organisation.',
  already_a_member_of_this_org: 'This person is already a member.',
  workspace_owner_cannot_join: 'This person owns their own workspace, so they cannot join yours.',
  cannot_join_own_workspace: 'This request is from your own account and cannot be approved.',
  team_channel_unavailable_reinvite: 'The team on this request no longer exists. Restore or replace that channel, then approve.',
  invite_already_accepted: 'This person already joined, so the invite cannot be revoked.',
  invite_not_found: 'This invite no longer exists.',
  // access
  org_manager_access_required: 'You are not a manager of this agency.',
};

/** errorText for the Departmental pages: their own server codes first. */
export function deptErrorText(e: unknown): string {
  const body = (e as {body?: {message?: string | string[]}})?.body;
  const raw = Array.isArray(body?.message) ? body?.message[0] : body?.message ?? '';
  if (raw && DEPT_ERRORS[raw]) return DEPT_ERRORS[raw];
  if (raw.startsWith('invalid_incident_transition')) {
    return raw.includes(':closed->') ? 'Only the agency owner can reopen a closed incident.' : 'That status change is not allowed.';
  }
  // DeptChatV2Guard answers a bare 404 while the rollout flag is off.
  if ((e as {status?: number})?.status === 404 && (!raw || raw === 'Not Found')) {
    return 'This is not switched on for your agency yet.';
  }
  return errorText(e);
}

/**
 * For ConfirmDialog, which prints errorText(thrown): rethrow a server error
 * carrying the Departmental wording so the dialog shows plain English.
 */
export function deptError(e: unknown): Error {
  const text = deptErrorText(e);
  return Object.assign(new Error(text), {status: (e as {status?: number})?.status, body: {message: text}});
}
