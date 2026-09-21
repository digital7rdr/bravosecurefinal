/**
 * IA-18 — the ops console's FIRST tests.
 *
 * The 2026-09-03 restructure moved 33 pages and re-grouped the whole rail. The
 * failure mode of a change that size is not a crash: it is a page that quietly
 * stops being reachable, a rail item pointing at a route that no longer exists,
 * or a role gate that drifts from the endpoint it mirrors. None of those show
 * up in a typecheck, a lint or a build.
 *
 * These are static scans over the route tree and the nav data — no rendering,
 * no DOM — so they run in the node project alongside the crypto suites.
 */

import fs from 'fs';
import path from 'path';
import {NAV_GROUPS, isNavItemActive} from '../lib/nav';
import {routes, REDIRECTS} from '../lib/routes';
import * as rbac from '../lib/rbac';

const APP_DIR = path.join(__dirname, '..', 'app');
const CONSOLE_DIR = path.join(APP_DIR, '(console)');
const SHELL = path.join(__dirname, '..', 'components', 'Shell.tsx');

/** Strip comments — prose naming a token must not satisfy a scan. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Every routable path under app/, with route groups "(x)" stripped. */
function routablePaths(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    if (!entry.isDirectory()) {
      if (entry.name === 'page.tsx') out.push(prefix === '' ? '/' : prefix);
      continue;
    }
    // A "(group)" folder does not appear in the URL.
    const segment = entry.name.startsWith('(') && entry.name.endsWith(')')
      ? prefix
      : `${prefix}/${entry.name}`;
    out.push(...routablePaths(path.join(dir, entry.name), segment));
  }
  return out;
}

/** '/lite/bookings/[id]' -> '/lite/bookings/:id' so it can be compared. */
function toParamForm(p: string): string {
  return p.replace(/\[(\w+)\]/g, ':$1');
}

const ALL_ROUTES = routablePaths(APP_DIR).map(toParamForm);

