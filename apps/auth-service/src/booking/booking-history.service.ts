import {Injectable, Logger} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {PricingService, DEFAULT_SERVICE_PRICING} from './pricing.service';
// Reused, never re-derived: the ONE client-facing mission mapping (crew that has
// not accepted yet is not "dispatched" to the client). A second copy of this rule
// is how the history and the resume path start disagreeing about the same booking.
import {clientMissionStatus} from './booking.service';

/**
 * B-786 — the client's BOOKING HISTORY read model.
 *
 * Deliberately a SEPARATE service and endpoint from `BookingService.list`
 * (GET /bookings). That list is the app's RESUME model: the Home hero, the
 * B-405 upcoming card and the LB17 "one mission at a time" slot all read it,
 * and every one of those behaviours is sensitive to its ordering, its 50-row
 * ceiling and its exact shape. Widening it to serve a history screen is how
 * those regress. So this file adds a read model beside it and changes nothing
 * about it.
 *
 * What it fixes (all in B-786):
 *   - the history had no payment state, receipt, rating, crew or mission timing
 *     even though every one of those is already stored (B-786d);
 *   - `total` was the PAGE LENGTH, so no caller could show a true count or know
 *     whether a next page existed (B-786c);
 *   - ordering was by `created_at`, so a 'later' booking made last week sank
 *     below a 'now' booking made yesterday (B-786g).
 *
 * NO N+1: one page query, one count, then a FIXED number of batched
 * `= ANY($ids)` enrichment queries. The query count does not grow with the page
 * size — pinned by booking.history.spec.ts.
 *
 * Money truth is the ESCROW + the payer's LEDGER, never `payment_captured`
 * (legacy pay-with-credits only) and never the quote. B-379 is the precedent:
 * the client half of the escrow controls was missing and money moved on the
 * sweep timer alone with nothing surfaced.
 */

/** Buckets are a COARSE, purely status-driven split so they can live in SQL and
 *  page correctly. The finer Active-vs-Upcoming presentation split needs
 *  `mission_status` + the B-405 parked-reservation rule and is done client-side
 *  (bookingStatus.ts `bucketFor`), over the rows this returns. */
export type HistoryBucket = 'all' | 'upcoming' | 'past' | 'cancelled';

export type PaymentFilter = 'paid' | 'held' | 'refunded' | 'under_review';

export type PaymentState =
  | 'due' | 'paid' | 'held' | 'released'
  | 'refunded' | 'partially_refunded' | 'under_review' | 'not_charged';

export interface HistoryQuery {
  bucket?: string;
  /** Comma-separated service keys; anything not in the allow-list is dropped. */
  service?: string;
  from?: string;
  to?: string;
  payment?: string;
  limit?: number;
  before?: string;
}

export interface HistoryLedgerEntry {
  id: string;
  type: string;
  amount_credits: number;
  created_at: string;
}

export interface HistoryPayment {
  method: string;
  payer: 'self' | 'family_owner';
  /**
   * B-843 (A18) — the ROOT's display name when someone else paid, else null.
   * A member may be under several roots, so "Paid by plan holder" no longer
   * identifies anyone; the client renders "Paid by {name}" and keeps the old
   * string as its fallback for pre-B-843 servers.
   */
  payer_name: string | null;
  quoted_credits: number;
  charged_credits: number;
  refunded_credits: number;
  state: PaymentState;
  escrow: {
    status: string;
    basis: string | null;
    release_eligible_at: string | null;
    review_required: boolean;
  } | null;
  ledger: HistoryLedgerEntry[];
}

export interface HistoryMission {
  short_code: string;
  status: string;
  started_at: string | null;
  pickup_at: string | null;
  live_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  route_distance_m: number | null;
  route_duration_s: number | null;
  lead: {call_sign: string; display_name: string | null} | null;
  crew_count: number;
  vehicle: {model: string | null; plate: string | null; armour: string | null} | null;
}

