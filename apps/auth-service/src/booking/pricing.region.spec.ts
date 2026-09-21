import {
  DEFAULT_SERVICE_PRICING, GLOBAL_REGION, PricingService, resolveLeadHours,
} from './pricing.service';
import type {DatabaseService} from '../database/database.service';

/**
 * Client 2026-09-01 — "pricing needs to be changed for each product of secure
 * services and must be adjustable per region", and "the lead times need to be
 * adjustable".
 *
 * The rule being pinned is the three-layer overlay:
 *
 *     compiled defaults  ->  'GLOBAL' rows  ->  this region's rows
 *
 * Most of these exist because the WRONG resolution is silent. A region that
 * accidentally inherits nothing charges the compiled default; a region that
 * accidentally overrides everything stops tracking global changes forever. Both
 * look like a working board.
 */

const row = (key: string, value: number, region = GLOBAL_REGION) =>
  ({key, value: String(value), region_code: region});

/**
 * The mock HONOURS the query's ORDER BY instead of imposing its own.
 *
 * The first cut of this file sorted GLOBAL-first unconditionally, and a mutation
 * that reversed the real `ORDER BY` left every overlay test green — the pin was
 * decorative. Postgres is what applies that clause in production, so the mock
 * reads it: `THEN 0` on the GLOBAL branch means GLOBAL sorts first (applied
 * first, so the region wins), and anything else means it does not.
 */
function dbWith(rows: Array<{key: string; value: string; region_code: string}>) {
  const q = jest.fn(async (sql: string, params: unknown[]) => {
    const [globalCode, region] = params as [string, string];
    const globals = rows.filter(r => r.region_code === globalCode);
    const locals  = rows.filter(r => r.region_code === region && region !== globalCode);
    const globalSortsFirst = /region_code = \$1 THEN 0/.test(sql);
    return globalSortsFirst ? [...globals, ...locals] : [...locals, ...globals];
  });
  return {q} as unknown as DatabaseService & {q: jest.Mock};
}

describe('PricingService.config — per-region overlay', () => {
  it('with no rows at all it is the compiled defaults', async () => {
    const cfg = await new PricingService(dbWith([])).config('AE');
    expect(cfg).toEqual(DEFAULT_SERVICE_PRICING);
  });

  it('GLOBAL rows override the compiled defaults', async () => {
    const cfg = await new PricingService(dbWith([row('exec_cpo_rate_bc', 99)])).config();
    expect(cfg.exec_cpo_rate_bc).toBe(99);
  });

  it("a region's row wins over GLOBAL for that key", async () => {
    const db = dbWith([row('exec_cpo_rate_bc', 99), row('exec_cpo_rate_bc', 120, 'AE')]);
    expect((await new PricingService(db).config('AE')).exec_cpo_rate_bc).toBe(120);
  });

  it('a region INHERITS every key it has not diverged on', async () => {
    const db = dbWith([
      row('exec_cpo_rate_bc', 99), row('peak_multiplier', 1.5),
      row('exec_cpo_rate_bc', 120, 'AE'),
    ]);
    const cfg = await new PricingService(db).config('AE');
    expect(cfg.exec_cpo_rate_bc).toBe(120);  // its own
    expect(cfg.peak_multiplier).toBe(1.5);   // still following global
    expect(cfg.eur_per_bc).toBe(DEFAULT_SERVICE_PRICING.eur_per_bc); // still compiled
  });

  it("another region's rows never leak in", async () => {
    const db = dbWith([row('exec_cpo_rate_bc', 99), row('exec_cpo_rate_bc', 500, 'ZA')]);
    expect((await new PricingService(db).config('AE')).exec_cpo_rate_bc).toBe(99);
  });

  it('an absent/empty region resolves GLOBAL — never a region rate', async () => {
    const db = dbWith([row('exec_cpo_rate_bc', 99), row('exec_cpo_rate_bc', 50, 'AE')]);
    const svc = new PricingService(db);
    expect((await svc.config(null)).exec_cpo_rate_bc).toBe(99);
    expect((await svc.config('   ')).exec_cpo_rate_bc).toBe(99);
    expect((await svc.config()).exec_cpo_rate_bc).toBe(99);
  });

  it('lower-cases are normalised, so "ae" is not a different region', async () => {
    const db = dbWith([row('exec_cpo_rate_bc', 99), row('exec_cpo_rate_bc', 120, 'AE')]);
    expect((await new PricingService(db).config('ae')).exec_cpo_rate_bc).toBe(120);
  });

  it('caches PER REGION — one region must not serve another its numbers', async () => {
    const db = dbWith([row('exec_cpo_rate_bc', 99), row('exec_cpo_rate_bc', 120, 'AE')]);
    const svc = new PricingService(db);
    await svc.config('AE');
    await svc.config('ZA');
    await svc.config('AE');   // cached
    expect((db as unknown as {q: jest.Mock}).q).toHaveBeenCalledTimes(2);
    expect((await svc.config('ZA')).exec_cpo_rate_bc).toBe(99);
  });

  it('asks for BOTH layers in ONE query, ordered so the region is applied last', async () => {
    const db = dbWith([row('exec_cpo_rate_bc', 99), row('exec_cpo_rate_bc', 120, 'AE')]);
    await new PricingService(db).config('AE');

    const [sql, params] = (db as unknown as {q: jest.Mock}).q.mock.calls[0];
    // One query, not two: an ops edit landing between two round trips would
    // produce a config that never existed.
    expect((db as unknown as {q: jest.Mock}).q).toHaveBeenCalledTimes(1);
    expect(sql).toMatch(/region_code = \$1 OR region_code = \$2/);
    expect(sql).toMatch(/region_code = \$1 THEN 0 ELSE 1/);
    expect(params).toEqual([GLOBAL_REGION, 'AE']);
  });

  it('a read failure falls back to compiled defaults rather than throwing', async () => {
    const db = {q: jest.fn(async () => { throw new Error('no such column region_code'); })} as unknown as DatabaseService;
    // Un-migrated environment: the whole point of fail-open.
    expect(await new PricingService(db).config('AE')).toEqual(DEFAULT_SERVICE_PRICING);
  });

  it('ignores a zero/negative/garbage stored value instead of charging it', async () => {
    const db = dbWith([
      {key: 'exec_cpo_rate_bc', value: '0', region_code: GLOBAL_REGION},
      {key: 'peak_multiplier', value: 'abc', region_code: GLOBAL_REGION},
    ]);
    const cfg = await new PricingService(db).config();
    expect(cfg.exec_cpo_rate_bc).toBe(DEFAULT_SERVICE_PRICING.exec_cpo_rate_bc);
    expect(cfg.peak_multiplier).toBe(DEFAULT_SERVICE_PRICING.peak_multiplier);
  });

  it('ignores an unknown key rather than widening the config object', async () => {
    const db = dbWith([{key: 'not_a_key', value: '5', region_code: GLOBAL_REGION}]);
    expect(await new PricingService(db).config()).toEqual(DEFAULT_SERVICE_PRICING);
  });
});