describe('nav tree ↔ route tree', () => {
  it('every nav item points at a page that exists', () => {
    const missing: string[] = [];
    for (const g of NAV_GROUPS) {
      for (const item of g.items) {
        if (!ALL_ROUTES.includes(item.href)) missing.push(`${g.label} · ${item.label} → ${item.href}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every console page is reachable from the rail or from a page that is', () => {
    // A page counts as reachable when a nav item points at it, at one of its
    // ancestors (a tab or a detail route of a listed item), or it is a dynamic
    // detail route whose parent list is listed.
    const navHrefs = NAV_GROUPS.flatMap(g => g.items.map(i => i.href));
    const consoleRoutes = routablePaths(CONSOLE_DIR).map(toParamForm);
    const orphans = consoleRoutes.filter(r =>
      !navHrefs.some(h => r === h || r.startsWith(h + '/')),
    );
    expect(orphans).toEqual([]);
  });

  it('no two nav items share a label inside a group, and no href is listed twice', () => {
    const hrefs = NAV_GROUPS.flatMap(g => g.items.map(i => i.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const g of NAV_GROUPS) {
      const labels = g.items.map(i => i.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  /**
   * IA-02 — the founder's actual complaint. "Pro" meant three different things
   * (the messenger tier, the Secure Pro plan product, and the Pro delivery
   * org), so a label containing a bare "Pro" is banned: it must be qualified.
   */
  it('no nav label uses the bare word "Pro"', () => {
    const offenders: string[] = [];
    for (const g of NAV_GROUPS) {
      for (const item of g.items) {
        const text = `${g.label} ${item.label}`;
        if (/\bPro\b/.test(text) && !/Secure Pro|Messenger Pro/.test(text)) {
          offenders.push(`${g.label} · ${item.label}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('section landings do not stay highlighted on their children', () => {
    const liteRoot = NAV_GROUPS.find(g => g.key === 'lite')!.items.find(i => i.exact)!;
    expect(isNavItemActive(liteRoot, '/lite')).toBe(true);
    expect(isNavItemActive(liteRoot, '/lite/bookings')).toBe(false);

    // A tabbed item DOES stay lit for its own tabs.
    const dispatch = NAV_GROUPS.find(g => g.key === 'lite')!.items.find(i => i.href === routes.lite.dispatch)!;
    expect(isNavItemActive(dispatch, '/lite/dispatch/requests')).toBe(true);
  });
});

describe('role gating', () => {
  it('the config, finance and audit surfaces stay SUPERVISOR+, admins ADMIN', () => {
    const config = NAV_GROUPS.find(g => g.key === 'config')!;
    const finance = NAV_GROUPS.find(g => g.key === 'finance')!;
    expect(config.minRole).toBe('SUPERVISOR');
    expect(finance.minRole).toBe('SUPERVISOR');

    const internal = NAV_GROUPS.find(g => g.key === 'internal')!;
    expect(internal.items.find(i => i.href === routes.internal.admins)!.minRole).toBe('ADMIN');
    expect(internal.items.find(i => i.href === routes.internal.audit)!.minRole).toBe('SUPERVISOR');
  });

  it('an OPS operator sees no configuration or finance item', () => {
    const visible = NAV_GROUPS
      .filter(g => !g.minRole || rbac.hasRole('OPS', g.minRole))
      .flatMap(g => g.items.filter(i => !i.minRole || rbac.hasRole('OPS', i.minRole)).map(i => i.href));
    expect(visible).not.toContain(routes.config.pricing);
    expect(visible).not.toContain(routes.finance.ledger);
    expect(visible).not.toContain(routes.internal.admins);
    // …but they keep every operational surface.
    expect(visible).toContain(routes.lite.bookings);
    expect(visible).toContain(routes.safety.sos);
  });

  it('the review-hold exit is gated at SUPERVISOR, matching its endpoint', () => {
    // Mirrors @RequireRoles('SUPERVISOR','ADMIN') on
    // POST /ops/bookings/:id/resolve-review.
    expect(rbac.canResolveReviewHold('OPS')).toBe(false);
    expect(rbac.canResolveReviewHold('SUPERVISOR')).toBe(true);
    expect(rbac.canResolveReviewHold('ADMIN')).toBe(true);
  });

  it('the SOS lane is gated at SUPERVISOR, matching its endpoints', () => {
    // E2E-18 — full reasoning + the endpoint citations in opsGates.test.ts.
    // Repeated here because this describe block is where a future gate change
    // is most likely to be made.
    expect(rbac.canAckSos('OPS')).toBe(false);
    expect(rbac.canAckSos('SUPERVISOR')).toBe(true);
  });

  it('enterprise join decisions are closed until the product question is answered', () => {
    // Audit §11 Q5. If this ever returns true, the console must also have an
    // endpoint to call — flipping it alone would render a button that 404s.
    expect(rbac.canDecideJoinRequest('ADMIN')).toBe(false);
  });
});

describe('redirects from the pre-restructure URLs', () => {
  it('every old path redirects to a route that exists', () => {
    const broken = REDIRECTS.filter(r => !ALL_ROUTES.includes(r.destination));
    expect(broken).toEqual([]);
  });

  it('covers every flat route the console used to serve', () => {
    const old = [
      '/bookings', '/bookings/:id', '/jobs', '/jobs/:id', '/dispatch',
      '/dispatch-inspector', '/dispatch-inspector/:id', '/live', '/live/:id',
      '/live/wall', '/pro-applications', '/pro-applications/:id',
      '/pro-management', '/protection', '/agents', '/agents/:id', '/users',
      '/users/:id', '/compliance', '/settings', '/referral-codes', '/sos',
      '/vbg', '/incidents', '/messenger', '/departments', '/dept-attendance',
      '/audit', '/admins',
    ];
    const sources = REDIRECTS.map(r => r.source);
    expect(old.filter(o => !sources.includes(o))).toEqual([]);
  });

  it('no redirect source is still a live route (that would be a loop)', () => {
    const loops = REDIRECTS.filter(r => ALL_ROUTES.includes(r.source));
    expect(loops).toEqual([]);
  });
});

/**
 * B-841 (founder, 2026-09-10) — the sidebar read "SECURE PRO 2 / Applications 2"
 * while the Applications page said "NEW 0 · QUEUE CLEAR". The 2 was
 * `pro_pending + pro_requests`: protection-DATE reservations awaiting officers,
 * a queue that lives on /pro/assignments, summed into the Applications badge.
 * An item badge must mean the page's OWN queue.
 */
describe('B-841 — every badge names the queue on its own page', () => {
  const pro = NAV_GROUPS.find(g => g.key === 'pro')!;

  it('Applications carries the applications badge; Assignments the date-requests one', () => {
    expect(pro.items.find(i => i.href === routes.pro.applications)!.badgeKey).toBe('pro');
    expect(pro.items.find(i => i.href === routes.pro.assignments)!.badgeKey).toBe('proRequests');
  });

  it('no GROUP carries a badgeKey — a group badge is the sum of its visible items', () => {
    // Two mechanisms for one number is how the Pro badge drifted from its page:
    // the group key said "pro" and so did an item, and only one of them moved.
    const withKey = NAV_GROUPS.filter(g => Object.keys(g).includes('badgeKey')).map(g => g.key);
    expect(withKey).toEqual([]);
  });

  it('Shell gives proRequests its own KPI and sums nothing into pro', () => {
    const lines = stripComments(fs.readFileSync(SHELL, 'utf8')).split(/\r?\n/);
    // Self-check: the tokens the absence assertion is about DO occur here.
    expect(lines.some(l => l.includes('navBadges'))).toBe(true);
    expect(lines.some(l => l.includes('pro_pending'))).toBe(true);
    expect(lines.some(l => l.includes('pro_requests'))).toBe(true);

    expect(lines.filter(l => /^\s*pro:\s*k\?\.pro_pending \?\? 0,\s*$/.test(l))).toHaveLength(1);
    expect(lines.filter(l => /^\s*proRequests:\s*k\?\.pro_requests \?\? 0,\s*$/.test(l))).toHaveLength(1);
    // THE BUG: `pro: (k?.pro_pending ?? 0) + (k?.pro_requests ?? 0)`.
    expect(lines.filter(l => l.includes('pro_pending') && l.includes('pro_requests'))).toEqual([]);
  });

  it('the group badge is summed from the ROLE-FILTERED items, not a group key', () => {
    const src = stripComments(fs.readFileSync(SHELL, 'utf8'));
    expect(src).toMatch(
      /const groupBadge = items\.reduce\(\(n, i\) => n \+ \(i\.badgeKey \? navBadges\[i\.badgeKey\] \?\? 0 : 0\), 0\);/,
    );
    expect(src).not.toMatch(/navBadges\[g\.badgeKey\]/);
  });

  it('every badgeKey a nav item uses is wired in Shell', () => {
    const src = stripComments(fs.readFileSync(SHELL, 'utf8'));
    const keys = new Set(NAV_GROUPS.flatMap(g => g.items.map(i => i.badgeKey).filter(Boolean)));
    expect(keys.size).toBeGreaterThan(0);
    for (const k of keys) expect(src).toMatch(new RegExp(`^\\s*${k}:\\s`, 'm'));
  });
});
