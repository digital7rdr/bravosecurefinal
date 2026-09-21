/**
 * The family MEMBER's spending card — spec §41, §42, and the §8/§9/§21 split.
 *
 * These are render tests rather than a source scan because the rules are about
 * WHICH state the member is shown, and the states differ only in copy and in
 * which single action is offered. Getting that wrong is the defect §9 names:
 * telling a member their quota is exhausted when the real problem is the root
 * account sends them to ask for credit that cannot help.
 */
import React from 'react';
import {render, screen, waitFor, fireEvent, act} from '@testing-library/react-native';

// `mock`-prefixed so Jest's out-of-scope guard allows the factory to close
// over them (the guard whitelists that prefix precisely for this).
const mockMembership = jest.fn();
const mockMemberships = jest.fn();
const mockRequestCredit = jest.fn();
const mockCancelCredit = jest.fn();
const mockRequestFundMembers = jest.fn();
const mockStopFundMembers = jest.fn();
const mockAlert = jest.fn();

jest.mock('@services/api', () => ({
  familyApi: {
    membership:    (...a: unknown[]) => mockMembership(...a),
    memberships:   (...a: unknown[]) => mockMemberships(...a),
    requestCredit: (...a: unknown[]) => mockRequestCredit(...a),
    cancelCredit:  (...a: unknown[]) => mockCancelCredit(...a),
    requestFundMembers: (...a: unknown[]) => mockRequestFundMembers(...a),
    stopFundMembers:    (...a: unknown[]) => mockStopFundMembers(...a),
  },
}));
jest.mock('@utils/alert', () => ({Alert: {alert: (...a: unknown[]) => mockAlert(...a)}}));
// useFocusEffect fires the effect once on mount, which is all these tests need.
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => { const React2 = require('react'); React2.useEffect(cb, []); },
}));

import {FamilyQuotaCard} from '../FamilyQuotaCard';
import type {FamilyMembership} from '@services/api';

// Typed as the real DTO, not inferred from the literal: inference would narrow
// `pendingRequest` to `null` and `remaining` to `number`, so the overrides these
// tests depend on (a pending request, an unlimited quota) would not type-check —
// and a fixture that cannot express the states under test is worse than useless.
const base: FamilyMembership = {
  id: 'row-1',
  holderId: 'u-holder', holderName: 'Dad', heldUntil: null,
  spendLimit: 5000, spent: 4250, remaining: 750, effectiveSpendable: 750,
  rootSuspended: false, pendingRequest: null,
};
/**
 * B-843 — the card list now comes from `memberships()`. These cases feed the
 * SAME single membership through it, so every §41/§42 rule below is unchanged;
 * the multi-root cases live in their own describe at the end.
 */
const give = (over: Partial<FamilyMembership> = {}) =>
  mockMemberships.mockResolvedValue({data: {memberships: [{...base, ...over}]}});
const giveMany = (...rows: Array<Partial<FamilyMembership>>) =>
  mockMemberships.mockResolvedValue({
    data: {memberships: rows.map(r => ({...base, ...r}))},
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockRequestCredit.mockResolvedValue({data: {}});
  mockCancelCredit.mockResolvedValue({data: {ok: true}});
  mockRequestFundMembers.mockResolvedValue({data: {request: {id: 'fr-1', status: 'pending'}}});
  mockStopFundMembers.mockResolvedValue({data: {ok: true}});
});

