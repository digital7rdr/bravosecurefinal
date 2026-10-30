/**
 * Founder 2026-08-08 — "remove Operator Partner completely from Virtual
 * Bodyguard."
 *
 * VBG is a PERSONAL safety product; there is no roster of officers to onboard
 * under a master licence, so the provider funnel has no business on that path.
 * It must still be offered everywhere else — it is how a security company signs
 * up (D-5), not a plan the client chooses between, so a blanket removal would
 * be a different and much worse bug.
 *
 * Asserted by CALLING `cardsForProduct`, not by scanning source. The sibling
 * scan in `screens/booking/__tests__/productScopedPlans.test.ts` can only see
 * that the guard is written; only this can see what the screen would render.
 */
import {cardsForProduct, defaultChoice} from '@screens/auth/RoleSelectionScreen';
import type {BravoProduct, OnboardingPath} from '@store/productStore';

const ids = (p: BravoProduct | null) => cardsForProduct(p).map(c => c.id);

describe('Operator Partner is not offered under Virtual Bodyguard', () => {
  it('vbg offers NO provider card', () => {
    expect(ids('vbg')).not.toContain('provider');
  });

  it('vbg still offers its own plans — the card was removed, not the screen', () => {
    // A guard that returned [] would also pass the assertion above.
    expect(ids('vbg').length).toBeGreaterThan(0);
  });

  it('removing the card removes its "WHAT YOU GET" sub-card with it', () => {
    // That block renders from `card.id === 'provider'`, so no card = no block.
    // Pinned because the founder asked for it gone COMPLETELY, and the
    // sub-card is the second half of what was on screen.
    expect(cardsForProduct('vbg').some(c => c.id === 'provider')).toBe(false);
  });

  it('the funnel survives ONLY on the Secure path (founder 2026-09-02: gone from messenger too)', () => {
    expect(ids('secure')).toContain('provider');
    // No product chosen yet (deep link / cold start) keeps it — it may be an agency.
    expect(ids(null)).toContain('provider');
    expect(ids('messenger').includes('provider')).toBe(false);
  });

  it('the provider card follows the plans wherever it appears (Agent code door last on Secure)', () => {
    expect(ids(null)[ids(null).length - 1]).toBe('provider');
    // Owner 2026-10-31 — Bravo Secure, Bravo Secure Pro, Service Provider, Agent (Enter with Code).
    expect(ids('secure')).toEqual(['lite', 'pro', 'provider', 'agent']);
  });

  it('owner 2026-10-31 — the four doors offer exactly the agreed options', () => {
    const titles = (p: OnboardingPath | null) => cardsForProduct(p).map(c => c.title);
    expect(titles('messenger')).toEqual(['Bravo Messenger', 'Bravo Messenger Pro']);
    expect(cardsForProduct('messenger').find(c => c.id === 'pro')?.soon).toBe(true);
    expect(titles('secure')).toEqual(['Bravo Secure', 'Bravo Secure Pro', 'Service Provider', 'Agent']);
    expect(titles('workspace')).toEqual(['Enterprise', 'Enterprise User']);
    expect(titles('vbg')).toEqual(['Bravo GeoRisk']);
    expect(cardsForProduct('secure').find(c => c.id === 'agent')?.code).toBe('agent');
    expect(cardsForProduct('workspace').find(c => c.id === 'member')?.code).toBe('workspace');
  });

  it('the screen opens on the first choosable card', () => {
    expect(defaultChoice(cardsForProduct('messenger'))).toBe('lite');
    expect(defaultChoice(cardsForProduct('workspace'))).toBe('enterprise');
  });

  it('no path emits a duplicate card id', () => {
    for (const p of ['messenger', 'secure', 'vbg', null] as Array<BravoProduct | null>) {
      const list = ids(p);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("the screen's default selection always names a card that renders and can be chosen", () => {
    for (const p of ['messenger', 'secure', 'vbg', 'workspace', null] as Array<OnboardingPath | null>) {
      const cards = cardsForProduct(p);
      const d = defaultChoice(cards);
      expect(cards.find(c => c.id === d)?.soon).not.toBe(true);
    }
  });
});
