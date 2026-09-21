/**
 * B-807 — the escrow rulebook the Finance › Escrow / Disputes pages explain a
 * decision with, as PURE functions (no SWR, no Next, no DOM) so the node test
 * project can pin every number against the server's own arithmetic.
 *
 * Every formula here MIRRORS a server rule and names it. The server is the
 * authority (it clamps, refuses and audits); this module exists so the operator
 * sees, BEFORE they press the button, exactly what the server is going to do —
 * a money dialog that shows a different number from the one that lands is
 * worse than one that shows none.
 *
 *   reviewReleasePreview  ↔ wallet.service.ts releaseEscrowHold (fee rounding)
 *   disputeMode           ↔ ops.service.ts resolveDispute branch selection
 *   disputePreview        ↔ resolveDispute clamps + the three clawback refusals
 *   holdTimeline          ↔ agent.service.ts settleEscrowOnFinish (window stamp)
 */

// ─── Lifecycle ────────────────────────────────────────────────────────────

export type EscrowStatus = 'HELD' | 'PENDING_RELEASE' | 'DISPUTED' | 'RELEASED' | 'REFUNDED' | 'PARTIAL';

export interface EscrowStateRule {
  status: EscrowStatus;
  title: string;
  /** Where the money physically is. */
  money: string;
  /** What moves it on, and who. */
  next: string;
  /** Terminal = no further transition; only a dispute clawback can touch it. */
  terminal: boolean;
}

export const ESCROW_STATE_RULES: readonly EscrowStateRule[] = [
  {
    status: 'HELD', title: 'Held',
    money: 'In the platform escrow account. The client has been charged; the provider has been paid nothing.',
    next: 'The assigned lead presses Finish → the proof-of-completion gate runs. PASS → Pending release. FAIL → stays Held with REVIEW REQUIRED (operator only). A cancel, no-show or abort settles it to Refunded / Partial instead.',
    terminal: false,
  },
  {
    status: 'PENDING_RELEASE', title: 'Pending release',
    money: 'Still in escrow. The dispute window is running.',
    next: 'When the window closes the release sweep (every minute) pays the provider automatically. The client can confirm early (releases now) or open a dispute (freezes it). A dispute racing the sweep always wins.',
    terminal: false,
  },
  {
    status: 'DISPUTED', title: 'Disputed',
    money: 'Frozen in escrow. Nothing moves until an operator resolves the dispute.',
    next: 'Finance › Disputes → Resolve with a final split (client / provider / platform).',
    terminal: false,
  },
  {
    status: 'RELEASED', title: 'Released',
    money: 'Paid: provider received gross minus the platform fee; the fee is in the platform account.',
    next: 'Terminal. A later upheld dispute becomes a CLAWBACK from the provider wallet.',
    terminal: true,
  },
  {
    status: 'REFUNDED', title: 'Refunded',
    money: 'Returned in full to the client wallet.',
    next: 'Terminal.',
    terminal: true,
  },
  {
    status: 'PARTIAL', title: 'Partial',
    money: 'Split between provider and client (a cancellation fee, a client no-show fee, or a mid-mission pro-rata).',
    next: 'Terminal. Only a client no-show fee can still be disputed (reversed or reduced, never increased).',
    terminal: true,
  },
];

export function escrowStateRule(status: string | null | undefined): EscrowStateRule | undefined {
  return ESCROW_STATE_RULES.find(r => r.status === status);
}

/** How a terminal hold's split was produced (`escrow_holds.basis`). */
export const ESCROW_BASIS_LABELS: Record<string, string> = {
  full_release: 'Full release to provider (proof gate passed, window elapsed or client confirmed)',
  refund: 'Full refund to client',
  partial: 'Cancellation / no-show fee (cancel_fee_pct to provider, rest refunded)',
  pro_rata: 'Mid-mission abort — provider paid for minutes on task, rest refunded',
  clawback: 'Clawed back after payout (dispute upheld)',
};

// ─── The proof-of-completion gate ─────────────────────────────────────────

export interface GateReasonRule {
  id: string;
  title: string;
  /** What the server checked. */
  check: string;
  /** What a human should look at before overriding. */
  verify: string;
}

/**
 * Mirrors `proof-of-completion.service.ts` reason ids. An unknown id (a check
 * added server-side later) still renders — as its raw id — rather than hiding.
 */
