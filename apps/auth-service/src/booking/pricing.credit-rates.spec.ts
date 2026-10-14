import {PricingService, LOCAL_PER_EUR_DEFAULTS, DEFAULT_SERVICE_PRICING} from './pricing.service';

/**
 * 2026-10-14 — "How Bravo Credits work": 1 BC = eur_per_bc EUR, and what that
 * is in each region's currency. A region's own `local_per_eur` row wins; the
 * compiled indicative rate covers a region with none; a dead board answers the
 * defaults (display only — never throws).
 */
describe('PricingService.creditRates', () => {
  it('compiled defaults with no database', async () => {
    const r = await new PricingService().creditRates();
    expect(r.eurPerBc).toBe(DEFAULT_SERVICE_PRICING.eur_per_bc);
    const ae = r.rates.find(x => x.region === 'AE')!;
    expect(ae.currency).toBe('AED');
    expect(ae.localPerBc).toBeCloseTo(LOCAL_PER_EUR_DEFAULTS.AED, 4);
    expect(r.rates.map(x => x.region).sort()).toEqual(['AE', 'BD', 'GB', 'SA', 'ZA']);
  });

  it('a region row overrides the default and the peg scales it', async () => {
    const db = {
      q: jest.fn(async (sql: string) => {
        if (sql.includes("key = 'local_per_eur'")) return [{region_code: 'AE', value: '4.0000'}];
        // the board for config(): eur_per_bc = 1.25 globally
        return [{key: 'eur_per_bc', value: '1.25', region_code: 'GLOBAL'}];
      }),
    };
    const svc = new PricingService(db as never);
    const r = await svc.creditRates();
    expect(r.eurPerBc).toBe(1.25);
    expect(r.rates.find(x => x.region === 'AE')!.localPerBc).toBe(5);
    expect(r.rates.find(x => x.region === 'GB')!.localPerBc).toBeCloseTo(LOCAL_PER_EUR_DEFAULTS.GBP * 1.25, 4);
  });

  it('an unreadable board answers the defaults', async () => {
    const db = {q: jest.fn(async () => { throw new Error('down'); })};
    const r = await new PricingService(db as never).creditRates();
    expect(r.eurPerBc).toBe(1);
    expect(r.rates.find(x => x.region === 'ZA')!.localPerBc).toBeCloseTo(LOCAL_PER_EUR_DEFAULTS.ZAR, 4);
  });
});
