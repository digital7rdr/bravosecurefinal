import {tiersToShow, PRICING_ORDER} from '../pricingTiers';

describe('tiersToShow (B-781 — the workspace door shows only Enterprise)', () => {
  it('no filter → the whole ladder in display order', () => {
    expect(tiersToShow()).toEqual(['lite', 'pro', 'enterprise']);
    expect(tiersToShow(null)).toEqual(PRICING_ORDER);
  });
  it('only=enterprise → exactly the Enterprise card', () => {
    expect(tiersToShow('enterprise')).toEqual(['enterprise']);
  });
  it('an unknown tier never renders an empty screen', () => {
    expect(tiersToShow('gold' as never)).toEqual(PRICING_ORDER);
  });
});
