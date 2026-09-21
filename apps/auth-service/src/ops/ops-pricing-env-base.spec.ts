import {OpsServicePricingController} from './ops-service-pricing.controller';
import {PricingService, DEFAULT_SERVICE_PRICING, envFeeBase} from '../booking/pricing.service';

/**
 * B-807 (critic P2) — the board and settlement must fall back to the SAME fee
 * when no board row exists. Before this the list fell back to the compiled 15
 * while `PricingService.config()` fell back to `DISPATCH_PLATFORM_FEE_PCT`, so
 * an environment with the env set and no board row showed the operator a fee
 * the release never applied — and the B-807 release dialog now presents that
 * number as "what the server will use".
 */
const cfg = {get: jest.fn((k: string) => (k === 'dispatch.platformFeePct' ? 12 : k === 'dispatch.cancelFeePct' ? 30 : undefined))};

describe('B-807 — envFeeBase is the one fallback for both readers', () => {
  it('applies the env fee percentages over the compiled defaults, leaving every other key alone', () => {
    const base = envFeeBase(cfg as never);
    expect(base.platform_fee_pct).toBe(12);
    expect(base.cancel_fee_pct).toBe(30);
    expect(base.eur_per_bc).toBe(DEFAULT_SERVICE_PRICING.eur_per_bc);
    expect(envFeeBase(undefined).platform_fee_pct).toBe(DEFAULT_SERVICE_PRICING.platform_fee_pct);
    expect(envFeeBase({get: () => -1} as never).platform_fee_pct).toBe(DEFAULT_SERVICE_PRICING.platform_fee_pct);
  });

  it('the board LIST with no rows reports the env base as value AND global_value, compiled as default_value', async () => {
    const db = {q: jest.fn().mockResolvedValue([]), qOne: jest.fn()};
    const regions = {ensureFresh: jest.fn().mockResolvedValue(undefined)};
    const ctrl = new OpsServicePricingController(db as never, {} as never, regions as never, undefined, cfg as never);
    const out = await ctrl.list(undefined);
    const fee = out.pricing.find(p => p.key === 'platform_fee_pct')!;
    expect(fee).toMatchObject({value: 12, global_value: 12, default_value: 15, inherited: true});
    const cancel = out.pricing.find(p => p.key === 'cancel_fee_pct')!;
    expect(cancel).toMatchObject({value: 30, global_value: 30, default_value: 25});
  });

  it('settlement (PricingService.config with no DB) resolves the same base number', async () => {
    const svc = new PricingService(undefined as never, undefined as never, cfg as never);
    const c = await svc.config('AE');
    expect(c.platform_fee_pct).toBe(12);
    expect(c.cancel_fee_pct).toBe(30);
  });
});
