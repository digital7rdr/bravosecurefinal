/**
 * B-798 (founder 2026-09-04) — "wherever there is top up / credit, mention
 * 1 BC = 1 euro; the user has to know before purchasing the credit."
 *
 * One label, one source: `eurPerBcLabel()` reads the LIVE ops peg
 * (`eur_per_bc`, fallback 1) through the same `priceValue` every pricing mirror
 * uses, so the disclosure can never drift from the number the charge uses.
 * Every purchase surface renders it (source scans — the screens mount native
 * modules this project cannot import). Comments stripped, CRLF normalised.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {eurPerBcLabel, setServicePricingOverrides} from '../servicePricingOverrides';

function code(rel: string): string {
  const src = readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

describe('eurPerBcLabel — the peg from the live board, never a literal', () => {
  afterEach(() => setServicePricingOverrides(null));

  it('reads 1 BC = €1.00 with no board (fail-open to the compiled peg)', () => {
    setServicePricingOverrides(null);
    expect(eurPerBcLabel()).toBe('1 BC = €1.00');
  });

  it('follows an ops edit of eur_per_bc', () => {
    setServicePricingOverrides({eur_per_bc: 1.25});
    expect(eurPerBcLabel()).toBe('1 BC = €1.25');
  });

  it('ignores a corrupt board value', () => {
    setServicePricingOverrides({eur_per_bc: -3});
    expect(eurPerBcLabel()).toBe('1 BC = €1.00');
  });
});

describe('every credit purchase surface states the peg before the purchase', () => {
  it('wallet top-up (CreditsScreen): note above the packs, euro on each pack, euro on the button', () => {
    const s = code('src/screens/wallet/CreditsScreen.tsx');
    expect(s).toMatch(/eurPerBcLabel\(\)\} · your card is charged in euro/);
    expect(s).toMatch(/pay €\{pkg\.credits\.toLocaleString\(\)\} on card/);
    expect(s).toMatch(/Top Up · \{selectedCredits\.toLocaleString\(\)\} BC · €\{selectedCredits\.toLocaleString\(\)\}/);
  });

  it('Secure Pro plan payment: a RATE row above the balance', () => {
    const s = code('src/screens/securepro/SecureProPaymentScreen.tsx');
    expect(s).toMatch(/<InfoRow label="RATE" value=\{eurPerBcLabel\(\)\} \/>/);
  });

  it('tier paywall: under the price', () => {
    const s = code('src/screens/pro/TierPaywall.tsx');
    expect(s).toMatch(/\{eurPerBcLabel\(\)\} · billed in euro/);
  });

  it('booking credit paywall keeps its headline rate pill (already stated the peg)', () => {
    const s = code('src/screens/booking/CreditPaywallScreen.tsx');
    expect(s).toMatch(/1 Bravo Credit = \{eurPerBcLabel\}/);
    expect(s).toMatch(/priceValue\('eur_per_bc', 1\)/);
  });

  it('no purchase surface hard-codes the peg as prose', () => {
    for (const f of [
      'src/screens/wallet/CreditsScreen.tsx',
      'src/screens/securepro/SecureProPaymentScreen.tsx',
      'src/screens/pro/TierPaywall.tsx',
    ]) {
      expect(code(f)).not.toMatch(/1 BC = €1\b|1 BC = 1 EUR/);
    }
  });
});
