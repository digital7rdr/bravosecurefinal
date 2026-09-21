/**
 * B-786 — `GET /bookings/history`, the client booking-history read model.
 *
 * Same discipline as booking.list.spec.ts: DatabaseService is mocked across this
 * service's whole suite, so the only things a unit test can honestly assert are
 * the VALUES bound to Postgres, the SQL text that surrounds them, and the pure
 * mapping on the way out. That is exactly where this feature's risk lives:
 *
 *   - an un-allow-listed query value reaching the type layer (the B-388 class);
 *   - a filter applied AFTER paging, which silently corrupts total + cursor;
 *   - an N+1 that only shows up on a real account with real history;
 *   - a field that must never leave the server (`rating_remarks`, Issue 31).
 */
import * as fs from 'fs';
import * as path from 'path';
import {BookingHistoryService, paymentState, reference} from './booking-history.service';
import type {DatabaseService} from '../database/database.service';
import type {PricingService} from './pricing.service';

type QCall = {sql: string; params: unknown[]};

/**
 * Enrichment rows the mock serves. Answering [] for all of them (the first
 * cut of this file) left the entire mission / crew / escrow / receipt mapping
 * unexercised — every mapped row came back with `mission: null` — which is
 * precisely what hid the crew-status defect below.
 */
interface Enrich {
  missions?: Record<string, unknown>[];
  crew?: Record<string, unknown>[];
  escrows?: Record<string, unknown>[];
  ledger?: Record<string, unknown>[];
  invoices?: Record<string, unknown>[];
  disputes?: Record<string, unknown>[];
}

function mk(opts?: {
  pageRows?: Record<string, unknown>[];
  count?: string;
  enrich?: Enrich;
  eurPerBc?: number;
}) {
  const calls: QCall[] = [];
  const pageRows = opts?.pageRows ?? [];
  const en = opts?.enrich ?? {};
  const q = jest.fn().mockImplementation((sql: string, params: unknown[] = []) => {
    calls.push({sql, params});
    if (/FROM lite_bookings b/.test(sql) && /ORDER BY b\.pickup_time/.test(sql)) {
      return Promise.resolve(pageRows);
    }
    if (/DISTINCT ON \(m\.booking_id\)/.test(sql)) {return Promise.resolve(en.missions ?? []);}
    if (/JOIN mission_crew mc/.test(sql)) {return Promise.resolve(en.crew ?? []);}
    if (/FROM escrow_holds/.test(sql)) {return Promise.resolve(en.escrows ?? []);}
    if (/FROM wallet_transactions/.test(sql) && /booking_id = ANY/.test(sql)) {
      return Promise.resolve(en.ledger ?? []);
    }
    if (/FROM invoices/.test(sql)) {return Promise.resolve(en.invoices ?? []);}
    if (/FROM booking_disputes/.test(sql)) {return Promise.resolve(en.disputes ?? []);}
    return Promise.resolve([]);
  });
  const qOne = jest.fn().mockImplementation((sql: string, params: unknown[] = []) => {
    calls.push({sql, params});
    if (/COUNT\(\*\)::text AS n/.test(sql)) {return Promise.resolve({n: opts?.count ?? '0'});}
    if (/count_all/.test(sql)) {
      return Promise.resolve({
        count_all: '7', count_in_flight: '2', count_completed: '4', count_cancelled: '1',
      });
    }
    if (/spent_all/.test(sql)) {
      return Promise.resolve({spent_all: '4120', spent_30d: '980', refunded_all: '480'});
    }
    return Promise.resolve(null);
  });
  const db = {q, qOne} as unknown as DatabaseService;
  // 1 BC = eur_per_bc EUR, and the peg is ops-editable — the fixture varies it.
  const pricing = {
    config: jest.fn().mockResolvedValue({eur_per_bc: opts?.eurPerBc ?? 1}),
  } as unknown as PricingService;
  return {svc: new BookingHistoryService(db, pricing), calls, q, qOne};
}

