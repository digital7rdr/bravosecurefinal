/**
 * B-854 — chained credit, in the console's words.
 *
 * A linked member B who holds their OWN members C may be allowed to have C's
 * bookings paid from the root A's wallet, inside B's allocation. Three surfaces
 * have to say so honestly: the roster column (off / a pending ask / on), the
 * per-member spending disclosure ("C via B", never "B"), and the money screens,
 * where a chained charge lands on A's wallet with C as the ACTOR and would
 * otherwise read as A's own spend.
 *
 * Pure and dependency-free apart from the UTC date formatter, because the
 * ops-console Jest project is `testEnvironment: node` and mounts nothing: every
 * label these screens render is decided here so it can be pinned.
 *
 * Copy rule (B-832, pinned by `linkedMembersCopy.test.ts`): these people are
 * MEMBERS. Never family, spouse, household or children. And `holds N` is a
 * count, never an entitlement — `getMine`'s Pro root and the root that actually
 * PAYS can be two different accounts (plan A14).
 */

import {formatDateUtc} from './datetime';

export type FundingState = 'off' | 'pending' | 'on';

export interface FundingRowLike {
  /** `family_members.funds_sub_members` on the (root, member) row. */
  funds_sub_members?: boolean | null;
  /** The latest ask in whatever state it is in — a DECLINED one is history, not a state. */
  funding_request?: {id: string; status: string; created_at: string} | null;
}

/**
 * The flag is the AUTHORITY on whether the chain is on; the request row is the
 * history behind it (the server says so in as many words). So a stale pending
 * ask against a row that is already funding can never downgrade the column to
 * "waiting" — an operator would switch it on twice.
 */
export function fundingState(row: FundingRowLike): FundingState {
  if (row.funds_sub_members) return 'on';
  if (row.funding_request?.status === 'pending') return 'pending';
  return 'off';
}

export function fundingStateLabel(state: FundingState): string {
  return state === 'on' ? 'On' : state === 'pending' ? 'Pending' : 'Off';
}

/** A plain member count. Absent when there is nobody to fund. */
export function holdsBadgeLabel(n: number | null | undefined): string | null {
  const count = Math.floor(Number(n ?? 0));
  if (!Number.isFinite(count) || count <= 0) return null;
  return `holds ${count.toLocaleString()}`;
}

/** What the chain has cost this allocation so far — shown only once it has. */
export function subMemberSpendLabel(credits: number | null | undefined): string | null {
  const c = Math.floor(Number(credits ?? 0));
  if (!Number.isFinite(c) || c <= 0) return null;
  return `${c.toLocaleString()} BC by their members`;
}

/** A Nest refusal body as it lands: `{code, message}` plus whatever that code adds. */
type RefusalBody = {code?: unknown; count?: unknown; [key: string]: unknown} | null | undefined;

function refusalCode(body: RefusalBody): string {
  return typeof body?.code === 'string' ? body.code : '';
}

/**
 * The A10 conflict's count, and only that code's. A zero means the server had
 * no reason to refuse, so it must not put a FORCE button on screen — forcing
 * cancels the very bookings the count names, hours later at accept.
 */
