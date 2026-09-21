// Backend booking statuses are UPPERCASE (`PENDING_OPS`, `OPS_APPROVED`, …)
// while the legacy `BookingStatus` type uses lowercase. This helper maps
// either casing to a display config and identifies bookings that should
// resume the ops-review / payment flow on app re-entry.

export interface StatusDisplay {
  label: string;
  color: string;
  isActive: boolean;
  needsAttention: boolean;
}

const FALLBACK: StatusDisplay = {
  label: 'UNKNOWN', color: '#475569', isActive: false, needsAttention: false,
};

const CONFIG: Record<string, StatusDisplay> = {
  DRAFT:           {label: 'DRAFT',       color: '#475569', isActive: false, needsAttention: false},
  // Auto-dispatch (Uber-style): searching for the nearest agency — active, no attention.
  DISPATCHING:     {label: 'SEARCHING',   color: '#5B8DEF', isActive: true,  needsAttention: false},
  // Ops-gated auto dispatch: an AUTO booking now parks here after submit too
  // ("Submitted — awaiting ops approval", same OpsRoomReview presentation as legacy);
  // the server flips it OPS_APPROVED → DISPATCHING once ops approve.
  PENDING_OPS:     {label: 'PENDING OPS', color: '#FBBF24', isActive: true,  needsAttention: false},
  OPS_APPROVED:    {label: 'APPROVED',    color: '#4ADE80', isActive: true,  needsAttention: true},
  PAYMENT_PENDING: {label: 'PAYMENT DUE', color: '#60A5FA', isActive: true,  needsAttention: true},
  CONFIRMED:       {label: 'CONFIRMED',   color: '#60A5FA', isActive: true,  needsAttention: false},
  LIVE:            {label: 'LIVE',        color: '#4ADE80', isActive: true,  needsAttention: false},
  COMPLETED:       {label: 'COMPLETED',   color: '#475569', isActive: false, needsAttention: false},
  CANCELLED:       {label: 'CANCELLED',   color: '#F87171', isActive: false, needsAttention: false},
  // Auto-dispatch terminal: nobody available. NOT an active booking (must not trap the
  // "one mission at a time" slot) — needsAttention so the home surfaces the fallback.
  NO_PROVIDER:     {label: 'NO DETAIL',   color: '#F5C76B', isActive: false, needsAttention: true},
  // LM-U4 — crew-SLA breach terminal: the agency accepted but never crewed; the
  // client was fully refunded. Rendered the grey UNKNOWN chip before this row.
  AGENCY_NO_SHOW:  {label: 'REFUNDED — AGENCY NO-SHOW', color: '#F5C76B', isActive: false, needsAttention: true},
};

export function describeStatus(raw: string | undefined | null): StatusDisplay {
  if (!raw) {return FALLBACK;}
  return CONFIG[raw.toUpperCase()] ?? FALLBACK;
}

// Bookings that should pull the user back into a flow on app re-entry.
// COMPLETED / CANCELLED are terminal — never resume those. DISPATCHING (auto search)
// resumes into the Finding screen. NO_PROVIDER is DELIBERATELY excluded — it is terminal
// and must not occupy the "one mission at a time" slot (the active-mission trap, LB17).
const RESUMABLE = new Set(['DISPATCHING', 'PENDING_OPS', 'OPS_APPROVED', 'PAYMENT_PENDING', 'CONFIRMED', 'LIVE']);

// B-405 — a PARKED FUTURE RESERVATION: a 'later' booking pre-dispatch
// (PENDING_OPS awaiting approval, or an AUTO booking OPS_APPROVED waiting for
// the T-15 scheduled-dispatch sweep). It must NOT trap the client: no
// auto-resume yank into OpsRoomReview, no "one mission at a time" hero lock —
// the home screen shows it as an upcoming card instead, and the server-side
// guard exempts it the same way so a go-now booking can ride alongside.
//
// A LEGACY (non-auto) 'later' row at OPS_APPROVED is deliberately NOT parked:
// legacy approval means PAYMENT IS DUE NOW (only auto escrow-charges at CPO
// accept), so it must stay resumable — the auto-resume yank into OpsRoomReview
// is what runs the pay countdown. 3-agent review 2026-08-09: classifying it as
// upcoming let the booking die unpaid at pickup+60 (drift-janitor
// stale_uncrewed_expiry) behind a green APPROVED chip.
export function isUpcomingScheduled(
  b: {status?: unknown; booking_mode?: unknown; dispatch_mode?: unknown},
): boolean {
  if (b.booking_mode !== 'later') {return false;}
  const s = typeof b.status === 'string' ? b.status.toUpperCase() : '';
  return s === 'PENDING_OPS' || (s === 'OPS_APPROVED' && b.dispatch_mode === 'auto');
}

