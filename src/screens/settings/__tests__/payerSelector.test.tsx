/**
 * B-843 — the "Pay from" selector.
 *
 * A render test rather than a source scan because the rules are about what the
 * member can TAP: an ineligible root must be visible (so they know it exists
 * and why it cannot pay) and un-selectable (so a charge can never be aimed at
 * it). The ordering rules live in `payerOptions.test.ts` (node); this file
 * pins the interaction and the accessibility contract.
 *
 * It lives under `screens/settings/__tests__` ON PURPOSE: the `app` Jest
 * project IGNORES `src/screens/booking/__tests__/` (that path belongs to the
 * node `booking` project, which matches `.ts` only and cannot mount RN), so a
 * `.tsx` render test placed beside the component would never run at all.
 */
import React from 'react';
import {render, screen, fireEvent} from '@testing-library/react-native';

import {PayerSelector} from '@screens/booking/PayerSelector';
import type {PayerMembershipInput} from '@screens/booking/payerOptions';

const SELF = 'user-me';

const m = (over: Partial<PayerMembershipInput> = {}): PayerMembershipInput => ({
  id: 'row-1', holderId: 'holder-a', holderName: 'Dad',
  spendLimit: 5000, spent: 4250, remaining: 750,
  held: false, rootSuspended: false,
  ...over,
});

const two = [
  m(),
  m({id: 'row-2', holderId: 'holder-b', holderName: 'Acme Ltd', spendLimit: null, remaining: null}),
];

describe('the rows the member can see', () => {
  it('lists My wallet first, then every root', () => {
    render(
      <PayerSelector selfUserId={SELF} selfBalance={1200} memberships={two} value={null} onChange={jest.fn()} />,
    );
    expect(screen.getByText('My wallet')).toBeTruthy();
    expect(screen.getByText('Dad')).toBeTruthy();
    expect(screen.getByText('Acme Ltd')).toBeTruthy();
    expect(screen.getByText('1,200 BC')).toBeTruthy();
    expect(screen.getByText('750 BC left')).toBeTruthy();
    expect(screen.getByText('No limit')).toBeTruthy();
  });

  it('asks the question out loud while nothing is chosen and there are ≥2 roots', () => {
    render(
      <PayerSelector selfUserId={SELF} selfBalance={0} memberships={two} value={null} onChange={jest.fn()} />,
    );
    expect(screen.getByText(/Choose which account pays/i)).toBeTruthy();
  });

  it('drops the prompt once a payer is chosen', () => {
    render(
      <PayerSelector selfUserId={SELF} selfBalance={0} memberships={two} value="holder-a" onChange={jest.fn()} />,
    );
    expect(screen.queryByText(/Choose which account pays/i)).toBeNull();
  });

  it('renders NOTHING when the person is under no roots — there is no choice to make', () => {
    const {toJSON} = render(
      <PayerSelector selfUserId={SELF} selfBalance={10} memberships={[]} value={null} onChange={jest.fn()} />,
    );
    expect(toJSON()).toBeNull();
  });
});

describe('choosing', () => {
  it('reports the chosen holder id', () => {
    const onChange = jest.fn();
    render(
      <PayerSelector selfUserId={SELF} selfBalance={0} memberships={two} value={null} onChange={onChange} />,
    );
    fireEvent.press(screen.getByTestId('payer-choice-holder-b'));
    expect(onChange).toHaveBeenCalledWith('holder-b');
  });

  it('"My wallet" reports the member\'s OWN id — that is what the server reads as self', () => {
    const onChange = jest.fn();
    render(
      <PayerSelector selfUserId={SELF} selfBalance={0} memberships={two} value={null} onChange={onChange} />,
    );
    fireEvent.press(screen.getByTestId('payer-choice-self'));
    expect(onChange).toHaveBeenCalledWith(SELF);
  });

  it('a HELD root is shown but cannot be chosen — never aim a charge at it', () => {
    const onChange = jest.fn();
    render(
      <PayerSelector
        selfUserId={SELF} selfBalance={0}
        memberships={[m({held: true})]}
        value={null} onChange={onChange}
      />,
    );
    expect(screen.getByText('On hold')).toBeTruthy();
    fireEvent.press(screen.getByTestId('payer-choice-holder-a'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a SUSPENDED root cannot be chosen either', () => {
    const onChange = jest.fn();
    render(
      <PayerSelector
        selfUserId={SELF} selfBalance={0}
        memberships={[m({rootSuspended: true})]}
        value={null} onChange={onChange}
      />,
    );
    expect(screen.getByText('Suspended')).toBeTruthy();
    fireEvent.press(screen.getByTestId('payer-choice-holder-a'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('accessibility', () => {
  it('P3-14 — the rows sit in a radiogroup, so a screen reader reads them as one choice', () => {
    render(
      <PayerSelector selfUserId={SELF} selfBalance={0} memberships={two} value={null} onChange={jest.fn()} />,
    );
    expect(screen.getByTestId('payer-selector').props.accessibilityRole).toBe('radiogroup');
  });

  it('P3-14 — a long sublabel wraps instead of clipping at fontScale 1.3', () => {
    render(
      <PayerSelector selfUserId={SELF} selfBalance={1200} memberships={two} value={null} onChange={jest.fn()} />,
    );
    // "1,200 BC left" at a large font scale does not fit one line on a 320 dp
    // screen; one line silently truncates the number the member is deciding on.
    expect(screen.getByText('1,200 BC').props.numberOfLines).toBe(2);
  });

  it('every row is a radio that announces its own state', () => {
    render(
      <PayerSelector selfUserId={SELF} selfBalance={0} memberships={two} value={'holder-a'} onChange={jest.fn()} />,
    );
    const chosen = screen.getByTestId('payer-choice-holder-a');
    expect(chosen.props.accessibilityRole).toBe('radio');
    expect(chosen.props.accessibilityState.selected).toBe(true);
    const other = screen.getByTestId('payer-choice-holder-b');
    expect(other.props.accessibilityState.selected).toBe(false);
    expect(screen.getByTestId('payer-choice-self').props.accessibilityState.selected).toBe(false);
  });

  it('a disabled row says so to a screen reader, not just visually', () => {
    render(
      <PayerSelector
        selfUserId={SELF} selfBalance={0}
        memberships={[m({held: true})]}
        value={null} onChange={jest.fn()}
      />,
    );
    const row = screen.getByTestId('payer-choice-holder-a');
    expect(row.props.accessibilityState.disabled).toBe(true);
    expect(String(row.props.accessibilityLabel)).toMatch(/on hold/i);
  });
});
