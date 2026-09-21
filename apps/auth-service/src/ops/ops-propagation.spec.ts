import {OpsServicePricingController} from './ops-service-pricing.controller';
import {OpsRegionsController} from './ops-regions.controller';
import {OpsSubscriptionController} from './ops-subscription.controller';
import {OpsService} from './ops.service';
import {OpsDataService} from './ops-data.service';
import {MissionService} from './mission.service';
import {BookingController} from '../booking/booking.controller';
import {BookingPushBridge} from './booking-push-bridge.service';

/**
 * OP-01..OP-16 wiring pins (audit docs/audits/OPS_PROPAGATION_AND_FETCHING_AUDIT_2026-09-02.md).
 *
 * The primitives are pinned in config-version.spec / pricing.version.spec /
 * regions.version.spec. This file pins WHO calls them — the class of defect
 * the audit found was never a broken primitive, it was a write path that
 * simply did not call one (tier-gate had a cache and no bust; the pricing
 * controller did not even inject the service whose cache it invalidated).
 */
const admin = {user_id: 'adm', call_sign: 'OPS-1', role: 'ADMIN', region: 'AE'};
const req = {admin} as never;

function redis() {
  const client = {get: jest.fn().mockResolvedValue(null), incr: jest.fn().mockResolvedValue(1), del: jest.fn().mockResolvedValue(1), set: jest.fn()};
  return {r: {client} as never, client};
}

describe('OP-02 — the pricing board write bumps the cluster version', () => {
  it('PATCH and DELETE both INCR cfgver:pricing', async () => {
    const {r, client} = redis();
    const db = {
      q: jest.fn().mockResolvedValue([]),
      qOne: jest.fn()
        .mockResolvedValueOnce(null)                                    // prev (PATCH)
        .mockResolvedValueOnce({key: 'eur_per_bc', value: '2'})         // upsert RETURNING
        .mockResolvedValueOnce({value: '2'}),                           // DELETE RETURNING
    };
    const audit = {recordAdmin: jest.fn().mockResolvedValue(undefined)};
    const regions = {ensureFresh: jest.fn().mockResolvedValue(undefined)};
    const ctrl = new OpsServicePricingController(db as never, audit as never, regions as never, r);
    await ctrl.set({key: 'eur_per_bc', value: 2} as never, req);
    expect(client.incr).toHaveBeenCalledWith('cfgver:pricing');
    client.incr.mockClear();
    await ctrl.clear('eur_per_bc', 'AE', req);
    expect(client.incr).toHaveBeenCalledWith('cfgver:pricing');
  });

  it('accepts the two fee keys on the board (OP-10)', async () => {
    const {r} = redis();
    const db = {q: jest.fn().mockResolvedValue([]), qOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({key: 'platform_fee_pct', value: '12'})};
    const audit = {recordAdmin: jest.fn().mockResolvedValue(undefined)};
    const regions = {ensureFresh: jest.fn().mockResolvedValue(undefined)};
    const ctrl = new OpsServicePricingController(db as never, audit as never, regions as never, r);
    const out = await ctrl.set({key: 'platform_fee_pct', value: 12} as never, req);
    expect(out).toMatchObject({key: 'platform_fee_pct', value: 12});
    await expect(ctrl.set({key: 'platform_fee_pct', value: 80} as never, req)).rejects.toThrow(/value_out_of_bounds/);
  });
});

describe('OP-05 — a region write bumps cfgver:regions as well as refreshing locally', () => {
  it('create refreshes this pod AND bumps the cluster version', async () => {
    const {r, client} = redis();
    const db = {q: jest.fn().mockResolvedValue([]), qOne: jest.fn().mockResolvedValue(null)};
    const audit = {recordAdmin: jest.fn().mockResolvedValue(undefined)};
    const regions = {refresh: jest.fn().mockResolvedValue(undefined), ensureFresh: jest.fn()};
    const ctrl = new OpsRegionsController(db as never, audit as never, regions as never, r);
    await ctrl.create({code: 'QA', name: 'Qatar', currency: 'QAR'} as never, req);
    expect(regions.refresh).toHaveBeenCalled();
    expect(client.incr).toHaveBeenCalledWith('cfgver:regions');
  });
});

describe('OP-03 — an ops tier change busts the tier gate', () => {
  it('PATCH users/:id/tier DELs tier-gate:<user>', async () => {
    const {r, client} = redis();
    const db = {
      qOne: jest.fn()
        .mockResolvedValueOnce({subscription_tier: 'lite', pro_active_until: null})
        .mockResolvedValueOnce({id: 'u1', subscription_tier: 'pro', pro_active_until: null}),
    };
    const subscription = {cancelAutoRenew: jest.fn()};
    const audit = {recordAdmin: jest.fn().mockResolvedValue(undefined)};
    const ctrl = new OpsSubscriptionController(db as never, subscription as never, audit as never, r);
    await ctrl.setUserTier('u1', {tier: 'pro', days: 30} as never, req);
    expect(client.del).toHaveBeenCalledWith('tier-gate:u1');
  });
});

