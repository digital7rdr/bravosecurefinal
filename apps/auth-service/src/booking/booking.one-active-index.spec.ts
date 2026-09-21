import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DispatchService} from '../dispatch/dispatch.service';
import {BookingStateMachine} from './state-machine.service';
import {ONE_ACTIVE_BOOKING_INDEX} from './booking.service';
import type {DatabaseService} from '../database/database.service';
import type {OpsAuditService} from '../ops/ops-audit.service';
import type {BookingPushBridge} from '../ops/booking-push-bridge.service';
import type {WalletService} from '../wallet/wallet.service';

/**
 * E2E-23, adversarial review 2026-09-03 — THE INDEX PREDICATE MUST BE CLOSED
 * UNDER UPDATE.
 *
 * The first cut of `lite_bookings_one_active_per_client_uq` copied
 * `BookingService.create()`'s read guard character-for-character, including its
 * B-405 exemption for parked `later` reservations. A read guard is evaluated
 * ONCE against a snapshot; an index predicate is re-evaluated on EVERY UPDATE.
 * The exempt set was not closed under its own exits, and the consequence was
 * destruction of a paid-for booking:
 *
 *   1. A client legally holds a parked `later` reservation AND an active `now`
 *      booking — exactly what B-405 exists to permit.
 *   2. The reservation's lead window arrives; `DispatchService.start()` runs
 *      `UPDATE … SET status = 'DISPATCHING'`.
 *   3. That row is now `later` + DISPATCHING, no longer exempt, so it ENTERS the
 *      index next to the `now` row → 23505.
 *   4. `start()` has no 23505 handler. `ScheduledDispatchService`'s per-row catch
 *      logs and the sweep retries every minute.
 *   5. 30 minutes past `pickup_time`, `sweepStaleStarts` CANCELS the booking and
 *      refunds it — a scheduled protection detail deleted because the client also
 *      had a transfer running.
 *
 * Two pins: the artefact (the migration's own SQL) and the behaviour (a stateful
 * fake DB that MODELS the index and fails an UPDATE the way Postgres would).
 */

const MIGRATION = join(
  __dirname, '..', '..', '..', '..',
  'supabase', 'migrations', '20260903120000_booking_guards_and_scale_indexes.sql',
);

/** The SQL of the CREATE UNIQUE INDEX, with `--` comment lines stripped.
 *  Stripping matters: this file's HEADER discusses the rejected predicate at
 *  length, so a raw substring scan would match prose and pass vacuously. */
function indexStatement(): string {
  const src = readFileSync(MIGRATION, 'utf8');
  const body = src
    .split(/\r?\n/)                       // the repo ships CRLF — never anchor on \n
    .filter(l => !l.trimStart().startsWith('--'))
    .join('\n');
  const start = body.indexOf('CREATE UNIQUE INDEX lite_bookings_one_active_per_client_uq');
  expect(start).toBeGreaterThan(-1);
  const end = body.indexOf('$ix$', start);
  expect(end).toBeGreaterThan(start);
  return body.slice(start, end);
}

describe('lite_bookings_one_active_per_client_uq — the artefact', () => {
  it('is scoped to booking_mode = \'now\', the one immutable column', () => {
    expect(indexStatement()).toMatch(/WHERE\s+booking_mode = 'now'/);
  });

  it('does NOT mirror the read guard\'s `later` exemption — that is what broke B-405', () => {
    const stmt = indexStatement();
    expect(stmt).not.toMatch(/booking_mode = 'later'/);
    expect(stmt).not.toMatch(/PENDING_OPS/);
    expect(stmt).not.toMatch(/OPS_APPROVED/);
  });

  it('still excludes exactly the four terminal statuses (LB17 set, derived from the code)', () => {
    expect(indexStatement())
      .toMatch(/status NOT IN \('COMPLETED','CANCELLED','NO_PROVIDER','AGENCY_NO_SHOW'\)/);
  });

  it('the pre-flight duplicate count uses the SAME predicate as the build', () => {
    // A pre-flight that counts a WIDER set warns on rows the index would accept
    // and silently skips a guard that would have built fine.
    const src = readFileSync(MIGRATION, 'utf8')
      .split(/\r?\n/).filter(l => !l.trimStart().startsWith('--')).join('\n');
    const preflight = src.slice(src.indexOf('SELECT count(*) INTO offending_clients'), src.indexOf('HAVING count(*) > 1'));
    expect(preflight).toMatch(/booking_mode = 'now'/);
    expect(preflight).toMatch(/status NOT IN \('COMPLETED','CANCELLED','NO_PROVIDER','AGENCY_NO_SHOW'\)/);
    expect(preflight).not.toMatch(/booking_mode = 'later'/);
  });
});

