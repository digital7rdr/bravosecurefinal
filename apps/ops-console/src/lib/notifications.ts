/**
 * B-817 (founder, 2026-09-07) — "the notification is bad: when any new booking
 * comes a popup should come with a notification (overlay notification also),
 * all the meaningful notifications are needed, and from a notification you
 * can redirect to that page."
 *
 * The decisions — which feed rows are popup-worthy, what a row is titled, and
 * WHERE a click lands — are pure and live here so the node project executes
 * them. The server now stamps full ids in `metadata` (`booking_id`,
 * `mission_id`, `job_id`, `user_id`, …); `subject` is the 8-char short form
 * the feed displays and is never parsed for an id.
 */
import {routes, isExecutiveService} from './routes';

export interface FeedItem {
  id: number;
  kind: string;
  severity: 'info' | 'ok' | 'warn' | 'err';
  actor: string | null;
  subject: string | null;
  message: string;
  created_at: string;
  metadata?: Record<string, unknown> | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Human title for a feed row — the popup headline and the browser notification title. */
export function notificationTitle(item: Pick<FeedItem, 'kind' | 'severity'>): string {
  switch (item.kind) {
    case 'booking.request':      return 'New booking';
    case 'booking.approve':      return 'Booking approved';
    case 'booking.reject':       return 'Booking rejected';
    case 'booking.dispatch':     return 'Booking dispatched';
    case 'booking.complete':     return 'Booking completed';
    case 'dispatch.accept':      return 'Provider accepted';
    case 'dispatch.no_provider': return 'Dispatch failed';
    case 'job.publish':          return 'Job published';
    case 'application.submit':   return 'New job application';
    case 'mission.dispatch':     return 'Mission dispatched';
    case 'mission.pickup':       return 'Principal onboard';
    case 'mission.complete':     return 'Mission completed';
    case 'mission.abort':        return 'Mission aborted';
    case 'mission.reroute':      return 'Mission re-routed';
    case 'agent.approve':        return 'Partner approved';
    case 'agent.reject':         return 'Partner rejected';
    case 'agent.terminate':      return 'Agent terminated';
    case 'sos':                  return item.severity === 'err' ? 'SOS' : 'Safety alert';
    case 'protection':           return 'Secure Pro';
    case 'family':               return 'Family plan';
    default:                     return 'Ops activity';
  }
}

/**
 * Where a click on the row lands. `null` when the row carries nothing we can
 * route (an old row from before ids were stamped) — the caller renders it as
 * plain text, never a dead link.
 */
export function notificationHref(item: FeedItem): string | null {
  const m = item.metadata ?? {};
  const service = str(m.service);
  const bookingId = str(m.booking_id);
  const missionId = str(m.mission_id);
  const jobId = str(m.job_id);
  const userId = str(m.user_id);

  switch (item.kind) {
    case 'booking.request':
    case 'booking.approve':
    case 'booking.reject':
    case 'booking.complete':
    case 'dispatch.accept':
      return bookingId ? bookingHrefFor(bookingId, service) : null;
    case 'dispatch.no_provider':
      return bookingId ? bookingHrefFor(bookingId, service) : routes.lite.dispatch;
    case 'booking.dispatch':
    case 'mission.dispatch':
      return missionId ? missionHrefFor(missionId, service)
        : bookingId ? bookingHrefFor(bookingId, service) : null;
    case 'mission.pickup':
    case 'mission.complete':
    case 'mission.abort':
    case 'mission.reroute':
      return missionId ? missionHrefFor(missionId, service) : null;
    case 'job.publish':
    case 'application.submit':
      return jobId ? routes.lite.job(jobId) : routes.lite.jobs;
    case 'agent.approve':
    case 'agent.reject':
    case 'agent.terminate':
      return userId ? routes.people.agent(userId) : routes.people.agents;
    case 'sos':
      // A VBG breach (severity warn, source 'vbg') is worked on the VBG board;
      // every other SOS row is worked on the SOS log.
      return str(m.source) === 'vbg' ? routes.safety.vbg : routes.safety.sos;
    case 'protection': {
      // Critic P1 — `subject` is an APPLICATION id on five emits and a SESSION
      // id on four (CPO Protect activated + the three session sweeps), so it
      // cannot be routed by shape. Both stamp their id in metadata now.
      const session = str(m.session_id);
      if (session) return routes.pro.session(session);
      const app = str(m.application_id);
      return app ? routes.pro.application(app) : routes.pro.applications;
    }
    case 'family':
      return str(item.subject) ? routes.people.client(item.subject as string) : null;
    default:
      return null;
  }
}

function bookingHrefFor(id: string, service: string | null): string {
  return isExecutiveService(service) ? routes.executive.booking(id) : routes.lite.booking(id);
}
function missionHrefFor(id: string, service: string | null): string {
  return isExecutiveService(service) ? routes.executive.mission(id) : routes.lite.mission(id);
}

/**
 * Is this row worth interrupting the operator for? Everything in the feed is
 * ops-relevant, but a row describing the operator's OWN action (they just
 * clicked the button) is noise — the toast for that action already fired.
 */
export function isPopupWorthy(item: Pick<FeedItem, 'kind' | 'actor'>, myCallSign: string | null | undefined): boolean {
  if (myCallSign && item.actor && item.actor === myCallSign) return false;
  return true;
}

/**
 * How long a popup stays. An `err` row (a failed dispatch, an aborted mission)
 * stays until the operator closes it — those are the "meaningful" ones the
 * founder asked never to miss; a new booking gets 15 s; the rest 8 s.
 */
export function popupTtlMs(item: Pick<FeedItem, 'kind' | 'severity'>): number | null {
  if (item.severity === 'err') return null;
  if (item.kind === 'booking.request') return 15_000;
  return 8_000;
}

/**
 * The rows that arrived since the last poll, newest first, capped so a burst
 * (a reconnect after an hour away) never stacks fifty popups. The FIRST call
 * seeds the watermark and returns nothing: opening the console is not "fifty
 * new things happened".
 */
export function diffNewItems(
  items: FeedItem[],
  seen: Set<number>,
  opts: {seeded: boolean; cap?: number},
): FeedItem[] {
  const cap = opts.cap ?? 3;
  if (!opts.seeded) {
    for (const it of items) seen.add(it.id);
    return [];
  }
  const fresh = items
    .filter(it => !seen.has(it.id))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  for (const it of fresh) seen.add(it.id);
  return fresh.slice(0, cap);
}
