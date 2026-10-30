/**
 * F9 / PDF A2 + M2 — "the Professional plan must not appear in the Enterprise
 * onboarding route."
 *
 * `plansForProduct` IS the onboarding plan list: its only production caller is
 * `RoleSelectionScreen.cardsForProduct`, the pre-auth picker. The Enterprise
 * plan is sold on the messenger path, so that path is the Enterprise onboarding
 * route and the rule lands there.
 *
 * The function is pure, so this is a real unit test rather than a scan. The
 * second half is the part that matters most: it pins what the fix must NOT have
 * done. Filtering `PricingScreen` (Settings -> Pricing, where every user manages
 * their own plan) would strand live Pro subscribers with no current-plan row and
 * no downgrade path — the exact mistake the fit doc records being made once
 * already and reversed.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  plansForProduct,
  PRODUCT_PLANS,
  TIER_LABELS,
  TIER_FEATURES,
} from '../../pro/tierMatrix';

function code(rel: string[]): string {
  return readFileSync(join(process.cwd(), 'src', ...rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
}

describe('F9 — Professional is absent from the onboarding plan list', () => {
  // Owner 2026-10-31 — supersedes F9 on the Messenger door: "Bravo Messenger,
  // Bravo Messenger Pro (Coming Soon) — currently enterprise is there - remove
  // it". Enterprise moved to the Workspace door (Company Register).
  it('the messenger door offers Bravo Messenger and Bravo Messenger Pro (Coming Soon), no Enterprise', () => {
    const plans = plansForProduct('messenger');
    expect(plans.map(p => p.title)).toEqual(['Bravo Messenger', 'Bravo Messenger Pro']);
    expect(plans.find(p => p.tier === 'pro')?.soon).toBe(true);
    expect(plans.find(p => p.tier === 'lite')?.soon).toBeUndefined();
    expect(plans.some(p => p.tier === 'enterprise')).toBe(false);
  });

  it('the workspace door is Enterprise (Company Register)', () => {
    const plans = plansForProduct('workspace');
    expect(plans.map(p => [p.tier, p.title, p.eyebrow])).toEqual([['enterprise', 'Enterprise', 'Company Register']]);
  });

  it('an unknown / cold-start path gets the messenger door, Professional still not selectable', () => {
    for (const p of [null, undefined, 'nonsense' as unknown as 'messenger']) {
      expect(plansForProduct(p).filter(x => x.tier === 'pro').every(x => x.soon === true)).toBe(true);
    }
    expect(plansForProduct(null)).toEqual(plansForProduct('messenger'));
    expect(plansForProduct(undefined)).toEqual(plansForProduct('messenger'));
  });

  it('Bravo Secure Pro is untouched — a different product family, not this tier', () => {
    // lockedTerminology.test.ts keeps the two families apart; the A2 rule names
    // the MESSENGER Professional tier, and the Secure path's plan is the
    // request-and-approval protection plan.
    expect(plansForProduct('secure').map(p => p.title))
      .toEqual(['Bravo Secure', 'Bravo Secure Pro']); // founder 2026-09-02: no "Lite" in the product name
  });
});

describe('F9 — plan MANAGEMENT is not collateral damage', () => {
  it('the full catalogue still describes Professional', () => {
    // Only the onboarding VIEW narrows. A live Pro subscriber still has a plan
    // with a name and a feature list to render.
    expect(PRODUCT_PLANS.messenger.some(p => p.tier === 'pro')).toBe(true);
    expect(TIER_LABELS.pro).toBe('Bravo Messenger Pro');
    expect(TIER_FEATURES.pro.length).toBeGreaterThan(0);
  });

  it('Settings -> Pricing was NOT filtered', () => {
    // It reads TIER_LABELS / TIER_FEATURES — the maps above — and iterates all
    // three tiers. A `plansForProduct` import here would mean the onboarding
    // filter had leaked onto the plan-management screen.
    const pricing = code(['screens', 'settings', 'PricingScreen.tsx']);
    expect(pricing).toMatch(/TIER_LABELS/);
    expect(pricing).not.toMatch(/plansForProduct/);
    expect(pricing).not.toMatch(/ONBOARDING_HIDDEN/);
  });

  it('the paywall can still resolve a Pro purchase', () => {
    const paywall = code(['screens', 'pro', 'TierPaywall.tsx']);
    expect(paywall).toMatch(/TIER_LABELS/);
    expect(paywall).not.toMatch(/plansForProduct/);
  });
});
