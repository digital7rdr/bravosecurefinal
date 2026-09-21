import {BadRequestException, ForbiddenException, NotFoundException} from '@nestjs/common';
import {AgentService} from './agent.service';
import type {DatabaseService} from '../database/database.service';

/**
 * Executive Protection — hourly check-ins (the executive replacement for waypoints).
 *
 * Contract pinned here: lead-only · executive-only · mission LIVE/SOS · hour within
 * the booked block · an hour is confirmable only once ELAPSED (see the E2E-16 anchor
 * block below, − 120s grace) · idempotent per (mission, hour) · pushes fan out to
 * the client AND the agency on a FRESH insert only.
 *
 * E2E-14 — `status` accepts the table's full CHECK set ('SMOOTH' | 'ISSUE'); it was
 * hard-coded 'SMOOTH' at the only writer while three UIs rendered an 'ISSUE' branch that
 * could never occur.
 * E2E-16 — the schedule anchors to the CONTRACTED start (lite_bookings.pickup_time), not
 * to go-live. The legacy live_at anchoring survives ONLY as a fallback for a row with no
 * pickup_time, which is why the pre-existing cases below (no pickup_time in the ctx)
 * still describe the old arithmetic.
 */
type Ctx = Partial<{
  booking_id: string; mission_status: string; live_at: Date | null;
  service: string; duration_hours: number; client_id: string;
  provider: string | null; is_lead: boolean; short_code: string;
  pickup_time: Date | null;
}>;

