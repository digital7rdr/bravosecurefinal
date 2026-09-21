/**
 * B-786 — the pure view-model behind every booking-history ROW.
 *
 * Founder, 2026-09-03: _"the booking summary is not ok, no history coming. this
 * should be very rich, like each booking with type, payment, time, category, all
 * industry standard."_ A row therefore has to answer five questions at a glance:
 * WHAT (service + category), WHEN (date **and** time, local, with duration),
 * WHERE (route, or "protection only"), WHAT HAPPENED (one chip carrying status
 * AND where the money is), HOW MUCH (amount + how it was paid).
 *
 * Kept free of RN/Expo imports so the node `booking` Jest project pins it —
 * the same rule `bookingSummaryRows.ts` follows, and the reason the formatting
 * bugs in the old list were never caught.
 *
 * TIME IS LOCAL, ALWAYS. The screen this replaces formatted with
 * `timeZone: 'UTC'` (B-786b), so a 01:00 Gulf booking was dated the previous
 * day — the exact defect a review round already rejected once on the summary
 * rows ("14:30Z" for a time the user picked as "2:30 PM").
 */
import {formatTime12h} from '../../components/booking/time12h';
import {SERVICE_LABELS} from './bookingSummaryRows';
import {execTaskLabel, isExecTaskType} from '../executive/executiveProduct';
import {describeBookingRow, type RowBucket, type RowPaymentState, type RowStatus} from './bookingStatus';

/** Structural subset shared by the rich history DTO and the plain wire Booking,
 *  so the same builder renders a freshly-created booking from the store and a
 *  fully-enriched history row without two code paths. */
export interface HistoryRowInput {
  id: string;
  reference?: string | null;
  status?: string | null;
  mission_status?: string | null;
  service?: string | null;
  type?: string | null;
  task_type?: string | null;
  booking_mode?: string | null;
  dispatch_mode?: string | null;
  start_time?: string | null;
  created_at?: string | null;
  duration_hours?: number | null;
  region_code?: string | null;
  region_label?: string | null;
  pickup_address?: string | null;
  dropoff_address?: string | null;
  pickup?: {address?: string; label?: string} | null;
  dropoff?: {address?: string; label?: string} | null;
  cpo_count?: number | null;
  vehicle_count?: number | null;
  driver_only?: boolean | null;
  requirements?: {armed?: boolean; female?: boolean; driver_only?: boolean} | null;
  exec_transport?: {mode?: string} | null;
  total_eur?: number | null;
  total_price?: number | null;
  estimated_price?: number | null;
  payment?: {
    method?: string | null;
    payer?: string | null;
    /** B-843/A18 — WHICH root paid; a member may be under several. */
    payer_name?: string | null;
    quoted_credits?: number | null;
    charged_credits?: number | null;
    refunded_credits?: number | null;
    state?: RowPaymentState | null;
  } | null;
  payment_method?: string | null;
  receipt?: {invoice_number?: string | null} | null;
  rating?: {stars?: number | null} | number | null;
  mission?: {lead?: {call_sign?: string | null} | null; short_code?: string | null} | null;
}

export interface HistoryRowVM {
  id: string;
  reference: string;
  /** "Executive Protection · Event Security" */
  title: string;
  /** "Tue 02 Sep · 6:30 PM · 4 h" — local clock, never UTC. */
  when: string;
  /** "Marina → DIFC", "Protection only", or "" when nothing is known. */
  where: string;
  /** "1 CPO · 1 vehicle" plus any requirement words. */
  team: string;
  status: RowStatus;
  bucket: RowBucket;
  /** "980 BC", "−480 BC", or "" when there is no figure to show. */
  amount: string;
  /** How it was paid: "Credits", "Card", "Paid by family". `null` = unknown. */
  paidWith: string | null;
  /** True when the amount shown is a quote, not a charge — the row says so
   *  rather than implying money moved. */
  quoted: boolean;
  stars: number | null;
  receiptNumber: string | null;
  monthKey: string;
  monthLabel: string;
  accessibilityLabel: string;
}

const DAY_MS = 86_400_000;

const clean = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

/** First meaningful segment of an address — "Dubai Marina, Dubai, UAE" → "Dubai Marina". */
export function shortPlace(v: string | null | undefined): string | null {
  const t = clean(v);
  if (!t) {return null;}
  const head = t.split(',')[0]?.trim();
  return head && head.length > 0 ? head : t;
}

export function shortRef(id: string): string {
  return 'BL-' + id.replace(/-/g, '').slice(-12).toUpperCase();
}