describe('§41 — the member sees allocated, used and remaining', () => {
  it('renders all three figures from the SERVER, not from local arithmetic', async () => {
    give();
    render(<FamilyQuotaCard />);
    // The spec's own worked example: 5,000 limit / 4,250 used / 750 remaining.
    // Why: this is the FIRST mount in the file and pays the module-graph cost —
    // 525 ms in isolation but 22 s under a full pre-push sweep, so waitFor's
    // 1 000 ms default coin-flipped a push. The timeout is load headroom, not a
    // slower assertion (it still resolves on the first passing poll).
    await waitFor(() => expect(screen.getByText('5,000')).toBeTruthy(), {timeout: 10_000});
    expect(screen.getByText('4,250')).toBeTruthy();
    expect(screen.getByText('750')).toBeTruthy();
    expect(screen.getByText('Limit')).toBeTruthy();
    expect(screen.getByText('Remaining')).toBeTruthy();
  });

  it('never displays the holder\'s raw balance', async () => {
    // §41 says "if appropriate"; a member is not entitled to the holder's
    // finances, so the API does not send it and the card cannot leak it.
    give({effectiveSpendable: 750});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText('750')).toBeTruthy());
    expect(screen.queryByText(/Root Credit/i)).toBeNull();
  });

  it('renders NOTHING for a user who is not a family member', async () => {
    mockMemberships.mockResolvedValue({data: {memberships: []}});
    const {toJSON} = render(<FamilyQuotaCard />);
    await waitFor(() => expect(mockMemberships).toHaveBeenCalled());
    await waitFor(() => expect(toJSON()).toBeNull());
  });

  it('falls back to the single-membership read on a ≤1.0.306 server (D6)', async () => {
    // `memberships` 404s there; the one card must still render exactly as it
    // did before, or upgrading the APK before the server blanks the screen.
    mockMemberships.mockRejectedValue({response: {status: 404, data: {}}});
    mockMembership.mockResolvedValue({data: {membership: base}});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText('5,000')).toBeTruthy(), {timeout: 10_000});
    expect(screen.getByText(/On Dad’s plan/)).toBeTruthy();
  });
});

describe('§34 — the approaching-limit warning', () => {
  it('warns at 80% and above', async () => {
    give({spent: 4100, remaining: 900, effectiveSpendable: 900});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText(/approaching your spending limit/i)).toBeTruthy());
  });

  it('stays quiet below 80%', async () => {
    give({spent: 1000, remaining: 4000, effectiveSpendable: 4000});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText('4,000')).toBeTruthy());
    expect(screen.queryByText(/approaching/i)).toBeNull();
  });
});

describe('§8 vs §9 vs §21 — three different refusals, three different messages', () => {
  it('§8: quota exhausted says so, and offers the request action', async () => {
    give({spent: 5000, remaining: 0, effectiveSpendable: 0});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText(/reached your spending limit/i)).toBeTruthy());
    expect(screen.getByLabelText(/Request more credit/i)).toBeTruthy();
  });

  it('§9: quota INTACT but the root is empty — must NOT blame their limit', async () => {
    // remaining 2,000 of quota, but nothing spendable because the root is at 0.
    give({spent: 3000, remaining: 2000, effectiveSpendable: 0});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText(/Root Account currently has insufficient credit/i)).toBeTruthy());
    // THE regression to guard: telling them their own limit is exhausted.
    expect(screen.queryByText(/reached your spending limit/i)).toBeNull();
  });

  it('§21: a suspended root outranks both messages', async () => {
    give({spent: 0, remaining: 5000, effectiveSpendable: 0, rootSuspended: true});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText(/suspended/i)).toBeTruthy());
    expect(screen.queryByText(/reached your spending limit/i)).toBeNull();
    expect(screen.queryByText(/Root Account currently has insufficient/i)).toBeNull();
  });
});

