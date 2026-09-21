/**
 * B-859 — "if I give a shift to a user for any day, there should be an option
 * to ping each user; if an admin or higher pings a person they should see their
 * location while on shift. Other than shift, if pinged, don't share location."
 *
 * THE PREDICATE IS "CLOCKED IN", and it is asked TWICE (plan §10 A6):
 *
 *   - at REQUEST time  → no OPEN cpo_shift_sessions row for THAT shift → 409
 *                        not_on_shift. Never `myTodayShift`: its window has a
 *                        12-hour forward lead, so that predicate would make a
 *                        worker answerable eleven hours before their shift.
 *                        Never "inside the window but not clocked in" either —
 *                        that is a fix from someone who is not working.
 *   - at ANSWER time   → re-checked. A worker who clocked out in between is
 *                        recorded 'refused' with reason 'off_shift' and NO
 *                        coordinates are stored. The DEVICE never decides this
 *                        (a worker on two shifts would self-check one org).
 *
 * ⚠️ The db is mocked and answers regardless of the query, so nothing
 * behavioural here can see a WHERE clause. Every predicate is asserted on the
 * SQL text, comment-stripped line-wise.
 */
import {ConflictException, ForbiddenException, HttpException, NotFoundException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {AttendanceService, reportedPingStatus, PING_EXPIRY_MS} from './attendance.service';
import {AttendanceController} from './attendance.controller';
import type {AttendancePhotoService} from './attendance-photo.service';
import type {BookingPushBridge} from '../ops/booking-push-bridge.service';
import type {DatabaseService} from '../database/database.service';
import type {OrgAuditService} from '../org/org-audit.service';
import type {NotificationsService} from '../notifications/notifications.service';
import type {OrgManagerContext} from '../org/org-manager.guard';
import type {AccessClaims} from '../auth/jwt.service';

/** Own-line comments first, then TRAILING inline `-- …` tails: prose on a live
 *  SQL line is not code, and reading it as code is how a banned token
 *  "appears" in a query that never contained it. */
const clean = (sql: unknown): string =>
  String(sql)
    .split(/\r?\n/)
    .filter(l => !l.trim().startsWith('--'))
    .map(l => l.replace(/\s--.*$/, ''))
    .join('\n');

interface Wiring {
  /** The manager guard read: null → the shift is not in this org/branch. */
  shift?: Record<string, unknown> | null;
  /** The "is this worker clocked in on THIS shift" read. */
  openSession?: Record<string, unknown> | null;
  /** pending_id / day_count / last_by_manager, in one round trip. */
  limits?: Record<string, unknown> | null;
  /** The ping row + its shift org, for the worker-side routes. */
  ping?: Record<string, unknown> | null;
  /** Make the status-gated UPDATE return 0 rows (a concurrent replay won). */
  updateLost?: boolean;
  /** Make the INSERT raise the partial-unique violation. */
  insertConflict?: boolean;
}

function mk(wiring: Wiring = {}) {
  const calls: Array<{sql: string; params: unknown[]}> = [];
  const answer = async (sql: unknown, params: unknown[] = []) => {
    const s = String(sql);
    calls.push({sql: s, params});
    if (/INSERT INTO cpo_shift_pings/.test(s)) {
      if (wiring.insertConflict) {
        // The shape node-postgres raises for a unique-index violation.
        throw Object.assign(new Error('duplicate key value violates unique constraint'),
          {code: '23505', constraint: 'cpo_shift_pings_one_pending'});
      }
      return {
        id: 'ping-1', status: 'pending', requested_at: '2026-09-12T10:00:00.000Z',
        answered_at: null, lat: null, lng: null, accuracy_m: null, refuse_reason: null,
      };
    }
    if (/UPDATE cpo_shift_pings/.test(s) && /RETURNING/.test(s)) {
      if (wiring.updateLost) {return null;}
      return {
        id: 'ping-1',
        status: /'answered'/.test(s) ? 'answered' : 'refused',
        requested_at: '2026-09-12T10:00:00.000Z',
        answered_at: '2026-09-12T10:00:12.000Z',
        lat: null, lng: null, accuracy_m: null,
        refuse_reason: null,
      };
    }
    if (/FROM cpo_shift_pings p/.test(s) && /JOIN cpo_shifts sh/.test(s)) {
      return wiring.ping === undefined ? null : wiring.ping;
    }
    if (/AS pending_id/.test(s)) {
      return wiring.limits === undefined
        ? {pending_id: null, day_count: 0, last_by_manager: null}
        : wiring.limits;
    }
    if (/FROM cpo_shift_sessions/.test(s)) {
      return wiring.openSession === undefined ? null : wiring.openSession;
    }
    if (/FROM cpo_shifts/.test(s)) {
      return wiring.shift === undefined
        ? {id: 'sh1', org_user_id: 'org-9', department: null}
        : wiring.shift;
    }
    return null;
  };
  const db = {
    q: jest.fn(async (sql: unknown, params: unknown[] = []) => {
      calls.push({sql: String(sql), params});
      return [] as Array<Record<string, unknown>>;
    }),
    qOne: jest.fn(answer),
    withTransaction: jest.fn(async (fn: (t: unknown) => unknown) => fn({q: jest.fn(), qOne: jest.fn()})),
  };
  const audit = {log: jest.fn()};
  const push = {attendancePing: jest.fn().mockResolvedValue(undefined)};
  const svc = new AttendanceService(
    db as unknown as DatabaseService,
    {get: jest.fn(() => undefined)} as unknown as ConfigService,
    audit as unknown as OrgAuditService,
    {record: jest.fn()} as unknown as NotificationsService,
    undefined, undefined,
    push as unknown as BookingPushBridge,
  );
  const sqlMatching = (re: RegExp) => {
    const hit = calls.find(c => re.test(c.sql));
    return hit ? {sql: clean(hit.sql), params: hit.params} : null;
  };
  return {svc, db, audit, push, calls, sqlMatching};
}

describe('A6 — requestPing: the predicate matrix', () => {
  it('a worker with an OPEN session on THIS shift can be pinged, and is woken with ids only', async () => {
    const {svc, audit, push, sqlMatching} = mk({openSession: {id: 'ses-1'}});
    const out = await svc.requestPing('org-9', 'sh1', 'cpo-1', 'mgr-1', null);
    // The SAME field set the projection's `last_ping` slot carries, so the
    // manager's sheet drops the answer straight in with no second shape.
    expect(out).toEqual({
      id: 'ping-1', status: 'pending', requested_at: '2026-09-12T10:00:00.000Z',
      answered_at: null, lat: null, lng: null, accuracy_m: null, refuse_reason: null,
    });
    expect(push.attendancePing).toHaveBeenCalledWith('cpo-1', 'ping-1', 'sh1');
    // The audit row must name WHO was asked, not only which shift: without
    // cpo_user_id the trail says "someone on this shift was pinged" and cannot
    // answer the one question a review of it asks.
    expect(audit.log).toHaveBeenCalledWith('org-9', 'mgr-1', 'attendance.ping.request',
      expect.objectContaining({
        targetKind: 'shift_ping', targetId: 'ping-1',
        metadata: {shift_id: 'sh1', cpo_user_id: 'cpo-1'},
      }));
    const insert = sqlMatching(/INSERT INTO cpo_shift_pings/);
    expect(insert!.params).toEqual(['sh1', 'cpo-1', 'mgr-1']);
  });

  it('S1 — the created row answers the FULL ping shape, `mocked` included, and inserts none', async () => {
    // One shape for every verb (see ShiftPingResult). A brand-new ping has no
    // answer yet, so the flag is only ever a NULL the schema CHECK requires —
    // writing one at INSERT time would be a claim nobody made.
    const {svc, sqlMatching} = mk({openSession: {id: 'ses-1'}});
    await svc.requestPing('org-9', 'sh1', 'cpo-1', 'mgr-1', null);
    const insert = sqlMatching(/INSERT INTO cpo_shift_pings/)!;
    const at = insert.sql.indexOf('RETURNING');
    expect(insert.sql.slice(at)).toMatch(/\bmocked\b/);
    expect(insert.sql.slice(0, at)).not.toMatch(/\bmocked\b/);
  });

  it('a lost race on the partial unique index reads as ping_pending, never a 500', async () => {
    /**
     * The pre-check and the INSERT are two statements. Two managers tapping in
     * the same tick both pass the check and the index refuses the second — a
     * raw 23505 would surface as an "Unexpected error" on a button whose real
     * answer is "someone already asked". The repo pattern (family.service.ts)
     * maps the code at the write.
     */
    const {svc, push} = mk({openSession: {id: 'ses-1'}, insertConflict: true});
    await expect(svc.requestPing('org-9', 'sh1', 'cpo-1', 'mgr-1', null))
      .rejects.toThrow('ping_pending');
    await expect(svc.requestPing('org-9', 'sh1', 'cpo-1', 'mgr-1', null))
      .rejects.toBeInstanceOf(ConflictException);
    expect(push.attendancePing).not.toHaveBeenCalled();
  });

  it('a NON-unique db error is NOT swallowed as ping_pending', async () => {
    // Mapping every throw to a 409 would hide a real outage behind a message
    // that tells the manager to wait for an answer that will never come.
    const {svc, db} = mk({openSession: {id: 'ses-1'}});
    const real = db.qOne.getMockImplementation()!;
    db.qOne.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      if (/INSERT INTO cpo_shift_pings/.test(String(sql))) {
        throw Object.assign(new Error('connection terminated'), {code: '57P01'});
      }
      return real(sql, params ?? []);
    });
    await expect(svc.requestPing('org-9', 'sh1', 'cpo-1', 'mgr-1', null))
      .rejects.toThrow('connection terminated');
  });

  it('ASSIGNED but never clocked in → 409 not_on_shift, nothing written, nobody woken', async () => {
    const {svc, push, sqlMatching} = mk({openSession: null});
    await expect(svc.requestPing('org-9', 'sh1', 'cpo-1', 'mgr-1', null))
      .rejects.toThrow('not_on_shift');
    expect(sqlMatching(/INSERT INTO cpo_shift_pings/)).toBeNull();
    expect(push.attendancePing).not.toHaveBeenCalled();
  });

  it('inside the shift WINDOW but with no open session → still not_on_shift', async () => {
    // The same wiring as above stated as its own case on purpose: the window is
    // not consulted at all, so "the shift starts in ten minutes" is refused for
    // the same reason "the shift ended an hour ago" is.
    const {svc} = mk({openSession: null});
    await expect(svc.requestPing('org-9', 'sh1', 'cpo-1', 'mgr-1', null))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('the predicate is an OPEN session for THAT shift — never myTodayShift', async () => {
    const {svc, sqlMatching} = mk({openSession: {id: 'ses-1'}});
    await svc.requestPing('org-9', 'sh1', 'cpo-1', 'mgr-1', null);
    const probe = sqlMatching(/FROM cpo_shift_sessions/);
    expect(probe).not.toBeNull();
    expect(probe!.sql).toMatch(/shift_id = \$1/);
    expect(probe!.sql).toMatch(/cpo_user_id = \$2/);
    expect(probe!.sql).toMatch(/status = 'open'/);
    expect(probe!.params).toEqual(['sh1', 'cpo-1']);
    // The 12-hour forward lead that makes myTodayShift the WRONG predicate.
    expect(probe!.sql).not.toMatch(/INTERVAL '12 hours'/);
    expect(probe!.sql).not.toMatch(/cpo_shift_assignments/);
  });

  it('keeps the manager guard: a foreign-org/branch shift 404s before any probe', async () => {
    const {svc, sqlMatching} = mk({shift: null});
    await expect(svc.requestPing('org-OTHER', 'sh1', 'cpo-1', 'mgr-1', 'Ops'))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(sqlMatching(/FROM cpo_shift_sessions/)).toBeNull();
    const guard = sqlMatching(/SELECT id, org_user_id, department/);
    expect(guard!.sql).toMatch(/\$3::text IS NULL OR department = \$3/);
    expect(guard!.params).toEqual(['sh1', 'org-OTHER', 'Ops']);
  });
});

describe('A7 — requestPing: one pending, the expiry sweep, and the rate limits', () => {
  it('a live pending ask → 409 ping_pending', async () => {
    const {svc, push} = mk({openSession: {id: 'ses-1'}, limits: {pending_id: 'ping-0', day_count: 1, last_by_manager: null}});
    await expect(svc.requestPing('org-9', 'sh1', 'cpo-1', 'mgr-1', null))
      .rejects.toThrow('ping_pending');
    expect(push.attendancePing).not.toHaveBeenCalled();
  });

  it('stale pendings are SWEPT to expired before the pending check (the unique index must not wedge)', async () => {
    /**
     * The partial unique index is on `status = 'pending'`, and the status is
     * swept lazily. Without this UPDATE a single unanswered ping would block
     * that (shift, worker) pair from ever being pinged again — a 10-minute
     * feature turned into a permanent lockout by a killed app.
     */
    const {svc, calls, sqlMatching} = mk({openSession: {id: 'ses-1'}});
    await svc.requestPing('org-9', 'sh1', 'cpo-1', 'mgr-1', null);
    const sweep = sqlMatching(/UPDATE cpo_shift_pings\s+SET status = 'expired'/);
    expect(sweep).not.toBeNull();
    expect(sweep!.sql).toMatch(/status = 'pending'/);
    expect(sweep!.sql).toMatch(/requested_at <= NOW\(\) - INTERVAL '10 minutes'/);
    expect(sweep!.params).toEqual(['sh1', 'cpo-1']);
    // …and it must run BEFORE the read that decides ping_pending, or the sweep
    // is decorative.
    const sweepAt = calls.findIndex(c => /SET status = 'expired'/.test(c.sql));
    const limitsAt = calls.findIndex(c => /AS pending_id/.test(c.sql));
    expect(sweepAt).toBeGreaterThan(-1);
    expect(sweepAt).toBeLessThan(limitsAt);
  });

  it('the per-(shift, worker) daily cap is 12 → 429 ping_rate_limited', async () => {
    const {svc} = mk({openSession: {id: 'ses-1'}, limits: {pending_id: null, day_count: 12, last_by_manager: null}});
    const err = await svc.requestPing('org-9', 'sh1', 'cpo-1', 'mgr-1', null).catch(e => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(String((err as HttpException).getResponse())).toContain('ping_rate_limited');
  });

  it('eleven pings today is still allowed — the cap is a ceiling, not a fence', async () => {
    const {svc} = mk({openSession: {id: 'ses-1'}, limits: {pending_id: null, day_count: 11, last_by_manager: null}});
    await expect(svc.requestPing('org-9', 'sh1', 'cpo-1', 'mgr-1', null)).resolves.toBeDefined();
  });

  it('the same manager re-pinging inside 60 s → 429 ping_rate_limited', async () => {
    const {svc} = mk({
      openSession: {id: 'ses-1'},
      limits: {pending_id: null, day_count: 1, last_by_manager: '2026-09-12T10:00:00.000Z'},
    });
    const err = await svc.requestPing('org-9', 'sh1', 'cpo-1', 'mgr-1', null).catch(e => e);
    expect((err as HttpException).getStatus()).toBe(429);
  });

  it('the three limits ride ONE round trip, each bounded, and the floor is per MANAGER', async () => {
    const {svc, sqlMatching} = mk({openSession: {id: 'ses-1'}});
    await svc.requestPing('org-9', 'sh1', 'cpo-1', 'mgr-1', null);
    const limits = sqlMatching(/AS pending_id/);
    expect(limits).not.toBeNull();
    expect(limits!.sql).toMatch(/AS day_count/);
    expect(limits!.sql).toMatch(/AS last_by_manager/);
    // The daily cap counts this (shift, worker); the floor counts this
    // (manager, worker). Keying the floor on the shift instead would let two
    // managers of the same shift ding the worker twice a second.
    expect(limits!.sql).toMatch(/requested_by = \$3/);
    expect(limits!.params).toEqual(['sh1', 'cpo-1', 'mgr-1']);
  });
});

describe('A6 — answerPing re-checks the session; a clocked-out worker shares NOTHING', () => {
  const livePing = {
    id: 'ping-1', shift_id: 'sh1', cpo_user_id: 'cpo-1', status: 'pending',
    requested_at: new Date().toISOString(), org_user_id: 'org-9',
  };

  it('an on-shift answer stores the fix and writes its own audit row (ids only)', async () => {
    const {svc, sqlMatching, audit} = mk({ping: livePing, openSession: {id: 'ses-1'}});
    const out = await svc.answerPing('cpo-1', 'ping-1', {lat: 25.21, lng: 55.31, accuracy_m: 18});
    expect(out.status).toBe('answered');
    const upd = sqlMatching(/UPDATE cpo_shift_pings\s+SET status = 'answered'/);
    // The trailing null is `mocked`: this caller sent no flag (see S1 below).
    expect(upd!.params).toEqual(['ping-1', 25.21, 55.31, 18, null]);
    // The capture is the sensitive half of this feature; org_audit_log is where
    // every other sensitive provider action lands. Ids and enums ONLY — a
    // coordinate in `metadata` would defeat the rule the whole table keeps.
    expect(audit.log).toHaveBeenCalledWith('org-9', 'cpo-1', 'attendance.ping.answered',
      expect.objectContaining({targetKind: 'shift_ping', targetId: 'ping-1'}));
    const meta = JSON.stringify(audit.log.mock.calls.at(-1)![3]);
    expect(meta).not.toContain('25.21');
    expect(meta).not.toContain('55.31');
    expect(meta).not.toMatch(/lat|lng|accuracy/);
  });

  it('a huge accuracy is CLAMPED, never rejected — a cell-tower fix is still an answer', async () => {
    /**
     * `@Max(10_000)` on the DTO turned an indoor/cell-tower fix into a 400 the
     * responder could only report as silence, and the manager then read "No
     * answer" for a worker whose device answered honestly. The bound belongs on
     * the WRITE (a sane column value), not on the door.
     */
    const {svc, sqlMatching} = mk({ping: livePing, openSession: {id: 'ses-1'}});
    await svc.answerPing('cpo-1', 'ping-1', {lat: 25.21, lng: 55.31, accuracy_m: 4_000_000});
    expect(sqlMatching(/SET status = 'answered'/)!.params)
      .toEqual(['ping-1', 25.21, 55.31, 100_000, null]);
  });

  it('an ordinary accuracy passes through untouched', async () => {
    const {svc, sqlMatching} = mk({ping: livePing, openSession: {id: 'ses-1'}});
    await svc.answerPing('cpo-1', 'ping-1', {lat: 1, lng: 2, accuracy_m: 37.5});
    expect(sqlMatching(/SET status = 'answered'/)!.params[3]).toBe(37.5);
  });

  it('S1 — the answered UPDATE stores the device MOCKED flag', async () => {
    /**
     * Location integrity is the entire purpose of this feature: "if an admin
     * or higher pings a person they should see their location while on shift".
     * A mock-location app makes that coordinate a number the device chose, and
     * the device already knows — `onDutyHeartbeat` ships `is_mocked` on the
     * live lane, and `agent.service.ts` grades it. The ping answer is the
     * OTHER place a coordinate enters this system, and it was the only one
     * that dropped the flag on the floor: the manager's pin then rendered a
     * fabricated fix exactly like a real one.
     */
    const {svc, sqlMatching} = mk({ping: livePing, openSession: {id: 'ses-1'}});
    await svc.answerPing('cpo-1', 'ping-1', {lat: 25.21, lng: 55.31, accuracy_m: 18, mocked: true});
    const upd = sqlMatching(/SET status = 'answered'/)!;
    expect(upd.sql).toMatch(/\bmocked\s*=\s*\$5\b/);
    expect(upd.params).toEqual(['ping-1', 25.21, 55.31, 18, true]);
    // Every verb answers ONE shape (the projection's `last_ping` slot), so the
    // column has to come back too or the sheet gets a hole where a warning
    // belongs.
    expect(upd.sql.slice(upd.sql.indexOf('RETURNING'))).toMatch(/\bmocked\b/);
  });

  it('S1 — an old client that sends no flag stores NULL, never a `false` it never measured', async () => {
    /**
     * NULL and false are DIFFERENT facts and the column comment says so. An
     * APK built before this field existed reports nothing; writing `false` for
     * it would tell a manager the device checked and found a real fix — the
     * one thing this column must never say on its own.
     */
    const {svc, sqlMatching} = mk({ping: livePing, openSession: {id: 'ses-1'}});
    await svc.answerPing('cpo-1', 'ping-1', {lat: 1, lng: 2});
    expect(sqlMatching(/SET status = 'answered'/)!.params[4]).toBeNull();
  });

  it('S1 — a device that measured "not mocked" stores false, not NULL', async () => {
    const {svc, sqlMatching} = mk({ping: livePing, openSession: {id: 'ses-1'}});
    await svc.answerPing('cpo-1', 'ping-1', {lat: 1, lng: 2, mocked: false});
    expect(sqlMatching(/SET status = 'answered'/)!.params[4]).toBe(false);
  });

  it('a replay that loses the race is a 409, not a silent second answer (answerPing)', async () => {
    /**
     * `loadOwnPing` reads, then the UPDATE writes — two statements. A retried
     * request (the responder's own retry, a double tap, a redelivered wake)
     * can pass the read while the first answer is committing. The UPDATE's
     * `AND status = 'pending'` is the ONLY thing that makes the second one a
     * no-op, so it is asserted in the SQL text AND exercised as a 0-row result.
     */
    const {svc, sqlMatching} = mk({ping: livePing, openSession: {id: 'ses-1'}, updateLost: true});
    await expect(svc.answerPing('cpo-1', 'ping-1', {lat: 1, lng: 2}))
      .rejects.toThrow('ping_not_pending');
    expect(sqlMatching(/SET status = 'answered'/)!.sql).toMatch(/WHERE id = \$1 AND status = 'pending'/);
  });

  it('a replay that loses the race is a 409 on the REFUSAL path too (closePing)', async () => {
    const {svc, sqlMatching} = mk({ping: livePing, updateLost: true});
    await expect(svc.refusePing('cpo-1', 'ping-1', 'no_fix'))
      .rejects.toBeInstanceOf(ConflictException);
    expect(sqlMatching(/SET status = 'refused'/)!.sql).toMatch(/WHERE id = \$1 AND status = 'pending'/);
  });

  it('answering AFTER clock-out is recorded refused/off_shift with NO coordinates', async () => {
    const {svc, sqlMatching} = mk({ping: livePing, openSession: null});
    const out = await svc.answerPing('cpo-1', 'ping-1', {lat: 25.21, lng: 55.31, accuracy_m: 18});
    expect(out).toEqual(expect.objectContaining({status: 'refused'}));
    const upd = sqlMatching(/UPDATE cpo_shift_pings\s+SET status = 'refused'/);
    expect(upd).not.toBeNull();
    // The whole founder rule in one assertion: "other than shift, if pinged,
    // don't share location". Neither the columns nor the params may carry it.
    expect(upd!.sql).not.toMatch(/\blat\s*=/);
    expect(upd!.sql).not.toMatch(/\blng\s*=/);
    expect(upd!.params).toEqual(['ping-1', 'off_shift']);
    expect(JSON.stringify(upd!.params)).not.toContain('25.21');
    // And the verdict is the SERVER's — the device is never asked.
    const probe = sqlMatching(/FROM cpo_shift_sessions/);
    expect(probe!.params).toEqual(['sh1', 'cpo-1']);
  });

  it('S1 — the off-shift refusal writes no `mocked` either, and still answers the full shape', async () => {
    /**
     * A refusal records that the device was ASKED and said nothing usable; it
     * records no claim the device made about itself. The SET list is the
     * assertion — `mocked` rides the RETURNING (one shape for every verb) but
     * may never be WRITTEN here, and the schema's answered-only CHECK is the
     * floor under that.
     */
    const {svc, sqlMatching} = mk({ping: livePing, openSession: null});
    await svc.answerPing('cpo-1', 'ping-1', {lat: 25.21, lng: 55.31, accuracy_m: 18, mocked: true});
    const upd = sqlMatching(/UPDATE cpo_shift_pings\s+SET status = 'refused'/)!;
    const set = upd.sql.slice(0, upd.sql.indexOf('RETURNING'));
    expect(set).not.toMatch(/\bmocked\b/);
    expect(upd.params).toEqual(['ping-1', 'off_shift']);
    expect(upd.sql.slice(upd.sql.indexOf('RETURNING'))).toMatch(/\bmocked\b/);
  });

  it('the off-shift refusal is audited as a REFUSAL, naming the server reason', async () => {
    const {svc, audit} = mk({ping: livePing, openSession: null});
    await svc.answerPing('cpo-1', 'ping-1', {lat: 25.21, lng: 55.31});
    expect(audit.log).toHaveBeenCalledWith('org-9', 'cpo-1', 'attendance.ping.refused',
      expect.objectContaining({
        targetKind: 'shift_ping', targetId: 'ping-1',
        metadata: {shift_id: 'sh1', reason: 'off_shift'},
      }));
    expect(audit.log).not.toHaveBeenCalledWith('org-9', 'cpo-1', 'attendance.ping.answered',
      expect.anything());
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('25.21');
  });

  it('a worker may only answer their OWN ping → 403', async () => {
    const {svc, sqlMatching} = mk({ping: livePing, openSession: {id: 'ses-1'}});
    await expect(svc.answerPing('cpo-INTRUDER', 'ping-1', {lat: 1, lng: 2}))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(sqlMatching(/UPDATE cpo_shift_pings\s+SET status/)).toBeNull();
  });

  it('an unknown ping id → 404', async () => {
    const {svc} = mk({ping: null});
    await expect(svc.answerPing('cpo-1', 'ping-x', {lat: 1, lng: 2}))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('a ping older than 10 minutes is expired — the answer is refused and nothing is stored', async () => {
    const {svc, sqlMatching} = mk({
      ping: {...livePing, requested_at: new Date(Date.now() - PING_EXPIRY_MS - 1000).toISOString()},
      openSession: {id: 'ses-1'},
    });
    await expect(svc.answerPing('cpo-1', 'ping-1', {lat: 25.21, lng: 55.31}))
      .rejects.toThrow('ping_expired');
    expect(sqlMatching(/SET status = 'answered'/)).toBeNull();
  });

  it('an already-answered ping cannot be answered twice', async () => {
    const {svc} = mk({ping: {...livePing, status: 'answered'}, openSession: {id: 'ses-1'}});
    await expect(svc.answerPing('cpo-1', 'ping-1', {lat: 1, lng: 2}))
      .rejects.toThrow('ping_not_pending');
  });

  it('refusePing records the device-side reason and never a coordinate', async () => {
    const {svc, sqlMatching} = mk({ping: livePing});
    const out = await svc.refusePing('cpo-1', 'ping-1', 'no_permission');
    expect(out.status).toBe('refused');
    const upd = sqlMatching(/UPDATE cpo_shift_pings\s+SET status = 'refused'/);
    expect(upd!.params).toEqual(['ping-1', 'no_permission']);
    expect(upd!.sql).not.toMatch(/\blat\s*=/);
    // A refusal is the worker's own answer, so it does NOT probe the session.
    expect(sqlMatching(/FROM cpo_shift_sessions/)).toBeNull();
  });

  it('a device refusal is audited with its enum reason', async () => {
    const {svc, audit} = mk({ping: livePing});
    await svc.refusePing('cpo-1', 'ping-1', 'declined');
    expect(audit.log).toHaveBeenCalledWith('org-9', 'cpo-1', 'attendance.ping.refused',
      expect.objectContaining({metadata: {shift_id: 'sh1', reason: 'declined'}}));
  });

  it('refusePing is owner-gated too', async () => {
    const {svc} = mk({ping: livePing});
    await expect(svc.refusePing('cpo-INTRUDER', 'ping-1', 'declined'))
      .rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('A7 — reportedPingStatus is the ONE expiry rule', () => {
  const t0 = Date.parse('2026-09-12T10:00:00.000Z');

  it('pending inside the window stays pending', () => {
    expect(reportedPingStatus('pending', new Date(t0).toISOString(), t0 + 60_000)).toBe('pending');
  });

  it('pending past 10 minutes reads expired without a cron ever running', () => {
    expect(reportedPingStatus('pending', new Date(t0).toISOString(), t0 + PING_EXPIRY_MS + 1)).toBe('expired');
  });

  it('a decided row is reported as decided, whatever the clock says', () => {
    expect(reportedPingStatus('answered', new Date(t0).toISOString(), t0 + 86_400_000)).toBe('answered');
    expect(reportedPingStatus('refused', new Date(t0).toISOString(), t0 + 86_400_000)).toBe('refused');
  });

  it('a NULL/unreadable timestamp is not silently treated as fresh', () => {
    expect(reportedPingStatus('pending', null, t0)).toBe('expired');
  });

  it('the shift-detail projection maps last_ping through it', async () => {
    // Otherwise the manager's sheet offers "waiting…" forever on a ping that
    // the answer route would already refuse — two screens disagreeing about
    // one row, which is exactly what the shared rule exists to prevent.
    const src = clean(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('node:fs').readFileSync(require('node:path').join(__dirname, 'attendance.service.ts'), 'utf8'),
    );
    const at = src.indexOf('private static pingOf(');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, src.indexOf('\n  }', at))).toContain('reportedPingStatus(');
  });
});

describe('the WIRE envelopes — the seam the mobile client is written against', () => {
  /**
   * `{ping}` on all three verbs and `{assignments, more}` / `{pings}` on the
   * two lists. The client (api.ts `pingAssignee` / `answerPing` / `refusePing`
   * → `{ping: ShiftAssigneePingDto}`) destructures these by name, so a flat
   * body renders an empty card with no error anywhere — the kind of seam break
   * that only a device pass catches.
   */
  function ctl() {
    const attendance = {
      requestPing: jest.fn().mockResolvedValue({id: 'ping-1'}),
      answerPing:  jest.fn().mockResolvedValue({id: 'ping-1'}),
      refusePing:  jest.fn().mockResolvedValue({id: 'ping-1'}),
      myPings:     jest.fn().mockResolvedValue({pings: []}),
    };
    const controller = new AttendanceController(
      attendance as unknown as AttendanceService,
      {} as unknown as AttendancePhotoService,
    );
    return {controller, attendance};
  }

  const MGR = {org_user_id: 'org-9', user_id: 'mgr-1', department: null} as OrgManagerContext;
  const PING_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';

  it('pingAssignee answers {ping}', async () => {
    const {controller, attendance} = ctl();
    await expect(controller.pingAssignee('sh1', 'cpo-1', MGR)).resolves.toEqual({ping: {id: 'ping-1'}});
    expect(attendance.requestPing).toHaveBeenCalledWith('org-9', 'sh1', 'cpo-1', 'mgr-1', null);
  });

  it('answerPing answers {ping} and forwards the fix fields — the mocked flag included', async () => {
    // S1 — the handler enumerates what it forwards, so a field added to the
    // DTO and nowhere else is silently dropped at the door. That is exactly
    // what would have happened to `mocked`.
    const {controller, attendance} = ctl();
    await expect(controller.answerPing(
      PING_ID, {lat: 1, lng: 2, accuracy_m: 3, mocked: true}, {sub: 'cpo-1'} as AccessClaims,
    )).resolves.toEqual({ping: {id: 'ping-1'}});
    expect(attendance.answerPing).toHaveBeenCalledWith(
      'cpo-1', PING_ID, {lat: 1, lng: 2, accuracy_m: 3, mocked: true});
  });

  it('an old client that sends no flag is forwarded as undefined, not as false', async () => {
    const {controller, attendance} = ctl();
    await controller.answerPing(PING_ID, {lat: 1, lng: 2}, {sub: 'cpo-1'} as AccessClaims);
    expect((attendance.answerPing.mock.calls[0][2] as {mocked?: boolean}).mocked).toBeUndefined();
  });

  it('refusePing answers {ping} and passes the validated reason through', async () => {
    const {controller, attendance} = ctl();
    await expect(controller.refusePing(
      PING_ID, {reason: 'no_fix'}, {sub: 'cpo-1'} as AccessClaims,
    )).resolves.toEqual({ping: {id: 'ping-1'}});
    expect(attendance.refusePing).toHaveBeenCalledWith('cpo-1', PING_ID, 'no_fix');
  });

  it("the worker routes are scoped to the CALLER's own sub, never a body/param id", async () => {
    // The only thing standing between "answer my ping" and "answer anyone's"
    // is that these pass user.sub. The service re-checks ownership too, but a
    // controller that took a user id from the request would make that check
    // the only gate — and it has been the second gate everywhere else here.
    const {controller, attendance} = ctl();
    await controller.answerPing(PING_ID, {lat: 1, lng: 2}, {sub: 'cpo-1'} as AccessClaims);
    await controller.refusePing(PING_ID, {reason: 'declined'}, {sub: 'cpo-1'} as AccessClaims);
    expect(attendance.answerPing.mock.calls[0][0]).toBe('cpo-1');
    expect(attendance.refusePing.mock.calls[0][0]).toBe('cpo-1');
  });

  describe('S2 — /pings/mine threads the workspace header, exactly like my-shift/today', () => {
    /**
     * B-856 scoped the Departmental shell to ONE workspace: inside Acme, a
     * member of Acme and Meridian must see Acme's attendance. `my-shift/today`
     * learned the header there; this route did not, so the "Location requests"
     * card inside Acme listed Meridian's managers asking Meridian questions —
     * the other company's names, on a screen that is supposed to be one
     * workspace.
     *
     * The header NARROWS a list of the caller's OWN rows, so it needs no
     * `pickOrgContext`: it can only ever return fewer of their own pings.
     */
    const ORG = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';

    it('the header becomes the scope param', async () => {
      const {controller, attendance} = ctl();
      await controller.myPings({sub: 'cpo-1'} as AccessClaims, {headers: {'x-org-context': ORG}});
      expect(attendance.myPings).toHaveBeenCalledWith('cpo-1', ORG);
    });

    it('no header → null, and the officer shell keeps its cross-org trace', async () => {
      // The officer shell passes {crossOrg: true} on purpose, and an old APK
      // sends nothing at all. A sticky context must never blank a worker's
      // record of having been asked for their location.
      const {controller, attendance} = ctl();
      await controller.myPings({sub: 'cpo-1'} as AccessClaims, {headers: {}});
      expect(attendance.myPings).toHaveBeenCalledWith('cpo-1', null);
    });

    it('a malformed header is ignored — it never reaches a uuid column', async () => {
      const {controller, attendance} = ctl();
      await controller.myPings({sub: 'cpo-1'} as AccessClaims,
        {headers: {'x-org-context': '------------------------------------'}});
      expect(attendance.myPings).toHaveBeenCalledWith('cpo-1', null);
    });
  });
});

describe('A7 — GET /attendance/pings/mine is the worker-visible trace', () => {
  it('lists the worker’s own pings with the requester’s name and the reported status', async () => {
    const {svc, db} = mk();
    db.q.mockResolvedValueOnce([{
      id: 'ping-1', shift_id: 'sh1', status: 'pending',
      requested_at: new Date(Date.now() - 20 * 60_000).toISOString(),
      answered_at: null, refuse_reason: null, requested_by_name: 'Dana Okoro',
    }]);
    const out = await svc.myPings('cpo-1');
    expect(out.pings[0]).toEqual(expect.objectContaining({
      id: 'ping-1', shift_id: 'sh1', requested_by_name: 'Dana Okoro',
      // Same lazy rule as everywhere else: a 20-minute-old "pending" is dead.
      status: 'expired',
    }));
    const call = db.q.mock.calls.find(c => /FROM cpo_shift_pings/.test(String(c[0])));
    expect((call![1] as unknown[])[0]).toBe('cpo-1');
    expect(clean(call![0])).toMatch(/p\.cpo_user_id = \$1/);
    expect(clean(call![0])).toMatch(/ORDER BY p\.requested_at DESC/);
  });

  it('the worker trace does NOT read back coordinates', async () => {
    /**
     * The list answers "who asked, when, and what came of it". The worker was
     * there — telling them where they were adds nothing and puts the one
     * sensitive column of this table on a route that exists for transparency.
     * Selecting it "just in case" is how it ends up on a screen.
     */
    const {svc, db} = mk();
    await svc.myPings('cpo-1');
    const call = db.q.mock.calls.find(c => /FROM cpo_shift_pings/.test(String(c[0])));
    const sql = clean(call![0]);
    expect(sql).not.toMatch(/\bp\.lat\b/);
    expect(sql).not.toMatch(/\bp\.lng\b/);
    expect(sql).not.toMatch(/\bp\.accuracy_m\b/);
    // Self-check: the columns it DOES carry, so this cannot pass vacuously on
    // a query that selects nothing.
    expect(sql).toMatch(/p\.requested_at/);
    expect(sql).toMatch(/u\.display_name AS requested_by_name/);
  });

  it('a deleted manager leaves the row readable: requested_by_name is NULL, never a crash', async () => {
    // `requested_by` is ON DELETE SET NULL, so the LEFT JOIN yields no user.
    // The trace must survive the requester's account — it is the worker's
    // record, not the manager's.
    const {svc, db} = mk();
    db.q.mockResolvedValueOnce([{
      id: 'ping-9', shift_id: 'sh1', status: 'answered',
      requested_at: '2026-09-12T10:00:00.000Z', answered_at: '2026-09-12T10:00:09.000Z',
      refuse_reason: null, requested_by_name: null,
    }]);
    const out = await svc.myPings('cpo-1');
    expect(out.pings[0].requested_by_name).toBeNull();
    expect(out.pings[0].status).toBe('answered');
  });

  it('S2 — a workspace id NARROWS the trace to that org, through the shift', async () => {
    /**
     * The ping row carries no org of its own; the shift does. So the scope is
     * a join, not a column — and it is a NARROWING predicate on the caller's
     * own rows (`p.cpo_user_id = $1` is still the gate), never a widening one.
     */
    const {svc, db} = mk();
    await svc.myPings('cpo-1', 'org-A');
    const call = db.q.mock.calls.find(c => /FROM cpo_shift_pings/.test(String(c[0])));
    expect(call![1]).toEqual(['cpo-1', 'org-A']);
    const sql = clean(call![0]);
    expect(sql).toMatch(/JOIN cpo_shifts sh ON sh\.id = p\.shift_id/);
    expect(sql).toMatch(/\$2::uuid IS NULL OR sh\.org_user_id = \$2::uuid/);
    // The ownership gate is untouched — the scope is an AND, never a swap.
    expect(sql).toMatch(/p\.cpo_user_id = \$1/);
  });

  it('S2 — no workspace id → every org, unchanged (the officer shell)', async () => {
    const {svc, db} = mk();
    await svc.myPings('cpo-1');
    const call = db.q.mock.calls.find(c => /FROM cpo_shift_pings/.test(String(c[0])));
    expect(call![1]).toEqual(['cpo-1', null]);
  });
});