const UUID_A = '11111111-2222-3333-4444-555555555555';
const UUID_B = '66666666-7777-8888-9999-aaaaaaaaaaaa';

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: UUID_A, client_id: 'c1', status: 'COMPLETED', service: 'secure_transfer',
    task_type: null, region_code: 'AE', region_label: 'UAE', booking_mode: 'now',
    dispatch_mode: 'auto', pickup_time: new Date('2026-09-02T14:30:00Z'), duration_hours: 4,
    created_at: new Date('2026-09-01T10:00:00Z'), confirmed_at: null,
    pickup_address: 'Marina', dropoff_address: 'DIFC', passengers: 2, cpo_count: 1,
    vehicle_count: 1, driver_only: false, add_ons: [], armed_required: false,
    female_required: false, exec_transport: null, total_eur: '980', total_aed: '3600',
    payment_method: 'bravo_credits', notes: null, conversation_id: null,
    rating: null, rating_tags: null, payer_user_id: null, payer_name: null,
    ...over,
  };
}

/** The page query is the one that ORDERs — the count query has no ORDER BY. */
const pageCall = (calls: QCall[]) =>
  calls.find(c => /FROM lite_bookings b/.test(c.sql) && /ORDER BY b\.pickup_time/.test(c.sql))!;
const countCall = (calls: QCall[]) => calls.find(c => /COUNT\(\*\)::text AS n/.test(c.sql))!;

describe('BookingHistoryService — values bound to Postgres', () => {
  it('scopes every page and count read to the calling client', async () => {
    const {svc, calls} = mk();
    await svc.history('client-9', {});
    expect(pageCall(calls).params[0]).toBe('client-9');
    expect(countCall(calls).params[0]).toBe('client-9');
    expect(pageCall(calls).sql).toMatch(/b\.client_id = \$1/);
  });

  it('never returns DRAFT rows (a booking that was never submitted is not history)', async () => {
    const {svc, calls} = mk();
    await svc.history('c1', {});
    expect(pageCall(calls).params[1]).not.toContain('DRAFT');
  });

  it('maps each bucket to its own status set', async () => {
    for (const [bucket, expected] of [
      ['upcoming', 'CONFIRMED'],
      ['past', 'COMPLETED'],
      ['cancelled', 'AGENCY_NO_SHOW'],
    ] as const) {
      const {svc, calls} = mk();
      await svc.history('c1', {bucket});
      expect(pageCall(calls).params[1]).toContain(expected);
    }
  });

  it('coerces an unknown bucket to "all" rather than binding it', async () => {
    const {svc, calls} = mk();
    await svc.history('c1', {bucket: "'; DROP TABLE lite_bookings; --"});
    const statuses = pageCall(calls).params[1] as string[];
    expect(statuses).toContain('COMPLETED');
    expect(statuses).toContain('CONFIRMED');
    expect(pageCall(calls).sql).not.toContain('DROP TABLE');
  });

  it('binds a null service filter for an unknown service — never an empty array', async () => {
    // `= ANY('{}')` matches NOTHING, so coercing a typo to [] would render an
    // empty history rather than an unfiltered one.
    const {svc, calls} = mk();
    await svc.history('c1', {service: 'not_a_service'});
    expect(pageCall(calls).params[2]).toBeNull();
  });

  it('keeps only allow-listed services from a mixed list', async () => {
    const {svc, calls} = mk();
    await svc.history('c1', {service: 'secure_transfer,evil,executive_protection'});
    expect(pageCall(calls).params[2]).toEqual(['secure_transfer', 'executive_protection']);
  });

  it('drops an unparseable date instead of binding it to a timestamptz', async () => {
    const {svc, calls} = mk();
    await svc.history('c1', {from: 'yesterday-ish', to: '2026-09-30'});
    expect(pageCall(calls).params[3]).toBeNull();
    expect(pageCall(calls).params[4]).toBe(new Date('2026-09-30').toISOString());
  });

  it('applies the payment filter INSIDE the paged query and the count, not after', async () => {
    // A post-filter would make `total` and the cursor disagree with the rows.
    const {svc, calls} = mk();
    await svc.history('c1', {payment: 'refunded'});
    expect(pageCall(calls).sql).toMatch(/escrow_holds/);
    expect(countCall(calls).sql).toMatch(/escrow_holds/);
  });

  it('ignores an unknown payment filter', async () => {
    const {svc, calls} = mk();
    await svc.history('c1', {payment: 'whatever'});
    expect(pageCall(calls).sql).not.toMatch(/escrow_holds/);
  });

  it('reads upcoming forward in time and everything else backwards', async () => {
    const up = mk();
    await up.svc.history('c1', {bucket: 'upcoming'});
    expect(pageCall(up.calls).sql).toMatch(/ORDER BY b\.pickup_time ASC/);
    expect(pageCall(up.calls).sql).toMatch(/\) > \(/);

    const past = mk();
    await past.svc.history('c1', {bucket: 'past'});
    expect(pageCall(past.calls).sql).toMatch(/ORDER BY b\.pickup_time DESC/);
    expect(pageCall(past.calls).sql).toMatch(/\) < \(/);
  });

  it('orders by pickup_time, not created_at (B-786g)', async () => {
    const {svc, calls} = mk();
    await svc.history('c1', {});
    expect(pageCall(calls).sql).not.toMatch(/ORDER BY b\.created_at/);
  });

  it('clamps the limit and fetches one extra row to detect a next page', async () => {
    const {svc, calls} = mk();
    await svc.history('c1', {limit: 9999});
    expect(pageCall(calls).params[7]).toBe(51); // MAX_LIMIT 50 + 1
    const low = mk();
    await low.svc.history('c1', {limit: 0});
    expect(pageCall(low.calls).params[7]).toBe(2); // floor 1 + 1
  });

  it('never selects rating_remarks (quality/ops only, Issue 31)', async () => {
    const {svc, calls} = mk();
    await svc.history('c1', {});
    for (const c of calls) {expect(c.sql).not.toMatch(/rating_remarks/);}
  });

  it('never selects internal ops notes or actor ids', async () => {
    const {svc, calls} = mk();
    await svc.history('c1', {});
    for (const c of calls) {
      expect(c.sql).not.toMatch(/internal_notes/);
      expect(c.sql).not.toMatch(/actor_user_id/);
    }
  });
});