// Where to send the user for a given status. Anything not in this map is
// considered terminal and the user stays on the home screen.
export type ResumeTarget =
  | {screen: 'OpsRoomReview'; bookingId: string}
  | {screen: 'BookingConfirmation'; bookingId: string}
  | {screen: 'LiveTracking'; bookingId: string}
  | {screen: 'FindingDetail'; bookingId: string}
  | {screen: 'NoDetail'; bookingId: string};

// LB-OTP1 / LB-ST2 — the booking FSM stays CONFIRMED for the WHOLE mission
// (DISPATCHED → PICKUP → LIVE); only `mission_status` (surfaced on getById and,
// after the LB-ST1 fix, on the list) tracks the live phase. Any of these means a
// crew exists and is en route / on-site, so the user belongs on LiveTracking —
// NOT parked on the static BookingConfirmation (whose Track button was gated on
// booking.status === 'LIVE', a state that only arrives at go-live). This is the
// window in which the verify-guard (team) code is shown, so routing here is what
// makes the OTP reachable on resume + on a deep-link tap.
// 2026-09-04 — CREWED (crew named, not yet dispatched) belongs on LiveTracking too:
// the tracker is where "team assigned · not yet dispatched" is rendered honestly.
// The verify (team) code itself appears only once the team is DISPATCHED (parity
// with the officer's code window) — a crew that has not left has nobody to show it to.
const MISSION_LIVE_STATES = new Set(['CREWED', 'DISPATCHED', 'PICKUP', 'LIVE', 'SOS']);

export function resumeTargetFor(
  id: string,
  raw: string | undefined | null,
  missionRaw?: string | undefined | null,
): ResumeTarget | null {
  const s = (raw ?? '').toUpperCase();
  const ms = (missionRaw ?? '').toUpperCase();
  // A live mission wins over the (intentionally lagging) booking status.
  if (MISSION_LIVE_STATES.has(ms)) {return {screen: 'LiveTracking', bookingId: id};}
  if (s === 'DISPATCHING')  {return {screen: 'FindingDetail', bookingId: id};}
  if (s === 'PENDING_OPS' || s === 'OPS_APPROVED' || s === 'PAYMENT_PENDING') {
    return {screen: 'OpsRoomReview', bookingId: id};
  }
  if (s === 'CONFIRMED') {return {screen: 'BookingConfirmation', bookingId: id};}
  if (s === 'LIVE')      {return {screen: 'LiveTracking', bookingId: id};}
  if (s === 'NO_PROVIDER') {return {screen: 'NoDetail', bookingId: id};}
  return null;
}

// Convenience overload for callers holding a booking-ish object with both fields.
export function liveTargetFor(
  b: {id: string; status?: string | null; mission_status?: string | null},
): ResumeTarget | null {
  return resumeTargetFor(b.id, b.status, b.mission_status);
}

/**
 * 2026-09-04 — with several bookings per customer, Home may only auto-resume
 * into a booking that is IN PROGRESS NOW: a live search, a live mission, or a
 * confirmed booking whose start is within this window. A confirmed booking for
 * tomorrow is an "Upcoming" row the customer taps deliberately, never a yank.
 */
export const RESUME_SOON_MS = 2 * 60 * 60_000;

export function isInProgressNow(
  b: {status?: unknown; mission_status?: unknown; start_time?: unknown; booking_mode?: unknown; dispatch_mode?: unknown},
  now: number = Date.now(),
): boolean {
  if (isUpcomingScheduled(b)) {return false;}
  const s = typeof b.status === 'string' ? b.status.toUpperCase() : '';
  const ms = typeof b.mission_status === 'string' ? b.mission_status.toUpperCase() : '';
  if (MISSION_LIVE_STATES.has(ms)) {return true;}
  if (s === 'DISPATCHING' || s === 'LIVE') {return true;}
  if (!RESUMABLE.has(s)) {return false;}
  // Only a CONFIRMED booking can be "for later". Every other resumable state owes
  // the customer an action NOW — an approval wait (PENDING_OPS 'now'), or PAYMENT
  // DUE: a legacy 'later' row at OPS_APPROVED / PAYMENT_PENDING (B-405 — the
  // auto-resume yank into OpsRoomReview is what runs the pay countdown; parking
  // it let the booking die unpaid at pickup+60 behind a green APPROVED chip).
  if (s !== 'CONFIRMED') {return true;}
  const start = typeof b.start_time === 'string' ? new Date(b.start_time).getTime() : NaN;
  // No start (legacy row) or a start already inside the window → in progress.
  return !Number.isFinite(start) || start - now <= RESUME_SOON_MS;
}