export const GATE_REASON_RULES: readonly GateReasonRule[] = [
  {
    id: 'no_progression', title: 'No real progression',
    check: 'The mission never went PICKUP → LIVE in order (a one-tap jump, or a Finish with no pickup recorded).',
    verify: 'Mission timeline: pickup_at and live_at both stamped, pickup before live.',
  },
  {
    id: 'never_reached_pickup', title: 'Never reached the pickup point',
    check: 'No GPS fix from the crew inside the arrival radius (default 150 m) of the booking pickup.',
    verify: 'Live map / telemetry trail for the mission against the pickup pin; the client\'s own account of the pickup.',
  },
  {
    id: 'no_pickup_coords', title: 'Booking has no pickup coordinates',
    check: 'The booking row carries no pickup lat/lng, so presence at pickup could not be tested at all.',
    verify: 'The booking address; whether the detail was location-anchored; agency + client statements.',
  },
  {
    id: 'insufficient_telemetry', title: 'Too little telemetry while live',
    check: 'Fewer GPS pings during LIVE than the minimum (default 5) — a 30-second "live" or a dead tracker.',
    verify: 'Telemetry count and gaps; whether the lead\'s phone was tracking; the mission duration.',
  },
  {
    id: 'too_short', title: 'On-task time too short',
    check: 'LIVE lasted less than the minimum on-task time (default 300 s).',
    verify: 'live_at → ended_at against the booked duration; whether the client ended it early.',
  },
  {
    id: 'no_live_movement', title: 'No movement while live',
    check: 'All LIVE fixes sit inside a tiny bounding box (default 25 m) — the shape of fabricated telemetry.',
    verify: 'Whether the detail was genuinely stationary (residential / site block) — that is a legitimate PASS override.',
  },
  {
    id: 'no_presence_checkins', title: 'No hourly presence check-ins',
    check: 'A location-anchored detail (Executive Protection / no transfer leg) produced fewer hourly check-ins than required for the hours that came due.',
    verify: 'The check-in log for the mission; whether the lead was on post; client confirmation.',
  },
  {
    id: 'identity_unverified', title: 'Guard identity never verified',
    check: 'The lead never entered the client-displayed arrival code, so the server has no proof the assigned guard was the person who turned up.',
    verify: 'Client confirmation of who attended; agency roster; any in-app messages between the parties.',
  },
  {
    id: 'mission_or_booking_missing', title: 'Mission or booking row missing',
    check: 'The gate could not load the mission or its booking — a data problem, not a field problem.',
    verify: 'Escalate to engineering before moving money.',
  },
];

export function gateReasonRule(id: string): GateReasonRule {
  return GATE_REASON_RULES.find(r => r.id === id) ?? {
    id, title: id.replace(/_/g, ' '),
    check: 'A newer proof-of-completion check the console does not describe yet.',
    verify: 'Check the auth-service log line dispatch.completion_gate_fail for this booking.',
  };
}

// ─── Review-hold release preview ──────────────────────────────────────────

export interface ReleasePreview {
  gross: number;
  feePct: number;
  platformFee: number;
  toProvider: number;
}

/**
 * ↔ `WalletService.releaseEscrowHold`:
 *   platformFee = min(gross, max(0, round(gross * feePct / 100)))
 *   toProvider  = gross − platformFee
 * Integer credits in, integer credits out. An UNKNOWN fee (board not fetched,
 * region unknown, fetch failed) returns null — the dialog must then show no
 * number at all. The server never applies 0 by default (its env base is 15),
 * so printing a 0-fee amount would tell the operator "release 800" for a
 * payout of 680.
 */
export function reviewReleasePreview(gross: number, feePct: number | null | undefined): ReleasePreview | null {
  if (typeof feePct !== 'number' || !Number.isFinite(feePct) || feePct < 0) return null;
  const g = Math.max(0, Math.round(Number(gross) || 0));
  const platformFee = Math.min(g, Math.max(0, Math.round((g * feePct) / 100)));
  return {gross: g, feePct, platformFee, toProvider: g - platformFee};
}

// ─── Hold timeline ────────────────────────────────────────────────────────

export interface HoldTimeline {
  /** Dispute window in whole hours, derived from completed_at → release_eligible_at. */
  windowHours: number | null;
  /** ms until auto-release; negative = the sweep is already due. null = no window running. */
  msUntilRelease: number | null;
  /** Human phrase for the timeline column. */
  phrase: string;
}