describe('OP-13 / OP-14 — bookings list: server-side search + offset', () => {
  it('q becomes an escaped ILIKE across id / client / pickup / dropoff; offset pages', () => {
    const q = jest.fn().mockResolvedValue([]);
    // OpsService has a 15+ way constructor; the list query needs only `db`.
    const svc = Object.assign(Object.create(OpsService.prototype), {db: {q, qOne: jest.fn()}}) as OpsService;
    svc.listBookings({q: '50%_off', limit: 20, offset: 40});
    const [sql, params] = q.mock.calls[0] as [string, unknown[]];
    // One backslash reaches Postgres (standard_conforming_strings): ESCAPE '\'.
    expect(sql).toMatch(/cu\.display_name ILIKE \$1 ESCAPE '\\'/);
    expect(sql).toMatch(/LIMIT \$2 OFFSET \$3/);
    expect(params).toEqual(['%50\\%\\_off%', 20, 40]);
  });

  it('missions list threads q through listByStatus with the same escaping', () => {
    const q = jest.fn().mockResolvedValue([]);
    const svc = Object.assign(Object.create(MissionService.prototype), {db: {q, qOne: jest.fn()}}) as MissionService;
    void svc.listActive('AE', 'BRV_1');
    const [sql, params] = q.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/m\.short_code ILIKE \$3 ESCAPE '\\'/);
    expect(params[2]).toBe('%BRV\\_1%');
  });
});

describe('OP-16 — the two unbounded console reads are bounded now', () => {
  it('vbg monitoring and promos take a clamped LIMIT', () => {
    const q = jest.fn().mockResolvedValue([]);
    const svc = new OpsDataService({q, qOne: jest.fn()} as never);
    svc.listVbgMonitoring(9_999);
    svc.listPromos(undefined);
    const [vbgSql, vbgParams] = q.mock.calls[0] as [string, unknown[]];
    const [promoSql, promoParams] = q.mock.calls[1] as [string, unknown[]];
    expect(vbgSql).toMatch(/LIMIT \$1\s*$/);
    expect(vbgParams).toEqual([500]);
    expect(promoSql).toMatch(/LIMIT \$1\s*$/);
    expect(promoParams).toEqual([100]);
  });
});

describe('OP-01 — the client display board is region-aware', () => {
  it('GET /bookings/service-pricing?region=AE prices the AE board; junk resolves GLOBAL', async () => {
    const pricing = {config: jest.fn().mockResolvedValue({eur_per_bc: 1})};
    const ctrl = new BookingController({} as never, {} as never, pricing as never, {} as never);
    await ctrl.servicePricing('ae');
    expect(pricing.config).toHaveBeenCalledWith('AE');
    await ctrl.servicePricing("'; DROP");
    expect(pricing.config).toHaveBeenLastCalledWith(undefined);
    const out = await ctrl.servicePricing(undefined);
    expect(out).toMatchObject({region: 'GLOBAL'});
  });

  it('a pickup point is resolved with the SAME regionFromPoint the charge uses; the code is the fallback', async () => {
    const pricing = {config: jest.fn().mockResolvedValue({eur_per_bc: 1})};
    const ctrl = new BookingController({} as never, {} as never, pricing as never, {} as never);
    // The compiled region set carries no bounding boxes, so the point resolves
    // to nothing and the draft's zone code stands in — the exact fallback the
    // client relies on before a pin is placed.
    await ctrl.servicePricing('ZA', '25.2048', '55.2708');
    expect(pricing.config).toHaveBeenLastCalledWith('ZA');
    // Garbage coordinates never throw and never leak into the region.
    await ctrl.servicePricing('ZA', 'abc', '');
    expect(pricing.config).toHaveBeenLastCalledWith('ZA');
  });
});

describe('OP-07 / OP-09 — the two silent ops writes now wake the app', () => {
  it('bridge publishes wallet-adjusted and compliance-decided', async () => {
    const client = {setex: jest.fn().mockResolvedValue('OK'), set: jest.fn().mockResolvedValue('OK'), publish: jest.fn().mockResolvedValue(1)};
    const bridge = Object.assign(Object.create(BookingPushBridge.prototype), {
      redis: {client},
      notifications: {record: jest.fn().mockResolvedValue(undefined)},
      log: {warn: jest.fn(), log: jest.fn(), debug: jest.fn()},
    }) as BookingPushBridge;
    await bridge.walletAdjusted('u1', 50);
    await bridge.complianceDecided('u2', 'cred1', 'verified', 'compliance');
    const kinds = client.publish.mock.calls.map(c => JSON.parse(c[1] as string).eventClass);
    expect(kinds).toEqual(['payout', 'agent']);
  });
});