export interface HistoryBooking {
  id: string;
  reference: string;
  category: 'lite';
  status: string;
  mission_status: string | null;
  service: string;
  task_type: string | null;
  region_code: string;
  region_label: string;
  booking_mode: 'now' | 'later' | null;
  dispatch_mode: string | null;
  start_time: string;
  duration_hours: number;
  created_at: string;
  confirmed_at: string | null;
  pickup_address: string;
  dropoff_address: string | null;
  passengers: number;
  cpo_count: number;
  vehicle_count: number;
  driver_only: boolean;
  add_ons: string[];
  requirements: {armed: boolean; female: boolean; driver_only: boolean};
  exec_transport: unknown | null;
  total_eur: number;
  total_aed: number;
  payment: HistoryPayment;
  mission: HistoryMission | null;
  receipt: {
    invoice_number: string;
    kind: string;
    issued_at: string;
    total_credits: number;
  } | null;
  rating: {stars: number; tags: string[]} | null;
  dispute: {status: string; category: string; created_at: string} | null;
  notes: string | null;
  conversation_id: string | null;
}

export interface HistorySummary {
  count_all: number;
  count_in_flight: number;
  count_completed: number;
  count_cancelled: number;
  spent_all_credits: number;
  spent_30d_credits: number;
  refunded_all_credits: number;
}

export interface HistoryPage {
  total: number;
  next_cursor: string | null;
  summary: HistorySummary | null;
  bookings: HistoryBooking[];
}

// Status sets per bucket. These are exactly the labels of the lite_booking_status
// enum (see supabase/migrations 20260423113000 + the auto-dispatch additions);
// a label that is not a real enum value would make the ::text comparison match
// nothing rather than error, which is the silent-empty-list failure mode.
const IN_FLIGHT = [
  'DISPATCHING', 'PENDING_OPS', 'OPS_APPROVED', 'PAYMENT_PENDING', 'CONFIRMED', 'LIVE',
] as const;
const PAST = ['COMPLETED'] as const;
const CANCELLED = ['CANCELLED', 'NO_PROVIDER', 'AGENCY_NO_SHOW'] as const;

// DRAFT is never history: it is a row that was created but never submitted.
const ALL_VISIBLE = [...IN_FLIGHT, ...PAST, ...CANCELLED] as const;

const SERVICES = new Set([
  'secure_transfer', 'executive_protection', 'recon_team', 'emergency_extraction',
]);

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 30;

/**
 * Payment predicates. Each is a CONSTANT SQL fragment chosen by an allow-listed
 * key — user input never reaches the string. They must live in SQL (not in a
 * post-filter) or the page size, the cursor and `total` all lie.
 */
const PAYMENT_PREDICATE: Record<PaymentFilter, string> = {
  held:
    'EXISTS (SELECT 1 FROM escrow_holds e WHERE e.booking_id = b.id ' +
    "AND e.status::text IN ('HELD','PENDING_RELEASE'))",
  // "Paid" must EXCLUDE anything that came back, or the filter and the row's
  // own `payment.state` contradict each other: a legacy booking charged and
  // then fully refunded matched `paid` while its state read 'refunded'.
  paid:
    "((EXISTS (SELECT 1 FROM escrow_holds e WHERE e.booking_id = b.id AND e.status::text = 'RELEASED') " +
    'OR (NOT EXISTS (SELECT 1 FROM escrow_holds e2 WHERE e2.booking_id = b.id) ' +
    'AND EXISTS (SELECT 1 FROM wallet_transactions w WHERE w.booking_id = b.id ' +
    "AND w.type::text = 'payment' AND w.status::text = 'succeeded'))) " +
    'AND NOT EXISTS (SELECT 1 FROM wallet_transactions wr WHERE wr.booking_id = b.id ' +
    "AND wr.type::text = 'refund' AND wr.status::text = 'succeeded'))",
  // A PARTIAL split can end with to_client 0 (a mission that ran to completion
  // before an abort, or a 100% cancellation fee) — that is not a refund, and
  // paymentState() says 'released' for it. The filter must agree.
  refunded:
    "(EXISTS (SELECT 1 FROM escrow_holds e WHERE e.booking_id = b.id AND (e.status::text = 'REFUNDED' " +
    "OR (e.status::text = 'PARTIAL' AND COALESCE(e.to_client_credits, 0) > 0))) " +
    'OR EXISTS (SELECT 1 FROM wallet_transactions w WHERE w.booking_id = b.id ' +
    "AND w.type::text = 'refund' AND w.status::text = 'succeeded'))",
  under_review:
    "(EXISTS (SELECT 1 FROM escrow_holds e WHERE e.booking_id = b.id AND e.status::text = 'DISPUTED') " +
    "OR EXISTS (SELECT 1 FROM booking_disputes d WHERE d.booking_id = b.id AND d.status = 'open'))",
};

