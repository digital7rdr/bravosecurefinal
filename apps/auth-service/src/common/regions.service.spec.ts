import {RegionsService} from './regions.service';
import {
  DEFAULT_REGIONS, isSupportedRegion, regionFromCountry, regionFromPoint,
  regions, regionUtcOffsetHours, setLiveRegions, supportedRegionCodes, REGION_NA,
} from './regions';
import type {DatabaseService} from '../database/database.service';

/**
 * Client 2026-09-01 — "we need to be able to add regions as we get service
 * providers." Regions moved from a compiled array to ops-managed rows.
 *
 * The invariants worth pinning are the ones where a wrong answer is expensive:
 *
 *  · An empty or unreachable table must read as "no data", never "no regions".
 *    Publishing an empty list would fail every `unsupported_region` check and
 *    stop bookings product-wide — a far worse failure than briefly missing a
 *    newly added region.
 *  · node-postgres returns `numeric` as a STRING. An unconverted utc_offset
 *    silently breaks every peak-hour comparison in the quote, and unconverted
 *    coordinates break the pricing-region resolve.
 *  · `regionFromPoint` is the SERVER-DERIVED answer that makes per-region
 *    pricing safe. 20260831180000 refused to scope lead time by region because
 *    the client supplies it; this is the replacement for that trust.
 */

const row = (over: Record<string, unknown> = {}) => ({
  code: 'AE', name: 'UAE', currency: 'AED',
  utc_offset_hours: '4.00', launched: true,
  min_lat: '22.50000', max_lat: '26.50000', min_lng: '51.00000', max_lng: '56.50000',
  ...over,
});

function mockDb(impl: () => Promise<unknown[]>) {
  return {q: jest.fn(impl)} as unknown as DatabaseService & {q: jest.Mock};
}

afterEach(() => setLiveRegions(null));

describe('regions() — the live layer', () => {
  it('falls back to the compiled set when nothing is published', () => {
    expect(regions()).toBe(DEFAULT_REGIONS);
    expect(supportedRegionCodes()).toEqual(['AE', 'SA', 'BD', 'GB', 'ZA']);
  });

  it('an EMPTY published list is treated as no data, not as "no regions exist"', () => {
    setLiveRegions([]);
    // The whole product would stop taking bookings otherwise.
    expect(regions()).toBe(DEFAULT_REGIONS);
    expect(isSupportedRegion('AE')).toBe(true);
  });

  it('publishes ops rows over the compiled set, including a brand-new region', () => {
    setLiveRegions([
      ...DEFAULT_REGIONS,
      {code: 'FR', name: 'France — Paris', currency: 'EUR', utcOffsetHours: 1, launched: true},
    ]);
    expect(supportedRegionCodes()).toContain('FR');
    expect(isSupportedRegion('fr')).toBe(true);
    expect(regionUtcOffsetHours('FR')).toBe(1);
  });

  it('an unknown region has no offset rather than a guessed one', () => {
    expect(regionUtcOffsetHours('ZZ')).toBe(0);
    expect(regionUtcOffsetHours(null)).toBe(0);
  });

  it('regionFromCountry resolves an ops-added region on its own ISO code', () => {
    expect(regionFromCountry('FR')).toBe(REGION_NA);
    setLiveRegions([...DEFAULT_REGIONS,
      {code: 'FR', name: 'France', currency: 'EUR', utcOffsetHours: 1, launched: true}]);
    expect(regionFromCountry('fr')).toBe('FR');
    expect(regionFromCountry('XX')).toBe(REGION_NA);
  });
});

