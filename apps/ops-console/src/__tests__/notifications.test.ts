/**
 * B-817 (founder, 2026-09-07) — "the notification is bad: when any new booking
 * comes a popup should come with a notification (overlay notification also),
 * all the meaningful notifications are needed, and from a notification you
 * can redirect to that page."
 *
 * Behaviour is asserted where it is pure (`lib/notifications.ts`); the wiring
 * — the notifier mounted in the Shell, the bell rows as links, the server
 * stamping the ids the links need — is pinned by source scan, comments
 * stripped, CRLF normalised, anchored on the decision sites.
 */
import fs from 'fs';
import path from 'path';
import {
  diffNewItems, isPopupWorthy, notificationHref, notificationTitle, popupTtlMs, type FeedItem,
} from '../lib/notifications';
import {routes} from '../lib/routes';

const row = (over: Partial<FeedItem> & {kind: string}): FeedItem => ({
  id: 1, severity: 'info', actor: null, subject: 'abcd1234', message: 'm',
  created_at: '2026-09-07T10:00:00.000Z', metadata: null, ...over,
});

const BOOKING = '11111111-2222-3333-4444-555555555555';
const MISSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('notificationHref — every row lands on the page that works it', () => {
  it('a NEW booking links to its booking page, product-aware', () => {
    expect(notificationHref(row({kind: 'booking.request', metadata: {booking_id: BOOKING, service: 'secure_transfer'}})))
      .toBe(routes.lite.booking(BOOKING));
    expect(notificationHref(row({kind: 'booking.request', metadata: {booking_id: BOOKING, service: 'executive_protection'}})))
      .toBe(routes.executive.booking(BOOKING));
  });

  it('approve / reject / complete / provider-accepted all land on the booking', () => {
    for (const kind of ['booking.approve', 'booking.reject', 'booking.complete', 'dispatch.accept']) {
      expect(notificationHref(row({kind, metadata: {booking_id: BOOKING}}))).toBe(routes.lite.booking(BOOKING));
    }
  });

  it('a dispatch that produced a mission prefers the mission page; a failed cascade falls back to the dispatch board', () => {
    expect(notificationHref(row({kind: 'booking.dispatch', metadata: {booking_id: BOOKING, mission_id: MISSION}})))
      .toBe(routes.lite.mission(MISSION));
    expect(notificationHref(row({kind: 'mission.dispatch', metadata: {mission_id: MISSION, service: 'executive_protection'}})))
      .toBe(routes.executive.mission(MISSION));
    expect(notificationHref(row({kind: 'dispatch.no_provider', metadata: {}}))).toBe(routes.lite.dispatch);
  });

  it('mission lifecycle rows link to the mission; jobs to the job; partners to the agent', () => {
    for (const kind of ['mission.pickup', 'mission.complete', 'mission.abort', 'mission.reroute']) {
      expect(notificationHref(row({kind, metadata: {mission_id: MISSION}}))).toBe(routes.lite.mission(MISSION));
    }
    expect(notificationHref(row({kind: 'job.publish', metadata: {job_id: 'j1'}}))).toBe(routes.lite.job('j1'));
    expect(notificationHref(row({kind: 'application.submit', metadata: null}))).toBe(routes.lite.jobs);
    expect(notificationHref(row({kind: 'agent.approve', metadata: {user_id: 'u1'}}))).toBe(routes.people.agent('u1'));
    expect(notificationHref(row({kind: 'agent.terminate', metadata: {}}))).toBe(routes.people.agents);
  });

  it('SOS rows go to the SOS log; a VBG breach to the VBG board; Secure Pro to the application', () => {
    expect(notificationHref(row({kind: 'sos', severity: 'err', metadata: {source: 'client'}}))).toBe(routes.safety.sos);
    expect(notificationHref(row({kind: 'sos', severity: 'warn', metadata: {source: 'vbg'}}))).toBe(routes.safety.vbg);
    // Critic P1 — a session row must land on the SESSION page, an application
    // row on the application, and the id comes from metadata, never the subject.
    expect(notificationHref(row({kind: 'protection', subject: BOOKING, metadata: {session_id: MISSION}}))).toBe(routes.pro.session(MISSION));
    expect(notificationHref(row({kind: 'protection', subject: BOOKING, metadata: {application_id: BOOKING}}))).toBe(routes.pro.application(BOOKING));
    expect(notificationHref(row({kind: 'protection', subject: BOOKING, metadata: null}))).toBe(routes.pro.applications);
  });

  it('a pre-stamp row (no ids) is NOT a link — never a dead click, never an id parsed from the short subject', () => {
    expect(notificationHref(row({kind: 'booking.reject', subject: 'abcd1234', metadata: null}))).toBeNull();
    expect(notificationHref(row({kind: 'mission.complete', subject: 'BRV-01', metadata: {}}))).toBeNull();
    expect(notificationHref(row({kind: 'something.new'}))).toBeNull();
  });
});