export function holdTimeline(
  row: {status: string; review_required: boolean; completed_at: string | null; release_eligible_at: string | null; settled_at: string | null},
  now: number = Date.now(),
): HoldTimeline {
  if (row.settled_at) return {windowHours: null, msUntilRelease: null, phrase: 'settled'};
  if (row.status === 'HELD' && row.review_required) {
    return {windowHours: null, msUntilRelease: null, phrase: 'parked — will not auto-release'};
  }
  if (row.status === 'HELD') return {windowHours: null, msUntilRelease: null, phrase: 'awaiting Finish'};
  if (row.status === 'DISPUTED') return {windowHours: null, msUntilRelease: null, phrase: 'frozen by dispute'};
  if (row.status !== 'PENDING_RELEASE' || !row.release_eligible_at) {
    return {windowHours: null, msUntilRelease: null, phrase: '—'};
  }
  const releaseAt = new Date(row.release_eligible_at).getTime();
  const completedAt = row.completed_at ? new Date(row.completed_at).getTime() : NaN;
  const windowHours = Number.isFinite(completedAt) && releaseAt >= completedAt
    ? Math.round((releaseAt - completedAt) / 3_600_000)
    : null;
  const ms = releaseAt - now;
  if (ms <= 0) return {windowHours, msUntilRelease: ms, phrase: 'auto-release due (sweep runs every minute)'};
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const left = h >= 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : h > 0 ? `${h} h ${m} m` : `${m} m`;
  return {windowHours, msUntilRelease: ms, phrase: `auto-releases in ${left}`};
}

// ─── Dispute resolution ───────────────────────────────────────────────────

export type DisputeMode = 'settle' | 'clawback' | 'no_show_fee' | 'unresolvable';

export interface DisputeHold {
  escrow_status: string | null;
  gross_credits: number | null;
  hold_basis: string | null;
  hold_to_provider_credits: number | null;
  hold_to_client_credits: number | null;
  hold_platform_fee_credits: number | null;
  hold_no_show_at: string | null;
}

/**
 * ↔ `OpsService.resolveDispute` branch selection:
 *   DISPUTED                  → settle from escrow (money has not moved)
 *   RELEASED                  → clawback from the provider wallet
 *   PARTIAL with no_show_at   → no-show fee reversal (a narrow clawback)
 *   anything else             → the server refuses (dispute_resolve_invalid_hold_state)
 */
export function disputeMode(h: Pick<DisputeHold, 'escrow_status' | 'hold_no_show_at'>): DisputeMode {
  if (h.escrow_status === 'DISPUTED') return 'settle';
  if (h.escrow_status === 'RELEASED') return 'clawback';
  if (h.escrow_status === 'PARTIAL' && h.hold_no_show_at) return 'no_show_fee';
  return 'unresolvable';
}

export const DISPUTE_MODE_RULES: Record<DisputeMode, {title: string; body: string}> = {
  settle: {
    title: 'Money is still in escrow',
    body: 'The hold is DISPUTED, so nothing has been paid yet. Your split moves it now: client ← to_client, provider ← to_provider, and whatever is left stays with the platform. The hold becomes REFUNDED (provider 0), RELEASED (client 0) or PARTIAL.',
  },
  clawback: {
    title: 'Money was already paid out — this is a clawback',
    body: 'The hold is RELEASED: the provider already received gross minus the platform fee. Your split is the FINAL position; the difference is reclaimed from the provider wallet (the platform fronts any shortfall the provider cannot cover, and that shows up on the daily reconciliation).',
  },
  no_show_fee: {
    title: 'A client no-show fee — reverse or reduce it',
    body: 'The lead declared a client no-show at pickup; the provider kept the cancellation fee and the client was refunded the rest. You can give the client back some or all of that fee. You cannot pay the provider more than it already holds, and you cannot take back what the client or the platform already received.',
  },
  unresolvable: {
    title: 'This hold cannot be resolved from here',
    body: 'Only a DISPUTED hold, a RELEASED hold, or a PARTIAL hold that came from a client no-show can be resolved. Anything else (a cancellation fee, a mid-mission pro-rata, a hold still HELD) the server refuses.',
  },
};

export interface DisputeSplitRequest {
  toClient: number;
  toProvider: number;
}

export type DisputeOutcome = 'REFUNDED' | 'RELEASED' | 'PARTIAL' | 'CLAWBACK' | 'NO_CHANGE' | 'REFUSED';

