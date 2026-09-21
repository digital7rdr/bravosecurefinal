import {BadRequestException} from '@nestjs/common';
import {OpsService} from './ops.service';
import type {AdminContext} from './admin.guard';

const ADMIN: AdminContext = {user_id: 'adm-1', role: 'ADMIN', call_sign: 'OPS-1', region: 'AE'};

function mk(holdRow: unknown) {
  const txQ = jest.fn().mockResolvedValue([]);
  const txQOne = jest.fn().mockImplementation((sql: string) =>
    /FROM booking_disputes d/.test(sql) ? Promise.resolve(holdRow) : Promise.resolve(null));
  const tx = {q: txQ, qOne: txQOne};
  const db = {withTransaction: (fn: (t: unknown) => unknown) => fn(tx)};
  const wallet = {
    settleEscrowSplit: jest.fn().mockResolvedValue({settled: true, toProvider: 0, toClient: 0, platformFee: 0}),
    clawbackReleasedHold: jest.fn().mockResolvedValue({clawed: true, toClient: 800, toPlatform: 0, toProvider: 0, shortfall: 0}),
  };
  const audit = {recordAdmin: jest.fn().mockResolvedValue(undefined), emit: jest.fn().mockResolvedValue(undefined)};
  // LM-N4 — resolveDispute wakes both parties post-commit.
  const push = {
    disputeResolved: jest.fn().mockResolvedValue(undefined),
    refundIssued: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new OpsService(
    db as never, {} as never, {} as never, {} as never, {} as never,
    audit as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    wallet as never, {} as never, {} as never, push as never,
  );
  return {svc, tx, txQ, wallet, audit, push};
}

describe('OpsService.resolveDispute (Step 11)', () => {
  it('splits a DISPUTED hold (client 300 / provider 500) → PARTIAL, records decided_by + audit', async () => {
    const {svc, txQ, wallet, audit, push} = mk({dispute_status: 'open', booking_id: 'b1', hold_status: 'DISPUTED', gross_credits: 800, region_code: 'AE', client_id: 'c1', provider_user_id: 'agency-A'});
    const res = await svc.resolveDispute('d1', ADMIN, {to_client: 300, to_provider: 500, resolution: 'split decision'});
    expect(res).toEqual({ok: true, dispute_id: 'd1', outcome: 'PARTIAL', to_client: 300, to_provider: 500, platform_fee: 0});
    expect(wallet.settleEscrowSplit).toHaveBeenCalledWith(expect.anything(), 'b1', expect.objectContaining({toProvider: 500, toClient: 300, fromStatuses: ['DISPUTED'], finalStatus: 'PARTIAL'}));
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/UPDATE booking_disputes/), expect.arrayContaining(['d1', 'resolved', 300, 500, 'adm-1']));
    expect(audit.recordAdmin).toHaveBeenCalledWith(ADMIN, 'dispute.resolve', 'booking', 'b1', expect.objectContaining({outcome: 'PARTIAL'}));
    // LM-N4 — both parties woken with the outcome; the client also sees the refund.
    expect(push.disputeResolved).toHaveBeenCalledWith('c1', 'b1', 'PARTIAL');
    expect(push.disputeResolved).toHaveBeenCalledWith('agency-A', 'b1', 'PARTIAL');
    expect(push.refundIssued).toHaveBeenCalledWith('c1', 'b1', 300);
  });

  it('full client refund (provider 0) → REFUNDED, decision upheld', async () => {
    const {svc, wallet} = mk({dispute_status: 'open', booking_id: 'b1', hold_status: 'DISPUTED', gross_credits: 800, region_code: 'AE'});
    const res = await svc.resolveDispute('d1', ADMIN, {to_client: 800, to_provider: 0, resolution: 'agency failed'});
    expect(res.outcome).toBe('REFUNDED');
    expect(wallet.settleEscrowSplit).toHaveBeenCalledWith(expect.anything(), 'b1', expect.objectContaining({finalStatus: 'REFUNDED', basis: 'refund'}));
  });

  it('claws back when the hold already RELEASED', async () => {
    const {svc, wallet} = mk({dispute_status: 'open', booking_id: 'b1', hold_status: 'RELEASED', gross_credits: 800, region_code: 'AE'});
    const res = await svc.resolveDispute('d1', ADMIN, {to_client: 800, to_provider: 0, resolution: 'upheld post-release'});
    expect(res.outcome).toBe('CLAWBACK');
    // clawback reclaims (gross − to_provider) = client refund (800) + platform leg (0).
    expect(wallet.clawbackReleasedHold).toHaveBeenCalledWith(expect.anything(), 'b1', 800, 0, expect.stringMatching(/clawback/));
  });

  // The same fail-closed defect the PARTIAL branch was built with — this half was
  // pre-existing. `clawbackReleasedHold` RETURNS clawed:false (never throws) when its
  // guards decline, and the RELEASED branch used to carry on with the all-zero return.
  describe('RELEASED — a declined clawback fails closed', () => {
    const RELEASED_HOLD = {
      dispute_status: 'open', booking_id: 'b1', hold_status: 'RELEASED',
      gross_credits: 800, region_code: 'AE', client_id: 'c1', provider_user_id: 'agency-A',
      no_show_at: null, to_provider_credits: 800, to_client_credits: 0, platform_fee_credits: 0,
    };

    it('refuses instead of reporting a resolution that moved nothing', async () => {
      const {svc, wallet, txQ, audit, push} = mk(RELEASED_HOLD);
      // An already-clawed-back hold (basis === 'clawback') — the reachable case, e.g.
      // a retry after a partial failure, or two operators on the same dispute.
      wallet.clawbackReleasedHold.mockResolvedValue({
        clawed: false, toClient: 0, toPlatform: 0, toProvider: 0, shortfall: 0,
      });
      await expect(svc.resolveDispute('d1', ADMIN, {
        to_client: 800, to_provider: 0, resolution: 'upheld post-release',
      })).rejects.toThrow('dispute_resolve_clawback_declined:RELEASED');
      // Nothing downstream ran: no dispute flip, no audit row claiming a split, and
      // critically no refund push telling the client money came back when it did not.
      expect(txQ).not.toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE booking_disputes/), expect.anything(),
      );
      expect(audit.recordAdmin).not.toHaveBeenCalled();
      expect(push.refundIssued).not.toHaveBeenCalled();
      expect(push.disputeResolved).not.toHaveBeenCalled();
    });

    it('the ordinary successful RELEASED resolve is UNCHANGED', async () => {
      const {svc, wallet, txQ, audit, push} = mk(RELEASED_HOLD);
      wallet.clawbackReleasedHold.mockResolvedValue({
        clawed: true, toClient: 600, toPlatform: 0, toProvider: 200, shortfall: 0,
      });
      const res = await svc.resolveDispute('d1', ADMIN, {
        to_client: 600, to_provider: 200, resolution: 'partially upheld post-release',
      });
      // Same executed split, same outcome, same downstream effects as before the guard.
      expect(res).toEqual({
        ok: true, dispute_id: 'd1', outcome: 'CLAWBACK',
        to_client: 600, to_provider: 200, platform_fee: 0,
      });
      expect(wallet.clawbackReleasedHold).toHaveBeenCalledWith(expect.anything(), 'b1', 600, 0, expect.anything());
      expect(txQ).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE booking_disputes/),
        expect.arrayContaining(['d1', 'resolved', 600, 200, 'adm-1']),
      );
      expect(audit.recordAdmin).toHaveBeenCalledWith(
        ADMIN, 'dispute.resolve', 'booking', 'b1', expect.objectContaining({outcome: 'CLAWBACK'}),
      );
      expect(push.disputeResolved).toHaveBeenCalledWith('c1', 'b1', 'CLAWBACK');
      expect(push.refundIssued).toHaveBeenCalledWith('c1', 'b1', 600);
    });

    // NOTE: the "agency keeps everything" case that used to live here asserted a
    // REFUSAL. The critic showed that refusing it made the most common dispute
    // outcome unrecordable, so it is now a first-class NO_CHANGE resolution — see
    // "affirming a RELEASED hold records the rejection too" below. What remains
    // here is the case the fail-closed guard is genuinely for: a clawback the
    // primitive declined for a reason OTHER than "nothing to do".
    it('a declined clawback on a split that DOES require movement still refuses', async () => {
      const {svc, wallet} = mk(RELEASED_HOLD);
      wallet.clawbackReleasedHold.mockResolvedValue({
        clawed: false, toClient: 0, toPlatform: 0, toProvider: 0, shortfall: 0,
      });
      await expect(svc.resolveDispute('d1', ADMIN, {
        to_client: 400, to_provider: 400, resolution: 'half back',
      })).rejects.toThrow('dispute_resolve_clawback_declined');
    });
  });

  // ─── E2E-06 follow-up — the no-show fee dispute exit ──────────────────────
  //
  // The lead declared a client no-show at PICKUP; the hold settled TERMINALLY to
  // PARTIAL (agency kept cancel_fee_pct = 200, client refunded 600) and stamped
  // no_show_at. resolveDispute previously accepted only DISPUTED/RELEASED, so
  // there was no operator exit at all.
  const NO_SHOW_HOLD = {
    dispute_status: 'open', booking_id: 'b1', hold_status: 'PARTIAL',
    gross_credits: 800, region_code: 'AE', client_id: 'c1', provider_user_id: 'agency-A',
    no_show_at: new Date('2026-09-03T10:00:00Z'),
    to_provider_credits: 200, to_client_credits: 600, platform_fee_credits: 0,
  };

  describe('no-show fee (PARTIAL + no_show_at)', () => {
    it('reverses the fee in full — claws the DELTA from the agency, not the gross', async () => {
      const {svc, wallet, audit, push} = mk(NO_SHOW_HOLD);
      // The clawback moves the remaining 200; the client ends on the full 800.
      wallet.clawbackReleasedHold.mockResolvedValue({
        clawed: true, toClient: 200, toPlatform: 0, toProvider: 0, shortfall: 0,
      });
      const res = await svc.resolveDispute('d1', ADMIN, {
        to_client: 800, to_provider: 0, resolution: 'client was at the pickup, CPO went to the wrong gate',
      });
      // THE ASSERTION: the delta (800 − 600 already refunded = 200), NEVER 800.
      // Passing the final number straight through would tell the clawback to pull
      // the whole gross from an agency that only ever received 200.
      expect(wallet.clawbackReleasedHold).toHaveBeenCalledWith(
        expect.anything(), 'b1', 200, 0, expect.stringMatching(/no-show clawback/),
      );
      expect(res).toEqual(expect.objectContaining({
        outcome: 'CLAWBACK', to_client: 800, to_provider: 0, platform_fee: 0,
      }));
      expect(audit.recordAdmin).toHaveBeenCalledWith(
        ADMIN, 'dispute.resolve', 'booking', 'b1',
        expect.objectContaining({outcome: 'CLAWBACK', to_client: 800}),
      );
      expect(push.refundIssued).toHaveBeenCalledWith('c1', 'b1', 800);
    });

    it('reduces the fee partially — agency keeps 50, client gets the other 150 back', async () => {
      const {svc, wallet} = mk(NO_SHOW_HOLD);
      wallet.clawbackReleasedHold.mockResolvedValue({
        clawed: true, toClient: 150, toPlatform: 0, toProvider: 50, shortfall: 0,
      });
      const res = await svc.resolveDispute('d1', ADMIN, {
        to_client: 750, to_provider: 50, resolution: 'fee halved as a goodwill adjustment',
      });
      expect(wallet.clawbackReleasedHold).toHaveBeenCalledWith(expect.anything(), 'b1', 150, 0, expect.anything());
      expect(res.to_client).toBe(750);
      expect(res.to_provider).toBe(50);
    });

    it('IDEMPOTENCY — a declined clawback fails CLOSED and never marks the dispute decided', async () => {
      const {svc, wallet, txQ, audit, push} = mk(NO_SHOW_HOLD);
      // What the real machinery returns for an already-clawed-back hold
      // (basis === 'clawback'): clawed:false, zero movement, no throw.
      wallet.clawbackReleasedHold.mockResolvedValue({
        clawed: false, toClient: 0, toPlatform: 0, toProvider: 0, shortfall: 0,
      });
      await expect(svc.resolveDispute('d1', ADMIN, {
        to_client: 800, to_provider: 0, resolution: 'retry',
      })).rejects.toThrow('dispute_resolve_clawback_declined');
      // No second refund, no dispute flip, no audit row claiming money moved.
      expect(txQ).not.toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE booking_disputes/), expect.anything(),
      );
      expect(audit.recordAdmin).not.toHaveBeenCalled();
      expect(push.refundIssued).not.toHaveBeenCalled();
    });

    it('refuses to INCREASE the agency share — a terminal hold has no escrow left to pay from', async () => {
      const {svc, wallet} = mk(NO_SHOW_HOLD);
      const err = await svc.resolveDispute('d1', ADMIN, {
        to_client: 500, to_provider: 300, resolution: 'raise the fee',
      }).catch(e => e);
      expect(err).toBeInstanceOf(BadRequestException);
      // Typed body, not just a message — the console branches on `code`.
      expect((err as BadRequestException).getResponse()).toEqual(expect.objectContaining({
        code: 'dispute_resolve_cannot_increase_provider_share',
        provider_credits: 200,
      }));
      expect(wallet.clawbackReleasedHold).not.toHaveBeenCalled();
    });

    // The pull bound is the CALLER's invariant: inside clawbackReleasedHold the pull
    // is capped at `gross`, not at to_provider_credits, because on a RELEASED hold
    // the agency IS meant to front the platform's original fee back to the client.
    // On a PARTIAL no-show the agency only ever received the cancellation fee.
    // CRITIC P1 — the clamp family. `Math.max(0, want − already)` silently DROPPED
    // an operator's intent to reduce a leg, and the surviving leg then carried its
    // full un-netted value into the pull. Both reductions are refused by name now,
    // so no resolution can execute a split different from the one submitted.
    it('ZERO-ZERO — refuses rather than draining an agency that received 200', async () => {
      const {svc, wallet} = mk(NO_SHOW_HOLD);
      // to_client 0 + to_provider 0 ⇒ the client's 600 would have to come BACK,
      // which the clawback cannot do; the platform leg then carried the whole 800.
      const err = await svc.resolveDispute('d1', ADMIN, {
        to_client: 0, to_provider: 0, resolution: 'void everything',
      }).catch(e => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toEqual(expect.objectContaining({
        code: 'dispute_resolve_cannot_reduce_client_refund',
        requested_to_client: 0,
        already_to_client: 600,
      }));
      // The money primitive is never reached — no drain, no platform-fronted shortfall.
      expect(wallet.clawbackReleasedHold).not.toHaveBeenCalled();
    });

    it("CRITIC P1 — {to_client:500, to_provider:100} no longer drains all 200 the operator said it keeps", async () => {
      const {svc, wallet} = mk(NO_SHOW_HOLD);
      // The worked case: deltaToClient clamps to 0, deltaPlatform = 200, so the OLD
      // bound (pull 200 ≤ heldByProvider 200) passed and executed 600/0/200 —
      // silently different from the 500/100/200 the operator submitted.
      const err = await svc.resolveDispute('d1', ADMIN, {
        to_client: 500, to_provider: 100, resolution: 'agency keeps 100',
      }).catch(e => e);
      expect((err as BadRequestException).getResponse()).toEqual(expect.objectContaining({
        code: 'dispute_resolve_cannot_reduce_client_refund',
      }));
      expect(wallet.clawbackReleasedHold).not.toHaveBeenCalled();
    });

    it('CRITIC P1 — zeroing a NON-ZERO platform share is refused, not silently ignored', async () => {
      // 800 gross: agency 150, client 600, platform 50.
      const {svc, wallet} = mk({
        ...NO_SHOW_HOLD, to_provider_credits: 150, to_client_credits: 600, platform_fee_credits: 50,
      });
      const err = await svc.resolveDispute('d1', ADMIN, {
        to_client: 800, to_provider: 0, resolution: 'full reversal, platform keeps nothing',
      }).catch(e => e);
      expect((err as BadRequestException).getResponse()).toEqual(expect.objectContaining({
        code: 'dispute_resolve_cannot_reduce_platform_share',
        requested_platform_fee: 0,
        already_platform_fee: 50,
      }));
      expect(wallet.clawbackReleasedHold).not.toHaveBeenCalled();
    });

    it('the pull bound is stated against what the agency KEEPS under the resolution', async () => {
      const {svc, wallet} = mk(NO_SHOW_HOLD);
      wallet.clawbackReleasedHold.mockResolvedValue({
        clawed: true, toClient: 150, toPlatform: 0, toProvider: 50, shortfall: 0,
      });
      // 750/50: pull 150, bound = received 200 − keeps 50 = 150. Allowed at equality.
      await expect(svc.resolveDispute('d1', ADMIN, {
        to_client: 750, to_provider: 50, resolution: 'fee halved',
      })).resolves.toEqual(expect.objectContaining({outcome: 'CLAWBACK'}));
      expect(wallet.clawbackReleasedHold).toHaveBeenCalledWith(expect.anything(), 'b1', 150, 0, expect.anything());
    });

    it('ALLOWS a pull of exactly what the agency received (the boundary is inclusive)', async () => {
      const {svc, wallet} = mk(NO_SHOW_HOLD);
      wallet.clawbackReleasedHold.mockResolvedValue({
        clawed: true, toClient: 0, toPlatform: 200, toProvider: 0, shortfall: 0,
      });
      // Fee voided but routed to the platform rather than the client: pull == 200.
      await expect(svc.resolveDispute('d1', ADMIN, {
        to_client: 600, to_provider: 0, resolution: 'fee void, retained by platform',
      })).resolves.toEqual(expect.objectContaining({outcome: 'CLAWBACK'}));
      expect(wallet.clawbackReleasedHold).toHaveBeenCalledWith(expect.anything(), 'b1', 0, 200, expect.anything());
    });

    it('a zero-fee no-show hold has nothing to claw back at all', async () => {
      // cancel_fee_pct = 0 ⇒ the agency received nothing; every pull over-draws.
      const {svc, wallet} = mk({
        ...NO_SHOW_HOLD, to_provider_credits: 0, to_client_credits: 800, platform_fee_credits: 0,
      });
      await expect(svc.resolveDispute('d1', ADMIN, {
        to_client: 0, to_provider: 0, resolution: 'x',
      })).rejects.toBeInstanceOf(BadRequestException);
      expect(wallet.clawbackReleasedHold).not.toHaveBeenCalled();
    });

    // CRITIC P0 — "the fee stands, dispute rejected" is the MOST COMMON outcome and
    // had become unrecordable: resolveDispute is the sole writer of
    // booking_disputes.status, so the row stayed open forever with no other endpoint
    // able to close it. Affirming the executed split is now a first-class outcome.
    it('affirming the executed split RECORDS the rejection and moves no money', async () => {
      const {svc, wallet, txQ, audit, push} = mk(NO_SHOW_HOLD);
      const res = await svc.resolveDispute('d1', ADMIN, {
        to_client: 600, to_provider: 200, resolution: 'client did not attend; fee stands',
      });
      expect(res).toEqual({
        ok: true, dispute_id: 'd1', outcome: 'NO_CHANGE',
        to_client: 600, to_provider: 200, platform_fee: 0,
      });
      // The dispute is CLOSED — decision 'rejected', not left open.
      expect(txQ).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE booking_disputes/),
        expect.arrayContaining(['d1', 'rejected', 600, 200, 'adm-1']),
      );
      expect(audit.recordAdmin).toHaveBeenCalledWith(
        ADMIN, 'dispute.resolve', 'booking', 'b1',
        expect.objectContaining({outcome: 'NO_CHANGE'}),
      );
      // No wallet call at all — there is nothing to fail closed on.
      expect(wallet.clawbackReleasedHold).not.toHaveBeenCalled();
      expect(wallet.settleEscrowSplit).not.toHaveBeenCalled();
      // Honest copy: the outcome wake, and NOT a refund banner. `to_client` here is
      // the 600 already refunded weeks ago, not money that just moved.
      expect(push.disputeResolved).toHaveBeenCalledWith('c1', 'b1', 'NO_CHANGE');
      expect(push.refundIssued).not.toHaveBeenCalled();
    });

    it('affirming a RELEASED hold records the rejection too', async () => {
      const {svc, wallet, txQ, push} = mk({
        ...NO_SHOW_HOLD, hold_status: 'RELEASED', no_show_at: null,
        to_provider_credits: 800, to_client_credits: 0, platform_fee_credits: 0,
      });
      const res = await svc.resolveDispute('d1', ADMIN, {
        to_client: 0, to_provider: 800, resolution: 'agency delivered; claim rejected',
      });
      expect(res.outcome).toBe('NO_CHANGE');
      expect(txQ).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE booking_disputes/),
        expect.arrayContaining(['d1', 'rejected']),
      );
      expect(wallet.clawbackReleasedHold).not.toHaveBeenCalled();
      expect(push.refundIssued).not.toHaveBeenCalled();
    });

    it('a DISPUTED hold is NEVER treated as no-change (its money has not moved yet)', async () => {
      // to_*_credits are 0 on an unsettled hold; the split must still execute.
      const {svc, wallet} = mk({
        ...NO_SHOW_HOLD, hold_status: 'DISPUTED', no_show_at: null,
        to_provider_credits: 0, to_client_credits: 0, platform_fee_credits: 800,
      });
      await svc.resolveDispute('d1', ADMIN, {to_client: 0, to_provider: 0, resolution: 'x'});
      expect(wallet.settleEscrowSplit).toHaveBeenCalled();
    });

    it('a PARTIAL hold WITHOUT no_show_at is still refused — the branch is exactly as narrow as openDispute', async () => {
      // A mid-LIVE abort pro-rata or a post-grace cancel fee also lands on PARTIAL.
      // Those are not no-show disputes and must keep hitting the invalid-state 400.
      const {svc, wallet} = mk({...NO_SHOW_HOLD, no_show_at: null});
      await expect(svc.resolveDispute('d1', ADMIN, {
        to_client: 800, to_provider: 0, resolution: 'x',
      })).rejects.toThrow('dispute_resolve_invalid_hold_state:PARTIAL');
      expect(wallet.clawbackReleasedHold).not.toHaveBeenCalled();
    });

    it('the DISPUTED and RELEASED branches are untouched by the widening', async () => {
      const d = mk({...NO_SHOW_HOLD, hold_status: 'DISPUTED'});
      await d.svc.resolveDispute('d1', ADMIN, {to_client: 300, to_provider: 500, resolution: 'x'});
      expect(d.wallet.settleEscrowSplit).toHaveBeenCalledWith(
        expect.anything(), 'b1', expect.objectContaining({fromStatuses: ['DISPUTED']}),
      );
      expect(d.wallet.clawbackReleasedHold).not.toHaveBeenCalled();

      const r = mk({...NO_SHOW_HOLD, hold_status: 'RELEASED', to_provider_credits: 800, to_client_credits: 0});
      const out = await r.svc.resolveDispute('d1', ADMIN, {to_client: 800, to_provider: 0, resolution: 'x'});
      // RELEASED still passes the FINAL numbers straight through (client had 0).
      expect(r.wallet.clawbackReleasedHold).toHaveBeenCalledWith(expect.anything(), 'b1', 800, 0, expect.anything());
      expect(out.outcome).toBe('CLAWBACK');
    });
  });

  it('rejects a dispute that is not open', async () => {
    const {svc} = mk({dispute_status: 'resolved', booking_id: 'b1', hold_status: 'DISPUTED', gross_credits: 800, region_code: 'AE'});
    await expect(svc.resolveDispute('d1', ADMIN, {to_client: 0, to_provider: 800, resolution: 'x'})).rejects.toThrow('dispute_not_open');
  });

  it('404s an unknown dispute', async () => {
    const {svc} = mk(null);
    await expect(svc.resolveDispute('d1', ADMIN, {to_client: 0, to_provider: 0, resolution: 'x'})).rejects.toThrow('Dispute not found');
  });
});
