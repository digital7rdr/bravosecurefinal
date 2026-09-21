/**
 * B-843 — `usePayerChoice`, the state behind every "Pay from" surface.
 *
 * Behaviour tests, not a source scan, because all three defects this file
 * pins were invisible one layer out: the pins passed and the MONEY still
 * landed on the wrong account.
 *
 *  · P2-5 — with ONE held/suspended root, `defaultPayerChoice` returns null
 *    (nothing safe to preselect) but the CTA was NOT blocked, so Continue
 *    shipped no `payer_user_id` and the server — which excludes held rows —
 *    resolved to "self" and quietly charged the member's own wallet.
 *  · P2-7 — a ≤1.0.306 server has no `/family/memberships`. The fallback still
 *    rendered the selector, but `payer_user_id` is stripped there by
 *    `whitelist: true`, so a member picking "My wallet" was charged to the
 *    root anyway. A choice the server cannot honour must not be offered.
 *  · P2-10 — offline, both reads fail and the roster is empty; a later refusal
 *    set `locked`, so Continue was blocked with NO selector on screen: a dead
 *    button with no way out.
 *
 * Lives under `screens/settings/__tests__` because the `app` project IGNORES
 * `src/screens/booking/__tests__/` (that path is the node `booking` project,
 * which cannot run hooks).
 */
import React from 'react';
import {render, screen, waitFor, act} from '@testing-library/react-native';
import {Text} from 'react-native';

const mockMemberships = jest.fn();
const mockMembership = jest.fn();

jest.mock('@services/api', () => ({
  walletApi: {},
  bookingApi: {},
  familyApi: {
    memberships: (...a: unknown[]) => mockMemberships(...a),
    membership:  (...a: unknown[]) => mockMembership(...a),
  },
}));
jest.mock('@store/authStore', () => {
  const state = {user: {id: 'user-me'}};
  const useAuthStore = (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state);
  useAuthStore.getState = () => state;
  return {useAuthStore};
});
jest.mock('@store/walletStore', () => {
  const state = {balance: {bravo_credits: 1200}};
  const useWalletStore = (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state);
  useWalletStore.getState = () => state;
  return {useWalletStore};
});

import {usePayerChoice} from '@screens/booking/usePayerChoice';
import {useBookingStore} from '@store/bookingStore';

const m = (over: Record<string, unknown> = {}) => ({
  id: 'row-1', holderId: 'holder-a', holderName: 'Dad',
  spendLimit: 5000, spent: 4250, remaining: 750, effectiveSpendable: 750,
  heldUntil: null, rootSuspended: false, pendingRequest: null,
  ...over,
});

let last: ReturnType<typeof usePayerChoice> | null = null;

function Probe() {
  const s = usePayerChoice();
  last = s;
  return (
    <Text testID="probe">
      {`visible=${s.visible} blocked=${s.blocked} rows=${s.memberships.length} value=${String(s.value)}`}
    </Text>
  );
}

const probe = () => String(screen.getByTestId('probe').props.children);

beforeEach(() => {
  jest.clearAllMocks();
  last = null;
  useBookingStore.getState().resetDraft();
  useBookingStore.setState({payerChoiceRequired: null});
});
afterEach(() => { useBookingStore.getState().resetDraft(); });

/** The new server answered. */
const serverHas = (...rows: Array<Record<string, unknown>>) =>
  mockMemberships.mockResolvedValue({data: {memberships: rows}});

/** A ≤1.0.306 server: no `/family/memberships`. */
function oldServer(one: Record<string, unknown> | null) {
  mockMemberships.mockRejectedValue({response: {status: 404, data: {}}});
  mockMembership.mockResolvedValue({data: {membership: one}});
}

describe('the ordinary cases still behave', () => {
  it('nobody\'s member — no selector, nothing blocked, no payer sent', async () => {
    serverHas();
    render(<Probe />);
    await waitFor(() => expect(probe()).toContain('rows=0'));
    expect(probe()).toContain('visible=false');
    expect(probe()).toContain('blocked=false');
    expect(useBookingStore.getState().draft.payerUserId).toBeUndefined();
  });

  it('ONE eligible root — preselected, not blocked (today\'s behaviour)', async () => {
    serverHas(m());
    render(<Probe />);
    await waitFor(() => expect(useBookingStore.getState().draft.payerUserId).toBe('holder-a'));
    expect(probe()).toContain('blocked=false');
    expect(probe()).toContain('visible=true');
  });

  it('TWO roots — nothing preselected, and Continue waits', async () => {
    serverHas(m(), m({id: 'row-2', holderId: 'holder-b', holderName: 'Acme Ltd'}));
    render(<Probe />);
    await waitFor(() => expect(probe()).toContain('rows=2'));
    expect(probe()).toContain('blocked=true');
    expect(useBookingStore.getState().draft.payerUserId).toBeUndefined();
    act(() => { last?.choose('holder-b'); });
    await waitFor(() => expect(probe()).toContain('blocked=false'));
  });
});