// ─── the behaviour, against a fake DB that enforces the index ───────────────

interface Row {
  id: string; client_id: string; booking_mode: 'now' | 'later';
  dispatch_mode: string | null; status: string;
}
type Predicate = (r: Row) => boolean;

const TERMINAL = new Set(['COMPLETED', 'CANCELLED', 'NO_PROVIDER', 'AGENCY_NO_SHOW']);

/** SHIPPED predicate — mirrors the CREATE UNIQUE INDEX above. */
const shipped: Predicate = r => r.booking_mode === 'now' && !TERMINAL.has(r.status);

/** REJECTED predicate — the read-guard mirror, kept to prove what it did. */
const readGuardMirror: Predicate = r =>
  !TERMINAL.has(r.status)
  && !(r.booking_mode === 'later'
       && (r.status === 'PENDING_OPS'
           || (r.status === 'OPS_APPROVED' && r.dispatch_mode === 'auto')));

/**
 * A DatabaseService double that holds rows and ENFORCES a partial unique index
 * on every write, exactly as Postgres would: apply the change, then look for two
 * rows of one client inside the predicate, and if so raise 23505 naming the
 * constraint (and roll the change back).
 *
 * A mock that does not model the constraint cannot see this class of bug at all
 * — the whole defect lives in what the DB does on UPDATE, not in what the
 * service intends.
 */
function fakeDb(rows: Row[], predicate: Predicate) {
  const violates = (): boolean => {
    const seen = new Set<string>();
    for (const r of rows) {
      if (!predicate(r)) {continue;}
      if (seen.has(r.client_id)) {return true;}
      seen.add(r.client_id);
    }
    return false;
  };
  const q = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (/UPDATE lite_bookings SET status = 'DISPATCHING'/.test(sql)) {
      const [id, expected] = params as [string, string];
      const row = rows.find(r => r.id === id && r.status === expected);
      if (!row) {return [];}
      const before = row.status;
      row.status = 'DISPATCHING';
      if (violates()) {
        row.status = before;                       // Postgres aborts the statement
        throw Object.assign(new Error('duplicate key value violates unique constraint'),
          {code: '23505', constraint: ONE_ACTIVE_BOOKING_INDEX});
      }
      return [{id}];
    }
    return [];
  });
  const qOne = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (/SELECT status, dispatch_mode FROM lite_bookings WHERE id = \$1 FOR UPDATE/.test(sql)) {
      const r = rows.find(x => x.id === (params as string[])[0]);
      return r ? {status: r.status, dispatch_mode: r.dispatch_mode} : null;
    }
    // offerNext's booking-context read → null ends the cascade immediately, so
    // this spec stays about the UPDATE and nothing else.
    return null;
  });
  return {
    db: {q, qOne, withTransaction: (fn: (tx: unknown) => unknown) => fn({q, qOne})} as unknown as DatabaseService,
    q,
  };
}

function svc(db: DatabaseService): DispatchService {
  return new DispatchService(
    db, new BookingStateMachine(),
    {record: jest.fn().mockResolvedValue(undefined)} as unknown as OpsAuditService,
    {dispatchOffer: jest.fn().mockResolvedValue(undefined)} as unknown as BookingPushBridge,
    {refundEscrowHold: jest.fn().mockResolvedValue({credits: 0})} as unknown as WalletService,
  );
}

