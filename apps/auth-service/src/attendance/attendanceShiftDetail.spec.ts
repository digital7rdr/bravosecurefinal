/**
 * B-855 / B-856 / B-860 — the shift DETAIL, the per-workspace "today", and the
 * series overlap refusal (plan §10 A5, A1, A8).
 *
 * B-855: "when we expand each shift we should see which users are assigned,
 * their location, and all required information for each worker with their
 * picture". `GET /attendance/shifts/:id/assignments` used to answer
 * `{cpo_user_id, display_name}` — every other field the founder asked for
 * already existed in `DAY_ROW_SELECT` and was simply never joined here.
 *
 * THE LOAD-BEARING RULE IS "FOR THIS SHIFT". The session lateral keys on
 * `ses.shift_id = sh.id`, never "any session today": a consultant clocked into
 * ANOTHER org's shift must read "Not checked in for this shift", and a worker
 * with two sessions against this one must still produce exactly ONE row.
 *
 * ⚠️ The db here is mocked and answers regardless of the query, so nothing
 * BEHAVIOURAL in this file can see a WHERE clause (the repo's DB-only blind
 * spot). The predicates are therefore asserted on the SQL text, comment-
 * stripped line-wise — the prose above each query names the very clauses these
 * assertions forbid.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {BadRequestException, NotFoundException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {AttendanceService, type Shift} from './attendance.service';
import {AttendanceController} from './attendance.controller';
import type {AttendancePhotoService} from './attendance-photo.service';
import type {DatabaseService} from '../database/database.service';
import type {OrgAuditService} from '../org/org-audit.service';
import type {NotificationsService} from '../notifications/notifications.service';
import type {AccessClaims} from '../auth/jwt.service';

function mk() {
  const tx = {q: jest.fn().mockResolvedValue([]), qOne: jest.fn().mockResolvedValue(null)};
  const db = {
    q: jest.fn().mockResolvedValue([]),
    qOne: jest.fn().mockResolvedValue(null),
    withTransaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
  const audit = {log: jest.fn()};
  const svc = new AttendanceService(
    db as unknown as DatabaseService,
    {get: jest.fn(() => undefined)} as unknown as ConfigService,
    audit as unknown as OrgAuditService,
    {record: jest.fn()} as unknown as NotificationsService,
  );
  return {svc, db, tx, audit};
}

/**
 * Line-wise strip: a greedy block stripper has eaten real code in this repo.
 * Own-line comments go first, then TRAILING inline ones — a `-- …` tail on a
 * live SQL line is prose the scanner would otherwise read as code, which is
 * exactly how a banned token "appears" in a query that never contained it.
 */
const clean = (sql: unknown): string =>
  String(sql)
    .split(/\r?\n/)
    .filter(l => !l.trim().startsWith('--'))
    .map(l => l.replace(/\s--.*$/, ''))
    .join('\n');

const assigneeSql = (db: {q: jest.Mock}): string => {
  const call = db.q.mock.calls.find(c => /FROM cpo_shift_assignments a/.test(String(c[0])));
  expect(call).toBeDefined();
  return clean(call![0]);
};

const shiftFixture = (over: Partial<Shift> = {}): Shift => ({
  id: 'sh1', org_user_id: 'org-9', department: null, site_label: null,
  site_lat: null, site_lng: null, approved_radius_m: 150,
  start_at: '2026-09-12T09:00:00.000Z', end_at: '2026-09-12T17:00:00.000Z',
  created_by: 'mgr-1', archived_at: null, created_at: '2026-09-11T08:00:00.000Z',
  ...over,
});

/** One flat row as the projection SQL returns it. */
const row = (over: Record<string, unknown> = {}) => ({
  cpo_user_id: 'cpo-1', display_name: 'Sam Vance', avatar_url: 'https://cdn/av.png',
  call_sign: 'CPO 44', department: 'Operations', member_status: 'active',
  session_id: 'ses-1', session_status: 'open',
  clock_in_at: '2026-09-12T09:04:00.000Z', clock_in_lat: 25.2, clock_in_lng: 55.3,
  clock_in_place: 'Sandton City, Johannesburg',
  clock_out_at: null, within_radius: true, distance_m: 41, has_photo: true,
  ping_id: null, ping_status: null, ping_requested_at: null, ping_answered_at: null,
  ping_lat: null, ping_lng: null, ping_accuracy_m: null, ping_refuse_reason: null,
  ping_mocked: null,
  fix_ping_id: null, fix_answered_at: null, fix_lat: null, fix_lng: null, fix_accuracy_m: null,
  fix_mocked: null,
  total_count: 1,
  ...over,
});

