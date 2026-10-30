/**
 * Provider console — Org Chart and Bravo Feed pages (2026-10-31).
 *
 * Pins the endpoints (same ones the app uses), the module gates, that the feed
 * never fetches a news site from the browser, and the small helpers.
 */

import fs from 'fs';
import path from 'path';
import {
  FEED_CATEGORIES, FEED_COUNTRIES, categoryId, chartCounts, dutyLabel, feedQuery, initials,
  positionLabel, regionLabel, safeLink, severityOf, timeAgo, type OrgHierarchy,
} from '../lib/provider/api-intel';
import {PROVIDER_NAV} from '../lib/provider/nav';
import {pvRoutes} from '../lib/provider/routes';

const SRC = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const ORG_PAGE = 'app/provider/(app)/org-chart/page.tsx';
const FEED_PAGE = 'app/provider/(app)/feed/page.tsx';
const CLIENT = 'lib/provider/api-intel.ts';

describe('Org Chart and Bravo Feed — wiring', () => {
  it('both pages exist at the routes the rail links to, behind their modules', () => {
    const items = PROVIDER_NAV.flatMap(g => g.items);
    expect(items.find(i => i.href === pvRoutes.orgChart)?.modules).toEqual(['orgChart']);
    expect(items.find(i => i.href === pvRoutes.feed)?.modules).toEqual(['intel']);
    expect(fs.existsSync(path.join(SRC, ORG_PAGE))).toBe(true);
    expect(fs.existsSync(path.join(SRC, FEED_PAGE))).toBe(true);
  });

  it('the pages check the grant and show NotGranted otherwise', () => {
    const org = stripComments(read(ORG_PAGE));
    expect(org).toMatch(/can\('orgChart'\)/);
    expect(org).toMatch(/<NotGranted what="Org chart"\/>/);
    const feed = stripComments(read(FEED_PAGE));
    expect(feed).toMatch(/can\('intel'\)/);
    expect(feed).toMatch(/<NotGranted what="Bravo Feed"\/>/);
    for (const p of [org, feed]) expect(p.startsWith("'use client'")).toBe(true);
  });

  it('the client uses the app endpoints through the provider transport', () => {
    const api = stripComments(read(CLIENT));
    expect(api).toMatch(/from '@\/lib\/provider\/api'/);
    expect(api).toMatch(/get<OrgHierarchy>\('\/org\/hierarchy'\)/);
    expect(api).toMatch(/`\/org\/cpos\/\$\{encodeURIComponent\(memberUserId\)\}\/profile`/);
    expect(api).toMatch(/`\/news\/feed\?\$\{feedQuery\(category, country\)\}`/);
    // no raw fetch, no news-site hosts, no keys in the browser
    expect(api).not.toMatch(/\bfetch\(/);
    expect(api).not.toMatch(/guardianapis|reddit\.com|hacker-news|news\.google|api[-_]?key/i);
    expect(stripComments(read(FEED_PAGE))).not.toMatch(/\bfetch\(|https?:\/\//);
  });

  it('the profile is only fetched after someone asks for it (each view is logged)', () => {
    const org = stripComments(read(ORG_PAGE));
    expect(org).toMatch(/showProfile && <ProfileDetails/);
  });

  it('feed links open in a new tab without handing over the console window', () => {
    const feed = stripComments(read(FEED_PAGE));
    expect(feed).toMatch(/target="_blank" rel="noopener noreferrer"/);
    expect(feed).toMatch(/safeLink\(a\.url\)/);
  });

  it('no avatar images (the console only loads images from its own host)', () => {
    expect(stripComments(read(ORG_PAGE))).not.toMatch(/<img|avatar_url/);
  });
});

describe('org chart helpers', () => {
  const node = (over: Partial<OrgHierarchy['owner']>) => ({
    user_id: 'u', display_name: 'A B', email: null, avatar_url: null,
    position: 'CPO' as const, status: 'active', call_sign: null, on_duty: false, ...over,
  });

  it('plain-English positions and initials', () => {
    expect(positionLabel('CPO')).toBe('Officer');
    expect(positionLabel('Manager')).toBe('Manager');
    expect(initials('Jane van Dyke')).toBe('JD');
    expect(initials('Cher')).toBe('CH');
    expect(initials(null)).toBe('OF');
  });

  it('duty reads the toggle, but suspended or invited people are never on duty', () => {
    expect(dutyLabel(node({on_duty: true}))).toBe('On duty');
    expect(dutyLabel(node({on_duty: false}))).toBe('Off duty');
    expect(dutyLabel(node({on_duty: true, status: 'suspended'}))).toBe('Suspended');
    expect(dutyLabel(node({status: 'invited'}))).toMatch(/not accepted/);
    const h: OrgHierarchy = {
      owner: node({position: 'Owner', on_duty: true}),
      managers: [node({position: 'Manager', on_duty: true, status: 'suspended'})],
      members: [node({on_duty: true}), node({})],
    };
    expect(chartCounts(h)).toEqual({people: 4, onDuty: 2, suspended: 1});
  });
});

describe('feed helpers', () => {
  it('categories match the app News Filter, top first', () => {
    expect(FEED_CATEGORIES.map(c => c.id)).toEqual(
      ['top', 'world', 'business', 'finance', 'security', 'technology', 'energy', 'defence', 'aviation', 'realestate']);
    expect(categoryId('Risk & Safety')).toBe('security');
    expect(categoryId('Top Stories')).toBe('top');
    expect(categoryId('Sport')).toBe('');
  });

  it('countries: GLOBAL first, ISO codes only; unknown codes fall back to GLOBAL', () => {
    expect(FEED_COUNTRIES[0]).toBe('GLOBAL');
    expect(FEED_COUNTRIES.slice(1).every(c => /^[A-Z]{2}$/.test(c))).toBe(true);
    expect(feedQuery('security', 'AE')).toBe('categories=security&countries=AE');
    expect(feedQuery('top', 'ZZ')).toBe('categories=top&countries=GLOBAL');
    expect(regionLabel('GLOBAL')).toBe('Global');
    expect(regionLabel('')).toBe('Global');
    expect(regionLabel('AE')).toMatch(/Emirates|AE/);
  });

  it('levels follow the app headline estimate', () => {
    expect(severityOf('Two killed in attack', 'Top Stories')).toBe('critical');
    expect(severityOf('Protest planned downtown', 'Business')).toBe('high');
    expect(severityOf('Summit opens', 'World')).toBe('medium');
    expect(severityOf('Airline adds route', 'Aviation')).toBe('low');
  });

  it('only http(s) links are rendered', () => {
    expect(safeLink('https://example.com/a')).toBe('https://example.com/a');
    expect(safeLink('javascript:alert(1)')).toBeNull();
    expect(safeLink('data:text/html,x')).toBeNull();
    expect(safeLink('not a url')).toBeNull();
  });

  it('time ago', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    expect(timeAgo('2026-10-31T11:59:40Z', now)).toBe('just now');
    expect(timeAgo('2026-10-31T11:15:00Z', now)).toBe('45 min ago');
    expect(timeAgo('2026-10-31T09:00:00Z', now)).toBe('3 h ago');
    expect(timeAgo('2026-10-30T09:00:00Z', now)).toBe('1 day ago');
    expect(timeAgo('', now)).toBe('');
  });
});
