/**
 * 2026-10-25 — "Payment failed — Request failed with status code 400" when
 * upgrading: production has no card processor connected (`stripe_disabled`).
 * The user now gets words, and is told nothing was charged.
 */
jest.mock('@stripe/stripe-react-native', () => ({useStripe: () => ({})}));
jest.mock('../api', () => ({walletApi: {}}));

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {topUpErrorText} from '../stripe';

const axiosErr = (status: number, message: unknown) => ({response: {status, data: {statusCode: status, message}}});

describe('topUpErrorText', () => {
  it('no card processor connected', () => {
    expect(topUpErrorText(axiosErr(400, 'stripe_disabled'))).toMatch(/Card payments are not switched on yet.*not been charged/);
  });
  it('amount below the minimum (class-validator array form)', () => {
    expect(topUpErrorText(axiosErr(400, ['amount must not be less than 1']))).toMatch(/too small/);
  });
  it('no response at all', () => {
    expect(topUpErrorText(new Error('Network Error'))).toMatch(/Could not reach/);
  });
  it('anything else never shows the raw status line', () => {
    const t = topUpErrorText(axiosErr(500, 'boom'));
    expect(t).not.toMatch(/status code/);
    expect(t).toMatch(/not been charged/);
  });
});

describe('the plan paywall tops up a whole amount of at least 1', () => {
  it('Math.max(1, Math.ceil(...))', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'screens', 'pro', 'TierPaywall.tsx'), 'utf8');
    expect(src).toMatch(/amountFiat: Math\.max\(1, Math\.ceil\(bcToUsd\(shortfall\)\)\),/);
  });
});