export function serviceTitle(b: HistoryRowInput): string {
  const key = clean(b.service) ?? clean(b.type) ?? '';
  const base = SERVICE_LABELS[key]
    ?? (key ? key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Booking');
  const task = clean(b.task_type);
  if (key === 'executive_protection' && task && isExecTaskType(task)) {
    return `${base} · ${execTaskLabel(task)}`;
  }
  return base;
}

/** Hours as the app writes them: "4 h", "1 h 30 m" is not a thing here (the
 *  wire stores whole hours), so a non-integer simply renders with its decimal. */
function durationWord(h: number | null | undefined): string | null {
  if (h === null || h === undefined || !Number.isFinite(h) || h <= 0) {return null;}
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

/**
 * "Tue 02 Sep · 6:30 PM · 4 h", with a relative day word inside a 48-hour
 * window because that is the range where "Today" reads faster than a date.
 *
 * `now` is injected so the boundary is testable rather than depending on when
 * the suite runs.
 */
export function formatRowWhen(
  startIso: string | null | undefined,
  durationHours: number | null | undefined,
  now: number = Date.now(),
): string {
  const parts: string[] = [];
  const d = startIso ? new Date(startIso) : null;
  if (d && !Number.isNaN(d.getTime())) {
    parts.push(`${relativeDay(d, now)} · ${formatTime12h(d.getHours(), d.getMinutes())}`);
  }
  const dur = durationWord(durationHours);
  if (dur) {parts.push(dur);}
  return parts.join(' · ');
}

/** Local calendar-day comparison — NOT a millisecond delta. 11 PM tonight and
 *  1 AM tomorrow are 2 hours apart but are different days, and a delta-based
 *  check calls the second one "Today". */
function relativeDay(d: Date, now: number): string {
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(d) - startOfDay(new Date(now))) / DAY_MS);
  if (days === 0) {return 'Today';}
  if (days === 1) {return 'Tomorrow';}
  if (days === -1) {return 'Yesterday';}
  return d.toLocaleDateString('en-GB', {weekday: 'short', day: '2-digit', month: 'short'});
}

export function routeLine(b: HistoryRowInput): string {
  const from = shortPlace(b.pickup_address ?? b.pickup?.address ?? b.pickup?.label);
  const to = shortPlace(b.dropoff_address ?? b.dropoff?.address ?? b.dropoff?.label);
  // Executive Protection with no transfer leg is a STATIC detail — saying
  // "Marina →" with nothing after it reads like missing data.
  const staticDetail = (b.service ?? '') === 'executive_protection' && !b.exec_transport;
  if (from && to) {return `${from} → ${to}`;}
  if (from) {return staticDetail ? `${from} · Protection only` : from;}
  // No address at all: still say WHAT it is rather than leaving the line blank.
  return staticDetail ? 'Protection only' : '';
}

export function teamLine(b: HistoryRowInput): string {
  const bits: string[] = [];
  const cpos = b.cpo_count ?? 0;
  if (cpos > 0) {bits.push(`${cpos} CPO${cpos === 1 ? '' : 's'}`);}
  const vehicles = b.vehicle_count ?? 0;
  if (vehicles > 0 && !b.driver_only) {bits.push(`${vehicles} vehicle${vehicles === 1 ? '' : 's'}`);}
  if (b.driver_only || b.requirements?.driver_only) {bits.push('Driver only');}
  if (b.requirements?.armed) {bits.push('Armed');}
  if (b.requirements?.female) {bits.push('Female CPO');}
  return bits.join(' · ');
}

export function formatCredits(n: number): string {
  const sign = n < 0 ? '−' : '';
  return `${sign}${Math.abs(Math.round(n)).toLocaleString('en-US')} BC`;
}

const PAID_WITH: Record<string, string> = {
  bravo_credits: 'Credits',
  card: 'Card',
  corporate: 'Corporate',
  plan: 'Plan',
};

/**
 * B-847 — the one place the mobile app turns a stored `payment_method` into
 * words. Built on `PAID_WITH` so the history rows and the Trip Summary can never
 * drift apart; an unknown value degrades to its own text with the underscores
 * opened out rather than disappearing, because a label nobody has taught this
 * table yet is still more useful than a blank.
 */
export function paymentMethodLabel(method: string | null | undefined): string {
  const raw = (method ?? '').toString().trim();
  if (raw === '') {return '—';}
  return PAID_WITH[raw] ?? raw.replace(/_/g, ' ');
}

/**
 * The amount to show, and whether it is a CHARGE or still only a QUOTE.
 *
 * Refunds render negative; a partial refund shows what was kept. A row with no
 * payment block at all (the plain wire Booking, before the history DTO loads)
 * falls back to the quote and is flagged so the UI can say so — never implying
 * money moved when it has not.
 */
export function rowAmount(b: HistoryRowInput): {amount: string; quoted: boolean} {
  const p = b.payment;
  const quote = b.total_eur ?? b.total_price ?? b.estimated_price ?? p?.quoted_credits ?? 0;
  if (!p?.state) {
    return {amount: quote > 0 ? formatCredits(quote) : '', quoted: true};
  }
  const charged = p.charged_credits ?? 0;
  const refunded = p.refunded_credits ?? 0;
  if (p.state === 'refunded') {
    const back = refunded || charged;
    // Nothing to show beats "0 BC" beside a REFUNDED chip (a cancel that never
    // charged reports state 'not_charged', but a data gap must not print a zero).
    return back > 0 ? {amount: formatCredits(-back), quoted: false} : {amount: '', quoted: false};
  }
  if (p.state === 'partially_refunded') {
    return {amount: `${formatCredits(charged - refunded)} · ${formatCredits(refunded)} back`, quoted: false};
  }
  if (charged > 0) {return {amount: formatCredits(charged), quoted: false};}
  return {amount: quote > 0 ? formatCredits(quote) : '', quoted: true};
}

