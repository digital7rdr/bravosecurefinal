/**
 * B-843/B-844 — "which account pays for this booking?"
 *
 * A person may now be an active member under ANY number of root accounts, so
 * the payer is a CHOICE, not a lookup. These are the pure rules behind that
 * choice; the money consequence of getting them wrong is a charge landing on a
 * root the member never picked, which is why the plan (D2) fails CLOSED rather
 * than guessing.
 *
 * Deliberately dependency-free (no RN, no axios) so the node `booking` project
 * can execute them instead of scanning source.
 */
import {
  buildPayerChoices,
  defaultPayerChoice,
  payerChoiceFromRefusal,
  payerRefusalMessage,
  type PayerMembershipInput,
} from '../payerOptions';

const SELF = 'user-me';

const m = (over: Partial<PayerMembershipInput> = {}): PayerMembershipInput => ({
  id: 'row-1',
  holderId: 'holder-a',
  holderName: 'Dad',
  spendLimit: 5000,
  spent: 4250,
  remaining: 750,
  held: false,
  rootSuspended: false,
  ...over,
});

describe('buildPayerChoices — order and identity', () => {
  it('puts "My wallet" FIRST and keeps the memberships in the given (oldest-first) order', () => {
    const choices = buildPayerChoices({
      selfUserId: SELF,
      selfBalance: 1200,
      memberships: [
        m({id: 'row-1', holderId: 'holder-a', holderName: 'Dad'}),
        m({id: 'row-2', holderId: 'holder-b', holderName: 'Acme Ltd'}),
      ],
    });
    expect(choices.map(c => c.holderId)).toEqual([SELF, 'holder-a', 'holder-b']);
    expect(choices[0].label).toBe('My wallet');
    expect(choices[1].label).toBe('Dad');
    expect(choices[2].label).toBe('Acme Ltd');
  });

  it('the self row carries the MEMBER\'s own user id — that is what the server reads as "self"', () => {
    const [self] = buildPayerChoices({selfUserId: SELF, selfBalance: 40, memberships: []});
    expect(self.holderId).toBe(SELF);
    expect(self.key).toBe('self');
    expect(self.disabled).toBe(false);
    expect(self.sublabel).toBe('40 BC');
  });

  it('keys are unique and stable, even when the server sends no row id', () => {
    const choices = buildPayerChoices({
      selfUserId: SELF,
      selfBalance: 0,
      memberships: [
        m({id: undefined, holderId: 'holder-a'}),
        m({id: undefined, holderId: 'holder-b'}),
      ],
    });
    const keys = choices.map(c => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is empty of memberships but never of the self row', () => {
    expect(buildPayerChoices({selfUserId: SELF, selfBalance: 0, memberships: []})).toHaveLength(1);
  });
});

describe('buildPayerChoices — what each row says', () => {
  it('shows the remaining quota', () => {
    const [, row] = buildPayerChoices({selfUserId: SELF, selfBalance: 0, memberships: [m({remaining: 750})]});
    expect(row.sublabel).toBe('750 BC left');
    expect(row.disabled).toBe(false);
  });

  it('P3-11 — prefers effectiveSpendable: what the member can ACTUALLY spend', () => {
    // B-709 — `remaining` is the quota; `effectiveSpendable` is
    // min(quota, what the root can still cover). Showing "5,000 BC left" for a
    // root with 200 credits promises money that is not there, and the member
    // discovers it as a refusal at the moment they commit.
    const [, row] = buildPayerChoices({
      selfUserId: SELF, selfBalance: 0,
      memberships: [m({remaining: 5000, effectiveSpendable: 200})],
    });
    expect(row.sublabel).toBe('200 BC left');
  });

  it('falls back to the quota when the server sent no effectiveSpendable', () => {
    // A refusal's `PayerOption` carries no such field, so the two sources must
    // still render through the same builder.
    const [, row] = buildPayerChoices({
      selfUserId: SELF, selfBalance: 0,
      memberships: [m({remaining: 750, effectiveSpendable: undefined})],
    });
    expect(row.sublabel).toBe('750 BC left');
  });

  it('an unlimited quota with a real spendable number shows that number', () => {
    const [, row] = buildPayerChoices({
      selfUserId: SELF, selfBalance: 0,
      memberships: [m({spendLimit: null, remaining: null, effectiveSpendable: 340})],
    });
    expect(row.sublabel).toBe('340 BC left');
  });

  it('an unlimited quota reads "No limit", never "null left"', () => {
    const [, row] = buildPayerChoices({
      selfUserId: SELF, selfBalance: 0,
      memberships: [m({spendLimit: null, remaining: null})],
    });
    expect(row.sublabel).toBe('No limit');
    expect(row.disabled).toBe(false);
  });

  it('a HELD membership is listed but not selectable (edge case 8)', () => {
    const [, row] = buildPayerChoices({selfUserId: SELF, selfBalance: 0, memberships: [m({held: true})]});
    expect(row.disabled).toBe(true);
    expect(row.reason).toBe('on hold');
    expect(row.sublabel).toBe('On hold');
  });

  it('reads the legacy `heldUntil` timestamp as a hold too (FamilyMembership has no `held`)', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const past = new Date(Date.now() - 3600_000).toISOString();
    const [, held] = buildPayerChoices({
      selfUserId: SELF, selfBalance: 0,
      memberships: [m({held: undefined, heldUntil: future})],
    });
    expect(held.disabled).toBe(true);
    const [, lifted] = buildPayerChoices({
      selfUserId: SELF, selfBalance: 0,
      memberships: [m({held: undefined, heldUntil: past})],
    });
    expect(lifted.disabled).toBe(false);
  });

  it('a SUSPENDED root outranks the hold and the quota (§21)', () => {
    const [, row] = buildPayerChoices({
      selfUserId: SELF, selfBalance: 0,
      memberships: [m({held: true, rootSuspended: true, remaining: 5000})],
    });
    expect(row.disabled).toBe(true);
    expect(row.reason).toBe('suspended');
    expect(row.sublabel).toBe('Suspended');
  });

  it('falls back to a neutral name rather than rendering "null"', () => {
    const [, row] = buildPayerChoices({
      selfUserId: SELF, selfBalance: 0,
      memberships: [m({holderName: null})],
    });
    expect(row.label).toBe('Plan holder');
  });
});