describe('titles, popup worthiness and stay time', () => {
  it('titles the founder-named case as "New booking" and has a title for every emitted kind', () => {
    expect(notificationTitle(row({kind: 'booking.request'}))).toBe('New booking');
    for (const kind of ['booking.approve', 'dispatch.no_provider', 'application.submit', 'mission.abort', 'agent.approve', 'protection']) {
      expect(notificationTitle(row({kind}))).not.toBe('Ops activity');
    }
    expect(notificationTitle(row({kind: 'sos', severity: 'err'}))).toBe('SOS');
  });

  it('the operator’s OWN action is not popped back at them; everyone else’s is', () => {
    expect(isPopupWorthy({kind: 'booking.approve', actor: 'ALPHA'}, 'ALPHA')).toBe(false);
    expect(isPopupWorthy({kind: 'booking.approve', actor: 'ALPHA'}, 'BRAVO')).toBe(true);
    expect(isPopupWorthy({kind: 'booking.request', actor: null}, 'ALPHA')).toBe(true);
  });

  it('a new booking stays 15 s; an error row stays until dismissed; the rest 8 s', () => {
    expect(popupTtlMs({kind: 'booking.request', severity: 'warn'})).toBe(15_000);
    expect(popupTtlMs({kind: 'dispatch.no_provider', severity: 'err'})).toBeNull();
    expect(popupTtlMs({kind: 'mission.abort', severity: 'err'})).toBeNull();
    expect(popupTtlMs({kind: 'mission.pickup', severity: 'ok'})).toBe(8_000);
  });
});

describe('diffNewItems — opening the console is not "fifty new things happened"', () => {
  const at = (id: number, s: number) => row({id, kind: 'booking.request', created_at: `2026-09-07T10:00:${String(s).padStart(2, '0')}.000Z`});

  it('the first poll only seeds the watermark', () => {
    const seen = new Set<number>();
    expect(diffNewItems([at(1, 1), at(2, 2)], seen, {seeded: false})).toEqual([]);
    expect(seen.has(1) && seen.has(2)).toBe(true);
  });

  it('later polls return only unseen rows, newest first, and remember them', () => {
    const seen = new Set<number>([1, 2]);
    const out = diffNewItems([at(4, 4), at(3, 3), at(2, 2), at(1, 1)], seen, {seeded: true});
    expect(out.map(r => r.id)).toEqual([4, 3]);
    expect(diffNewItems([at(4, 4), at(3, 3)], seen, {seeded: true})).toEqual([]);
  });

  it('a burst is capped — but EVERY row is still marked seen so the rest never pop later', () => {
    const seen = new Set<number>();
    diffNewItems([], seen, {seeded: false});
    const burst = Array.from({length: 10}, (_, i) => at(i + 1, i + 1));
    expect(diffNewItems(burst, seen, {seeded: true, cap: 3})).toHaveLength(3);
    expect(seen.size).toBe(10);
  });
});