describe('BookingHistoryService — cursor', () => {
  it('round-trips a cursor and binds both halves of the keyset', async () => {
    const first = mk({pageRows: [row(), row({id: UUID_B})], count: '2'});
    const page = await first.svc.history('c1', {limit: 1});
    expect(page.next_cursor).toBeTruthy();

    const second = mk();
    await second.svc.history('c1', {limit: 1, before: page.next_cursor!});
    expect(pageCall(second.calls).params[5]).toBe('2026-09-02T14:30:00.000Z');
    expect(pageCall(second.calls).params[6]).toBe(UUID_A);
  });

  it('returns a null cursor when the page is the last one', async () => {
    const {svc} = mk({pageRows: [row()], count: '1'});
    const page = await svc.history('c1', {limit: 5});
    expect(page.next_cursor).toBeNull();
  });

  it('drops a malformed cursor rather than binding garbage to ::uuid', async () => {
    for (const bad of ['not-base64!!', Buffer.from('nopipe').toString('base64url'),
      Buffer.from('2026-01-01T00:00:00Z|not-a-uuid').toString('base64url')]) {
      const {svc, calls} = mk();
      await svc.history('c1', {before: bad});
      expect(pageCall(calls).params[5]).toBeNull();
      expect(pageCall(calls).params[6]).toBeNull();
    }
  });

  it('serves the summary on the first page only', async () => {
    const first = mk({pageRows: [row()]});
    expect((await first.svc.history('c1', {})).summary).not.toBeNull();
    const next = mk({pageRows: [row()]});
    const cur = Buffer.from(`2026-09-02T14:30:00.000Z|${UUID_A}`).toString('base64url');
    expect((await next.svc.history('c1', {before: cur})).summary).toBeNull();
  });
});

describe('BookingHistoryService — no N+1', () => {
  it('issues the same number of queries for 1 row as for 25', async () => {
    const one = mk({pageRows: [row()], count: '1'});
    await one.svc.history('c1', {});
    const many = mk({
      pageRows: Array.from({length: 25}, (_, i) =>
        row({id: `${i}`.padStart(8, '0') + '-2222-3333-4444-555555555555'})),
      count: '25',
    });
    await many.svc.history('c1', {});
    expect(many.calls.length).toBe(one.calls.length);
    // page + count + 2 summary + 6 enrichment. The BC peg read is a config
    // lookup, not a db query, so it adds nothing here.
    expect(one.calls.length).toBe(10);
  });

  it('skips enrichment entirely on an empty page', async () => {
    const {svc, calls} = mk({pageRows: []});
    await svc.history('c1', {});
    expect(calls.some(c => /FROM missions m/.test(c.sql))).toBe(false);
  });

  it('scopes the ledger to the booking payer so escrow mirror rows cannot double-count', async () => {
    const {svc, calls} = mk({pageRows: [row({payer_user_id: 'owner-1'})], count: '1'});
    await svc.history('c1', {});
    const led = calls.find(c => /FROM wallet_transactions/.test(c.sql) && /booking_id = ANY/.test(c.sql))!;
    expect(led.params[1]).toEqual(['owner-1']);
  });

  it('joins agents on user_id — the table has no id column', async () => {
    const {svc, calls} = mk({pageRows: [row()], count: '1'});
    await svc.history('c1', {});
    const crew = calls.find(c => /JOIN mission_crew mc/.test(c.sql))!;
    expect(crew.sql).toMatch(/LEFT JOIN agents a ON a\.user_id = mc\.agent_id/);
  });
});