describe('A5 — listAssignments is the shift DETAIL projection (B-855)', () => {
  it('returns one rich row per assignee: photo, call sign, department, session, ping', async () => {
    const {svc, db} = mk();
    db.qOne.mockResolvedValueOnce({id: 'sh1', org_user_id: 'org-9', department: null});
    db.q.mockResolvedValueOnce([row({
      ping_id: 'p-1', ping_status: 'answered',
      ping_requested_at: '2026-09-12T10:00:00.000Z',
      ping_answered_at: '2026-09-12T10:00:12.000Z',
      ping_lat: 25.21, ping_lng: 55.31, ping_accuracy_m: 18, ping_refuse_reason: null,
      fix_ping_id: 'p-1', fix_answered_at: '2026-09-12T10:00:12.000Z',
      fix_lat: 25.21, fix_lng: 55.31, fix_accuracy_m: 18,
    })]);
    const out = await svc.listAssignments('org-9', 'sh1', null);
    expect(out.assignments).toEqual([{
      cpo_user_id: 'cpo-1', display_name: 'Sam Vance', avatar_url: 'https://cdn/av.png',
      call_sign: 'CPO 44', department: 'Operations', member_status: 'active',
      session: {
        status: 'open', id: 'ses-1',
        clock_in_at: '2026-09-12T09:04:00.000Z', clock_in_lat: 25.2, clock_in_lng: 55.3,
        clock_in_place: 'Sandton City, Johannesburg',
        clock_out_at: null, within_radius: true, distance_m: 41, has_photo: true,
      },
      last_ping: {
        id: 'p-1', status: 'answered',
        requested_at: '2026-09-12T10:00:00.000Z', answered_at: '2026-09-12T10:00:12.000Z',
        lat: 25.21, lng: 55.31, accuracy_m: 18, refuse_reason: null,
        // A row written before the column existed reads NULL, which is
        // "unknown" — deliberately not `false`. See the mocked case below.
        mocked: null,
      },
      last_fix: {
        ping_id: 'p-1', answered_at: '2026-09-12T10:00:12.000Z',
        lat: 25.21, lng: 55.31, accuracy_m: 18, mocked: null,
      },
    }]);
    expect(out.more).toBe(0);
  });

  it('last_ping carries refuse_reason — "Off shift" and "No permission" are different answers', async () => {
    /**
     * Without it the sheet can only say "Declined" for four outcomes that mean
     * four different things: the worker was off shift (the SERVER's verdict),
     * denied the permission, got no fix, or said no. A manager acts differently
     * on each one.
     */
    const {svc, db} = mk();
    db.qOne.mockResolvedValueOnce({id: 'sh1', org_user_id: 'org-9', department: null});
    db.q.mockResolvedValueOnce([row({
      ping_id: 'p-2', ping_status: 'refused',
      ping_requested_at: '2026-09-12T10:00:00.000Z',
      ping_answered_at: '2026-09-12T10:00:04.000Z',
      ping_refuse_reason: 'off_shift',
    })]);
    const out = await svc.listAssignments('org-9', 'sh1', null);
    expect(out.assignments[0].last_ping?.refuse_reason).toBe('off_shift');
    expect(assigneeSql(db)).toMatch(/png\.refuse_reason/);
  });

  it('a NEWER pending ping does not erase the last answered FIX', async () => {
    /**
     * `last_ping` is the STATE slot — it must show the ask that is outstanding
     * right now. Reading the fix off it means the moment a manager re-pings,
     * the pin they were looking at vanishes from the sheet (the newest row has
     * NULL coordinates) and only comes back if the worker answers again. The
     * fix is its own LATERAL, keyed on status = 'answered'.
     */
    const {svc, db} = mk();
    db.qOne.mockResolvedValueOnce({id: 'sh1', org_user_id: 'org-9', department: null});
    db.q.mockResolvedValueOnce([row({
      ping_id: 'p-3', ping_status: 'pending',
      ping_requested_at: '2026-09-12T11:00:00.000Z',
      ping_answered_at: null, ping_lat: null, ping_lng: null, ping_accuracy_m: null,
      fix_ping_id: 'p-1', fix_answered_at: '2026-09-12T10:00:12.000Z',
      fix_lat: 25.21, fix_lng: 55.31, fix_accuracy_m: 18,
    })]);
    const out = await svc.listAssignments('org-9', 'sh1', null);
    expect(out.assignments[0].last_ping?.id).toBe('p-3');
    expect(out.assignments[0].last_ping?.lat).toBeNull();
    expect(out.assignments[0].last_fix).toEqual({
      ping_id: 'p-1', answered_at: '2026-09-12T10:00:12.000Z',
      lat: 25.21, lng: 55.31, accuracy_m: 18, mocked: null,
    });

    const sql = assigneeSql(db);
    const fixLateral = sql.slice(sql.lastIndexOf('LEFT JOIN LATERAL'));
    expect(fixLateral).toMatch(/FROM cpo_shift_pings fx/);
    expect(fixLateral).toMatch(/fx\.status = 'answered'/);
    expect(fixLateral).toMatch(/ORDER BY fx\.answered_at DESC, fx\.id DESC/);
  });

  it('S1 — a mocked fix is LABELLED as one, on both the state slot and the pin', async () => {
    /**
     * The feature exists so a manager can believe a location. A mock-location
     * app makes the coordinate a number the device chose, and the device
     * already knows: `onDutyHeartbeat` ships `is_mocked` on the live lane.
     * The ping answer is the OTHER place a coordinate enters this system, and
     * it was the only one that dropped the flag on the floor — so the sheet
     * rendered a fabricated pin exactly like a real one.
     *
     * Both slots project it: `last_ping` is what the sheet shows while the ask
     * is live, `last_fix` is the pin that survives a re-ping.
     */
    const {svc, db} = mk();
    db.qOne.mockResolvedValueOnce({id: 'sh1', org_user_id: 'org-9', department: null});
    db.q.mockResolvedValueOnce([row({
      ping_id: 'p-7', ping_status: 'answered',
      ping_requested_at: '2026-09-12T10:00:00.000Z',
      ping_answered_at: '2026-09-12T10:00:12.000Z',
      ping_lat: 25.21, ping_lng: 55.31, ping_accuracy_m: 18, ping_mocked: true,
      fix_ping_id: 'p-7', fix_answered_at: '2026-09-12T10:00:12.000Z',
      fix_lat: 25.21, fix_lng: 55.31, fix_accuracy_m: 18, fix_mocked: true,
    })]);
    const out = await svc.listAssignments('org-9', 'sh1', null);
    expect(out.assignments[0].last_ping?.mocked).toBe(true);
    expect(out.assignments[0].last_fix?.mocked).toBe(true);

    const sql = assigneeSql(db);
    // The projection aliases, and the column inside each lateral's own SELECT
    // list — an alias over a column the lateral never selected is a 42703.
    // Terminated on purpose: an UNANCHORED `AS ping_mocked` also matches
    // `AS ping_mocked_X`, so a renamed alias — a column the fold then reads as
    // undefined — passed a scan that looked right. (Measured: the rename
    // mutation was GREEN against the loose form.)
    expect(sql).toMatch(/lp\.mocked\s+AS ping_mocked,/);
    expect(sql).toMatch(/lf\.mocked\s+AS fix_mocked,/);
    const upToLp = sql.slice(0, sql.indexOf(') lp'));
    expect(upToLp.slice(upToLp.lastIndexOf('LEFT JOIN LATERAL'))).toMatch(/\bpng\.mocked\b/);
    const fixLateral = sql.slice(sql.lastIndexOf('LEFT JOIN LATERAL'));
    expect(fixLateral).toMatch(/\bfx\.mocked\b/);
  });

  it('S1 — an old answer reads mocked: null (unknown), never a reassuring `false`', async () => {
    // NULL and false are different facts. A row written by an APK from before
    // the column existed reported nothing; rendering that as "not mocked"
    // would be the server inventing the very assurance it cannot give.
    const {svc, db} = mk();
    db.qOne.mockResolvedValueOnce({id: 'sh1', org_user_id: 'org-9', department: null});
    db.q.mockResolvedValueOnce([row({
      ping_id: 'p-8', ping_status: 'answered',
      ping_requested_at: '2026-09-12T10:00:00.000Z',
      ping_answered_at: '2026-09-12T10:00:12.000Z',
      ping_lat: 25.21, ping_lng: 55.31, ping_accuracy_m: 18,
      fix_ping_id: 'p-8', fix_answered_at: '2026-09-12T10:00:12.000Z',
      fix_lat: 25.21, fix_lng: 55.31, fix_accuracy_m: 18,
    })]);
    const out = await svc.listAssignments('org-9', 'sh1', null);
    expect(out.assignments[0].last_ping?.mocked).toBeNull();
    expect(out.assignments[0].last_fix?.mocked).toBeNull();
  });

  it('the OLD consumer still works — the ShiftEditor prefill reads cpo_user_id + display_name', async () => {
    // The response envelope keeps its `assignments` key and every row keeps
    // both original fields; the editor prefill is the one existing caller and
    // it must not need a single line changed to keep working.
    const {svc, db} = mk();
    db.qOne.mockResolvedValueOnce({id: 'sh1', org_user_id: 'org-9', department: null});
    db.q.mockResolvedValueOnce([row()]);
    const out = await svc.listAssignments('org-9', 'sh1', null);
    expect(out.assignments[0].cpo_user_id).toBe('cpo-1');
    expect(out.assignments[0].display_name).toBe('Sam Vance');
  });

  it('a worker who never clocked in reads not_started — session is PRESENT, never absent', async () => {
    /**
     * A9 — the client gates the Ping button on the row CARRYING the session
     * field (the old server answers 200 with the old shape, so a 404 check is
     * wrong). Encoding "no session" as an absent/null field would make the
     * not-yet-clocked-in worker look like an old server and hide the button on
     * exactly the row a manager most wants to ping.
     */
    const {svc, db} = mk();
    db.qOne.mockResolvedValueOnce({id: 'sh1', org_user_id: 'org-9', department: null});
    db.q.mockResolvedValueOnce([row({
      session_id: null, session_status: null, clock_in_at: null, clock_in_lat: null,
      clock_in_lng: null, clock_in_place: null, clock_out_at: null,
      within_radius: null, distance_m: null, has_photo: null,
    })]);
    const out = await svc.listAssignments('org-9', 'sh1', null);
    expect(out.assignments[0].session).toEqual({
      status: 'not_started', id: null, clock_in_at: null, clock_in_lat: null,
      clock_in_lng: null, clock_in_place: null, clock_out_at: null,
      within_radius: null, distance_m: null, has_photo: false,
    });
    expect(out.assignments[0].last_ping).toBeNull();
    expect(out.assignments[0].last_fix).toBeNull();
  });

  it("an 'edited' session reads closed, not a raw column value the client cannot map", async () => {
    const {svc, db} = mk();
    db.qOne.mockResolvedValueOnce({id: 'sh1', org_user_id: 'org-9', department: null});
    db.q.mockResolvedValueOnce([row({session_status: 'edited', clock_out_at: '2026-09-12T17:02:00.000Z'})]);
    const out = await svc.listAssignments('org-9', 'sh1', null);
    expect(out.assignments[0].session.status).toBe('closed');
  });

  it('a worker with TWO sessions on this shift still yields ONE row (LATERAL … LIMIT 1)', async () => {
    /**
     * The mock cannot execute SQL, so this is pinned on BOTH halves: the
     * projection returns one output row per input row (no fan-out mapping),
     * and the session join is a LEFT JOIN LATERAL bounded by LIMIT 1 — which
     * is the thing that makes the DB return one row per assignee. A plain
     * `LEFT JOIN cpo_shift_sessions` would duplicate the assignee per session.
     */
    const {svc, db} = mk();
    db.qOne.mockResolvedValueOnce({id: 'sh1', org_user_id: 'org-9', department: null});
    db.q.mockResolvedValueOnce([row()]);
    const out = await svc.listAssignments('org-9', 'sh1', null);
    expect(out.assignments).toHaveLength(1);

    const sql = assigneeSql(db);
    const lateral = sql.slice(sql.indexOf('LEFT JOIN LATERAL'));
    expect(lateral).toMatch(/FROM cpo_shift_sessions ses/);
    // Tie-break on id: two check-ins can share a clock_in_at to the
    // microsecond after a manager correction rewrites one of them, and an
    // unstable pick would flip the whole row between two identical requests.
    expect(lateral).toMatch(/ORDER BY ses\.clock_in_at DESC, ses\.id DESC/);
    // THREE laterals now: the session, the latest ping (state) and the latest
    // ANSWERED ping (the fix that must survive a re-ping).
    expect((sql.match(/LEFT JOIN LATERAL/g) ?? []).length).toBe(3);
    expect(sql).not.toMatch(/LEFT JOIN cpo_shift_sessions/);
  });

  it('each lateral is bounded by its own LIMIT 1', async () => {
    // Counted per BLOCK, not per file: the corrections fold carries its own
    // `LIMIT 1` inside every effectiveField() subquery, so a whole-query count
    // stopped being a statement about the laterals the moment P1-1 landed.
    const {svc, db} = mk();
    db.qOne.mockResolvedValueOnce({id: 'sh1', org_user_id: 'org-9', department: null});
    db.q.mockResolvedValueOnce([row()]);
    await svc.listAssignments('org-9', 'sh1', null);
    const sql = assigneeSql(db);
    const blocks = sql.split('LEFT JOIN LATERAL').slice(1);
    expect(blocks).toHaveLength(3);
    for (const b of blocks) {
      // Cut at the lateral's OWN closing alias, not at the first ") " in the
      // text: the corrections fold carries parens of its own, so an incidental
      // anchor made this test a statement about the fold instead of the bound.
      const end = b.search(/\n\s*\)\s+\w+ ON TRUE/);
      expect(end).toBeGreaterThan(-1);
      expect(b.slice(0, end)).toMatch(/LIMIT 1/);
    }
  });

  it('the session lateral FOLDS manager corrections, exactly like every other human reader', async () => {
    /**
     * A7.4 — `recordCorrection` appends rows; a reader that shows the RAW
     * column displays the pre-correction time. This sheet is the founder's
     * "all required information for each worker", so a corrected clock-in that
     * still reads the wrong time here is the same bug the fold exists to kill.
     *
     * ORDER BY stays RAW on purpose (the service's own rule): ordering is the
     * record's place in history; the projection shows corrected CONTENT.
     */
    const {svc, db} = mk();
    db.qOne.mockResolvedValueOnce({id: 'sh1', org_user_id: 'org-9', department: null});
    db.q.mockResolvedValueOnce([row()]);
    await svc.listAssignments('org-9', 'sh1', null);
    const sql = assigneeSql(db);
    expect(sql).toMatch(/after_value->>'clock_in_at'/);
    expect(sql).toMatch(/after_value->>'clock_out_at'/);
    expect(sql).toMatch(/after_value \? 'clock_in_at'/);
    expect(sql).toMatch(/ORDER BY c\.corrected_at DESC, c\.id DESC LIMIT 1/);
    // Tenancy-bound like its siblings.
    expect(sql).toMatch(/c\.session_id = ses\.id AND c\.org_user_id = ses\.org_user_id/);
    // Aliased over the raw column, and the ORDER BY is NOT folded.
    expect(sql).toMatch(/\)::timestamptz, ses\.clock_in_at\) AS clock_in_at/);
    expect(sql).toMatch(/ORDER BY ses\.clock_in_at DESC/);
  });

  it('the session lateral keys on THIS shift — never "any session today"', async () => {
    const {svc, db} = mk();
    db.qOne.mockResolvedValueOnce({id: 'sh1', org_user_id: 'org-9', department: null});
    db.q.mockResolvedValueOnce([row()]);
    await svc.listAssignments('org-9', 'sh1', null);
    const sql = assigneeSql(db);
    expect(sql).toMatch(/ses\.shift_id = sh\.id\s+AND ses\.cpo_user_id = a\.cpo_user_id/);
    // The three shapes a "today" predicate takes in this codebase. Any of them
    // here would show another org's check-in against this shift.
    expect(sql).not.toMatch(/date_trunc\(/);
    expect(sql).not.toMatch(/CURRENT_DATE/);
    expect(sql).not.toMatch(/INTERVAL '24 hours'/);
  });

  it('the ping lateral is the latest ping for (shift, worker)', async () => {
    const {svc, db} = mk();
    db.qOne.mockResolvedValueOnce({id: 'sh1', org_user_id: 'org-9', department: null});
    db.q.mockResolvedValueOnce([row()]);
    await svc.listAssignments('org-9', 'sh1', null);
    const sql = assigneeSql(db);
    expect(sql).toMatch(/FROM cpo_shift_pings png/);
    expect(sql).toMatch(/png\.shift_id = sh\.id\s+AND png\.cpo_user_id = a\.cpo_user_id/);
    // Tie-break on id: two managers can raise a ping in the same microsecond.
    expect(sql).toMatch(/ORDER BY png\.requested_at DESC, png\.id DESC/);
  });

  it('member_status + department come from the SHIFT owner org, folded shift-first', async () => {
    const {svc, db} = mk();
    db.qOne.mockResolvedValueOnce({id: 'sh1', org_user_id: 'org-9', department: null});
    db.q.mockResolvedValueOnce([row()]);
    await svc.listAssignments('org-9', 'sh1', null);
    const sql = assigneeSql(db);
    expect(sql).toMatch(/om\.org_user_id = sh\.org_user_id\s+AND om\.member_user_id = a\.cpo_user_id/);
    expect(sql).toMatch(/COALESCE\(sh\.department, om\.department\) AS department/);
    expect(sql).toMatch(/om\.status\s+AS member_status/);
  });

  it('has_photo reuses the EXACT DAY_ROW_SELECT predicate', async () => {
    /**
     * `deleted_at IS NULL AND sealed IS NOT NULL` is what "the bytes are still
     * there" means. A row whose bytes were purged after review keeps existing
     * as the view-count audit trail, so a bare `p.session_id IS NOT NULL`
     * would offer a tap that 404s.
     */
    const {svc, db} = mk();
    db.qOne.mockResolvedValueOnce({id: 'sh1', org_user_id: 'org-9', department: null});
    db.q.mockResolvedValueOnce([row()]);
    await svc.listAssignments('org-9', 'sh1', null);
    const sql = assigneeSql(db);
    expect(sql).toMatch(/p\.session_id = ses\.id AND p\.deleted_at IS NULL AND p\.sealed IS NOT NULL/);
    expect(sql).toMatch(/\(p\.session_id IS NOT NULL\) AS has_photo/);
  });

  it('caps at 200 rows and reports the remainder as `more`', async () => {
    const {svc, db} = mk();
    db.qOne.mockResolvedValueOnce({id: 'sh1', org_user_id: 'org-9', department: null});
    db.q.mockResolvedValueOnce(
      Array.from({length: 200}, (_, i) => row({cpo_user_id: `cpo-${i}`, total_count: 217})),
    );
    const out = await svc.listAssignments('org-9', 'sh1', null);
    expect(out.assignments).toHaveLength(200);
    expect(out.more).toBe(17);
    const call = db.q.mock.calls.find(c => /FROM cpo_shift_assignments a/.test(String(c[0])));
    expect(call![1]).toEqual(['sh1', 200]);
    const sql = clean(call![0]);
    expect(sql).toMatch(/LIMIT \$2/);
    // `more` is a REAL count, not a "did we hit the cap" guess: the window
    // function is evaluated over the whole result before LIMIT, so it names the
    // rows the cap dropped instead of implying "at least one".
    expect(sql).toMatch(/\(COUNT\(\*\) OVER \(\)\)::int\s+AS total_count/);
    // A stable outer order, or two identical requests return different pages.
    expect(sql).toMatch(/ORDER BY u\.display_name NULLS LAST, a\.cpo_user_id/);
  });

  it('keeps the guard: a foreign-org (or foreign-branch) manager still 404s, and never reads rows', async () => {
    const {svc, db} = mk();
    db.qOne.mockResolvedValueOnce(null); // the shift is not in this org/branch
    await expect(svc.listAssignments('org-OTHER', 'sh1', 'Ops'))
      .rejects.toBeInstanceOf(NotFoundException);
    // The refusal precedes the projection — no assignee row is ever fetched.
    expect(db.q.mock.calls.find(c => /FROM cpo_shift_assignments a/.test(String(c[0])))).toBeUndefined();
    const guard = clean(db.qOne.mock.calls[0][0]);
    expect(guard).toMatch(/\$3::text IS NULL OR department = \$3/);
    expect(db.qOne.mock.calls[0][1]).toEqual(['sh1', 'org-OTHER', 'Ops']);
  });
});