describe('P2-5 — a single INELIGIBLE root must not fall through to the member\'s wallet', () => {
  it('one HELD root blocks Continue until the member picks', async () => {
    serverHas(m({heldUntil: new Date(Date.now() + 3600_000).toISOString()}));
    render(<Probe />);
    await waitFor(() => expect(probe()).toContain('rows=1'));
    // Nothing is preselected — and that is precisely why the CTA must wait.
    expect(useBookingStore.getState().draft.payerUserId).toBeUndefined();
    expect(probe()).toContain('blocked=true');
    expect(probe()).toContain('visible=true');
  });

  it('one SUSPENDED root blocks the same way', async () => {
    serverHas(m({rootSuspended: true}));
    render(<Probe />);
    await waitFor(() => expect(probe()).toContain('rows=1'));
    expect(probe()).toContain('blocked=true');
  });

  it('picking "My wallet" explicitly unblocks it — and that choice reaches the body', async () => {
    serverHas(m({heldUntil: new Date(Date.now() + 3600_000).toISOString()}));
    render(<Probe />);
    await waitFor(() => expect(probe()).toContain('blocked=true'));
    act(() => { last?.choose('user-me'); });
    await waitFor(() => expect(probe()).toContain('blocked=false'));
    expect(useBookingStore.getState().draft.payerUserId).toBe('user-me');
  });
});

describe('P2-7 — an old server cannot honour a choice, so none is offered', () => {
  it('hides the selector on the 404 fallback, even with a membership', async () => {
    oldServer(m());
    render(<Probe />);
    await waitFor(() => expect(mockMembership).toHaveBeenCalled());
    await waitFor(() => expect(probe()).toContain('visible=false'));
    expect(probe()).toContain('blocked=false');
  });

  it('sends NO payer_user_id there — the old server would strip it anyway', async () => {
    oldServer(m());
    render(<Probe />);
    await waitFor(() => expect(mockMembership).toHaveBeenCalled());
    // A stripped key means the server charges its OWN default. Writing one
    // would make the app claim a choice it cannot deliver.
    await waitFor(() => expect(probe()).toContain('rows=1'));
    expect(useBookingStore.getState().draft.payerUserId).toBeUndefined();
  });

  it('a refusal carrying options still opens the selector (a mis-detected new server)', async () => {
    oldServer(m());
    render(<Probe />);
    await waitFor(() => expect(probe()).toContain('visible=false'));
    act(() => {
      last?.noteRefusal({response: {data: {
        code: 'PAYER_CHOICE_REQUIRED',
        options: [
          {holderId: 'holder-a', holderName: 'Dad', spendLimit: null, spent: 0, remaining: null, held: false, rootSuspended: false},
          {holderId: 'holder-b', holderName: 'Acme Ltd', spendLimit: null, spent: 0, remaining: null, held: false, rootSuspended: false},
        ],
      }}});
    });
    await waitFor(() => expect(probe()).toContain('visible=true'));
    expect(probe()).toContain('rows=2');
    expect(probe()).toContain('blocked=true');
  });
});

describe('P2-10 — never a blocked CTA with no selector to answer it', () => {
  it('offline (both reads fail) + a refusal with no options leaves Continue usable', async () => {
    mockMemberships.mockRejectedValue(new Error('offline'));
    mockMembership.mockRejectedValue(new Error('offline'));
    render(<Probe />);
    await waitFor(() => expect(probe()).toContain('rows=0'));
    act(() => {
      last?.noteRefusal({response: {data: {code: 'PAYER_NOT_ELIGIBLE', message: 'payer_not_eligible'}}});
    });
    // There is nothing to choose FROM, so locking the button would strand the
    // member with no door. The refusal message is their signal instead.
    await waitFor(() => expect(probe()).toContain('blocked=false'));
    expect(probe()).toContain('visible=false');
  });

  it('offline + a refusal WITH options renders those options and blocks properly', async () => {
    mockMemberships.mockRejectedValue(new Error('offline'));
    mockMembership.mockRejectedValue(new Error('offline'));
    render(<Probe />);
    await waitFor(() => expect(probe()).toContain('rows=0'));
    act(() => {
      last?.noteRefusal({response: {data: {
        code: 'PAYER_CHOICE_REQUIRED',
        options: [
          {holderId: 'holder-a', holderName: 'Dad', spendLimit: null, spent: 0, remaining: null, held: false, rootSuspended: false},
          {holderId: 'holder-b', holderName: 'Acme', spendLimit: null, spent: 0, remaining: null, held: false, rootSuspended: false},
        ],
      }}});
    });
    await waitFor(() => expect(probe()).toContain('rows=2'));
    expect(probe()).toContain('visible=true');
    expect(probe()).toContain('blocked=true');
  });

  it('a refusal retires the pre-fill — the refused root is never re-selected', async () => {
    serverHas(m());
    render(<Probe />);
    await waitFor(() => expect(useBookingStore.getState().draft.payerUserId).toBe('holder-a'));
    act(() => {
      last?.noteRefusal({response: {data: {
        code: 'insufficient_credits', message: 'insufficient_credits', payer_is_self: false,
        holder_id: 'holder-a', holder_name: 'Dad',
      }}});
    });
    await waitFor(() => expect(useBookingStore.getState().draft.payerUserId).toBeUndefined());
    // …and it stays cleared: re-filling it would loop the member into the same
    // refusal on every tap.
    await waitFor(() => expect(probe()).toContain('blocked=true'));
    expect(useBookingStore.getState().draft.payerUserId).toBeUndefined();
  });
});
