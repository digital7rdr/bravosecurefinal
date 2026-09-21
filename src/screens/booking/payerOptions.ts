/**
 * B-843/B-844 — "which account pays for this booking?", as pure rules.
 *
 * A person may be an active member under any number of root accounts, so the
 * payer is a CHOICE the member makes, not a lookup the client performs. Two
 * sources feed the same shape: `familyApi.memberships()` up front, and the
 * `options[]` the server attaches to a money refusal (`PAYER_CHOICE_REQUIRED`,
 * `SPENDING_QUOTA_EXCEEDED`, …).
 *
 * The rule that matters most is `defaultPayerChoice`: it preselects ONLY where
 * the answer is unambiguous. A guess here charges a root the member never
 * picked, and for money a surprise is the worse failure (plan D2/D5).
 *
 * Deliberately dependency-free (no RN, no axios) so the node `booking` Jest
 * project can execute it directly. The one import is a TYPE and is erased.
 */
import type {PayerOption} from '@services/api';

/**
 * What both sources have in common. `FamilyMembership` carries `heldUntil` (a
 * timestamp) while a refusal's `PayerOption` carries `held` (a boolean) — one
 * input type accepts either so there is exactly one row builder.
 */
export interface PayerMembershipInput {
  id?: string | null;
  holderId: string;
  holderName: string | null;
  spendLimit?: number | null;
  spent?: number | null;
  remaining?: number | null;
  /**
   * B-709 — `min(remaining quota, what the root can actually cover)`. The
   * number the member can really spend, and the only honest one to put on a
   * row they are about to commit money against. A refusal's `PayerOption`
   * carries no such field, so `remaining` stays the fallback.
   */
  effectiveSpendable?: number | null;
  held?: boolean;
  heldUntil?: string | null;
  rootSuspended?: boolean;
}

export interface PayerChoice {
  /** Stable React key. */
  key: string;
  /** What rides the wire as `payer_user_id` / `payerUserId` — the member's OWN
   *  id for "my wallet", the root's user id otherwise. */
  holderId: string;
  label: string;
  sublabel: string;
  disabled: boolean;
  /** Why it is disabled, in the member's words. Absent when selectable. */
  reason?: string;
}

export const SELF_PAYER_KEY = 'self';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function heldNow(m: PayerMembershipInput): boolean {
  if (m.held === true) {return true;}
  if (!m.heldUntil) {return false;}
  const until = new Date(m.heldUntil).getTime();
  return Number.isFinite(until) && until > Date.now();
}

function amount(n: number): string {
  return n.toLocaleString();
}

/**
 * The ordered list the selector renders: the member's own wallet first, then
 * every membership in the order the server sent them (oldest first).
 */
export function buildPayerChoices(input: {
  selfUserId: string;
  selfBalance: number;
  memberships: PayerMembershipInput[];
}): PayerChoice[] {
  const self: PayerChoice = {
    key: SELF_PAYER_KEY,
    holderId: input.selfUserId,
    label: 'My wallet',
    sublabel: `${amount(input.selfBalance)} BC`,
    disabled: false,
  };
  const rows = (input.memberships ?? []).map((mem, i): PayerChoice => {
    const suspended = mem.rootSuspended === true;
    const held = heldNow(mem);
    // §21 — a suspended root outranks the hold and the quota: telling the
    // member anything else sends them somewhere that cannot help.
    const reason = suspended ? 'suspended' : held ? 'on hold' : undefined;
    // P3-11 — what the member can ACTUALLY spend beats the raw quota: showing
    // "5,000 BC left" for a root holding 200 credits promises money that is not
    // there, and they only find out at the moment they commit.
    const spendable = typeof mem.effectiveSpendable === 'number'
      ? mem.effectiveSpendable
      : mem.remaining;
    const sublabel = suspended
      ? 'Suspended'
      : held
        ? 'On hold'
        : typeof spendable === 'number'
          ? `${amount(spendable)} BC left`
          : 'No limit';
    return {
      key: mem.id ? `row:${mem.id}` : `holder:${mem.holderId}:${i}`,
      holderId: mem.holderId,
      label: mem.holderName ?? 'Plan holder',
      sublabel,
      disabled: reason !== undefined,
      ...(reason ? {reason} : {}),
    };
  });
  return [self, ...rows];
}