describe('A1 — GET /attendance/my-shift/today honours X-Org-Context (B-856)', () => {
  const ORG = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

  function ctl() {
    const attendance = {myTodayShift: jest.fn().mockResolvedValue(null)};
    const controller = new AttendanceController(
      attendance as unknown as AttendanceService,
      {} as unknown as AttendancePhotoService,
    );
    return {controller, attendance};
  }

  it('threads the header into the existing orgUserId param', async () => {
    const {controller, attendance} = ctl();
    await controller.myTodayShift({sub: 'cpo-1'} as AccessClaims, {headers: {'x-org-context': ORG}});
    expect(attendance.myTodayShift).toHaveBeenCalledWith('cpo-1', ORG);
  });

  it('no header → unchanged cross-org answer (an old APK must not go blank)', async () => {
    const {controller, attendance} = ctl();
    await controller.myTodayShift({sub: 'cpo-1'} as AccessClaims, {headers: {}});
    expect(attendance.myTodayShift).toHaveBeenCalledWith('cpo-1', undefined);
  });

  it('a junk header is dropped by readOrgContextHeader, never passed through', async () => {
    const {controller, attendance} = ctl();
    await controller.myTodayShift({sub: 'cpo-1'} as AccessClaims, {headers: {'x-org-context': 'not-a-uuid'}});
    expect(attendance.myTodayShift).toHaveBeenCalledWith('cpo-1', undefined);
  });

  it('the SQL param is the org when scoped and NULL when not — the header NARROWS, never widens', async () => {
    // The predicate is `($2::uuid IS NULL OR s.org_user_id = $2)` over shifts
    // the CPO is already ASSIGNED to, so a forged header can only ever return
    // fewer of their own rows. That is why this route needs no pickOrgContext.
    const scoped = mk();
    await scoped.svc.myTodayShift('cpo-1', 'org-A');
    expect(scoped.db.qOne.mock.calls[0][1]).toEqual(['cpo-1', 'org-A']);
    expect(clean(scoped.db.qOne.mock.calls[0][0]))
      .toMatch(/\$2::uuid IS NULL OR s\.org_user_id = \$2::uuid/);

    const wide = mk();
    await wide.svc.myTodayShift('cpo-1');
    expect(wide.db.qOne.mock.calls[0][1]).toEqual(['cpo-1', null]);
  });
});

