import type {ModuleKey, OrgMission} from './api';
import type {Tone} from '@/lib/status';

/** Lite = the on-demand secure transfer lane; Executive = executive protection. */
export type Product = 'lite' | 'executive';

export function productOf(service: string | null | undefined): Product {
  return service === 'executive_protection' ? 'executive' : 'lite';
}
export const PRODUCT_LABEL: Record<Product, string> = {lite: 'Lite', executive: 'Executive'};

const SERVICE_LABEL: Record<string, string> = {
  secure_transfer: 'Secure transfer',
  executive_protection: 'Executive protection',
  recon_team: 'Recon team',
  emergency_extraction: 'Emergency extraction',
};
const TASK_LABEL: Record<string, string> = {
  site_protection: 'Site protection',
  event_security: 'Event security',
  close_protection: 'Close protection',
  residential_watch: 'Residential watch',
  asset_protection: 'Asset protection',
  other: 'Other',
};

export function serviceLabel(m: {service: string; task_type?: string | null}): string {
  const base = SERVICE_LABEL[m.service] ?? m.service.replace(/_/g, ' ');
  const task = m.task_type ? TASK_LABEL[m.task_type] : null;
  return task ? `${base} · ${task}` : base;
}

/** What the board calls each state. CREWED must never read as "dispatched". */
export function missionState(m: Pick<OrgMission, 'mission_id' | 'mission_status' | 'booking_status'>): {label: string; tone: Tone} {
  if (!m.mission_id) {
    if (m.booking_status === 'CONFIRMED') return {label: 'Needs crew', tone: 'warn'};
    if (m.booking_status === 'CANCELLED') return {label: 'Cancelled', tone: 'muted'};
    return {label: m.booking_status.toLowerCase().replace(/_/g, ' '), tone: 'muted'};
  }
  switch (m.mission_status) {
    case 'CREWED':     return {label: 'Not dispatched', tone: 'warn'};
    case 'DISPATCHED': return {label: 'Dispatched', tone: 'info'};
    case 'PICKUP':     return {label: 'Arrived', tone: 'info'};
    case 'LIVE':       return {label: 'Live', tone: 'live'};
    case 'SOS':        return {label: 'SOS', tone: 'err'};
    case 'COMPLETED':  return {label: 'Completed', tone: 'ok'};
    case 'ABORTED':    return {label: 'Stood down', tone: 'muted'};
    default:           return {label: (m.mission_status ?? '').toLowerCase(), tone: 'muted'};
  }
}

export const MODULE_LABEL: Record<ModuleKey, string> = {
  jobs: 'Missions',
  portal: 'Job portal',
  compliance: 'Compliance',
  roster: 'Officer roster',
  orgChart: 'Org chart',
  dept: 'Departmental',
  earn: 'Earnings',
  msg: 'Messenger',
  intel: 'Bravo Feed',
  region: 'Region',
  fleet: 'Vehicles',
  pro: 'Secure Pro',
};

/** The modules this console uses, in the order the permissions screen lists them. */
export const CONSOLE_MODULES: ModuleKey[] = ['jobs', 'portal', 'pro', 'roster', 'fleet', 'earn'];

export function credits(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${Math.round(n).toLocaleString('en-GB')} BC`;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', {day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'});
}

export function errorText(e: unknown): string {
  const body = (e as {body?: {message?: string | string[]; error?: string}})?.body;
  const raw = Array.isArray(body?.message) ? body?.message[0] : body?.message ?? (e as Error)?.message ?? '';
  const map: Record<string, string> = {
    crew_count_mismatch: 'Pick exactly the number of officers this job needs.',
    lead_not_in_crew: 'The lead must be one of the selected officers.',
    cpo_not_in_org: 'One of the officers is no longer on your roster.',
    cpo_not_approved_for_deployment: 'One of the officers has not been approved for deployment yet.',
    cpo_not_on_duty: 'One of the officers is off duty. Ask them to go on duty in the app.',
    cpo_busy: 'One of the officers is already on another mission.',
    crew_already_assigned: 'A crew is already assigned, so the job can no longer be returned.',
    mission_not_completable: 'This mission cannot be completed yet.',
    offer_not_available: 'This offer is no longer available. Another agency took it or it expired.',
    only_org_owner_can_change_permissions: 'Only the agency owner can change manager permissions.',
    org_owner_only: 'Only the agency owner can do this.',
    vehicle_not_verified: 'Bravo Secure has not verified this vehicle yet.',
    vehicle_busy: 'This vehicle is already on another mission.',
    vehicle_inactive: 'This vehicle is retired. Reactivate it first.',
    mission_not_open: 'This mission has ended, so vehicles can no longer change.',
    plate_taken: 'Your agency already has a vehicle with this plate.',
    call_sign_taken: 'Your agency already uses this call sign for a vehicle.',
    range_max_366_days: 'Choose a period of one year or less.',
    csrf_token_invalid: 'Your session is out of date. Reload the page and try again.',
  };
  if (map[raw]) return map[raw];
  if (raw.startsWith('org_module_not_granted')) return 'Your agency owner has not given you access to this.';
  if ((e as {status?: number})?.status === 429) return 'Too many attempts. Wait a minute and try again.';
  return raw || 'Something went wrong. Try again.';
}