describe('defaultPayerChoice — 0 / 1 / N (D5)', () => {
  it('ZERO memberships → the member\'s own wallet', () => {
    const choices = buildPayerChoices({selfUserId: SELF, selfBalance: 100, memberships: []});
    expect(defaultPayerChoice(choices)?.holderId).toBe(SELF);
  });

  it('exactly ONE eligible membership → that one (today\'s behaviour, unchanged)', () => {
    const choices = buildPayerChoices({selfUserId: SELF, selfBalance: 100, memberships: [m()]});
    expect(defaultPayerChoice(choices)?.holderId).toBe('holder-a');
  });

  it('TWO memberships → NO preselection; the member must choose', () => {
    const choices = buildPayerChoices({
      selfUserId: SELF, selfBalance: 100,
      memberships: [m({holderId: 'holder-a'}), m({id: 'row-2', holderId: 'holder-b'})],
    });
    expect(defaultPayerChoice(choices)).toBeNull();
  });

  it('two memberships of which only ONE is eligible still asks — a disabled row is not a fallback', () => {
    const choices = buildPayerChoices({
      selfUserId: SELF, selfBalance: 100,
      memberships: [m({holderId: 'holder-a'}), m({id: 'row-2', holderId: 'holder-b', held: true})],
    });
    expect(defaultPayerChoice(choices)).toBeNull();
  });

  it('a single INELIGIBLE membership never silently redirects the charge to the member\'s wallet', () => {
    const choices = buildPayerChoices({
      selfUserId: SELF, selfBalance: 100,
      memberships: [m({held: true})],
    });
    expect(defaultPayerChoice(choices)).toBeNull();
  });
});

