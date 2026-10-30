/**
 * Service Provider Console — Org Chart and Bravo Feed (2026-10-31).
 *
 * The web side of two agency dashboard rows in the app:
 *
 *  - Org Chart (OrgHierarchyScreen): GET /org/hierarchy, the owner → managers
 *    → officers tiers, each with status, call sign and the on-duty toggle.
 *    Tapping someone in the app opens their profile: GET
 *    /org/cpos/:id/profile (the server records who opened it).
 *    Both sit behind OrgManagerGuard + @OrgModules, so the agency comes from
 *    X-Org-Context and a manager needs the orgChart grant.
 *
 *  - Bravo Feed (the app's Messenger "News" tab → Bravo Feed): the app blends
 *    the server feed with sources it fetches from the phone. The console only
 *    uses the SERVER feed, GET /news/feed (Google News + the curated outlet
 *    directory, at most 72 hours old, cached 15 min upstream). Nothing in the
 *    browser talks to a news site or holds a news API key.
 *
 * Calls go through `get` from api.ts, so they carry the provider cookie
 * session, CSRF and the agency context like every other console call.
 */

import {get, useOrgSWR} from '@/lib/provider/api';

/* ── Org chart ───────────────────────────────────────────────────────── */

export type OrgPosition = 'Owner' | 'Manager' | 'CPO' | 'Employee';

export interface OrgHierarchyNode {
  user_id: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  position: OrgPosition;
  /** 'active' | 'invited' | 'suspended' (removed members are not returned). */
  status: string;
  call_sign: string | null;
  /** The member's own on-duty toggle, not "has the app open". */
  on_duty: boolean;
}

export interface OrgHierarchy {
  owner: OrgHierarchyNode;
  managers: OrgHierarchyNode[];
  members: OrgHierarchyNode[];
}

/** The parts of GET /org/cpos/:id/profile the console shows. */
export interface OrgMemberProfile {
  member_user_id: string;
  display_name: string | null;
  email: string | null;
  phone_e164: string | null;
  call_sign: string | null;
  member_role: 'cpo' | 'manager' | 'employee' | 'owner';
  status: string;
  rating?: number | null;
  armed_authorized?: boolean;
  armed_expires_at?: string | null;
  on_duty?: boolean;
  on_mission?: boolean;
  created_at?: string | null;
  suspended_until?: string | null;
  suspend_reason?: string | null;
  stats?: {missions_total: number; missions_completed: number; missions_led: number};
}

/** Plain-English position: the app's "CPO" reads as "Officer" here. */
export function positionLabel(p: OrgPosition | string): string {
  switch (p) {
    case 'Owner': return 'Owner';
    case 'Manager': return 'Manager';
    case 'Employee': return 'Employee';
    default: return 'Officer';
  }
}

