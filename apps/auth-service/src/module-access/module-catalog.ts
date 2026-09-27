/**
 * The product modules an ops admin can switch on/off per account group.
 *
 * ONE source of truth: the guard validates keys against it, the admin API
 * returns it, and the console renders the matrix from it.
 *
 * SAFETY RULE — a module being OFF blocks STARTING new use of it. It never
 * blocks SOS / panic, VBG heartbeat / biometric check-in / telemetry / tracking,
 * or an in-flight protection session. `serverGate` says exactly what is blocked
 * so an operator never has to guess; module-access.binding.spec pins the
 * never-gated endpoints.
 */

export type AccountGroup = 'individual' | 'enterprise' | 'agency' | 'cpo';

export const ACCOUNT_GROUPS: readonly {id: AccountGroup; label: string; description: string}[] = [
  {id: 'individual', label: 'Individual clients', description: 'Personal client accounts'},
  {id: 'enterprise', label: 'Enterprise', description: 'Clients who own or belong to a company workspace'},
  {id: 'agency', label: 'Service-provider agencies', description: 'Agency owners and the managers they delegate to'},
  {id: 'cpo', label: 'CPO agents', description: 'Close-protection officers'},
];

export type ModuleKey =
  | 'secure_lite' | 'executive_protection' | 'secure_pro' | 'vbg'
  | 'family' | 'news' | 'departmental' | 'job_portal';

export interface ModuleDef {
  key: ModuleKey;
  label: string;
  description: string;
  /** Groups this module exists for. Outside these it is not applicable and never gated. */
  groups: readonly AccountGroup[];
  /** Plain statement of what the server refuses when the module is off. */
  serverGate: string;
}

const CLIENTS: readonly AccountGroup[] = ['individual', 'enterprise'];

export const MODULES: readonly ModuleDef[] = [
  {key: 'secure_lite', label: 'Secure Transfer', description: 'Book a secure transfer (Lite).',
   groups: CLIENTS, serverGate: 'New bookings. Existing bookings stay visible and continue.'},
  {key: 'executive_protection', label: 'Executive Protection', description: 'Book executive protection.',
   groups: CLIENTS, serverGate: 'New executive-protection bookings. Existing ones continue.'},
  {key: 'secure_pro', label: 'Secure Pro', description: 'Pro plans, designated team, protection sessions.',
   groups: CLIENTS, serverGate: 'New applications, renewals, activations, missions and new protection sessions. An active session is never interrupted.'},
  {key: 'vbg', label: 'GeoRisk (VBG)', description: 'Risk assessment, threats, key points, geofences, monitoring.',
   groups: CLIENTS, serverGate: 'Monitoring enrolment, risk assessment, threats, key points and new geofences. Panic, check-ins, telemetry and tracking always work.'},
  {key: 'family', label: 'Linked Members', description: 'Link and fund family members.',
   groups: CLIENTS, serverGate: 'All linked-member management.'},
  {key: 'news', label: 'Bravo Feed', description: 'Security news and threat alerts.',
   groups: ['individual', 'enterprise', 'agency', 'cpo'], serverGate: 'The Bravo Feed API.'},
  {key: 'departmental', label: 'Departmental', description: 'Channels, attendance, incidents and workspace.',
   groups: ['enterprise', 'agency', 'cpo'], serverGate: 'Departmental channels, attendance, rosters, incident reports and workspace settings.'},
  {key: 'job_portal', label: 'Job Portal', description: 'Browse and claim open jobs.',
   groups: ['agency'], serverGate: 'Listing and claiming open jobs.'},
];

export const MODULE_BY_KEY: ReadonlyMap<string, ModuleDef> = new Map(MODULES.map(m => [m.key, m]));
export const GROUP_IDS: ReadonlySet<string> = new Set(ACCOUNT_GROUPS.map(g => g.id));

/** Shown in the console so nobody hunts for a switch that must never exist. */
export const ALWAYS_ON: readonly {key: string; label: string; reason: string}[] = [
  {key: 'sos', label: 'SOS / panic', reason: 'Safety — can never be switched off.'},
  {key: 'wallet', label: 'Wallet & payments', reason: 'Needed to pay for any service.'},
];

/** Honest list of what this matrix cannot control yet. */
export const NOT_YET: readonly {key: string; label: string; reason: string}[] = [
  {key: 'messenger', label: 'Messenger', reason: 'Runs in the separate messenger service; server-side switching there is the next step.'},
];

export function isApplicable(key: string, group: AccountGroup): boolean {
  return MODULE_BY_KEY.get(key)?.groups.includes(group) ?? false;
}