describe('payerChoiceFromRefusal — the server hands back the options with the refusal', () => {
  const options = [
    {holderId: 'holder-a', holderName: 'Dad', spendLimit: 5000, spent: 4250, remaining: 750, held: false, rootSuspended: false},
    {holderId: 'holder-b', holderName: 'Acme Ltd', spendLimit: null, spent: 0, remaining: null, held: false, rootSuspended: false},
  ];

  it.each([
    'PAYER_CHOICE_REQUIRED',
    'SPENDING_QUOTA_EXCEEDED',
    'ROOT_ACCOUNT_SUSPENDED',
    'HOLDER_REQUIRED',
    'insufficient_credits',
  ])('reads options off a %s body', code => {
    expect(payerChoiceFromRefusal({code, message: 'nope', options})).toHaveLength(2);
  });

  it('digs the body out of a live axios rejection', () => {
    const e = {response: {status: 400, data: {code: 'PAYER_CHOICE_REQUIRED', options}}};
    expect(payerChoiceFromRefusal(e)?.[0].holderId).toBe('holder-a');
  });

  it('is null when the refusal carries no options — never an empty list that reads as "no roots"', () => {
    expect(payerChoiceFromRefusal({code: 'PAYER_NOT_ELIGIBLE', message: 'no'})).toBeNull();
    expect(payerChoiceFromRefusal({code: 'PAYER_CHOICE_REQUIRED', options: []})).toBeNull();
    expect(payerChoiceFromRefusal(new Error('network timeout'))).toBeNull();
    expect(payerChoiceFromRefusal(null)).toBeNull();
    expect(payerChoiceFromRefusal(undefined)).toBeNull();
  });

  it('drops malformed rows rather than rendering a row with no id', () => {
    const parsed = payerChoiceFromRefusal({
      code: 'PAYER_CHOICE_REQUIRED',
      options: [{holderName: 'No id'}, options[0]],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0].holderId).toBe('holder-a');
  });

  it('feeds straight into buildPayerChoices — one shape for both sources', () => {
    const parsed = payerChoiceFromRefusal({code: 'PAYER_CHOICE_REQUIRED', options}) ?? [];
    const choices = buildPayerChoices({selfUserId: SELF, selfBalance: 10, memberships: parsed});
    expect(choices.map(c => c.holderId)).toEqual([SELF, 'holder-a', 'holder-b']);
    expect(choices[2].sublabel).toBe('No limit');
  });
});

/**
 * A7 — the copy that keeps a root-paid booking OUT of the top-up paywall.
 *
 * `insufficient_credits` is the same wire code whether the member's own wallet
 * or a root's was short; `payer_is_self` is the only thing that separates
 * them. Routing a root-short refusal to CreditPaywall tells the member to buy
 * credits that cannot pay for the booking — B-384's loop.
 */
describe('payerRefusalMessage — is this a payer problem, and what do we say?', () => {
  const err = (data: Record<string, unknown>) => ({response: {status: 400, data}});

  it('PAYER_CHOICE_REQUIRED asks the question', () => {
    const out = payerRefusalMessage(err({code: 'PAYER_CHOICE_REQUIRED', message: 'Choose which account pays for this booking.'}));
    expect(out).toMatch(/which account pays/i);
  });

  it('PAYER_NOT_ELIGIBLE says the account cannot pay, without blaming the member', () => {
    const out = payerRefusalMessage(err({code: 'PAYER_NOT_ELIGIBLE'}));
    expect(out).toMatch(/can’t pay|cannot pay/i);
    expect(out).not.toMatch(/your (wallet|balance) is/i);
  });

  it('a ROOT-short insufficient_credits offers the OTHER accounts, not a top-up', () => {
    const out = payerRefusalMessage(err({
      code: 'insufficient_credits', message: 'insufficient_credits',
      payer_is_self: false, holder_id: 'holder-a', holder_name: 'Dad',
    }));
    expect(out).toMatch(/enough credit/i);
    expect(out).toMatch(/another account|your wallet/i);
  });

  it('a SELF-short insufficient_credits is NOT a payer problem — that one belongs to the paywall', () => {
    expect(payerRefusalMessage(err({
      code: 'insufficient_credits', message: 'insufficient_credits',
      payer_is_self: true, required: 400, balance: 10,
    }))).toBeNull();
  });

  it('an old server that says nothing about the payer keeps the old paywall route', () => {
    expect(payerRefusalMessage(err({code: 'insufficient_credits', message: 'insufficient_credits'}))).toBeNull();
  });

  it('never swallows an unrelated failure', () => {
    expect(payerRefusalMessage(err({message: 'You already have an active booking.'}))).toBeNull();
    expect(payerRefusalMessage(new Error('network timeout'))).toBeNull();
    expect(payerRefusalMessage(null)).toBeNull();
  });

  it('no raw code ever reaches the copy', () => {
    for (const code of ['PAYER_CHOICE_REQUIRED', 'PAYER_NOT_ELIGIBLE']) {
      const out = payerRefusalMessage(err({code})) ?? '';
      expect(out).not.toContain(code);
      expect(out).not.toMatch(/_/);
    }
  });
});

