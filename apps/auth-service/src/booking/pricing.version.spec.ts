import type {ConfigService} from '@nestjs/config';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import {DEFAULT_SERVICE_PRICING, PricingService} from './pricing.service';

/**
 * OP-02 — PricingService drops its per-pod board when the cluster version
 * moves (the ops write bumps it), so N pods converge within the 2 s mirror
 * instead of each waiting out its own 60 s TTL and quoting old/new/old.
 * OP-10 — the two fee percentages ride the board with the env value as base.
 */
function db(rows: Array<{key: string; value: string; region_code: string}> = []) {
  return {q: jest.fn().mockResolvedValue(rows)} as unknown as DatabaseService & {q: jest.Mock};
}
function redis(version: string | null) {
  const client = {get: jest.fn().mockResolvedValue(version), incr: jest.fn(), del: jest.fn()};
  return {redis: {client} as unknown as RedisService, client};
}
function config(values: Record<string, unknown>) {
  return {get: jest.fn((k: string) => values[k])} as unknown as ConfigService;
}

describe('OP-02 — cluster version invalidates the per-pod board', () => {
  it('re-reads the table when the version moved, even inside the 60 s TTL', async () => {
    const d = db([{key: 'eur_per_bc', value: '2', region_code: 'GLOBAL'}]);
    const r = redis('1');
    const svc = new PricingService(d, r.redis);
    jest.spyOn(Date, 'now').mockReturnValue(10_000);
    expect((await svc.config()).eur_per_bc).toBe(2);
    expect(d.q).toHaveBeenCalledTimes(1);
    // Same version, inside TTL → cached, no table read.
    jest.spyOn(Date, 'now').mockReturnValue(15_000);
    await svc.config();
    expect(d.q).toHaveBeenCalledTimes(1);
    // The ops write bumped the version; the mirror's 2 s window (last read at
    // 15 000) elapsed, while the 60 s board TTL (built at 10 000) has NOT.
    r.client.get.mockResolvedValue('2');
    d.q.mockResolvedValue([{key: 'eur_per_bc', value: '3', region_code: 'GLOBAL'}]);
    jest.spyOn(Date, 'now').mockReturnValue(17_500);
    expect((await svc.config()).eur_per_bc).toBe(3);
    expect(d.q).toHaveBeenCalledTimes(2);
    jest.restoreAllMocks();
  });

  it('without Redis the 60 s TTL behaviour is unchanged', async () => {
    const d = db();
    const svc = new PricingService(d);
    jest.spyOn(Date, 'now').mockReturnValue(0);
    await svc.config();
    jest.spyOn(Date, 'now').mockReturnValue(30_000);
    await svc.config();
    expect(d.q).toHaveBeenCalledTimes(1);
    jest.spyOn(Date, 'now').mockReturnValue(61_000);
    await svc.config();
    expect(d.q).toHaveBeenCalledTimes(2);
    jest.restoreAllMocks();
  });

});

describe('OP-10 — fee percentages: env is the base, the board overrides', () => {
  it('ships the compiled defaults with no env and no rows', async () => {
    const cfg = await new PricingService().config();
    expect(cfg.platform_fee_pct).toBe(DEFAULT_SERVICE_PRICING.platform_fee_pct);
    expect(cfg.cancel_fee_pct).toBe(DEFAULT_SERVICE_PRICING.cancel_fee_pct);
  });

  it('takes the env value as base and a board row over it', async () => {
    const c = config({'dispatch.platformFeePct': 12, 'dispatch.cancelFeePct': 30});
    const base = await new PricingService(undefined, undefined, c).config();
    expect(base.platform_fee_pct).toBe(12);
    expect(base.cancel_fee_pct).toBe(30);
    const d = db([{key: 'platform_fee_pct', value: '9.5', region_code: 'GLOBAL'}]);
    const over = await new PricingService(d, undefined, c).config();
    expect(over.platform_fee_pct).toBe(9.5);
    expect(over.cancel_fee_pct).toBe(30);
  });
});
