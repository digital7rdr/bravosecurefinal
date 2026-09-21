import {BadRequestException, ForbiddenException, NotFoundException} from '@nestjs/common';
import {AgentService} from './agent.service';
import {MissionStateMachine} from '../ops/mission-state-machine.service';
import type {DatabaseService} from '../database/database.service';
import type {WalletService} from '../wallet/wallet.service';
import type {ConfigService} from '@nestjs/config';

/**
 * E2E-06 — the lead-declared CLIENT NO-SHOW (SECURE_SERVICES_E2E_AUDIT_2026-09-03).
 *
 * Before this there was no such path anywhere in the repo: a mission at PICKUP could
 * only be completed after go-live, and the only exits were an SOS or an ops abort that
 * refunds the client IN FULL pre-live — the agency deployed a crew and earned nothing.
 *
 * The MONEY assertions here run against a MUTATING model, not an inert double. The fake
 * settleEscrowSplit reads the hold's real status, no-ops when it is not in `fromStatuses`
 * and flips it to `finalStatus` when it is — exactly like the real primitive under
 * FOR UPDATE. Without that, "a second declaration cannot double-pay" would pass
 * vacuously (an inert mock returns the same split however many times it is called).
 */

interface Hold {status: string; gross_credits: number}

interface World {
  mission: {status: string};
  booking: {status: string};
  hold: Hold | null;
  isLead: boolean | null;          // null = not on the crew at all
  pickupTimeMs: number;
  /** missions.pickup_at — server-stamped when the crew actually reached pickup. */
  pickupAtMs: number | null;
  pickupCoords: boolean;
  /** A mission_telemetry row inside the radius AND inside the freshness window. */
  telemetryAtPickup: boolean;
  /** Models the RACE window: both callers read the mission as PICKUP before either
   *  conditional UPDATE lands. Only the UPDATE arbitrates. */
  freezeCtxStatus: boolean;
  /** Wire the real PricingService dependency (P2-13). */
  withPricing: boolean;
  /** every settleEscrowSplit call the service made, in order */
  splits: Array<{toProvider: number; toClient: number; basis: string; finalStatus: string}>;
}

const GROSS = 800;
const HOUR = 3600_000;