/** Strip comments — prose naming a token is the classic false result. */
function code(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('wiring (source scans)', () => {
  it('the Shell mounts the notifier ONCE and feeds the bell from the 50-row hidden-tab poll', () => {
    const shell = code('apps/ops-console/src/components/Shell.tsx');
    expect(shell.match(/<OpsNotifier \/>/g)).toHaveLength(1);
    expect(shell).toMatch(/const \{data: feed\} = useActivity\(50\);/);
    expect(shell).toMatch(/<NotificationBell activity=\{activity\}/);
  });

  it('useActivity keeps polling while hidden — the overlay for a backgrounded console is the point', () => {
    const api = code('apps/ops-console/src/lib/api.ts');
    const hook = api.slice(api.indexOf('export function useActivity('));
    expect(hook.slice(0, 600)).toMatch(/refreshWhenHidden: true/);
  });

  it('bell rows are links when routable and plain text otherwise; the notifier never pops an SOS (the bar owns it)', () => {
    const bell = code('apps/ops-console/src/components/NotificationBell.tsx');
    expect(bell).toMatch(/const href = notificationHref\(ev\);/);
    expect(bell).toMatch(/return href \? \(\s*<Link key=\{ev\.id\} href=\{href\}/);
    const notifier = code('apps/ops-console/src/components/OpsNotifier.tsx');
    expect(notifier).toMatch(/if \(it\.kind === 'sos' && it\.severity === 'err'\) continue;/);
    expect(notifier).toMatch(/if \(document\.visibilityState === 'visible'\) return;/);
    expect(notifier).toMatch(/tag: `bravo-ops-feed-\$\{it\.id\}`/);
  });

  it('a toast can carry a link, a title and a sticky ttl', () => {
    const toast = code('apps/ops-console/src/components/Toast.tsx');
    expect(toast).toMatch(/href\?: string;/);
    expect(toast).toMatch(/ttlMs\?: number \| null;/);
    expect(toast).toMatch(/if \(ttl === null\) return;/);
    // The close control is a SIBLING of the link (a button inside an anchor is
    // invalid), and it renders on every toast so a sticky one can be closed.
    expect(toast).toMatch(/<Link href=\{t\.href\}[\s\S]{0,200}?<\/Link>\s*\) : inner\}\s*\{close\}/);
    expect(toast).not.toMatch(/<Link[^>]*>[\s\S]{0,300}?\{close\}[\s\S]{0,100}?<\/Link>/);
  });

  it('SERVER: the feed is region-scoped for a region-scoped admin (critic P1)', () => {
    const audit = code('apps/auth-service/src/ops/ops-audit.service.ts');
    expect(audit).toMatch(/recentFeed\(limit = 50, region: string \| null = null\)/);
    expect(audit).toMatch(/OR metadata->>'region' = \$2::text/);
    const ctrl = code('apps/auth-service/src/ops/ops.controller.ts');
    expect(ctrl).toMatch(/const region = isGlobalAdmin\(req\.admin\) \? null : \(req\.admin\.region \|\| null\);/);
    expect(ctrl).toMatch(/recentFeed\(Number\(limit\) \|\| 50, region\)/);
  });

  it('SERVER: every Secure Pro emit stamps session_id or application_id (critic P1)', () => {
    const prot = code('apps/auth-service/src/protection/protection.service.ts');
    expect(prot.match(/jsonb_build_object\('session_id', id\)/g)).toHaveLength(3);
    expect(prot).toMatch(/metadata: \{session_id: sessionId\}/);
    expect(prot).toMatch(/metadata: \{application_id: applicationId\}/);
    const apps = code('apps/auth-service/src/pro-applications/pro-applications.service.ts');
    expect(apps.match(/application_id: (row\.id|id|applicationId)\}/g)).toHaveLength(3);
    const act = code('apps/auth-service/src/pro-management/pro-mission-activation.service.ts');
    expect(act.match(/application_id: m\.application_id\}/g)).toHaveLength(2);
  });

  it('SERVER: a new booking writes a feed row, and every booking/mission/job/agent emit stamps the id the link needs', () => {
    const booking = code('apps/auth-service/src/booking/booking.service.ts');
    expect(booking).toMatch(/kind: 'booking\.request', severity: 'warn'/);
    expect(booking).toMatch(/INSERT INTO live_feed_events \(kind, severity, actor, subject, message, metadata\)/);
    const ops = code('apps/auth-service/src/ops/ops.service.ts');
    for (const kind of ['booking.reject', 'booking.dispatch', 'booking.approve']) {
      const at = ops.indexOf(`kind: '${kind}'`);
      expect(at).toBeGreaterThan(-1);
      expect(ops.slice(at, at + 600)).toMatch(/metadata: \{booking_id: bookingId/);
    }
    expect(ops.match(/kind: 'booking\.complete'[\s\S]{0,400}?metadata: \{booking_id: bookingId\}/g)).toHaveLength(2);
    for (const kind of ['agent.approve', 'agent.reject', 'agent.terminate']) {
      const at = ops.indexOf(`kind: '${kind}'`);
      expect(ops.slice(at, at + 400)).toMatch(/metadata: \{user_id: userId\}/);
    }
    const mission = code('apps/auth-service/src/ops/mission.service.ts');
    for (const kind of ['mission.pickup', 'mission.complete', 'mission.abort', 'mission.reroute']) {
      const at = mission.indexOf(`kind: '${kind}'`);
      expect(at).toBeGreaterThan(-1);
      expect(mission.slice(at, at + 500)).toMatch(/metadata: \{mission_id: missionId, booking_id: (m|mission)\.booking_id\}/);
    }
    const jobs = code('apps/auth-service/src/ops/job-feed.service.ts');
    expect(jobs).toMatch(/kind: 'job\.publish'[\s\S]{0,400}?metadata: \{job_id: job\.id, booking_id: bookingId\}/);
    expect(jobs).toMatch(/kind: 'mission\.dispatch'[\s\S]{0,400}?metadata: \{mission_id: mission\.id/);
    const dispatch = code('apps/auth-service/src/dispatch/dispatch.service.ts');
    expect(dispatch).toMatch(/kind: 'dispatch\.no_provider', severity: 'err'/);
    expect(dispatch).toMatch(/kind: 'dispatch\.accept', severity: 'ok'/);
  });
});