interface PageRow {
  id: string;
  status: string;
  service: string;
  task_type: string | null;
  region_code: string;
  region_label: string;
  booking_mode: string | null;
  dispatch_mode: string | null;
  pickup_time: Date;
  duration_hours: number;
  created_at: Date;
  confirmed_at: Date | null;
  pickup_address: string;
  dropoff_address: string | null;
  passengers: number;
  cpo_count: number;
  vehicle_count: number;
  driver_only: boolean;
  add_ons: string[];
  armed_required: boolean;
  female_required: boolean;
  exec_transport: unknown | null;
  total_eur: string;
  total_aed: string;
  payment_method: string;
  notes: string | null;
  conversation_id: string | null;
  rating: number | null;
  rating_tags: string[] | null;
  payer_user_id: string | null;
  payer_name: string | null;
  /** B-854 — the INTERMEDIARY on a chained booking, and their display name. */
  payer_via_user_id: string | null;
  payer_via_name: string | null;
  client_id: string;
}

@Injectable()
export class BookingHistoryService {
  private readonly log = new Logger(BookingHistoryService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly pricing: PricingService,
  ) {}

  async history(clientId: string, raw: HistoryQuery): Promise<HistoryPage> {
    const bucket = this.parseBucket(raw.bucket);
    const statuses = this.statusesFor(bucket);
    const services = this.parseServices(raw.service);
    const from = this.parseDate(raw.from);
    const to = this.parseDate(raw.to);
    const payment = this.parsePayment(raw.payment);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw.limit ?? DEFAULT_LIMIT)));
    const cursor = this.parseCursor(raw.before);

    // Upcoming reads forward in time; everything else reads backwards. The
    // direction is derived from an allow-listed bucket, never from input.
    const asc = bucket === 'upcoming';
    const order = asc ? 'ASC' : 'DESC';
    const cmp = asc ? '>' : '<';

    // $1 client, $2 statuses, $3 services, $4 from, $5 to, $6 cursorTime, $7 cursorId
    const filterSql =
      `b.client_id = $1
         AND b.status::text = ANY($2::text[])
         AND ($3::text[] IS NULL OR b.service = ANY($3::text[]))
         AND ($4::timestamptz IS NULL OR b.pickup_time >= $4::timestamptz)
         AND ($5::timestamptz IS NULL OR b.pickup_time < $5::timestamptz)` +
      (payment ? `\n         AND ${PAYMENT_PREDICATE[payment]}` : '');

    const filterParams = [clientId, statuses, services, from, to];

    const [rows, countRow, summary] = await Promise.all([
      this.db.q<PageRow>(
        `SELECT b.id, b.status::text AS status, b.service, b.task_type, b.region_code, b.region_label,
                b.booking_mode, b.dispatch_mode, b.pickup_time, b.duration_hours, b.created_at,
                b.confirmed_at, b.pickup_address, b.dropoff_address, b.passengers, b.cpo_count,
                b.vehicle_count, b.driver_only, b.add_ons, b.armed_required, b.female_required,
                b.exec_transport, b.total_eur, b.total_aed, b.payment_method, b.notes,
                b.conversation_id, b.rating, b.rating_tags, b.payer_user_id, b.client_id,
                pu.display_name AS payer_name,
                b.payer_via_user_id, vu.display_name AS payer_via_name
           FROM lite_bookings b
           LEFT JOIN public.users pu ON pu.id = b.payer_user_id
           LEFT JOIN public.users vu ON vu.id = b.payer_via_user_id
          WHERE ${filterSql}
            AND ($6::timestamptz IS NULL
                 OR (b.pickup_time, b.id) ${cmp} ($6::timestamptz, $7::uuid))
          ORDER BY b.pickup_time ${order}, b.id ${order}
          LIMIT $8`,
        [...filterParams, cursor?.time ?? null, cursor?.id ?? null, limit + 1],
      ),
      this.db.qOne<{n: string}>(
        `SELECT COUNT(*)::text AS n FROM lite_bookings b WHERE ${filterSql}`,
        filterParams,
      ),
      // The stats strip is only meaningful unfiltered, and re-running it for
      // every page would be pure waste — first page only.
      cursor ? Promise.resolve(null) : this.summaryFor(clientId),
    ]);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const ids = page.map(r => r.id);

    // 1 BC = `eur_per_bc` EUR, and that peg is OPS-EDITABLE (founder
    // 2026-08-26). Stored totals are EUR, so a BC quote has to be derived at
    // the live rate — the same conversion the CHARGE path runs
    // (payWithCredits, pricing.service total_bc). Reading total_eur as credits
    // made the quote disagree with `charged_credits` (which comes from the
    // peg-correct escrow gross) by exactly the peg at any value but 1.0.
    // Fail-open to the compiled default, like every other reader of it.
    const eurPerBc =
      (await this.pricing.config?.().catch(() => null))?.eur_per_bc
      ?? DEFAULT_SERVICE_PRICING.eur_per_bc;

    const enriched = await this.enrich(ids, page, eurPerBc);

    const last = page[page.length - 1];
    return {
      total: Number(countRow?.n ?? 0),
      next_cursor: hasMore && last ? this.encodeCursor(last.pickup_time, last.id) : null,
      summary,
      bookings: enriched,
    };
  }

  // ── enrichment ────────────────────────────────────────────────────────────

  /**
   * SIX batched queries, independent of the page size. Every one of them keys on
   * the id array that the (already owner-scoped) page produced, so nothing here
   * can widen the caller's visibility beyond their own bookings.
   */
  private async enrich(
    ids: string[],
    page: PageRow[],
    eurPerBc: number,
  ): Promise<HistoryBooking[]> {
    if (ids.length === 0) {return [];}
    // The ledger is scoped to the booking's PAYER so a family booking shows the
    // movements that actually paid for it. It also keeps the escrow account's own
    // mirror rows out: an escrow charge writes a `payment` debit on the payer AND
    // a matching credit on the escrow account, and summing both would net to zero.
    const payers = page.map(r => r.payer_user_id ?? r.client_id);

    const [missions, crew, escrows, ledger, invoices, disputes] = await Promise.all([
      this.db.q<{
        booking_id: string; id: string; short_code: string; status: string;
        started_at: Date | null; pickup_at: Date | null; live_at: Date | null;
        ended_at: Date | null; end_reason: string | null;
        route_distance_m: number | null; route_duration_s: number | null;
        vehicle_model: string | null; vehicle_plate: string | null; vehicle_armour: string | null;
        crew_accepted: boolean;
      }>(
        // Same "newest non-ABORTED mission wins" rule the resume path uses
        // (BookingService.list / getById) so the two surfaces cannot disagree
        // about which mission a re-dispatched booking is showing.
        `SELECT DISTINCT ON (m.booking_id)
                m.booking_id, m.id, m.short_code, m.status::text AS status,
                m.started_at, m.pickup_at, m.live_at, m.ended_at, m.end_reason,
                m.route_distance_m, m.route_duration_s,
                m.vehicle_model, m.vehicle_plate, m.vehicle_armour,
                EXISTS (SELECT 1 FROM mission_crew mc
                         WHERE mc.mission_id = m.id AND mc.accepted_at IS NOT NULL) AS crew_accepted
           FROM missions m
          WHERE m.booking_id = ANY($1::uuid[])
          ORDER BY m.booking_id, (m.status <> 'ABORTED') DESC, m.created_at DESC`,
        [ids],
      ),
      this.db.q<{
        booking_id: string; call_sign: string | null; display_name: string | null;
        is_lead: boolean; crew_count: string;
      }>(
        // Lead call-sign + headcount only. The client already sees these through
        // the verify-code handshake and the assigned-team card; agent ids stay out.
        // `agents` is keyed by user_id — it has NO `id` column, and mission_crew
        // stores the agent's USER id. Same join the verify-code lead lookup uses.
        //
        // NO `mc.status <> 'off'` FILTER. Every terminal mission path flips the
        // whole crew to 'off' to free the officers again (mission complete, ops
        // abort, arrival no-show, client cancel), so filtering it out would erase
        // the crew for exactly the COMPLETED / CANCELLED bookings this endpoint
        // mostly serves — every finished detail would report no officers. A
        // history row says who WAS on the mission; liveness is the active
        // surfaces' question, not this one.
        `SELECT m.booking_id,
                (ARRAY_AGG(mc.call_sign ORDER BY mc.is_lead DESC, mc.slot))[1] AS call_sign,
                (ARRAY_AGG(a.display_name ORDER BY mc.is_lead DESC, mc.slot))[1] AS display_name,
                BOOL_OR(mc.is_lead) AS is_lead,
                COUNT(*)::text AS crew_count
           FROM missions m
           JOIN mission_crew mc ON mc.mission_id = m.id
           LEFT JOIN agents a ON a.user_id = mc.agent_id
          WHERE m.booking_id = ANY($1::uuid[])
          GROUP BY m.booking_id`,
        [ids],
      ),
      this.db.q<{
        booking_id: string; status: string; basis: string | null;
        gross_credits: number; to_client_credits: number | null;
        release_eligible_at: Date | null; review_required: boolean;
      }>(
        `SELECT booking_id, status::text AS status, basis, gross_credits,
                to_client_credits, release_eligible_at, review_required
           FROM escrow_holds WHERE booking_id = ANY($1::uuid[])`,
        [ids],
      ),
      this.db.q<{
        id: string; booking_id: string; user_id: string; type: string;
        amount_credits: number; created_at: Date;
      }>(
        `SELECT id, booking_id, user_id, type::text AS type, amount_credits, created_at
           FROM wallet_transactions
          WHERE booking_id = ANY($1::uuid[])
            AND user_id = ANY($2::uuid[])
            AND status::text = 'succeeded'
          ORDER BY created_at DESC`,
        [ids, payers],
      ),
      this.db.q<{
        booking_id: string; invoice_number: string; kind: string;
        issued_at: Date; total_credits: number;
      }>(
        `SELECT DISTINCT ON (booking_id) booking_id, invoice_number, kind, issued_at, total_credits
           FROM invoices WHERE booking_id = ANY($1::uuid[])
          ORDER BY booking_id, issued_at DESC`,
        [ids],
      ),
      this.db.q<{booking_id: string; status: string; category: string; created_at: Date}>(
        `SELECT DISTINCT ON (booking_id) booking_id, status, category, created_at
           FROM booking_disputes WHERE booking_id = ANY($1::uuid[])
          ORDER BY booking_id, created_at DESC`,
        [ids],
      ),
    ]);

    const missionBy = new Map(missions.map(m => [m.booking_id, m]));
    const crewBy = new Map(crew.map(c => [c.booking_id, c]));
    const escrowBy = new Map(escrows.map(e => [e.booking_id, e]));
    const invoiceBy = new Map(invoices.map(i => [i.booking_id, i]));
    const disputeBy = new Map(disputes.map(d => [d.booking_id, d]));
    const ledgerBy = new Map<string, typeof ledger>();
    for (const l of ledger) {
      const list = ledgerBy.get(l.booking_id);
      if (list) {list.push(l);} else {ledgerBy.set(l.booking_id, [l]);}
    }

    return page.map(r => {
      const m = missionBy.get(r.id) ?? null;
      const c = crewBy.get(r.id);
      const e = escrowBy.get(r.id) ?? null;
      const inv = invoiceBy.get(r.id) ?? null;
      const disp = disputeBy.get(r.id) ?? null;
      const rows = ledgerBy.get(r.id) ?? [];

      // Sign, not type, is the discriminator: a debit is negative on the payer's
      // wallet and a credit is positive, whatever the row is called. That keeps a
      // new ledger type from silently landing on the wrong side of the total.
      const charged = rows.reduce((n, l) => (l.amount_credits < 0 ? n - l.amount_credits : n), 0);
      const refunded = rows.reduce((n, l) => (l.amount_credits > 0 ? n + l.amount_credits : n), 0);
      const chargedCredits = e ? Number(e.gross_credits) : charged;
      // The payer's ledger is the truth for what came BACK. The escrow's own
      // reconciled split stands in only while no refund row exists yet (the
      // sweep credits the wallet in the same transaction, so that is a narrow
      // window rather than a disagreement).
      const refundedCredits =
        refunded > 0
          ? refunded
          : e?.to_client_credits != null ? Number(e.to_client_credits) : 0;

      return {
        id: r.id,
        reference: reference(r.id),
        category: 'lite' as const,
        status: r.status,
        mission_status: clientMissionStatus(m),
        service: r.service,
        task_type: r.task_type ?? null,
        region_code: r.region_code,
        region_label: r.region_label,
        booking_mode: (r.booking_mode as 'now' | 'later' | null) ?? null,
        dispatch_mode: r.dispatch_mode ?? null,
        start_time: iso(r.pickup_time),
        duration_hours: r.duration_hours,
        created_at: iso(r.created_at),
        confirmed_at: r.confirmed_at ? iso(r.confirmed_at) : null,
        pickup_address: r.pickup_address,
        dropoff_address: r.dropoff_address ?? null,
        passengers: r.passengers,
        cpo_count: r.cpo_count,
        vehicle_count: r.vehicle_count,
        driver_only: r.driver_only,
        add_ons: Array.isArray(r.add_ons) ? r.add_ons : [],
        requirements: {
          armed: !!r.armed_required,
          female: !!r.female_required,
          driver_only: !!r.driver_only,
        },
        exec_transport: r.exec_transport ?? null,
        total_eur: Number(r.total_eur),
        total_aed: Number(r.total_aed),
        payment: {
          method: r.payment_method ?? 'bravo_credits',
          payer: r.payer_user_id && r.payer_user_id !== r.client_id ? 'family_owner' as const : 'self' as const,
          // Gated on the SAME condition as `payer` — a self-paid booking never
          // names anyone, even though the join happily returns the client's own
          // name for the (now stamped) self payer.
          //
          // B-854 (A8) — this endpoint is the CLIENT's own history, so on a
          // CHAINED booking the name it shows is the INTERMEDIARY's: that is
          // the root the client actually joined. `payer_user_id` points at the
          // wallet one rung above, and naming it here would tell the member
          // about an account they are not a member of with zero code change
          // (LM-B7). The wallet owner and the chain itself belong on the
          // holder/ops projections, never on this one.
          payer_name: r.payer_user_id && r.payer_user_id !== r.client_id
            ? (r.payer_via_user_id ? (r.payer_via_name ?? null) : (r.payer_name ?? null))
            : null,
          quoted_credits: toCredits(r.total_eur, eurPerBc),
          charged_credits: chargedCredits,
          refunded_credits: refundedCredits,
          state: paymentState(r.status, e, chargedCredits, refundedCredits, disp),
          escrow: e
            ? {
                status: e.status,
                basis: e.basis ?? null,
                release_eligible_at: e.release_eligible_at ? iso(e.release_eligible_at) : null,
                review_required: !!e.review_required,
              }
            : null,
          ledger: rows.map(l => ({
            id: l.id,
            type: l.type,
            amount_credits: l.amount_credits,
            created_at: iso(l.created_at),
          })),
        },
        mission: m
          ? {
              short_code: m.short_code,
              status: m.status,
              started_at: m.started_at ? iso(m.started_at) : null,
              pickup_at: m.pickup_at ? iso(m.pickup_at) : null,
              live_at: m.live_at ? iso(m.live_at) : null,
              ended_at: m.ended_at ? iso(m.ended_at) : null,
              end_reason: m.end_reason ?? null,
              route_distance_m: m.route_distance_m ?? null,
              route_duration_s: m.route_duration_s ?? null,
              lead: c?.call_sign ? {call_sign: c.call_sign, display_name: c.display_name ?? null} : null,
              crew_count: Number(c?.crew_count ?? 0),
              vehicle: m.vehicle_model || m.vehicle_plate
                ? {model: m.vehicle_model, plate: m.vehicle_plate, armour: m.vehicle_armour}
                : null,
            }
          : null,
        receipt: inv
          ? {
              invoice_number: inv.invoice_number,
              kind: inv.kind,
              issued_at: iso(inv.issued_at),
              total_credits: Number(inv.total_credits),
            }
          : null,
        // `rating_remarks` is quality/ops-only (Issue 31) and is NOT selected here.
        rating: r.rating != null
          ? {stars: Number(r.rating), tags: Array.isArray(r.rating_tags) ? r.rating_tags : []}
          : null,
        dispute: disp
          ? {status: disp.status, category: disp.category, created_at: iso(disp.created_at)}
          : null,
        notes: r.notes ?? null,
        conversation_id: r.conversation_id ?? null,
      };
    });
  }

  private async summaryFor(clientId: string): Promise<HistorySummary> {
    const [counts, money] = await Promise.all([
      this.db.qOne<{
        count_all: string; count_in_flight: string;
        count_completed: string; count_cancelled: string;
      }>(
        `SELECT COUNT(*) FILTER (WHERE status::text = ANY($2::text[]))::text AS count_all,
                COUNT(*) FILTER (WHERE status::text = ANY($3::text[]))::text AS count_in_flight,
                COUNT(*) FILTER (WHERE status::text = ANY($4::text[]))::text AS count_completed,
                COUNT(*) FILTER (WHERE status::text = ANY($5::text[]))::text AS count_cancelled
           FROM lite_bookings WHERE client_id = $1`,
        [clientId, [...ALL_VISIBLE], [...IN_FLIGHT], [...PAST], [...CANCELLED]],
      ),
      // What left THIS user's wallet for bookings. A booking someone else paid
      // for (family owner) correctly contributes nothing to their own spend.
      this.db.qOne<{spent_all: string; spent_30d: string; refunded_all: string}>(
        `SELECT COALESCE(-SUM(amount_credits) FILTER (WHERE amount_credits < 0), 0)::text AS spent_all,
                COALESCE(-SUM(amount_credits) FILTER (WHERE amount_credits < 0
                          AND created_at >= NOW() - INTERVAL '30 days'), 0)::text AS spent_30d,
                COALESCE(SUM(amount_credits) FILTER (WHERE amount_credits > 0), 0)::text AS refunded_all
           FROM wallet_transactions
          WHERE user_id = $1 AND booking_id IS NOT NULL AND status::text = 'succeeded'`,
        [clientId],
      ),
    ]);
    return {
      count_all: Number(counts?.count_all ?? 0),
      count_in_flight: Number(counts?.count_in_flight ?? 0),
      count_completed: Number(counts?.count_completed ?? 0),
      count_cancelled: Number(counts?.count_cancelled ?? 0),
      spent_all_credits: Number(money?.spent_all ?? 0),
      spent_30d_credits: Number(money?.spent_30d ?? 0),
      refunded_all_credits: Number(money?.refunded_all ?? 0),
    };
  }

  // ── input parsing (every value is allow-listed before it reaches Postgres) ──

  private parseBucket(v: string | undefined): HistoryBucket {
    return v === 'upcoming' || v === 'past' || v === 'cancelled' ? v : 'all';
  }

  private statusesFor(b: HistoryBucket): string[] {
    if (b === 'upcoming') {return [...IN_FLIGHT];}
    if (b === 'past') {return [...PAST];}
    if (b === 'cancelled') {return [...CANCELLED];}
    return [...ALL_VISIBLE];
  }

  /** `null` = no filter. An all-unknown list also yields null rather than an
   *  empty array, because `= ANY('{}')` matches nothing and would render an
   *  empty history for a typo. */
  private parseServices(v: string | undefined): string[] | null {
    if (!v) {return null;}
    const picked = v.split(',').map(s => s.trim()).filter(s => SERVICES.has(s));
    return picked.length > 0 ? picked : null;
  }

  private parseDate(v: string | undefined): string | null {
    if (!v) {return null;}
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  private parsePayment(v: string | undefined): PaymentFilter | null {
    return v === 'paid' || v === 'held' || v === 'refunded' || v === 'under_review' ? v : null;
  }

  private encodeCursor(t: Date, id: string): string {
    return Buffer.from(`${iso(t)}|${id}`, 'utf8').toString('base64url');
  }

  /** A malformed or non-uuid cursor is DROPPED (first page) rather than 400'd or
   *  bound raw — an unparseable uuid reaching the `::uuid` cast is a 500. */
  private parseCursor(v: string | undefined): {time: string; id: string} | null {
    if (!v) {return null;}
    try {
      const [time, id] = Buffer.from(v, 'base64url').toString('utf8').split('|');
      if (!time || !id) {return null;}
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {return null;}
      const d = new Date(time);
      if (Number.isNaN(d.getTime())) {return null;}
      return {time: d.toISOString(), id};
    } catch {
      this.log.warn('history cursor could not be decoded; serving the first page');
      return null;
    }
  }
}