function mk(over: Partial<World> = {}) {
  const w: World = {
    mission: {status: 'PICKUP'},
    booking: {status: 'CONFIRMED'},
    hold: {status: 'HELD', gross_credits: GROSS},
    isLead: true,
    pickupTimeMs: Date.now() - HOUR,     // an hour past the contracted start
    pickupAtMs: Date.now() - HOUR,       // and the crew arrived on time
    pickupCoords: true,
    telemetryAtPickup: true,
    freezeCtxStatus: false,
    withPricing: false,
    splits: [],
    ...over,
  };

  const qOne = jest.fn().mockImplementation((sql: string) => {
    if (/FROM mission_crew mc/.test(sql)) {
      if (w.isLead === null) {return Promise.resolve(null); }
      return Promise.resolve({
        booking_id: 'bk1',
        mission_status: w.freezeCtxStatus ? 'PICKUP' : w.mission.status,
        pickup_at: w.pickupAtMs === null ? null : new Date(w.pickupAtMs),
        short_code: 'MSN-1', is_lead: w.isLead, client_id: 'client1', provider: 'org1',
        pickup_time: new Date(w.pickupTimeMs),
        pickup_lat: w.pickupCoords ? '25.20' : null,
        pickup_lng: w.pickupCoords ? '55.27' : null,
      });
    }
    // Both shapes of the presence probe (with and without a pickup point) read
    // mission_telemetry; neither can be satisfied by anything on the request.
    if (/FROM mission_telemetry/.test(sql)) {return Promise.resolve({ok: w.telemetryAtPickup}); }
    if (/FROM lite_bookings WHERE id = \$1 FOR UPDATE/.test(sql)) {return Promise.resolve({id: 'bk1'}); }
    if (/gross_credits, status FROM escrow_holds/.test(sql)) {return Promise.resolve(w.hold); }
    if (/comms_channel_id FROM missions/.test(sql)) {return Promise.resolve(null); }
    if (/region_code FROM lite_bookings/.test(sql)) {return Promise.resolve({region_code: 'AE'}); }
    return Promise.resolve(null);
  });

  const q = jest.fn().mockImplementation((sql: string) => {
    // The mission flip is CONDITIONAL on status='PICKUP' — model that, or the
    // "a second declaration is a no-op" pin cannot fail.
    if (/UPDATE missions[\s\S]*'ABORTED'/.test(sql)) {
      if (w.mission.status !== 'PICKUP') {return Promise.resolve([]); }
      w.mission.status = 'ABORTED';
      return Promise.resolve([{booking_id: 'bk1'}]);
    }
    if (/UPDATE lite_bookings SET status = 'CANCELLED'/.test(sql)) {
      if (w.booking.status !== 'CONFIRMED' && w.booking.status !== 'LIVE') {return Promise.resolve([]); }
      w.booking.status = 'CANCELLED';
      return Promise.resolve([{id: 'bk1'}]);
    }
    return Promise.resolve([]);
  });

  const db = {
    q, qOne,
    withTransaction: jest.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn({q, qOne})),
  } as unknown as DatabaseService;

  const wallet = {
    settleEscrowSplit: jest.fn().mockImplementation((
      _tx: unknown, _bookingId: string,
      o: {toProvider: number; toClient: number; basis: string; fromStatuses: string[]; finalStatus: string},
    ) => {
      // Real primitive: gated on fromStatuses under FOR UPDATE — wrong state is an
      // idempotent no-op, and a successful settle moves the hold terminal.
      if (!w.hold || !o.fromStatuses.includes(w.hold.status)) {
        return Promise.resolve({settled: false, toProvider: 0, toClient: 0, platformFee: 0});
      }
      w.hold.status = o.finalStatus;
      w.splits.push({toProvider: o.toProvider, toClient: o.toClient, basis: o.basis, finalStatus: o.finalStatus});
      const platformFee = w.hold.gross_credits - o.toProvider - o.toClient;
      return Promise.resolve({settled: true, toProvider: o.toProvider, toClient: o.toClient, platformFee});
    }),
  };

  const config = {
    get: (k: string) => (({
      'dispatch.clientNoShowGraceMinutes': 20,
      'dispatch.arrivalRadiusM': 150,
      'dispatch.cancelFeePct': 25,
    } as Record<string, number>)[k]),
  };

  const push = {
    clientNoShow: jest.fn().mockResolvedValue(undefined),
    refundIssued: jest.fn().mockResolvedValue(undefined),
    missionCancelledByClient: jest.fn().mockResolvedValue(undefined),
    missionAborted: jest.fn().mockResolvedValue(undefined),
  };
  const events = {statusChanged: jest.fn().mockResolvedValue(undefined)};

  // P2-13 — with `pricing` wired, cancelFeePctFor must read the ops pricing board, which
  // is the ONLY thing making the claim "a no-show charges exactly what a post-crew cancel
  // charges" true. Every earlier spec constructed the service without it, so that claim
  // was never exercised at all.
  const pricing = {config: jest.fn().mockResolvedValue({cancel_fee_pct: 40})};

  const svc = new AgentService(
    db, {} as never, {} as never, {} as never,
    wallet as unknown as WalletService,
    {} as never, {} as never,
    config as unknown as ConfigService,
    events as never, push as never,
    undefined,
    over.withPricing ? (pricing as never) : undefined,
  );
  return {svc, w, q, qOne, wallet, push, events, pricing};
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const r = (e as BadRequestException).getResponse?.();
    return typeof r === 'object' && r !== null ? String((r as {code?: string}).code) : String(r);
  }
  return '<resolved>';
}