export function initials(name: string | null): string {
  const p = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return 'OF';
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

export function dutyLabel(n: Pick<OrgHierarchyNode, 'on_duty' | 'status'>): string {
  if (n.status === 'invited') return 'Invite not accepted yet';
  if (n.status === 'suspended') return 'Suspended';
  return n.on_duty ? 'On duty' : 'Off duty';
}

/** Counts for the header line. Suspended or invited people are never "on duty". */
export function chartCounts(h: OrgHierarchy): {people: number; onDuty: number; suspended: number} {
  const all = [h.owner, ...h.managers, ...h.members];
  return {
    people: all.length,
    onDuty: all.filter(n => n.on_duty && n.status === 'active').length,
    suspended: all.filter(n => n.status === 'suspended').length,
  };
}

export const pvOrgChartApi = {
  hierarchy: () => get<OrgHierarchy>('/org/hierarchy'),
  profile: (memberUserId: string) =>
    get<OrgMemberProfile>(`/org/cpos/${encodeURIComponent(memberUserId)}/profile`),
};

export const usePvHierarchy = (org: string | null, on = true) =>
  useOrgSWR(on ? 'org-hierarchy' : null, org, pvOrgChartApi.hierarchy, {refreshInterval: 60_000});

/** Only fetched when someone asks for the profile: the server logs each view. */
export const usePvMemberProfile = (org: string | null, memberUserId: string | null) =>
  useOrgSWR(memberUserId ? `member-profile:${memberUserId}` : null, org,
    () => pvOrgChartApi.profile(memberUserId as string),
    {refreshInterval: 0, revalidateOnFocus: false});

/* ── Bravo Feed ──────────────────────────────────────────────────────── */

export interface NewsArticle {
  id: string;
  title: string;
  summary: string;
  url: string;
  source: string;
  /** 'GLOBAL' or an ISO country code. */
  region: string;
  /** Display label, e.g. 'Risk & Safety'. */
  category: string;
  /** ISO time, '' when the source gave none. */
  published_at: string;
}

/** The same categories, in the same order, as the app's News Filter. */
export const FEED_CATEGORIES = [
  {id: 'top', label: 'Top Stories'},
  {id: 'world', label: 'World'},
  {id: 'business', label: 'Business'},
  {id: 'finance', label: 'Finance'},
  {id: 'security', label: 'Risk & Safety'},
  {id: 'technology', label: 'Technology'},
  {id: 'energy', label: 'Energy'},
  {id: 'defence', label: 'Defence'},
  {id: 'aviation', label: 'Aviation'},
  {id: 'realestate', label: 'Real Estate'},
] as const;
export type FeedCategory = (typeof FEED_CATEGORIES)[number]['id'];

/** The app's country list (newsPrefs.ts), GLOBAL first. The server ignores anything else. */
export const FEED_COUNTRIES: readonly string[] = (
  'GLOBAL AF AL DZ AD AO AG AR AM AU AT AZ BS BH BD BB BY BE BZ BJ BT BO BA BW BR BN BG BF BI KH CM CA CV CF TD CL CN CO KM CG CR HR CU CY CZ CD DK DJ DM DO EC EG SV GQ ER EE SZ ET FJ FI FR GA GM GE DE GH GR GD GT GN GW GY HT HN HK HU IS IN ID IR IQ IE IL IT CI JM JP JO KZ KE KI XK KW KG LA LV LB LS LR LY LI LT LU MG MW MY MV ML MT MH MR MU MX FM MD MC MN ME MA MZ MM NA NR NP NL NZ NI NE NG KP MK NO OM PK PW PS PA PG PY PE PH PL PT QA RO RU RW KN LC VC WS SM ST SA SN RS SC SL SG SK SI SB SO ZA KR SS ES LK SD SR SE CH SY TW TJ TZ TH TL TG TO TT TN TR TM TV AE GB UG UA US UY UZ VU VE VN YE ZM ZW'
).split(' ');

let regionNames: Intl.DisplayNames | null | undefined;

/** 'GLOBAL' → 'Global', 'AE' → 'United Arab Emirates'; unknown codes as they are. */
export function regionLabel(code: string): string {
  const c = (code || 'GLOBAL').toUpperCase();
  if (c === 'GLOBAL') return 'Global';
  if (regionNames === undefined) {
    try { regionNames = new Intl.DisplayNames(['en'], {type: 'region'}); } catch { regionNames = null; }
  }
  try { return regionNames?.of(c) ?? c; } catch { return c; }
}

/** Server category label → id ('Risk & Safety' → 'security'); '' when unknown. */
export function categoryId(label: string): string {
  const l = (label || '').trim().toLowerCase();
  return FEED_CATEGORIES.find(c => c.label.toLowerCase() === l || c.id === l)?.id ?? '';
}

export type Severity = 'critical' | 'high' | 'medium' | 'low';

/**
 * The app's headline heuristic (src/modules/news/geotag.ts severityFor), so
 * the same story carries the same level on both. It is a keyword estimate,
 * not an assessment, and the page says so.
 */
export function severityOf(title: string, category: string): Severity {
  const t = title.toLowerCase();
  if (/\b(killed|attack|strike|bomb|ballistic|shooting|massacre|crisis|emergency)\b/.test(t)) return 'critical';
  if (/\b(protest|riot|threat|sanction|war|violence|clash|unrest)\b/.test(t)) return 'high';
  const id = categoryId(category);
  if (id === 'world') return 'medium';
  return 'low';
}

export const SEVERITY_LABEL: Record<Severity, string> = {critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low'};
export const SEVERITY_TONE: Record<Severity, 'err' | 'warn' | 'info' | 'muted'> = {
  critical: 'err', high: 'warn', medium: 'info', low: 'muted',
};

/** Only http(s) links are ever rendered as an href. */
export function safeLink(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch { return null; }
}

/** "5 min ago", "3 h ago", "2 days ago"; '' when the date is missing or bad. */
export function timeAgo(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const m = Math.max(0, Math.floor((now - ms) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** Query string for /news/feed. GLOBAL with no country means the world edition. */
export function feedQuery(category: FeedCategory, country: string): string {
  const p = new URLSearchParams();
  p.set('categories', category);
  p.set('countries', FEED_COUNTRIES.includes(country) ? country : 'GLOBAL');
  return p.toString();
}

export const pvIntelApi = {
  feed: (category: FeedCategory, country: string) =>
    get<{articles: NewsArticle[]}>(`/news/feed?${feedQuery(category, country)}`),
};

/** The server caches each pair for 15 minutes and allows 20 reads a minute per user. */
export const usePvFeed = (org: string | null, category: FeedCategory, country: string, on = true) =>
  useOrgSWR(on ? `feed:${category}:${country}` : null, org, () => pvIntelApi.feed(category, country),
    {refreshInterval: 5 * 60_000, revalidateOnFocus: false});