describe('the routes and the schema this batch adds (source scans)', () => {
  /**
   * Both are gates the node project cannot reach behaviourally: pipes do not
   * run when a handler is called directly, and NO test in this repo executes
   * SQL. Scanned with comments stripped, anchored on the shape the code uses.
   */
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const controller = () =>
    strip(readFileSync(join(__dirname, 'attendance.controller.ts'), 'utf8'));
  const sqlOf = (file: string) => readFileSync(
    join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations', file), 'utf8',
  ).split(/\r?\n/).filter(l => !l.trim().startsWith('--')).join('\n');
  const migration = () => sqlOf('20260912100000_attendance_pings.sql');
  const mockedMigration = () => sqlOf('20260912110000_attendance_pings_mocked.sql');
  const dto = () =>
    strip(readFileSync(join(__dirname, 'dto', 'attendance.dto.ts'), 'utf8'));

  it.each([['listAssignments'], ['pingAssignee']])(
    "%s binds @Param('id', ParseUUIDPipe) — a malformed id is a 400, never a 22P02 500",
    (handler) => {
      expect(controller())
        .toMatch(new RegExp(`\\b${handler}\\s*\\(\\s*@Param\\('id',\\s*ParseUUIDPipe\\)`));
    },
  );

  it('the worker ping routes validate their :id too', () => {
    const src = controller();
    for (const h of ['answerPing', 'refusePing']) {
      expect(src).toMatch(new RegExp(`\\b${h}\\s*\\(\\s*@Param\\('id',\\s*ParseUUIDPipe\\)`));
    }
  });

  it('coordinates are a SCHEMA invariant: they may exist only on an answered row', () => {
    // The founder's "other than shift, if pinged, don't share location" put
    // under the service, so a future writer cannot leave a fix on a refusal by
    // a forgotten NULL in an UPDATE, a backfill, or a console edit.
    const sql = migration();
    expect(sql).toMatch(
      /CHECK \(status = 'answered' OR \(lat IS NULL AND lng IS NULL AND accuracy_m IS NULL\)\)/);
  });

  it('requested_by is NULLABLE and SET NULL — the trace outlives the manager who asked', () => {
    // CASCADE here would DELETE the worker's record of having been asked when
    // the asker's account goes, which is exactly backwards: the trace exists
    // for the person who was asked.
    const sql = migration();
    expect(sql).toMatch(/requested_by\s+UUID REFERENCES public\.users\(id\) ON DELETE SET NULL/);
    expect(sql).not.toMatch(/requested_by\s+UUID NOT NULL/);
  });

  it('one pending per (shift, worker), and the table is deny-by-default', () => {
    const sql = migration();
    expect(sql).toMatch(/CREATE UNIQUE INDEX[\s\S]*?cpo_shift_pings\(shift_id, cpo_user_id\)[\s\S]*?WHERE status = 'pending'/);
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/FORCE\s+ROW LEVEL SECURITY/);
    // No policy is defined on purpose — the service role is the only reader.
    expect(sql).not.toMatch(/CREATE POLICY/);
  });

  it('S1 — `mocked` arrives as its OWN additive migration, never an edit of the applied one', () => {
    /**
     * 20260912100000 is already applied on staging. Editing an applied
     * migration is a no-op there and a divergence everywhere else: the file
     * says one thing and the live schema another, and the next fresh database
     * is the only one that ever agrees with the file.
     */
    expect(migration()).not.toMatch(/\bmocked\b/);
    const sql = mockedMigration();
    expect(sql).toMatch(
      /ALTER TABLE public\.cpo_shift_pings\s+ADD COLUMN IF NOT EXISTS mocked BOOLEAN/);
    expect(sql).toMatch(/COMMENT ON COLUMN public\.cpo_shift_pings\.mocked/);
  });

  it('S1 — the flag is answered-only at the SCHEMA, on its own CHECK', () => {
    /**
     * The same floor the coordinates already have, and deliberately a SECOND
     * constraint rather than a widened first one: the fix CHECK is applied and
     * dropping/re-adding it to bolt a column on would re-validate every
     * existing row for nothing. A refusal carries no device claim at all.
     */
    const sql = mockedMigration();
    expect(sql).toMatch(/CONSTRAINT cpo_shift_pings_mocked_only_when_answered/);
    expect(sql).toMatch(/CHECK \(status = 'answered' OR mocked IS NULL\)/);
    // The fix CHECK is left exactly as it is — see the case above.
    expect(sql).not.toMatch(/cpo_shift_pings_fix_only_when_answered/);
    // Re-runnable: a CHECK has no ALTER form and no IF NOT EXISTS, so the
    // repo pattern (family_quota_audit) is DROP IF EXISTS then ADD.
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS cpo_shift_pings_mocked_only_when_answered/);
  });

  it('S1 — the door takes the flag as an OPTIONAL boolean, never a required one', () => {
    // An APK built before this column existed sends no field at all. Making it
    // required would 400 every one of those answers, and the manager would
    // read "No answer" for a device that answered honestly — the same defect
    // the accuracy @Max(10_000) caused.
    const src = dto();
    const at = src.indexOf('class AnswerPingDto');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf('}', at));
    expect(block).toMatch(/@IsOptional\(\)\s*@IsBoolean\(\)\s*mocked\?:\s*boolean/);
  });
});

