/**
 * Family spending-quota error handling on the CLIENT.
 *
 * The server is the authority on every number here (§38, §48); these helpers
 * only decide which screen the member sees and which figures it may render
 * without a second round trip. The rule that matters most is §8 vs §9: two
 * different refusals that must never be shown interchangeably, because one has
 * a "Request More Credit" action and the other has nothing the member can do.
 */
import {
  fundMembersRefusalMessage, holderFrom, humanCreditMessage, pendingCreditRequestFrom,
  quotaFiguresFrom, quotaFloorFrom, spendDenialKind,
} from '../creditErrors';

/** An axios-shaped rejection carrying a Nest structured 400 body. */
const serverError = (body: Record<string, unknown>) => ({response: {data: body}});

describe('§8 vs §9 — the denial names the right limit', () => {
  it('§8: the member\'s own quota is exhausted', () => {
    const e = serverError({
      code: 'SPENDING_QUOTA_EXCEEDED', message: 'family_spend_limit_exceeded',
      required: 400, allocated: 5000, used: 5000, remaining: 0,
    });
    expect(spendDenialKind(e, {isFamilyMember: true})).toBe('SPENDING_QUOTA_EXCEEDED');
  });

  it('§9: the ROOT is empty while the member still has quota', () => {
    const e = serverError({code: 'insufficient_credits', message: 'insufficient_credits', required: 400, balance: 0});
    expect(spendDenialKind(e, {isFamilyMember: true})).toBe('ROOT_CREDIT_UNAVAILABLE');
  });

  it('the SAME wire error means something else for a solo payer', () => {
    // Identical body — only the caller's own membership distinguishes them, and
    // the copy must follow.
    const e = serverError({code: 'insufficient_credits', message: 'insufficient_credits'});
    expect(spendDenialKind(e, {isFamilyMember: false})).toBe('INSUFFICIENT_CREDITS');
    expect(spendDenialKind(e)).toBe('INSUFFICIENT_CREDITS');
  });

  it('§21: a suspended root outranks both, and is checked first', () => {
    const e = serverError({code: 'ROOT_ACCOUNT_SUSPENDED', message: 'root_account_suspended'});
    expect(spendDenialKind(e, {isFamilyMember: true})).toBe('ROOT_ACCOUNT_SUSPENDED');
  });

  it('is undefined for an unrelated failure — it must not swallow real errors', () => {
    expect(spendDenialKind(serverError({message: 'Booking not found'}))).toBeUndefined();
    expect(spendDenialKind(new Error('network timeout'))).toBeUndefined();
    expect(spendDenialKind(null)).toBeUndefined();
    expect(spendDenialKind(undefined)).toBeUndefined();
  });

  it('survives a flattened Error that kept only the raw code', () => {
    // The store's catch has historically collapsed structured bodies into
    // `new Error(raw)`; all three carriers must still resolve.
    expect(spendDenialKind(new Error('family_spend_limit_exceeded'))).toBe('SPENDING_QUOTA_EXCEEDED');
    expect(spendDenialKind(new Error('root_account_suspended'))).toBe('ROOT_ACCOUNT_SUSPENDED');
  });

  it('reads a validation-pipe string[] message as well as a string', () => {
    const e = serverError({message: ['family_spend_limit_exceeded', 'something else']});
    expect(spendDenialKind(e)).toBe('SPENDING_QUOTA_EXCEEDED');
  });
});

describe('§48 — the figures come from the server, never from the stale UI', () => {
  it('extracts the full quota picture from the refusal', () => {
    const e = serverError({
      code: 'SPENDING_QUOTA_EXCEEDED', message: 'family_spend_limit_exceeded',
      required: 400, allocated: 5000, used: 4250, remaining: 750,
    });
    expect(quotaFiguresFrom(e)).toEqual({required: 400, allocated: 5000, used: 4250, remaining: 750});
  });

  it('returns undefined rather than a partial set — the caller must refresh', () => {
    // Rendering three real numbers and one guessed one is worse than refreshing:
    // the whole point of §48 is that the client's own copy may be wrong.
    expect(quotaFiguresFrom(serverError({code: 'SPENDING_QUOTA_EXCEEDED', required: 400}))).toBeUndefined();
    expect(quotaFiguresFrom(serverError({}))).toBeUndefined();
    expect(quotaFiguresFrom(new Error('family_spend_limit_exceeded'))).toBeUndefined();
  });
});

