/**
 * Founder 2026-09-01 — "1 BRAVO CREDIT = 1 EURO … this can be changed via ops
 * console, and that ops console rate will show here."
 *
 * Two things have to hold together, and a render test of the label alone would
 * miss the one that costs money:
 *
 *  1. EVERY top-up path charges EUR. Credits awarded are `round(amount)`
 *     whatever the card is charged in (the 1-fiat-unit = 1-BC peg), which made
 *     the currency argument look inert. It was not: service prices are quoted in
 *     EUR and converted at `eur_per_bc`, so the wallet screen's `'aed'` sold
 *     EUR-priced credit at roughly a quarter price and the two paywalls' `'usd'`
 *     at roughly double. The server now decides the settlement currency
 *     (pinned in `wallet.service.spec.ts`); these scans stop a NEW screen
 *     reintroducing a wrong currency at the call site.
 *
 *  2. The rate on screen is the OPS value, not a literal. A hard-coded "€1.00"
 *     would look identical in a screenshot and silently lie the moment ops
 *     changed the rate.
 *
 * Source scans, because these screens mount RN and the node project cannot
 * import them. Comments are stripped first: this repo has lost a session to a
 * scan matching its own explanatory prose.
 */
import {readFileSync} from 'fs';
import {join} from 'path';

const ROOT = join(__dirname, '..', '..', '..', '..');

/** Strip block and line comments so prose can never satisfy or break a scan. */
function code(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const TOP_UP_CALL_SITES = [
  'src/screens/booking/CreditPaywallScreen.tsx',
  'src/screens/pro/TierPaywall.tsx',
  'src/screens/wallet/CreditsScreen.tsx',
];

describe('top-up settlement currency — every call site sends EUR', () => {
  it.each(TOP_UP_CALL_SITES)('%s sends currency EUR', rel => {
    const src = code(rel);
    // It must ask for a top-up at all — an empty match would pass vacuously if
    // the call were ever renamed.
    expect(src).toMatch(/topUpAndCharge\s*\(/);
    expect(src).toMatch(/currency:\s*'eur'/);
  });

  it.each(TOP_UP_CALL_SITES)('%s sends no other currency', rel => {
    const src = code(rel);
    const currencies = [...src.matchAll(/currency:\s*'([a-z]{3})'/g)].map(m => m[1]);
    // Lower-case three-letter literals are the charge-currency form; 'BC' and
    // `st.balance?.currency` (display) are deliberately not matched.
    expect(currencies.length).toBeGreaterThan(0);
    expect(currencies.every(c => c === 'eur')).toBe(true);
  });
});

describe('the rate shown to the customer is the ops value', () => {
  const paywall = code('src/screens/booking/CreditPaywallScreen.tsx');

  it('reads eur_per_bc through priceValue rather than hard-coding it', () => {
    expect(paywall).toMatch(/priceValue\(\s*'eur_per_bc'\s*,\s*1\s*\)/);
  });

  it('renders the rate line next to the pay button', () => {
    expect(paywall).toMatch(/1 Bravo Credit = \{eurPerBcLabel\}/);
    // Founder 2026-09-02 — the ops attribution was removed and the rate
    // promoted to a highlighted pill; the peg statement itself is the pin.
    expect(paywall).not.toMatch(/rate set by Bravo Secure operations/);
  });

  it('does NOT hard-code a euro figure in the disclaimer', () => {
    // A literal would survive an ops rate change and quietly misprice the copy.
    expect(paywall).not.toMatch(/1 Bravo Credit = €[\d.]/);
  });

  it('formats to two decimals so a fractional rate is never truncated', () => {
    expect(paywall).toMatch(/priceValue\('eur_per_bc', 1\)\.toFixed\(2\)/);
  });
});

describe('the ops key backing the rate is real and bounded', () => {
  const pricing = code('apps/auth-service/src/booking/pricing.service.ts');
  const opsBoard = code('apps/auth-service/src/ops/ops-service-pricing.controller.ts');

  it('eur_per_bc ships as 1.0 — the rate the disclaimer states', () => {
    expect(pricing).toMatch(/eur_per_bc:\s*1(\.0)?\s*,/);
  });

  it('eur_per_bc is editable from the ops console, with fat-finger bounds', () => {
    expect(opsBoard).toMatch(/eur_per_bc:\s*\{min:/);
  });
});