describe('§42/§12 — never offer a button that creates a duplicate request', () => {
  it('shows the PENDING state instead of the request button', async () => {
    give({
      spent: 5000, remaining: 0, effectiveSpendable: 0,
      pendingRequest: {id: 'req-1', requestedCredits: 2000, createdAt: new Date().toISOString()},
    });
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText(/2,000 BC is pending approval/i)).toBeTruthy());
    // The duplicate-creating affordance must be gone entirely.
    expect(screen.queryByLabelText(/Request more credit/i)).toBeNull();
  });

  it('§17 — the member can cancel their own pending request', async () => {
    give({
      spent: 5000, remaining: 0, effectiveSpendable: 0,
      pendingRequest: {id: 'req-1', requestedCredits: 2000, createdAt: new Date().toISOString()},
    });
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByLabelText(/Cancel your pending credit request/i)).toBeTruthy());
    fireEvent.press(screen.getByLabelText(/Cancel your pending credit request/i));
    await waitFor(() => expect(mockCancelCredit).toHaveBeenCalledWith('req-1'));
  });

  it('a server CREDIT_REQUEST_PENDING refusal reconciles instead of retrying', async () => {
    give({spent: 5000, remaining: 0, effectiveSpendable: 0});
    mockRequestCredit.mockRejectedValue({
      response: {data: {code: 'CREDIT_REQUEST_PENDING', message: 'credit_request_pending', requestId: 'req-9'}},
    });
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByLabelText(/Request more credit/i)).toBeTruthy());
    fireEvent.press(screen.getByLabelText(/Request more credit/i));
    fireEvent.changeText(screen.getByLabelText(/Additional credits requested/i), '2000');
    fireEvent.press(screen.getByLabelText(/Send credit request/i));
    await waitFor(() => expect(mockAlert).toHaveBeenCalledWith(
      'Request already pending', expect.stringContaining('awaiting approval'),
    ));
    // …and it re-reads rather than insisting: the initial load plus the reload.
    await waitFor(() => expect(mockMemberships).toHaveBeenCalledTimes(2));
  });
});

describe('§30 — the amount is validated before it is sent', () => {
  it.each(['0', '-100', '', 'abc'])('refuses %p without calling the API', async text => {
    give({spent: 5000, remaining: 0, effectiveSpendable: 0});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByLabelText(/Request more credit/i)).toBeTruthy());
    fireEvent.press(screen.getByLabelText(/Request more credit/i));
    fireEvent.changeText(screen.getByLabelText(/Additional credits requested/i), text);
    fireEvent.press(screen.getByLabelText(/Send credit request/i));
    await waitFor(() => expect(mockAlert).toHaveBeenCalledWith('Enter an amount', expect.any(String)));
    expect(mockRequestCredit).not.toHaveBeenCalled();
  });

  it('sends a valid amount', async () => {
    give({spent: 5000, remaining: 0, effectiveSpendable: 0});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByLabelText(/Request more credit/i)).toBeTruthy());
    fireEvent.press(screen.getByLabelText(/Request more credit/i));
    fireEvent.changeText(screen.getByLabelText(/Additional credits requested/i), '2000');
    fireEvent.press(screen.getByLabelText(/Send credit request/i));
    // B-724 — the optional reason rides along (undefined when left empty).
    // B-843/A13 — RE-POINTED: the request now names WHICH root is being asked.
    // The server refuses a holder-less request from a member with ≥2 roots, and
    // an unnamed one from a member with exactly one would be a coin flip the
    // moment they join a second.
    await waitFor(() => expect(mockRequestCredit).toHaveBeenCalledWith(2000, undefined, 'u-holder'));
  });
});

/**
 * B-843/D6/A14 — one card per root.
 *
 * "Your plan holder" is singular copy for a world that no longer exists: a
 * person may be on their family's plan AND their employer's. Each card is its
 * own quota, its own warnings and its own request button, keyed by the
 * membership ROW id so a `family-quota-changed {familyRowId}` wake is mappable
 * to the card it changed.
 */
