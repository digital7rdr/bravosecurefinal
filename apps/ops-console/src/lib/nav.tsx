/**
 * IA-01/IA-09 — the rail as DATA, grouped by business area instead of by tool.
 *
 * The pre-2026-09-03 rail had seven tool-shaped groups ("Operations" held eight
 * unrelated items; Secure Pro was split across two of them; Executive Protection
 * had no home at all). This tree is the audit's §5.2 target: Overview, the three
 * revenue products, Enterprise, the people behind them, the config levers, the
 * money, the safety net, the house — in the order an operator works them.
 *
 * `Shell.tsx` renders from this and nothing else. Role gating is declared here
 * (group first, then item); the backend @RequireRoles remain the real boundary —
 * this only stops an operator walking into a 403.
 */

import type {ReactNode} from 'react';
import type {AdminDomain, AdminRole} from './rbac';
import {routes} from './routes';

export type NavBadgeKey = 'lite' | 'executive' | 'pro' | 'proRequests' | 'enterprise' | 'safety';

export interface NavItem {
  label: string;
  href: string;
  icon: ReactNode;
  minRole?: AdminRole;
  /** Section landings must not stay lit for every child route. */
  exact?: boolean;
  /** Reads dash.kpis.<key>.waiting — "how much is waiting on ops here". */
  badgeKey?: NavBadgeKey;
}

export interface NavGroup {
  key: string;
  /** B-818 — which admin level sees this group. Omitted = every admin. */
  domain?: AdminDomain | 'platform';
  label: string;
  minRole?: AdminRole;
  items: NavItem[];
}

/* ── Icons ──────────────────────────────────────────────────────────────
   18×18, 1.4 stroke, currentColor. Kept inline (no icon dependency) and
   deliberately simple — the rail is dense and glyphs must read at 18px. */
const s = {stroke: 'currentColor', strokeWidth: 1.4} as const;
const Ic = ({children}: {children: ReactNode}) => (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">{children}</svg>
);

