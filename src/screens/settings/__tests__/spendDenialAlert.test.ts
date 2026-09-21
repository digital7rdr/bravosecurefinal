/**
 * B-843/A11 — a money refusal must name the account that refused.
 *
 * B-724 gave the family-quota refusal its own door ("Request More Credit").
 * With one root that was enough. With several, "your plan holder" names nobody
 * and the door opens onto a list of cards with no indication which one to act
 * on — so the alert now says WHICH root, and the deep link carries that
 * holder's id so the matching card is highlighted.
 *
 * Lives under `screens/settings/__tests__` because the `app` project ignores
 * `src/screens/booking/__tests__/` (that path belongs to the node `booking`
 * project) and this module pulls in `@utils/alert` + the nav tap guard.
 */
const mockAlert = jest.fn();
const mockNavigateOnce = jest.fn();

jest.mock('@utils/alert', () => ({Alert: {alert: (...a: unknown[]) => mockAlert(...a)}}));
jest.mock('@navigation/tapGuard', () => ({
  navigateOnce: (...a: unknown[]) => mockNavigateOnce(...a),
}));

import {showSpendDenialAlert} from '@screens/booking/spendDenialAlert';

const nav = {navigate: jest.fn()} as never;

const quotaError = (extra: Record<string, unknown> = {}) => ({
  response: {status: 400, data: {
    code: 'SPENDING_QUOTA_EXCEEDED', message: 'family_spend_limit_exceeded',
    required: 400, allocated: 5000, used: 5000, remaining: 0,
    ...extra,
  }},
});

/** Run the alert's CTA (the last button that carries an onPress). */
function pressCta() {
  const buttons = mockAlert.mock.calls[0][2] as Array<{text: string; onPress?: () => void}>;
  const cta = [...buttons].reverse().find(b => typeof b.onPress === 'function');
  cta?.onPress?.();
}

beforeEach(() => jest.clearAllMocks());

describe('naming the root that refused', () => {
  it('puts the holder name in the alert when the server sent one', () => {
    expect(showSpendDenialAlert(quotaError({holder_id: 'holder-a', holder_name: 'Acme Ltd'}), nav)).toBe(true);
    const [title, body] = mockAlert.mock.calls[0];
    expect(`${title} ${body}`).toContain('Acme Ltd');
  });

  it('keeps the neutral wording when the server named nobody — never a guessed name', () => {
    expect(showSpendDenialAlert(quotaError(), nav)).toBe(true);
    const [title, body] = mockAlert.mock.calls[0];
    expect(`${title} ${body}`).not.toMatch(/undefined|null/);
    expect(`${title} ${body}`).toMatch(/plan holder/i);
  });

  it('still shows the server\'s own figures — §48, never guessed numbers', () => {
    showSpendDenialAlert(quotaError({holder_id: 'holder-a', holder_name: 'Acme Ltd'}), nav);
    expect(String(mockAlert.mock.calls[0][1])).toContain('5000');
  });
});

describe('the door lands on the RIGHT card', () => {
  it('passes the refusing holder id so the matching card is highlighted', () => {
    showSpendDenialAlert(quotaError({holder_id: 'holder-a', holder_name: 'Acme Ltd'}), nav);
    pressCta();
    expect(mockNavigateOnce).toHaveBeenCalledWith(nav, 'IndividualProfile', {focusHolderId: 'holder-a'});
  });

  it('navigates without a focus param when the refusal named no holder', () => {
    showSpendDenialAlert(quotaError(), nav);
    pressCta();
    expect(mockNavigateOnce).toHaveBeenCalledWith(nav, 'IndividualProfile');
  });
});

describe('it still refuses to hijack unrelated errors', () => {
  it.each([
    {response: {data: {code: 'insufficient_credits', message: 'insufficient_credits'}}},
    {response: {data: {message: 'Booking not found'}}},
    new Error('network timeout'),
    null,
  ])('returns false and shows nothing for %p', e => {
    expect(showSpendDenialAlert(e as unknown, nav)).toBe(false);
    expect(mockAlert).not.toHaveBeenCalled();
  });
});