describe('B-843 — a member under several roots gets a card each', () => {
  const two = () => giveMany(
    {id: 'row-1', holderId: 'u-dad', holderName: 'Dad', spendLimit: 5000, spent: 4250, remaining: 750, effectiveSpendable: 750},
    {id: 'row-2', holderId: 'u-acme', holderName: 'Acme Ltd', spendLimit: 9000, spent: 1000, remaining: 8000, effectiveSpendable: 8000},
  );

  it('renders BOTH, each named and each with its own figures', async () => {
    two();
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText(/On Dad’s plan/)).toBeTruthy(), {timeout: 10_000});
    expect(screen.getByText(/On Acme Ltd’s plan/)).toBeTruthy();
    expect(screen.getByText('750')).toBeTruthy();
    expect(screen.getByText('8,000')).toBeTruthy();
  });

  it('each request button asks ITS OWN root', async () => {
    two();
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByLabelText(/Request more credit from Acme Ltd/i)).toBeTruthy(), {timeout: 10_000});
    fireEvent.press(screen.getByLabelText(/Request more credit from Acme Ltd/i));
    fireEvent.changeText(screen.getByLabelText(/Additional credits requested from Acme Ltd/i), '1500');
    fireEvent.press(screen.getByLabelText(/Send credit request to Acme Ltd/i));
    await waitFor(() => expect(mockRequestCredit).toHaveBeenCalledWith(1500, undefined, 'u-acme'));
  });

  it('one root\'s state never leaks into the other\'s card', async () => {
    giveMany(
      {id: 'row-1', holderId: 'u-dad', holderName: 'Dad', spent: 5000, remaining: 0, effectiveSpendable: 0},
      {id: 'row-2', holderId: 'u-acme', holderName: 'Acme Ltd', spendLimit: 9000, spent: 1000, remaining: 8000, effectiveSpendable: 8000},
    );
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText(/reached your spending limit/i)).toBeTruthy(), {timeout: 10_000});
    // Exactly ONE card is exhausted; the other must still offer its full quota.
    expect(screen.queryAllByText(/reached your spending limit/i)).toHaveLength(1);
    expect(screen.getByLabelText(/Request more credit from Acme Ltd/i)).toBeTruthy();
  });

  it('focusHolderId highlights the card the refusal was about (A11)', async () => {
    two();
    render(<FamilyQuotaCard focusHolderId="u-acme" />);
    await waitFor(() => expect(screen.getByTestId('quota-card-u-acme')).toBeTruthy(), {timeout: 10_000});
    expect(screen.getByTestId('quota-card-u-acme').props.accessibilityState?.selected).toBe(true);
    expect(screen.getByTestId('quota-card-u-dad').props.accessibilityState?.selected).toBe(false);
  });

  it('an unknown focusHolderId highlights nothing rather than the first card', async () => {
    two();
    render(<FamilyQuotaCard focusHolderId="u-nobody" />);
    await waitFor(() => expect(screen.getByTestId('quota-card-u-dad')).toBeTruthy(), {timeout: 10_000});
    expect(screen.getByTestId('quota-card-u-dad').props.accessibilityState?.selected).toBe(false);
    expect(screen.getByTestId('quota-card-u-acme').props.accessibilityState?.selected).toBe(false);
  });
});

describe('unlimited quota', () => {
  it('shows no bar and offers no request button — there is no ceiling to raise', async () => {
    give({spendLimit: null, remaining: null, spent: 900, effectiveSpendable: 9999});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText(/No spending limit set/i)).toBeTruthy());
    expect(screen.queryByLabelText(/Request more credit/i)).toBeNull();
  });
});

/**
 * B-854 — the chain, from the MEMBER's side.
 *
 * This member holds members of their own. Today their members' bookings can
 * only ever come out of this member's OWN wallet; the chain lets them come out
 * of the root's allowance instead, inside this member's existing limit.
 *
 * The rule that shapes this whole surface is A11: it is the ROOT's money, so
 * the member ASKS and the root decides. There is deliberately NO member-side
 * off switch — a member who could switch it on and off at will would be
 * deciding how the root's money is spent, which is the thing the approval model
 * exists to prevent.
 */
