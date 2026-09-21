import {DispatchService} from './dispatch.service';
import {BookingStateMachine} from '../booking/state-machine.service';
import type {DatabaseService} from '../database/database.service';
import type {OpsAuditService} from '../ops/ops-audit.service';
import type {BookingPushBridge} from '../ops/booking-push-bridge.service';
import type {WalletService} from '../wallet/wallet.service';
import type {SentryService} from '../observability/sentry.service';

/**
 * SECURE_SERVICES_E2E_AUDIT_2026-09-03 — the dispatch-lane fixes.
 *
 *   E2E-04  the scheduled sweep had no lower bound; a stale approval dispatched a
 *           booking whose start was already past. `expireStaleScheduled` is the
 *           sweeper-side terminal outcome (+ the existing refund + an ops page).
 *   E2E-11  `noProvider()` was a silent dead end for a booking made days ahead.
 *   E2E-25  the ranking ran two plpgsql functions per agency in radius and its
 *           ORDER BY defeated the GiST KNN index.
 */

const fsm = new BookingStateMachine(); // real FSM — the transitions must be legal
const audit = {record: jest.fn()};
const push = {dispatchOffer: jest.fn(), noProvider: jest.fn(), bookingRejected: jest.fn()};
const wallet = {refundEscrowHold: jest.fn(), holdToEscrow: jest.fn()};
const sentry = {captureException: jest.fn()};
const db = {q: jest.fn(), qOne: jest.fn(), withTransaction: jest.fn()};

function service(): DispatchService {
  return new DispatchService(
    db as unknown as DatabaseService,
    fsm,
    audit as unknown as OpsAuditService,
    push as unknown as BookingPushBridge,
    wallet as unknown as WalletService,
    undefined, undefined, undefined, undefined,
    sentry as unknown as SentryService,
  );
}

beforeEach(() => {
  jest.resetAllMocks();
  audit.record.mockResolvedValue(undefined);
  push.dispatchOffer.mockResolvedValue(undefined);
  push.noProvider.mockResolvedValue(undefined);
  push.bookingRejected.mockResolvedValue(undefined);
  wallet.refundEscrowHold.mockResolvedValue({refunded: false, credits: 0});
  db.q.mockResolvedValue([]);
  db.qOne.mockResolvedValue(null);
  db.withTransaction.mockImplementation((fn: (tx: unknown) => unknown) => fn({q: db.q, qOne: db.qOne}));
});

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);

// ─── E2E-04 — a scheduled booking whose start is already past ───────────────

describe('E2E-04 — expireStaleScheduled', () => {
  function wireBooking(row: Record<string, unknown> | null, flipped = true) {
    db.qOne.mockImplementation((sql: string) =>
      /SELECT status, client_id, region_code, service, pickup_time/.test(sql)
        ? Promise.resolve(row) : Promise.resolve(null));
    db.q.mockImplementation((sql: string) =>
      /UPDATE lite_bookings SET status = 'CANCELLED'/.test(sql)
        ? Promise.resolve(flipped ? [{id: 'b1'}] : []) : Promise.resolve([]));
  }
  const PARKED = {
    status: 'OPS_APPROVED', client_id: 'c1', region_code: 'AE',
    service: 'executive_protection', pickup_time: inHours(-3),
  };

  it('flips a parked OPS_APPROVED row to CANCELLED and reports true', async () => {
    wireBooking(PARKED);
    await expect(service().expireStaleScheduled('b1')).resolves.toBe(true);
    expect(db.q).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE lite_bookings SET status = 'CANCELLED'/),
      ['b1', 'OPS_APPROVED'],
    );
  });

  it('runs the EXISTING refund path, not a new one — idempotent for the uncharged case', async () => {
    wireBooking(PARKED);
    await service().expireStaleScheduled('b1');
    expect(wallet.refundEscrowHold).toHaveBeenCalledWith(
      expect.anything(), 'b1', expect.stringContaining('Start time missed'),
    );
    // Exactly one refund attempt — never a second money path.
    expect(wallet.refundEscrowHold).toHaveBeenCalledTimes(1);
  });

  it('writes a DISTINCT terminal reason so this is not confused with a client cancel', async () => {
    wireBooking(PARKED);
    await service().expireStaleScheduled('b1');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'dispatch.scheduled_start_missed', subject_id: 'b1', actor_role: 'SYSTEM',
    }));
    expect(db.q).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO lite_booking_audit/),
      expect.arrayContaining([expect.stringContaining('scheduled_start_missed')]),
    );
  });

  it('pages ops (Sentry, ids + enums only — never PII, never the push channel)', async () => {
    wireBooking(PARKED);
    await service().expireStaleScheduled('b1');
    const [err, ctx] = sentry.captureException.mock.calls[0] as [Error, Record<string, never>];
    expect(err.message).toBe('slo:scheduled_start_missed');
    expect(JSON.stringify(ctx)).not.toMatch(/c1/);       // no client id
    expect(ctx).toMatchObject({tags: {slo: 'scheduled_start_missed'}});
  });

  it('wakes the client with a SHIPPED push kind (never one installed apps cannot render)', async () => {
    wireBooking(PARKED);
    await service().expireStaleScheduled('b1');
    expect(push.bookingRejected).toHaveBeenCalledWith('c1', 'b1');
  });

  it.each(['DISPATCHING', 'CONFIRMED', 'LIVE', 'COMPLETED', 'CANCELLED', 'NO_PROVIDER'])(
    'REFUSES to touch a %s booking — that row belongs to another sweep', async (status) => {
      wireBooking({...PARKED, status});
      await expect(service().expireStaleScheduled('b1')).resolves.toBe(false);
      expect(db.q).not.toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE lite_bookings SET status = 'CANCELLED'/), expect.anything());
      expect(wallet.refundEscrowHold).not.toHaveBeenCalled();
      expect(sentry.captureException).not.toHaveBeenCalled();
    });

  it('a missing booking is a no-op', async () => {
    wireBooking(null);
    await expect(service().expireStaleScheduled('b1')).resolves.toBe(false);
    expect(wallet.refundEscrowHold).not.toHaveBeenCalled();
  });

  it('another pod won the conditional flip ⇒ false, no refund, no page', async () => {
    wireBooking(PARKED, /* flipped */ false);
    await expect(service().expireStaleScheduled('b1')).resolves.toBe(false);
    expect(wallet.refundEscrowHold).not.toHaveBeenCalled();
    expect(push.bookingRejected).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('also handles the legacy in-flight DRAFT cohort the due-selection covers', async () => {
    wireBooking({...PARKED, status: 'DRAFT'});
    await expect(service().expireStaleScheduled('b1')).resolves.toBe(true);
  });
});