export interface DisputePreview {
  mode: DisputeMode;
  gross: number;
  /** The split the server will EXECUTE after its clamps (what to show, not what was typed). */
  toClient: number;
  toProvider: number;
  platformFee: number;
  /** Clawback modes only: credits pulled from the provider wallet by this resolution. */
  pullFromProvider: number;
  outcome: DisputeOutcome;
  /** Why the server would refuse (empty when it would accept). Codes mirror the server's. */
  refusals: Array<{code: string; message: string}>;
  /** Server-side clamping changed what was typed — tell the operator before they press. */
  clamped: boolean;
}

/**
 * ↔ `OpsService.resolveDispute`. Reproduces, in order:
 *   1. the clamps: toProvider = min(gross, max(0, round(req)));
 *                  toClient   = min(gross − toProvider, max(0, round(req)));
 *                  platformFee = gross − toProvider − toClient
 *   2. NO_CHANGE when a TERMINAL hold's executed split is affirmed exactly (the
 *      "dispute rejected" outcome — records the decision, moves nothing)
 *   3. per-mode execution + the no-show refusals
 *      (cannot_increase_provider_share / cannot_reduce_client_refund /
 *       cannot_reduce_platform_share / pull_exceeds_provider_credits / no_change)
 *   4. RELEASED clawback: a zero pull is refused (clawback_declined)
 */
export function disputePreview(h: DisputeHold, req: DisputeSplitRequest): DisputePreview {
  const mode = disputeMode(h);
  const gross = Math.max(0, Math.round(Number(h.gross_credits) || 0));
  const reqP = Number.isFinite(req.toProvider) ? Math.round(req.toProvider) : 0;
  const reqC = Number.isFinite(req.toClient) ? Math.round(req.toClient) : 0;
  const toProvider = Math.min(gross, Math.max(0, reqP));
  const toClient = Math.min(gross - toProvider, Math.max(0, reqC));
  const platformFee = gross - toProvider - toClient;
  const clamped = toProvider !== reqP || toClient !== reqC;
  const refusals: Array<{code: string; message: string}> = [];
  const base = {mode, gross, toClient, toProvider, platformFee, clamped};

  if (mode === 'unresolvable') {
    refusals.push({code: 'dispute_resolve_invalid_hold_state', message: DISPUTE_MODE_RULES.unresolvable.body});
    return {...base, pullFromProvider: 0, outcome: 'REFUSED', refusals};
  }

  const execP = h.hold_to_provider_credits ?? 0;
  const execC = h.hold_to_client_credits ?? 0;
  const execF = h.hold_platform_fee_credits ?? 0;
  const terminal = mode === 'clawback' || mode === 'no_show_fee';
  if (terminal && toProvider === execP && toClient === execC && platformFee === execF) {
    return {...base, pullFromProvider: 0, outcome: 'NO_CHANGE', refusals};
  }
  // ↔ WalletService.clawbackReleasedHold: a hold whose basis is already
  // 'clawback' has been reclaimed once and never reclaims again (clawed:false
  // → the server fails closed with dispute_resolve_clawback_declined). On the
  // RELEASED branch the server calls the primitive directly, so this is the
  // first refusal it can hit; on the no-show branch the three split guards run
  // BEFORE the primitive, so there it is checked after them (same order, same
  // message the operator would see).
  const alreadyClawed = {code: 'dispute_resolve_clawback_declined', message: 'This hold has already been clawed back once; a second reclaim is refused. Only affirming the executed split is possible now.'};
  if (mode === 'clawback' && h.hold_basis === 'clawback') {
    refusals.push(alreadyClawed);
    return {...base, pullFromProvider: 0, outcome: 'REFUSED', refusals};
  }

  if (mode === 'settle') {
    const outcome: DisputeOutcome = toProvider === 0 ? 'REFUNDED' : toClient === 0 ? 'RELEASED' : 'PARTIAL';
    return {...base, pullFromProvider: 0, outcome, refusals};
  }

  if (mode === 'clawback') {
    // The server pulls (toClient + platformFee) from the provider, then RE-STATES
    // the hold from what the provider actually held (`to_provider_credits`, or
    // the gross if the column is null):
    //   finalToProvider = max(0, paidToProvider − pull)
    //   finalPlatform   = gross − toClient − finalToProvider
    // So the typed "to provider" is NOT what lands — the executed split is what
    // the audit row and the ledger carry, and it is what the dialog must show.
    const pull = toClient + platformFee;
    if (pull <= 0) {
      refusals.push({code: 'dispute_resolve_clawback_declined', message: 'Nothing to reclaim: the provider would keep the whole gross. To reject the dispute, affirm the executed split instead.'});
      return {...base, pullFromProvider: pull, outcome: 'REFUSED', refusals};
    }
    const paidToProvider = h.hold_to_provider_credits ?? gross;
    const finalToProvider = Math.max(0, paidToProvider - pull);
    const finalPlatform = gross - toClient - finalToProvider;
    return {
      ...base,
      toProvider: finalToProvider, platformFee: finalPlatform,
      clamped: clamped || finalToProvider !== toProvider || finalPlatform !== platformFee,
      pullFromProvider: pull, outcome: 'CLAWBACK', refusals,
    };
  }

  // no_show_fee
  if (toProvider > execP) {
    refusals.push({code: 'dispute_resolve_cannot_increase_provider_share', message: `A no-show fee can be reversed or reduced, never increased — the provider holds ${execP} BC and the hold is already settled.`});
  }
  if (toClient < execC) {
    refusals.push({code: 'dispute_resolve_cannot_reduce_client_refund', message: `The client has already been refunded ${execC} BC on this booking; a resolution can add to that, never take it back.`});
  }
  if (platformFee < execF) {
    refusals.push({code: 'dispute_resolve_cannot_reduce_platform_share', message: `The platform has already retained ${execF} BC on this booking; a resolution cannot return it.`});
  }
  const deltaClient = Math.max(0, toClient - execC);
  const deltaPlatform = Math.max(0, platformFee - execF);
  const pull = deltaClient + deltaPlatform;
  if (refusals.length === 0 && pull > execP - toProvider) {
    refusals.push({code: 'dispute_resolve_pull_exceeds_provider_credits', message: `This would reclaim ${pull} BC from a provider that received ${execP} BC and keeps ${toProvider} BC under it.`});
  }
  if (refusals.length === 0 && pull === 0) {
    refusals.push({code: 'dispute_resolve_no_change', message: 'This split moves nothing. To reject the dispute, affirm the executed split exactly.'});
  }
  if (refusals.length === 0 && h.hold_basis === 'clawback') {
    refusals.push(alreadyClawed);
  }
  return {...base, pullFromProvider: pull, outcome: refusals.length ? 'REFUSED' : 'CLAWBACK', refusals};
}

