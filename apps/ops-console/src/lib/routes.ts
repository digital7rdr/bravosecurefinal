/**
 * IA-01/IA-11 — the ONE source of every internal path in the console.
 *
 * Before this module, 60+ string literals ("/live", "/bookings/" + id, …) were
 * spread across pages, the Shell, the notification bell and the SOS bar, so the
 * 2026-09-03 section restructure could not be done safely: a missed literal is a
 * dead link that nothing catches. `routesLiteral.test.ts` now bans a bare "/…"
 * href outside this file.
 *
 * Section prefixes mirror the rail groups exactly (audit §5.2):
 *   /lite · /executive · /pro · /enterprise · /people · /config · /finance
 *   /safety · /internal
 * Old flat URLs (/bookings, /live, /pro-management, …) are permanently
 * redirected in next.config.ts — see REDIRECTS below, which is the single
 * source for those too.
 */

export const routes = {
  root: '/',
  login: '/login',
  acceptInvite: '/accept-invite',
  /** Public referral-link landing (no session): what a shared code opens. */
  referralLanding: (code: string) => `/r/${encodeURIComponent(code)}`,

  dashboard: '/dashboard',
  analytics: '/analytics',

  /** Lite — on-demand Secure Transfer (+ recon / extraction) bookings. */
  lite: {
    root: '/lite',
    bookings: '/lite/bookings',
    booking: (id: string) => `/lite/bookings/${id}`,
    dispatch: '/lite/dispatch',
    dispatchRequests: '/lite/dispatch/requests',
    dispatchRequest: (id: string) => `/lite/dispatch/requests/${id}`,
    dispatchTest: '/lite/dispatch/test',
    jobs: '/lite/jobs',
    job: (id: string) => `/lite/jobs/${id}`,
    missions: '/lite/missions',
    mission: (id: string) => `/lite/missions/${id}`,
  },

  /** Executive Protection — fixed-block on-site details. */
  executive: {
    root: '/executive',
    bookings: '/executive/bookings',
    booking: (id: string) => `/executive/bookings/${id}`,
    missions: '/executive/missions',
    mission: (id: string) => `/executive/missions/${id}`,
  },

  /** Secure Pro — 3-month protection plans and their delivery. */
  pro: {
    root: '/pro',
    applications: '/pro/applications',
    application: (id: string) => `/pro/applications/${id}`,
    organisations: '/pro/organisations',
    pool: '/pro/pool',
    assignments: '/pro/assignments',
    assignmentsScheduled: '/pro/assignments/scheduled',
    fleet: '/pro/fleet',
    fleetResources: '/pro/fleet/resources',
    protection: '/pro/protection',
    session: (id: string) => `/pro/protection/${id}`,
  },

  /** Messenger Enterprise workspaces. */
  enterprise: {
    root: '/enterprise',
    messenger: '/enterprise/messenger',
    departments: '/enterprise/departments',
    /** One organisation: profile, channel tree, people, incidents, org graph. */
    org: (id: string) => `/enterprise/departments/${id}`,
    attendance: '/enterprise/attendance',
    incidents: '/enterprise/incidents',
    joinRequests: '/enterprise/join-requests',
  },

  /** People — clients, CPOs, provider agencies, compliance. */
  people: {
    root: '/people/clients',
    clients: '/people/clients',
    client: (id: string) => `/people/clients/${id}`,
    agents: '/people/agents',
    agent: (id: string) => `/people/agents/${id}`,
    agencies: '/people/agencies',
    agency: (id: string) => `/people/agencies/${id}`,
    compliance: '/people/compliance',
    users: '/people/users',
    user: (id: string) => `/people/users/${id}`,
  },

  /** App Configuration — everything the mobile apps fetch that ops can change. */
  config: {
    root: '/config',
    pricing: '/config/pricing',
    regions: '/config/regions',
    packages: '/config/packages',
    tierGrants: '/config/tier-grants',
    switches: '/config/switches',
    integrations: '/config/integrations',
  },

  finance: {
    root: '/finance',
    ledger: '/finance/ledger',
    escrow: '/finance/escrow',
    payouts: '/finance/payouts',
    disputes: '/finance/disputes',
    invoices: '/finance/invoices',
    promos: '/finance/promos',
    referralCodes: '/finance/promos/referral-codes',
    /** Referral / discount campaigns (2026-09-05): ops-minted, per region or universal. */
    referralCampaigns: '/finance/promos/campaigns',
    referralCampaign: (id: string) => `/finance/promos/campaigns/${id}`,
    adjust: '/finance/adjust',
  },

  safety: {
    root: '/safety/sos',
    sos: '/safety/sos',
    vbg: '/safety/vbg',
  },

  internal: {
    root: '/internal/audit',
    admins: '/internal/admins',
    audit: '/internal/audit',
    console: '/internal/console',
  },
} as const;

