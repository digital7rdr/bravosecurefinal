/**
 * B-807 — the escrow rulebook the Finance › Escrow / Disputes dialogs explain a
 * decision with. Every number here is pinned against the SERVER's own rule
 * (named in each case), because a preview that disagrees with the ledger is
 * worse than no preview: the operator would press the button believing a
 * different split from the one that lands.
 *
 * Node project, no DOM — `lib/escrowRules.ts` is dependency-free on purpose.
 */
import {
  ESCROW_STATE_RULES, escrowStateRule, GATE_REASON_RULES, gateReasonRule,
  reviewReleasePreview, holdTimeline, disputeMode, disputePreview, disputePresets,
  type DisputeHold,
} from '../lib/escrowRules';

const SETTLE: DisputeHold = {
  escrow_status: 'DISPUTED', gross_credits: 800, hold_basis: null,
  hold_to_provider_credits: null, hold_to_client_credits: null, hold_platform_fee_credits: null, hold_no_show_at: null,
};
/** A released 800 BC hold at 10% fee: provider 720, platform 80 (wallet.releaseEscrowHold). */
const RELEASED: DisputeHold = {
  escrow_status: 'RELEASED', gross_credits: 800, hold_basis: 'full_release',
  hold_to_provider_credits: 720, hold_to_client_credits: 0, hold_platform_fee_credits: 80, hold_no_show_at: null,
};
/** A client no-show on 800 BC at 25% cancel fee: provider 200, client 600, platform 0. */
const NO_SHOW: DisputeHold = {
  escrow_status: 'PARTIAL', gross_credits: 800, hold_basis: 'partial',
  hold_to_provider_credits: 200, hold_to_client_credits: 600, hold_platform_fee_credits: 0,
  hold_no_show_at: '2026-09-03T10:00:00Z',
};

describe('lifecycle rulebook', () => {
  it('describes every escrow_hold_status value exactly once, terminals marked', () => {
    const statuses = ESCROW_STATE_RULES.map(r => r.status);
    expect([...statuses].sort()).toEqual(['DISPUTED', 'HELD', 'PARTIAL', 'PENDING_RELEASE', 'REFUNDED', 'RELEASED']);
    expect(new Set(statuses).size).toBe(statuses.length);
    expect(ESCROW_STATE_RULES.filter(r => r.terminal).map(r => r.status).sort()).toEqual(['PARTIAL', 'REFUNDED', 'RELEASED']);
    expect(escrowStateRule('nope')).toBeUndefined();
  });

  it('every proof-gate reason id the server can emit has a title, a check and a verify step', () => {
    // ↔ proof-of-completion.service.ts reasons.push('…')
    const serverIds = [
      'no_progression', 'never_reached_pickup', 'no_pickup_coords', 'insufficient_telemetry',
      'too_short', 'no_live_movement', 'no_presence_checkins', 'identity_unverified', 'mission_or_booking_missing',
    ];
    for (const id of serverIds) {
      const r = GATE_REASON_RULES.find(x => x.id === id);
      expect(r).toBeDefined();
      expect(r!.title.length).toBeGreaterThan(3);
      expect(r!.check.length).toBeGreaterThan(10);
      expect(r!.verify.length).toBeGreaterThan(10);
    }
  });

  it('an unknown reason id still renders (raw id, generic guidance) rather than vanishing', () => {
    const r = gateReasonRule('some_future_check');
    expect(r.id).toBe('some_future_check');
    expect(r.title).toBe('some future check');
    expect(r.verify).toMatch(/completion_gate_fail/);
  });
});

