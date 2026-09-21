/**
 * B-854 (A6 / A8 / A11 / A14) — chained credit, as the console renders it.
 *
 * A linked member B who holds their OWN members C can be allowed to spend the
 * root A's allowance for them. Three things that follow from that have to be
 * legible in the support console, and each one has a way of going quietly
 * wrong:
 *
 *   1. The switch has THREE states (off / a pending ask / on) and two of the
 *      three actions are one-word apart. Swapping the approve and decline
 *      routes grants exactly the thing an operator just refused, and no render
 *      test can see it — so the api route literals are scanned per route and
 *      the card's dispatcher is order-pinned.
 *   2. A chained charge lands on A's WALLET with C as the ACTOR. Anything that
 *      renders the wallet owner's name alone reads a sub-member's spend as the
 *      root's own — the exact defect A14 exists to close.
 *   3. The copy stays neutral. B-832's rule ("members", never family/spouse)
 *      is a product rule, and `holds N` must not read as a Pro entitlement:
 *      `getMine`'s Pro root and the PAYING root can be different accounts.
 *
 * The ops-console Jest project is `testEnvironment: node` and matches only
 * `*.test.ts`, so no screen can be mounted here. Everything that is not a pure
 * helper is a SOURCE SCAN, and each one obeys the three rules that make a scan
 * real: comments are stripped BEFORE any assertion (prose naming a token is not
 * the token), lines split on `\r?\n` (these files are checked out CRLF on
 * Windows and a `\n` anchor passes vacuously), and every absence assertion is
 * paired with a present-token self-check.
 */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  chainedInFlightCount,
  creditsLabel,
  financeActorLabel,
  fundingErrorCopy,
  fundingState,
  fundingStateLabel,
  holdsBadgeLabel,
  paidByLabel,
  singleFlight,
  spendRowLabel,
  subMemberSpendLabel,
  withoutRow,
} from '../lib/familyFunding';

const SRC = join(__dirname, '..');

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const read = (...p: string[]) => stripComments(readFileSync(join(SRC, ...p), 'utf8'));

const API = read('lib', 'api.ts');
const CARD = read('features', 'people', 'LinkedMembersCard.tsx');
const DETAIL = read('features', 'bookings', 'BookingDetail.tsx');
const LIST = read('features', 'bookings', 'BookingsList.tsx');
const FINANCE = read('features', 'finance', 'FinancePage.tsx');

/** The nearest enclosing `<button …>LABEL</button>` element, attributes included. */
function buttonWith(src: string, label: string): string {
  const re = new RegExp(`<button(?:(?!<button)[\\s\\S])*?>\\s*${label}\\s*<\\/button>`);
  return re.exec(src)?.[0] ?? '';
}

describe('the scans can see the code they are scanning', () => {
  it('read every file and the stripper left the executable source intact', () => {
    for (const [name, src] of Object.entries({API, CARD, DETAIL, LIST, FINANCE})) {
      expect(`${name}:${src.length > 2000}`).toBe(`${name}:true`);
    }
    // Present-token self-checks: tokens that MUST survive the strip.
    expect(API).toContain('familyMemberSpend');
    expect(CARD).toContain('const CODE_COPY');
    expect(DETAIL).toContain('data?.payer');
    expect(LIST).toContain('function clientSub(');
    expect(FINANCE).toContain('wallet_ledger_');
  });
});

// ─── 1. The switch state ──────────────────────────────────────────────────

