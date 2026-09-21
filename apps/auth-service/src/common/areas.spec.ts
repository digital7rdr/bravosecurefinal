/**
 * B-788a — area resolution and the routing switch.
 *
 * `areaIdForPoint` is the ONE query both BookingService (stamp at create) and
 * DispatchService (resolve at route) run, so its bind values and its order are
 * what a unit test can honestly assert. `regionRoutingMode` is what keeps the
 * whole feature dark: a region with no ops-set mode routes on the process
 * default, which itself defaults to 'nearest'.
 */
import {areaIdForPoint, regionRoutingMode, parseRoutingMode} from './areas';
import {setLiveRegions} from './regions';

function db() {
  const calls: Array<{sql: string; params: unknown[]}> = [];
  const qOne = jest.fn().mockImplementation((sql: string, params: unknown[]) => {
    calls.push({sql, params});
    return Promise.resolve({id: 'area-1'});
  });
  return {qOne, calls};
}

afterEach(() => setLiveRegions(null));

describe('areaIdForPoint', () => {
  it('binds the region and the point, and prefers a drawn area over the default', async () => {
    const d = db();
    const id = await areaIdForPoint(d, 'za', -33.09, 18.03);
    expect(id).toBe('area-1');
    const c = d.calls[0];
    expect(c.params).toEqual(['ZA', true, -33.09, 18.03]);
    expect(c.sql).toMatch(/is_default = TRUE/);
    expect(c.sql).toMatch(/ORDER BY is_default ASC, created_at ASC/);
    expect(c.sql).toMatch(/active = TRUE/);
  });

  it('still resolves the default area when the point is unknown', async () => {
    const d = db();
    await areaIdForPoint(d, 'ZA', null, undefined);
    expect(d.calls[0].params).toEqual(['ZA', false, 0, 0]);
  });

  it('returns null with no region and never queries', async () => {
    const d = db();
    expect(await areaIdForPoint(d, '', 1, 1)).toBeNull();
    expect(await areaIdForPoint(d, null, 1, 1)).toBeNull();
    expect(d.calls).toHaveLength(0);
  });

  it('returns null when the region has no areas at all', async () => {
    const d = db();
    d.qOne.mockResolvedValueOnce(null);
    expect(await areaIdForPoint(d, 'GB', 51.5, -0.1)).toBeNull();
  });
});

describe('regionRoutingMode — dark by default', () => {
  it('is the process default when the region carries no mode', () => {
    setLiveRegions([{code: 'ZA', name: 'ZA', currency: 'ZAR', utcOffsetHours: 2, launched: true}]);
    expect(regionRoutingMode('ZA', 'nearest')).toBe('nearest');
    expect(regionRoutingMode('ZA', 'assigned')).toBe('assigned');
  });

  it('the region\'s own ops-set mode wins over the process default', () => {
    setLiveRegions([{code: 'ZA', name: 'ZA', currency: 'ZAR', utcOffsetHours: 2, launched: true, routingMode: 'assigned'}]);
    expect(regionRoutingMode('ZA', 'nearest')).toBe('assigned');
    setLiveRegions([{code: 'ZA', name: 'ZA', currency: 'ZAR', utcOffsetHours: 2, launched: true, routingMode: 'nearest'}]);
    expect(regionRoutingMode('za', 'assigned')).toBe('nearest');
  });

  it('an unknown region routes on the process default', () => {
    expect(regionRoutingMode('XX', 'nearest')).toBe('nearest');
  });

  it('parses only the two real modes; anything else is nearest', () => {
    expect(parseRoutingMode('assigned')).toBe('assigned');
    expect(parseRoutingMode('nearest')).toBe('nearest');
    expect(parseRoutingMode('ASSIGNED')).toBe('nearest');
    expect(parseRoutingMode(undefined)).toBe('nearest');
    expect(parseRoutingMode('')).toBe('nearest');
  });
});