describe('reviewReleasePreview ↔ wallet.releaseEscrowHold', () => {
  it('fee = min(gross, max(0, round(gross × pct / 100))); provider gets the rest', () => {
    expect(reviewReleasePreview(800, 15)).toEqual({gross: 800, feePct: 15, platformFee: 120, toProvider: 680});
    expect(reviewReleasePreview(333, 15)).toEqual({gross: 333, feePct: 15, platformFee: 50, toProvider: 283}); // 49.95 → 50
    expect(reviewReleasePreview(100, 0.4)).toEqual({gross: 100, feePct: 0.4, platformFee: 0, toProvider: 100}); // 0.4 → 0
  });
  it('CRITIC P1 — an unknown fee is null, never a 0-fee number (the server default is 15, not 0)', () => {
    // A dialog that printed "RELEASE 800 BC" from a 0 guess would land 680.
    expect(reviewReleasePreview(800, null)).toBeNull();
    expect(reviewReleasePreview(800, undefined)).toBeNull();
    expect(reviewReleasePreview(800, -5)).toBeNull();
    expect(reviewReleasePreview(800, Number.NaN)).toBeNull();
    expect(reviewReleasePreview(800, 0)).toEqual({gross: 800, feePct: 0, platformFee: 0, toProvider: 800}); // an EXPLICIT 0 is a number
  });
  it('caps the fee at gross', () => {
    expect(reviewReleasePreview(10, 500)).toEqual({gross: 10, feePct: 500, platformFee: 10, toProvider: 0});
  });
});

describe('holdTimeline', () => {
  const now = Date.parse('2026-09-06T12:00:00Z');
  const base = {status: 'PENDING_RELEASE', review_required: false, completed_at: '2026-09-05T12:00:00Z', release_eligible_at: '2026-09-08T12:00:00Z', settled_at: null};

  it('derives the dispute window from completed_at → release_eligible_at and counts down', () => {
    const t = holdTimeline(base, now);
    expect(t.windowHours).toBe(72);
    expect(t.msUntilRelease).toBe(48 * 3_600_000);
    expect(t.phrase).toBe('auto-releases in 2 d 0 h');
  });
  it('reports the sweep as due once the window elapsed', () => {
    const t = holdTimeline({...base, release_eligible_at: '2026-09-06T11:00:00Z'}, now);
    expect(t.msUntilRelease).toBeLessThan(0);
    expect(t.phrase).toMatch(/due/);
  });
  it('a review-parked HELD hold never auto-releases; other states name their gate', () => {
    expect(holdTimeline({...base, status: 'HELD', review_required: true}, now).phrase).toMatch(/will not auto-release/);
    expect(holdTimeline({...base, status: 'HELD', review_required: false}, now).phrase).toBe('awaiting Finish');
    expect(holdTimeline({...base, status: 'DISPUTED'}, now).phrase).toBe('frozen by dispute');
    expect(holdTimeline({...base, status: 'RELEASED', settled_at: '2026-09-06T00:00:00Z'}, now).phrase).toBe('settled');
  });
  it('sub-day countdown reads hours and minutes', () => {
    expect(holdTimeline({...base, release_eligible_at: '2026-09-06T13:30:00Z'}, now).phrase).toBe('auto-releases in 1 h 30 m');
    expect(holdTimeline({...base, release_eligible_at: '2026-09-06T12:05:00Z'}, now).phrase).toBe('auto-releases in 5 m');
  });
});

describe('disputeMode ↔ OpsService.resolveDispute branch selection', () => {
  it('DISPUTED settles, RELEASED claws back, PARTIAL+no_show reverses a fee, anything else is refused', () => {
    expect(disputeMode(SETTLE)).toBe('settle');
    expect(disputeMode(RELEASED)).toBe('clawback');
    expect(disputeMode(NO_SHOW)).toBe('no_show_fee');
    expect(disputeMode({escrow_status: 'PARTIAL', hold_no_show_at: null})).toBe('unresolvable');
    expect(disputeMode({escrow_status: 'HELD', hold_no_show_at: null})).toBe('unresolvable');
    expect(disputeMode({escrow_status: null, hold_no_show_at: null})).toBe('unresolvable');
  });
});