describe('BookingHistoryService — mapping', () => {
  it('reports the TRUE total, not the page length (B-786c)', async () => {
    const {svc} = mk({pageRows: [row()], count: '137'});
    const page = await svc.history('c1', {});
    expect(page.total).toBe(137);
    expect(page.bookings).toHaveLength(1);
  });

  it('marks a booking paid from another wallet as family_owner', async () => {
    const {svc} = mk({pageRows: [row({payer_user_id: 'owner-1'})], count: '1'});
    const [b] = (await svc.history('c1', {})).bookings;
    expect(b.payment.payer).toBe('family_owner');
  });

  it('treats a payer equal to the client as self', async () => {
    const {svc} = mk({pageRows: [row({payer_user_id: 'c1', client_id: 'c1'})], count: '1'});
    const [b] = (await svc.history('c1', {})).bookings;
    expect(b.payment.payer).toBe('self');
  });

  // B-843 (A18) — a member may be under several roots, so "Paid by plan holder"
  // no longer identifies anyone. The row names the root that actually paid.
  it('B-843: names the ROOT that paid (payer_name) when someone else paid', async () => {
    const {svc, calls} = mk({
      pageRows: [row({payer_user_id: 'owner-1', payer_name: 'Acme Security'})], count: '1',
    });
    const [b] = (await svc.history('c1', {})).bookings;
    expect(b.payment.payer).toBe('family_owner');
    expect(b.payment.payer_name).toBe('Acme Security');
    // Projected through a LEFT JOIN on the payer — an INNER join would drop
    // every self-paid row from the page.
    const sql = pageCall(calls).sql.replace(/\s+/g, ' ');
    expect(sql).toContain('LEFT JOIN public.users pu ON pu.id = b.payer_user_id');
    expect(sql).toContain('pu.display_name AS payer_name');
  });

  it('B-843: a SELF-paid booking names nobody, even though the join returns the client\'s own name', async () => {
    // B-843 stamps `payer_user_id` on the legacy path too, so the join now
    // resolves for self-paid rows as well — the gate is the mapper.
    const {svc} = mk({
      pageRows: [row({payer_user_id: 'c1', client_id: 'c1', payer_name: 'Me Myself'})], count: '1',
    });
    const [b] = (await svc.history('c1', {})).bookings;
    expect(b.payment.payer).toBe('self');
    expect(b.payment.payer_name).toBeNull();
  });

  it('B-843: a nameless root degrades to null, never to undefined', async () => {
    const {svc} = mk({pageRows: [row({payer_user_id: 'owner-1', payer_name: null})], count: '1'});
    const [b] = (await svc.history('c1', {})).bookings;
    expect(b.payment.payer_name).toBeNull();
  });

  // B-854 (A8) — LM-B7 on the CLIENT's own history.
  //
  // On a chained booking the wallet is a root the client has never heard of:
  // they are a member of the INTERMEDIARY, not of the account above it. This
  // endpoint would otherwise hand them the wallet owner's display name with
  // ZERO code change — `payer_user_id !== client_id` is already true — which is
  // the leak the edge-case round caught.
  it('B-854: a CHAINED booking names the INTERMEDIARY to the client, never the wallet owner', async () => {
    const {svc, calls} = mk({
      pageRows: [row({
        client_id: 'c1', payer_user_id: 'root-A', payer_name: 'Root A Holdings',
        payer_via_user_id: 'member-B', payer_via_name: 'Bee Member',
      })],
      count: '1',
    });
    const [b] = (await svc.history('c1', {})).bookings;
    expect(b.payment.payer).toBe('family_owner');
    expect(b.payment.payer_name).toBe('Bee Member');
    // The wallet owner's name must not reach this payload at all.
    expect(JSON.stringify(b.payment)).not.toContain('Root A Holdings');
    const sql = pageCall(calls).sql.replace(/\s+/g, ' ');
    expect(sql).toContain('LEFT JOIN public.users vu ON vu.id = b.payer_via_user_id');
    expect(sql).toContain('vu.display_name AS payer_via_name');
  });

  it('B-854: an UNCHAINED family booking still names the payer, unchanged', async () => {
    const {svc} = mk({
      pageRows: [row({payer_user_id: 'owner-1', payer_name: 'Acme Security', payer_via_user_id: null})],
      count: '1',
    });
    const [b] = (await svc.history('c1', {})).bookings;
    expect(b.payment.payer_name).toBe('Acme Security');
  });

  it('computes a stable support reference from the booking id', async () => {
    // Byte-identical to the apps' own `shortRef` (last 12 hex of the uuid,
    // upper-cased) so support, ops and the client all say the same string.
    expect(reference(UUID_A)).toBe('BL-555555555555');
    expect(reference('0f9a1b2c-3d4e-5f60-7a8b-9c0d1e2f3a4b')).toBe('BL-9C0D1E2F3A4B');
    expect(reference(UUID_A)).toMatch(/^BL-[0-9A-F]{12}$/);
  });

  it('surfaces the rating without ever surfacing remarks', async () => {
    const {svc} = mk({pageRows: [row({rating: 5, rating_tags: ['punctual']})], count: '1'});
    const [b] = (await svc.history('c1', {})).bookings;
    expect(b.rating).toEqual({stars: 5, tags: ['punctual']});
    expect(JSON.stringify(b)).not.toMatch(/remarks/i);
  });
});