const iconGrid = <Ic><rect x="2" y="2" width="7" height="7" rx="1.5" {...s}/><rect x="11" y="2" width="7" height="7" rx="1.5" {...s}/><rect x="2" y="11" width="7" height="7" rx="1.5" {...s}/><rect x="11" y="11" width="7" height="7" rx="1.5" {...s}/></Ic>;
const iconChart = <Ic><path d="M3 17V7M8 17V3M13 17V10M17 17V6" {...s} strokeLinecap="round"/></Ic>;
const iconGauge = <Ic><path d="M3.5 15a7 7 0 1 1 13 0" {...s} strokeLinecap="round"/><path d="M10 11.5l3.5-3" {...s} strokeLinecap="round"/><circle cx="10" cy="12" r="1.2" fill="currentColor"/></Ic>;
const iconCalendar = <Ic><rect x="3" y="4" width="14" height="13" rx="1.4" {...s}/><path d="M3 8h14M7 2v4M13 2v4" {...s} strokeLinecap="round"/></Ic>;
const iconRelay = <Ic><path d="M10 2l7 4-7 4-7-4 7-4Z" {...s} strokeLinejoin="round"/><path d="M3 10l7 4 7-4M3 14l7 4 7-4" {...s} strokeLinejoin="round"/></Ic>;
const iconClipboard = <Ic><path d="M3 5h14v12H3z" {...s}/><path d="M6 2h8l1 3H5l1-3Z" {...s}/><path d="M7 10h6M7 13h4" {...s} strokeLinecap="round"/></Ic>;
const iconTarget = <Ic><circle cx="10" cy="10" r="7" {...s}/><circle cx="10" cy="10" r="3" {...s}/><circle cx="10" cy="10" r="1" fill="currentColor"/></Ic>;
const iconShieldStar = <Ic><path d="M10 2l6 2.5v5c0 4-2.7 6.4-6 8.5-3.3-2.1-6-4.5-6-8.5v-5L10 2Z" {...s} strokeLinejoin="round"/><path d="M10 6.5l1.1 2.2 2.4.35-1.75 1.7.4 2.4L10 12l-2.15 1.15.4-2.4-1.75-1.7 2.4-.35L10 6.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/></Ic>;
const iconShieldDot = <Ic><path d="M10 2l6 2.5v4.5c0 4-2.6 6.6-6 8-3.4-1.4-6-4-6-8V4.5L10 2Z" {...s} strokeLinejoin="round"/><circle cx="10" cy="9" r="1.6" fill="currentColor"/></Ic>;
const iconDoc = <Ic><rect x="4" y="2.5" width="12" height="15" rx="1.4" {...s}/><path d="M7 6.5h6M7 9.5h6M7 12.5h4" {...s} strokeLinecap="round"/></Ic>;
const iconBuilding = <Ic><rect x="3" y="3" width="8" height="14" rx="1.2" {...s}/><path d="M11 8h6v9h-6" {...s}/><path d="M6 6.5h2M6 9.5h2M6 12.5h2M13.5 11h1.5M13.5 14h1.5" {...s} strokeLinecap="round"/></Ic>;
const iconPeople = <Ic><circle cx="7" cy="7" r="2.6" {...s}/><circle cx="13.5" cy="8.5" r="2.1" {...s}/><path d="M2.5 16.5c0-2.6 2-4.4 4.5-4.4s4.5 1.8 4.5 4.4M12.5 12.6c2.3.2 5 1.6 5 3.9" {...s} strokeLinecap="round"/></Ic>;
const iconPerson = <Ic><circle cx="10" cy="7" r="3.2" {...s}/><path d="M3 18c0-3.5 3-6 7-6s7 2.5 7 6" {...s}/></Ic>;
const iconBadgeCheck = <Ic><path d="M10 2l6 2.5v5c0 4-2.7 6.4-6 8.5-3.3-2.1-6-4.5-6-8.5v-5L10 2Z" {...s} strokeLinejoin="round"/><path d="M7.5 10l1.8 1.8L13 8" {...s} strokeLinecap="round" strokeLinejoin="round"/></Ic>;
const iconChat = <Ic><path d="M3 4h14v10H7l-4 4V4Z" {...s} strokeLinejoin="round"/></Ic>;
const iconTree = <Ic><rect x="7" y="2.5" width="6" height="4" rx="1" {...s}/><rect x="2.5" y="13" width="5" height="4" rx="1" {...s}/><rect x="12.5" y="13" width="5" height="4" rx="1" {...s}/><path d="M10 6.5v3.5M5 13v-3h10v3" {...s} strokeLinecap="round"/></Ic>;
const iconCheckSquare = <Ic><rect x="3" y="4" width="14" height="13" rx="1.4" {...s}/><path d="M3 8h14M7 2v4M13 2v4" {...s} strokeLinecap="round"/><path d="M7 12l2 2 4-4" {...s} strokeLinecap="round" strokeLinejoin="round"/></Ic>;
const iconAlertTri = <Ic><path d="M10 2L2 17h16L10 2Z" {...s} strokeLinejoin="round"/><path d="M10 8v4M10 14.5v.5" {...s} strokeLinecap="round"/></Ic>;
const iconInbox = <Ic><path d="M3 11l2-7h10l2 7v5H3v-5Z" {...s} strokeLinejoin="round"/><path d="M3 11h4l1 2h4l1-2h4" {...s} strokeLinejoin="round"/></Ic>;
const iconSliders = <Ic><path d="M4 5h12M4 10h12M4 15h12" {...s} strokeLinecap="round"/><circle cx="8" cy="5" r="1.8" {...s}/><circle cx="13" cy="10" r="1.8" {...s}/><circle cx="7" cy="15" r="1.8" {...s}/></Ic>;
const iconTag = <Ic><path d="M11 3h5a1 1 0 0 1 1 1v5l-8 8-6-6 8-8Z" {...s} strokeLinejoin="round"/><circle cx="13.5" cy="6.5" r="1.2" stroke="currentColor" strokeWidth="1.2"/></Ic>;
const iconGlobe = <Ic><circle cx="10" cy="10" r="7" {...s}/><path d="M3 10h14M10 3c2 2.2 3 4.6 3 7s-1 4.8-3 7c-2-2.2-3-4.6-3-7s1-4.8 3-7Z" {...s}/></Ic>;
const iconBox = <Ic><path d="M10 2.5l6.5 3.2v8.6L10 17.5 3.5 14.3V5.7L10 2.5Z" {...s} strokeLinejoin="round"/><path d="M3.5 5.7L10 9l6.5-3.3M10 9v8.5" {...s} strokeLinejoin="round"/></Ic>;
const iconStar = <Ic><path d="M10 3l2.1 4.4 4.9.7-3.5 3.4.8 4.8L10 14l-4.3 2.3.8-4.8L3 8.1l4.9-.7L10 3Z" {...s} strokeLinejoin="round"/></Ic>;
const iconSwitch = <Ic><rect x="2.5" y="6" width="15" height="8" rx="4" {...s}/><circle cx="13" cy="10" r="2.4" fill="currentColor"/></Ic>;
const iconTrend = <Ic><path d="M3 13l4-5 3 3 6-8" {...s} strokeLinecap="round" strokeLinejoin="round"/><path d="M3 17h14" {...s} strokeLinecap="round"/></Ic>;
const iconLedger = <Ic><rect x="3.5" y="3" width="13" height="14" rx="1.4" {...s}/><path d="M7 7h6M7 10h6M7 13h3" {...s} strokeLinecap="round"/></Ic>;
const iconLock = <Ic><rect x="4" y="9" width="12" height="8" rx="1.6" {...s}/><path d="M7 9V6.5a3 3 0 0 1 6 0V9" {...s}/></Ic>;
const iconPayout = <Ic><circle cx="10" cy="10" r="7" {...s}/><path d="M10 6v8M12.2 7.6c-.5-.7-1.3-1-2.2-1-1.2 0-2 .6-2 1.6 0 2.2 4.4 1.1 4.4 3.4 0 1-0.9 1.7-2.2 1.7-1 0-1.8-.4-2.3-1.1" {...s} strokeLinecap="round"/></Ic>;
const iconScale = <Ic><path d="M10 3v14M5 6h10M4 6l-2 5h4l-2-5ZM16 6l-2 5h4l-2-5Z" {...s} strokeLinejoin="round"/></Ic>;
const iconInvoice = <Ic><path d="M5 2.5h10v15l-2.5-1.5L10 17.5 7.5 16 5 17.5v-15Z" {...s} strokeLinejoin="round"/><path d="M8 7h4M8 10h4" {...s} strokeLinecap="round"/></Ic>;
const iconAdjust = <Ic><circle cx="10" cy="10" r="7" {...s}/><path d="M7 10h6M10 7v6" {...s} strokeLinecap="round"/></Ic>;
const iconSiren = <Ic><circle cx="10" cy="10" r="7" {...s}/><path d="M10 6.5v4M10 13.5v.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></Ic>;
const iconFingerprint = <Ic><path d="M6 9a4 4 0 0 1 8 0v2.5" {...s} strokeLinecap="round"/><path d="M8 9.2a2 2 0 0 1 4 0v3.3" {...s} strokeLinecap="round"/><path d="M4 8.5A6 6 0 0 1 16 8v3" {...s} strokeLinecap="round"/><path d="M10 9.5v5" {...s} strokeLinecap="round"/></Ic>;
const iconAdminKey = <Ic><circle cx="10" cy="6.5" r="3" {...s}/><path d="M4 17c0-3 2.7-5 6-5s6 2 6 5" {...s}/><path d="M14.5 3.5l1 1 2-2" {...s} strokeLinecap="round" strokeLinejoin="round"/></Ic>;
const iconTerminal = <Ic><rect x="2.5" y="4" width="15" height="12" rx="1.6" {...s}/><path d="M6 8l2.5 2L6 12M10.5 12.5h4" {...s} strokeLinecap="round" strokeLinejoin="round"/></Ic>;