describe('disputePreview — settle from escrow (DISPUTED)', () => {
  it('client 300 / provider 500 → PARTIAL with a 0 platform share (the spec case)', () => {
    const p = disputePreview(SETTLE, {toClient: 300, toProvider: 500});
    expect(p).toMatchObject({mode: 'settle', outcome: 'PARTIAL', toClient: 300, toProvider: 500, platformFee: 0, pullFromProvider: 0, clamped: false});
    expect(p.refusals).toEqual([]);
  });
  it('provider 0 → REFUNDED; client 0 → RELEASED; the unassigned remainder is the platform share', () => {
    expect(disputePreview(SETTLE, {toClient: 800, toProvider: 0}).outcome).toBe('REFUNDED');
    expect(disputePreview(SETTLE, {toClient: 0, toProvider: 800}).outcome).toBe('RELEASED');
    expect(disputePreview(SETTLE, {toClient: 100, toProvider: 500}).platformFee).toBe(200);
  });
  it('reproduces the server clamps and flags them: provider first, client to what is left', () => {
    const p = disputePreview(SETTLE, {toClient: 500, toProvider: 500});
    expect(p).toMatchObject({toProvider: 500, toClient: 300, platformFee: 0, clamped: true});
    const q = disputePreview(SETTLE, {toClient: -20, toProvider: 9_999});
    expect(q).toMatchObject({toProvider: 800, toClient: 0, platformFee: 0, clamped: true, outcome: 'RELEASED'});
  });
  it('a DISPUTED hold is never NO_CHANGE — its money has not moved', () => {
    const p = disputePreview({...SETTLE, hold_to_provider_credits: 800, hold_to_client_credits: 0, hold_platform_fee_credits: 0}, {toClient: 0, toProvider: 800});
    expect(p.outcome).toBe('RELEASED');
  });
});

describe('disputePreview — clawback (RELEASED)', () => {
  it('affirming the executed split exactly is NO_CHANGE (the dispute rejected, nothing moves)', () => {
    const p = disputePreview(RELEASED, {toClient: 0, toProvider: 720});
    expect(p.outcome).toBe('NO_CHANGE');
    expect(p.pullFromProvider).toBe(0);
  });
  it('a full refund pulls the whole gross back from the provider (client 800 + platform 0)', () => {
    const p = disputePreview(RELEASED, {toClient: 800, toProvider: 0});
    expect(p).toMatchObject({outcome: 'CLAWBACK', pullFromProvider: 800, platformFee: 0});
  });
  it('a zero pull that is NOT the executed split is refused (server: clawed:false → 400)', () => {
    const p = disputePreview(RELEASED, {toClient: 0, toProvider: 800});
    expect(p.outcome).toBe('REFUSED');
    expect(p.refusals[0].code).toBe('dispute_resolve_clawback_declined');
  });
  it('CRITIC P1 — the executed split is RE-STATED from what the provider held: 400/400 on 720/0/80 lands 400/320/80', () => {
    // ↔ clawbackReleasedHold: finalToProvider = max(0, to_provider_credits − pull),
    //   finalPlatform = gross − toClient − finalToProvider. The typed 400 is not what lands.
    const p = disputePreview(RELEASED, {toClient: 400, toProvider: 400});
    expect(p).toMatchObject({outcome: 'CLAWBACK', pullFromProvider: 400, toClient: 400, toProvider: 320, platformFee: 80, clamped: true});
    // A null to_provider_credits column reads as the gross (server `?? gross`).
    const q = disputePreview({...RELEASED, hold_to_provider_credits: null}, {toClient: 400, toProvider: 400});
    expect(q).toMatchObject({toClient: 400, toProvider: 400, platformFee: 0, pullFromProvider: 400});
    // Pull can exceed what the provider held: floors at 0, remainder to platform.
    const r = disputePreview({...RELEASED, hold_to_provider_credits: 100}, {toClient: 400, toProvider: 0});
    expect(r).toMatchObject({toClient: 400, toProvider: 0, platformFee: 400, pullFromProvider: 800});
  });

  it('an already-clawed hold refuses a second reclaim', () => {
    const p = disputePreview({...RELEASED, hold_basis: 'clawback', hold_to_provider_credits: 0, hold_to_client_credits: 800, hold_platform_fee_credits: 0}, {toClient: 400, toProvider: 400});
    expect(p.outcome).toBe('REFUSED');
    expect(p.refusals[0].code).toBe('dispute_resolve_clawback_declined');
  });
});

