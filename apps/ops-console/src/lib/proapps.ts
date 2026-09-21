import type {ProApplicationRow, ProApplicationStatus} from '@/lib/api';
// RELATIVE, not `@/lib/datetime`: the node test project transforms through the
// repo-root babel config, whose module-resolver rewrites `@/` to the MOBILE
// `src/` before Jest's own mapper is consulted — a value import through the
// alias makes every suite that reaches this module fail to resolve. (Type-only
// imports are erased, which is why line 1 is fine.)
import {utcDayDelta} from './datetime';

// Presentation helpers shared by the Pro Applications list + detail pages.

export function proStatusTone(status: ProApplicationStatus): string {
  switch (status) {
    case 'PENDING_PROPOSAL':
    case 'REVISION_REQUESTED': return 'warn';
    case 'PROPOSAL_CREATED':   return 'info';
    case 'ACCEPTED':           return 'ok';
    case 'ACTIVE':             return 'live';
    case 'EXPIRED':            return 'warn';
    case 'REJECTED':           return 'err';
    case 'CANCELLED':          return 'err';
  }
}

/**
 * B-819 — the review queue's own vocabulary.
 *
 * The two buckets below are the ones that are waiting on OPS; everything else
 * is waiting on the client, running, or closed. The page leads with these,
 * counts them separately, and ages them — on a queue, "how long has this sat
 * here" is the fact that decides what an operator opens next, and the list
 * used to show only an absolute timestamp.
 */
export const PRO_ACTIONABLE_STATUSES: ProApplicationStatus[] = ['PENDING_PROPOSAL', 'REVISION_REQUESTED'];

export function isProActionable(status: ProApplicationStatus): boolean {
  return PRO_ACTIONABLE_STATUSES.includes(status);
}

/** Whole days an application has been waiting, floored at 0 (a clock-skewed
 *  future timestamp reads "today", never "-1 days"). */
export function waitingDays(submittedAt: string, now: Date = new Date()): number {
  return Math.max(0, -utcDayDelta(submittedAt, now));
}

export function waitingLabel(days: number): string {
  if (days <= 0) return 'today';
  return days === 1 ? '1 day' : `${days} days`;
}

/** Past this, an application waiting on ops is called out in amber. */
export const PRO_STALE_DAYS = 3;

/** Amber only where the operator can actually act — an ACTIVE plan that
 *  started months ago is not "late". */
export function isProStale(row: Pick<ProApplicationRow, 'status' | 'submitted_at'>, now: Date = new Date()): boolean {
  return isProActionable(row.status) && waitingDays(row.submitted_at, now) >= PRO_STALE_DAYS;
}

export function intendedUseLabel(row: Pick<ProApplicationRow, 'intended_use' | 'intended_use_note'>): string {
  if (row.intended_use === 'custom' && row.intended_use_note) return row.intended_use_note;
  return row.intended_use.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function durationLabel(row: Pick<ProApplicationRow, 'duration_months' | 'duration_note'>): string {
  if (row.duration_months) return `${row.duration_months} mo`;
  return row.duration_note ?? 'Custom';
}

export const PRO_SERVICE_CATALOG = [
  'secure_transfers', 'medical_support', 'advance_assessment',
  'secure_communications', 'journey_monitoring', 'event_support',
  'residential_support',
] as const;

export function serviceLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * E2E-08 — is a reserved Secure Pro date actually going to happen?
 *
 * The founder's question was whether the reserved-date flow is workable from
 * the console, and the two ways it silently is not:
 *
 *   `no_officers`    the date is SCHEDULED — the client's calendar paints it
 *                    booked and the team chip says ON DUTY — but no assignment
 *                    covers it. Nobody is coming, and nothing anywhere said so.
 *                    Fires on TODAY *and* TOMORROW: an unassigned tomorrow date
 *                    is exactly the thing ops wants a day's notice on.
 *   `not_activated`  the reserved day has ARRIVED and no session ever started.
 *                    TODAY only.
 *
 * Three rules, all load-bearing:
 *
 * 1. `no_officers` reads `officers_on_date`, NEVER `officers_today`.
 *
 *    Both fields exist on the row and differ by one word.
 *    `officers_on_date` counts cover on THIS ROW'S OWN date
 *    (pro-management.service.ts:409-411); `officers_today` counts cover on
 *    today (`:406-408`) and is kept only for compatibility. Reading the wrong
 *    one is not a subtle inaccuracy — a correctly-staffed TOMORROW reservation
 *    whose officer starts tomorrow reports `officers_today = 0`, so it paints a
 *    healthy booking with a pulsing red "NO OFFICERS ASSIGNED" and tells the
 *    operator to assign or cancel it. That shipped once already; the field is
 *    the whole fix, which is why the spec mutation-proves it by name.
 *
 * 2. `not_activated` applies only when the date is TODAY. A tomorrow row has
 *    not had its chance yet; flagging it would put a permanent warning on every
 *    healthy future reservation and train operators to ignore the flag — which
 *    costs more than the warning buys.
 *
 * 3. `no_officers` OUTRANKS `not_activated`. A date with nobody assigned did
 *    not "fail to activate", it was never staffed, and the fix is different
 *    (assign officers, or cancel so the client is told). Reporting the
 *    downstream symptom would send the operator to the wrong action.
 *
 * Pure and in this module (not the panel) so it is reachable from the node test
 * project — the component that renders it cannot be imported there.
 */
export type ReservedDateAlert = 'no_officers' | 'not_activated' | null;

export function reservedDateAlert(row: {
  /** Cover on the row's OWN date. Rule 1: never `officers_today` here. */
  officers_on_date: number;
  is_today: boolean;
  activated_at: string | null;
}): ReservedDateAlert {
  if (row.officers_on_date <= 0) return 'no_officers';
  // Only today's row can be late to activate — rule 2.
  if (row.is_today && !row.activated_at) return 'not_activated';
  return null;
}