export function chainedInFlightCount(body: RefusalBody): number | null {
  if (refusalCode(body) !== 'CHAINED_BOOKINGS_IN_FLIGHT') return null;
  const n = Math.floor(Number(body?.count ?? 0));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Every refusal these four routes can answer with, in the operator's words. */
export function fundingErrorCopy(body: RefusalBody, fallback: string): string {
  const code = refusalCode(body);
  if (code === 'CHAINED_BOOKINGS_IN_FLIGHT') {
    const n = chainedInFlightCount(body);
    return n == null
      ? 'Some of their members’ bookings are in progress — try again later.'
      : `${n.toLocaleString()} of their members’ bookings are in progress — try again later.`;
  }
  const table: Record<string, string> = {
    FUNDING_SOURCE_ALREADY_SET: 'Their members already spend another account’s credits. That has to be switched off there first — a member draws on one account at a time.',
    FUNDING_REQUEST_PENDING: 'There is already an open request on this row. Allow or decline that one.',
    FUNDING_CYCLE: 'These two accounts would end up funding each other’s members. Switch the other direction off first.',
    NO_SUB_MEMBERS: 'This member holds nobody yet, so there is nothing to fund.',
    MEMBER_NOT_ACTIVE: 'This member has not accepted yet, so nothing can be switched on for them.',
    MEMBER_NOT_FOUND: 'That row is no longer on this account.',
    // Defensive. Neither reaches the four OPS routes today —
    // `NO_FUNDING_REQUEST` fires only for an actor filed as CLIENT
    // (family.service.ts:990, which is what lets a support desk act for a root
    // who asked by phone), and `REQUEST_NOT_FOUND` lives on the member's own
    // request route. Mapped anyway: the day either moves, a raw
    // `no_funding_request` in a support console is a ticket to engineering.
    NO_FUNDING_REQUEST: 'No request on file for this member.',
    REQUEST_NOT_FOUND: 'That request no longer exists — reload the page.',
  };
  return table[code] ?? fallback;
}

/** One signed ledger amount. Positive = credits came back. */
export function creditsLabel(amount: number): string {
  const n = Number(amount) || 0;
  const abs = Math.abs(n).toLocaleString();
  return n > 0 ? `+${abs} BC` : `${abs} BC`;
}

export interface SpendTxLike {
  type: 'payment' | 'refund';
  feature: string | null;
  amount: number;
  at: string;
  /** A6 — who actually spent it, and the member they spent THROUGH (null = direct). */
  actorUserId?: string | null;
  actorName?: string | null;
  viaUserId?: string | null;
}

/**
 * "C via B · booking · 258 BC · 11 Sep 2026" when the charge came through this
 * member's own member; the member's own spend keeps the shorter line so the
 * attribution only ever appears where it means something.
 */
export function spendRowLabel(tx: SpendTxLike, memberName: string): string {
  const feature = (tx.feature ?? '').trim() || 'other';
  const tail = `${feature} · ${creditsLabel(tx.amount)} · ${formatDateUtc(tx.at)}`;
  if (!tx.viaUserId) return tail;
  const actor = (tx.actorName ?? '').trim() || 'A member';
  return `${actor} via ${memberName} · ${tail}`;
}

/**
 * A8 — the holder and ops surfaces MAY name the wallet owner; LM-B7 keeps that
 * off the client's own history, which is the server's job (`payer_name` is the
 * via holder there). The ops booking projections do not yet carry a via NAME,
 * so a chain whose id alone arrived still declares itself rather than reading
 * as a plain one-hop charge.
 */
export function paidByLabel(b: {
  payer_name?: string | null;
  payer_via_user_id?: string | null;
  payer_via_name?: string | null;
}): string | null {
  const payer = (b.payer_name ?? '').trim();
  if (!payer) return null;
  if (!b.payer_via_user_id) return `Paid by ${payer}`;
  const via = (b.payer_via_name ?? '').trim();
  return via ? `Paid by ${payer} via ${via}` : `Paid by ${payer} via a linked member`;
}

/**
 * A14 — a family charge lands on the ROOT's wallet, so a finance row that shows
 * only the wallet owner reads a member's (or, chained, a sub-member's) spend as
 * the root's own. Null means the owner really did spend it themselves.
 *
 * `via` is the whole phrase, because on a chained row `user_id` is the root
 * either way: the NAME of the intermediary is the only thing separating "B
 * spent this" from "C spent it through B". The neutral fallback is for a row
 * whose via id no longer resolves to a user, never the default.
 */
export function financeActorLabel(r: {
  user_id: string;
  actor_user_id?: string | null;
  actor_name?: string | null;
  via_user_id?: string | null;
  via_name?: string | null;
}): {text: string; via: string | null} | null {
  const actor = (r.actor_user_id ?? '').trim();
  if (!actor || actor === r.user_id) return null;
  // The ID is the fact that there was a chain; the name only dresses it.
  const viaId = (r.via_user_id ?? '').trim();
  const viaName = (r.via_name ?? '').trim();
  return {
    text: (r.actor_name ?? '').trim() || actor.slice(0, 8),
    via: !viaId ? null : viaName ? `via ${viaName}` : 'via a linked member',
  };
}

/**
 * N4 (NAV_RAPID_USE_LOOP) — a synchronous single-flight latch for a button that
 * MOVES MONEY or grants access.
 *
 * `setBusy(...)` is React state: it does not take effect until the next render,
 * so two taps landing in one tick both read the old value and both fire. On
 * FORCE OFF that is two force-offs; on ALLOW it is a duplicate grant. The ref is
 * claimed here, before anything async, and released on BOTH settlements — a 409
 * that leaves the latch held is a dead button — and on a body that throws
 * synchronously (which would otherwise leak the latch forever).
 *
 * `fn` OWNS its errors: this returns `void`, so a rejection has nowhere to go
 * and is released-and-dropped rather than left as an unhandled rejection. Every
 * caller here reports inside its own `catch`. A SYNCHRONOUS throw is different —
 * an async body cannot do it, so it is a programming error and is rethrown.
 */
export function singleFlight(ref: {current: boolean}, fn: () => Promise<void>): void {
  if (ref.current) return;
  ref.current = true;
  let started: Promise<void>;
  try {
    started = fn();
  } catch (e) {
    ref.current = false;
    throw e;
  }
  const release = () => { ref.current = false; };
  void started.then(release, release);
}

/**
 * Drop one key, keeping the map's IDENTITY when the key was never there — a new
 * object for a miss is a re-render that changes nothing on screen.
 */
export function withoutRow<T>(map: Record<string, T>, id: string): Record<string, T> {
  if (!(id in map)) return map;
  const next = {...map};
  delete next[id];
  return next;
}
