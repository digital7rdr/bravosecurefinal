import {OpsDataService} from './ops-data.service';

/**
 * B-794 — the ops "last known location" must not become a way around the
 * user's own Settings -> Location choice.
 *
 * The consent basis is already written down on the WRITE side:
 * FamilyService.reportLocation shares continuously only while
 * `users.location_scope = 'while_on_duty'`, and both narrower choices exclude
 * it. Rows survive a later narrowing, so re-checking at READ time is the whole
 * point — without it a user who switches to 'never' keeps showing the fix that
 * was legal to collect last week.
 *
 * VBG is deliberately NOT gated on location_scope: an ACTIVE vbg_monitoring
 * enrolment is the user asking to be tracked, and suppressing a protectee's
 * position in a protection product would be the wrong failure. It is labelled
 * by source so nobody reads it as a general fix.
 */

type Row = Record<string, unknown> | null;

/**
 * A db double that answers by matching the SQL, so a query the code stops
 * issuing cannot pass by accident — an inert mock returning a fixed row is how
 * a consent gate gets "verified" while doing nothing.
 */
function makeDb(rows: {family?: Row; agent?: Row; vbg?: Row}) {
  const seen: string[] = [];
  return {
    seen,
    q: jest.fn(),
    qOne: jest.fn(async (sql: string) => {
      seen.push(sql);
      if (sql.includes('family_member_locations')) return rows.family ?? null;
      if (sql.includes('FROM public.agents')) return rows.agent ?? null;
      if (sql.includes('vbg_telemetry_last')) return rows.vbg ?? null;
      return null;
    }),
  };
}

function svc(db: unknown): {
  lastKnownLocation(userId: string, scope: string): Promise<Record<string, unknown>>;
} {
  // Only the DB is exercised; the other collaborators are untouched by this path.
  return new OpsDataService(db as never) as never;
}

const FAMILY = {lat: 25.2, lng: 55.27, accuracy_m: 12, label: 'Downtown Dubai', recorded_at: '2026-09-04T04:00:00.000Z'};
const AGENT = {lat: 24.5, lng: 54.4, accuracy_m: null, recorded_at: '2026-09-04T05:00:00.000Z'};
const VBG = {lat: 21.4, lng: 39.8, recorded_at: '2026-09-03T00:00:00.000Z'};

describe('lastKnownLocation — consent', () => {
  it("scope 'never' reports opted_out and queries no general source", async () => {
    const db = makeDb({family: FAMILY, agent: AGENT});
    const out = await svc(db).lastKnownLocation('u1', 'never');
    expect(out).toEqual({blocked: 'opted_out'});
    // Not merely filtered out of the answer — never read.
    expect(db.seen.some(s => s.includes('family_member_locations'))).toBe(false);
    expect(db.seen.some(s => s.includes('FROM public.agents'))).toBe(false);
  });

  it("scope 'during_mission' excludes the continuous family fix", async () => {
    // Mirrors FamilyService.reportLocation: only 'while_on_duty' shares 24/7.
    const db = makeDb({family: FAMILY});
    expect(await svc(db).lastKnownLocation('u1', 'during_mission')).toEqual({blocked: 'no_source'});
    expect(db.seen.some(s => s.includes('family_member_locations'))).toBe(false);
  });

  it("scope 'while_on_duty' allows the family fix", async () => {
    const out = await svc(makeDb({family: FAMILY})).lastKnownLocation('u1', 'while_on_duty');
    expect(out).toMatchObject({source: 'family', lat: 25.2, lng: 55.27, label: 'Downtown Dubai', accuracy_m: 12});
  });

  it('distinguishes "turned it off" from "nothing ever reported"', async () => {
    // A single blank dash for both is what made this unanswerable; ops needs to
    // know which of the two it is looking at.
    expect(await svc(makeDb({})).lastKnownLocation('u1', 'while_on_duty')).toEqual({blocked: 'no_source'});
    expect(await svc(makeDb({})).lastKnownLocation('u1', 'never')).toEqual({blocked: 'opted_out'});
  });

  it('an active VBG enrolment is its own consent and survives a narrowed scope', async () => {
    const out = await svc(makeDb({vbg: VBG})).lastKnownLocation('u1', 'never');
    expect(out).toMatchObject({source: 'vbg', lat: 21.4});
  });

  it('the VBG read requires the enrolment to still be active', async () => {
    const db = makeDb({vbg: VBG});
    await svc(db).lastKnownLocation('u1', 'while_on_duty');
    const vbgSql = db.seen.find(s => s.includes('vbg_telemetry_last')) ?? '';
    expect(vbgSql).toMatch(/vbg_monitoring/);
    expect(vbgSql).toMatch(/status = 'active'/);
  });

  it('picks the freshest fix when several sources have one', async () => {
    const out = await svc(makeDb({family: FAMILY, agent: AGENT, vbg: VBG})).lastKnownLocation('u1', 'while_on_duty');
    expect(out).toMatchObject({source: 'agent'}); // 05:00 beats 04:00 and the day-old VBG row
  });

  it('normalises coordinates and a missing accuracy', async () => {
    // Postgres numerics can arrive as strings; a missing accuracy must stay
    // null rather than becoming Number(null) === 0, i.e. "perfect precision".
    const out = await svc(makeDb({agent: {...AGENT, lat: '24.5', lng: '54.4'}})).lastKnownLocation('u1', 'while_on_duty');
    expect(out).toMatchObject({lat: 24.5, lng: 54.4, accuracy_m: null});
  });
});
