/**
 * IA-07 — the honest answer to "I changed it, why hasn't the app changed?"
 *
 * The founder's ask was for one place holding "the api calls to app (like
 * package update change everything)". Half of that is the editors; the other
 * half — the half nobody could see — is WHAT the apps read, HOW LONG it takes,
 * and WHICH values ops cannot change at all.
 *
 * The delays below are not guesses: they are the measured findings of
 * `docs/audits/OPS_PROPAGATION_AND_FETCHING_AUDIT_2026-09-02.md` (OP-01..OP-10).
 * When those fixes land, correct this file — it is the single place the console
 * makes the claim, so it cannot drift page by page.
 */

export type ConfigKey =
  | 'service_pricing' | 'regions' | 'plan_catalog' | 'subscription_prices'
  | 'tier_grants' | 'killswitch' | 'platform_fees' | 'app_flags';

export interface ConfigDescriptor {
  key: ConfigKey;
  /** What an operator calls it. */
  label: string;
  /** Where it is edited in this console; null = not ops-changeable at all. */
  href: string | null;
  /** The endpoint the mobile apps actually read. */
  appReads: string;
  /** How long a save takes to reach a device, in the operator's words. */
  lands: string;
  /** Known caveat, straight from the propagation audit. Shown as a warning. */
  caveat?: string;
  /** Why it cannot be changed here (only for href === null). */
  locked?: 'deploy' | 'release';
}

export const CONFIG_DESCRIPTORS: ConfigDescriptor[] = [
  {
    key: 'service_pricing',
    label: 'Pricing board — bookings',
    href: '/config/pricing',
    appReads: 'GET /bookings/service-pricing, and the quote at charge time',
    lands: 'Next quote. The server caches the board for 60 s per pod, so allow a minute for every pod to agree.',
    caveat: 'OP-01: the app’s DISPLAY call resolves the GLOBAL board while the charge path uses the booking’s pickup region — a region override changes what is charged before it changes what is shown.',
  },
  {
    key: 'regions',
    label: 'Regions',
    href: '/config/regions',
    appReads: 'GET /bookings/regions/availability',
    lands: 'Next fetch by the app.',
    caveat: 'OP-04: the mobile zone map still iterates a COMPILED region list, so a brand-new region needs an app build before customers can pick it. Pricing and ops surfaces see it immediately.',
  },
  {
    key: 'plan_catalog',
    label: 'Package names & descriptions',
    href: '/config/packages',
    appReads: 'GET /subscription/catalog',
    lands: 'The app’s next catalog fetch.',
    caveat: 'OP-08: the client store loads the catalog on mount, so an app already open keeps the old copy until it is reopened.',
  },
  {
    key: 'subscription_prices',
    label: 'Messenger subscription prices',
    href: '/config/packages',
    appReads: 'GET /subscription/prices, and the charge at subscribe/renew',
    lands: 'Every subscribe and every renewal from now. Already-paid periods finish at the price they were charged.',
  },
  {
    key: 'tier_grants',
    label: 'Messenger tier grants',
    href: '/config/tier-grants',
    appReads: '/auth/me plus the server-side tier gate',
    lands: 'Up to 30 seconds.',
    caveat: 'OP-03: the tier gate has no bust, so for up to 30 s the app can already say "Pro" while a Pro endpoint still refuses.',
  },
  {
    key: 'killswitch',
    label: 'Auto-dispatch kill switch',
    href: '/config/switches',
    appReads: 'Server-side only — the dispatch engine reads it, not the app',
    lands: 'Under 2 seconds. It is shared Redis state, not a per-pod copy — the one value that propagates properly.',
  },
  {
    key: 'platform_fees',
    label: 'Platform fee % and cancellation fee %',
    href: null,
    locked: 'deploy',
    appReads: 'Server environment, read once at boot',
    lands: 'Needs a backend deploy.',
    caveat: 'OP-10: moving these onto the pricing board is an open follow-up — the code carries its own TODO saying so.',
  },
  {
    key: 'app_flags',
    label: 'App behaviour flags (auto-dispatch, dept chat, native map, …)',
    href: null,
    locked: 'release',
    appReads: 'Baked into the app bundle at build time',
    lands: 'Needs a new app build and a store release.',
  },
];

/** Maps a `GET /ops/config/status` row key onto its descriptor. */
export function descriptorFor(key: string): ConfigDescriptor | undefined {
  return CONFIG_DESCRIPTORS.find(d => d.key === key);
}