describe('regionFromPoint — the server-derived pricing region', () => {
  beforeEach(() => setLiveRegions(DEFAULT_REGIONS.map(r => ({
    ...r,
    bbox: r.code === 'AE' ? {minLat: 22.5, maxLat: 26.5, minLng: 51, maxLng: 56.5}
        : r.code === 'ZA' ? {minLat: -35, maxLat: -22.1, minLng: 16.4, maxLng: 33}
        : undefined,
  }))));

  it('resolves a point inside a box', () => {
    expect(regionFromPoint(25.2, 55.27)).toBe('AE');   // Dubai
  });

  it('resolves a NEGATIVE-latitude box (the southern-hemisphere sign bug)', () => {
    expect(regionFromPoint(-33.92, 18.42)).toBe('ZA'); // Cape Town
  });

  it('returns null outside every box — which prices at the GLOBAL rate', () => {
    expect(regionFromPoint(48.85, 2.35)).toBeNull();   // Paris, no box
  });

  it('a region with no box never resolves, so it cannot make a booking cheaper', () => {
    // GB is boxless in this fixture; a London point must not resolve to it.
    expect(regionFromPoint(51.5, -0.12)).toBeNull();
  });

  it('rejects absent, NaN and Infinite coordinates rather than matching a box', () => {
    for (const [lat, lng] of [[NaN, 55], [25, NaN], [Infinity, 55], [25, Infinity]] as const) {
      expect(regionFromPoint(lat, lng)).toBeNull();
    }
    expect(regionFromPoint(undefined, undefined)).toBeNull();
    expect(regionFromPoint(null, null)).toBeNull();
  });

  it('includes the box edges — a pickup on the border is inside, not nowhere', () => {
    expect(regionFromPoint(22.5, 51)).toBe('AE');
    expect(regionFromPoint(26.5, 56.5)).toBe('AE');
  });
});

describe('RegionsService', () => {
  it('converts numeric-as-string columns — offsets and coordinates alike', async () => {
    const db = mockDb(async () => [row()]);
    await new RegionsService(db).ensureFresh();

    const ae = regions().find(r => r.code === 'AE');
    expect(ae?.utcOffsetHours).toBe(4);            // number, not "4.00"
    expect(ae?.bbox).toEqual({minLat: 22.5, maxLat: 26.5, minLng: 51, maxLng: 56.5});
    // Proof the conversion matters: a string offset would break this.
    expect(regionUtcOffsetHours('AE')).toBe(4);
  });

  it('a row with a partial box carries NO box rather than a half-formed one', async () => {
    const db = mockDb(async () => [row({max_lng: null})]);
    await new RegionsService(db).ensureFresh();
    expect(regions().find(r => r.code === 'AE')?.bbox).toBeUndefined();
  });

  it('drops a row with no code or no name instead of publishing it', async () => {
    const db = mockDb(async () => [row(), row({code: '  ', name: 'x'}), row({code: 'XX', name: '  '})]);
    await new RegionsService(db).ensureFresh();
    expect(supportedRegionCodes()).toEqual(['AE']);
  });

  it('a failed read leaves the compiled set in place and RETRIES next call', async () => {
    let calls = 0;
    const db = mockDb(async () => { calls++; throw new Error('relation does not exist'); });
    const svc = new RegionsService(db);

    await svc.ensureFresh();
    expect(regions()).toBe(DEFAULT_REGIONS);

    // The failure must NOT have stamped the cache clock — otherwise a single
    // blip strands the service on compiled defaults for a full TTL.
    await svc.ensureFresh();
    expect(calls).toBe(2);
  });

  it('caches — a second call inside the TTL does not re-query', async () => {
    const db = mockDb(async () => [row()]);
    const svc = new RegionsService(db);
    await svc.ensureFresh();
    await svc.ensureFresh();
    expect((db as unknown as {q: jest.Mock}).q).toHaveBeenCalledTimes(1);
  });

  it('single-flights a burst — concurrent bookings issue ONE query', async () => {
    const db = mockDb(async () => [row()]);
    const svc = new RegionsService(db);
    await Promise.all([svc.ensureFresh(), svc.ensureFresh(), svc.ensureFresh()]);
    expect((db as unknown as {q: jest.Mock}).q).toHaveBeenCalledTimes(1);
  });

  it('refresh() bypasses the cache so an ops write is visible immediately', async () => {
    const db = mockDb(async () => [row()]);
    const svc = new RegionsService(db);
    await svc.ensureFresh();
    await svc.refresh();
    expect((db as unknown as {q: jest.Mock}).q).toHaveBeenCalledTimes(2);
  });

  it('with no database at all it is a no-op on the compiled set', async () => {
    await new RegionsService().ensureFresh();
    expect(regions()).toBe(DEFAULT_REGIONS);
  });
});
