import {OrgFleetService} from './org-fleet.service';
import type {DatabaseService} from '../database/database.service';

const ORG = 'org-A';

/** A tiny scripted DB: each call is matched by regex against the SQL. */
function db(script: Array<[RegExp, unknown]>) {
  const calls: Array<{sql: string; params: unknown[]}> = [];
  const answer = (sql: string) => {
    for (const [re, v] of script) if (re.test(sql)) return typeof v === 'function' ? (v as () => unknown)() : v;
    return null;
  };
  const tx = {
    q: jest.fn(async (sql: string, params: unknown[] = []) => { calls.push({sql, params}); return answer(sql) ?? []; }),
    qOne: jest.fn(async (sql: string, params: unknown[] = []) => { calls.push({sql, params}); return answer(sql); }),
  };
  const d = {...tx, withTransaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx))};
  return {svc: new OrgFleetService(d as unknown as DatabaseService), calls};
}

describe('OrgFleetService — agency vehicles', () => {
  it('lists only the caller org', async () => {
    const {svc, calls} = db([[/FROM org_vehicles v/, []]]);
    await svc.list(ORG);
    expect(calls[0].sql).toMatch(/WHERE v\.org_user_id = \$1/);
    expect(calls[0].params).toEqual([ORG]);
  });

  it('a new vehicle is created under the caller org and starts in review', async () => {
    const {svc, calls} = db([[/INSERT INTO org_vehicles/, {id: 'v1', review_status: 'pending'}]]);
    await svc.create(ORG, 'mgr', {call_sign: 'FS-01', make_model: 'Toyota LC300', plate: 'A 4439'});
    expect(calls[0].params[0]).toBe(ORG);
    // DB default 'pending': the INSERT column list never sets the review state.
    expect(calls[0].sql.split('VALUES')[0]).not.toMatch(/review_status/);
  });

  it('changing the plate sends a verified vehicle back to review and off open missions', async () => {
    const {svc, calls} = db([
      [/SELECT make_model, plate, armored, armor_grade FROM org_vehicles/, {make_model: 'LC300', plate: 'A 4439', armored: true, armor_grade: 'B6'}],
      [/UPDATE org_vehicles AS v/, {id: 'v1'}],
    ]);
    await svc.update(ORG, 'v1', {plate: 'B 1234'});
    const upd = calls.find(c => /UPDATE org_vehicles AS v/.test(c.sql))!;
    expect(upd.sql).toMatch(/review_status = 'pending'/);
    expect(upd.params.slice(-2)).toEqual(['v1', ORG]);
    expect(calls.some(c => /UPDATE mission_org_vehicles SET released_at/.test(c.sql))).toBe(true);
  });

  it('re-saving the same plate (spacing/case aside) keeps the review status', async () => {
    const {svc, calls} = db([
      [/SELECT make_model, plate, armored, armor_grade FROM org_vehicles/, {make_model: 'LC300', plate: 'A 4439', armored: true, armor_grade: 'B6'}],
      [/UPDATE org_vehicles AS v/, {id: 'v1'}],
    ]);
    await svc.update(ORG, 'v1', {plate: 'a4439', colour: 'Black'});
    const upd = calls.find(c => /UPDATE org_vehicles AS v/.test(c.sql))!;
    expect(upd.sql.split('WHERE')[0]).not.toMatch(/review_status/);
    expect(calls.some(c => /UPDATE mission_org_vehicles/.test(c.sql))).toBe(false);
  });

  it("another agency's vehicle reads as not found", async () => {
    const {svc} = db([[/FOR UPDATE/, null]]);
    await expect(svc.update(ORG, 'v-other', {colour: 'Red'})).rejects.toThrow('vehicle_not_found');
  });

  describe('assigning to a mission', () => {
    const base: Array<[RegExp, unknown]> = [
      [/FROM missions m\s+JOIN lite_bookings b/, {status: 'CREWED'}],
    ];
    it('needs the mission to belong to the agency', async () => {
      const {svc} = db([[/FROM missions m\s+JOIN lite_bookings b/, null]]);
      await expect(svc.assign(ORG, 'mgr', 'm1', 'v1')).rejects.toThrow('mission_not_found');
    });
    it('refuses a closed mission', async () => {
      const {svc} = db([[/FROM missions m\s+JOIN lite_bookings b/, {status: 'COMPLETED'}]]);
      await expect(svc.assign(ORG, 'mgr', 'm1', 'v1')).rejects.toThrow('mission_not_open');
    });
    it('refuses an unverified vehicle', async () => {
      const {svc} = db([...base, [/FROM org_vehicles\s+WHERE id = \$1 AND org_user_id = \$2 FOR UPDATE/, {active: true, review_status: 'pending'}]]);
      await expect(svc.assign(ORG, 'mgr', 'm1', 'v1')).rejects.toThrow('vehicle_not_verified');
    });
    it('refuses a vehicle busy on another open mission', async () => {
      const {svc} = db([...base,
        [/FROM org_vehicles\s+WHERE id = \$1 AND org_user_id = \$2 FOR UPDATE/, {active: true, review_status: 'verified'}],
        [/SELECT mv\.mission_id FROM mission_org_vehicles/, {mission_id: 'm-other'}]]);
      await expect(svc.assign(ORG, 'mgr', 'm1', 'v1')).rejects.toThrow('vehicle_busy');
    });
    it('assigns a verified, free vehicle, locking the vehicle row first', async () => {
      const {svc, calls} = db([...base,
        [/FROM org_vehicles\s+WHERE id = \$1 AND org_user_id = \$2 FOR UPDATE/, {active: true, review_status: 'verified'}],
        [/SELECT mv\.mission_id FROM mission_org_vehicles/, null]]);
      await expect(svc.assign(ORG, 'mgr', 'm1', 'v1')).resolves.toEqual({ok: true});
      const ins = calls.find(c => /INSERT INTO mission_org_vehicles/.test(c.sql))!;
      expect(ins.params).toEqual(['m1', 'v1', ORG, 'mgr']);
      const lockAt = calls.findIndex(c => /FOR UPDATE/.test(c.sql));
      const insAt = calls.indexOf(ins);
      expect(lockAt).toBeGreaterThan(-1);
      expect(lockAt).toBeLessThan(insAt);
    });
  });

  it('HQ rejection needs a reason and frees the vehicle', async () => {
    const {svc, calls} = db([[/UPDATE org_vehicles AS v/, {id: 'v1', org_user_id: ORG}]]);
    await expect(svc.review('adm', 'v1', 'rejected', '')).rejects.toThrow('reason_required');
    await svc.review('adm', 'v1', 'rejected', 'Plate does not match registration');
    expect(calls.some(c => /UPDATE mission_org_vehicles SET released_at/.test(c.sql))).toBe(true);
  });
});