describe('fundingState — off / pending / on', () => {
  it('is OFF on a row that never asked', () => {
    expect(fundingState({})).toBe('off');
    expect(fundingState({funds_sub_members: false, funding_request: null})).toBe('off');
  });

  it('is PENDING while an ask is open', () => {
    expect(fundingState({funds_sub_members: false, funding_request: {id: 'q1', status: 'pending', created_at: '2026-09-11T00:00:00.000Z'}})).toBe('pending');
  });

  it('is OFF again once the ask was declined, expired or cancelled', () => {
    for (const status of ['declined', 'expired', 'cancelled']) {
      expect(fundingState({funds_sub_members: false, funding_request: {id: 'q1', status, created_at: '2026-09-11T00:00:00.000Z'}})).toBe('off');
    }
  });

  it('the FLAG is the authority — a stale pending row never downgrades a live switch', () => {
    // The server says so in as many words: `fundsSubMembers` is the authority
    // on whether the chain is ON; the request row is the history behind it.
    expect(fundingState({funds_sub_members: true, funding_request: {id: 'q1', status: 'pending', created_at: '2026-09-11T00:00:00.000Z'}})).toBe('on');
    expect(fundingState({funds_sub_members: true, funding_request: null})).toBe('on');
  });

  it('labels the three states without leaking a code at the operator', () => {
    expect(fundingStateLabel('off')).toBe('Off');
    expect(fundingStateLabel('pending')).toBe('Pending');
    expect(fundingStateLabel('on')).toBe('On');
    for (const s of ['off', 'pending', 'on'] as const) {
      expect(fundingStateLabel(s)).not.toMatch(/_/);
    }
  });
});

// ─── 2. The badge ─────────────────────────────────────────────────────────

describe('holdsBadgeLabel — a member count, never an entitlement', () => {
  it('says nothing at all when this member holds nobody', () => {
    expect(holdsBadgeLabel(0)).toBeNull();
    expect(holdsBadgeLabel(null)).toBeNull();
    expect(holdsBadgeLabel(undefined)).toBeNull();
    expect(holdsBadgeLabel(-3)).toBeNull();
  });

  it('counts the members they hold', () => {
    expect(holdsBadgeLabel(1)).toBe('holds 1');
    expect(holdsBadgeLabel(3)).toBe('holds 3');
    expect(holdsBadgeLabel(1200)).toBe('holds 1,200');
  });

  it('never reads as a plan or a Pro entitlement (the paying root may not be the Pro root)', () => {
    for (const n of [1, 7, 4000]) {
      const label = holdsBadgeLabel(n) as string;
      expect(label).not.toMatch(/\bPro\b/i);
      expect(label).not.toMatch(/plan|tier|premium|upgrade/i);
    }
  });

  it('shows what the chain has cost so far, and only once it has cost something', () => {
    expect(subMemberSpendLabel(0)).toBeNull();
    expect(subMemberSpendLabel(null)).toBeNull();
    expect(subMemberSpendLabel(1200)).toBe('1,200 BC by their members');
  });
});

// ─── 3. The refusals ──────────────────────────────────────────────────────

describe('fundingErrorCopy — every refusal in the operator’s words', () => {
  it('names the in-flight count on the A10 conflict', () => {
    const copy = fundingErrorCopy({code: 'CHAINED_BOOKINGS_IN_FLIGHT', message: 'chained_bookings_in_flight', count: 3}, 'fallback');
    expect(copy).toBe('3 of their members’ bookings are in progress — try again later.');
  });

  it('still says something usable when the count is missing', () => {
    const copy = fundingErrorCopy({code: 'CHAINED_BOOKINGS_IN_FLIGHT', message: 'chained_bookings_in_flight'}, 'fallback');
    expect(copy).toMatch(/in progress/);
    expect(copy).not.toMatch(/undefined|NaN|null/);
  });

  it('reads the count back for the force option, and only for that code', () => {
    expect(chainedInFlightCount({code: 'CHAINED_BOOKINGS_IN_FLIGHT', count: 2})).toBe(2);
    // A zero would mean the server had no reason to refuse — treat it as the
    // generic refusal, never as "offer to force nothing".
    expect(chainedInFlightCount({code: 'CHAINED_BOOKINGS_IN_FLIGHT', count: 0})).toBeNull();
    expect(chainedInFlightCount({code: 'FUNDING_CYCLE', count: 2})).toBeNull();
    expect(chainedInFlightCount(null)).toBeNull();
    expect(chainedInFlightCount({code: 'CHAINED_BOOKINGS_IN_FLIGHT'})).toBeNull();
  });

  it('translates every code these four routes can answer with', () => {
    for (const code of [
      'FUNDING_SOURCE_ALREADY_SET', 'FUNDING_REQUEST_PENDING', 'FUNDING_CYCLE',
      'NO_SUB_MEMBERS', 'MEMBER_NOT_ACTIVE', 'MEMBER_NOT_FOUND',
      // Defensive: the two request-lifecycle codes. Unreachable from the four
      // OPS routes today (`NO_FUNDING_REQUEST` fires only for an actor whose
      // role is CLIENT — family.service.ts:990 — and `REQUEST_NOT_FOUND` lives
      // on the member's own request route), but a raw `no_funding_request` in a
      // support console is a ticket back to engineering the day either moves.
      'NO_FUNDING_REQUEST', 'REQUEST_NOT_FOUND',
    ]) {
      const copy = fundingErrorCopy({code, message: code.toLowerCase()}, 'fallback');
      expect(`${code}:${copy}`).not.toBe(`${code}:fallback`);
      expect(copy).not.toContain('_');
    }
  });

  it('falls back rather than inventing a sentence for a code it has not been taught', () => {
    expect(fundingErrorCopy({code: 'SOMETHING_NEW'}, 'fallback')).toBe('fallback');
    expect(fundingErrorCopy(null, 'fallback')).toBe('fallback');
    expect(fundingErrorCopy(undefined, 'fallback')).toBe('fallback');
  });
});

