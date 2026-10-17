/**
 * Group creation outcome (bug 27, 2026-10-17 — "Cannot create groups in
 * mobile app").
 *
 * Two ways a perfectly good group used to be reported as "Could not create
 * group":
 *
 *  1. A member's copy of the signed `create` failed TRANSIENTLY (offline,
 *     timeout, relay 5xx/429). That copy is already a durable outbox row and
 *     the drain delivers it, so the group reached everyone — while the creator
 *     saw an error, tapped Create again and made a second group.
 *  2. Every selected member had no published Messenger keys (registered but
 *     never opened Messenger). The reason never reached the error, so the user
 *     read "group create: no member could be reached ()".
 *
 * This module holds the two small contracts that fix it: a marker the
 * delivery helper puts on a transient failure whose row is queued, and the
 * typed error createGroupChat throws when NO member can be reached at all —
 * plus the copy the screen shows for it.
 */

const QUEUED = 'queuedForRetry';

/**
 * Tag a delivery error as "queued for retry". `retryable` is the caller's
 * verdict: the durable outbox row was written AND the outbox's own failure
 * rule (classifyOutboxFailure) says the drain will retry it — one rule, so
 * this cannot drift from what the drain really does. Returns what to throw.
 */
export function markQueuedForRetry(e: unknown, retryable: boolean): unknown {
  if (!retryable) {return e;}
  const err = e instanceof Error ? e : new Error(typeof e === 'string' ? e : 'delivery deferred');
  try {
    (err as Error & {[QUEUED]?: boolean})[QUEUED] = true;
  } catch { /* frozen error object — fall back to the plain failure */ }
  return err;
}

export function isQueuedForRetry(e: unknown): boolean {
  return !!(e && typeof e === 'object' && (e as {[QUEUED]?: unknown})[QUEUED] === true);
}

/** The keys service's "this account never published Messenger keys" (404). */
export function isNoKeysError(e: unknown): boolean {
  const status = (e as {status?: unknown} | null)?.status;
  if (status === 404) {return true;}
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return /no_keys_found/i.test(msg);
}

export type UnreachableReason = 'no_keys' | 'offline' | 'other';

/** Why one member could not be reached, from the raw error text. */
export function unreachableReason(error: string): UnreachableReason {
  if (/no_keys_found|no keys|prekey|bundle|404|not found/i.test(error)) {return 'no_keys';}
  if (/network|timed? ?out|abort|transport not open|econn|enotfound|unreach|failed to fetch/i.test(error)) {return 'offline';}
  return 'other';
}

export class GroupCreateUnreachableError extends Error {
  readonly code = 'GROUP_MEMBERS_UNREACHABLE';
  /** userId → reason, for every member no copy could be queued for. */
  readonly reasons: Record<string, UnreachableReason>;

  constructor(readonly unreachableUserIds: string[], failures: string[]) {
    super(`group create: no member could be reached (${failures.join('; ')})`);
    this.name = 'GroupCreateUnreachableError';
    const reasons: Record<string, UnreachableReason> = {};
    for (const f of failures) {
      const i = f.indexOf(': ');
      if (i <= 0) {continue;}
      reasons[f.slice(0, i)] = unreachableReason(f.slice(i + 2));
    }
    this.reasons = reasons;
  }
}

function listNames(names: string[]): string {
  if (names.length <= 1) {return names[0] ?? '';}
  if (names.length <= 3) {return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;}
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`;
}

/**
 * The alert for a failed create. Names are what the picker showed; a member
 * the screen cannot name is "a member".
 */
export function groupCreateFailureCopy(
  e: unknown,
  nameOf: (userId: string) => string | undefined,
): {title: string; message: string} {
  const title = 'Could not create group';
  if (e instanceof GroupCreateUnreachableError || (e as {code?: string} | null)?.code === 'GROUP_MEMBERS_UNREACHABLE') {
    const err = e as GroupCreateUnreachableError;
    const ids = err.unreachableUserIds ?? [];
    const reasons = Object.values(err.reasons ?? {});
    const names = listNames(ids.map(id => nameOf(id) ?? 'a member'));
    if (reasons.length > 0 && reasons.every(r => r === 'offline')) {
      return {title, message: 'No connection — check your internet and try again.'};
    }
    if (reasons.length > 0 && reasons.every(r => r === 'no_keys')) {
      return {
        title,
        message: `${names || 'The selected members'} ${ids.length === 1 ? "hasn't" : "haven't"} opened Bravo Messenger yet, so they can't receive the group key. Ask them to open Messenger once, then try again.`,
      };
    }
    return {title, message: `${names || 'The selected members'} could not be reached. Please try again.`};
  }
  const msg = e instanceof Error ? e.message : String(e ?? '');
  if (/transport not open|network|timed? ?out/i.test(msg)) {
    return {title, message: 'No connection — check your internet and try again.'};
  }
  return {title, message: 'Please try again.'};
}

/**
 * The note shown AFTER a successful create when some selected members were
 * left out because they have no Messenger keys yet. Null when nobody was.
 */
export function groupCreatePartialNote(
  leftOutUserIds: string[] | undefined,
  nameOf: (userId: string) => string | undefined,
): string | null {
  const ids = leftOutUserIds ?? [];
  if (ids.length === 0) {return null;}
  const names = listNames(ids.map(id => nameOf(id) ?? 'a member'));
  return `${names} ${ids.length === 1 ? "wasn't" : "weren't"} added — they haven't opened Bravo Messenger yet. Add them from Group info once they have.`;
}