export interface DisputePreset {
  key: 'refund_all' | 'release_all' | 'affirm' | 'custom';
  label: string;
  hint: string;
  split: DisputeSplitRequest | null;
}

/**
 * The three decisions an operator actually makes, as one-click presets, plus
 * custom. Terminal modes get "affirm" (reject the dispute, move nothing) in
 * place of "release all" (which on a RELEASED hold is the same thing, and on a
 * no-show hold is refused).
 */
export function disputePresets(h: DisputeHold): DisputePreset[] {
  const mode = disputeMode(h);
  const gross = Math.max(0, Math.round(Number(h.gross_credits) || 0));
  const presets: DisputePreset[] = [
    {key: 'refund_all', label: 'Uphold — full refund to client', hint: 'Client gets the whole gross back; provider and platform keep nothing.', split: {toClient: gross, toProvider: 0}},
  ];
  if (mode === 'settle') {
    presets.push({key: 'release_all', label: 'Reject — release to provider', hint: 'Provider is paid the whole gross; no platform fee is taken on a resolved dispute unless you leave some unassigned.', split: {toClient: 0, toProvider: gross}});
  } else if (
    (mode === 'clawback' || mode === 'no_show_fee')
    // "Affirm" is only an affirmation when the executed split is KNOWN. With a
    // null leg the server's `?? 0` reading of the same row would fail the
    // NO_CHANGE equality and execute a clawback instead — a preset labelled
    // "moves no money" must never be able to move money.
    && h.hold_to_client_credits != null && h.hold_to_provider_credits != null && h.hold_platform_fee_credits != null
  ) {
    presets.push({
      key: 'affirm', label: 'Reject — the executed split stands',
      hint: 'Records the decision and moves no money.',
      split: {toClient: h.hold_to_client_credits, toProvider: h.hold_to_provider_credits},
    });
  }
  presets.push({key: 'custom', label: 'Custom split', hint: 'Type both legs; the remainder stays with the platform.', split: null});
  return presets;
}