/** EUR total -> BC at the live ops-editable peg. Mirrors the charge path. */
function toCredits(totalEur: string | number, eurPerBc: number): number {
  const rate = Number.isFinite(eurPerBc) && eurPerBc > 0 ? eurPerBc : 1;
  return Math.round(Number(totalEur) / rate);
}

function iso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

/** The support-facing short reference. Computed HERE so the apps, ops and the
 *  server cannot drift into three different spellings of the same booking. */
export function reference(id: string): string {
  return 'BL-' + id.replace(/-/g, '').slice(-12).toUpperCase();
}

/**
 * Where the money is, in ONE word. Escrow first (it is the truth for an
 * auto-dispatch booking), then the payer's ledger, and never `payment_captured`.
 */
export function paymentState(
  bookingStatus: string,
  escrow: {status: string; basis?: string | null} | null,
  charged: number,
  refunded: number,
  dispute: {status: string} | null,
): PaymentState {
  if (escrow?.status === 'DISPUTED' || dispute?.status === 'open') {return 'under_review';}
  if (escrow) {
    if (escrow.status === 'HELD' || escrow.status === 'PENDING_RELEASE') {return 'held';}
    // For every SETTLED status the MONEY decides, not the label.
    //
    // A hold that was released and later CLAWED BACK (a dispute upheld after
    // release) keeps status 'RELEASED' for ever — only `basis` flips to
    // 'clawback' and to_client_credits is restated — so reading the status
    // alone reported PAID beside a non-zero refund in the same payload. And a
    // PARTIAL split can legitimately end with to_client 0 (a mission that ran
    // to completion before an abort, or a 100% cancellation fee), which is not
    // a refund at all.
    if (escrow.status === 'RELEASED' || escrow.status === 'PARTIAL' || escrow.status === 'REFUNDED') {
      if (refunded <= 0) {return escrow.status === 'REFUNDED' ? 'refunded' : 'released';}
      return refunded >= charged && charged > 0 ? 'refunded' : 'partially_refunded';
    }
  }
  if (refunded > 0) {return refunded >= charged && charged > 0 ? 'refunded' : 'partially_refunded';}
  if (charged > 0) {return 'paid';}
  // Nothing has moved. On the two statuses that are WAITING for the client to
  // pay that is a bill; anywhere else it is simply a booking that never charged
  // (NO_PROVIDER, a cancel before capture, a legacy admin row).
  if (bookingStatus === 'PAYMENT_PENDING' || bookingStatus === 'OPS_APPROVED') {return 'due';}
  return 'not_charged';
}