describe('§19/§44 — the quota floor for the confirmation dialog', () => {
  it('reads the minimum from a QUOTA_BELOW_SPENT refusal', () => {
    const e = serverError({code: 'QUOTA_BELOW_SPENT', message: 'quota_below_spent', minimumCredits: 4500, spentCredits: 4500});
    expect(quotaFloorFrom(e)).toBe(4500);
  });

  it('ignores an unrelated error, so a stale floor cannot be shown', () => {
    expect(quotaFloorFrom(serverError({code: 'insufficient_credits', minimumCredits: 4500}))).toBeUndefined();
    expect(quotaFloorFrom(serverError({code: 'QUOTA_BELOW_SPENT'}))).toBeUndefined();
  });
});

describe('§12/§42 — never offer a button that creates a duplicate request', () => {
  it('extracts the OPEN request id so the UI can show "View Request"', () => {
    const e = serverError({
      code: 'CREDIT_REQUEST_PENDING', message: 'credit_request_pending',
      requestId: 'req-1', requestedCredits: 2000,
    });
    expect(pendingCreditRequestFrom(e)).toEqual({id: 'req-1', requestedCredits: 2000});
  });

  it('returns undefined without an id — there is nothing to link to', () => {
    expect(pendingCreditRequestFrom(serverError({code: 'CREDIT_REQUEST_PENDING'}))).toBeUndefined();
    expect(pendingCreditRequestFrom(serverError({code: 'insufficient_credits', requestId: 'x'}))).toBeUndefined();
  });
});

/**
 * B-843/A7/A11 — the SERVER now says whose wallet was short and which root
 * refused. `isFamilyMember` was a caller-side guess that no production caller
 * ever passed; `payer_is_self` is the same question answered by the side that
 * actually knows, so it must win wherever it is present.
 */
describe('B-843 — the body decides whose wallet it was, not the caller', () => {
  it('payer_is_self:false means the ROOT was short, with no opt passed at all', () => {
    const e = serverError({
      code: 'insufficient_credits', message: 'insufficient_credits',
      payer_is_self: false, holder_id: 'holder-a', holder_name: 'Dad', required: 400,
    });
    expect(spendDenialKind(e)).toBe('ROOT_CREDIT_UNAVAILABLE');
  });

  it('payer_is_self:true OVERRULES a stale isFamilyMember opt — the member paid themselves', () => {
    const e = serverError({
      code: 'insufficient_credits', message: 'insufficient_credits',
      payer_is_self: true, required: 400, balance: 10,
    });
    expect(spendDenialKind(e, {isFamilyMember: true})).toBe('INSUFFICIENT_CREDITS');
  });

  it('falls back to the opt when the server says nothing (an old server)', () => {
    const e = serverError({code: 'insufficient_credits', message: 'insufficient_credits'});
    expect(spendDenialKind(e, {isFamilyMember: true})).toBe('ROOT_CREDIT_UNAVAILABLE');
    expect(spendDenialKind(e)).toBe('INSUFFICIENT_CREDITS');
  });

  it('holderFrom names the root that refused, so the alert can say WHICH one', () => {
    const e = serverError({
      code: 'SPENDING_QUOTA_EXCEEDED', message: 'family_spend_limit_exceeded',
      holder_id: 'holder-a', holder_name: 'Dad',
    });
    expect(holderFrom(e)).toEqual({holderId: 'holder-a', holderName: 'Dad'});
  });

  it('holderFrom is undefined when the server named nobody — never a guessed name', () => {
    expect(holderFrom(serverError({code: 'SPENDING_QUOTA_EXCEEDED'}))).toBeUndefined();
    expect(holderFrom(new Error('family_spend_limit_exceeded'))).toBeUndefined();
    expect(holderFrom(null)).toBeUndefined();
  });

  it('holderFrom survives an id with no name (the id is what the deep link needs)', () => {
    expect(holderFrom(serverError({holder_id: 'holder-a'}))).toEqual({holderId: 'holder-a', holderName: null});
  });
});

describe('no raw server code may ever reach the user (§8)', () => {
  it.each([
    'root_account_suspended',
    'family_spend_limit_exceeded',
    'SPENDING_QUOTA_EXCEEDED',
    'insufficient_credits',
  ])('%s is humanized', raw => {
    const out = humanCreditMessage(raw, {isFamilyMember: true});
    expect(out).toBeDefined();
    expect(out).not.toContain(raw);
    expect(out).not.toMatch(/_/);
  });
});