describe('disputePreview — no-show fee reversal (PARTIAL + no_show_at) ↔ the three refusals', () => {
  it('reverses the fee in full: pull = the 200 the provider received', () => {
    const p = disputePreview(NO_SHOW, {toClient: 800, toProvider: 0});
    expect(p).toMatchObject({outcome: 'CLAWBACK', pullFromProvider: 200, toClient: 800, toProvider: 0, platformFee: 0});
  });
  it('reduces the fee partially: provider keeps 50, client gets 150 more', () => {
    const p = disputePreview(NO_SHOW, {toClient: 750, toProvider: 50});
    expect(p).toMatchObject({outcome: 'CLAWBACK', pullFromProvider: 150});
  });
  it('affirming 600/200/0 is NO_CHANGE', () => {
    expect(disputePreview(NO_SHOW, {toClient: 600, toProvider: 200}).outcome).toBe('NO_CHANGE');
  });
  it('cannot INCREASE the provider share on a terminal hold', () => {
    const p = disputePreview(NO_SHOW, {toClient: 500, toProvider: 300});
    expect(p.refusals.map(r => r.code)).toContain('dispute_resolve_cannot_increase_provider_share');
    expect(p.outcome).toBe('REFUSED');
  });
  it('cannot reduce what the client already got back', () => {
    const p = disputePreview(NO_SHOW, {toClient: 500, toProvider: 100});
    expect(p.refusals.map(r => r.code)).toEqual(['dispute_resolve_cannot_reduce_client_refund']);
  });
  it('cannot return a platform share already retained', () => {
    const hold = {...NO_SHOW, hold_to_provider_credits: 150, hold_to_client_credits: 600, hold_platform_fee_credits: 50};
    const p = disputePreview(hold, {toClient: 700, toProvider: 100});
    expect(p.refusals.map(r => r.code)).toEqual(['dispute_resolve_cannot_reduce_platform_share']);
  });
  it('the zero-zero case is refused with the exact pull, never drains the provider', () => {
    // toClient 0 < 600 already refunded → refused on that leg first (server order).
    const p = disputePreview(NO_SHOW, {toClient: 0, toProvider: 0});
    expect(p.outcome).toBe('REFUSED');
    expect(p.refusals[0].code).toBe('dispute_resolve_cannot_reduce_client_refund');
  });
});

describe('disputePreview — refusal ORDER on a clawed-back no-show hold mirrors the server', () => {
  it('the split guards run before the already-clawed refusal (no_show branch), so the first message matches', () => {
    const clawed = {...NO_SHOW, hold_basis: 'clawback'};
    expect(disputePreview(clawed, {toClient: 500, toProvider: 300}).refusals[0].code).toBe('dispute_resolve_cannot_increase_provider_share');
    expect(disputePreview(clawed, {toClient: 800, toProvider: 0}).refusals[0].code).toBe('dispute_resolve_clawback_declined');
  });
});

describe('disputePresets', () => {
  it('a DISPUTED hold offers refund-all, release-all and custom', () => {
    expect(disputePresets(SETTLE).map(p => p.key)).toEqual(['refund_all', 'release_all', 'custom']);
    expect(disputePresets(SETTLE)[1].split).toEqual({toClient: 0, toProvider: 800});
  });
  it('a terminal hold swaps release-all for "affirm" carrying the EXECUTED split', () => {
    const ps = disputePresets(RELEASED);
    expect(ps.map(p => p.key)).toEqual(['refund_all', 'affirm', 'custom']);
    expect(ps[1].split).toEqual({toClient: 0, toProvider: 720});
    expect(disputePreview(RELEASED, ps[1].split!).outcome).toBe('NO_CHANGE');
    expect(disputePresets(NO_SHOW)[1].split).toEqual({toClient: 600, toProvider: 200});
  });
  it('CRITIC P2 — "affirm" is withheld when any executed leg is null (it would execute a clawback, not affirm)', () => {
    const blind = {...RELEASED, hold_platform_fee_credits: null};
    expect(disputePresets(blind).map(p => p.key)).toEqual(['refund_all', 'custom']);
  });

  it('every preset with a split is one the server would accept or record', () => {
    for (const hold of [SETTLE, RELEASED, NO_SHOW]) {
      for (const p of disputePresets(hold)) {
        if (!p.split) continue;
        expect(disputePreview(hold, p.split).outcome).not.toBe('REFUSED');
      }
    }
  });
});