describe('paymentState — where the money is, in one word', () => {
  const held = {status: 'HELD'};
  it('escrow wins over the ledger', () => {
    expect(paymentState('COMPLETED', held, 980, 0, null)).toBe('held');
    expect(paymentState('COMPLETED', {status: 'PENDING_RELEASE'}, 980, 0, null)).toBe('held');
    expect(paymentState('COMPLETED', {status: 'RELEASED'}, 980, 0, null)).toBe('released');
    expect(paymentState('COMPLETED', {status: 'PARTIAL'}, 980, 300, null)).toBe('partially_refunded');
    expect(paymentState('CANCELLED', {status: 'REFUNDED'}, 980, 980, null)).toBe('refunded');
  });

  it('an open dispute or a disputed hold reads under review', () => {
    expect(paymentState('COMPLETED', {status: 'DISPUTED'}, 980, 0, null)).toBe('under_review');
    expect(paymentState('COMPLETED', held, 980, 0, {status: 'open'})).toBe('under_review');
    expect(paymentState('COMPLETED', held, 980, 0, {status: 'resolved'})).toBe('held');
  });

  it('falls back to the ledger for a legacy booking with no hold', () => {
    expect(paymentState('COMPLETED', null, 980, 0, null)).toBe('paid');
    expect(paymentState('CANCELLED', null, 980, 980, null)).toBe('refunded');
    expect(paymentState('CANCELLED', null, 980, 300, null)).toBe('partially_refunded');
  });

  it('separates a bill that is DUE from a booking that never charged', () => {
    expect(paymentState('PAYMENT_PENDING', null, 0, 0, null)).toBe('due');
    expect(paymentState('OPS_APPROVED', null, 0, 0, null)).toBe('due');
    expect(paymentState('NO_PROVIDER', null, 0, 0, null)).toBe('not_charged');
    expect(paymentState('CANCELLED', null, 0, 0, null)).toBe('not_charged');
  });

  it('never calls a zero-charge refund "refunded"', () => {
    // Guards a sign bug: with charged 0 a stray positive row must not read as a
    // full refund of nothing.
    expect(paymentState('COMPLETED', null, 0, 50, null)).toBe('partially_refunded');
  });
});