/**
 * B-854 — the chained-funding refusals.
 *
 * Every one of these is a rule that RETRYING cannot satisfy, which is the exact
 * class §19's quota floor already exists to keep out of a "Please try again"
 * loop. Two of them are also the only thing that explains a switch which
 * visibly refuses to move: a second root already funds these members (D1's one
 * funding root), or bookings are still running on the chain (A10).
 */
describe('B-854 — the funding refusals say what the member/root must do', () => {
  it('funding_source_already_set names the rule: ONE funding root', () => {
    const out = fundMembersRefusalMessage(serverError({
      code: 'funding_source_already_set', message: 'funding_source_already_set',
    }));
    expect(out).toBeDefined();
    expect(out).toMatch(/another account/i);
    expect(out).not.toMatch(/_/);
  });

  it('funding_cycle explains that the two accounts cannot fund each other', () => {
    const out = fundMembersRefusalMessage(serverError({code: 'funding_cycle', message: 'funding_cycle'}));
    expect(out).toBeDefined();
    expect(out).toMatch(/each other|already fund/i);
    expect(out).not.toMatch(/_/);
  });

  /**
   * The body is the SERVER's, copied from `family.service.ts:848` — not one
   * invented to match the client. The first cut keyed on `no_members_to_fund`,
   * a code the server never emits, so the branch was dead and its pin passed
   * only because the fixture fabricated the payload (the repo's
   * tests-cannot-vouch-for-invented-payloads rule, exactly).
   */
  it('no_sub_members says there is nobody to fund yet — the SERVER\'s code', () => {
    const out = fundMembersRefusalMessage(serverError({
      code: 'NO_SUB_MEMBERS', message: 'no_sub_members',
    }));
    expect(out).toBeDefined();
    expect(out).toMatch(/no members|don’t have any members/i);
    expect(out).not.toMatch(/_/);
  });

  it('the code the server never sends is NOT what the branch keys on', () => {
    // Guards the regression directly: if someone re-introduces the invented
    // literal, this starts matching and the real one stops.
    expect(fundMembersRefusalMessage(serverError({
      code: 'no_members_to_fund', message: 'no_members_to_fund',
    }))).toBeUndefined();
  });

  it('MEMBER_NOT_ACTIVE is understood in either casing', () => {
    for (const raw of ['MEMBER_NOT_ACTIVE', 'member_not_active']) {
      const out = fundMembersRefusalMessage(serverError({code: raw, message: raw}));
      expect(out).toBeDefined();
      expect(out).toMatch(/not active|on hold/i);
      expect(out).not.toMatch(/_/);
    }
  });

  /** A10 — the one refusal that carries a number the root actually needs. */
  it('chained_bookings_in_flight quotes the SERVER\'s count', () => {
    const out = fundMembersRefusalMessage(serverError({
      code: 'chained_bookings_in_flight', message: 'chained_bookings_in_flight', count: 3,
    }));
    expect(out).toBe('3 of their members’ bookings are still in progress. Try again when they finish.');
  });

  it('reads ONE as singular rather than "1 … are"', () => {
    const out = fundMembersRefusalMessage(serverError({
      code: 'chained_bookings_in_flight', message: 'chained_bookings_in_flight', count: 1,
    }));
    expect(out).toBe('1 of their members’ bookings is still in progress. Try again when they finish.');
  });

  it('never invents a count the server did not send', () => {
    const out = fundMembersRefusalMessage(serverError({
      code: 'chained_bookings_in_flight', message: 'chained_bookings_in_flight',
    }));
    expect(out).toBeDefined();
    expect(out).toMatch(/still in progress/i);
    // A guessed "0 of their members' bookings" reads as "nothing is running",
    // which is the opposite of why the switch refused to move.
    expect(out).not.toMatch(/\b0\b|\bundefined\b|\bNaN\b/);
  });

  it('is undefined for anything else — it must not swallow a real failure', () => {
    expect(fundMembersRefusalMessage(serverError({code: 'insufficient_credits'}))).toBeUndefined();
    expect(fundMembersRefusalMessage(serverError({message: 'Booking not found'}))).toBeUndefined();
    expect(fundMembersRefusalMessage(new Error('network timeout'))).toBeUndefined();
    expect(fundMembersRefusalMessage(null)).toBeUndefined();
    expect(fundMembersRefusalMessage(undefined)).toBeUndefined();
  });

  it('survives a flattened Error that kept only the raw code', () => {
    // The store's catch has historically collapsed structured bodies; the code
    // must still resolve from the message alone.
    expect(fundMembersRefusalMessage(new Error('funding_source_already_set'))).toBeDefined();
    expect(fundMembersRefusalMessage(new Error('no_sub_members'))).toBeDefined();
  });

  it('reads a validation-pipe string[] message as well as a string', () => {
    expect(fundMembersRefusalMessage(serverError({message: ['funding_cycle', 'and more']}))).toBeDefined();
  });

  /**
   * The holder's Allow/Decline card answers a PENDING request. If the request
   * was withdrawn, expired, or already decided on another device, there is
   * nothing to answer — and "Please try again" would loop the holder against a
   * row that no longer exists.
   */
  it('no_funding_request says there is nothing to answer', () => {
    const out = fundMembersRefusalMessage(serverError({
      code: 'no_funding_request', message: 'no_funding_request',
    }));
    expect(out).toBeDefined();
    expect(out).toMatch(/no request/i);
    expect(out).not.toMatch(/_/);
  });

  /**
   * The SAME wire code, two readers. The holder is told about THEIR member's
   * members; the member is told about their OWN. "their members" on the
   * member's own screen names nobody they recognise.
   */
  it('chained_bookings_in_flight speaks to whoever is reading it', () => {
    const e = serverError({
      code: 'chained_bookings_in_flight', message: 'chained_bookings_in_flight', count: 2,
    });
    expect(fundMembersRefusalMessage(e)).toBe(
      '2 of their members’ bookings are still in progress. Try again when they finish.',
    );
    expect(fundMembersRefusalMessage(e, {side: 'member'})).toBe(
      '2 of your members’ bookings are in progress — try again when they finish.',
    );
  });

  it('the member-side copy reads ONE as singular too', () => {
    const out = fundMembersRefusalMessage(serverError({
      code: 'chained_bookings_in_flight', message: 'chained_bookings_in_flight', count: 1,
    }), {side: 'member'});
    expect(out).toBe('1 of your members’ bookings is in progress — try again when they finish.');
  });

  it('the member-side copy never invents a count either', () => {
    const out = fundMembersRefusalMessage(serverError({
      code: 'chained_bookings_in_flight', message: 'chained_bookings_in_flight',
    }), {side: 'member'});
    // Case-insensitive: with no count the sentence starts on the word.
    expect(out).toMatch(/your members’ bookings/i);
    expect(out).not.toMatch(/\b0\b|\bundefined\b|\bNaN\b/);
  });

  /**
   * `family.service.ts:928` — the member asked twice (two devices, or a stale
   * screen). The ask they already filed is still open, so "Please try again"
   * would invite a third attempt the server will refuse identically.
   */
  it('funding_request_pending says the ask is already waiting, and names the root', () => {
    const out = fundMembersRefusalMessage(serverError({
      code: 'FUNDING_REQUEST_PENDING', message: 'funding_request_pending', requestId: 'fr-9',
    }), {side: 'member', holderName: 'Dad'});
    expect(out).toBe('Your request is already waiting for Dad.');
    expect(out).not.toMatch(/try again/i);
    expect(out).not.toMatch(/_/);
  });

  it('falls back to a neutral noun when no root was named — never "undefined"', () => {
    const out = fundMembersRefusalMessage(serverError({
      code: 'FUNDING_REQUEST_PENDING', message: 'funding_request_pending',
    }), {side: 'member'});
    expect(out).toMatch(/already waiting/i);
    expect(out).not.toMatch(/undefined|null/);
    expect(out).not.toMatch(/try again/i);
  });

  it('the side never leaks a raw code, whichever way it is read', () => {
    for (const side of ['holder', 'member'] as const) {
      for (const code of ['funding_cycle', 'funding_source_already_set', 'no_funding_request']) {
        const out = fundMembersRefusalMessage(serverError({code, message: code}), {side}) ?? '';
        expect(out).not.toContain(code);
        expect(out).not.toMatch(/_/);
      }
    }
  });
});