describe('B-854 — "fund my members from this root"', () => {
  const ask = /Ask Dad to fund your members/i;

  /** Press the CONFIRM button of the last alert, the way a person would. */
  const confirmLastAlert = async (label: RegExp) => {
    const buttons = mockAlert.mock.calls[mockAlert.mock.calls.length - 1][2] as
      Array<{text: string; onPress?: () => void}>;
    const btn = buttons.find(b => label.test(b.text));
    expect(btn).toBeTruthy();
    await act(async () => { btn!.onPress?.(); });
  };

  it('is HIDDEN for a member who holds nobody — there is nothing to fund', async () => {
    give({holdsMembersCount: 0});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText('5,000')).toBeTruthy(), {timeout: 10_000});
    expect(screen.queryByLabelText(ask)).toBeNull();
    expect(screen.queryByText(/fund your members|your members spend/i)).toBeNull();
  });

  it('is HIDDEN on a ≤1.0.309 server that sends no count at all', async () => {
    // Absent must read as "off", never as a broken or half-drawn control.
    give({holdsMembersCount: undefined});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText('5,000')).toBeTruthy(), {timeout: 10_000});
    expect(screen.queryByLabelText(ask)).toBeNull();
  });

  it('NOT REQUESTED → an "Ask {root}" button naming the root', async () => {
    give({holdsMembersCount: 2, fundsSubMembers: false, fundingRequest: null});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByLabelText(ask)).toBeTruthy(), {timeout: 10_000});
    expect(screen.getByText(/Ask Dad/)).toBeTruthy();
  });

  it('PENDING → "Waiting for {root}", and the button is gone', async () => {
    give({holdsMembersCount: 2, fundingRequest: {id: 'fr-1', status: 'pending'}});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText(/Waiting for Dad/i)).toBeTruthy(), {timeout: 10_000});
    // A duplicate ask is a request the server refuses anyway.
    expect(screen.queryByLabelText(ask)).toBeNull();
  });

  /**
   * A11 is about who may WIDEN the spend, not who may narrow it. Turning the
   * chain ON takes the root's approval; turning it OFF takes nobody's — it only
   * ever reduces who can reach the root's money, and the member is the one who
   * knows when their members no longer need it.
   */
  it('APPROVED → the ON line, a Stop row, and still no way to re-arm it alone', async () => {
    give({
      holdsMembersCount: 2, fundsSubMembers: true,
      fundingRequest: {id: 'fr-1', status: 'approved', createdAt: '2026-09-11T00:00:00.000Z'},
    });
    render(<FamilyQuotaCard />);
    await waitFor(
      () => expect(screen.getByText(/your members spend from Dad’s allowance/i)).toBeTruthy(),
      {timeout: 10_000},
    );
    expect(screen.getByLabelText(/Stop funding your members from Dad/i)).toBeTruthy();
    // THE regression to guard: an affordance that switches the chain back ON
    // without the root — that IS the money-widening act A11 reserves for them.
    expect(screen.queryByLabelText(ask)).toBeNull();
  });

  it('the Stop row confirms first, then calls the MEMBERSHIP route', async () => {
    give({
      id: 'row-7', holdsMembersCount: 2, fundsSubMembers: true,
      fundingRequest: {id: 'fr-1', status: 'approved', createdAt: '2026-09-11T00:00:00.000Z'},
    });
    mockStopFundMembers.mockResolvedValue({data: {ok: true}});
    render(<FamilyQuotaCard />);
    const stop = await waitFor(
      () => screen.getByLabelText(/Stop funding your members from Dad/i), {timeout: 10_000});
    fireEvent.press(stop);
    expect(mockStopFundMembers).not.toHaveBeenCalled();
    await confirmLastAlert(/stop/i);
    await waitFor(() => expect(mockStopFundMembers).toHaveBeenCalledWith('row-7'));
  });

  it('N4 — a double confirm stops it exactly ONCE', async () => {
    give({
      id: 'row-7', holdsMembersCount: 2, fundsSubMembers: true,
      fundingRequest: {id: 'fr-1', status: 'approved', createdAt: '2026-09-11T00:00:00.000Z'},
    });
    let release: (v: unknown) => void = () => {};
    mockStopFundMembers.mockReturnValue(new Promise(res => { release = res; }));
    render(<FamilyQuotaCard />);
    const stop = await waitFor(
      () => screen.getByLabelText(/Stop funding your members from Dad/i), {timeout: 10_000});
    fireEvent.press(stop);
    const buttons = mockAlert.mock.calls[mockAlert.mock.calls.length - 1][2] as
      Array<{text: string; onPress?: () => void}>;
    const go = buttons.find(b => /stop/i.test(b.text))!;
    await act(async () => { go.onPress?.(); go.onPress?.(); });
    expect(mockStopFundMembers).toHaveBeenCalledTimes(1);
    await act(async () => { release({data: {ok: true}}); });
  });

  /** A10 again, from the MEMBER's end — their own members, not "their" members. */
  it('a 409 while their bookings run quotes the count in the MEMBER\'s words', async () => {
    give({
      id: 'row-7', holdsMembersCount: 2, fundsSubMembers: true,
      fundingRequest: {id: 'fr-1', status: 'approved', createdAt: '2026-09-11T00:00:00.000Z'},
    });
    mockStopFundMembers.mockRejectedValue({
      response: {status: 409, data: {
        code: 'chained_bookings_in_flight', message: 'chained_bookings_in_flight', count: 2,
      }},
    });
    render(<FamilyQuotaCard />);
    const stop = await waitFor(
      () => screen.getByLabelText(/Stop funding your members from Dad/i), {timeout: 10_000});
    fireEvent.press(stop);
    await confirmLastAlert(/stop/i);
    await waitFor(() => expect(mockAlert).toHaveBeenCalledWith(
      expect.any(String),
      '2 of your members’ bookings are in progress — try again when they finish.',
    ));
    const bodies = mockAlert.mock.calls.map(c => String(c[1] ?? ''));
    expect(bodies.some(b => b.includes('chained_bookings_in_flight'))).toBe(false);
  });

  it('the Stop row is absent while the chain is OFF — there is nothing to stop', async () => {
    give({holdsMembersCount: 2, fundsSubMembers: false, fundingRequest: null});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByLabelText(ask)).toBeTruthy(), {timeout: 10_000});
    expect(screen.queryByLabelText(/Stop funding your members/i)).toBeNull();
  });

  /**
   * The CONTRACT shape: the server sends the LATEST request of any status, so
   * `declined` is a real state the card must read — not an absence. Keying
   * "declined" off a missing request would show the plain Ask button and lose
   * the only place the member is told the answer was no.
   */
  it('DECLINED → says so and offers the ask again', async () => {
    give({
      holdsMembersCount: 2, fundsSubMembers: false,
      fundingRequest: {id: 'fr-1', status: 'declined', createdAt: '2026-09-11T00:00:00.000Z'},
    });
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText(/Declined/i)).toBeTruthy(), {timeout: 10_000});
    expect(screen.getByLabelText(ask)).toBeTruthy();
    expect(screen.queryByText(/Waiting for Dad/i)).toBeNull();
  });

  /**
   * `expired` is NOT `declined`: nobody said no, the window simply closed.
   * Telling the member they were refused would be a statement about the root
   * that never happened.
   */
  it('EXPIRED → says the request expired, and offers the ask again', async () => {
    give({
      holdsMembersCount: 2, fundsSubMembers: false,
      fundingRequest: {id: 'fr-1', status: 'expired', createdAt: '2026-08-01T00:00:00.000Z'},
    });
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText(/last request expired/i)).toBeTruthy(), {timeout: 10_000});
    expect(screen.getByLabelText(ask)).toBeTruthy();
    expect(screen.queryByText(/Declined/i)).toBeNull();
    expect(screen.queryByText(/Waiting for Dad/i)).toBeNull();
  });

  it('CANCELLED reads as never asked — the member withdrew it themselves', async () => {
    give({
      holdsMembersCount: 2, fundsSubMembers: false,
      fundingRequest: {id: 'fr-1', status: 'cancelled', createdAt: '2026-08-01T00:00:00.000Z'},
    });
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByLabelText(ask)).toBeTruthy(), {timeout: 10_000});
    expect(screen.queryByText(/Declined/i)).toBeNull();
    expect(screen.queryByText(/last request expired/i)).toBeNull();
  });

  /**
   * The SHIPPED server selects `status = 'pending' AND expires_at > NOW()` and
   * projects `{id, createdAt}` — no `status` field at all. Reading
   * `fundingRequest.status === 'pending'` therefore never matches, the member
   * keeps seeing "Ask Dad" while their ask is open, and a second press is
   * refused by the server with a code they cannot act on.
   *
   * A request the server hands over IS a pending one; absent `status` means
   * pending, and an explicit `status` still wins when a server sends one.
   */
  it('a status-LESS request object still reads as pending (the shipped server shape)', async () => {
    give({
      holdsMembersCount: 2, fundsSubMembers: false,
      fundingRequest: {id: 'fr-1', createdAt: '2026-09-11T00:00:00.000Z'} as never,
    });
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText(/Waiting for Dad/i)).toBeTruthy(), {timeout: 10_000});
    expect(screen.queryByLabelText(ask)).toBeNull();
  });

  it('APPROVED-then-switched-off by the root reads as not requested, not as ON', async () => {
    // The root's `PATCH {enabled:false}` clears the flag and leaves the decided
    // request behind. Reading the REQUEST rather than the flag would show "On"
    // for a chain that is dead.
    give({
      holdsMembersCount: 2, fundsSubMembers: false,
      fundingRequest: {id: 'fr-1', status: 'approved'},
    });
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByLabelText(ask)).toBeTruthy(), {timeout: 10_000});
    expect(screen.queryByText(/your members spend from Dad’s allowance/i)).toBeNull();
  });

  it('asks for CONFIRMATION before spending the root\'s money, then sends the row id', async () => {
    give({id: 'row-7', holdsMembersCount: 2, fundsSubMembers: false, fundingRequest: null});
    mockRequestFundMembers.mockResolvedValue({data: {request: {id: 'fr-9', status: 'pending'}}});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByLabelText(ask)).toBeTruthy(), {timeout: 10_000});

    fireEvent.press(screen.getByLabelText(ask));
    // The tap alone must not send it — this widens who can spend Dad's money.
    expect(mockRequestFundMembers).not.toHaveBeenCalled();
    await confirmLastAlert(/ask|send/i);
    // The MEMBERSHIP row id, not the holder id: the server keys the request on
    // the row, and a member may be under several roots.
    await waitFor(() => expect(mockRequestFundMembers).toHaveBeenCalledWith('row-7'));
  });

  it('N4 — a double confirm sends exactly ONE request', async () => {
    give({id: 'row-7', holdsMembersCount: 2, fundsSubMembers: false, fundingRequest: null});
    let release: (v: unknown) => void = () => {};
    mockRequestFundMembers.mockReturnValue(new Promise(res => { release = res; }));
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByLabelText(ask)).toBeTruthy(), {timeout: 10_000});

    fireEvent.press(screen.getByLabelText(ask));
    const buttons = mockAlert.mock.calls[mockAlert.mock.calls.length - 1][2] as
      Array<{text: string; onPress?: () => void}>;
    const go = buttons.find(b => /ask|send/i.test(b.text))!;
    // Two SYNCHRONOUS presses, before any re-render can disable anything — the
    // exact shape a `disabled={state}` alone does not stop.
    await act(async () => { go.onPress?.(); go.onPress?.(); });
    expect(mockRequestFundMembers).toHaveBeenCalledTimes(1);
    await act(async () => { release({data: {request: {id: 'fr-9', status: 'pending'}}}); });
  });

  it('a 409 funding_source_already_set explains the ONE-funding-root rule', async () => {
    give({id: 'row-7', holdsMembersCount: 2, fundsSubMembers: false, fundingRequest: null});
    mockRequestFundMembers.mockRejectedValue({
      response: {status: 409, data: {code: 'funding_source_already_set', message: 'funding_source_already_set'}},
    });
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByLabelText(ask)).toBeTruthy(), {timeout: 10_000});
    fireEvent.press(screen.getByLabelText(ask));
    await confirmLastAlert(/ask|send/i);
    await waitFor(() => expect(mockAlert).toHaveBeenCalledWith(
      expect.any(String), expect.stringMatching(/Another account already funds your members/i),
    ));
    // No raw wire code may reach the member.
    const bodies = mockAlert.mock.calls.map(c => String(c[1] ?? ''));
    expect(bodies.some(b => b.includes('funding_source_already_set'))).toBe(false);
  });

  // The SERVER's body (`family.service.ts:848`), not one invented to match the
  // client — the earlier `no_members_to_fund` fixture kept a dead branch green.
  it('a 400 no_sub_members is not a "try again" failure', async () => {
    give({id: 'row-7', holdsMembersCount: 2, fundsSubMembers: false, fundingRequest: null});
    mockRequestFundMembers.mockRejectedValue({
      response: {status: 400, data: {code: 'NO_SUB_MEMBERS', message: 'no_sub_members'}},
    });
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByLabelText(ask)).toBeTruthy(), {timeout: 10_000});
    fireEvent.press(screen.getByLabelText(ask));
    await confirmLastAlert(/ask|send/i);
    await waitFor(() => expect(mockAlert).toHaveBeenCalledWith(
      expect.any(String), expect.stringMatching(/don’t have any members to fund/i),
    ));
  });

  /** `family.service.ts:928` — they already asked from another device. */
  it('a 409 funding_request_pending names the root, and never says "try again"', async () => {
    give({id: 'row-7', holdsMembersCount: 2, fundsSubMembers: false, fundingRequest: null});
    mockRequestFundMembers.mockRejectedValue({
      response: {status: 409, data: {
        code: 'FUNDING_REQUEST_PENDING', message: 'funding_request_pending', requestId: 'fr-9',
      }},
    });
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByLabelText(ask)).toBeTruthy(), {timeout: 10_000});
    fireEvent.press(screen.getByLabelText(ask));
    await confirmLastAlert(/ask|send/i);
    await waitFor(() => expect(mockAlert).toHaveBeenCalledWith(
      expect.any(String), 'Your request is already waiting for Dad.',
    ));
    const bodies = mockAlert.mock.calls.map(c => String(c[1] ?? ''));
    expect(bodies.some(b => /try again/i.test(b))).toBe(false);
  });

  it('an unrecognised failure still says something human', async () => {
    give({id: 'row-7', holdsMembersCount: 2, fundsSubMembers: false, fundingRequest: null});
    mockRequestFundMembers.mockRejectedValue(new Error('network timeout'));
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByLabelText(ask)).toBeTruthy(), {timeout: 10_000});
    fireEvent.press(screen.getByLabelText(ask));
    await confirmLastAlert(/ask|send/i);
    await waitFor(() => expect(mockAlert).toHaveBeenCalledWith(
      expect.any(String), expect.stringMatching(/try again/i),
    ));
  });
});