describe('A8 — a series whose windows overlap is refused (B-860)', () => {
  const create = (occurrences: Array<{start_at: string; end_at: string}>) => ({
    start_at: occurrences[0].start_at, end_at: occurrences[0].end_at, occurrences,
  });

  /** Roster lookup → no month; the group id + each INSERT answer for real. */
  function wireCreate(tx: {qOne: jest.Mock}) {
    tx.qOne.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (/gen_random_uuid\(\) AS id/.test(s)) {return {id: 'grp-1'};}
      if (/INSERT INTO cpo_shifts/.test(s)) {return shiftFixture();}
      return null;
    });
  }

  it('refuses overlapping occurrences BEFORE it opens a transaction', async () => {
    const {svc, db} = mk();
    await expect(svc.createShift('org-9', 'mgr-1', create([
      {start_at: '2026-09-12T09:00:00.000Z', end_at: '2026-09-12T17:00:00.000Z'},
      {start_at: '2026-09-12T16:00:00.000Z', end_at: '2026-09-13T01:00:00.000Z'},
    ]))).rejects.toThrow('occurrences_overlap');
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  it('catches a long window swallowing two later ones', async () => {
    // MEASURED, not assumed: on a start-sorted list an adjacent-pair compare is
    // equivalent in DETECTION power to the running max-end sweep (if i and j
    // overlap then so do i and i+1), so this case does not distinguish the two
    // forms and a mutation to the adjacent form leaves it green. It is kept
    // because a > 24 h daily window is the real-world shape of B-860, and the
    // sweep is kept because it states the invariant instead of relying on that
    // proof holding after the next edit.
    const {svc} = mk();
    await expect(svc.createShift('org-9', 'mgr-1', create([
      {start_at: '2026-09-12T06:00:00.000Z', end_at: '2026-09-13T06:00:00.000Z'},
      {start_at: '2026-09-12T07:00:00.000Z', end_at: '2026-09-12T08:00:00.000Z'},
      {start_at: '2026-09-12T09:00:00.000Z', end_at: '2026-09-12T10:00:00.000Z'},
    ]))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('TOUCHING windows are fine — end == next start is a back-to-back shift', async () => {
    const {svc, tx} = mk();
    wireCreate(tx);
    const out = await svc.createShift('org-9', 'mgr-1', create([
      {start_at: '2026-09-12T09:00:00.000Z', end_at: '2026-09-12T17:00:00.000Z'},
      {start_at: '2026-09-12T17:00:00.000Z', end_at: '2026-09-13T01:00:00.000Z'},
    ]));
    expect(out.occurrences).toBe(2);
  });

  it('an overnight 22:00→06:00 DAILY series is fine (R6 — the founder’s 10-day sequence)', async () => {
    const {svc, tx} = mk();
    wireCreate(tx);
    const days = Array.from({length: 10}, (_, k) => ({
      start_at: new Date(Date.UTC(2026, 8, 12 + k, 22, 0, 0)).toISOString(),
      end_at:   new Date(Date.UTC(2026, 8, 13 + k, 6, 0, 0)).toISOString(),
    }));
    const out = await svc.createShift('org-9', 'mgr-1', create(days));
    expect(out.occurrences).toBe(10);
  });

  it('the plain single-window create is untouched', async () => {
    const {svc, tx} = mk();
    wireCreate(tx);
    const out = await svc.createShift('org-9', 'mgr-1', {
      start_at: '2026-09-12T09:00:00.000Z', end_at: '2026-09-12T17:00:00.000Z',
    });
    expect(out.occurrences).toBe(1);
  });

  it('the weekly repeat still produces N non-overlapping rows', async () => {
    const {svc, tx} = mk();
    wireCreate(tx);
    const out = await svc.createShift('org-9', 'mgr-1', {
      start_at: '2026-09-12T09:00:00.000Z', end_at: '2026-09-12T17:00:00.000Z', repeat_weeks: 4,
    });
    expect(out.occurrences).toBe(4);
  });

  /**
   * DOCUMENTS a deliberate BEHAVIOUR CHANGE for legacy clients.
   *
   * The check is not scoped to the new `occurrences` lane — it runs over the
   * generated windows whatever produced them. A `repeat_weeks` series whose
   * window is longer than its 7-day step overlaps ITSELF, and that used to
   * create N rows the roster's findConflicts would flag at publish. It now
   * 400s at create.
   *
   * This is intended: the rows were always wrong, and a refusal the manager
   * sees while they are still on the editor beats a conflict list days later.
   * It is written down because an OLD APK can still send this body, and the
   * only symptom there is a create that stops working — so if support ever
   * reports that, this is the line to read.
   */
  it('a >7-day window with repeat_weeks now 400s (behaviour change for old clients)', async () => {
    const {svc} = mk();
    await expect(svc.createShift('org-9', 'mgr-1', {
      start_at: '2026-09-12T09:00:00.000Z',
      end_at:   '2026-09-20T17:00:00.000Z',   // 8 days — laps the +7d step
      repeat_weeks: 3,
    })).rejects.toThrow('occurrences_overlap');
  });

  it('a window exactly 7 days long still repeats weekly (the boundary is TOUCHING, not overlapping)', async () => {
    const {svc, tx} = mk();
    wireCreate(tx);
    const out = await svc.createShift('org-9', 'mgr-1', {
      start_at: '2026-09-12T09:00:00.000Z',
      end_at:   '2026-09-19T09:00:00.000Z',   // ends exactly as the next starts
      repeat_weeks: 3,
    });
    expect(out.occurrences).toBe(3);
  });
});