describe('the route is reachable', () => {
  // Nest matches routes in DECLARATION order. `@Get(':id')` declared first would
  // swallow /bookings/history as a booking whose id is "history" — a 404 that
  // reads exactly like a missing feature. A source scan is the only honest test
  // here: this suite does not boot the Nest router.
  const src = fs
    .readFileSync(path.join(__dirname, 'booking.controller.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  it("declares @Get('history') before @Get(':id')", () => {
    const history = src.indexOf("@Get('history')");
    const byId = src.indexOf("@Get(':id')");
    expect(history).toBeGreaterThan(-1);
    expect(byId).toBeGreaterThan(-1);
    expect(history).toBeLessThan(byId);
  });

  it('passes the authenticated user, never a client id from the query string', () => {
    expect(src).toMatch(/this\.history\.history\(user\.sub,/);
  });
});

describe('the enrichment actually maps (reviewer finding: it was never exercised)', () => {
  const MISSION = {
    booking_id: UUID_A, id: 'm1', short_code: 'BRV-42', status: 'COMPLETED',
    started_at: new Date('2026-09-02T14:30:00Z'), pickup_at: new Date('2026-09-02T14:40:00Z'),
    live_at: new Date('2026-09-02T14:45:00Z'), ended_at: new Date('2026-09-02T18:30:00Z'),
    end_reason: 'completed', route_distance_m: 18400, route_duration_s: 1500,
    vehicle_model: 'GLE 450', vehicle_plate: 'D-12345', vehicle_armour: 'B4',
    crew_accepted: true,
  };
  const CREW = {
    booking_id: UUID_A, call_sign: 'FALCON-2', display_name: 'A. Karim',
    is_lead: true, crew_count: '3',
  };

  it('surfaces the mission, the lead and the vehicle', async () => {
    const {svc} = mk({pageRows: [row()], count: '1', enrich: {missions: [MISSION], crew: [CREW]}});
    const [b] = (await svc.history('c1', {})).bookings;
    expect(b.mission?.short_code).toBe('BRV-42');
    expect(b.mission?.lead).toEqual({call_sign: 'FALCON-2', display_name: 'A. Karim'});
    expect(b.mission?.crew_count).toBe(3);
    expect(b.mission?.vehicle).toEqual({model: 'GLE 450', plate: 'D-12345', armour: 'B4'});
    expect(b.mission?.route_distance_m).toBe(18400);
  });

  it('does NOT filter the crew by status — a finished mission has crew "off"', async () => {
    // Every terminal path (mission complete, ops abort, arrival no-show, client
    // cancel) sets mission_crew.status = 'off' to free the officers. Filtering
    // on it erased the crew for exactly the COMPLETED / CANCELLED bookings this
    // endpoint mostly serves, so every finished detail reported no officers.
    const {svc, calls} = mk({pageRows: [row()], count: '1', enrich: {missions: [MISSION], crew: [CREW]}});
    const b = (await svc.history('c1', {})).bookings[0];
    const crewSql = calls.find(c => /JOIN mission_crew mc/.test(c.sql))!.sql;
    expect(crewSql).not.toMatch(/mc\.status/);
    expect(b.mission?.crew_count).toBe(3);
  });

  it('surfaces the receipt and the dispute', async () => {
    const {svc} = mk({
      pageRows: [row()], count: '1',
      enrich: {
        invoices: [{
          booking_id: UUID_A, invoice_number: 'BS-000123', kind: 'client_receipt',
          issued_at: new Date('2026-09-03T09:00:00Z'), total_credits: 980,
        }],
        disputes: [{
          booking_id: UUID_A, status: 'open', category: 'left_early',
          created_at: new Date('2026-09-03T10:00:00Z'),
        }],
      },
    });
    const [b] = (await svc.history('c1', {})).bookings;
    expect(b.receipt?.invoice_number).toBe('BS-000123');
    expect(b.dispute?.category).toBe('left_early');
    // An open dispute is what "under review" means to the client.
    expect(b.payment.state).toBe('under_review');
  });

  it('reads the payer ledger into charged / refunded', async () => {
    const {svc} = mk({
      pageRows: [row({payer_user_id: 'c1', client_id: 'c1'})], count: '1',
      enrich: {
        ledger: [
          {id: 'w1', booking_id: UUID_A, user_id: 'c1', type: 'payment', amount_credits: -980, created_at: new Date()},
          {id: 'w2', booking_id: UUID_A, user_id: 'c1', type: 'refund', amount_credits: 300, created_at: new Date()},
        ],
      },
    });
    const [b] = (await svc.history('c1', {})).bookings;
    expect(b.payment.charged_credits).toBe(980);
    expect(b.payment.refunded_credits).toBe(300);
    expect(b.payment.state).toBe('partially_refunded');
    expect(b.payment.ledger).toHaveLength(2);
  });
});

describe('the BC peg (1 BC = eur_per_bc EUR, ops-editable)', () => {
  it('derives the quote in CREDITS, not in EUR', async () => {
    // total_eur 980 at a peg of 2 is 490 BC. Reading the EUR figure as credits
    // made the quote disagree with charged_credits (which comes from the
    // peg-correct escrow gross) by exactly the peg.
    const {svc} = mk({pageRows: [row()], count: '1', eurPerBc: 2});
    const [b] = (await svc.history('c1', {})).bookings;
    expect(b.payment.quoted_credits).toBe(490);
  });

  it('agrees with the escrow charge at a non-unit peg', async () => {
    const {svc} = mk({
      pageRows: [row()], count: '1', eurPerBc: 2,
      enrich: {escrows: [{
        booking_id: UUID_A, status: 'HELD', basis: null, gross_credits: 490,
        to_client_credits: null, release_eligible_at: null, review_required: false,
      }]},
    });
    const [b] = (await svc.history('c1', {})).bookings;
    expect(b.payment.quoted_credits).toBe(b.payment.charged_credits);
  });

  it('falls open to the compiled default when the config read throws', async () => {
    const {svc} = mk({pageRows: [row()], count: '1'});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).pricing = {config: jest.fn().mockRejectedValue(new Error('down'))};
    const [b] = (await svc.history('c1', {})).bookings;
    expect(b.payment.quoted_credits).toBe(980);
  });
});