export function findResumableBooking<T extends {id: string; status?: unknown; booking_mode?: unknown; mission_status?: unknown; start_time?: unknown}>(
  bookings: readonly T[],
  excludeIds?: ReadonlySet<string>,
  now: number = Date.now(),
): T | undefined {
  // Soonest first, so with two in-progress bookings the nearer one wins.
  const sorted = [...bookings].sort((a, b) => {
    const ta = typeof a.start_time === 'string' ? new Date(a.start_time).getTime() : Number.POSITIVE_INFINITY;
    const tb = typeof b.start_time === 'string' ? new Date(b.start_time).getTime() : Number.POSITIVE_INFINITY;
    return ta - tb;
  });
  return sorted.find(b => {
    if (excludeIds?.has(b.id)) {return false;}
    // B-405 — never auto-yank the user into a parked future reservation:
    // "after making a future booking it needs to go back to the normal
    // screen" (founder, 2026-08-09). Explicit taps still navigate to it.
    if (isUpcomingScheduled(b)) {return false;}
    return isInProgressNow(b, now);
  });
}

// ─── B-786 — the ONE row vocabulary for the booking-history surface ──────────
//
// `describeStatus` above answers "what is this booking's status chip?" and is
// kept verbatim for its existing callers. A history ROW has to answer a second
// question the status alone cannot: WHERE IS THE MONEY. A booking sits at
// COMPLETED for the whole dispute window while the credits are still held, and
// "COMPLETED" on its own tells the client nothing about that.
//
// So a row chip is (status × mission × payment) and it is built HERE, once, for
// every surface that renders a booking row.

/** Coarse presentation bucket. The server buckets by status alone (it has to —
 *  paging happens in SQL); this is the finer split the UI needs, and it is the
 *  only place that consults `mission_status` and the B-405 parked rule. */
export type RowBucket = 'active' | 'upcoming' | 'past' | 'cancelled';

export interface RowStatus {
  /** What is happening: 'PROTECTION ACTIVE', 'COMPLETED', 'CANCELLED'. */
  label: string;
  /** Where the money is: 'PAID', 'ON HOLD', 'REFUNDED'… `null` when nothing
   *  ever moved, so the chip stays a single honest word. */
  money: string | null;
  color: string;
  bucket: RowBucket;
}

/** Payment states as returned by GET /bookings/history (`payment.state`). */
export type RowPaymentState =
  | 'due' | 'paid' | 'held' | 'released'
  | 'refunded' | 'partially_refunded' | 'under_review' | 'not_charged';

const C = {
  live:   '#4ADE80',
  active: '#5B8DEF',
  wait:   '#FBBF24',
  info:   '#60A5FA',
  done:   '#475569',
  bad:    '#F87171',
  warn:   '#F5C76B',
} as const;

// A live mission beats the (intentionally lagging) booking status — the same
// precedence `resumeTargetFor` uses, so the chip and the tap target can never
// tell the user two different stories.
// 2026-09-04 — "Accepted is not Dispatched": CREWED reads TEAM ASSIGNED, and
// only the explicit DISPATCHED state reads dispatched.
const MISSION_CHIP: Record<string, {label: string; color: string}> = {
  CREWED:     {label: 'TEAM ASSIGNED',     color: C.info},
  DISPATCHED: {label: 'TEAM DISPATCHED',   color: C.active},
  PICKUP:     {label: 'ARRIVED',           color: C.active},
  LIVE:       {label: 'PROTECTION ACTIVE', color: C.live},
  SOS:        {label: 'SOS',               color: C.bad},
};

const STATUS_CHIP: Record<string, {label: string; color: string; bucket: RowBucket}> = {
  DISPATCHING:     {label: 'SEARCHING',          color: C.active, bucket: 'active'},
  PENDING_OPS:     {label: 'AWAITING APPROVAL',  color: C.wait,   bucket: 'active'},
  OPS_APPROVED:    {label: 'APPROVED',           color: C.live,   bucket: 'active'},
  PAYMENT_PENDING: {label: 'PAYMENT DUE',        color: C.info,   bucket: 'active'},
  CONFIRMED:       {label: 'CONFIRMED',          color: C.info,   bucket: 'active'},
  LIVE:            {label: 'PROTECTION ACTIVE',  color: C.live,   bucket: 'active'},
  COMPLETED:       {label: 'COMPLETED',          color: C.done,   bucket: 'past'},
  CANCELLED:       {label: 'CANCELLED',          color: C.bad,    bucket: 'cancelled'},
  NO_PROVIDER:     {label: 'NO DETAIL AVAILABLE', color: C.warn,  bucket: 'cancelled'},
  AGENCY_NO_SHOW:  {label: 'AGENCY NO-SHOW',     color: C.warn,   bucket: 'cancelled'},
  DRAFT:           {label: 'DRAFT',              color: C.done,   bucket: 'past'},
};

