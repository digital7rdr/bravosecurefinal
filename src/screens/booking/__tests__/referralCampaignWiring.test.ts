/**
 * Referral / discount campaigns (2026-09-05) — the WIRING, pinned as static
 * source scans in the CLAUDE.md discipline (comments stripped first; CRLF-safe;
 * anchored on the shapes the code uses, not the ones you would write).
 *
 * What would regress silently without these:
 *  - a wizard stops sending the code with its estimate → the client sees full
 *    price until submit, then a discounted charge (or a refusal) they never saw;
 *  - the discount moves AFTER the affordability check or the insert → the
 *    stored total is gross and every charge path over-charges;
 *  - the campaign service grows a dispatch/rank hook → the Issue 28 boundary
 *    ("a code never bypasses availability, licensing or operator approval") is
 *    crossed for the discount lane too;
 *  - the deep link plumbing (scheme, intent filter, root hook, public landing)
 *    loses a piece → a shared link opens nothing.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();

function code(rel: string): string {
  const src = readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
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

const SERVICE = 'apps/auth-service/src/booking/booking.service.ts';
const CAMPAIGNS = 'apps/auth-service/src/booking/referral-campaigns.service.ts';
const LITE = 'src/screens/booking/CustomizeAddOnsScreen.tsx';
const EXEC = 'src/screens/executive/ExecReviewScreen.tsx';

describe('the discount is decided BEFORE the money is, and stored net', () => {
  it('create() resolves the campaign on the gross total, before the affordability check and the insert', () => {
    const src = code(SERVICE);
    const createAt = src.indexOf('  async create(');
    const resolveAt = src.indexOf('this.campaigns?.resolveForBooking(', createAt);
    const applyAt = src.indexOf('applyDiscount(grossPrice, campaign.discountEur', createAt);
    const affordAt = src.indexOf('const cost = price.total_bc;', createAt);
    const insertAt = src.indexOf('INSERT INTO lite_bookings', createAt);
    expect(createAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(createAt);
    expect(applyAt).toBeGreaterThan(resolveAt);
    expect(affordAt).toBeGreaterThan(applyAt);
    expect(insertAt).toBeGreaterThan(affordAt);
  });

  it('the insert carries the campaign columns and the ledger row is written AFTER it', () => {
    const src = code(SERVICE);
    expect(src).toMatch(/referral_campaign_id, referral_campaign_code, referral_discount_eur/);
    const insertAt = src.indexOf('INSERT INTO lite_bookings');
    const ledgerAt = src.indexOf('this.campaigns?.recordRedemption(');
    expect(ledgerAt).toBeGreaterThan(insertAt);
    // Never fails the booking.
    expect(src.slice(ledgerAt, ledgerAt + 600)).toMatch(/\.catch\(/);
  });

  it('a campaign code does not ALSO become a partner attribution', () => {
    expect(code(SERVICE)).toMatch(/const referral = campaign \? null : await this\.resolveReferralCode\(dto\.referral_code\);/);
  });

  it('estimate() quotes the same code and returns what it did', () => {
    const src = code(SERVICE);
    expect(src).toMatch(/this\.campaigns\?\.quote\(\{/);
    expect(src).toMatch(/gross_bc: grossPrice\.total_bc/);
    expect(code('apps/auth-service/src/booking/dto/create-booking.dto.ts'))
      .toMatch(/class EstimateBookingDto[\s\S]*referral_code\?: string;/);
  });

  it('the campaign service never touches dispatch, the cascade, ranking or escrow', () => {
    expect(code(CAMPAIGNS)).not.toMatch(/dispatch|cascade|\brank|escrow/i);
  });

  it('applyDiscount leaves the breakdown lines alone (the ops exec mapper is positional)', () => {
    const src = code('apps/auth-service/src/booking/pricing.service.ts');
    const fn = src.slice(src.indexOf('export function applyDiscount'));
    expect(fn).toMatch(/\.\.\.result,/);
    expect(fn).not.toMatch(/breakdown: \[/);
  });
});

describe('both wizards quote the code and show the outcome', () => {
  it.each([[LITE], [EXEC]])('%s sends referral_code with the estimate and reads the reply', file => {
    const src = code(file);
    expect(src).toMatch(/bookingApi\.estimatePrice\(\{[\s\S]*?referral_code: /);
    expect(src).toMatch(/setReferralQuote\(data\.referral \?\? null\)/);
    expect(src).toMatch(/data\.gross_bc/);
    // The pre-filled link code is consumed once, never re-applied forever.
    expect(src).toMatch(/consumePendingReferral\(\);/);
    expect(src).toMatch(/useReferralStore\(st => st\.pendingCode\)/);
  });

  it('the Lite code box keeps its Issue 28 copy (pinned elsewhere) AND says a Bravo code discounts', () => {
    const src = code(LITE);
    expect(src).toMatch(/does not\s*\n?\s*change availability or who is assigned/);
    expect(src).toMatch(/A Bravo referral code takes its discount off the total/);
  });

  it('the Executive review has a code box too', () => {
    expect(code(EXEC)).toMatch(/value=\{draft\.referral_code\}/);
  });
});

describe('deep links — every piece of the plumbing', () => {
  it('the app registers the bravosecure scheme and the /r/ https intent filter', () => {
    const app = JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8')).expo;
    expect(app.scheme).toBe('bravosecure');
    const f = (app.android?.intentFilters ?? []).find((x: {data?: Array<{pathPrefix?: string}>}) =>
      (x.data ?? []).some(d => d.pathPrefix === '/r/'));
    expect(f).toBeTruthy();
    expect(f.category).toEqual(expect.arrayContaining(['BROWSABLE', 'DEFAULT']));
  });

  it('the root mounts the link hook (outside the navigator) and the store uses the debounced adapter', () => {
    expect(code('App.tsx')).toMatch(/useReferralDeepLinks\(\);/);
    const hook = code('src/modules/referral/useReferralDeepLinks.ts');
    expect(hook).toMatch(/Linking\.getInitialURL\(\)/);
    expect(hook).toMatch(/Linking\.addEventListener\('url'/);
    expect(hook).not.toMatch(/navigate|navigationRef/);
    const store = code('src/store/referralStore.ts');
    expect(store).toMatch(/makeDebouncedJsonStorage\(/);
    expect(store).not.toMatch(/createJSONStorage/);
  });

  it('the console serves /r without a session and links every promo tab to the campaigns page', () => {
    expect(code('apps/ops-console/src/lib/publicRoutes.ts')).toMatch(/'\/r'/);
    for (const page of [
      'apps/ops-console/src/app/(console)/finance/promos/page.tsx',
      'apps/ops-console/src/app/(console)/finance/promos/referral-codes/page.tsx',
      'apps/ops-console/src/app/(console)/finance/promos/campaigns/page.tsx',
    ]) {
      expect(code(page)).toMatch(/routes\.finance\.referralCampaigns/);
    }
    expect(code('apps/ops-console/src/lib/routes.ts')).toMatch(/referralLanding: \(code: string\) => `\/r\//);
    // The two link builders agree on the scheme.
    expect(code('apps/ops-console/src/lib/referralLinks.ts')).toMatch(/REFERRAL_APP_SCHEME = 'bravosecure'/);
    expect(code('src/modules/referral/referralLinks.ts')).toMatch(/REFERRAL_SCHEME = 'bravosecure'/);
  });

  it('the public resolve is registered and reveals no usage figures', () => {
    expect(code('apps/auth-service/src/booking/booking.module.ts')).toMatch(/controllers:\s*\[[^\]]*ReferralsPublicController/);
    const svc = code(CAMPAIGNS);
    const fn = svc.slice(svc.indexOf('async publicResolve('), svc.indexOf('async list('));
    expect(fn).not.toMatch(/redemptions|notes|created_by/);
  });
});