describe('paymentState — the settled statuses read the MONEY, not the label', () => {
  it('a clawed-back release is NOT "paid"', () => {
    // clawbackReleasedHold (a dispute upheld AFTER release) leaves
    // escrow_holds.status = 'RELEASED' for ever and only restates
    // to_client_credits, so reading the status alone reported PAID beside a
    // non-zero refund in the same payload.
    expect(paymentState('COMPLETED', {status: 'RELEASED', basis: 'clawback'}, 980, 980, null))
      .toBe('refunded');
    expect(paymentState('COMPLETED', {status: 'RELEASED', basis: 'clawback'}, 980, 300, null))
      .toBe('partially_refunded');
  });

  it('a PARTIAL split that refunded nothing is not "partly refunded"', () => {
    // settleEscrowSplit can legitimately end with to_client 0 — a mission that
    // ran to completion before an abort, or a 100% cancellation fee.
    expect(paymentState('COMPLETED', {status: 'PARTIAL', basis: 'partial'}, 980, 0, null))
      .toBe('released');
    expect(paymentState('COMPLETED', {status: 'PARTIAL', basis: 'partial'}, 980, 300, null))
      .toBe('partially_refunded');
  });

  it('an ordinary release with nothing refunded is still paid', () => {
    expect(paymentState('COMPLETED', {status: 'RELEASED', basis: 'full_release'}, 980, 0, null))
      .toBe('released');
  });

  it('a REFUNDED hold reads refunded even before the ledger row lands', () => {
    expect(paymentState('CANCELLED', {status: 'REFUNDED', basis: 'refund'}, 980, 0, null))
      .toBe('refunded');
  });
});

describe('the refunded filter agrees with the state it produces', () => {
  it('does not match a PARTIAL split that refunded nothing', async () => {
    const {svc, calls} = mk();
    await svc.history('c1', {payment: 'refunded'});
    const sql = pageCall(calls).sql;
    expect(sql).toMatch(/e\.status::text = 'PARTIAL' AND COALESCE\(e\.to_client_credits, 0\) > 0/);
    expect(sql).not.toMatch(/IN \('REFUNDED','PARTIAL'\)/);
  });
});

describe('the paid filter agrees with the state it produces', () => {
  it('excludes a booking that was charged and then refunded', async () => {
    const {svc, calls} = mk();
    await svc.history('c1', {payment: 'paid'});
    const sql = pageCall(calls).sql;
    // Without this a legacy pay-with-credits booking that was fully refunded
    // matched ?payment=paid while its own state read 'refunded'.
    expect(sql).toMatch(/AND NOT EXISTS \(SELECT 1 FROM wallet_transactions wr/);
    expect(sql).toMatch(/wr\.type::text = 'refund'/);
  });
});