/**
 * IA-03 — the service values that belong to each product section. The Lite and
 * Executive lists are the SAME component with a different `services` prop, and
 * the server filters on it (`GET /ops/bookings?service=`), so an Executive row
 * can never appear in a Lite list just because it fell outside the loaded page.
 */
export const LITE_SERVICES = ['secure_transfer', 'recon_team', 'emergency_extraction'] as const;
export const EXECUTIVE_SERVICE = 'executive_protection';

export function isExecutiveService(service: string | null | undefined): boolean {
  return service === EXECUTIVE_SERVICE;
}

/**
 * Product-aware detail links. These two helpers are the ONLY place that decides
 * whether a booking/mission belongs to Lite or Executive — every list, KPI tile,
 * SOS row and activity entry routes through them, so the split cannot drift.
 * A row without a `service` (older projections) falls back to Lite, which is the
 * safe direction: the Lite detail renders every Executive field too, it just
 * does not lead with them.
 */
export function bookingHref(b: {id: string; service?: string | null}): string {
  return isExecutiveService(b.service) ? routes.executive.booking(b.id) : routes.lite.booking(b.id);
}

export function missionHref(m: {id: string; service?: string | null}): string {
  return isExecutiveService(m.service) ? routes.executive.mission(m.id) : routes.lite.mission(m.id);
}

/**
 * Permanent redirects from the pre-2026-09-03 flat URLs. Consumed by
 * next.config.ts (build-time) and by `redirects.test.ts`, which asserts every
 * destination is a real route. `:id` is Next's path-param syntax.
 *
 * `/bookings/:id` and `/live/:id` land on the LITE detail: it is service-aware
 * and replaces the URL with the Executive one when the row turns out to be an
 * Executive booking (see BookingDetail / MissionDetail `useCanonicalRoute`).
 */
export const REDIRECTS: ReadonlyArray<{source: string; destination: string}> = [
  {source: '/bookings', destination: routes.lite.bookings},
  {source: '/bookings/:id', destination: '/lite/bookings/:id'},
  {source: '/jobs', destination: routes.lite.jobs},
  {source: '/jobs/:id', destination: '/lite/jobs/:id'},
  {source: '/dispatch', destination: routes.lite.dispatch},
  {source: '/dispatch-inspector', destination: routes.lite.dispatchRequests},
  {source: '/dispatch-inspector/:id', destination: '/lite/dispatch/requests/:id'},
  {source: '/live', destination: routes.lite.missions},
  {source: '/live/wall', destination: routes.lite.missions},
  {source: '/live/:id', destination: '/lite/missions/:id'},

  {source: '/pro-applications', destination: routes.pro.applications},
  {source: '/pro-applications/:id', destination: '/pro/applications/:id'},
  {source: '/pro-management', destination: routes.pro.root},
  {source: '/protection', destination: routes.pro.protection},

  {source: '/agents', destination: routes.people.agents},
  {source: '/agents/:id', destination: '/people/agents/:id'},
  {source: '/users', destination: routes.people.users},
  {source: '/users/:id', destination: '/people/users/:id'},
  {source: '/compliance', destination: routes.people.compliance},

  {source: '/settings', destination: routes.config.root},

  {source: '/referral-codes', destination: routes.finance.referralCodes},

  {source: '/sos', destination: routes.safety.sos},
  {source: '/vbg', destination: routes.safety.vbg},

  {source: '/incidents', destination: routes.enterprise.incidents},
  {source: '/messenger', destination: routes.enterprise.messenger},
  {source: '/departments', destination: routes.enterprise.departments},
  {source: '/dept-attendance', destination: routes.enterprise.attendance},

  {source: '/audit', destination: routes.internal.audit},
  {source: '/admins', destination: routes.internal.admins},
];