describe('resolveLeadHours — per service, now that region is server-derived', () => {
  const cfg = {...DEFAULT_SERVICE_PRICING};

  it('reads each service from its own key', () => {
    expect(resolveLeadHours('executive_protection', {...cfg, exec_min_lead_hours: 5})).toBe(5);
    expect(resolveLeadHours('close_protection', {...cfg, close_min_lead_hours: 2})).toBe(2);
    expect(resolveLeadHours('secure_transfer', {...cfg, transfer_min_lead_hours: 0.5})).toBe(0.5);
  });

  it('an UNKNOWN service has no lead — it must not invent a wait', () => {
    // A booking flow that never had a lead time must not start rejecting starts
    // because a new service string appeared.
    expect(resolveLeadHours('recon_team', cfg)).toBe(0);
    expect(resolveLeadHours(undefined, cfg)).toBe(0);
    expect(resolveLeadHours(null, cfg)).toBe(0);
  });

  it('a bad configured value falls back to the compiled default, per service', () => {
    for (const bad of [0, -1, NaN, Infinity, 169, 'x' as unknown as number]) {
      expect(resolveLeadHours('executive_protection', {...cfg, exec_min_lead_hours: bad as number}))
        .toBe(DEFAULT_SERVICE_PRICING.exec_min_lead_hours);
      expect(resolveLeadHours('secure_transfer', {...cfg, transfer_min_lead_hours: bad as number}))
        .toBe(DEFAULT_SERVICE_PRICING.transfer_min_lead_hours);
    }
  });

  it('the shipped defaults keep EP at 3h and leave transfer effectively book-now', () => {
    expect(DEFAULT_SERVICE_PRICING.exec_min_lead_hours).toBe(3);
    expect(DEFAULT_SERVICE_PRICING.close_min_lead_hours).toBe(3);
    // 15 minutes — the smallest lead the dispatch rail can honour, not a wait.
    expect(DEFAULT_SERVICE_PRICING.transfer_min_lead_hours).toBe(0.25);
  });

  it('a REGION may set its own lead, which is what the whole overlay was for', async () => {
    const db = dbWith([row('exec_min_lead_hours', 3), row('exec_min_lead_hours', 12, 'ZA')]);
    const za = await new PricingService(db).config('ZA');
    expect(resolveLeadHours('executive_protection', za)).toBe(12);
  });
});