/**
 * The pre-fill, or `null` when the member must choose (D5).
 *
 * Zero memberships → their own wallet. Exactly one ELIGIBLE membership → that
 * one, which is what the server did before this change. Anything else → null:
 * with two roots there is no safe guess, and with one held/suspended root a
 * silent fall back to the member's own wallet would spend their money to avoid
 * asking a question.
 */
export function defaultPayerChoice(choices: PayerChoice[]): PayerChoice | null {
  const memberships = choices.filter(c => c.key !== SELF_PAYER_KEY);
  if (memberships.length === 0) {return choices.find(c => c.key === SELF_PAYER_KEY) ?? null;}
  if (memberships.length === 1 && !memberships[0].disabled) {return memberships[0];}
  return null;
}

function toOption(v: unknown): PayerOption | null {
  if (!isObject(v)) {return null;}
  if (typeof v.holderId !== 'string' || v.holderId === '') {return null;}
  return {
    holderId: v.holderId,
    holderName: typeof v.holderName === 'string' ? v.holderName : null,
    spendLimit: typeof v.spendLimit === 'number' ? v.spendLimit : null,
    spent: typeof v.spent === 'number' ? v.spent : 0,
    remaining: typeof v.remaining === 'number' ? v.remaining : null,
    // B-854/A12 — the chain-aware ceiling, when the server computed one. The
    // builder has preferred this over `remaining` since B-709, but dropping it
    // here meant the one path that runs AT the moment of choosing a payer —
    // re-picking after a refusal — showed the raw quota and walked the member
    // into the same refusal again. `null` (not 0) when absent: zero is a real,
    // very different answer.
    effectiveSpendable: typeof v.effectiveSpendable === 'number' ? v.effectiveSpendable : null,
    held: v.held === true,
    rootSuspended: v.rootSuspended === true,
  };
}

/**
 * The `options[]` a money refusal carries, from either the raw body or a live
 * axios rejection. Null (never `[]`) when there are none: an empty list would
 * render as "you belong to no root accounts", which is a different, wrong
 * statement.
 */
/**
 * A7 — "is this refusal about WHO pays?", with the one line to say if so.
 *
 * `insufficient_credits` is the same wire code whether the member's own wallet
 * or a root's was short, and only `payer_is_self` separates them. Sending a
 * root-short refusal to the top-up paywall tells the member to buy credits
 * that cannot pay for this booking (B-384's loop), so that case answers with
 * the OTHER accounts instead.
 *
 * Null means "not a payer problem" — the caller's existing handling stands.
 */
export function payerRefusalMessage(e: unknown): string | null {
  if (!isObject(e)) {return null;}
  const response = e.response;
  const body = isObject(response) && isObject(response.data) ? response.data : e;
  const code = typeof body.code === 'string' ? body.code : '';
  const message = typeof body.message === 'string' ? body.message : '';
  const text = `${code} ${message}`;
  if (text.includes('PAYER_CHOICE_REQUIRED') || text.includes('payer_choice_required')) {
    return 'Choose which account pays for this booking.';
  }
  if (text.includes('PAYER_NOT_ELIGIBLE') || text.includes('payer_not_eligible')) {
    return 'That account can’t pay for this booking right now.';
  }
  if (text.includes('insufficient_credits') && body.payer_is_self === false) {
    return 'That account doesn’t have enough credit. Choose another account or your wallet.';
  }
  return null;
}

export function payerChoiceFromRefusal(e: unknown): PayerOption[] | null {
  if (!isObject(e)) {return null;}
  const response = e.response;
  const body = isObject(response) && isObject(response.data) ? response.data : e;
  const raw = body.options;
  if (!Array.isArray(raw)) {return null;}
  const options = raw.map(toOption).filter((o): o is PayerOption => o !== null);
  return options.length > 0 ? options : null;
}