// ─── 4. The spending disclosure (A6) ──────────────────────────────────────

describe('spendRowLabel — “C via B”, never “B”', () => {
  const base = {
    id: 't1', type: 'payment' as const, feature: 'booking', description: 'Secure transfer',
    amount: -258, bookingId: 'b1', at: '2026-09-11T08:30:00.000Z',
    actorUserId: 'C', actorName: 'Cara Nolan', viaUserId: 'B',
  };

  it('attributes a chained charge to the SUB-member, through the member', () => {
    expect(spendRowLabel(base, 'Ben Okafor'))
      .toBe('Cara Nolan via Ben Okafor · booking · 258 BC · 11 Sep 2026');
  });

  it('drops the attribution entirely when the member spent it themselves', () => {
    expect(spendRowLabel({...base, actorUserId: 'B', actorName: 'Ben Okafor', viaUserId: null}, 'Ben Okafor'))
      .toBe('booking · 258 BC · 11 Sep 2026');
  });

  it('a via WITHOUT a resolvable actor name still says it came through the member', () => {
    const label = spendRowLabel({...base, actorName: null}, 'Ben Okafor');
    expect(label).toContain('via Ben Okafor');
    expect(label).not.toContain('null');
  });

  it('marks a refund as money coming back, not as more spend', () => {
    expect(creditsLabel(-258)).toBe('258 BC');
    expect(creditsLabel(258)).toBe('+258 BC');
    expect(creditsLabel(0)).toBe('0 BC');
    expect(spendRowLabel({...base, type: 'refund', amount: 258}, 'Ben Okafor')).toContain('+258 BC');
  });

  it('names an unfeatured row rather than rendering a null', () => {
    expect(spendRowLabel({...base, feature: null}, 'Ben Okafor')).toContain('other');
    expect(spendRowLabel({...base, feature: null}, 'Ben Okafor')).not.toContain('null');
  });
});

// ─── 5. Who paid, on the ops booking surfaces (A8) ────────────────────────

describe('paidByLabel — the ops/holder surfaces may name the wallet owner', () => {
  it('says nothing on a booking the client paid for themselves', () => {
    expect(paidByLabel({})).toBeNull();
    expect(paidByLabel({payer_name: null})).toBeNull();
    expect(paidByLabel({payer_name: '   '})).toBeNull();
  });

  it('names the wallet owner on a plain one-hop family charge', () => {
    expect(paidByLabel({payer_name: 'Aisha Rahman'})).toBe('Paid by Aisha Rahman');
  });

  it('names BOTH links of the chain when the server sends the via name', () => {
    expect(paidByLabel({payer_name: 'Aisha Rahman', payer_via_user_id: 'B', payer_via_name: 'Ben Okafor'}))
      .toBe('Paid by Aisha Rahman via Ben Okafor');
  });

  it('still declares the chain when only the via ID arrived (the ops projections carry no via name yet)', () => {
    const label = paidByLabel({payer_name: 'Aisha Rahman', payer_via_user_id: 'B'}) as string;
    expect(label).toContain('Paid by Aisha Rahman via ');
    expect(label).not.toContain('B');   // never a raw id in the sentence
    expect(label).toBe('Paid by Aisha Rahman via a linked member');
  });
});

