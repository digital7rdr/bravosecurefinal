import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import {RegionsService} from './regions.service';
import {regions} from './regions';

/**
 * OP-05 — RegionsService reloads when the cluster version moved (an ops write
 * on ANY pod), loads at boot, and ticks in the background so an idle pod's
 * synchronous readers (agent region validation) never sit on the compiled
 * defaults for longer than one interval.
 */
const row = (code: string) => ({
  code, name: code, currency: 'AED', utc_offset_hours: 4, launched: true,
  min_lat: null, max_lat: null, min_lng: null, max_lng: null,
});
function db(rows: unknown[]) {
  return {q: jest.fn().mockResolvedValue(rows)} as unknown as DatabaseService & {q: jest.Mock};
}
function redis(version: string) {
  const client = {get: jest.fn().mockResolvedValue(version)};
  return {redis: {client} as unknown as RedisService, client};
}

describe('OP-05 — regions follow the cluster version', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reloads inside the TTL when the version moved', async () => {
    const d = db([row('AE')]);
    const r = redis('1');
    const svc = new RegionsService(d, r.redis);
    jest.spyOn(Date, 'now').mockReturnValue(10_000);
    await svc.ensureFresh();
    expect(d.q).toHaveBeenCalledTimes(1);
    await svc.ensureFresh();               // same version, inside TTL
    expect(d.q).toHaveBeenCalledTimes(1);
    r.client.get.mockResolvedValue('2');   // an ops write elsewhere
    d.q.mockResolvedValue([row('AE'), row('QA')]);
    jest.spyOn(Date, 'now').mockReturnValue(12_500);
    await svc.ensureFresh();
    expect(d.q).toHaveBeenCalledTimes(2);
    expect(regions().map(x => x.code)).toContain('QA');
  });

  it('onApplicationBootstrap loads immediately and arms a background tick; destroy clears it', () => {
    jest.useFakeTimers();
    const d = db([row('AE')]);
    const svc = new RegionsService(d);
    const spy = jest.spyOn(svc, 'ensureFresh');
    // Post-bootstrap on purpose: OnModuleInit ran before the DB pool existed on
    // the staging box (first load failed open, recovered by the 30 s tick).
    svc.onApplicationBootstrap();
    expect(spy).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(30_000);
    expect(spy).toHaveBeenCalledTimes(2);
    svc.onModuleDestroy();
    jest.advanceTimersByTime(60_000);
    expect(spy).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('does nothing at boot without a db (bare spec construction stays inert)', () => {
    jest.useFakeTimers();
    const svc = new RegionsService();
    const spy = jest.spyOn(svc, 'ensureFresh');
    svc.onApplicationBootstrap();
    jest.advanceTimersByTime(90_000);
    expect(spy).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});