/* ── The tree ───────────────────────────────────────────────────────── */

export const NAV_GROUPS: NavGroup[] = [
  {
    key: 'overview',
    label: 'Overview',
    items: [
      {label: 'Dashboard', href: routes.dashboard, icon: iconGrid},
      {label: 'Analytics', href: routes.analytics, icon: iconChart},
    ],
  },
  {
    key: 'lite',
    domain: 'operations',
    label: 'Lite · Secure Transfer',
    items: [
      {label: 'Overview', href: routes.lite.root, icon: iconGauge, exact: true},
      {label: 'Bookings', href: routes.lite.bookings, icon: iconCalendar, badgeKey: 'lite'},
      {label: 'Auto-Dispatch', href: routes.lite.dispatch, icon: iconRelay},
      {label: 'Manual Dispatch', href: routes.lite.jobs, icon: iconClipboard},
      {label: 'Missions', href: routes.lite.missions, icon: iconTarget},
    ],
  },
  {
    key: 'executive',
    domain: 'operations',
    label: 'Executive Protection',
    items: [
      {label: 'Overview', href: routes.executive.root, icon: iconGauge, exact: true},
      {label: 'Bookings', href: routes.executive.bookings, icon: iconCalendar, badgeKey: 'executive'},
      {label: 'Details & Check-ins', href: routes.executive.missions, icon: iconShieldDot},
    ],
  },
  {
    key: 'pro',
    domain: 'operations',
    label: 'Secure Pro',
    items: [
      {label: 'Overview', href: routes.pro.root, icon: iconGauge, exact: true},
      {label: 'Applications', href: routes.pro.applications, icon: iconShieldStar, badgeKey: 'pro'},
      {label: 'Organisations', href: routes.pro.organisations, icon: iconBuilding},
      {label: 'CPO Pool', href: routes.pro.pool, icon: iconPeople},
      // B-841 — protection-DATE requests awaiting officers are THIS page's queue,
      // not the applications queue the badge used to be summed into.
      {label: 'Assignments', href: routes.pro.assignments, icon: iconCalendar, badgeKey: 'proRequests'},
      {label: 'Fleet & Resources', href: routes.pro.fleet, icon: iconBox},
      {label: 'Protection Sessions', href: routes.pro.protection, icon: iconShieldDot},
    ],
  },
  {
    key: 'enterprise',
    domain: 'communication',
    label: 'Enterprise',
    items: [
      {label: 'Overview', href: routes.enterprise.root, icon: iconGauge, exact: true},
      {label: 'Messenger', href: routes.enterprise.messenger, icon: iconChat},
      {label: 'Departments', href: routes.enterprise.departments, icon: iconTree},
      {label: 'Attendance', href: routes.enterprise.attendance, icon: iconCheckSquare},
      {label: 'Incident Reports', href: routes.enterprise.incidents, icon: iconAlertTri},
      {label: 'Join Requests', href: routes.enterprise.joinRequests, icon: iconInbox, badgeKey: 'enterprise'},
    ],
  },
  {
    key: 'people',
    domain: 'operations',
    label: 'People',
    items: [
      {label: 'Clients', href: routes.people.clients, icon: iconPerson, minRole: 'SUPERVISOR'},
      {label: 'Agents (CPOs)', href: routes.people.agents, icon: iconPeople},
      {label: 'Provider Agencies', href: routes.people.agencies, icon: iconBuilding},
      {label: 'Compliance', href: routes.people.compliance, icon: iconBadgeCheck},
      {label: 'All Users', href: routes.people.users, icon: iconDoc, minRole: 'SUPERVISOR'},
    ],
  },
  {
    key: 'config',
    domain: 'operations',
    label: 'App Configuration',
    minRole: 'SUPERVISOR',
    items: [
      {label: 'Status', href: routes.config.root, icon: iconSliders, exact: true},
      {label: 'Pricing Board', href: routes.config.pricing, icon: iconTag},
      {label: 'Regions', href: routes.config.regions, icon: iconGlobe},
      {label: 'Packages & Catalog', href: routes.config.packages, icon: iconBox},
      {label: 'Tier Grants', href: routes.config.tierGrants, icon: iconStar},
      {label: 'Switches', href: routes.config.switches, icon: iconSwitch},
      {label: 'Integrations', href: routes.config.integrations, icon: iconLock, minRole: 'ADMIN'},
    ],
  },
  {
    key: 'finance',
    domain: 'operations',
    label: 'Finance',
    minRole: 'SUPERVISOR',
    items: [
      {label: 'Overview', href: routes.finance.root, icon: iconTrend, exact: true},
      {label: 'Ledger', href: routes.finance.ledger, icon: iconLedger},
      {label: 'Escrow & Holds', href: routes.finance.escrow, icon: iconLock},
      {label: 'Payouts', href: routes.finance.payouts, icon: iconPayout},
      {label: 'Disputes', href: routes.finance.disputes, icon: iconScale},
      {label: 'Invoices', href: routes.finance.invoices, icon: iconInvoice},
      {label: 'Promos & Referrals', href: routes.finance.promos, icon: iconTag},
      {label: 'Wallet Adjustments', href: routes.finance.adjust, icon: iconAdjust},
    ],
  },
  {
    key: 'safety',
    domain: 'risk',
    label: 'Safety',
    items: [
      {label: 'SOS Log', href: routes.safety.sos, icon: iconSiren, badgeKey: 'safety'},
      {label: 'Biometric Guard', href: routes.safety.vbg, icon: iconFingerprint},
    ],
  },
  {
    key: 'internal',
    label: 'Internal',
    items: [
      {label: 'Admins', href: routes.internal.admins, icon: iconAdminKey, minRole: 'ADMIN'},
      {label: 'Audit Log', href: routes.internal.audit, icon: iconDoc, minRole: 'SUPERVISOR'},
      {label: 'Console', href: routes.internal.console, icon: iconTerminal},
    ],
  },
];

/** `/lite` must not stay lit on `/lite/bookings`; `/lite/dispatch` must, because
 *  its Requests/Test tabs are the same nav item. */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(item.href + '/');
}