// ─── 6. Finance (A14) ─────────────────────────────────────────────────────

describe('financeActorLabel — a chained charge must not read as the root’s own spend', () => {
  it('says nothing when the wallet owner is the one who spent it', () => {
    expect(financeActorLabel({user_id: 'A'})).toBeNull();
    expect(financeActorLabel({user_id: 'A', actor_user_id: 'A'})).toBeNull();
    expect(financeActorLabel({user_id: 'A', actor_user_id: null})).toBeNull();
  });

  it('names the actor on a one-hop member charge, with no via phrase', () => {
    expect(financeActorLabel({user_id: 'A', actor_user_id: 'B', actor_name: 'Ben Okafor'}))
      .toEqual({text: 'Ben Okafor', via: null});
  });

  it('NAMES the intermediary on a chained charge — the id alone renders as nothing', () => {
    // On a chained row `user_id` is the root either way, so the intermediary's
    // NAME is the only thing separating "B spent this" from "C spent it via B".
    expect(financeActorLabel({
      user_id: 'A', actor_user_id: 'C', actor_name: 'Cara Nolan',
      via_user_id: 'B', via_name: 'Ben Okafor',
    })).toEqual({text: 'Cara Nolan', via: 'via Ben Okafor'});
  });

  it('falls back to the neutral phrase ONLY when the via name is missing', () => {
    expect(financeActorLabel({user_id: 'A', actor_user_id: 'C', actor_name: 'Cara Nolan', via_user_id: 'B'}))
      .toEqual({text: 'Cara Nolan', via: 'via a linked member'});
    expect(financeActorLabel({user_id: 'A', actor_user_id: 'C', actor_name: 'Cara Nolan', via_user_id: 'B', via_name: '  '}))
      .toEqual({text: 'Cara Nolan', via: 'via a linked member'});
    // A via NAME with no via id is not a chain — the id is the fact.
    expect(financeActorLabel({user_id: 'A', actor_user_id: 'C', actor_name: 'Cara Nolan', via_name: 'Ben Okafor'}))
      .toEqual({text: 'Cara Nolan', via: null});
  });

  it('degrades a nameless actor to a short id rather than to the wallet owner', () => {
    const lab = financeActorLabel({user_id: 'A', actor_user_id: '7f3c1d2e-aaaa-bbbb-cccc-ddddeeeeffff', actor_name: null});
    expect(lab?.text).toBe('7f3c1d2e');
  });
});

// ─── 6b. The synchronous latch + the disclosure cache ─────────────────────