/** The B-405 pair: one parked scheduled reservation, one live on-demand booking. */
const b405Rows = (): Row[] => ([
  {id: 'later-1', client_id: 'c1', booking_mode: 'later', dispatch_mode: 'auto', status: 'OPS_APPROVED'},
  {id: 'now-1',   client_id: 'c1', booking_mode: 'now',   dispatch_mode: 'auto', status: 'CONFIRMED'},
]);

describe('B-405 pair: dispatching the parked reservation must not collide', () => {
  it('SHIPPED predicate — start() on the `later` row succeeds beside a live `now` booking', async () => {
    const rows = b405Rows();
    const {db} = fakeDb(rows, shipped);
    await expect(svc(db).start('later-1')).resolves.toBeUndefined();
    expect(rows.find(r => r.id === 'later-1')!.status).toBe('DISPATCHING');
    expect(rows.find(r => r.id === 'now-1')!.status).toBe('CONFIRMED');
  });

  it('REJECTED predicate — the same call raises 23505, which is the destroyed-booking path', async () => {
    // Documents WHY the shipped predicate is narrower. If this ever stops
    // throwing, the read-guard mirror was safe after all and this comment is wrong.
    const rows = b405Rows();
    const {db} = fakeDb(rows, readGuardMirror);
    await expect(svc(db).start('later-1')).rejects.toMatchObject({
      code: '23505', constraint: ONE_ACTIVE_BOOKING_INDEX,
    });
    // start() has no handler, so the row never leaves OPS_APPROVED — the sweep
    // retries every minute and sweepStaleStarts eventually cancels + refunds it.
    expect(rows.find(r => r.id === 'later-1')!.status).toBe('OPS_APPROVED');
  });

  it('SHIPPED predicate — a LEGACY `later` row on ops approval is equally safe', async () => {
    const rows: Row[] = [
      {id: 'later-legacy', client_id: 'c1', booking_mode: 'later', dispatch_mode: null, status: 'OPS_APPROVED'},
      {id: 'now-1', client_id: 'c1', booking_mode: 'now', dispatch_mode: 'auto', status: 'LIVE'},
    ];
    const {db} = fakeDb(rows, shipped);
    // (dispatch_mode null => start() refuses as not_an_auto_booking, but the
    // point is that the INDEX no longer objects: the row's membership is
    // unchanged by any status it can reach.)
    expect(shipped({...rows[0]!, status: 'DISPATCHING'})).toBe(false);
    expect(readGuardMirror({...rows[0]!, status: 'DISPATCHING'})).toBe(true);
  });

  it('the shipped predicate is CLOSED under every status transition (membership only ever LOST)', () => {
    const statuses = ['DRAFT', 'PENDING_OPS', 'OPS_APPROVED', 'PAYMENT_PENDING', 'DISPATCHING',
      'CONFIRMED', 'LIVE', 'COMPLETED', 'CANCELLED', 'NO_PROVIDER', 'AGENCY_NO_SHOW'];
    for (const mode of ['now', 'later'] as const) {
      for (const dm of ['auto', null]) {
        const members = statuses.filter(s => shipped({id: 'x', client_id: 'c', booking_mode: mode, dispatch_mode: dm, status: s}));
        // For 'later' the membership set is EMPTY, for 'now' it is exactly the
        // non-terminal statuses. Either way `booking_mode` is immutable, so a row
        // can never transition INTO the index from outside it.
        expect(members).toEqual(mode === 'now' ? statuses.filter(s => !TERMINAL.has(s)) : []);
      }
    }
  });

  it('still catches the race it exists for: two concurrent active `now` rows', () => {
    const rows: Row[] = [
      {id: 'a', client_id: 'c1', booking_mode: 'now', dispatch_mode: 'auto', status: 'DISPATCHING'},
      {id: 'b', client_id: 'c1', booking_mode: 'now', dispatch_mode: 'auto', status: 'PENDING_OPS'},
    ];
    const seen = new Set<string>();
    let dupes = 0;
    for (const r of rows.filter(shipped)) {
      if (seen.has(r.client_id)) {dupes++;}
      seen.add(r.client_id);
    }
    expect(dupes).toBe(1);
  });
});
