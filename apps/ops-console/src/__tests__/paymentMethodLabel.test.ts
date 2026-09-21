/**
 * B-847 — the console's payment-method label.
 *
 * `BookingDetail` rendered `booking.payment_method.toUpperCase()`. That said
 * "CARD" for a booking whose escrow hold is charged in Bravo Credits (the server
 * has no card lane at all — Stripe is wallet top-ups only), and once the stored
 * value became honest the same line would have read "BRAVO_CREDITS". One helper,
 * one table, and a scan that the raw `.toUpperCase()` never comes back.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {paymentMethodLabel} from '../lib/paymentMethodLabel';

describe('paymentMethodLabel', () => {
  it('names every method the table knows', () => {
    expect(paymentMethodLabel('bravo_credits')).toBe('Bravo Credits');
    expect(paymentMethodLabel('card')).toBe('Card');
    expect(paymentMethodLabel('corporate')).toBe('Corporate');
  });

  it('never shouts an underscore at the operator', () => {
    // The whole point: the pre-fix line produced BRAVO_CREDITS.
    expect(paymentMethodLabel('bravo_credits')).not.toContain('_');
    expect(paymentMethodLabel('bravo_credits')).not.toBe('BRAVO_CREDITS');
  });

  it('opens the underscores on a value the table has not been taught', () => {
    expect(paymentMethodLabel('apple_pay')).toBe('apple pay');
  });

  it('degrades an empty / missing method to an em dash, never to a blank cell', () => {
    expect(paymentMethodLabel(null)).toBe('—');
    expect(paymentMethodLabel(undefined)).toBe('—');
    expect(paymentMethodLabel('')).toBe('—');
    expect(paymentMethodLabel('   ')).toBe('—');
  });
});

describe('B-847 — BookingDetail renders through the helper', () => {
  // The screen is a client component this node project cannot mount, so the
  // wiring is a source scan. CRLF-safe and comment-stripped: this file's own
  // prose names `.toUpperCase()`, which is exactly how such a scan goes vacuous.
  const src = (): string =>
    readFileSync(join(__dirname, '..', 'features', 'bookings', 'BookingDetail.tsx'), 'utf8')
      .replace(/\r?\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('calls paymentMethodLabel( and imports it', () => {
    expect(src()).toContain('paymentMethodLabel(booking.payment_method)');
    expect(src()).toMatch(/import \{paymentMethodLabel\} from '@\/lib\/paymentMethodLabel';/);
  });

  it('no longer upper-cases the raw column', () => {
    expect(src()).not.toContain('payment_method.toUpperCase()');
  });

  it('the CAPTURED / PENDING half of the line is untouched', () => {
    // Present-token self-check: the scan above would also pass if the whole
    // Payment row had been deleted.
    expect(src()).toContain("booking.payment_captured ? 'CAPTURED' : 'PENDING'");
  });
});