describe('payerChoiceFromRefusal — the options survive the round trip', () => {
  const options = [
    {holderId: 'holder-a', holderName: 'Dad', spendLimit: 5000, spent: 4250, remaining: 750, held: false, rootSuspended: false},
    {holderId: 'holder-b', holderName: 'Acme Ltd', spendLimit: null, spent: 0, remaining: null, held: false, rootSuspended: false},
  ];

  it('parsed options feed straight into buildPayerChoices — one shape for both sources', () => {
    const parsed = payerChoiceFromRefusal({code: 'PAYER_CHOICE_REQUIRED', options}) ?? [];
    const choices = buildPayerChoices({selfUserId: SELF, selfBalance: 10, memberships: parsed});
    expect(choices.map(c => c.holderId)).toEqual([SELF, 'holder-a', 'holder-b']);
    expect(choices[2].sublabel).toBe('No limit');
  });

  it('a held option parsed from a refusal renders disabled', () => {
    const parsed = payerChoiceFromRefusal({
      code: 'SPENDING_QUOTA_EXCEEDED',
      options: [{...options[0], held: true}],
    }) ?? [];
    const [, row] = buildPayerChoices({selfUserId: SELF, selfBalance: 10, memberships: parsed});
    expect(row.disabled).toBe(true);
    expect(row.reason).toBe('on hold');
  });
});

/**
 * B-854/A12 — `effectiveSpendable` now rides the REFUSAL's options too.
 *
 * With the chain on, a root's true ceiling is
 * `min(C's remaining under B, B's remaining under A, A's credits)` — arithmetic
 * only the server can do. `buildPayerChoices` has preferred `effectiveSpendable`
 * over `remaining` since B-709, but the refusal parser DROPPED the field, so the
 * one path that fires at the exact moment the member is choosing a payer showed
 * the raw quota. That is the promise-money-that-is-not-there defect P3-11 names,
 * one layer further out: the member re-picks the same root and is refused again.
 */
describe('B-854/A12 — toOption carries effectiveSpendable through the refusal', () => {
  it('a root whose quota is 5,000 but whose chain ceiling is 200 renders "200 BC left"', () => {
    const parsed = payerChoiceFromRefusal({
      code: 'PAYER_CHOICE_REQUIRED',
      options: [{
        holderId: 'holder-a', holderName: 'Dad',
        spendLimit: 5000, spent: 0, remaining: 5000,
        effectiveSpendable: 200,
        held: false, rootSuspended: false,
      }],
    }) ?? [];
    expect(parsed[0].effectiveSpendable).toBe(200);
    const [, row] = buildPayerChoices({selfUserId: SELF, selfBalance: 10, memberships: parsed});
    expect(row.sublabel).toBe('200 BC left');
  });

  it('ZERO spendable is a real number, not a missing one — it must not fall back to the quota', () => {
    // The falsy trap: `effectiveSpendable: 0` with `remaining: 5000` is exactly
    // the state a drained root is in, and the row that matters most to get right.
    const parsed = payerChoiceFromRefusal({
      code: 'SPENDING_QUOTA_EXCEEDED',
      options: [{
        holderId: 'holder-a', holderName: 'Dad',
        spendLimit: 5000, spent: 0, remaining: 5000,
        effectiveSpendable: 0,
        held: false, rootSuspended: false,
      }],
    }) ?? [];
    expect(parsed[0].effectiveSpendable).toBe(0);
    const [, row] = buildPayerChoices({selfUserId: SELF, selfBalance: 10, memberships: parsed});
    expect(row.sublabel).toBe('0 BC left');
  });

  it('an old server that sends no effectiveSpendable parses to null, and the quota still shows', () => {
    const parsed = payerChoiceFromRefusal({
      code: 'PAYER_CHOICE_REQUIRED',
      options: [{holderId: 'holder-a', holderName: 'Dad', spendLimit: 5000, spent: 4250, remaining: 750, held: false, rootSuspended: false}],
    }) ?? [];
    expect(parsed[0].effectiveSpendable ?? null).toBeNull();
    const [, row] = buildPayerChoices({selfUserId: SELF, selfBalance: 10, memberships: parsed});
    expect(row.sublabel).toBe('750 BC left');
  });

  it('a non-numeric effectiveSpendable is dropped rather than rendered', () => {
    const parsed = payerChoiceFromRefusal({
      code: 'PAYER_CHOICE_REQUIRED',
      options: [{
        holderId: 'holder-a', holderName: 'Dad',
        spendLimit: null, spent: 0, remaining: null,
        effectiveSpendable: 'lots',
        held: false, rootSuspended: false,
      }],
    }) ?? [];
    expect(parsed[0].effectiveSpendable ?? null).toBeNull();
    const [, row] = buildPayerChoices({selfUserId: SELF, selfBalance: 10, memberships: parsed});
    expect(row.sublabel).toBe('No limit');
  });
});