describe('AgentService.clientNoShow — E2E-06 guards', () => {
  it('rejects a caller who is not on the crew', async () => {
    const {svc} = mk({isLead: null});
    await expect(svc.clientNoShow('stranger', 'm1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a non-lead crew member (lead_only)', async () => {
    const {svc} = mk({isLead: false});
    await expect(svc.clientNoShow('cpo2', 'm1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects any mission status other than PICKUP', async () => {
    for (const status of ['DISPATCHED', 'LIVE', 'SOS', 'COMPLETED']) {
      const {svc} = mk({mission: {status}});
      expect(await codeOf(svc.clientNoShow('lead1', 'm1'))).toBe('client_no_show_wrong_status');
    }
  });

  it('rejects before pickup_time + grace, and carries due_at for the app', async () => {
    // Contracted start 5 minutes ago; the grace is 20 minutes.
    const {svc, wallet} = mk({pickupTimeMs: Date.now() - 5 * 60_000});
    expect(await codeOf(svc.clientNoShow('lead1', 'm1'))).toBe('client_no_show_too_early');
    // Nothing may move before the grace — not the mission, not the money.
    expect(wallet.settleEscrowSplit).not.toHaveBeenCalled();
  });

  it('grace is measured on the CONTRACTED start, not on when the crew arrived', async () => {
    // pickup_time 21 minutes ago > the 20-minute grace, so it is declarable even though
    // the crew has only just reached PICKUP.
    const {svc} = mk({pickupTimeMs: Date.now() - 21 * 60_000});
    await expect(svc.clientNoShow('lead1', 'm1')).resolves.toMatchObject({ok: true});
  });

  it('refuses a declaration made away from the pickup point, and writes NOTHING', async () => {
    const {svc, q, wallet} = mk({telemetryAtPickup: false});
    expect(await codeOf(svc.clientNoShow('lead1', 'm1'))).toBe('client_no_show_not_at_pickup');
    // Without this guard the cancellation fee is farmable by a crew that never left the
    // depot: no telemetry near pickup, no device fix, no fee.
    expect(q).not.toHaveBeenCalledWith(expect.stringMatching(/UPDATE missions/), expect.anything());
    expect(wallet.settleEscrowSplit).not.toHaveBeenCalled();
  });

  it('a FABRICATED fix AT the pickup point does NOT buy the fee — the body is never a gate', async () => {
    // THE attack this guard exists for, and the case the previous spec missed by only
    // ever testing a FAR fix: flip to PICKUP (no server proximity check of its own), wait
    // out the grace from anywhere, then POST the pickup coordinates the app already
    // holds. Exact coordinates, zero server-side telemetry — must still be refused.
    const {svc, wallet} = mk({telemetryAtPickup: false});
    expect(await codeOf(svc.clientNoShow('lead1', 'm1', {lat: 25.20, lng: 55.27})))
      .toBe('client_no_show_not_at_pickup');
    expect(wallet.settleEscrowSplit).not.toHaveBeenCalled();
  });

  it('a far device fix is equally irrelevant — near or far, the body decides nothing', async () => {
    const {svc} = mk({telemetryAtPickup: false});
    expect(await codeOf(svc.clientNoShow('lead1', 'm1', {lat: 24.0, lng: 54.0})))
      .toBe('client_no_show_not_at_pickup');
  });

  it('the body fix cannot even OVERRIDE good telemetry — server facts alone decide', async () => {
    const {svc} = mk({telemetryAtPickup: true});
    await expect(svc.clientNoShow('lead1', 'm1', {lat: 0, lng: 0})).resolves.toMatchObject({ok: true});
  });

  it('requires a server-stamped arrival (pickup_at) — an unstamped mission is refused', async () => {
    const {svc, wallet} = mk({pickupAtMs: null});
    expect(await codeOf(svc.clientNoShow('lead1', 'm1'))).toBe('client_no_show_not_at_pickup');
    expect(wallet.settleEscrowSplit).not.toHaveBeenCalled();
  });

  it('the telemetry probe is bounded to a FRESH window on the SERVER clock', async () => {
    const {svc, qOne} = mk();
    await svc.clientNoShow('lead1', 'm1');
    const probe = qOne.mock.calls.find(c => /FROM mission_telemetry/.test(String(c[0])));
    // recorded_at is a server DEFAULT NOW() the ingest never supplies, so a device
    // cannot backdate it — "drove past here once" must not authorize the fee.
    expect(String(probe?.[0])).toMatch(/recorded_at > NOW\(\) - \(\$5 \|\| ' minutes'\)::interval/);
  });

  it('a booking with no pickup coordinates still needs recent telemetry — not a free pass', async () => {
    const {svc} = mk({pickupCoords: false, telemetryAtPickup: false});
    expect(await codeOf(svc.clientNoShow('lead1', 'm1'))).toBe('client_no_show_not_at_pickup');
  });

  it('…and passes once that mission is genuinely streaming', async () => {
    const {svc} = mk({pickupCoords: false, telemetryAtPickup: true});
    await expect(svc.clientNoShow('lead1', 'm1')).resolves.toMatchObject({ok: true});
  });

  it('a LATE crew cannot declare instantly — the grace runs from arrival, not the booking', async () => {
    // Contracted start 90 minutes ago, crew reached PICKUP 2 minutes ago. Anchoring on
    // pickup_time alone made the fee available the moment they arrived, so the client who
    // waited and left paid for the agency's own lateness.
    const {svc, wallet} = mk({
      pickupTimeMs: Date.now() - 90 * 60_000,
      pickupAtMs:   Date.now() - 2 * 60_000,
    });
    expect(await codeOf(svc.clientNoShow('lead1', 'm1'))).toBe('client_no_show_too_early');
    expect(wallet.settleEscrowSplit).not.toHaveBeenCalled();
  });

  it('a late crew CAN declare once its own grace has run', async () => {
    const {svc} = mk({
      pickupTimeMs: Date.now() - 90 * 60_000,
      pickupAtMs:   Date.now() - 21 * 60_000,
    });
    await expect(svc.clientNoShow('lead1', 'm1')).resolves.toMatchObject({ok: true});
  });

  it('an EARLY crew still waits for the contracted start — the later anchor wins both ways', async () => {
    const {svc} = mk({
      pickupTimeMs: Date.now() - 5 * 60_000,
      pickupAtMs:   Date.now() - 60 * 60_000,
    });
    expect(await codeOf(svc.clientNoShow('lead1', 'm1'))).toBe('client_no_show_too_early');
  });
});

describe('AgentService.clientNoShow — E2E-06 termination + money', () => {
  it('terminates the mission and the booking through the existing terminal shape', async () => {
    const {svc, w, q} = mk();
    const res = await svc.clientNoShow('lead1', 'm1');
    expect(res).toMatchObject({ok: true, mission_status: 'ABORTED', already_ended: false});
    expect(w.mission.status).toBe('ABORTED');
    expect(w.booking.status).toBe('CANCELLED');
    // end_reason is what makes a no-show distinguishable from an ops abort in the audit.
    expect(q).toHaveBeenCalledWith(
      expect.stringMatching(/end_reason = 'client_no_show'/), expect.anything(),
    );
    // The crew must be released or mission_crew_agent_active_uq keeps rejecting each CPO
    // as 'cpo_busy' forever.
    expect(q).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE mission_crew SET status = 'off'/), ['m1'],
    );
    expect(q).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO ops_audit[\s\S]*/),
      expect.arrayContaining(['lead1', 'm1']),
    );
  });

  it('settles a PARTIAL on the cancel_fee_pct basis — never a full payout, never a full refund', async () => {
    const {svc, w, wallet} = mk();
    const res = await svc.clientNoShow('lead1', 'm1');
    expect(wallet.settleEscrowSplit).toHaveBeenCalledWith(
      expect.anything(), 'bk1',
      expect.objectContaining({basis: 'partial', fromStatuses: ['HELD'], finalStatus: 'PARTIAL'}),
    );
    // 25% of 800 to the agency, the remaining 600 back to the client.
    expect(res.agency_fee_credits).toBe(200);
    expect(res.refunded_credits).toBe(600);
    // Conserved: the split can never mint or burn credits.
    expect(res.agency_fee_credits + res.refunded_credits).toBe(GROSS);
    // Neither extreme is reachable on this path.
    expect(res.agency_fee_credits).toBeLessThan(GROSS);
    expect(res.refunded_credits).toBeLessThan(GROSS);
    expect(w.hold?.status).toBe('PARTIAL');
  });

  it('a sequential re-tap is refused by the status guard and settles nothing further', async () => {
    const {svc, wallet} = mk();
    await svc.clientNoShow('lead1', 'm1');
    expect(await codeOf(svc.clientNoShow('lead1', 'm1'))).toBe('client_no_show_wrong_status');
    expect(wallet.settleEscrowSplit).toHaveBeenCalledTimes(1);
  });

  it('a RACE (both callers read PICKUP) cannot double-pay — one settles, the loser reports already_ended', async () => {
    // freezeCtxStatus reproduces the window the status guard alone cannot close: two
    // requests that both passed the read before either write landed. What arbitrates is
    // the conditional UPDATE (`WHERE status = 'PICKUP'`), not the guard — and the escrow
    // is only reached inside the branch that won it.
    const {svc, w, wallet} = mk({freezeCtxStatus: true});
    const first = await svc.clientNoShow('lead1', 'm1');
    const second = await svc.clientNoShow('lead1', 'm1');
    expect(first).toMatchObject({already_ended: false, agency_fee_credits: 200, refunded_credits: 600});
    expect(second).toMatchObject({already_ended: true, agency_fee_credits: 0, refunded_credits: 0});
    expect(wallet.settleEscrowSplit).toHaveBeenCalledTimes(1);
    expect(w.splits).toHaveLength(1);
  });

  it('takes the BOOKING lock first — the order BookingService.cancelBooking contracts for', async () => {
    // cancelBooking locks `lite_bookings … FOR UPDATE` and only then aborts the mission.
    // Both paths are reachable on a PICKUP mission inside the cancel window, so the
    // opposite order here deadlocks the two against each other.
    const {svc, qOne, q} = mk();
    await svc.clientNoShow('lead1', 'm1');
    const lockAt = qOne.mock.calls.findIndex(c => /FROM lite_bookings WHERE id = \$1 FOR UPDATE/.test(String(c[0])));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    const missionAt = q.mock.calls.findIndex(c => /UPDATE missions[\s\S]*'ABORTED'/.test(String(c[0])));
    expect(missionAt).toBeGreaterThanOrEqual(0);
    // The booking lock is taken before any mission write in the same transaction.
    const lockTime = qOne.mock.invocationCallOrder[lockAt];
    const missionTime = q.mock.invocationCallOrder[missionAt];
    expect(lockTime).toBeLessThan(missionTime);
  });

  it('stamps no_show_at so the PARTIAL is distinguishable from a client cancellation', async () => {
    const {svc, q} = mk();
    await svc.clientNoShow('lead1', 'm1');
    expect(q).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE escrow_holds SET no_show_at = NOW\(\), no_show_by = \$2/),
      ['bk1', 'lead1'],
    );
  });

  it('P2-13 — with PricingService wired, the fee comes from the ops board, not the env base', async () => {
    // The env fallback is 25%; the board says 40%. If this path did not consult the board
    // a no-show would charge a different fee than a post-crew cancel on the same booking.
    const {svc, pricing} = mk({withPricing: true});
    const res = await svc.clientNoShow('lead1', 'm1');
    expect(pricing.config).toHaveBeenCalledWith('AE');
    expect(res.agency_fee_credits).toBe(320);   // 40% of 800, not 200
    expect(res.refunded_credits).toBe(480);
    expect(res.agency_fee_credits + res.refunded_credits).toBe(GROSS);
  });

  it('falls back to the env base when the board read throws — never blocks the settlement', async () => {
    const {svc, pricing} = mk({withPricing: true});
    pricing.config.mockRejectedValueOnce(new Error('pricing down'));
    const res = await svc.clientNoShow('lead1', 'm1');
    expect(res.agency_fee_credits).toBe(200);   // env cancelFeePct = 25
  });

  it('a LEGACY booking (no escrow hold) still terminates and moves NO money', async () => {
    const {svc, w, wallet} = mk({hold: null});
    const res = await svc.clientNoShow('lead1', 'm1');
    expect(res).toMatchObject({ok: true, agency_fee_credits: 0, refunded_credits: 0});
    expect(w.mission.status).toBe('ABORTED');
    expect(wallet.settleEscrowSplit).not.toHaveBeenCalled();
  });

  it('a hold that has already left HELD is left alone (the escrow lifecycle owns it)', async () => {
    const {svc, wallet} = mk({hold: {status: 'PENDING_RELEASE', gross_credits: GROSS}});
    const res = await svc.clientNoShow('lead1', 'm1');
    expect(res.agency_fee_credits).toBe(0);
    expect(res.refunded_credits).toBe(0);
    expect(wallet.settleEscrowSplit).not.toHaveBeenCalled();
  });

  it('wakes BOTH parties — the client on the no-show kind, the agency because its slot freed', async () => {
    const {svc, push, events} = mk();
    await svc.clientNoShow('lead1', 'm1');
    expect(push.clientNoShow).toHaveBeenCalledWith('client1', 'bk1');
    expect(push.missionCancelledByClient).toHaveBeenCalledWith('org1', 'm1', 'bk1');
    expect(events.statusChanged).toHaveBeenCalledWith('m1', 'ABORTED', 'bk1');
  });

  it('sends the client exactly ONE banner — never a refund wake alongside the no-show one', async () => {
    // Two banners for one event is the bug; and of the two, a bare "credits returned to
    // your wallet" is the misleading one — a no-show KEEPS the cancellation fee.
    const {svc, push} = mk();
    await svc.clientNoShow('lead1', 'm1');
    expect(push.clientNoShow).toHaveBeenCalledTimes(1);
    expect(push.refundIssued).not.toHaveBeenCalled();
  });

  it('still tells the client when NOTHING came back — a legacy booking with no hold', async () => {
    // The old `refunded > 0` guard left this case silent: the detail was closed and the
    // client was never told.
    const {svc, push} = mk({hold: null});
    await svc.clientNoShow('lead1', 'm1');
    expect(push.clientNoShow).toHaveBeenCalledWith('client1', 'bk1');
  });

  it('a push failure can never fail the settlement', async () => {
    const {svc, w, push} = mk();
    push.clientNoShow.mockRejectedValueOnce(new Error('redis down'));
    await expect(svc.clientNoShow('lead1', 'm1')).resolves.toMatchObject({ok: true});
    expect(w.hold?.status).toBe('PARTIAL'); // the money settled regardless
  });
});

describe('E2E-06 — the FSM modelling of a lead-requested abort', () => {
  const fsm = new MissionStateMachine();

  it('PICKUP → ABORTED is legal for SYSTEM (the server performs the termination)', () => {
    expect(() => fsm.assert('PICKUP', 'ABORTED', 'SYSTEM')).not.toThrow();
  });

  it('and is NOT legal for AGENT — a guard may not abort a mission by fiat', () => {
    // The no-show asserts as SYSTEM for exactly this reason, mirroring the client-cancel
    // abort and the client panic button. Adding an AGENT→ABORTED row to satisfy the
    // caller would delete this invariant.
    expect(() => fsm.assert('PICKUP', 'ABORTED', 'AGENT')).toThrow();
  });
});
