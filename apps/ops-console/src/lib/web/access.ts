/**
 * Who is signed in to the Bravo Web App, and what they may do. No imports, so
 * tests can load it without the API client.
 */
export type AccountKind = 'individual' | 'agency' | 'cpo';

export interface WebMe {
  user: {
    id: string; email: string | null; display_name: string | null; role: string;
    phone_e164: string | null; avatar_url: string | null;
  };
  account_kind: AccountKind;
  must_set_password: boolean;
  is_org_manager: boolean;
  /**
   * 2026-10-27 — the AGENCY half of is_org_manager (a manager of a service
   * provider, not of an Enterprise workspace). Undefined on an older server.
   */
  is_agency_manager?: boolean;
  auto_dispatch_enabled: boolean;
  identity_document_status?: 'missing' | 'submitted' | 'unknown';
  identity_document_required?: boolean;
  disabled_modules?: string[];
  /** 2026-10-25 — modules the PLAN locks (Secure Services on the free plan). */
  plan_locked_modules?: string[];
  /** Every workspace this person belongs to; `admin` (2026-10-27) on a manager. */
  workspaces?: Array<{org_id: string; name: string; role: 'owner' | 'manager' | 'employee' | 'cpo'; admin?: boolean}>;
}

/** A workspace this person runs, and how much of it. */
export interface ManagedWorkspace {
  org_id: string;
  name: string;
  /** owner: everything · admin: all but the owner and other admins · manager: channels and members. */
  level: 'owner' | 'admin' | 'manager';
}

/**
 * 2026-10-27 (owner) — the workspaces this account can manage on the web:
 * the one it owns and the ones it is a Manager or Admin of.
 */
export function managedWorkspaces(me: WebMe | undefined | null): ManagedWorkspace[] {
  return (me?.workspaces ?? [])
    .filter(w => w.role === 'owner' || w.role === 'manager')
    .map(w => ({org_id: w.org_id, name: w.name || 'Workspace',
      level: w.role === 'owner' ? 'owner' as const : w.admin ? 'admin' as const : 'manager' as const}));
}

/**
 * Who may book on the web: a client account, exactly the people the mobile
 * app routes to its client home (resolveRoute.ts) and the home site counts as
 * a client (hub.service audiences). Officers, agencies and AGENCY managers get
 * Messenger only. 2026-10-30 — the owner or a Manager of an Enterprise
 * workspace is a client (is_agency_manager); an older server without it falls
 * back to is_org_manager, as the app does.
 */
export function canBook(me: WebMe | undefined | null): boolean {
  if (!me) return false;
  return me.account_kind === 'individual' && !(me.is_agency_manager ?? me.is_org_manager)
    && me.user.role !== 'agent' && me.user.role !== 'service_provider';
}

/**
 * 2026-10-25 / 2026-10-30 (owner) — Secure Services is included with Bravo
 * Messenger Pro and Enterprise. On the free plan the server lists it in
 * plan_locked_modules and refuses to START a booking or a Secure Pro
 * application (403 tier_insufficient); the web pages offer the upgrade.
 * Existing bookings stay visible either way.
 */
export function secureServicesLocked(me: WebMe | undefined | null): boolean {
  return (me?.plan_locked_modules ?? []).includes('secure_lite');
}

/** What a Secure Services page shows this account. */
export type SecureServicesAccess = 'open' | 'upgrade' | 'not_client';

/** `startsService` — the page starts something new (Book, Secure Pro). */
export function secureServicesAccess(me: WebMe | undefined | null, startsService: boolean): SecureServicesAccess {
  if (!canBook(me)) return 'not_client';
  if (startsService && secureServicesLocked(me)) return 'upgrade';
  return 'open';
}