/**
 * B-854/A12 — the member's own allowance pays for their members' bookings, so
 * the part of "Used" that THEY did not spend has to be visible. Without it the
 * member watches their remaining figure fall for bookings they never made.
 */
describe('B-854 — "includes N BC spent by your members"', () => {
  it('names the sub-member share when there is one', async () => {
    give({spent: 4250, remaining: 750, spentByMembers: 1200, holdsMembersCount: 2, fundsSubMembers: true});
    render(<FamilyQuotaCard />);
    await waitFor(
      () => expect(screen.getByText(/includes 1,200 BC spent by your members/i)).toBeTruthy(),
      {timeout: 10_000},
    );
  });

  it('says nothing at zero — an "includes 0 BC" line is noise', async () => {
    give({spent: 4250, remaining: 750, spentByMembers: 0, holdsMembersCount: 2, fundsSubMembers: true});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText('4,250')).toBeTruthy(), {timeout: 10_000});
    expect(screen.queryByText(/spent by your members/i)).toBeNull();
  });

  it('says nothing on a server that does not send the figure', async () => {
    give({spent: 4250, remaining: 750, spentByMembers: undefined});
    render(<FamilyQuotaCard />);
    await waitFor(() => expect(screen.getByText('4,250')).toBeTruthy(), {timeout: 10_000});
    expect(screen.queryByText(/spent by your members/i)).toBeNull();
  });
});