const MONEY_WORD: Record<RowPaymentState, string | null> = {
  due:                'PAYMENT DUE',
  paid:               'PAID',
  released:           'PAID',
  held:               'ON HOLD',
  refunded:           'REFUNDED',
  partially_refunded: 'PARTLY REFUNDED',
  under_review:       'UNDER REVIEW',
  // Nothing ever moved (NO_PROVIDER, a cancel before capture, a legacy row).
  // Rendering "NOT CHARGED" beside CANCELLED is noise, so it stays silent.
  not_charged:        null,
};

const TERMINAL = new Set(['COMPLETED', 'CANCELLED', 'NO_PROVIDER', 'AGENCY_NO_SHOW']);

/**
 * After these nothing can still be running, whatever a stale `missions` row
 * says. Exported because the TAP TARGET needs the same answer the CHIP gets:
 * `resumeTargetFor` checks `mission_status` first and must keep doing so (the
 * booking FSM stays CONFIRMED for a whole mission, which is what makes Home's
 * auto-resume work), but that precedence is wrong once the booking itself has
 * finished — it made a row render COMPLETED while tapping it opened
 * LiveTracking.
 */
export function isTerminalBookingStatus(raw: string | null | undefined): boolean {
  return TERMINAL.has((raw ?? '').toUpperCase());
}
const MISSION_ACTIVE = new Set(['CREWED', 'DISPATCHED', 'PICKUP', 'LIVE', 'SOS']);

export interface RowStatusInput {
  status?: string | null;
  mission_status?: string | null;
  payment_state?: RowPaymentState | null;
  booking_mode?: string | null;
  dispatch_mode?: string | null;
  start_time?: string | null;
}

/**
 * The row chip. `now` is injected so the upcoming/active boundary is testable
 * to the millisecond rather than depending on when the suite runs.
 */
export function describeBookingRow(b: RowStatusInput, now: number = Date.now()): RowStatus {
  const s = (b.status ?? '').toUpperCase();
  const ms = (b.mission_status ?? '').toUpperCase();
  const base = STATUS_CHIP[s];
  const money = b.payment_state ? MONEY_WORD[b.payment_state] ?? null : null;

  // An SOS outranks everything, including a booking that already reads terminal.
  if (ms === 'SOS') {
    return {label: 'SOS', money, color: C.bad, bucket: 'active'};
  }

  // A terminal booking is history even if a stale mission row still says LIVE —
  // otherwise an ABORTED-then-completed booking would show as running forever.
  if (TERMINAL.has(s)) {
    const chip = base ?? {label: s || 'UNKNOWN', color: C.done, bucket: 'past' as RowBucket};
    return {
      label: chip.label,
      money,
      // The money word carries the alarm when payment is contested.
      color: b.payment_state === 'under_review' ? C.warn : chip.color,
      bucket: chip.bucket,
    };
  }

  if (MISSION_ACTIVE.has(ms)) {
    const chip = MISSION_CHIP[ms];
    return {label: chip.label, money, color: chip.color, bucket: 'active'};
  }

  if (!base) {
    return {label: s || 'UNKNOWN', money, color: C.done, bucket: 'past'};
  }

  return {label: base.label, money, color: base.color, bucket: bucketFor(b, now)};
}

/**
 * Which section a row belongs to.
 *
 * The one subtlety is CONFIRMED: a confirmed booking with no crew yet and a
 * start time still ahead is UPCOMING, not active — pinning it to the active
 * card would make a reservation made weeks early look like a running mission.
 * Once a mission exists, or the start time has passed, it is active.
 */
export function bucketFor(b: RowStatusInput, now: number = Date.now()): RowBucket {
  const s = (b.status ?? '').toUpperCase();
  const ms = (b.mission_status ?? '').toUpperCase();
  if (TERMINAL.has(s)) {return STATUS_CHIP[s]?.bucket ?? 'past';}
  if (MISSION_ACTIVE.has(ms)) {return 'active';}
  // B-405 — a parked future reservation must not read as a running mission.
  if (isUpcomingScheduled(b)) {return 'upcoming';}
  if (s === 'CONFIRMED') {
    const t = b.start_time ? new Date(b.start_time).getTime() : NaN;
    return Number.isFinite(t) && t > now ? 'upcoming' : 'active';
  }
  return STATUS_CHIP[s]?.bucket ?? 'past';
}