// ─── E2E-11 — noProvider is no longer a silent dead end when scheduled ──────

describe('E2E-11 — noProvider pages ops for a SCHEDULED booking with runway left', () => {
  function wireNoProvider(row: Record<string, unknown>) {
    db.qOne.mockImplementation((sql: string) =>
      /SELECT status, client_id, region_code, booking_mode, service, pickup_time/.test(sql)
        ? Promise.resolve(row) : Promise.resolve(null));
    db.q.mockImplementation((sql: string) =>
      /SET status = 'NO_PROVIDER'/.test(sql) ? Promise.resolve([{id: 'b1'}]) : Promise.resolve([]));
  }
  const DISPATCHING = {status: 'DISPATCHING', client_id: 'c1', region_code: 'AE'};

  it('pages when a `later` booking exhausts with hours still to go', async () => {
    wireNoProvider({...DISPATCHING, booking_mode: 'later', service: 'executive_protection', pickup_time: inHours(20)});
    await service().noProvider('b1');
    const [err, ctx] = sentry.captureException.mock.calls[0] as [Error, {extra: {minutes_to_start: number}}];
    expect(err.message).toBe('slo:no_provider_scheduled');
    expect(ctx.extra.minutes_to_start).toBeGreaterThan(1000);
  });

  it('does NOT page an ON-DEMAND exhaustion — the client is on screen and there is nothing to recover', async () => {
    wireNoProvider({...DISPATCHING, booking_mode: 'now', service: 'secure_transfer', pickup_time: inHours(0)});
    await service().noProvider('b1');
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(push.noProvider).toHaveBeenCalledWith('c1', 'b1'); // the client wake is unchanged
  });

  it('does NOT page a scheduled booking whose start has already passed (no runway)', async () => {
    wireNoProvider({...DISPATCHING, booking_mode: 'later', service: 'executive_protection', pickup_time: inHours(-1)});
    await service().noProvider('b1');
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('the terminal flip, the R12 refund and the client push are all unchanged', async () => {
    wireNoProvider({...DISPATCHING, booking_mode: 'later', service: 'executive_protection', pickup_time: inHours(20)});
    await service().noProvider('b1');
    expect(db.q).toHaveBeenCalledWith(expect.stringMatching(/SET status = 'NO_PROVIDER'/), ['b1']);
    expect(wallet.refundEscrowHold).toHaveBeenCalledWith(expect.anything(), 'b1', expect.stringContaining('No provider'));
    expect(push.noProvider).toHaveBeenCalledWith('c1', 'b1');
  });

  it('does NOT re-open the booking — NO_PROVIDER stays terminal (that reopen is arch-gated)', async () => {
    wireNoProvider({...DISPATCHING, booking_mode: 'later', service: 'executive_protection', pickup_time: inHours(20)});
    await service().noProvider('b1');
    expect(db.q).not.toHaveBeenCalledWith(
      expect.stringMatching(/SET status = 'DISPATCHING'/), expect.anything());
  });
});

// ─── E2E-25 — the ranking's bounded candidate set ──────────────────────────

describe('E2E-25 — the ranking pre-filters to the N nearest before the plpgsql functions', () => {
  /** Capture the ranking SQL + params actually issued by offerNext. */
  async function captureRanking(): Promise<{sql: string; params: unknown[]}> {
    let captured: {sql: string; params: unknown[]} | null = null;
    db.qOne.mockImplementation((sql: string, params: unknown[]) => {
      if (/SELECT status, region_code, cpo_count/.test(sql)) {
        return Promise.resolve({
          status: 'DISPATCHING', region_code: 'AE', cpo_count: 1,
          pickup_lat: '25', pickup_lng: '55', requirements: null, armed_required: false,
        });
      }
      if (/count\(\*\)::text/.test(sql)) {return Promise.resolve({n: '0'});}
      if (/is_eligible_for_dispatch/.test(sql)) {
        captured = {sql, params};
        return Promise.resolve(null); // no candidate → cascade ends, that is fine
      }
      return Promise.resolve(null);
    });
    await service().offerNext('b1');
    if (!captured) {throw new Error('ranking query was never issued');}
    return captured;
  }

  it('fences the candidate set in a MATERIALIZED CTE — without it PG inlines and the cost returns', async () => {
    const {sql} = await captureRanking();
    expect(sql).toMatch(/WITH nearby AS MATERIALIZED \(/);
  });

  it('the CTE orders by the KNN operator and LIMITs — the shape the GiST index can serve', async () => {
    const {sql} = await captureRanking();
    const cte = sql.slice(sql.indexOf('WITH nearby'), sql.indexOf('SELECT a.user_id, a.distance_km'));
    expect(cte).toMatch(/ORDER BY a\.last_location OPERATOR\(extensions\.<->\)/);
    expect(cte).toMatch(/LIMIT \$9/);
    // The expensive per-row functions must NOT be inside the CTE — that is the
    // whole point of the change.
    expect(cte).not.toMatch(/is_eligible_for_dispatch/);
    expect(cte).not.toMatch(/has_free_cpo_capacity/);
  });

  it('runs both plpgsql functions OUTSIDE the CTE, over the capped set', async () => {
    const {sql} = await captureRanking();
    const outer = sql.slice(sql.indexOf('SELECT a.user_id, a.distance_km'));
    expect(outer).toMatch(/is_eligible_for_dispatch\(a\.user_id, \$3, \$4::jsonb\)/);
    expect(outer).toMatch(/has_free_cpo_capacity\(a\.user_id, \$7\)/);
  });

  it('keeps the ORDER BY semantics identical: distance band, then rating, then exact distance', async () => {
    const {sql} = await captureRanking();
    const outer = sql.slice(sql.indexOf('SELECT a.user_id, a.distance_km'));
    const order = outer.slice(outer.lastIndexOf('ORDER BY'));
    expect(order).toMatch(/floor\(a\.distance_km \/ 1\) ASC/);
    expect(order).toMatch(/COALESCE\(a\.rating, 3\) DESC/);
    expect(order).toMatch(/a\.last_location OPERATOR\(extensions\.<->\)/);
    expect(order).toMatch(/LIMIT 1\s*$/);
  });

  it('keeps every anti-fraud / exclusion predicate in the CTE (none may be dropped)', async () => {
    const {sql} = await captureRanking();
    expect(sql).toMatch(/a\.type = 'company' AND a\.status = 'ACTIVE' AND a\.on_duty = TRUE/);
    expect(sql).toMatch(/a\.last_location_mocked = FALSE/);
    expect(sql).toMatch(/a\.cooldown_until IS NULL OR a\.cooldown_until < NOW\(\)/);
    expect(sql).toMatch(/a\.region_code = \$3/);
    expect(sql).toMatch(/extensions\.ST_DWithin/);
    expect(sql).toMatch(/status IN \('REJECTED','EXPIRED','SUPERSEDED'\)/);
    expect(sql).toMatch(/WHERE status = 'OFFERED'/);
  });

  it('binds the candidate cap as $9 (default 200, env-tunable)', async () => {
    const {params} = await captureRanking();
    expect(params).toHaveLength(9);
    expect(params[8]).toBe(200);
  });
});