describe('singleFlight — a money button’s guard is a REF, not `useState`', () => {
  /**
   * N4 (NAV_RAPID_USE_LOOP): `setBusy(...)` does not take effect until the next
   * render, so two clicks landing in ONE tick both read `busy === null` and both
   * fire. On FORCE OFF that is two force-offs; on ALLOW it is a duplicate grant.
   * The latch has to be claimed synchronously and released in `finally`.
   */
  it('runs once for two invocations in the same tick', () => {
    const ref = {current: false};
    const fn = jest.fn(() => new Promise<void>(() => undefined));
    singleFlight(ref, fn);
    singleFlight(ref, fn);
    singleFlight(ref, fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('releases the latch once the work settles, so the button works again', async () => {
    const ref = {current: false};
    const fn = jest.fn(async () => undefined);
    singleFlight(ref, fn);
    expect(ref.current).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(ref.current).toBe(false);
    singleFlight(ref, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('releases the latch on a REJECTION — a failed force-off must be retryable', async () => {
    const ref = {current: false};
    const fn = jest.fn(async () => { throw new Error('409'); });
    // Fire-and-forget: a rejection is released-and-dropped, never left as an
    // unhandled rejection (which in this project is a hard suite failure — the
    // first cut of this helper used `.finally()` and took the whole file down).
    expect(() => singleFlight(ref, fn)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(ref.current).toBe(false);
    singleFlight(ref, jest.fn(async () => undefined));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('releases the latch when the body throws SYNCHRONOUSLY, and rethrows', () => {
    const ref = {current: false};
    expect(() => singleFlight(ref, () => { throw new Error('boom'); })).toThrow('boom');
    expect(ref.current).toBe(false);
  });
});

describe('withoutRow — a stale disclosure is worse than no disclosure', () => {
  it('drops the row a flip just changed', () => {
    expect(withoutRow({a: 1, b: 2}, 'a')).toEqual({b: 2});
  });

  it('keeps IDENTITY when the row was never cached, so no pointless re-render', () => {
    const map = {a: 1};
    expect(withoutRow(map, 'zzz')).toBe(map);
  });

  it('never mutates the map it was handed', () => {
    const map = {a: 1, b: 2};
    withoutRow(map, 'a');
    expect(map).toEqual({a: 1, b: 2});
  });
});

// ─── 7. The api surface — wire keys, per route ────────────────────────────

describe('api.ts — the four ops routes, scanned per route', () => {
  it('carries the new family-row fields under the SERVER’s own names', () => {
    const row = /export interface OpsFamilyRow \{[\s\S]*?\n\}/.exec(API)?.[0] ?? '';
    expect(row).toContain('member_id');                 // self-check: block found
    expect(row).toContain('funds_sub_members');
    expect(row).toContain('holds_members_count');
    expect(row).toContain('spent_by_members');
    expect(row).toContain('funding_request');
    // The server's summary is exactly {id, status, created_at} — inventing a
    // camelCase reading of it is the B-832 trap.
    expect(row).toMatch(/funding_request\?:[\s\S]{0,140}created_at/);
    expect(row).not.toContain('fundsSubMembers');
    expect(row).not.toContain('holdsMembersCount');
  });

  it('the spend rows carry the actor and the via — in the DTO’s own camelCase', () => {
    const spend = /export interface FamilyMemberSpend \{[\s\S]*?\n\}/.exec(API)?.[0] ?? '';
    expect(spend).toContain('byFeature');               // self-check: block found
    expect(spend).toContain('actorUserId');
    expect(spend).toContain('actorName');
    expect(spend).toContain('viaUserId');
  });

  it('approve posts to the APPROVE route and decline to the DECLINE route', () => {
    const approve = /approveFundMembers:[\s\S]*?\),\n/.exec(API)?.[0] ?? '';
    const decline = /declineFundMembers:[\s\S]*?\),\n/.exec(API)?.[0] ?? '';
    expect(approve).toContain('approveFundMembers');    // self-check
    expect(decline).toContain('declineFundMembers');
    expect(approve).toContain('/fund-members/approve');
    expect(approve).not.toContain('/fund-members/decline');
    expect(decline).toContain('/fund-members/decline');
    expect(decline).not.toContain('/fund-members/approve');
    for (const call of [approve, decline]) {
      expect(call).toContain("method: 'POST'");
      expect(call).toContain('/ops/users/${userId}/family/members/${rowId}');
    }
  });

  it('the off switch PATCHes, sends `enabled` and carries `force` only when asked', () => {
    const off = /setFundMembers:[\s\S]*?\),\n/.exec(API)?.[0] ?? '';
    expect(off).toContain('setFundMembers');            // self-check
    expect(off).toContain("method: 'PATCH'");
    expect(off).toContain('/fund-members`');
    expect(off).toContain('enabled');
    expect(off).toContain('force');
    // A11: only the approve route may turn it ON — the PATCH's DTO is
    // `@IsIn([false])`, so a `true` here is a 400 the operator cannot read.
    expect(off).toMatch(/enabled:\s*false/);
  });

  it('the funding-request list reads the holder’s own route', () => {
    const reqs = /familyFundingRequests:[\s\S]*?\),\n/.exec(API)?.[0] ?? '';
    expect(reqs).toContain('familyFundingRequests');    // self-check
    expect(reqs).toContain('/ops/users/${userId}/family/funding-requests');
    expect(reqs).toContain('requests');
  });
});

// ─── 8. The card wiring ───────────────────────────────────────────────────

describe('LinkedMembersCard — the column, the actions and the disclosure', () => {
  it('renders the column through the shared state helper, not a re-derived boolean', () => {
    expect(CARD).toContain('fundingState(');
    expect(CARD).toContain('holdsBadgeLabel(');
    expect(CARD).toContain('Funds their members');
  });

  it('ALLOW approves and DECLINE declines — in that order, through the api', () => {
    const fn = /function fundAction\([\s\S]*?\n  \}/.exec(CARD)?.[0] ?? '';
    expect(fn).toContain('fundAction');                 // self-check: block found
    const iApproveKind = fn.indexOf("kind === 'approve'");
    const iApproveCall = fn.indexOf('approveFundMembers');
    const iDeclineKind = fn.indexOf("kind === 'decline'");
    const iDeclineCall = fn.indexOf('declineFundMembers');
    for (const i of [iApproveKind, iApproveCall, iDeclineKind, iDeclineCall]) expect(i).toBeGreaterThan(-1);
    // Swapping the two calls is a one-word edit that GRANTS what an operator
    // just refused; the ordering is what makes that edit red.
    expect(iApproveKind).toBeLessThan(iApproveCall);
    expect(iApproveCall).toBeLessThan(iDeclineKind);
    expect(iDeclineKind).toBeLessThan(iDeclineCall);
    expect(fn).toContain('setFundMembers(');
  });

  it('each button dispatches its OWN action', () => {
    expect(buttonWith(CARD, 'ALLOW')).toContain("fundAction(m, 'approve')");
    expect(buttonWith(CARD, 'DECLINE')).toContain("fundAction(m, 'decline')");
    expect(buttonWith(CARD, 'SWITCH OFF')).toContain("fundAction(m, 'off')");
    // Self-check: the matcher really found three distinct elements.
    expect(buttonWith(CARD, 'ALLOW')).not.toContain("fundAction(m, 'decline')");
    expect(buttonWith(CARD, 'DECLINE')).not.toContain("fundAction(m, 'approve')");
  });

  it('claims a SYNCHRONOUS latch before it does anything else (N4)', () => {
    const fn = /function fundAction\([\s\S]*?\n  \}/.exec(CARD)?.[0] ?? '';
    expect(fn).toContain('fundAction');                 // self-check: block found
    expect(CARD).toContain('const fundBusy = useRef(false)');
    const iLatch = fn.indexOf('singleFlight(fundBusy');
    const iBusy = fn.indexOf('setBusy(');
    expect(iLatch).toBeGreaterThan(-1);
    expect(iBusy).toBeGreaterThan(-1);
    // `setBusy` is React state: it does not take effect until the next render,
    // so two clicks in one tick would both pass a `busy` check. The ref has to
    // be claimed first, and `singleFlight` is what releases it in `finally`.
    expect(iLatch).toBeLessThan(iBusy);
  });

  it('throws away the cached Spending panel for the row it just changed', () => {
    const fn = /function fundAction\([\s\S]*?\n  \}/.exec(CARD)?.[0] ?? '';
    expect(fn).toContain('fundAction');                 // self-check
    const iMutate = fn.indexOf('mutate()');
    const iDrop = fn.indexOf('dropSpend(row)');
    expect(iMutate).toBeGreaterThan(-1);
    expect(iDrop).toBeGreaterThan(iMutate);
    // The drop keeps map identity when nothing was cached (no pointless render),
    // and an OPEN panel is re-read rather than left on "Loading…" forever.
    expect(CARD).toContain('withoutRow(');
    const drop = /function dropSpend\([\s\S]*?\n  \}/.exec(CARD)?.[0] ?? '';
    expect(drop).toContain('withoutRow(');
    expect(drop).toContain('loadSpend(row)');
  });

  it('the force option exists, is opt-in, and is gated above the SUPERVISOR who sees the column', () => {
    expect(CARD).toContain("fundAction(m, 'off', true)");
    expect(CARD).toContain('canForce');
    expect(CARD).toContain('chainedInFlightCount(');
    // The FORCE control appears only after the server has actually refused.
    expect(CARD).toMatch(/forceRow === m\.id && canForce/);
  });

  it('is the first UI caller of the per-member spend route, and renders it “C via B”', () => {
    expect(CARD).toContain('opsDataApi.familyMemberSpend(');
    expect(CARD).toContain('spendRowLabel(');
    expect(CARD).toContain('byFeature');
  });

  it('the badge is a plain member count — never a Pro entitlement', () => {
    expect(CARD).not.toMatch(/\bPro\b/);
    expect(CARD).not.toMatch(/\bPRO\b/);
    // Self-check: the scan can see rendered words in this file at all.
    expect(CARD).toContain('Funds their members');
  });
});

// ─── 9. The booking + finance surfaces ────────────────────────────────────

describe('the ops booking surfaces name the chain', () => {
  it('BookingDetail routes the payer line through the shared label', () => {
    expect(DETAIL).toContain('paidByLabel(');
    expect(DETAIL).toContain('payer_via_user_id');
  });

  it('BookingsList routes its payer badge through the same label', () => {
    expect(LIST).toContain('paidByLabel(');
  });

  it('BookingRow and the detail booking both admit the via fields', () => {
    const row = /export interface BookingRow \{[\s\S]*?\n\}/.exec(API)?.[0] ?? '';
    expect(row).toContain('payer_name');                // self-check
    expect(row).toContain('payer_via_user_id');
    expect(row).toContain('payer_via_name');
  });
});

describe('FinancePage — the actor rides with the row, in the table AND the export', () => {
  it('the ledger row carries the actor and the via key', () => {
    const tx = /export interface FinanceTxRow \{[\s\S]*?\n\}/.exec(API)?.[0] ?? '';
    expect(tx).toContain('amount_credits');             // self-check
    expect(tx).toContain('actor_user_id');
    expect(tx).toContain('actor_name');
    expect(tx).toContain('via_user_id');
    // The server joins the intermediary's name (`vu.display_name AS via_name`);
    // without it the console can only ever say "a linked member".
    expect(tx).toContain('via_name');
  });

  it('the table renders the actor AND the named via through the shared label', () => {
    expect(FINANCE).toContain('financeActorLabel(');
    expect(FINANCE).toContain('Spent by');
    // The via phrase comes from the helper — a hard-coded "via a linked member"
    // in the JSX would ignore the name the server now sends.
    expect(FINANCE).toContain('actor.via');
    expect(FINANCE).not.toMatch(/>\s*via a linked member\s*</);
  });

  it('the CSV header and the row builder agree on the four new columns', () => {
    const block = /wallet_ledger_\$\{stamp\(\)\}\.csv`,[\s\S]*?\n\s*\)\}/.exec(FINANCE)?.[0] ?? '';
    expect(block).toContain('created_at');              // self-check: block found
    for (const key of ['actor', 'actor_user_id', 'via_user_id', 'via_name']) {
      expect(`${key}:${block.includes(key)}`).toBe(`${key}:true`);
    }
    expect(block).toContain('r.actor_name');
    expect(block).toContain('r.actor_user_id');
    expect(block).toContain('r.via_user_id');
    expect(block).toContain('r.via_name');
    // Header and row must stay the same length, or every later column shifts.
    const header = /\[\s*'created_at'[\s\S]*?\]/.exec(block)?.[0] ?? '';
    const rowArr = /data\.map\(r => \[[\s\S]*?\]\)/.exec(block)?.[0] ?? '';
    expect(header).toContain('created_at');
    expect(rowArr).toContain('r.created_at');
    expect(header.split(',').length).toBe(rowArr.split(',').length);
  });
});