function mk(ctx: Ctx | null, opts?: {conflict?: boolean}) {
  const inserted = {hour_index: 2, status: 'SMOOTH', comment: null, created_at: new Date()};
  const qOne = jest.fn().mockImplementation((sql: string) => {
    if (/FROM mission_crew mc/.test(sql)) {return Promise.resolve(ctx);}
    if (/INSERT INTO mission_hourly_checkins/.test(sql)) {
      return Promise.resolve(opts?.conflict ? null : inserted);
    }
    if (/SELECT hour_index/.test(sql)) {return Promise.resolve(inserted);}
    return Promise.resolve(null);
  });
  const q = jest.fn().mockResolvedValue([]);
  const db = {qOne, q} as unknown as DatabaseService;
  const push = {
    hourlyCheckin: jest.fn().mockResolvedValue(undefined),
    hourlyCheckinAgency: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new AgentService(
    db, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {get: () => undefined} as never,
    undefined, push as never,
  );
  return {svc, qOne, q, push};
}

/** The parameter array the INSERT was called with — index 5 is the status column. */
function insertParams(qOne: jest.Mock): unknown[] {
  const call = qOne.mock.calls.find(c => /INSERT INTO mission_hourly_checkins/.test(String(c[0])));
  return (call?.[1] ?? []) as unknown[];
}

const HOUR = 3600_000;

function execCtx(over: Ctx = {}): Ctx {
  return {
    booking_id: 'bk1', mission_status: 'LIVE',
    live_at: new Date(Date.now() - 2 * HOUR - 60_000), // 2h01m ago → hours 1..2 elapsed
    service: 'executive_protection', duration_hours: 6, client_id: 'client1',
    provider: 'org1', is_lead: true, short_code: 'MSN-X',
    ...over,
  };
}

describe('AgentService.hourlyCheckIn — Executive Protection', () => {
  it('confirms an elapsed hour and pushes to client + agency', async () => {
    const {svc, push} = mk(execCtx());
    const res = await svc.hourlyCheckIn('lead1', 'm1', 2, 'all quiet');
    expect(res.ok).toBe(true);
    expect(res.hour_index).toBe(2);
    expect(push.hourlyCheckin).toHaveBeenCalledWith('client1', 'bk1', 2);
    expect(push.hourlyCheckinAgency).toHaveBeenCalledWith('org1', 'bk1', 'm1', 2);
  });

  it('is idempotent — a re-tap adopts the existing row and does NOT re-push', async () => {
    const {svc, push} = mk(execCtx(), {conflict: true});
    const res = await svc.hourlyCheckIn('lead1', 'm1', 2);
    expect(res.ok).toBe(true);
    expect(push.hourlyCheckin).not.toHaveBeenCalled();
    expect(push.hourlyCheckinAgency).not.toHaveBeenCalled();
  });

  it('rejects an hour that has not elapsed yet (with the 2-min grace honored)', async () => {
    // live_at 57 minutes ago: hour 1 is due at live+58m (60−2 grace) — not yet.
    const {svc} = mk(execCtx({live_at: new Date(Date.now() - 57 * 60_000)}));
    await expect(svc.hourlyCheckIn('lead1', 'm1', 1))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts inside the grace window (59 minutes elapsed for hour 1)', async () => {
    const {svc} = mk(execCtx({live_at: new Date(Date.now() - 59 * 60_000)}));
    const res = await svc.hourlyCheckIn('lead1', 'm1', 1);
    expect(res.ok).toBe(true);
  });

  it('rejects non-lead crew (lead_only)', async () => {
    const {svc} = mk(execCtx({is_lead: false}));
    await expect(svc.hourlyCheckIn('cp2', 'm1', 1)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects non-executive missions', async () => {
    const {svc} = mk(execCtx({service: 'secure_transfer'}));
    await expect(svc.hourlyCheckIn('lead1', 'm1', 1)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when the mission is not LIVE/SOS', async () => {
    const {svc} = mk(execCtx({mission_status: 'PICKUP'}));
    await expect(svc.hourlyCheckIn('lead1', 'm1', 1)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows confirmation during SOS (the record must survive an incident)', async () => {
    const {svc} = mk(execCtx({mission_status: 'SOS'}));
    const res = await svc.hourlyCheckIn('lead1', 'm1', 1);
    expect(res.ok).toBe(true);
  });

  it('rejects hours beyond the booked block', async () => {
    const {svc} = mk(execCtx({duration_hours: 3, live_at: new Date(Date.now() - 10 * HOUR)}));
    await expect(svc.hourlyCheckIn('lead1', 'm1', 4)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a caller who is not on the crew', async () => {
    const {svc} = mk(null);
    await expect(svc.hourlyCheckIn('stranger', 'm1', 1)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects garbage hour_index values', async () => {
    const {svc} = mk(execCtx());
    await expect(svc.hourlyCheckIn('lead1', 'm1', 0)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.hourlyCheckIn('lead1', 'm1', 25)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.hourlyCheckIn('lead1', 'm1', Number.NaN)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('E2E-14 — the lead can report an ISSUE, not only SMOOTH', () => {
  it('defaults to SMOOTH when no status is sent, so existing callers are unaffected', async () => {
    const {svc, qOne} = mk(execCtx());
    const res = await svc.hourlyCheckIn('lead1', 'm1', 2, 'all quiet');
    expect(res.ok).toBe(true);
    expect(insertParams(qOne)).toContain('SMOOTH');
    expect(insertParams(qOne)).not.toContain('ISSUE');
  });

  it('persists ISSUE when the lead reports one', async () => {
    // The only writer of mission_hourly_checkins hard-coded 'SMOOTH', so the 'ISSUE'
    // branch three UIs render could never occur.
    const {svc, qOne} = mk(execCtx());
    await svc.hourlyCheckIn('lead1', 'm1', 2, 'crowd at the entrance', 'ISSUE');
    expect(insertParams(qOne)).toContain('ISSUE');
  });

  it('accepts a lower-case status (normalised, not rejected)', async () => {
    const {svc, qOne} = mk(execCtx());
    await svc.hourlyCheckIn('lead1', 'm1', 2, undefined, 'issue');
    expect(insertParams(qOne)).toContain('ISSUE');
  });

  it('rejects a status outside the table CHECK set with a 400, not a DB 500', async () => {
    const {svc} = mk(execCtx());
    await expect(svc.hourlyCheckIn('lead1', 'm1', 2, undefined, 'PANIC'))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('an ISSUE hour also lands on the ops feed', async () => {
    const {svc, q} = mk(execCtx());
    await svc.hourlyCheckIn('lead1', 'm1', 2, undefined, 'ISSUE');
    expect(q).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO ops_audit[\s\S]*mission\.hourly_issue/),
      expect.anything(),
    );
  });

  it('a SMOOTH hour does not raise an ops signal', async () => {
    const {svc, q} = mk(execCtx());
    await svc.hourlyCheckIn('lead1', 'm1', 2);
    expect(q).not.toHaveBeenCalledWith(
      expect.stringMatching(/mission\.hourly_issue/), expect.anything(),
    );
  });

  it('a re-tap on an existing hour does NOT duplicate the ops signal', async () => {
    const {svc, q} = mk(execCtx(), {conflict: true});
    await svc.hourlyCheckIn('lead1', 'm1', 2, undefined, 'ISSUE');
    expect(q).not.toHaveBeenCalledWith(
      expect.stringMatching(/mission\.hourly_issue/), expect.anything(),
    );
  });

  it('P2-10 — an ISSUE can UPGRADE an hour already confirmed SMOOTH', async () => {
    // With ON CONFLICT DO NOTHING the write silently did nothing and the endpoint
    // answered 'SMOOTH' while the lead's screen showed their issue saved.
    const {svc, qOne} = mk(execCtx());
    await svc.hourlyCheckIn('lead1', 'm1', 2, 'crowd surge', 'ISSUE');
    const sql = String(qOne.mock.calls.find(c => /INSERT INTO mission_hourly_checkins/.test(String(c[0])))![0]);
    expect(sql).toMatch(/ON CONFLICT \(mission_id, hour_index\) DO UPDATE/);
    expect(sql).toMatch(/SET status\s*=\s*'ISSUE'/);
  });

  it('…but the upgrade is ONE-WAY — a later SMOOTH can never erase a reported ISSUE', async () => {
    const {svc, qOne} = mk(execCtx());
    await svc.hourlyCheckIn('lead1', 'm1', 2, undefined, 'ISSUE');
    const sql = String(qOne.mock.calls.find(c => /INSERT INTO mission_hourly_checkins/.test(String(c[0])))![0]);
    // The guard is what makes it one-way: only an existing SMOOTH row accepts an
    // incoming ISSUE. ISSUE→SMOOTH and SMOOTH→SMOOTH both match nothing.
    expect(sql).toMatch(/WHERE mission_hourly_checkins\.status = 'SMOOTH' AND EXCLUDED\.status = 'ISSUE'/);
  });
});

describe('E2E-16 — the hourly clock is anchored to the CONTRACTED start', () => {
  it('LATE go-live: the hours the paid block already consumed are confirmable now', async () => {
    // Contracted start 2h05m ago; the CPO only went live 25 minutes ago. Under the old
    // live_at anchoring hour 2 became confirmable ~1h35m AFTER the contracted hour 2 —
    // and hour N could only be confirmed after the contracted end.
    const {svc} = mk(execCtx({
      pickup_time: new Date(Date.now() - 2 * HOUR - 5 * 60_000),
      live_at:     new Date(Date.now() - 25 * 60_000),
    }));
    await expect(svc.hourlyCheckIn('lead1', 'm1', 2)).resolves.toMatchObject({ok: true});
  });

  it('EARLY go-live: starting before the contracted start does NOT start the clock early', async () => {
    // Live for 90 minutes, but the block the client paid for started 30 minutes ago, so
    // hour 1 is not due for another ~28 minutes. (The client is not billed for the early
    // start either.)
    const {svc} = mk(execCtx({
      pickup_time: new Date(Date.now() - 30 * 60_000),
      live_at:     new Date(Date.now() - 90 * 60_000),
    }));
    await expect(svc.hourlyCheckIn('lead1', 'm1', 1)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('the 2-minute grace still applies, measured from the contracted start', async () => {
    const {svc} = mk(execCtx({
      pickup_time: new Date(Date.now() - 59 * 60_000),
      live_at:     new Date(Date.now() - 5 * 60_000),
    }));
    await expect(svc.hourlyCheckIn('lead1', 'm1', 1)).resolves.toMatchObject({ok: true});
  });

  it('falls back to live_at only when the booking carries no contracted start', async () => {
    const {svc} = mk(execCtx({pickup_time: null, live_at: new Date(Date.now() - 59 * 60_000)}));
    await expect(svc.hourlyCheckIn('lead1', 'm1', 1)).resolves.toMatchObject({ok: true});
  });

  it('the duration cap is unchanged — an hour beyond the block is still refused', async () => {
    const {svc} = mk(execCtx({
      duration_hours: 3, pickup_time: new Date(Date.now() - 10 * HOUR),
      live_at: new Date(Date.now() - 10 * HOUR),
    }));
    await expect(svc.hourlyCheckIn('lead1', 'm1', 4)).rejects.toBeInstanceOf(BadRequestException);
  });
});