/** Date-range windows the filter sheet offers, in days. `null` = any time. */
export const DATE_RANGE_DAYS: ReadonlyArray<{key: string; days: number | null}> = [
  {key: 'any', days: null},
  {key: '30', days: 30},
  {key: '90', days: 90},
  {key: '365', days: 365},
];

/**
 * Which range pill an applied `from` timestamp came from.
 *
 * The sheet re-seeded with `filters.from ? '30' : 'any'`, so reopening after
 * "Last 90 days" showed the 30-day pill selected — and a subsequent Apply,
 * meant only to change the service, silently narrowed the window to 30 days.
 * Resolving to the NEAREST window makes the sheet show what is in force.
 */
export function rangeKeyFor(
  from: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!from) {return 'any';}
  const t = new Date(from).getTime();
  if (Number.isNaN(t)) {return 'any';}
  const days = Math.round((now - t) / DAY_MS);
  let best = 'any';
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const r of DATE_RANGE_DAYS) {
    if (r.days === null) {continue;}
    const delta = Math.abs(r.days - days);
    if (delta < bestDelta) {bestDelta = delta; best = r.key;}
  }
  return best;
}

export function monthKeyFor(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) {return 'unknown';}
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLabelFor(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) {return 'Earlier';}
  return d.toLocaleDateString(undefined, {month: 'long', year: 'numeric'}).toUpperCase();
}

function starsOf(b: HistoryRowInput): number | null {
  if (typeof b.rating === 'number') {return b.rating > 0 ? b.rating : null;}
  const s = b.rating?.stars;
  return typeof s === 'number' && s > 0 ? s : null;
}

export function buildHistoryRow(b: HistoryRowInput, now: number = Date.now()): HistoryRowVM {
  const status = describeBookingRow(
    {
      status: b.status,
      mission_status: b.mission_status,
      payment_state: b.payment?.state ?? null,
      booking_mode: b.booking_mode,
      dispatch_mode: b.dispatch_mode,
      start_time: b.start_time,
    },
    now,
  );
  const title = serviceTitle(b);
  // A booking with no pickup_time yet still has to sort and group somewhere —
  // fall back to when it was created rather than dropping into "unknown".
  const when = b.start_time ?? b.created_at ?? null;
  const {amount, quoted} = rowAmount(b);
  // B-843/A18 — name the root when the server projected it; "plan holder" no
  // longer identifies anyone once a member can be under several.
  const payerName = clean(b.payment?.payer_name);
  const paidWith = b.payment?.payer === 'family_owner'
    ? (payerName ? `Paid by ${payerName}` : 'Paid by plan holder')
    : PAID_WITH[b.payment?.method ?? b.payment_method ?? ''] ?? null;
  const stars = starsOf(b);
  const receiptNumber = clean(b.receipt?.invoice_number);
  const vm: Omit<HistoryRowVM, 'accessibilityLabel'> = {
    id: b.id,
    reference: clean(b.reference) ?? shortRef(b.id),
    title,
    when: formatRowWhen(when, b.duration_hours, now),
    where: routeLine(b),
    team: teamLine(b),
    status,
    bucket: status.bucket,
    amount,
    paidWith,
    quoted,
    stars,
    receiptNumber,
    monthKey: monthKeyFor(when),
    monthLabel: monthLabelFor(when),
  };
  return {...vm, accessibilityLabel: a11yLabelFor(vm)};
}

/** One spoken sentence per row. Screen readers get the same five answers the
 *  sighted row gives, in the same order — not a pile of raw field values. */
export function a11yLabelFor(vm: Omit<HistoryRowVM, 'accessibilityLabel'>): string {
  const money = vm.status.money ? `${vm.status.label.toLowerCase()}, ${vm.status.money.toLowerCase()}` : vm.status.label.toLowerCase();
  return [
    vm.title,
    vm.when,
    vm.where || null,
    vm.team || null,
    money,
    vm.amount ? `${vm.quoted ? 'quoted ' : ''}${vm.amount.replace('−', 'minus ').replace(/BC/g, 'credits')}` : null,
    vm.stars ? `rated ${vm.stars} star${vm.stars === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/** Group rows into month sections, preserving the order they arrive in (the
 *  server already sorted them; re-sorting a page client-side is how a paged
 *  list starts interleaving). */
export function groupByMonth<T extends {monthKey: string; monthLabel: string}>(
  rows: T[],
): Array<{key: string; label: string; data: T[]}> {
  const out: Array<{key: string; label: string; data: T[]}> = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.key === r.monthKey) {last.data.push(r);}
    else {out.push({key: r.monthKey, label: r.monthLabel, data: [r]});}
  }
  return out;
}
