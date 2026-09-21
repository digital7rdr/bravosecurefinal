import {BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, Optional} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService, type Tx} from '../database/database.service';
import {
  PricingService, resolveExecAddOns, resolveLeadHours, resolveDurationRule, resolveDurationHours,
  isTransferBlockService, resolveTransferBlockHours,
  DEFAULT_SERVICE_PRICING, type AddOnPricing, type ServicePricingConfig,
  applyDiscount,
} from './pricing.service';
import {BookingStateMachine, type ActorRole, type BookingStatus} from './state-machine.service';
import {MissionStateMachine, type MissionStatus} from '../ops/mission-state-machine.service';
import type {CreateBookingDto, EstimateBookingDto} from './dto/create-booking.dto';
import {TEAM_UNIT_MAX} from './dto/create-booking.dto';
import {CpoAssignmentService, type AssignedCpo} from './assignment/cpo-assignment.service';
import {VehiclePoolService, type AssignedVehicle} from './assignment/vehicle-pool.service';
import {regions, regionFromPoint, isInsideRegionBox, regionUtcOffsetHours} from '../common/regions';
import {areaIdForPoint} from '../common/areas';
import {RegionsService} from '../common/regions.service';
import {ReferralCampaignsService} from './referral-campaigns.service';

/**
 * Audit H5 — client-facing CPO shape: `AssignedCpo` minus the internal
 * agent user id. Used by the principal's getTeam so the officer's account
 * UUID never reaches the client.
 */
export type ClientAssignedCpo = Omit<AssignedCpo, 'id'>;
import {deriveVerifyCode} from '../dispatch/verify-code.util';
import {WalletService} from '../wallet/wallet.service';
import {FamilyService} from '../family/family.service';
import {familyCapRefusal} from '../family/family.service';
import type {PayerOption, ResolvedPayer} from '../family/family.service';
import {SettlementService} from '../settlement/settlement.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import type {CreateDisputeDto} from './dto/dispute.dto';
import {assertIdentityDocumentForBooking} from '../identity/identityGate';

// FSM defense-in-depth — client-cancel aborts the booking's live mission(s). The
// WHERE pins the from-states (DISPATCHED/PICKUP); asserting both keeps the FSM the
// single source of truth. SYSTEM actor: the server aborts on the client's behalf.
const missionFsm = new MissionStateMachine();
const MIN_LEAD_HOURS = 3;
// Team-sizing limits (mirrored client-side in src/screens/booking/pricing.ts).
// MAX_CPOS = the ONLY ceiling on a booking's detail (Control Room approves
// anything above 1).
//
// B-864 — founder, 2026-09-12: "cpo now increase as per vehicle, no it should
// not boundry on booking". Driver-only bookings used to cap CPOs at the free
// seats in the CLIENT's own car (4 - passengers), so a party of four could
// book exactly one CPO and the stepper died there. Worse, create() clamped a
// bigger Lite team DOWN silently, quoting one team and dispatching another.
// The client's vehicle no longer limits the detail: the team they pick is the
// team that is priced (the rate already adds 25% of base per CPO past the
// first) and dispatched. Bravo still assigns no vehicle in driver-only mode -
// seating is arranged with the client's own driver.
//
// B-876 - founder, 2026-09-14: "The limit is still here". The remaining 4 was
// a PRODUCT limit in disguise: the wizard's CPO + died at 4 and the Vehicles +
// stayed live and no-opped (the B-590 "rendered button that no-ops" class). The
// ceiling is now TEAM_UNIT_MAX - a SANITY bound against garbage input, NOT a
// product limit. Any team past the baseline (1 CPO + 1 Vehicle) is reviewed by
// the Bravo Control System, which is where the real judgement happens. ONE
// literal, exported from the DTO that bounds the wire, so this clamp can never
// disagree with what validation admitted.
const MAX_CPOS = TEAM_UNIT_MAX;
/** E-12 — persist bound for geocoder address strings (truncate, never reject). */
const ADDRESS_MAX = 500;

// Executive Protection — fixed 3-hour blocks and the task-type vocabulary (mirrored
// client-side in src/screens/executive/executiveProduct.ts).
const EXEC_TASK_TYPES = [
  'site_protection', 'event_security', 'close_protection',
  'residential_watch', 'asset_protection', 'other',
] as const;
const EXEC_TRANSPORT_MODES = ['one_way', 'return', 'both_ways'] as const;

/**
 * E2E-23 — the DB-level one-active-booking guard.
 *
 * `20260903120000_booking_guards_and_scale_indexes.sql` creates a PARTIAL UNIQUE
 * index on `lite_bookings(client_id)` WHERE
 * `booking_mode = 'now' AND status NOT IN (<terminal>)`.
 *
 * ⚠️ NARROWER THAN THE READ GUARD BELOW, ON PURPOSE. The read guard runs once at
 * INSERT; the index predicate is re-evaluated on EVERY UPDATE, so its exempt set
 * has to be closed under the transitions those rows make — and the read guard's
 * is not. Mirroring it would mean a B-405 parked `later` reservation ENTERS the
 * index the moment `DispatchService.start()` flips it to DISPATCHING, colliding
 * with the client's legitimately-concurrent `now` booking; `start()` has no
 * 23505 handler, so the scheduled sweep would retry forever and then the
 * stale-start sweep would CANCEL and refund the reservation. `booking_mode` is
 * immutable, so scoping to `now` means membership can only ever be LOST (on a
 * terminal status), never gained beside a sibling.
 *
 * Exported so the migration's index name has one owner in code and a spec can
 * pin both the name and the scoping decision.
 */
export const ONE_ACTIVE_BOOKING_INDEX = 'lite_bookings_one_active_per_client_uq';

/** Named-constraint match — never a bare 23505 (this INSERT has other uniques/FKs). */
function isOneActiveBookingViolation(e: unknown): boolean {
  const err = e as {code?: string; constraint?: string} | null;
  return err?.code === '23505' && err?.constraint === ONE_ACTIVE_BOOKING_INDEX;
}

/** Persisted exec_transport JSONB shape (validated below, never trusted raw). */
interface ExecTransportPersisted {
  mode: 'one_way' | 'return' | 'both_ways';
  pickup: {address: string; latitude: number; longitude: number};
  dropoff: {address: string; latitude: number; longitude: number};
  pickup_time: string | null;
  passengers: number;
}

/**
 * Audit fix #15 — single source of truth for supported regions on the
 * auth-service side. Mobile owns its own `REGION_SEED` (with city-level
 * zone geometry) in `src/screens/booking/ZoneMapScreen.tsx` and reads
 * availability counts from `/bookings/regions/availability`; this list
 * is what that endpoint enumerates. Add a new region here AND in the
 * mobile seed when expanding coverage.
 */
/**
 * A FUNCTION since 2026-09-01, not a const.
 *
 * It used to be `REGIONS.map(...)` evaluated at module load, which froze the
 * region list at process start — an ops-added region would have been invisible
 * to this service until the next restart, and every booking in it would have
 * been refused `unsupported_region`. Call it; do not hoist the result.
 */
export function supportedRegions(): ReadonlyArray<{code: string; name: string; launched: boolean}> {
  return regions().map(r => ({code: r.code, name: r.name, launched: r.launched}));
}

/** B-817 — the product name an operator reads in a feed row. */
export function bookingServiceLabel(service: string | null | undefined): string {
  switch (service) {
    case 'executive_protection': return 'Executive Protection';
    case 'recon_team':           return 'Recon Team';
    case 'emergency_extraction': return 'Emergency Extraction';
    case 'secure_transfer':      return 'Secure Transfer';
    default:                     return service ? service.replace(/_/g, ' ') : 'Secure';
  }
}

interface LiteBookingRow {
  id: string;
  client_id: string;
  status: BookingStatus;
  conversation_id: string | null;
  region_code: string;
  region_label: string;
  service: string;
  booking_mode: 'now' | 'later';
  pickup_time: Date;
  pickup_address: string;
  pickup_lat: string | null;
  pickup_lng: string | null;
  dropoff_address: string | null;
  dropoff_lat: string | null;
  dropoff_lng: string | null;
  passengers: number;
  cpo_count: number;
  vehicle_count: number;
  driver_only: boolean;
  add_ons: string[];
  rate_eur_per_hour: string;
  rate_aed_per_hour: string;
  duration_hours: number;
  total_eur: string;
  total_aed: string;
  /** Referral / discount campaign (2026-09-05). Absent on pre-migration rows. */
  referral_campaign_code?: string | null;
  referral_discount_eur?: string | null;
  payment_method: string;
  payment_captured: boolean;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  // Family shared credits (20260705100000) — the wallet the booking debits;
  // NULL for pre-stamp legacy rows (payer == client there).
  payer_user_id: string | null;
  // B-854 (A16) — the INTERMEDIARY on a chained booking: `payer_user_id` is the
  // wallet (the higher root), `client_id` is the spender, and this is the member
  // whose allowance it came out of. NULL on every non-chained booking, which is
  // why `payer_user_id` keeps its meaning for every existing reader.
  payer_via_user_id: string | null;
  // Auto-dispatch (Step 2 migration) — NULL for legacy admin-flow bookings.
  dispatch_mode: string | null;
  assigned_provider_user_id: string | null;
  dispatch_started_at: Date | null;
  dispatch_settled_at: Date | null;
  crew_deadline_at: Date | null;
  // Compliance / escrow requirements (Step 3 migration).
  armed_required: boolean;
  requirements: Record<string, unknown>;
  dispute_window_seconds: number | null;
  // Executive Protection (20260804150000) — NULL on non-executive bookings.
  task_type: string | null;
  exec_transport: ExecTransportPersisted | null;
}

interface AddOnRow {
  id: string;
  label: string;
  description: string | null;
  region_code: string;
  price_eur_per_hour: string;
  requires_ops_approval: boolean;
  active: boolean;
}

interface ClientSummary {
  bookings: ClientBooking[];
  total: number;
}

/** Referral campaign (2026-09-05) — what a code did to an estimate. */
export interface EstimateReferral {
  code: string;
  /** campaign = discount code; attribution = Issue 28 partner code (no discount); unknown = not recognised. */
  kind: 'campaign' | 'attribution' | 'unknown';
  applied: boolean;
  label: string | null;
  discount_eur: number;
  discount_bc: number;
  reason: string | null;
  message: string | null;
}

export interface ClientBooking {
  id: string;
  client_id: string;
  status: BookingStatus;
  type: 'transfer' | 'timeslot' | 'itinerary';
  region: string;
  region_label: string;
  service: string;
  pickup: {address: string; latitude: number; longitude: number};
  dropoff: {address: string; latitude: number; longitude: number} | null;
  start_time: string;
  passengers: number;
  cpo_count: number;
  vehicle_count: number;
  driver_only: boolean;
  add_ons: string[];
  estimated_price: number;
  duration_hours: number;
  total_eur: number;
  total_aed: number;
  /** Referral / discount campaign (2026-09-05): the code that discounted this
   *  booking and how much came off. `total_eur` is already net of it. */
  referral_campaign_code?: string | null;
  referral_discount_eur?: number;
  conversation_id: string | null;
  created_at: string;
  // Executive Protection — what the detail is for + the optional secure-transfer leg;
  // null/omitted on non-executive bookings.
  task_type?: string | null;
  exec_transport?: ExecTransportPersisted | null;
  // Executive Protection — hourly "all smooth" confirmations (getById only, executive only).
  hourly_checkins?: Array<{
    hour_index: number; status: string; comment: string | null; created_at: string;
  }>;
  // Ops-gated auto dispatch — 'auto' when the booking runs the offer cascade
  // (escrow-charged at accept, never payWithCredits); null on legacy bookings.
  // The client uses it to keep an approved auto booking out of the auto-pay flow.
  dispatch_mode?: string | null;
  // C-5 — TripSummary renders these; they were persisted at create but never
  // returned, so "Payment —" showed on every trip and the client's own notes
  // vanished from their receipt.
  payment_method?: string | null;
  notes?: string | null;
  booking_mode?: 'now' | 'later' | null;
  // Step 16 — present ONLY on the NO_PROVIDER terminal path; drives the
  // "no agency available" fallback card (hotline / widen / escalate). Omitted on
  // every other status so the legacy/admin booking shape is byte-for-byte unchanged.
  no_provider_fallback?: {
    hotline_e164: string;
    can_widen: boolean;
    can_escalate: boolean;
  } | null;
  // Surfaces the assigned mission's lifecycle (CREWED/DISPATCHED/PICKUP/LIVE/COMPLETED/
  // ABORTED) so the client's live-tracking stepper reflects real progress — the booking
  // FSM stays CONFIRMED while the mission advances, so booking.status alone can't tell
  // the story. Present on list and getById; null when no mission exists yet.
  mission_status?: string | null;
  // 2026-09-04 — the ONE customer-facing stage, derived server-side from
  // (booking.status × mission.status × booking_mode). The app renders copy from
  // this and never re-derives "dispatched" from raw statuses. See customerStageFor.
  stage?: CustomerStage;
  /** Server time the agency/lead pressed Dispatched; null until then. */
  dispatched_at?: string | null;
  /** Server time the lead arrived at the pickup point. */
  pickup_at?: string | null;
  /**
   * THE billable start — server time the mission went PICKUP → LIVE: the
   * lead's "Client received" confirmation, or (pre-existing) the telemetry
   * fallback 15 min after arrival, or an ops SOS→LIVE resolve. Never derived
   * from booking creation, the scheduled start, acceptance, dispatch, or any
   * client-supplied clock; never overwritten once set. Alias of missions.live_at.
   */
  client_received_at?: string | null;
  /** client_received_at + duration_hours — the booked service window's end. */
  service_window_end_at?: string | null;
  /**
   * Freshness token for the app: the newest of the booking row's and the
   * mission row's updated_at. A poll response older than what the app already
   * holds for this id must not overwrite it (stale-response guard).
   */
  updated_at?: string;
}

/** The mission columns the client projection reads (list + getById). */
interface MissionProjectionRow {
  booking_id: string;
  status: string;
  dispatched_at: Date | string | null;
  pickup_at: Date | string | null;
  live_at: Date | string | null;
  updated_at: Date | string | null;
  crew_accepted: boolean;
}

/**
 * 2026-09-04 — the customer-facing lifecycle, ONE vocabulary for every client
 * surface (home rows, live tracker header, pushes). Ordered on the happy path;
 * the terminal / side states carry no order.
 */
export type CustomerStage =
  | 'draft'
  | 'awaiting_approval'   // PENDING_OPS
  | 'scheduled'           // approved 'later' booking parked until its dispatch window
  | 'payment_pending'
  | 'finding_provider'    // DISPATCHING
  | 'provider_accepted'   // CONFIRMED, no crew yet
  | 'team_assigned'       // mission CREWED — crew named, NOT dispatched
  | 'team_dispatched'     // mission DISPATCHED — moving toward the client
  | 'team_arrived'        // mission PICKUP
  | 'service_started'     // mission LIVE — client received, billable window running
  | 'sos'
  | 'completed'
  | 'cancelled'
  | 'no_provider'
  | 'agency_no_show';

export function customerStageFor(
  bookingStatus: string | null | undefined,
  missionStatus: string | null | undefined,
  bookingMode?: string | null,
): CustomerStage {
  const b = (bookingStatus ?? '').toUpperCase();
  const m = (missionStatus ?? '').toUpperCase();
  // Booking terminals outrank any (stale) mission row.
  if (b === 'COMPLETED') {return 'completed';}
  if (b === 'CANCELLED') {return 'cancelled';}
  if (b === 'NO_PROVIDER') {return 'no_provider';}
  if (b === 'AGENCY_NO_SHOW') {return 'agency_no_show';}
  // A live mission outranks the (deliberately lagging) booking status.
  if (m === 'SOS') {return 'sos';}
  if (m === 'COMPLETED') {return 'completed';}
  if (m === 'LIVE') {return 'service_started';}
  if (m === 'PICKUP') {return 'team_arrived';}
  if (m === 'DISPATCHED') {return 'team_dispatched';}
  if (m === 'CREWED') {return 'team_assigned';}
  // ABORTED with a non-terminal booking = re-dispatching; fall through to the booking.
  if (b === 'LIVE') {return 'service_started';}
  if (b === 'CONFIRMED') {return 'provider_accepted';}
  if (b === 'DISPATCHING') {return 'finding_provider';}
  if (b === 'PAYMENT_PENDING') {return 'payment_pending';}
  if (b === 'OPS_APPROVED') {return bookingMode === 'later' ? 'scheduled' : 'finding_provider';}
  if (b === 'PENDING_OPS') {return 'awaiting_approval';}
  return 'draft';
}

/**
 * What the CLIENT is told about a mission — the raw mission status, verbatim.
 *
 * Issue 41 used to hide DISPATCHED until an officer had accepted, because
 * crew-assignment created the mission directly as DISPATCHED and "Team
 * dispatched" was a lie the instant the provider accepted. Since 2026-09-04 the
 * mission is created CREWED and DISPATCHED is an explicit act the agency or
 * lead performs, so the raw status IS the truth: CREWED reads "team assigned",
 * DISPATCHED reads "team dispatched", and no projection needs to wait.
 */
export function clientMissionStatus(
  mission: {status: string; crew_accepted?: boolean} | null | undefined,
): string | null {
  if (!mission) return null;
  return mission.status;
}

@Injectable()
export class BookingService {
  private readonly log = new Logger(BookingService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly pricing: PricingService,
    private readonly fsm: BookingStateMachine,
    private readonly cpoAssign: CpoAssignmentService,
    private readonly vehicles: VehiclePoolService,
    private readonly wallet: WalletService,
    private readonly family: FamilyService,
    private readonly settlement: SettlementService,
    private readonly config: ConfigService,
    // Optional so existing unit specs (which construct BookingService directly)
    // keep working; wake calls are guarded with `?.`.
    @Optional() private readonly bookingPush?: BookingPushBridge,
    // Optional for the same reason as bookingPush — the many specs that build
    // this service directly then run on the compiled DEFAULT_REGIONS, which is
    // exactly the pre-2026-09-01 behaviour they were written against.
    @Optional() private readonly regionsSvc?: RegionsService,
    // Optional for the same reason: the direct-construction specs predate
    // campaigns, and without the service a code simply takes the partner path.
    @Optional() private readonly campaigns?: ReferralCampaignsService,
  ) {}

  /**
   * POST /bookings — creates a DRAFT + immediately submits (→ PENDING_OPS, legacy flow).
   *
   * Step 19 (cut-over, dark behind AUTO_DISPATCH_ENABLED): when `opts.autoDispatch` is set
   * (the client-facing ClientDispatchController passes it), the booking is persisted as an
   * auto booking (`dispatch_mode='auto'`). Ops-gated auto dispatch: the auto booking is ALSO
   * submitted to PENDING_OPS — it lands on the ops board first, and ops approval (not the
   * client request) hands it to the matchmaker (OPS_APPROVED → DISPATCHING). The legacy path
   * (no opts) is byte-for-byte unchanged.
   */
  async create(
    clientId: string, dto: CreateBookingDto, opts?: {autoDispatch?: boolean; legacyClient?: boolean},
  ): Promise<{booking: ClientBooking}> {
    const auto = opts?.autoDispatch === true;
    // B-867 — an individual with no ID / passport on file may not START a
    // booking (any service, any mode; both the legacy and the auto-dispatch
    // create routes land here). 403 `identity_document_required` — the app
    // routes it to Profile → Identity verification. Server-side because the
    // client check is only a courtesy; this is the boundary.
    await assertIdentityDocumentForBooking(this.db, clientId);
    // Audit fix 0.8 — Pro tier gate. AI Itinerary booking is the lead
    // Pro feature; Lite clients see it locked client-side in the
    // ProDashboard. We backstop here so a Lite user calling the API
    // directly (or a future client regression) gets a clean 403 instead
    // of a created booking. Tier is read live from `public.users` so a
    // downgrade takes effect on the next call, not after JWT expiry.
    // Other booking types (transfer/timeslot) stay Lite-accessible.
    if (dto.type === 'itinerary') {
      // RS-19 (server) — a lapsed Pro window (pro_active_until in the past) is
      // effectively Lite even before the hourly lapse-sweep flips the column,
      // so gate on the LIVE entitlement, not the raw tier string. A NULL
      // pro_active_until is a permanent/comp grant (RS-17) and stays Pro.
      const tier = await this.db.qOne<{is_pro: boolean}>(
        `SELECT (subscription_tier = 'pro'
                 AND (pro_active_until IS NULL OR pro_active_until > now())) AS is_pro
           FROM public.users
          WHERE id = $1 AND deleted_at IS NULL`,
        [clientId],
      );
      if (!tier || !tier.is_pro) {
        throw new ForbiddenException({
          code: 'tier_insufficient',
          message: 'AI Itinerary booking requires a Pro subscription.',
          required_tier: 'pro',
        });
      }
    }

    // 2026-09-04 (founder: "a customer can have multiple bookings at the same
    // time — never assume one active booking"). The former "one mission at a
    // time" guard rejected a second booking while ANY non-parked one was open,
    // so a client with a confirmed detail this evening could not book tomorrow.
    // It is replaced by a CAP on OPEN bookings: every non-terminal row counts
    // (LB17 — NO_PROVIDER / AGENCY_NO_SHOW are terminal and never trap a client),
    // and the ceiling exists only so a runaway client cannot stack unbounded
    // future reservations that each pass the advisory affordability check and
    // all dispatch at T-15 (the B-405 concern, generalised from 1 + 3 parked).
    // Double-submit protection is the Idempotency-Key on BOTH create routes,
    // not this cap. Env BOOKING_MAX_OPEN_PER_CLIENT; default 5.
    // 2026-09-04 — a request with NO Idempotency-Key comes from an app built
    // before multi-booking: it shows ONE active booking, has no double-submit
    // key, and expects `active_booking_exists` (with the blocker's id, which it
    // navigates to) on a second submission. Keep the rule it was built against,
    // verbatim, B-405 parked-reservation exemption included. Keyed clients get
    // the open-bookings cap below.
    if (opts?.legacyClient) {
      const active = await this.db.qOne<{id: string; status: string}>(
        `SELECT id, status FROM lite_bookings
          WHERE client_id = $1
            AND status NOT IN ('COMPLETED','CANCELLED','NO_PROVIDER','AGENCY_NO_SHOW')
            AND NOT (booking_mode = 'later'
                     AND (status = 'PENDING_OPS'
                          OR (status = 'OPS_APPROVED' AND dispatch_mode = 'auto')))
          ORDER BY created_at DESC
          LIMIT 1`,
        [clientId],
      );
      if (active) {
        throw new BadRequestException({
          code: 'active_booking_exists',
          message: 'You already have an active booking. Finish or cancel it before starting another.',
          booking_id: active.id,
          booking_status: active.status,
        });
      }
    }
    const openCap = this.maxOpenBookingsPerClient();
    const open = await this.db.qOne<{n: number}>(
      `SELECT count(*)::int AS n FROM lite_bookings
        WHERE client_id = $1
          AND status NOT IN ('COMPLETED','CANCELLED','NO_PROVIDER','AGENCY_NO_SHOW')`,
      [clientId],
    );
    if ((open?.n ?? 0) >= openCap) {
      throw new BadRequestException({
        code: 'too_many_open_bookings',
        message: `You already have ${openCap} open bookings. Cancel one or let one complete before booking another.`,
        max_open: openCap,
      });
    }

    // Region gate — the booking must carry a region we actually dispatch in, or it is
    // un-rankable: the dispatch ranker hard-matches `agents.region_code = booking.region_code`
    // and the job feed now scopes by region too. Normalize casing + reject early with a clear
    // error instead of silently persisting a request no provider can ever be matched to.
    // Pull ops-managed regions before deciding, or a region added minutes ago is
    // rejected as unsupported and the client is told to pick another country.
    // 60 s cache, single-flighted, fail-open to the compiled set.
    await this.regionsSvc?.ensureFresh();
    const regionCode = (dto.region ?? '').trim().toUpperCase();
    if (!supportedRegions().some(r => r.code === regionCode)) {
      throw new BadRequestException({
        code: 'unsupported_region',
        message: `Region "${dto.region}" is not supported. Supported regions: ${supportedRegions().map(r => r.code).join(', ')}.`,

      });

    }


    // Derived HERE, before anything prices or lead-times: the pickup point, never
    // dto.region. Used by both the quote and the lead-time gate below.
    const priceRegion = regionFromPoint(dto.pickup?.latitude, dto.pickup?.longitude);

    // B-788b — a pickup outside the zone's own box used to price on the GLOBAL
    // board (no region → global) and be accepted. The client's city ring made
    // that unreachable; with the ring gone (B-788, founder: no distance
    // restriction) the server has to refuse it explicitly. Fails OPEN when the
    // region carries no box (the compiled seed never does): a box is data, and
    // no data must never block every booking in a region.
    //
    // E2E-31 (2026-09-03) — this ALSO closes the region CHIP vs pickup POINT
    // mismatch. They were two independent facts pointing different ways:
    // `region_code` is persisted from the client chip and dispatch HARD-MATCHES
    // `agents.region_code = booking.region_code`, while pricing uses
    // `regionFromPoint(pickup)`. A ZA pin on an AE chip priced ZA, dispatched
    // into AE, and was guaranteed `NO_PROVIDER` — after the client had been
    // quoted, consented and (on the auto path) affordability-checked.
    //
    // REFUSE rather than silently re-derive `region_code` from the point.
    // Deriving would move the booking into a region the client never saw:
    // `region_label`, the add-on catalogue, the availability chip and every
    // price the wizard rendered are keyed off the chip, and dispatch would then
    // offer the job to agencies in a country the client did not choose. A typed
    // 400 keeps display == charge == dispatch — the same reject-never-reprice
    // posture the exec rules already take.
    //
    // The error body NAMES the other zone whenever the point is unambiguously
    // inside exactly ONE other region's box, so the client can render "switch
    // the zone to <X>". It stays silent about where when the geometry is
    // ambiguous: ops rectangles are hand-entered and CAN overlap (a plausible AE
    // box and a plausible SA box share the western Gulf), so naming a region off
    // first-match-wins would point a paying customer at the wrong country. The
    // refusal itself still stands either way — a pin outside the chosen zone is
    // undispatchable regardless of what else contains it.
    if (isInsideRegionBox(regionCode, dto.pickup?.latitude, dto.pickup?.longitude) === false) {
      const elsewhere = regions().filter(
        r => r.code !== regionCode
          && isInsideRegionBox(r.code, dto.pickup?.latitude, dto.pickup?.longitude) === true,
      );
      const actual = elsewhere.length === 1 ? elsewhere[0]!.code : null;
      throw new BadRequestException({
        code: 'pickup_outside_region',
        message: actual
          ? `Your pickup location is in ${actual}, but the booking is set to ${regionCode}. Switch the zone to ${actual} (or move the pin) and try again.`
          : `The pickup is outside ${regionCode}. Move the pin into the zone or change the booking zone.`,
        region_code: regionCode,
        pickup_region: actual,
      });
    }

    // B-788a — the operational area (province) this pickup routes in. The LOOKUP
    // fails open (no match → NULL, the router resolves it lazily); the INSERT's
    // area_id column below is a HARD migration dependency — deploy order is
    // migration → server, always.
    let areaId: string | null = null;
    try {
      areaId = await areaIdForPoint(this.db, regionCode, dto.pickup?.latitude, dto.pickup?.longitude);
    } catch (e) {
      this.log.warn(`area stamp skipped: ${(e as Error).message}`);
    }

    const pickupTime = new Date(dto.start_time);
    if (Number.isNaN(pickupTime.getTime())) {
      throw new BadRequestException('Invalid start_time');
    }
    const now = Date.now();
    if (dto.service === 'executive_protection') {
      // EP is ALWAYS SCHEDULED (client change 2026-08-31). It used to be exempt
      // from the lead gate entirely, because "Book Now" wrote start_time =
      // submit-time by design; that mode no longer exists, so the exemption is
      // gone and the lead rule is unconditional here.
      //
      // Server time is the authority. The client computes an earliest-selectable
      // time for the picker, but it can be stale (screen left open), optimistic
      // (config changed under it) or simply a manipulated device clock — so the
      // decision is made HERE, against Date.now(), on every create.
      await this.assertExecLeadTime(pickupTime, now, {service: dto.service, region: priceRegion});
    } else {
      // Step 24 — on-demand exemption, UNCHANGED for every non-EP service. An
      // "I need a guard NOW" auto request (the headline feature) is dispatched
      // immediately, so it skips the scheduling lead-time gate; a SCHEDULED
      // ("later") auto request and every legacy booking still honor it.
      const isOnDemandAuto = auto && (dto.booking_mode ?? 'now') === 'now';
      if (!isOnDemandAuto && pickupTime.getTime() < now + MIN_LEAD_HOURS * 3600_000) {
        throw new BadRequestException(
          `Minimum ${MIN_LEAD_HOURS}-hour lead time required. Earliest: ${new Date(now + MIN_LEAD_HOURS * 3600_000).toISOString()}`,
        );
      }
    }

    // Step 22 — lawful-basis consent gate (auto path only). Auto-dispatch shares the
    // client's precise pickup + live location with a third-party agency, so we require
    // an explicit location + terms consent before persisting. The legacy ops-mediated
    // path keeps its existing implicit flow (byte-for-byte unchanged); consent stamps
    // are still recorded below whenever the client supplies them.
    if (auto && (dto.location_consent !== true || dto.terms_accepted !== true)) {
      throw new BadRequestException({
        code: 'consent_required',
        message: 'Location-sharing and terms consent are required to dispatch an agency.',
      });
    }

    // ─── Executive Protection (service 'executive_protection') — fixed-block validation ──────────────
    // Fail BEFORE any pricing so a malformed executive request can never be quoted,
    // let alone escrowed, on the wrong numbers.
    const isExec = dto.service === 'executive_protection';
    let execTransport: ExecTransportPersisted | null = null;
    if (isExec) {
      const dh = dto.duration_hours ?? 0;
      if (dh < 3 || dh > 24 || dh % 3 !== 0) {
        throw new BadRequestException({
          code: 'exec_invalid_duration',
          message: 'Executive Protection is booked in fixed 3-hour blocks between 3 and 24 hours.',
        });
      }
      const taskType = dto.task_type ?? 'site_protection';
      if (!(EXEC_TASK_TYPES as readonly string[]).includes(taskType)) {
        throw new BadRequestException({
          code: 'exec_invalid_task_type',
          message: `task_type must be one of: ${EXEC_TASK_TYPES.join(', ')}.`,
        });
      }
      const t = dto.exec_transport;
      if (t) {
        const legOk = (p?: {latitude?: unknown; longitude?: unknown}) =>
          !!p && typeof p.latitude === 'number' && Number.isFinite(p.latitude)
              && typeof p.longitude === 'number' && Number.isFinite(p.longitude);
        if (!(EXEC_TRANSPORT_MODES as readonly string[]).includes(t.mode) || !legOk(t.pickup) || !legOk(t.dropoff)) {
          throw new BadRequestException({
            code: 'exec_invalid_transport',
            message: 'exec_transport needs mode (one_way/return/both_ways) and pickup + dropoff coordinates.',
          });
        }
        let transferTime: string | null = null;
        if (t.pickup_time) {
          const parsed = new Date(t.pickup_time);
          if (Number.isNaN(parsed.getTime())) {
            throw new BadRequestException({code: 'exec_invalid_transport', message: 'exec_transport.pickup_time is not a valid time.'});
          }
          // Sanity window: the transfer belongs to the protection block —
          // allow up to 2 h before the start (pre-positioning) through the
          // end of the block. A leg dated days away is a stale-client bug.
          const startMs = pickupTime.getTime();
          const endMs = startMs + dh * 3600_000;
          if (parsed.getTime() < startMs - 2 * 3600_000 || parsed.getTime() > endMs) {
            throw new BadRequestException({
              code: 'exec_transport_time_out_of_window',
              message: 'The transfer pickup time must fall within the protection block.',
            });
          }
          transferTime = parsed.toISOString();
        }
        const pax = Math.max(1, Math.min(16, Math.trunc(Number(t.passengers ?? dto.passengers ?? 1)) || 1));
        execTransport = {
          mode: t.mode,
          // E-12 — the nested DTO skips the pipe (manual validation, see class
          // comment), so bound the persisted addresses here.
          pickup:  {address: (t.pickup.address ?? '').slice(0, 500),  latitude: t.pickup.latitude,  longitude: t.pickup.longitude},
          dropoff: {address: (t.dropoff.address ?? '').slice(0, 500), latitude: t.dropoff.latitude, longitude: t.dropoff.longitude},
          pickup_time: transferTime,
          passengers: pax,
        };
      }
    }

    const requestedAddOnIds = [...new Set(dto.add_ons ?? [])];
    // B-788b — the transfer leg is a second pickup; same rule, same fail-open.
    if (execTransport && isInsideRegionBox(regionCode, execTransport.pickup.latitude, execTransport.pickup.longitude) === false) {
        throw new BadRequestException({
          code: 'exec_transport_outside_region',
        message: `The transfer pickup is outside ${regionCode}. Move the pin into the zone or change the booking zone.`,
        });
      }
      const pricingCfg = (await this.pricing.config?.(priceRegion)) ?? DEFAULT_SERVICE_PRICING;
    const addOns = isExec
      ? resolveExecAddOns(dto.add_ons ?? [], pricingCfg)
      : await this.resolveAddOns(dto.region, dto.add_ons ?? []);
    if (addOns === null) {
      throw new BadRequestException({
        code: 'exec_unknown_addon',
        message: 'One or more add-ons are not available for Executive Protection.',
      });
    }
    // B-385 — Lite mirrored exec's posture: an inactive / out-of-region / unknown
    // add-on id used to be dropped SILENTLY while the raw list persisted on the
    // booking — the row then advertised an add-on nobody was charged for and the
    // agency staffed a phantom requirement. Reject, never silently reprice.
    if (!isExec && addOns.length < requestedAddOnIds.length) {
      throw new BadRequestException({
        code: 'unknown_add_on',
        message: 'One or more selected add-ons are not available in this region. Refresh and try again.',
      });
    }

    // Industry norm — "Driver Only (Client Vehicle)": the client supplies the
    // vehicle, so Bravo dispatches a vetted security driver but NO Bravo
    // vehicle. Normalize vehicle_count to 0 here so pricing (no extra-vehicle
    // surcharge), persistence, and ops dispatch (no vehicle to assign) all
    // agree. The 0.65× driver-only discount is applied inside PricingService.
    const driverOnly = dto.driver_only ?? false;
    // Why: `?? 1` only substitutes null/undefined, not a stray 0. With the DTO now
    // admitting vehicle_count=0 (driver-only), clamp non-driver bookings back to a
    // 1-vehicle baseline so a 0 can't create a mispriced/undispatchable booking.
    // executive differs: vehicles exist ONLY with a secure-transfer leg, so 0 is the
    // legitimate floor there (protection-only detail, nothing to drive).
    const vehicleCount = isExec
      ? (driverOnly ? 0 : Math.max(0, Math.min(dto.vehicle_count ?? 0, TEAM_UNIT_MAX)))
      : (driverOnly ? 0 : Math.max(1, dto.vehicle_count ?? 1));

    // executive: vehicles / a Bravo driver only make sense when a transfer leg
    // exists — reject instead of silently repricing what the client saw.
    if (isExec && !execTransport && (vehicleCount > 0 || driverOnly)) {
      throw new BadRequestException({
        code: 'exec_transport_required',
        message: 'Vehicles and driver-only options require a secure-transfer leg on an Executive Protection booking.',
      });
    }
    // …and the inverse: a transfer leg with nothing to drive it (no vehicle,
    // no Bravo driver) would persist legs the pricing never charged for.
    if (isExec && execTransport && vehicleCount === 0 && !driverOnly) {
      throw new BadRequestException({
        code: 'exec_vehicle_required',
        message: 'A secure-transfer leg needs at least one vehicle, or the driver-only option.',
      });
    }

    // B-864 — MAX_CPOS is the only ceiling, in BOTH modes. No seat clamp: the
    // client's own car does not decide how many CPOs they may book.
    const requestedCpos = dto.cpo_count ?? 1;
    const cpoCount = Math.max(1, Math.min(requestedCpos, MAX_CPOS));

    // executive: silently repricing what the client reviewed is banned — if the
    // ceiling would change the team, reject so the client re-confirms.
    if (isExec && cpoCount !== requestedCpos) {
      throw new BadRequestException({
        code: 'exec_cpo_cap',
        message: `At most ${MAX_CPOS} CPOs per booking. Adjust the team and try again.`,
      });
    }

    // E-14 — capacity floor (API-only reachable; the wizard derives vehicles from
    // passengers at 3/vehicle). Without it a 12-pax / 1-vehicle booking is accepted,
    // underpriced, and physically unboardable on the ground.
    if (!isExec && !driverOnly && vehicleCount * 3 < (dto.passengers ?? 1)) {
      throw new BadRequestException({
        code: 'vehicle_capacity_insufficient',
        message: 'Not enough vehicles for the passenger count. Add vehicles and try again.',
      });
    }

    // 2026-09-04 — the duration the client selected is validated against the
    // service's ops-configurable rule and is the ONLY length that is priced and
    // stored; an absent value takes the rule's default (formerly a compiled 4).
    // Executive Protection already rejected off-grid blocks above, so this is a
    // no-op for it; every hourly service now gets the same reject-never-reprice.
    const durationHours = this.resolveDurationOrThrow(dto.service, dto.duration_hours, pricingCfg);

    const grossPrice = this.pricing.calculate({
      cpoCount,
      vehicleCount,
      driverOnly,
      durationHours,
      pickupTime,
      addOns,
      regionCode,   // LM-M2 — local peak-hour window
      service: dto.service,   // 'executive_protection' → per-unit fixed-block formula
    }, pricingCfg);

    // Referral / discount campaign (2026-09-05) — decided on the GROSS total,
    // BEFORE the affordability check and the insert, so the stored total_eur is
    // already net of the discount and every charge path downstream (pay with
    // credits, offer accept, the B-795 committed sum) inherits it without
    // knowing a discount exists. A campaign code that does not apply is
    // REFUSED here, never silently charged full price; a non-campaign code
    // falls through to the Issue 28 partner attribution below. The campaign
    // is never handed to dispatch: it changes this number and nothing else.
    const campaign = (await this.campaigns?.resolveForBooking({
      code: dto.referral_code ?? '',
      userId: clientId,
      regionCode,
      service: dto.service ?? 'secure_transfer',
      grossEur: grossPrice.total_eur,
      eurPerBc: pricingCfg.eur_per_bc,
    })) ?? null;
    const price = campaign
      ? applyDiscount(grossPrice, campaign.discountEur, pricingCfg)
      : grossPrice;

    // LM-B7 — resolve the PAYER once at request time (family holder, or the client
    // themselves) and soft-check affordability BEFORE any agency is ever offered the
    // job. Two effects: (a) a short balance routes the client to the paywall now,
    // instead of surfacing `insufficient_credits` to the AGENCY at accept-time
    // (leaking the client's financial state); (b) a family member's booking charges
    // the holder's wallet at accept (holdToEscrow debits payer_user_id).
    //
    // B-843 (A1) — the payer resolution is HOISTED above the `auto` gate, and the
    // payer bound at the INSERT below is `payer.payerId`, never `dto.payer_user_id`.
    // The legacy path stamps the column too, so a client-supplied id that reached
    // the row unresolved would be read as truth by refunds, ops and history. Only
    // the balance/quota SOFT checks stay auto-gated.
    const payer = await this.family.resolvePayer(clientId, dto.payer_user_id ?? null);
    const payerUserId: string = payer.payerId;
    if (auto) {
      // eur_per_bc root: the BC hold is the converted total, not raw EUR.
      const cost = price.total_bc;
      // Spec §21 — a suspended ROOT account freezes every member draw on it, no
      // matter how much quota the member still has. Checked before the cap so
      // the member is told the real reason rather than a limit message.
      //
      // B-854 (A5) — on a CHAINED booking `holderSuspended` is the WALLET
      // owner's suspension, and the refusal still names the member's own root
      // (`holder_id`), never the account above it. A suspended INTERMEDIARY
      // never reaches here chained at all: the resolver drops the chain, and the
      // plain hop's `holderSuspended` is then that same suspension — so a
      // suspended account on EITHER rung stops the booking, and it is never a
      // silent hop to a different wallet (B-843 A21 inverted).
      if (payer.familyRowId && payer.holderSuspended) {
        // B-724 spec 'member notified on purchase-blocked' — the inline API
        // error is transient; leave a durable, throttled notification too.
        void this.bookingPush?.familySpendDenied(clientId, payer.holderId ?? null).catch(() => undefined);
        throw new BadRequestException({
          code: 'ROOT_ACCOUNT_SUSPENDED',
          message: 'root_account_suspended',
          ...(await this.familyRefusalContext(clientId, payer)),
        });
      }
      // B-854 (A5) — BOTH caps. `familyCapRefusal` reports whichever actually
      // blocked (the smaller REMAINING), so the member is not told to ask the
      // wrong person for more credit. Non-chained bookings still carry exactly
      // one cap and the body is unchanged, figure for figure.
      const capBlocked = familyCapRefusal(payer, cost);
      if (capBlocked) {
        // Same additive shape as `insufficient_credits` above: `message` keeps
        // the raw code already-shipped clients match on, `code` is the spec's
        // §8 name, and the figures let the UI render the limit screen and its
        // "Request More Credit" action without a second round trip.
        // B-724 spec 'member notified on purchase-blocked' — the inline API
        // error is transient; leave a durable, throttled notification too.
        void this.bookingPush?.familySpendDenied(clientId, payer.holderId ?? null).catch(() => undefined);
        throw new BadRequestException({
          code: 'SPENDING_QUOTA_EXCEEDED',
          message: 'family_spend_limit_exceeded',
          ...capBlocked,
          ...(await this.familyRefusalContext(clientId, payer)),
        });
      }
      const bal = await this.db.qOne<{bravo_credits: number}>(
        `SELECT bravo_credits FROM wallet_balances WHERE user_id = $1`,
        [payerUserId],
      );
      const have = Number(bal?.bravo_credits ?? 0);
      // B-795 — a client may hold several open bookings and each is charged at
      // its OWN accept (or pay step), so the balance must cover this booking PLUS
      // every other booking of this payer that has not been charged yet (no
      // escrow hold before CONFIRMED). Otherwise three bookings pass on one
      // balance and the second and third are cancelled at accept with a
      // payment-failed push. Stored totals are EUR; same root peg as pay time.
      const pending = await this.db.qOne<{committed_eur: string}>(
        `SELECT COALESCE(SUM(total_eur), 0)::text AS committed_eur
           FROM lite_bookings
          WHERE COALESCE(payer_user_id, client_id) = $1
            AND status IN ('PENDING_OPS', 'OPS_APPROVED', 'PAYMENT_PENDING', 'DISPATCHING')`,
        [payerUserId],
      );
      const committed = Math.max(0, Math.round(Number(pending?.committed_eur ?? '0') / pricingCfg.eur_per_bc));
      if (cost > 0 && have < cost + committed) {
        // Same shape as payWithCredits — the client routes to the top-up paywall.
        // Issue 25 — `message` stays the raw code so already-shipped clients that
        // match on it keep working; `code`/`required`/`balance` are additive and
        // let a current client show the exact shortfall.
        throw new BadRequestException({
          code: 'insufficient_credits',
          message: 'insufficient_credits',
          required: cost + committed,
          this_booking: cost,
          ...(await this.insufficientPayerContext(clientId, payer, {balance: have, committed})),
        });
      }
    }

    // State transition: both paths persist (no state) → DRAFT → PENDING_OPS directly (the
    // client only ever submits a committed draft). Ops-gated auto dispatch: the auto
    // booking goes to the ops board too — ops approval later triggers the offer cascade.
    this.fsm.assert('DRAFT', 'PENDING_OPS', 'CLIENT');

    // Issue 28 — resolve the referral code BEFORE the insert so an unknown or
    // expired one is rejected up front rather than silently recorded. Blank is
    // fine; the field is optional. Deliberately NOT passed to the matchmaker:
    // the PDF requires that a code never bypass availability, licensing or
    // operator approval, so this is attribution only.
    // A code that resolved as a CAMPAIGN above is not also a partner code.
    const referral = campaign ? null : await this.resolveReferralCode(dto.referral_code);

    // B-847 — Why: there is no card lane for BOOKINGS. Stripe exists only for
    // wallet top-ups, and every booking debit (the escrow hold taken at agency
    // accept, and payWithCredits) spends Bravo Credits regardless of this column;
    // nothing in the service branches on it, so a stored 'card' is a pure mislabel
    // on the ops console and Trip Summary. Clients <= 1.0.307 still send the legacy
    // 'card' default, so the value is normalised HERE rather than rejected at the
    // DTO (an already-shipped client must not start failing to book). Remove this
    // mapping only when a real card lane ships.
    const paymentMethod = dto.payment_method === 'card' ? 'bravo_credits' : dto.payment_method;

    // E2E-23 (2026-09-03) — the one-active-booking rule is now enforced by the
    // partial unique index `lite_bookings_one_active_per_client_uq` as well as
    // by the read-then-throw above. The read is a TOCTOU (two concurrent creates
    // both see "no active booking" and both insert); the index is the only
    // enforcement that survives a race. Translate its 23505 into the SAME error
    // shape the read-path throws, so the client renders one thing either way.
    let inserted: LiteBookingRow | null;
    try {
      inserted = await this.db.qOne<LiteBookingRow>(
      // $25 = status, $26 = dispatch_mode appended at the end so the legacy $1–$24 bindings
      // stay byte-for-byte; legacy => ('PENDING_OPS', NULL), auto => ('PENDING_OPS', 'auto').
      `INSERT INTO lite_bookings (
        client_id, status, dispatch_mode, region_code, region_label, service,
        booking_mode, pickup_time, pickup_address, pickup_lat, pickup_lng,
        dropoff_address, dropoff_lat, dropoff_lng,
        passengers, cpo_count, vehicle_count, driver_only, add_ons,
        rate_eur_per_hour, rate_aed_per_hour, duration_hours, total_eur, total_aed,
        payment_method, notes,
        location_consent_at, location_consent_version, terms_accepted_at, terms_accepted_version,
        payer_user_id, pricing_breakdown,
        referral_code, referral_code_id,
        task_type, exec_transport, area_id,
        referral_campaign_id, referral_campaign_code, referral_discount_eur,
        payer_via_user_id
      ) VALUES (
        $1, $25, $26, $2, $3, $4,
        $5, $6, $7, $8, $9,
        $10, $11, $12,
        $13, $14, $15, $16, $17::jsonb,
        $18, $19, $20, $21, $22,
        $23, $24,
        $27, $28, $29, $30,
        $31, $32::jsonb,
        $33, $34,
        $35, $36::jsonb, $37,
        $38, $39, $40,
        $41
      ) RETURNING *`,
      [
        clientId,
        regionCode,
        dto.region_label ?? regionCode,
        dto.service ?? 'secure_transfer',
        dto.booking_mode ?? 'now',
        pickupTime,
        // E-12 — truncate (never reject) third-party geocoder strings.
        (dto.pickup.address ?? '').slice(0, ADDRESS_MAX),
        dto.pickup.latitude,
        dto.pickup.longitude,
        dto.dropoff?.address ? dto.dropoff.address.slice(0, ADDRESS_MAX) : null,
        dto.dropoff?.latitude ?? null,
        dto.dropoff?.longitude ?? null,
        dto.passengers ?? 1,
        cpoCount,
        vehicleCount,
        driverOnly,
        // B-385 — persist the RESOLVED set (what was actually priced+charged),
        // never the raw request list.
        JSON.stringify(addOns.map(a => a.id)),
        price.rate_eur_per_hour,
        price.rate_aed_per_hour,
        durationHours,                   // $20 — the SAME hours the quote above was priced with
        price.total_eur,
        price.total_aed,
        paymentMethod,                   // $23 B-847 — normalised, never the raw DTO value
        dto.notes ?? null,
        'PENDING_OPS',                   // $25 status — auto submits to the ops board too
        auto ? 'auto' : null,            // $26 dispatch_mode
        // Step 22 — consent stamps. Recorded when the client supplies them (always
        // on the auto path, where the gate above made them mandatory). $27–$30.
        dto.location_consent === true ? new Date() : null,
        dto.location_consent === true ? (dto.location_consent_version ?? null) : null,
        dto.terms_accepted === true ? new Date() : null,
        dto.terms_accepted === true ? (dto.terms_accepted_version ?? null) : null,
        payerUserId,                     // $31 LM-B7/B-843 — the RESOLVED payer, both paths
        // $32 F1 — persist the itemised quote; the invoice must reflect the
        // lines the client saw, not a recomputation.
        JSON.stringify(price.breakdown ?? []),
        // $33/$34 Issue 28 — the code as submitted (denormalised so reporting
        // survives the code row being deactivated) plus the FK for ops joins.
        referral?.code ?? null,
        referral?.id ?? null,
        // $35/$36 Executive Protection — task + optional secure-transfer leg.
        isExec ? (dto.task_type ?? 'site_protection') : null,
        execTransport ? JSON.stringify(execTransport) : null,
        // $37 B-788a — the operational area this pickup routes in (NULL pre-migration).
        areaId,
        // $38–$40 referral campaign (2026-09-05): the discount already taken
        // off total_eur above, kept so gross is recoverable for reporting.
        campaign?.campaign.id ?? null,
        campaign?.campaign.code ?? null,
        campaign?.discountEur ?? 0,
        // $41 B-854 — the chain, from the RESOLUTION and never from the DTO
        // (there is no DTO field, and there must not be one: B-843 A1 is the
        // precedent — a client-supplied id that reached the row unresolved
        // would be read as truth by refunds, ops and history). NULL unless the
        // resolver actually found a live funding row.
        payer.viaUserId ?? null,
      ],
      );
    } catch (e) {
      // Constraint-NAMED, never a bare 23505: this INSERT can also violate the
      // referral FK or any future unique on the table, and swallowing those into
      // "you already have an active booking" would hide a real bug.
      if (isOneActiveBookingViolation(e)) {
        // The winner's id is not known here (the losing INSERT has no RETURNING),
        // so re-read it — the same row the read-path guard would have named.
        const winner = await this.db.qOne<{id: string; status: string}>(
          `SELECT id, status FROM lite_bookings
            WHERE client_id = $1
              AND status NOT IN ('COMPLETED','CANCELLED','NO_PROVIDER','AGENCY_NO_SHOW')
              AND NOT (booking_mode = 'later'
                       AND (status = 'PENDING_OPS'
                            OR (status = 'OPS_APPROVED' AND dispatch_mode = 'auto')))
            ORDER BY created_at DESC
            LIMIT 1`,
          [clientId],
        ).catch(() => null);
        throw new BadRequestException({
          code: 'active_booking_exists',
          message: 'You already have an active booking. Finish or cancel it before starting another.',
          booking_id: winner?.id ?? null,
          booking_status: winner?.status ?? null,
        });
      }
      throw e;
    }

    if (!inserted) throw new BadRequestException('Failed to create booking');
    if (campaign) {
      // Why AFTER the insert: the ledger row means "a booking was discounted",
      // and a booking whose INSERT failed was not. Logged, never thrown — a
      // ledger miss must not fail a booking the client has already made.
      this.campaigns?.recordRedemption({
        campaignId: campaign.campaign.id,
        bookingId: inserted.id,
        userId: clientId,
        regionCode,
        service: dto.service ?? 'secure_transfer',
        grossEur: grossPrice.total_eur,
        discountEur: campaign.discountEur,
      }).catch((e: unknown) => this.campaigns?.warnLedgerMiss(inserted.id, e));
    }
    if (referral) {
      // Why AFTER the insert: a bump at validation time counted redemptions for
      // bookings whose INSERT then failed, skewing partner reporting. Still
      // best-effort — a failure here must never fail the booking.
      this.db
        .q(`UPDATE provider_referral_codes SET redeemed_count = redeemed_count + 1 WHERE id = $1`, [referral.id])
        .catch((e: unknown) => this.log.warn(`referral counter bump failed: ${(e as Error).message}`));
    }
    await this.audit(inserted.id, null, 'DRAFT', clientId, 'CLIENT', {reason: 'draft_created'});
    if (auto) {
      // Ops-gated auto dispatch: the auto booking waits on the ops board; approval
      // (OpsService.approveBooking) hands it to the matchmaker, not the client request.
      await this.audit(inserted.id, 'DRAFT', 'PENDING_OPS', clientId, 'CLIENT', {reason: 'submitted_for_ops'});
      this.log.log(`Booking ${inserted.id} PENDING_OPS(auto) for client ${clientId} — awaiting ops approval`);
    } else {
      await this.audit(inserted.id, 'DRAFT', 'PENDING_OPS', clientId, 'CLIENT', {reason: 'submitted'});
      this.log.log(`Booking ${inserted.id} PENDING_OPS for client ${clientId}`);
    }
    await this.emitOpsFeed({
      kind: 'booking.request', severity: 'warn', subject: inserted.id.slice(0, 8),
      message: `New ${bookingServiceLabel(inserted.service)} booking · ${inserted.region_label ?? inserted.region_code}`
        + `${(inserted.booking_mode ?? 'now') === 'later' ? ' · scheduled' : ''} · waiting for ops approval`,
      metadata: {
        booking_id: inserted.id, service: inserted.service, region: inserted.region_code,
        booking_mode: inserted.booking_mode ?? 'now', dispatch_mode: auto ? 'auto' : 'legacy',
      },
    });

    return {booking: this.toClientBooking(inserted)};
  }

  /**
   * B-843 (A10) — re-validate a booking's STAMPED payer at charge time, the same
   * way the escrow accept does (B-384): the live `(member, holder)` row, locked.
   *
   * The stamp can be days old on a scheduled booking, so a holder who has since
   * revoked the member, put them on hold, or lowered the cap must not be debited.
   * A missing or held row is REFUSED — the pre-B-843 legacy path silently fell
   * back to the member's OWN wallet here, which charged the wrong person for a
   * booking the root had explicitly stopped.
   *
   * MON-4 — this is a `family_members` lock taken BEFORE the wallet lock below,
   * so the repo-wide family → wallet order is unchanged. `FOR UPDATE OF fm` locks
   * only the membership row: a bare `FOR UPDATE` across the join would also lock
   * the holder's `users` row, a lock this path has never held.
   *
   * Suspension and the cap are NOT decided here — they fall through to the
   * existing §21 check and the authoritative locked cap gate, so there is exactly
   * one place each of those rules lives.
   */
  private async validateStampedPayer(
    tx: Tx, memberId: string, holderId: string,
  ): Promise<ResolvedPayer> {
    const fam = await tx.qOne<{
      id: string; held_until: Date | null; holder_name: string | null;
      spend_limit_credits: number | null; spent_credits: number; holder_suspended_at: Date | null;
    }>(
      `SELECT fm.id, fm.held_until, fm.spend_limit_credits, fm.spent_credits,
              h.display_name AS holder_name, h.suspended_at AS holder_suspended_at
         FROM public.family_members fm
         JOIN public.users h ON h.id = fm.holder_id
        WHERE fm.member_id = $1 AND fm.holder_id = $2 AND fm.status = 'active'
        FOR UPDATE OF fm`,
      [memberId, holderId],
    );
    const onHold = !!fam?.held_until && new Date(fam.held_until).getTime() > Date.now();
    if (!fam || onHold) {
      void this.bookingPush?.familySpendDenied(memberId, holderId).catch(() => undefined);
      throw new BadRequestException({
        code: 'PAYER_NOT_ELIGIBLE',
        message: "That account can't pay for this booking right now.",
        holder_id: holderId,
        holder_name: fam?.holder_name ?? null,
      });
    }
    return {
      payerId: holderId, familyRowId: fam.id,
      spendLimit: fam.spend_limit_credits, spent: Number(fam.spent_credits ?? 0),
      holderSuspended: fam.holder_suspended_at !== null,
      holderId, holderName: fam.holder_name ?? 'Plan holder',
    };
  }

  /** The ONE refusal a broken chain produces. It names the member's own root
   *  (the intermediary), never the wallet above it — a member must not learn
   *  about an account they are not a member of (LM-B7). */
  private chainRefusal(viaId: string | null, holderName: string | null): BadRequestException {
    return new BadRequestException({
      code: 'PAYER_NOT_ELIGIBLE',
      message: "That account can't pay for this booking right now.",
      holder_id: viaId,
      holder_name: holderName,
    });
  }

  /**
   * B-854 (A2) — lock a set of membership rows in ONE statement, ordered by id.
   *
   * A total order, not a local one. "Upstream before member" reads like an
   * order but is not: two members of the same intermediary, and a pair of
   * mutual funders, each produce a lock cycle under it. Ordering by primary key
   * inside a single statement cannot — Postgres puts LockRows above the Sort,
   * so the rows are taken in the order they come out.
   *
   * Aliased `fr`, deliberately NOT `fm`: the B-384 and MON-4 source scans anchor
   * on the FIRST occurrence of `FROM public.family_members fm`, and that has to
   * keep landing on `validateStampedPayer` above (A1). `FOR UPDATE OF fr` for
   * the same reason the other sites use `OF fm` — no joined table is locked.
   */
  private async lockFamilyRowsInOrder(
    tx: Tx, rowIds: string[],
  ): Promise<Array<{id: string; spend_limit_credits: number | null; spent_credits: number}>> {
    const rows = await tx.q<{id: string; spend_limit_credits: number | null; spent_credits: number}>(
      `SELECT fr.id, fr.spend_limit_credits, fr.spent_credits
         FROM public.family_members fr
        WHERE fr.id = ANY($1::uuid[])
        ORDER BY fr.id
        FOR UPDATE OF fr`,
      [rowIds],
    );
    // P2-4 — every id asked for must come back. A row that vanished between the
    // id read and the lock (a hard delete, or an id that never matched) would
    // otherwise leave its cap unchecked and its `spent` unbumped — an uncapped
    // draw on somebody's allowance, which is the opposite of what this lock is
    // here for. Fail closed; the caller turns it into a neutral refusal.
    if (rows.length !== rowIds.length) {return [];}
    return rows;
  }

  /**
   * B-854 (A3) — re-validate a CHAINED stamp at charge time, the B-384 way.
   *
   * The stamp says "this booking is paid by A, through B, for C". Every part of
   * that can have died since: A may have switched the chain off, revoked B, put
   * B on hold or been suspended; B may have been suspended or erased; the (B,C)
   * row may be gone. Fail CLOSED on all of it — the pre-B-843 habit of silently
   * dropping to a different wallet is what charges the wrong person for a
   * booking a root had explicitly stopped.
   *
   * Both cap rows are locked in ONE ordered statement (A2), BEFORE the wallet
   * row below, so the repo-wide family → wallet order (MON-4) is unchanged and
   * two concurrent chained charges serialise instead of deadlocking.
   *
   * What is NOT decided here: suspension and the caps. A suspended account on
   * either rung comes out as `holderSuspended` and falls through to the single
   * §21 check; the caps fall through to the authoritative locked gate. One rule,
   * one place, exactly as `validateStampedPayer` does it.
   */
  private async validateChainedPayer(
    tx: Tx, memberId: string, walletId: string | null, viaId: string,
  ): Promise<ResolvedPayer> {
    // A2 — a chain that pays for its own spender is not a chain: it would
    // charge C for C's own booking while consuming two caps, and the refund's
    // `memberId === holderId` early return then strands both.
    if (!walletId || walletId === memberId || viaId === memberId || walletId === viaId) {
      void this.bookingPush?.familySpendDenied(memberId, viaId).catch(() => undefined);
      throw this.chainRefusal(viaId, null);
    }
    // Ids first, so the LOCK can be a single statement with a total order. This
    // read is unlocked and only chooses WHICH rows to lock; every decision below
    // is made from the locked projection. An ACTIVE row wins over a revoked one
    // for the same pair, which a bare `LIMIT 1` would pick arbitrarily.
    const ids = await tx.qOne<{member_row_id: string | null; funding_row_id: string | null}>(
      `SELECT
         (SELECT mr.id FROM public.family_members mr
           WHERE mr.member_id = $1 AND mr.holder_id = $2
           ORDER BY (mr.status = 'active') DESC, mr.id LIMIT 1) AS member_row_id,
         (SELECT fu.id FROM public.family_members fu
           WHERE fu.member_id = $2 AND fu.holder_id = $3
           ORDER BY (fu.status = 'active') DESC, fu.id LIMIT 1) AS funding_row_id`,
      [memberId, viaId, walletId],
    );
    const rowIds = [ids?.member_row_id, ids?.funding_row_id].filter((x): x is string => !!x);
    if (rowIds.length !== 2) {
      void this.bookingPush?.familySpendDenied(memberId, viaId).catch(() => undefined);
      throw this.chainRefusal(viaId, null);
    }
    const locked = await tx.q<{
      id: string; holder_id: string; member_id: string | null; status: string;
      held_until: Date | null; spend_limit_credits: number | null; spent_credits: number;
      funds_sub_members: boolean; holder_name: string | null;
      holder_suspended_at: Date | null; holder_deleted_at: Date | null;
    }>(
      `SELECT fr.id, fr.holder_id, fr.member_id, fr.status, fr.held_until,
              fr.spend_limit_credits, fr.spent_credits, fr.funds_sub_members,
              hu.display_name AS holder_name,
              hu.suspended_at AS holder_suspended_at, hu.deleted_at AS holder_deleted_at
         FROM public.family_members fr
         JOIN public.users hu ON hu.id = fr.holder_id
        WHERE fr.id = ANY($1::uuid[])
        ORDER BY fr.id
        FOR UPDATE OF fr`,
      [rowIds],
    );
    const mine = locked.find(r => r.holder_id === viaId && r.member_id === memberId);
    const fund = locked.find(r => r.holder_id === walletId && r.member_id === viaId);
    const now = Date.now();
    const dead = (r: typeof mine): boolean =>
      !r || r.status !== 'active' || r.holder_deleted_at !== null
      || (!!r.held_until && new Date(r.held_until).getTime() > now);
    // The funding row must still be FLAGGED. A stamp that outlived the switch
    // is exactly §5-edge-11: refused here, and the client re-picks a payer.
    if (dead(mine) || dead(fund) || !fund?.funds_sub_members) {
      void this.bookingPush?.familySpendDenied(memberId, viaId).catch(() => undefined);
      throw this.chainRefusal(viaId, mine?.holder_name ?? null);
    }
    return {
      // A4 — the WALLET pays, the SHOWN root is named.
      payerId: walletId, familyRowId: (mine as NonNullable<typeof mine>).id,
      spendLimit: (mine as NonNullable<typeof mine>).spend_limit_credits,
      spent: Number((mine as NonNullable<typeof mine>).spent_credits ?? 0),
      // A suspended account on EITHER rung freezes the draw: the intermediary's
      // because it is the member's own root, the wallet owner's because it is
      // the money. Both surface as §21 naming the intermediary.
      holderSuspended: (mine as NonNullable<typeof mine>).holder_suspended_at !== null
        || fund.holder_suspended_at !== null,
      holderId: viaId, holderName: (mine as NonNullable<typeof mine>).holder_name ?? 'Plan holder',
      fundingRowId: fund.id, fundingHolderId: walletId, viaUserId: viaId,
      fundingSpendLimit: fund.spend_limit_credits,
      fundingSpent: Number(fund.spent_credits ?? 0),
    };
  }

  /**
   * B-843 (A11) — every money refusal NAMES the root it is about, and offers the
   * others when there are others. Without the name a member under two roots is
   * told "your spending limit is exhausted" with no way to know whose.
   *
   * `options` only appears at two or more memberships: below that there is
   * nothing to choose between, and shipping a one-entry picker is noise.
   * `payerOptions` is called through `?.` because several specs build
   * BookingService with a `{resolvePayer}`-only double — a refusal must never
   * turn into a different error while trying to describe itself.
   */
  private async familyRefusalContext(
    clientId: string, payer: Pick<ResolvedPayer, 'holderId' | 'holderName'>, on?: Tx,
  ): Promise<{holder_id: string | null; holder_name: string | null; options?: PayerOption[]}> {
    let options: PayerOption[] = [];
    try {
      // F4 — `on` is the CALLER'S OPEN TRANSACTION when there is one. Every
      // refusal in `payWithCredits` fires while the member row is held FOR
      // UPDATE, and reading off the pool there checks out a SECOND connection
      // while locks are held — under pool pressure that is a wait for a
      // connection only this transaction can free.
      options = (await this.family.payerOptions?.(clientId, on)) ?? [];
    } catch { /* a refusal may never fail while decorating itself */ }
    return {
      holder_id:   payer.holderId ?? null,
      holder_name: payer.holderName ?? null,
      ...(options.length >= 2 ? {options} : {}),
    };
  }

  /**
   * A7 (LM-B7) — the `insufficient_credits` body for a booking whose payer may be
   * a ROOT.
   *
   * When the payer is not the caller, `balance` and `committed` are OMITTED:
   * they are the ROOT's finances, and a member must not be able to read them by
   * submitting a cheap booking. `payer_is_self` is what tells the client to
   * offer "pay from another account" instead of routing to the top-up paywall —
   * which, for a root-paid booking, is a loop the member cannot exit (B-384).
   */
  private async insufficientPayerContext(
    clientId: string,
    payer: Pick<ResolvedPayer, 'familyRowId' | 'holderId' | 'holderName'>,
    figures: {balance: number; committed?: number},
    on?: Tx,
  ): Promise<Record<string, unknown>> {
    if (!payer.familyRowId) {
      return {
        payer_is_self: true,
        balance: figures.balance,
        ...(figures.committed !== undefined ? {committed: figures.committed} : {}),
      };
    }
    return {payer_is_self: false, ...(await this.familyRefusalContext(clientId, payer, on))};
  }

  /**
   * B-817 — the ops console's notification centre reads `live_feed_events`,
   * and a NEW booking never wrote one: an operator learned of it only from a
   * KPI count going up. BookingModule cannot inject OpsAuditService (OpsModule
   * imports this module), so this is the same raw, best-effort insert the
   * protection service uses. `metadata` carries the FULL ids the console needs
   * to deep-link; `subject` stays the 8-char short form the feed displays.
   */
  private async emitOpsFeed(ev: {
    kind: string; severity: 'info' | 'ok' | 'warn' | 'err';
    subject: string; message: string; metadata: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.db.q(
        `INSERT INTO live_feed_events (kind, severity, actor, subject, message, metadata)
         VALUES ($1, $2, NULL, $3, $4, $5::jsonb)`,
        [ev.kind, ev.severity, ev.subject, ev.message, JSON.stringify(ev.metadata)],
      );
    } catch (e) {
      this.log.warn(`ops feed emit failed for ${ev.kind}: ${(e as Error).message}`);
    }
  }

  /**
   * Pay an OPS_APPROVED booking with Bravo Credits. Transitions the booking
   * OPS_APPROVED → PAYMENT_PENDING → CONFIRMED, debits the wallet, and
   * triggers CPO + vehicle assignment from the pool. Throws 400 with
   * `insufficient_credits` when the wallet is short — the client should then
   * route the user to the top-up paywall and retry.
   *
   * B-843 (A10) — WHO pays, in priority order:
   *   1. `body.payerUserId` whenever the client offers one (re-validated through
   *      `resolvePayer`, so the member can switch to their own wallet or another
   *      root after a refusal);
   *   2. otherwise the booking's STAMPED `payer_user_id`, re-validated the B-384
   *      way against the live `(member, holder)` row under `FOR UPDATE`;
   *   3. otherwise `resolvePayer(client, null)` — the pre-stamp legacy rows only.
   *
   * Argument order is unchanged (`clientId` first) on purpose: this is a money
   * entry point with a live controller and several specs bound to it, and a
   * silent swap of two same-typed string arguments is the shape that charges the
   * wrong account.
   */
  async payWithCredits(
    clientId: string, bookingId: string, body?: {payerUserId?: string | null},
  ): Promise<{booking: ClientBooking}> {
    // Run booking-status + wallet-debit + booking-flip atomically.
    //
    // Why a single transaction:
    //   - Two-device race: previously both clients could pass the status
    //     check (first flips OPS_APPROVED→PAYMENT_PENDING; second sees
    //     PAYMENT_PENDING and the old code's OR-branch let it through),
    //     then both call debit, draining the wallet twice for one booking.
    //   - Without `SELECT FOR UPDATE` on both rows, two concurrent calls
    //     each see balance ≥ cost, each insert a negative tx row, and
    //     `applyCreditDelta` decrements twice — net wallet drain of 2×.
    //
    // The transaction holds row locks on lite_bookings + wallet_balances
    // for its entire body. The second concurrent caller blocks on the
    // first's COMMIT/ROLLBACK, then runs the same checks against the
    // already-updated state and gets `Cannot pay booking in state
    // CONFIRMED` deterministically — never debits.
    //
    // Hoisted so the post-commit quota-threshold warning (spec §33/§34) can see
    // which membership row was actually charged. Set inside the txn, read only
    // after it commits — on a rollback it stays null and nothing is announced,
    // which is the point: a warning for a charge that never happened would be a
    // lie the holder acts on.
    let chargedFamilyRowId: string | null = null;
    // B-854 — the SECOND row a chained charge bumps. Both are warned about
    // after the commit: the root hears about the intermediary's allowance, the
    // intermediary hears about their own member's limit.
    let chargedFundingRowId: string | null = null;
    const updated = await this.db.withTransaction(async tx => {
      const row = await tx.qOne<LiteBookingRow>(
        `SELECT * FROM lite_bookings WHERE id = $1 AND client_id = $2 FOR UPDATE`,
        [bookingId, clientId],
      );
      if (!row) throw new NotFoundException('Booking not found');
      // Why: ops-gated auto dispatch parks auto bookings in OPS_APPROVED between the ops
      // approve and the matchmaker start. They are escrow-charged at offer-accept; letting
      // the legacy pay path run here would double-charge AND derail the offer cascade.
      if (row.dispatch_mode === 'auto') {
        throw new BadRequestException('auto_booking_pays_at_accept');
      }
      if (row.status !== 'OPS_APPROVED' && row.status !== 'PAYMENT_PENDING') {
        throw new BadRequestException(`Cannot pay booking in state ${row.status}`);
      }

      // B-405 later-payment — stored totals are EUR; convert at the LIVE
      // root rate at charge time (identical at the shipped 1.0).
      const payCfg = (await this.pricing.config?.()) ?? DEFAULT_SERVICE_PRICING;
      const cost = Math.round(Number(row.total_eur) / payCfg.eur_per_bc);
      if (cost <= 0) throw new BadRequestException('Booking has no chargeable total');

      if (row.status === 'OPS_APPROVED') {
        this.fsm.assert('OPS_APPROVED', 'PAYMENT_PENDING', 'CLIENT');
        await tx.q(`UPDATE lite_bookings SET status = 'PAYMENT_PENDING' WHERE id = $1`, [bookingId]);
      }

      // Family shared credits — if this client is an active family member,
      // the booking is charged to the HOLDER's wallet (resolvePayer returns
      // the holder; for everyone else it returns the client themselves, so
      // non-members are unaffected). The cap, if set, bounds a member's draw.
      const offeredPayer = body?.payerUserId ?? null;
      let payer: ResolvedPayer;
      if (offeredPayer) {
        // A10 — an explicit choice always wins, and is re-validated: a root the
        // caller is not (or is no longer) under is PAYER_NOT_ELIGIBLE, never a
        // silent fallback to somebody else's wallet.
        // F4 — on `tx`, not the pool: this runs inside the charge transaction.
        payer = await this.family.resolvePayer(clientId, offeredPayer, tx);
        // B-854 (P1-1) — `resolvePayer` reads the chain UNLOCKED, and the only
        // lock that used to follow on this lane projects `id,
        // spend_limit_credits, spent_credits`: the FLAG, the status, the hold
        // and both suspensions are never re-read. A root switching the chain
        // off — or revoking, or holding — between the resolve and the lock
        // still got their wallet debited, because the cap gate passed and
        // nothing else looked. Same class as B-384, one rung up: re-read the
        // whole chain under the lock and fail closed on any of it.
        if (payer.fundingRowId && payer.viaUserId) {
          payer = await this.validateChainedPayer(tx, clientId, payer.payerId, payer.viaUserId);
        }
      } else if (row.payer_via_user_id) {
        // B-854 (A3) — tested BEFORE the stamped-non-self branch. A chained
        // stamp is ALSO a non-self payer, so the old branch would have taken it
        // first and re-resolved `(client, wallet)` — a pair that has no row, so
        // every chained booking would refuse PAYER_NOT_ELIGIBLE naming an
        // account the member has never heard of.
        payer = await this.validateChainedPayer(tx, clientId, row.payer_user_id, row.payer_via_user_id);
      } else if (row.payer_user_id && row.payer_user_id !== clientId) {
        payer = await this.validateStampedPayer(tx, clientId, row.payer_user_id);
      } else if (row.payer_user_id === clientId) {
        // Stamped SELF at creation — the member already decided, and re-resolving
        // could route them into PAYER_CHOICE_REQUIRED for a booking that has none.
        payer = {
          payerId: clientId, familyRowId: null, spendLimit: null, spent: 0,
          holderSuspended: false, holderId: null, holderName: null,
        };
      } else {
        // F4 — same connection as the transaction, for the same reason.
        payer = await this.family.resolvePayer(clientId, null, tx);
      }
      const payerId = payer.payerId;
      // Spec §21 — a suspended ROOT account stops all member spending on it.
      // First, because it outranks both the quota and the balance.
      if (payer.familyRowId && payer.holderSuspended) {
        // B-724 spec 'member notified on purchase-blocked' — the inline API
        // error is transient; leave a durable, throttled notification too.
        void this.bookingPush?.familySpendDenied(clientId, payer.holderId ?? null).catch(() => undefined);
        throw new BadRequestException({
          code: 'ROOT_ACCOUNT_SUSPENDED',
          message: 'root_account_suspended',
          ...(await this.familyRefusalContext(clientId, payer, tx)),
        });
      }
      // Cheap early-out: resolvePayer's read is unlocked (it also serves pre-flight
      // soft checks), so a clearly-over-cap member fails fast without taking a lock.
      // NOT the authoritative gate — the locked re-read below is (MON-4).
      // B-854 (A5) — both caps, tighter one reported.
      const softCap = familyCapRefusal(payer, cost);
      if (softCap) {
        // B-724 spec 'member notified on purchase-blocked' — the inline API
        // error is transient; leave a durable, throttled notification too.
        void this.bookingPush?.familySpendDenied(clientId, payer.holderId ?? null).catch(() => undefined);
        throw new BadRequestException({
          code: 'SPENDING_QUOTA_EXCEEDED',
          message: 'family_spend_limit_exceeded',
          ...softCap,
          ...(await this.familyRefusalContext(clientId, payer, tx)),
        });
      }
      // B-854 (A2) — a chained charge has a SECOND cap row, and both are locked
      // in ONE statement ordered by id. Taken BEFORE the existing member-row
      // lock (which then simply finds its row already held) so the ordered
      // statement is the only place either row is FIRST acquired — that, not
      // "upstream before member", is what makes two concurrent chained charges
      // impossible to deadlock. Still before the wallet lock, like every other
      // family lock in this method (MON-4).
      let lockedFundingLimit: number | null = null;
      let lockedFundingSpent = 0;
      if (payer.familyRowId && payer.fundingRowId) {
        const both = await this.lockFamilyRowsInOrder(tx, [payer.familyRowId, payer.fundingRowId]);
        const fund = both.find(r => r.id === payer.fundingRowId);
        if (!fund) {
          void this.bookingPush?.familySpendDenied(clientId, payer.viaUserId ?? null).catch(() => undefined);
          throw this.chainRefusal(payer.viaUserId ?? null, payer.holderName ?? null);
        }
        lockedFundingLimit = fund.spend_limit_credits;
        lockedFundingSpent = Number(fund.spent_credits ?? 0);
      }
      // MON-4 — authoritative cap gate: re-read the member row FOR UPDATE inside THIS
      // txn (resolvePayer reads it UNLOCKED — on this same connection since F4,
      // but still without FOR UPDATE, so it is a snapshot, not a gate). Locking here
      // serializes concurrent charges for the same member — the second blocks until the
      // first commits its spent_credits bump, then reads the fresh total. Taken BEFORE
      // the wallet lock below to keep a single family→wallet lock order across paths.
      if (payer.familyRowId) {
        const locked = await tx.qOne<{spent_credits: number; spend_limit_credits: number | null}>(
          `SELECT spent_credits, spend_limit_credits FROM public.family_members
            WHERE id = $1 FOR UPDATE`,
          [payer.familyRowId],
        );
        const spent = Number(locked?.spent_credits ?? 0);
        const limit = locked?.spend_limit_credits;
        // B-854 (A5) — the authoritative gate reads BOTH caps from the values
        // taken under lock above, and reports whichever actually blocked.
        const hardCap = familyCapRefusal({
          familyRowId:       payer.familyRowId,
          spendLimit:        limit ?? null,
          spent,
          fundingRowId:      payer.fundingRowId ?? null,
          fundingSpendLimit: lockedFundingLimit,
          fundingSpent:      lockedFundingSpent,
        }, cost);
        if (hardCap) {
          // B-724 spec 'member notified on purchase-blocked' — the inline API
          // error is transient; leave a durable, throttled notification too.
          void this.bookingPush?.familySpendDenied(clientId, payer.holderId ?? null).catch(() => undefined);
          throw new BadRequestException({
            code: 'SPENDING_QUOTA_EXCEEDED',
            message: 'family_spend_limit_exceeded',
            ...hardCap,
            ...(await this.familyRefusalContext(clientId, payer, tx)),
          });
        }
      }

      // Lock the PAYER's wallet balance row before reading/debiting.
      const balance = await tx.qOne<{bravo_credits: number; currency: string}>(
        `SELECT bravo_credits, currency FROM wallet_balances WHERE user_id = $1 FOR UPDATE`,
        [payerId],
      );
      if (!balance) {
        // No balance row yet — auto-init at 0 inside the txn, then
        // fall through to the insufficient_credits branch below.
        await tx.q(
          `INSERT INTO wallet_balances (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
          [payerId],
        );
      }
      const have = Number(balance?.bravo_credits ?? 0);
      if (have < cost) {
        // Issue 25 — see the twin throw in requestAuto: `message` keeps the raw
        // code for already-shipped clients, the rest is additive.
        throw new BadRequestException({
          code: 'insufficient_credits',
          message: 'insufficient_credits',
          required: cost,
          ...(await this.insufficientPayerContext(clientId, payer, {balance: have}, tx)),
        });
      }

      // Insert the debit ledger row + decrement balance, both locked. The
      // ledger records the actual payer; the description notes a family
      // charge so the holder can see why their balance moved.
      const desc = payer.familyRowId ? `Booking ${bookingId} (family member)` : `Booking ${bookingId}`;
      // family_row_id pins the cap bookkeeping to the CHARGE-TIME membership
      // row, so a much later refund reverses that row — not whatever active
      // row exists then (revoke → re-invite would otherwise eat fresh spend).
      //
      // B-854 (D4/A6) — on a CHAINED charge `family_row_id` is the FUNDING row,
      // because that is the cap the money on THIS wallet was taken against, and
      // it is what the refund reverses first. The member's own row rides as
      // `via_family_row_id`, and `via_user_id` is what lets the root's sheet
      // read "C via B" instead of attributing C's spend to B.
      const payMeta = JSON.stringify(
        payer.familyRowId
          ? {
              family_row_id: payer.fundingRowId ?? payer.familyRowId,
              ...(payer.fundingRowId
                ? {via_family_row_id: payer.familyRowId, via_user_id: payer.viaUserId ?? null}
                : {}),
            }
          : {},
      );
      await tx.q(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, booking_id, metadata, settled_at, actor_user_id, feature
         ) VALUES ($1, 'payment', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW(), $7, 'booking')`,
        [payerId, -cost, balance?.currency ?? 'AED', desc, bookingId, payMeta, clientId],
      );
      await tx.q(
        `UPDATE wallet_balances SET bravo_credits = bravo_credits - $1 WHERE user_id = $2`,
        [cost, payerId],
      );
      // Bump the member's running family spend for the cap (best-effort —
      // outside-balance bookkeeping, the debit above is the source of truth).
      if (payer.familyRowId) {
        await tx.q(
          `UPDATE public.family_members SET spent_credits = spent_credits + $2 WHERE id = $1`,
          [payer.familyRowId, cost],
        );
        chargedFamilyRowId = payer.familyRowId;
      }
      // B-854 (D4) — a chained charge consumes BOTH allowances: the spender's
      // own limit under the intermediary, AND the intermediary's limit under
      // the root whose wallet actually paid. Bumping only one of them is how
      // the root's exposure would silently exceed what they granted (R3).
      if (payer.fundingRowId) {
        await tx.q(
          `UPDATE public.family_members SET spent_credits = spent_credits + $2 WHERE id = $1`,
          [payer.fundingRowId, cost],
        );
        chargedFundingRowId = payer.fundingRowId;
      }

      this.fsm.assert('PAYMENT_PENDING', 'CONFIRMED', 'SYSTEM');
      // Stamp the actual payer so ops/holder views can show "under <owner>"
      // on family-charged bookings (the auto path stamps it at insert; this
      // legacy path previously left it NULL).
      // B-386 — confirmed_at anchors the legacy cancel window (the window text
      // says "of confirmation"; anchoring to created_at locked scheduled
      // bookings out before they were even payable).
      //
      // B-854 (A3) — the via stamp is REWRITTEN from the resolution, never left
      // as it was found. `body.payerUserId` outranks the stamp (B-843 A10), so a
      // member who re-fires a chained booking against their own wallet must not
      // leave `payer_via_user_id` pointing at a chain that no longer paid for
      // it — every refund, history row and ops view reads these two together.
      const upd = await tx.qOne<LiteBookingRow>(
        `UPDATE lite_bookings
            SET status = 'CONFIRMED', payment_captured = TRUE, payer_user_id = $2,
                payer_via_user_id = $3,
                confirmed_at = COALESCE(confirmed_at, NOW())
          WHERE id = $1 RETURNING *`,
        [bookingId, payerId, payer.viaUserId ?? null],
      );
      if (!upd) throw new NotFoundException('Booking not found after payment');
      return upd;
    });

    // Audit rows outside the txn — best-effort; their failure shouldn't
    // unwind the wallet debit.
    await this.audit(bookingId, 'OPS_APPROVED', 'PAYMENT_PENDING', clientId, 'CLIENT', {reason: 'payment_initiated'}).catch(() => undefined);
    await this.audit(bookingId, 'PAYMENT_PENDING', 'CONFIRMED', clientId, 'SYSTEM', {reason: 'payment_captured'}).catch(() => undefined);

    // Spec §33/§34 — warn the holder if this charge pushed the member across
    // 80/90/100% of their quota. Crossing-based inside, so ten small bookings
    // inside one band produce one warning, not ten.
    //
    // try/catch rather than `.catch()`: the payment is already COMMITTED at this
    // point, so nothing here may propagate — and a `.catch()` cannot catch a
    // synchronous throw, which is precisely what an older FamilyService without
    // this method would produce.
    try {
      await this.family.notifyUsageThreshold(chargedFamilyRowId);
      // B-854 — the funding row crossed a band too, and its warning goes to a
      // DIFFERENT holder. Awaited separately so one failing warning cannot
      // swallow the other.
      await this.family.notifyUsageThreshold(chargedFundingRowId);
    } catch { /* a warning may never undo a captured payment */ }

    return {booking: this.toClientBooking(updated)};
  }

  /**
   * Read the assigned team for a booking. Powers the BookingConfirmation
   * and LiveTracking crew panels. Ownership-checked against the caller.
   *
   * Audit H5 — privacy: the internal agent USER UUID (`AssignedCpo.id`) is
   * stripped from the CLIENT-facing payload. A principal never needs the
   * agent's account id, and exposing it enabled cross-mission correlation /
   * enumeration of a specific officer. The human-facing fields the product
   * intends to surface (call sign, display name, armed/female, specialties)
   * are retained — `call_sign` is the public identifier the UI keys on. The
   * full `AssignedCpo` (with id) is still returned to OPS via its own path
   * (cpoAssign.getForBooking), which is operator-trusted.
   */
  async getTeam(clientId: string, bookingId: string): Promise<{
    cpos: ClientAssignedCpo[];
    vehicle: AssignedVehicle | null;
  }> {
    const row = await this.db.qOne<{id: string}>(
      `SELECT id FROM lite_bookings WHERE id = $1 AND client_id = $2`,
      [bookingId, clientId],
    );
    if (!row) throw new NotFoundException('Booking not found');
    // Auto-dispatch crew lives in mission_crew; legacy admin-assigned crew lives in
    // booking_cpo_assignments. Prefer the mission crew (real officers) so an auto-dispatched
    // booking's client team card shows the assigned guards instead of "assigning" forever.
    const [missionCrew, vehicle] = await Promise.all([
      this.cpoAssign.getMissionCrewForBooking(bookingId),
      this.vehicles.getForBooking(bookingId),
    ]);
    const cpos = missionCrew.length > 0
      ? missionCrew
      : await this.cpoAssign.getForBooking(bookingId);
    // Drop the internal agent id; keep the public detail card fields.
    const redacted: ClientAssignedCpo[] = cpos.map(({id: _id, ...rest}) => rest);
    return {cpos: redacted, vehicle};
  }

  /**
   * The ONE Executive Protection lead-time decision. `create()` and `estimate()`
   * both route through it so a quote can never succeed for a start time the
   * booking would reject (the estimate/create parity rule) - that split is how a
   * client gets priced for a booking that cannot exist.
   *
   * `nowMs` is passed in rather than read here so a single request evaluates one
   * consistent instant, and so the boundary is testable to the millisecond.
   *
   * Boundary: `start >= now + lead` is VALID. Strictly-less is rejected, so
   * exactly-3h passes and 2h59m59.999s does not.
   */
  /**
   * The region a booking is PRICED and lead-timed in — derived, never taken from
   * the client.
   *
   * `dto.region` is attacker-controlled: it is validated against the supported
   * list and then used for DISPATCH matching, which is fine because naming the
   * wrong region there only means no provider can be matched. Pricing is
   * different — naming the cheapest region would simply buy the cheapest rate.
   * 20260831180000 refused to scope lead time for exactly this reason.
   *
   * So the pricing region comes from the pickup COORDINATES via the ops-managed
   * bounding boxes. `null` (no coordinates, or a point in no box) means GLOBAL,
   * which is the safe direction: it can never be cheaper than the global price.
   */
  private async pricingRegion(pickup?: {latitude?: number; longitude?: number} | null): Promise<string | null> {
    await this.regionsSvc?.ensureFresh();
    return regionFromPoint(pickup?.latitude, pickup?.longitude);
  }

  private async assertExecLeadTime(
    startAt: Date, nowMs: number,
    opts?: {service?: string; region?: string | null},
  ): Promise<void> {
    const cfg = (await this.pricing.config?.(opts?.region ?? null)) ?? DEFAULT_SERVICE_PRICING;
    const leadHours = resolveLeadHours(opts?.service ?? 'executive_protection', cfg);
    if (leadHours <= 0) {return;}
    const earliestMs = nowMs + leadHours * 3600_000;
    if (startAt.getTime() < earliestMs) {
      throw new BadRequestException({
        code: 'exec_insufficient_lead_time',
        message: `Your selected start time is too soon. Please choose a time at least ${leadHours} hour(s) from now.`,
        // Echoed so the client can re-seed its picker from the AUTHORITATIVE
        // value instead of its own (possibly stale) config, and so the message
        // never has to hardcode a number.
        lead_hours: leadHours,
        earliest_start: new Date(earliestMs).toISOString(),
      });
    }
  }

  async estimate(dto: EstimateBookingDto, userId?: string): Promise<{
    total: number; total_bc: number; breakdown: Record<string, number>;
    rate_per_hour: number; duration_hours: number; total_aed: number;
    /** 2026-09-04 — the ops-configured duration rule the picker renders. */
    duration_rule: {default: number; min: number; max: number; grid?: number[]};
    /** Referral campaign (2026-09-05): the pre-discount BC figure. */
    gross_bc: number;
    /** Present only when a code was sent. */
    referral?: EstimateReferral;
  }> {
    // Executive Protection estimates use the fixed executive catalogue + per-unit formula so
    // the preview equals what create() will charge, to the credit.
    const isExec = dto.service === 'executive_protection';
    if (isExec) {
      // Mirror create()'s block rule — an estimate for a duration create()
      // would reject is a quote for a booking that can never exist.
      const dh = dto.duration_hours ?? 0;
      if (dh < 3 || dh > 24 || dh % 3 !== 0) {
        throw new BadRequestException({
          code: 'exec_invalid_duration',
          message: 'Executive Protection is booked in fixed 3-hour blocks between 3 and 24 hours.',
        });
      }
    }
    // The estimate must quote what create() will charge, so it resolves the
    // pricing region the same way — from the coordinates, never dto.region.
    const estRegion = await this.pricingRegion(dto.pickup);
    // B-788b — estimate/create parity: a quote for a pickup create() will
    // refuse is a quote for a booking that can never exist.
    const estZone = (dto.region ?? '').trim().toUpperCase();
    if (estZone && isInsideRegionBox(estZone, dto.pickup?.latitude, dto.pickup?.longitude) === false) {
      throw new BadRequestException({
        code: 'pickup_outside_region',
        message: `The pickup is outside ${estZone}. Move the pin into the zone or change the booking zone.`,
      });
    }
    const pricingCfg = (await this.pricing.config?.(estRegion)) ?? DEFAULT_SERVICE_PRICING;
    const addOns = isExec
      ? resolveExecAddOns(dto.add_ons ?? [], pricingCfg)
      : await this.resolveAddOns(dto.region, dto.add_ons ?? []);
    if (addOns === null) {
      throw new BadRequestException({
        code: 'exec_unknown_addon',
        message: 'One or more add-ons are not available for Executive Protection.',
      });
    }
    // B-385 parity — estimate must not quote a Lite add-on set create() will reject.
    if (!isExec && addOns.length < [...new Set(dto.add_ons ?? [])].length) {
      throw new BadRequestException({
        code: 'unknown_add_on',
        message: 'One or more selected add-ons are not available in this region. Refresh and try again.',
      });
    }
    const pickupTime = dto.pickup_time ? new Date(dto.pickup_time) : new Date();
    // Estimate/create PARITY on lead time: a quote must never succeed for a start
    // time create() would refuse, or the client is priced for a booking that
    // cannot exist.
    //
    // Guarded on an EXPLICIT pickup_time on purpose. When the caller omits it the
    // line above defaults to `now`, which is by definition inside the lead window
    // - checking that would 400 every EP quote that has not named a start yet and
    // take the live price preview down while the user is still building the
    // booking. An absent start time is not an invalid start time.
    if (isExec && dto.pickup_time && !Number.isNaN(pickupTime.getTime())) {
      await this.assertExecLeadTime(pickupTime, Date.now(), {service: dto.service, region: estRegion});
    }
    // Mirror create()'s clamps AND its reject rules so the preview can never
    // quote a team create() would price differently or refuse (E-9).
    const estDriverOnly = dto.driver_only ?? false;
    const estRequestedCpos = dto.cpo_count ?? 1;
    // B-864 — mirrors create(): one ceiling, no seat clamp.
    const estCpos = Math.max(1, Math.min(estRequestedCpos, MAX_CPOS));
    // executive: create() REJECTS when the ceiling would change the team
    // (reject-never-reprice) — the estimate previously clamped and quoted the
    // smaller team, i.e. a price for a booking that can never exist.
    if (isExec && estCpos !== estRequestedCpos) {
      throw new BadRequestException({
        code: 'exec_cpo_cap',
        message: `At most ${MAX_CPOS} CPOs per booking. Adjust the team and try again.`,
      });
    }
    // executive: 0 vehicles is the legitimate default (protection-only detail);
    // cap at TEAM_UNIT_MAX exactly like create() so preview == charge. Lite mirrors
    // create()'s min-1 (driver-only zeroes vehicles in PricingService itself).
    const estVehicles = isExec
      ? Math.max(0, Math.min(dto.vehicle_count ?? 0, TEAM_UNIT_MAX))
      : (estDriverOnly ? 0 : Math.max(1, dto.vehicle_count ?? 1));
    // E-14 parity — don't quote a passenger/vehicle combination create() rejects.
    if (!isExec && !estDriverOnly && estVehicles * 3 < (dto.passengers ?? 1)) {
      throw new BadRequestException({
        code: 'vehicle_capacity_insufficient',
        message: 'Not enough vehicles for the passenger count. Add vehicles and try again.',
      });
    }
    // E2E-47 parity — the two exec transfer-leg rules create() enforces. Applied
    // ONLY when the caller declares its transport state (see EstimateBookingDto):
    // `undefined` is a legacy caller that cannot say, and quoting it is today's
    // behaviour; `null` says "no leg"; an object says "a leg". Errors are the
    // same codes/messages create() throws, so the client renders one thing.
    if (isExec && dto.exec_transport === null && (estVehicles > 0 || estDriverOnly)) {
      throw new BadRequestException({
        code: 'exec_transport_required',
        message: 'Vehicles and driver-only options require a secure-transfer leg on an Executive Protection booking.',
      });
    }
    if (isExec && dto.exec_transport != null && estVehicles === 0 && !estDriverOnly) {
      throw new BadRequestException({
        code: 'exec_vehicle_required',
        message: 'A secure-transfer leg needs at least one vehicle, or the driver-only option.',
      });
    }
    // Estimate/create PARITY on duration: a quote must never succeed for a
    // length create() would refuse, and the default must be the SAME rule.
    const durationRule = resolveDurationRule(dto.service, pricingCfg);
    const estDuration = this.resolveDurationOrThrow(dto.service, dto.duration_hours, pricingCfg);
    const grossPrice = this.pricing.calculate({
      // Lite previously passed the RAW count while create() clamps — a
      // driver-only quote could exceed the eventual charge (E-9c).
      cpoCount: estCpos,
      vehicleCount: estVehicles,
      driverOnly: estDriverOnly,
      durationHours: estDuration,
      pickupTime,
      addOns,
      regionCode: (dto.region ?? '').trim().toUpperCase(),   // LM-M2
      service: dto.service,
    }, pricingCfg);
    // Referral / discount campaign (2026-09-05) — the SAME decision create()
    // makes, on the same gross and the same dispatch zone, so the preview and
    // the charge agree. The quote never throws: a code that does not apply
    // comes back with its reason so the client can say why. A code that is
    // not a campaign is checked against the partner table for the same
    // honesty — "attribution only" vs "not recognised".
    let referral: EstimateReferral | undefined;
    if (dto.referral_code && dto.referral_code.trim()) {
      const q = await this.campaigns?.quote({
        code: dto.referral_code, userId: userId ?? null, regionCode: estZone,
        service: dto.service ?? 'secure_transfer',
        grossEur: grossPrice.total_eur, eurPerBc: pricingCfg.eur_per_bc,
      });
      if (q) {
        referral = {
          code: q.campaign.code, kind: 'campaign', applied: q.applied, label: q.label,
          discount_eur: q.discountEur, discount_bc: q.discountBc, reason: q.reason,
          message: q.reason ? ReferralCampaignsService.refusalMessage(q.reason, q.campaign) : null,
        };
      } else {
        const partner = await this.resolveReferralCode(dto.referral_code).catch(() => null);
        referral = partner
          ? {code: partner.code, kind: 'attribution', applied: false, label: null,
             discount_eur: 0, discount_bc: 0, reason: null, message: null}
          : {code: dto.referral_code.trim().toUpperCase(), kind: 'unknown', applied: false, label: null,
             discount_eur: 0, discount_bc: 0, reason: 'referral_code_invalid',
             message: 'That provider or referral code is not recognised. Check it, or leave it blank.'};
      }
    }
    const price = referral?.applied
      ? applyDiscount(grossPrice, referral.discount_eur, pricingCfg)
      : grossPrice;
    const breakdown: Record<string, number> = {};
    for (const b of price.breakdown) breakdown[b.label] = b.amount_eur;
    // LM-M1 — the wizard needs the authoritative TOTAL (and rate) up front so the
    // paywall/affordability numbers match what escrow will actually charge.
    //
    // E2E-29 (2026-09-03) — `total` is EUR and always has been, but every client
    // consumer treats it as Bravo Credits: it is stored as `estimated_price`,
    // rendered "BC", and compared against `wallet_balances.bravo_credits`, while
    // the escrow hold charges `round(total_eur / eur_per_bc)`
    // (`pricing.service.ts` PricingResult.total_bc). At the shipped
    // `eur_per_bc = 1.0` the two coincide, so nothing is wrong today and nothing
    // changes numerically here — it goes wrong silently the moment ops or a
    // per-region override moves the peg (the board accepts 0.01–100).
    //
    // `total_bc` is ADDITIVE and is the number to show/compare against a wallet:
    // it is computed by the SAME `PricingService.calculate` that the charge path
    // uses, so preview == charge by construction rather than by coincidence.
    // `total` is left EXACTLY as it was for back-compat with shipped clients.
    return {
      total: price.total_eur,
      total_bc: price.total_bc,
      breakdown,
      rate_per_hour: price.rate_eur_per_hour,
      duration_hours: estDuration,
      // The rule the picker must render (min / max / default / fixed grid), so
      // the app never compiles its own copy of an ops-editable number.
      duration_rule: {
        default: durationRule.default, min: durationRule.min, max: durationRule.max,
        ...(durationRule.fixedGrid ? {grid: [...durationRule.fixedGrid]} : {}),
      },
      total_aed: price.total_aed,
      // Referral campaign (2026-09-05) — what the code did to this quote, and
      // the pre-discount figure so the client can show "was X".
      gross_bc: grossPrice.total_bc,
      ...(referral ? {referral} : {}),
    };
  }

  /**
   * 2026-09-04 — the ONE duration decision, shared by create() and estimate().
   * Validates the client's `duration_hours` against `resolveDurationRule` and
   * returns the hours to price and store; an absent value is the rule's default.
   *
   * B-877 (2026-09-14) — a Secure Transfer is the exception: it is billed as the
   * region's fixed BLOCK and the client has no duration control for it.
   */
  private resolveDurationOrThrow(
    service: string | null | undefined,
    requested: number | null | undefined,
    cfg: ServicePricingConfig,
  ): number {
    // Why: B-877 — for a transfer the requested hours are IGNORED, never refused.
    // Every app shipped before 1.0.316 unconditionally sends its stepper's value
    // (default 4, up to 24), so throwing `invalid_duration` at a block of 4 would
    // 400 the entire transfer flow on every installed build the moment ops moved
    // the block off 4. Preview == charge still holds because estimate() resolves
    // through this same function: the total the client consented to was already
    // priced on the block, not on the hours their stepper displayed.
    if (isTransferBlockService(service)) {return resolveTransferBlockHours(cfg);}
    const rule = resolveDurationRule(service, cfg);
    const r = resolveDurationHours(requested, rule);
    if (r.ok) {return r.hours;}
    if (rule.fixedGrid) {
      throw new BadRequestException({
        code: 'exec_invalid_duration',
        message: 'Executive Protection is booked in fixed 3-hour blocks between 3 and 24 hours.',
      });
    }
    throw new BadRequestException({
      code: 'invalid_duration',
      message: `Duration must be a whole number of hours between ${rule.min} and ${rule.max}.`,
      min_hours: rule.min,
      max_hours: rule.max,
      default_hours: rule.default,
    });
  }

  /** Env BOOKING_MAX_OPEN_PER_CLIENT (integer ≥ 1); default 5. */
  private maxOpenBookingsPerClient(): number {
    const raw = this.config.get<number | string>('booking.maxOpenPerClient');
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isInteger(n) && n >= 1 ? n : 5;
  }

  async list(clientId: string, opts?: {status?: string; page?: number}): Promise<ClientSummary> {
    // C-6 — the mobile client has always advertised {status, page}; the server
    // ignored both (hardcoded first-50). Honor them, additively: no params =
    // byte-identical behavior. Status is allow-listed (never interpolate input).
    // These are exactly the labels of the lite_booking_status enum. Pinned by
    // enumParamCast.spec.ts: 'LIVE' was missing (so ?status=LIVE silently
    // dropped the filter and returned EVERY booking instead of the live one),
    // and 'REJECTED' is not a lite_booking_status at all — it belongs to
    // dispatch_offers/agents, and could never match a row.
    const VALID_STATUS = new Set([
      'DRAFT', 'DISPATCHING', 'PENDING_OPS', 'OPS_APPROVED', 'PAYMENT_PENDING',
      'CONFIRMED', 'LIVE', 'COMPLETED', 'CANCELLED', 'NO_PROVIDER', 'AGENCY_NO_SHOW',
    ]);
    const status = opts?.status && VALID_STATUS.has(opts.status) ? opts.status : null;
    // B-388b — a page number needs an UPPER bound, not just a floor. The
    // controller admits any /^\d+$/ string, and `page * 50` is bound straight to
    // a bigint OFFSET, so two 500s were one query param away for any signed-in
    // client (both reproduced against the live database):
    //   ?page=1000000000000000000  -> OFFSET 50000000000000000000
    //                                 22003 value out of range for type bigint
    //   ?page=20000000000000000000 -> node-postgres binds a JS number with
    //                                 toString(), which switches to exponent
    //                                 form at 1e21, so Postgres receives the
    //                                 literal text "5e+21"
    //                                 22P02 invalid input syntax for type bigint
    // Same family as the cast bug below: an untrusted value reaching Postgres's
    // type layer, invisible to this suite because DatabaseService is mocked.
    // 10k pages is 500k rows deep — unreachable for a real client, and no client
    // sends `page` at all today.
    const page = Math.min(10_000, Math.max(0, Math.floor(opts?.page ?? 0)));
    const rows = await this.db.q<LiteBookingRow>(
      // `status` is the ENUM lite_booking_status, and `$2::text` PINS this
      // parameter's type to text for the whole statement — so the bare
      // `status = $2` below it became `lite_booking_status = text`, an operator
      // Postgres does not have. Every call threw, so the client's bookings list
      // 500'd for everyone, with or without a status filter (the cast is
      // evaluated regardless of which side of the OR wins).
      //
      // Cast the COLUMN, not the parameter: `$2::lite_booking_status` would
      // instead raise "invalid input value for enum" on any unexpected string,
      // turning a filter typo into a 500 as well. `status::text` compares like
      // with like and matches the idiom already used at
      // dispatch.service.ts:588 (`b.status::text = $1`).
      `SELECT * FROM lite_bookings
        WHERE client_id = $1 AND ($2::text IS NULL OR status::text = $2)
        ORDER BY created_at DESC LIMIT 50 OFFSET $3`,
      [clientId, status, page * 50],
    );
    const bookings = rows.map(r => this.toClientBooking(r));
    // LB-ST1 — surface the live mission phase on the LIST too, not only getById.
    // The booking FSM stays CONFIRMED for the whole mission, so without this the
    // client dashboard shows a frozen "CONFIRMED" the entire detail and the Home
    // resume/deep-link router can't send the user to the live tracker. One batched
    // query (newest non-ABORTED mission per booking) keeps it O(1), no N+1.
    if (bookings.length > 0) {
      const ids = bookings.map(b => b.id);
      const missions = await this.db.q<MissionProjectionRow>(
        `SELECT DISTINCT ON (m.booking_id) m.booking_id, m.status,
                m.dispatched_at, m.pickup_at, m.live_at, m.updated_at,
                EXISTS (SELECT 1 FROM mission_crew mc
                         WHERE mc.mission_id = m.id AND mc.accepted_at IS NOT NULL) AS crew_accepted
           FROM missions m
          WHERE m.booking_id = ANY($1)
          ORDER BY m.booking_id, (m.status <> 'ABORTED') DESC, m.created_at DESC`,
        [ids],
      );
      const byBooking = new Map(missions.map(m => [m.booking_id, m]));
      for (const b of bookings) {this.applyMissionProjection(b, byBooking.get(b.id) ?? null);}
    } else {
      for (const b of bookings) {this.applyMissionProjection(b, null);}
    }
    return {
      bookings,
      total: rows.length,
    };
  }

  /**
   * 2026-09-04 — stamp the mission-derived fields onto a client booking: the raw
   * mission status, the customer stage, the three lifecycle timestamps, the
   * service window and the freshness token. ONE place, used by list and getById,
   * so the two reads can never disagree about what the customer is told.
   */
  private applyMissionProjection(b: ClientBooking, m: MissionProjectionRow | null): void {
    const iso = (d: Date | string | null | undefined): string | null =>
      d ? (d instanceof Date ? d.toISOString() : new Date(d).toISOString()) : null;
    b.mission_status = clientMissionStatus(m);
    b.stage = customerStageFor(b.status, b.mission_status, b.booking_mode ?? null);
    b.dispatched_at = iso(m?.dispatched_at);
    b.pickup_at = iso(m?.pickup_at);
    b.client_received_at = iso(m?.live_at);
    b.service_window_end_at = m?.live_at
      ? new Date(new Date(m.live_at).getTime() + Math.max(1, b.duration_hours) * 3_600_000).toISOString()
      : null;
    const bookingTs = b.updated_at ? new Date(b.updated_at).getTime() : 0;
    const missionTs = m?.updated_at ? new Date(m.updated_at).getTime() : 0;
    const newest = Math.max(bookingTs, missionTs);
    if (newest > 0) {b.updated_at = new Date(newest).toISOString();}
  }

  async getById(clientId: string, id: string): Promise<ClientBooking> {
    const row = await this.db.qOne<LiteBookingRow>(
      `SELECT * FROM lite_bookings WHERE id = $1 AND client_id = $2`,
      [id, clientId],
    );
    if (!row) throw new NotFoundException('Booking not found');
    const booking = this.toClientBooking(row);
    // Surface the mission lifecycle so the client's live-tracking reflects DISPATCHED →
    // en route → protection active → completed. The booking FSM intentionally stays
    // CONFIRMED while the mission advances; the newest mission wins (a re-dispatch creates
    // a fresh one and supersedes any ABORTED predecessor).
    const mission = await this.db.qOne<MissionProjectionRow>(
      `SELECT m.booking_id, m.status,
              m.dispatched_at, m.pickup_at, m.live_at, m.updated_at,
              EXISTS (SELECT 1 FROM mission_crew mc
                       WHERE mc.mission_id = m.id AND mc.accepted_at IS NOT NULL) AS crew_accepted
         FROM missions m WHERE m.booking_id = $1
        ORDER BY (m.status <> 'ABORTED') DESC, m.created_at DESC LIMIT 1`,
      [id],
    );
    this.applyMissionProjection(booking, mission ?? null);
    // Executive Protection — the client's hour-by-hour timeline ("Hour N confirmed —
    // all smooth"). executive missions have no waypoints; this is their progress.
    // Scoped to the SAME mission the surfaced mission_status came from — a
    // re-crewed booking keeps an ABORTED history mission whose hours must
    // not mix into (or duplicate) the live mission's timeline.
    if (row.service === 'executive_protection') {
      const checkins = await this.db.q<{hour_index: number; status: string; comment: string | null; created_at: Date}>(
        `SELECT hour_index, status, comment, created_at
           FROM mission_hourly_checkins
          WHERE mission_id = (
            SELECT m.id FROM missions m WHERE m.booking_id = $1
             ORDER BY (m.status <> 'ABORTED') DESC, m.created_at DESC LIMIT 1
          )
          ORDER BY hour_index`,
        [id],
      );
      booking.hourly_checkins = checkins.map(c => ({
        hour_index: c.hour_index, status: c.status, comment: c.comment,
        created_at: c.created_at?.toISOString?.() ?? String(c.created_at),
      }));
    }
    return booking;
  }

  /**
   * Step 24 — client rates the agency that ran a COMPLETED booking, then recompute the
   * agency's rolling average (which the Step-6 dispatch ranking consumes). Owner-scoped,
   * COMPLETED-only, and idempotent: the `AND rating IS NULL` guard makes a re-submit a
   * no-op (one rating per booking), so it's safe under the IdempotencyInterceptor + retries.
   */
  /**
   * Issue 28 — validate a preferred-provider / partner / referral code.
   *
   * Returns null for a blank code (the field is optional) and THROWS for a code
   * that is unknown, inactive or expired, so a typo is reported at submit time
   * rather than silently attributed to nobody.
   *
   * Deliberately returns attribution only. The caller must not pass any part of
   * this into dispatch: the PDF requires that a code never bypass availability,
   * licensing or operator approval.
   */
  private async resolveReferralCode(
    raw: string | undefined,
  ): Promise<{id: string; code: string} | null> {
    const code = (raw ?? '').trim().toUpperCase();
    if (!code) return null;
    const row = await this.db.qOne<{id: string; code: string}>(
      `SELECT id, code FROM provider_referral_codes
        WHERE code = $1 AND active = TRUE
          AND (expires_at IS NULL OR expires_at > NOW())`,
      [code],
    );
    if (!row) {
      throw new BadRequestException({
        code: 'referral_code_invalid',
        message: 'That provider or referral code is not recognised. Check it, or leave it blank.',
      });
    }
    return row;
  }

  async submitRating(
    clientId: string, bookingId: string,
    dto: {stars: number; tags?: string[]; tip?: number; remarks?: string},
  ): Promise<{id: string; rating: number; agency_rating: number | null}> {
    // Phase 1 — write the rating atomically (idempotent: AND rating IS NULL ⇒ one per booking).
    const written = await this.db.withTransaction(async tx => {
      const won = await tx.q<{assigned_provider_user_id: string | null}>(
        // Issue 31 — persist tags + remarks alongside the star count. `tags`
        // was accepted by the DTO but never written, so the preset feedback
        // the client picked was silently discarded.
        `UPDATE lite_bookings SET rating = $2, rating_tags = $4, rating_remarks = $5
          WHERE id = $1 AND client_id = $3 AND status = 'COMPLETED' AND rating IS NULL
          RETURNING assigned_provider_user_id`,
        [bookingId, dto.stars, clientId, dto.tags ?? null, dto.remarks?.trim() || null],
      );
      if (won.length > 0) {
        return {kind: 'written' as const, providerId: won[0].assigned_provider_user_id, rating: dto.stars};
      }
      // Disambiguate the no-row: not owner / missing, not completed, or already rated.
      const cur = await tx.qOne<{status: string; rating: number | null; client_id: string}>(
        `SELECT status, rating, client_id FROM lite_bookings WHERE id = $1`,
        [bookingId],
      );
      if (!cur || cur.client_id !== clientId) throw new NotFoundException('Booking not found');
      if (cur.status !== 'COMPLETED') throw new BadRequestException('booking_not_completed');
      // Already rated → idempotent: a rating is one-shot, so echo the STORED value (a retry
      // with a different star count does NOT overwrite it; contact ops to amend).
      return {kind: 'idempotent' as const, rating: cur.rating ?? 0};
    });

    if (written.kind === 'idempotent') {
      return {id: bookingId, rating: written.rating, agency_rating: null};
    }
    // Phase 2 — recompute the agency average AFTER the rating commit, in its own statement,
    // so it reads the committed set (incl. any concurrent rating of the same agency) rather
    // than this txn's pre-commit snapshot. A failed recompute leaves the rating saved and
    // the average is corrected by the next rating; it never double-counts or rolls back data.
    let agencyRating: number | null = null;
    if (written.providerId) {
      const r = await this.db.qOne<{rating: string | null}>(
        `UPDATE agents SET rating = (
           SELECT ROUND(AVG(rating)::numeric, 2)
             FROM lite_bookings
            WHERE assigned_provider_user_id = $1 AND rating IS NOT NULL)
         WHERE user_id = $1 RETURNING rating`,
        [written.providerId],
      );
      const rv = r?.rating;
      agencyRating = rv !== null && rv !== undefined ? Number(rv) : null;
    }
    return {id: bookingId, rating: written.rating, agency_rating: agencyRating};
  }

  async cancel(clientId: string, id: string): Promise<{id: string; status: BookingStatus; refunded_credits: number; already_ended?: boolean}> {
    // LM-B4 — every cancel decision (FSM, window, protection-active) is made UNDER the
    // booking row lock and the flip is status-guarded, so a concurrent lead go-live
    // can't interleave between an unlocked read and an unconditional UPDATE (the old
    // TOCTOU that let a client cancel a mission that had just gone LIVE).
    let refundedCredits = 0;
    const escrow = await this.db.withTransaction(async tx => {
      const row = await tx.qOne<{
        status: BookingStatus; payment_captured: boolean; created_at: Date;
        dispatch_mode: string | null; dispatch_settled_at: Date | null;
        payer_user_id: string | null; assigned_provider_user_id: string | null;
        confirmed_at: Date | null;
        // E2E-12 — the contracted start + what kind of booking it is, so the
        // late-cancel window can be anchored to the SERVICE TIME, not to when
        // an agency happened to accept.
        pickup_time: Date | null; service: string | null; booking_mode: string | null;
      }>(
        `SELECT status, payment_captured, created_at, dispatch_mode, dispatch_settled_at,
                payer_user_id, assigned_provider_user_id, confirmed_at,
                pickup_time, service, booking_mode
           FROM lite_bookings WHERE id = $1 AND client_id = $2 FOR UPDATE`,
        [id, clientId],
      );
      if (!row) throw new NotFoundException('Booking not found');
      // NO-PROVIDER CANCEL (Job-Portal QA 2026-07-10) — the client taps "cancel search"
      // just as (or after) the search dies NO_PROVIDER, or re-taps after an earlier
      // cancel, or the agency-no-show sweep already closed it. Their intent — stop the
      // booking — is already satisfied, so answer with an idempotent success instead of
      // the FSM's 403 (which surfaced as a raw error popup on the searching screen).
      // No money moves here: each of these terminal paths already refunded on its own
      // (crew-SLA for AGENCY_NO_SHOW, noProvider's R12 refund, the first cancel).
      if (row.status === 'CANCELLED' || row.status === 'NO_PROVIDER' || row.status === 'AGENCY_NO_SHOW') {
        return {kind: 'already_ended' as const, status: row.status};
      }
      this.fsm.assert(row.status, 'CANCELLED', 'CLIENT');

      // Client cancellation WINDOW (LM-B8) — nothing is committed before an agency
      // accepts (or ops approval/payment on the legacy path), so pre-commitment
      // statuses are always cancellable — a scheduled ("later") booking no longer
      // self-locks an hour after creation. Once CONFIRMED, the window is anchored to
      // the ACCEPT time for auto bookings (dispatch_settled_at) and to the actual
      // payment/confirmation time for legacy ones (B-386 — anchoring to created_at
      // locked scheduled clients out days before service while the error text said
      // "of confirmation"; confirmed_at is stamped at the CONFIRMED flip, old rows
      // fall back to created_at = the previous behavior).
      //
      // E2E-12 (2026-09-03) — SCHEDULED BOOKINGS ARE EXEMPT FROM THIS GATE.
      //
      // It anchors to the ACCEPT time, which for a scheduled booking has nothing
      // to do with the client's commitment: the search now starts at the service's
      // lead window (T-24 h for Executive Protection), so an agency accepts ~24 h
      // out and from T-23 h the client is told `cancel_window_expired` — locked out
      // of their own booking for a full day before it starts, with the only escape
      // being support. It also made the late-cancel FEE below unreachable on exactly
      // the path it was written for: the refusal fires first, every time.
      //
      // A scheduled booking's cancellability is governed instead by the
      // `pickup_time`-anchored rule further down: free until T-`lateCancelHours`,
      // `cancel_fee_pct` inside it. That is the honest commitment boundary — it
      // tracks the service the client bought, not when a provider happened to
      // answer. The two are mutually exclusive, never stacked.
      //
      // ON-DEMAND IS UNTOUCHED: a `now` Secure Transfer keeps the accept-anchored
      // window byte-for-byte. LIVE/SOS remains blocked for both by the mission
      // check below, so "always cancellable" never means "cancellable mid-mission".
      const isScheduledBooking =
        row.service === 'executive_protection' || row.booking_mode === 'later';
      const preCommitment: readonly BookingStatus[] =
        ['DRAFT', 'DISPATCHING', 'PENDING_OPS', 'OPS_APPROVED', 'PAYMENT_PENDING'];
      if (!preCommitment.includes(row.status) && !isScheduledBooking) {
        const windowHours = this.config.get<number>('booking.cancelWindowHours') ?? 1;
        const anchor = row.dispatch_mode === 'auto'
          ? (row.dispatch_settled_at ?? row.created_at)
          : (row.confirmed_at ?? row.created_at);
        const ageMs = Date.now() - new Date(anchor).getTime();
        if (ageMs > windowHours * 3_600_000) {
          throw new BadRequestException({
            code: 'cancel_window_expired',
            message: `Cancellation is only allowed within ${windowHours} hour(s) of confirmation. Contact support to cancel.`,
            window_hours: windowHours,
          });
        }
      }

      // MISSION-CANCEL (#14) — no client cancel once protection is ACTIVE. Checked
      // under the mission row lock (booking→mission order, matching the sweeps) so a
      // concurrent go-live serializes behind us or wins visibly. LM-B1: ABORTED
      // history rows are skipped.
      const liveMission = await tx.qOne<{id: string; status: string}>(
        `SELECT id, status FROM missions
          WHERE booking_id = $1 AND status <> 'ABORTED'
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [id],
      );
      if (liveMission && (liveMission.status === 'LIVE' || liveMission.status === 'SOS')) {
        throw new BadRequestException({
          code: 'cancel_blocked_protection_active',
          message: 'Protection is already active. Contact support to end the mission.',
        });
      }

      // Status-guarded flip — 0 rows means the state moved after our lock read
      // (defensive; under FOR UPDATE this can't happen, but never cancel blind).
      const flipped = await tx.q(
        `UPDATE lite_bookings
            SET status = 'CANCELLED',
                dispatch_settled_at = CASE WHEN dispatch_mode = 'auto'
                                           THEN COALESCE(dispatch_settled_at, NOW())
                                           ELSE dispatch_settled_at END
          WHERE id = $1 AND status = $2 RETURNING id`,
        [id, row.status],
      );
      if (flipped.length === 0) {
        throw new BadRequestException('booking_state_changed_concurrently');
      }

      // LM-B2 — retire any live offer for this booking. Without this, a cancel while
      // DISPATCHING left the offer OFFERED, and dispatch_offers_one_live_per_provider
      // benched that agency from ALL other bookings until the expiry sweep reaped it.
      const benched = await tx.q<{provider_user_id: string}>(
        `UPDATE dispatch_offers SET status = 'SUPERSEDED', responded_at = NOW()
          WHERE booking_id = $1 AND status = 'OFFERED' RETURNING provider_user_id`,
        [id],
      );

      // Step 11 — escrow-aware cancel. An AUTO-dispatch booking carries a HELD escrow
      // hold; cancelling it must REVERSE that hold (not the legacy payment refund, which
      // would strand the escrow account credited and the hold orphaned — the documented
      // cut-over blocker). Reverse atomically with the CANCELLED flip:
      //   • pre-grace (no crew committed / no mission) → FULL refund (basis='refund').
      //   • post-grace (agency already committed crew → a mission exists) → PARTIAL: a
      //     cancellation fee to the agency, remainder refunded (basis='partial').
      // A LEGACY booking (no hold) keeps the existing idempotent payment refund.
      // MISSION-CANCEL (#14) — abort the mission ATOMICALLY with the booking flip
      // so a reader never sees a CANCELLED booking with a still-active mission.
      // LIVE/SOS are blocked above, so only DISPATCHED/PICKUP reach here. Keep the
      // mission_crew rows (status='off' frees capacity via mission_crew_agent_active_uq)
      // so the ABORTED mission still shows in CPO history. The escrow/refund math
      // below is untouched — these statements add nothing to the money path.
      // B-378 — capture the crew BEFORE the abort so the post-commit block can wake
      // them (a CPO already en route otherwise keeps navigating to a dead mission)
      // and the accepted agency (its board only updated on poll).
      // 2026-09-04 — CREWED (crew assigned, not yet dispatched) is a live mission
      // too: leaving it out orphans the row and holds the crew "busy" forever.
      const abortCrew = await tx.q<{mission_id: string; agent_id: string}>(
        `SELECT mc.mission_id, mc.agent_id
           FROM mission_crew mc
           JOIN missions m ON m.id = mc.mission_id
          WHERE m.booking_id = $1 AND m.status IN ('CREWED','DISPATCHED','PICKUP') AND mc.status <> 'off'`,
        [id],
      );
      for (const from of ['CREWED', 'DISPATCHED', 'PICKUP'] as const) {
        missionFsm.assert(from as MissionStatus, 'ABORTED', 'SYSTEM');
      }
      await tx.q(
        `UPDATE missions SET status = 'ABORTED', ended_at = NOW(), ended_by = $2, end_reason = 'client_cancel'
          WHERE booking_id = $1 AND status IN ('CREWED','DISPATCHED','PICKUP')`,
        [id, clientId],
      );
      await tx.q(
        `UPDATE mission_crew SET status = 'off'
          WHERE mission_id IN (SELECT id FROM missions WHERE booking_id = $1)`,
        [id],
      );
      // MISSION-GROUP (area 5) — DELETE the Ops Room on cancel too, so the
      // cancelled mission's room disappears for the client AND the SP/agency.
      // Capture the conversation id BEFORE nulling the back-reference, then SET
      // NULL the back-references (lite_bookings, missions) and delete the child
      // rows that FK conversations.id, then the conversation itself. Idempotent: a
      // missing/already-deleted conversation is a no-op. Server-side metadata only
      // — no group keys touched.
      const convRow = await tx.qOne<{conversation_id: string | null}>(
        `SELECT conversation_id FROM lite_bookings WHERE id = $1`,
        [id],
      );
      if (convRow?.conversation_id) {
        const c = [convRow.conversation_id];
        await tx.q(`UPDATE public.lite_bookings SET conversation_id = NULL WHERE conversation_id = $1`, c);
        await tx.q(`UPDATE public.missions SET comms_channel_id = NULL WHERE comms_channel_id = $1`, c);
        await tx.q(`DELETE FROM public.dispatch_room_intents WHERE conversation_id = $1`, c);
        await tx.q(`DELETE FROM public.conversation_members WHERE conversation_id = $1`, c);
        await tx.q(`DELETE FROM public.system_broadcasts WHERE conversation_id = $1`, c);
        await tx.q(`DELETE FROM public.conversations WHERE id = $1`, c);
      }
      const hold = await tx.qOne<{gross_credits: number}>(
        `SELECT gross_credits FROM escrow_holds WHERE booking_id = $1 AND status = 'HELD' FOR UPDATE`,
        [id],
      );
      const shared = {
        benched: benched.map(b => b.provider_user_id),
        fromStatus: row.status,
        paymentCaptured: row.payment_captured,
        // Family bookings debited the HOLDER's wallet — the legacy refund below
        // must credit that same wallet, not the cancelling member (whose wallet
        // holds no debit for this booking, so the refund would silently no-op).
        payerId: row.payer_user_id ?? clientId,
        // B-378 — who must hear about the abort, post-commit.
        abortCrew,
        providerId: row.assigned_provider_user_id,
      };
      if (!hold) return {kind: 'legacy' as const, credits: 0, ...shared};
      // "Crew committed" = a LIVE (non-ABORTED) mission by the CURRENT agency — an
      // ABORTED history row from a prior no-show round must not charge the client
      // a cancel fee for crew that never showed up (LM-B1).
      const committed = await tx.qOne<{id: string}>(
        `SELECT id FROM missions WHERE booking_id = $1 AND status <> 'ABORTED'`,
        [id],
      );
      // OP-10 — the cancel fee lives on the ops pricing board (env base).
      const cancelRegion = await tx.qOne<{region_code: string | null}>(`SELECT region_code FROM lite_bookings WHERE id = $1`, [id]);
      const cancelFeePct = (await this.pricing.config(cancelRegion?.region_code ?? null)).cancel_fee_pct;
      // E2E-12 (2026-09-03) — LATE CANCEL on a SCHEDULED booking.
      //
      // The fee used to trigger on ONE fact: "an agency committed crew" (a
      // non-ABORTED mission exists). For Executive Protection that is
      // structurally unreachable in time: EP is always scheduled, dispatch does
      // not start until the lead window, escrow is held at agency accept, and
      // crew is assigned minutes later — so the client could cancel a 24-hour
      // detail at T-20 min, after the agency had rostered officers, and pay
      // nothing. The window the fee was anchored to (`dispatch_settled_at + 1 h`)
      // sits entirely INSIDE the block.
      //
      // Anchor to the CONTRACTED START instead: inside `lateCancelHours` of
      // `pickup_time`, a scheduled booking that already carries a HELD escrow
      // pays the same `cancel_fee_pct` split, crewed or not. The agency has
      // committed capacity by then; that is what the fee is for.
      //
      // SCOPE — SECURE TRANSFER ON-DEMAND IS UNTOUCHED. `isScheduled` is true only
      // for EP (always scheduled) and for any `booking_mode='later'` reservation.
      // A `now` booking keeps the crew-committed rule byte-for-byte.
      //
      // MONEY — no new path, and no new charge. This only widens WHICH cancels
      // reach the EXISTING `settleEscrowSplit` (same `basis:'partial'`, same
      // `fromStatuses:['HELD']`, same PARTIAL final status, same fee formula).
      // Boundary cases:
      //   • no HELD hold (PENDING_OPS / OPS_APPROVED — i.e. the whole pre-lead
      //     life of an EP booking) → unreachable: this block is after
      //     `if (!hold) return legacy`. Nothing has been charged, so there is
      //     nothing to split, and taking a fee would need a pre-authorised hold
      //     at submit — a product + architecture decision, NOT a code change.
      //   • `pickup_time` in the past → `remaining <= 0` ⇒ inside the window.
      //   • `cancel_fee_pct = 0` → no fee, exactly as before.
      //   • crew already committed → fee applies as it always did, whichever
      //     branch is true (the two conditions are OR'd, never additive).
      //   • LIVE / SOS → this code is unreachable (cancel is refused earlier).
      // ONE definition of "scheduled", shared with the window exemption above —
      // the exemption and the fee are two halves of the same rule, and letting
      // them drift would either lock a client out or let one cancel free.
      const lateCancelHours = this.config.get<number>('booking.lateCancelHours') ?? 0;
      const startMs = row.pickup_time ? new Date(row.pickup_time).getTime() : NaN;
      const lateScheduledCancel =
        isScheduledBooking && lateCancelHours > 0 && Number.isFinite(startMs)
        && Date.now() >= startMs - lateCancelHours * 3_600_000;
      if ((committed || lateScheduledCancel) && cancelFeePct > 0) {
        const fee = Math.min(hold.gross_credits, Math.max(0, Math.round((hold.gross_credits * cancelFeePct) / 100)));
        const r = await this.wallet.settleEscrowSplit(tx, id, {
          toProvider: fee,
          toClient: hold.gross_credits - fee,
          basis: 'partial',
          fromStatuses: ['HELD'],
          finalStatus: 'PARTIAL',
          reason: `Cancellation fee · booking ${id}`,
        });
        return {kind: 'escrow' as const, credits: r.toClient, ...shared};
      }
      const r = await this.wallet.refundEscrowHold(tx, id, `Refund · booking ${id} cancelled`);
      return {kind: 'escrow' as const, credits: r.credits, ...shared};
    });

    if (escrow.kind === 'already_ended') {
      // Idempotent no-op — nothing flipped, nothing to refund/audit/release.
      return {id, status: escrow.status, refunded_credits: 0, already_ended: true};
    }
    if (escrow.kind === 'legacy') {
      // Audit C2 — legacy captured-credit refund (idempotent per user+booking).
      if (escrow.paymentCaptured) {
        try {
          const r = await this.wallet.refundForBooking(escrow.payerId, id, `Refund · booking ${id} cancelled`);
          refundedCredits = r.credits;
        } catch (e) {
          this.log.error(`refund failed on cancel for booking ${id}: ${(e as Error).message}`);
        }
      }
    } else {
      refundedCredits = escrow.credits;
    }
    // LM-B2 — nudge any agency whose live offer we just superseded so its app
    // re-polls and drops the phantom offer card (same wake dispatch.cancel used).
    for (const providerUserId of escrow.benched) {
      void this.bookingPush?.dispatchOffer(providerUserId, id).catch(() => undefined);
    }
    // B-378 — a crewed cancel used to abort the mission silently: wake every crew
    // member (mission-aborted — same kind ops-abort uses, client handling exists)
    // and the accepted agency (its re-crewable slot just freed).
    const wokenCrew = new Set<string>();
    for (const t of escrow.abortCrew) {
      if (wokenCrew.has(t.agent_id)) continue;
      wokenCrew.add(t.agent_id);
      void this.bookingPush?.missionAborted(t.agent_id, t.mission_id, id).catch(() => undefined);
    }
    // The accepted agency is woken whether or not it had crewed yet: cancelling
    // inside the crew-assign SLA window is precisely when it is still working the
    // job (review finding — gating this on crew left that window dark).
    if (escrow.providerId) {
      void this.bookingPush?.missionCancelledByClient(
        escrow.providerId, escrow.abortCrew[0]?.mission_id ?? null, id,
      ).catch(() => undefined);
    }
    // Return legacy-pool CPOs + vehicle (no-op for auto bookings, whose crew capacity
    // frees implicitly when the mission is terminal).
    await Promise.allSettled([
      this.cpoAssign.release(id),
      this.vehicles.release(id),
    ]);
    await this.audit(id, escrow.fromStatus, 'CANCELLED', clientId, 'CLIENT',
      {reason: 'client_cancel', refunded_credits: refundedCredits});
    return {id, status: 'CANCELLED', refunded_credits: refundedCredits};
  }

  /**
   * Step 11 §41 — client confirms the job early, releasing the escrow to the agency
   * NOW instead of waiting for the dispute-window sweep. Only valid while the hold is
   * PENDING_RELEASE and NOT flagged for review; the client must own the booking. Runs
   * the shared SettlementService release in one txn (idempotent — a re-tap no-ops).
   */
  async confirmComplete(clientId: string, id: string): Promise<{id: string; status: 'RELEASED'; to_provider_credits: number}> {
    const res = await this.db.withTransaction(async tx => {
      const hold = await tx.qOne<{status: string; review_required: boolean; client_id: string}>(
        `SELECT eh.status, eh.review_required, b.client_id
           FROM escrow_holds eh JOIN lite_bookings b ON b.id = eh.booking_id
          WHERE eh.booking_id = $1 FOR UPDATE`,
        [id],
      );
      if (!hold || hold.client_id !== clientId) throw new NotFoundException('Booking not found');
      if (hold.review_required) throw new BadRequestException('confirm_not_allowed_review');
      if (hold.status !== 'PENDING_RELEASE') throw new BadRequestException('confirm_not_allowed');
      return this.settlement.settleEscrowRelease(tx, id, {kind: 'client', userId: clientId});
    });
    // LM-N4 — wake the agency about its payout (post-commit).
    if (res.released && res.providerUserId) {
      void this.bookingPush?.payoutSettled(res.providerUserId, id, res.toProvider).catch(() => undefined);
    }
    return {id, status: 'RELEASED', to_provider_credits: res.toProvider};
  }

  /**
   * Step 11 §41 — client raises a dispute, freezing the escrow before it releases. Only
   * valid while PENDING_RELEASE (not after RELEASED). Race-safe: the conditional
   * PENDING_RELEASE→DISPUTED flip beats a concurrent release sweep (dispute wins). The
   * partial unique index `booking_disputes_one_open` blocks a 2nd open dispute.
   */
  async openDispute(clientId: string, id: string, dto: CreateDisputeDto): Promise<{id: string; status: 'DISPUTED'; dispute_id: string}> {
    const disputeId = await this.db.withTransaction(async tx => {
      const hold = await tx.qOne<{status: string; client_id: string; no_show_at: Date | null}>(
        // E2E-06 — no_show_at distinguishes a PARTIAL produced by a lead-declared
        // CLIENT NO-SHOW from one produced by a client cancellation. Both settle on
        // the same `cancel_fee_pct` basis, so `basis` alone cannot tell them apart
        // (20260903110000_settlement_retry_and_no_show.sql stamps the column for
        // exactly this reason).
        `SELECT eh.status, b.client_id, eh.no_show_at
           FROM escrow_holds eh JOIN lite_bookings b ON b.id = eh.booking_id
          WHERE eh.booking_id = $1 FOR UPDATE`,
        [id],
      );
      if (!hold || hold.client_id !== clientId) throw new NotFoundException('Booking not found');

      // E2E-06 (2026-09-03) — THE CLIENT'S DOOR AFTER A NO-SHOW.
      //
      // A lead-declared client no-show settles the escrow TERMINALLY to PARTIAL
      // (the agency keeps `cancel_fee_pct`, the client is refunded the rest).
      // Before this branch the client had no recourse at all except an ops wallet
      // adjustment: a guard could declare a no-show that never happened and the
      // client could not even file a claim. One party deciding a money outcome
      // with no appeal is not a settlement, it is a verdict.
      //
      // Bounded by the SAME dispute window the normal release path uses, so the
      // agency's money stops being contestable at the same age either way.
      const disputeWindowSec = this.config.get<number>('dispatch.disputeWindowSeconds') ?? 259_200;
      const noShowAgeMs = hold.no_show_at ? Date.now() - new Date(hold.no_show_at).getTime() : null;
      const noShowDisputable =
        hold.status === 'PARTIAL' && noShowAgeMs !== null && noShowAgeMs <= disputeWindowSec * 1000;

      if (hold.status !== 'PENDING_RELEASE' && !noShowDisputable) {
        throw new BadRequestException('dispute_not_allowed');
      }

      // ⚠️ THE NO-SHOW BRANCH MUST NOT TOUCH THE HOLD'S STATUS. A PARTIAL hold is
      // ALREADY SETTLED — the wallet rows moved when the no-show was declared.
      // Flipping it to DISPUTED would hand it to `OpsService.resolveDispute`'s
      // `hold_status === 'DISPUTED'` branch, which calls `settleEscrowSplit` with
      // `fromStatuses: ['DISPUTED']` and would pay the split A SECOND TIME. It
      // stays PARTIAL, and ops resolves it through the CLAWBACK shape (the same
      // one a RELEASED hold uses). Until that ops branch lands, a resolve on this
      // dispute refuses with `dispute_resolve_invalid_hold_state:PARTIAL` — the
      // claim is recorded and visible, and no money can move wrongly.
      //
      // Everything below is therefore shared: only the PENDING_RELEASE path
      // freezes the escrow, and its conditional flip is unchanged (dispute still
      // beats a concurrent release sweep).
      if (hold.status === 'PENDING_RELEASE') {
        const flipped = await tx.qOne<{id: string}>(
          `UPDATE escrow_holds SET status = 'DISPUTED'
            WHERE booking_id = $1 AND status = 'PENDING_RELEASE' RETURNING id`,
          [id],
        );
        if (!flipped) throw new BadRequestException('dispute_not_allowed');
      }
      try {
        const d = await tx.qOne<{id: string}>(
          `INSERT INTO booking_disputes (booking_id, raised_by, category, reason, status)
           VALUES ($1, $2, $3, $4, 'open') RETURNING id`,
          [id, clientId, dto.category, dto.reason ?? null],
        );
        return d?.id ?? '';
      } catch (e) {
        // booking_disputes_one_open partial unique → a 2nd open dispute is rejected.
        if (/duplicate key|unique/i.test((e as Error).message)) throw new BadRequestException('dispute_already_open');
        throw e;
      }
    });
    // LM-N4 — the agency's payout just froze; tell it a dispute was opened.
    const provider = await this.db.qOne<{provider_user_id: string | null}>(
      `SELECT provider_user_id FROM escrow_holds WHERE booking_id = $1`,
      [id],
    );
    if (provider?.provider_user_id) {
      void this.bookingPush?.disputeOpened(provider.provider_user_id, id).catch(() => undefined);
    }
    return {id, status: 'DISPUTED', dispute_id: disputeId};
  }

  /**
   * Step 11 §41 — hold state + final split for the receipt/UI. Readable by the client
   * who owns the booking OR the assigned agency provider. Never leaks the counterparty's
   * identity — only credit amounts + status.
   */
  async getEscrow(userId: string, id: string): Promise<{
    booking_id: string; status: string; basis: string | null; currency: string;
    gross_credits: number; to_provider_credits: number | null; to_client_credits: number | null;
    platform_fee_credits: number | null; release_eligible_at: string | null; review_required: boolean;
  }> {
    const row = await this.db.qOne<{
      booking_id: string; status: string; basis: string | null; currency: string; gross_credits: number;
      to_provider_credits: number | null; to_client_credits: number | null; platform_fee_credits: number | null;
      release_eligible_at: Date | null; review_required: boolean; client_id: string; provider_user_id: string | null;
    }>(
      `SELECT eh.booking_id, eh.status, eh.basis, eh.currency, eh.gross_credits,
              eh.to_provider_credits, eh.to_client_credits, eh.platform_fee_credits,
              eh.release_eligible_at, eh.review_required, b.client_id, eh.provider_user_id
         FROM escrow_holds eh JOIN lite_bookings b ON b.id = eh.booking_id
        WHERE eh.booking_id = $1`,
      [id],
    );
    if (!row || (row.client_id !== userId && row.provider_user_id !== userId)) {
      throw new NotFoundException('Booking not found');
    }
    return {
      booking_id: row.booking_id, status: row.status, basis: row.basis, currency: row.currency,
      gross_credits: row.gross_credits, to_provider_credits: row.to_provider_credits,
      to_client_credits: row.to_client_credits, platform_fee_credits: row.platform_fee_credits,
      release_eligible_at: row.release_eligible_at ? row.release_eligible_at.toISOString() : null,
      review_required: row.review_required,
    };
  }

  /**
   * Audit fix 3.1 — replace mobile's hardcoded `REGIONS` constant with
   * a live read from the cpo_pool. Returns one row per supported region
   * with the count of currently-available CPOs. Lite uses this to
   * disable the "Coming soon" regions and stamp accurate counts on the
   * zone map; ops uses it to surface dispatch capacity.
   *
   * city-level zone breakdowns stay client-side static for now — the
   * cpo_pool only carries country-level region_code. A future migration
   * adding a `city_code` column would let this be granular.
   */
  async listRegionsAvailability(): Promise<Array<{
    code: string; name: string; cpos_available: number; cpos_total: number;
    available: boolean;
    /** B-789b — the zone's fixed UTC offset, so the app can read schedule
     *  pickers in the ZONE's clock rather than the device's. */
    utc_offset_hours: number;
  }>> {
    // This endpoint IS the mobile app's region list, so it has to show a region
    // the moment ops adds one — otherwise the app cannot offer it and the
    // booking gate would reject it anyway.
    await this.regionsSvc?.ensureFresh();
    const rows = await this.db.q<{
      region_code: string; available: string; total: string;
    }>(
      `SELECT
         region_code,
         SUM(CASE WHEN availability = 'available' AND active = TRUE THEN 1 ELSE 0 END)::text AS available,
         COUNT(*)::text AS total
       FROM cpo_pool
      GROUP BY region_code`,
    );
    // Audit fix #15 — supported-region list comes from a single shared
    // constant so a new region only needs adding in one place; mobile's
    // ZoneMapScreen REGION_SEED still owns city-level zone geometry
    // (lat/lng/city labels), but the canonical {code → name} map lives
    // in supportedRegions() below.
    const byCode = new Map(rows.map(r => [r.region_code, r]));
    return supportedRegions().map(({code, name, launched}) => {
      const row = byCode.get(code);
      const cposAvailable = Number(row?.available ?? 0);
      const cposTotal     = Number(row?.total     ?? 0);
      return {
        code,
        name,
        cpos_available: cposAvailable,
        cpos_total:     cposTotal,
        // B-93 — bookability is the PRODUCT launch flag, not a live head-
        // count: a freshly-launched region (ZA) must be selectable before
        // its pool is staffed, and a live region must not flash "COMING
        // SOON" if its pool momentarily hits zero. Counts stay informational.
        available: launched,
        utc_offset_hours: regionUtcOffsetHours(code),
      };
    });
  }

  async listAddOns(region: string): Promise<Array<{
    id: string; label: string; description: string | null;
    price_eur_per_hour: number; requires_ops_approval: boolean;
  }>> {
    const rows = await this.db.q<AddOnRow>(
      `SELECT * FROM lite_booking_add_ons
        WHERE active = TRUE AND (region_code = $1 OR region_code = 'GLOBAL')`,
      [region],
    );
    return rows.map(r => ({
      id: r.id,
      label: r.label,
      description: r.description,
      price_eur_per_hour: Number(r.price_eur_per_hour),
      requires_ops_approval: r.requires_ops_approval,
    }));
  }

  // ──────────────────────────────────────────────────────────────────
  // helpers
  // ──────────────────────────────────────────────────────────────────

  private async resolveAddOns(region: string, ids: string[]): Promise<AddOnPricing[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.q<AddOnRow>(
      `SELECT * FROM lite_booking_add_ons
        WHERE id = ANY($1::text[])
          AND active = TRUE
          AND (region_code = $2 OR region_code = 'GLOBAL')`,
      [ids, region],
    );
    return rows.map(r => ({
      id: r.id,
      label: r.label,
      price_eur_per_hour: Number(r.price_eur_per_hour),
    }));
  }

  private async audit(
    bookingId: string,
    from: BookingStatus | null,
    to: BookingStatus,
    actorId: string,
    actorRole: ActorRole,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.db.q(
        `INSERT INTO lite_booking_audit
          (booking_id, from_status, to_status, actor_id, actor_role, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [bookingId, from, to, actorId, actorRole, JSON.stringify(metadata)],
      );
    } catch (e) {
      // Audit L1 — a dropped audit row is a compliance gap, not a UX blip,
      // so it must NOT vanish into a warn line. We keep it non-fatal (the
      // booking transition already happened; failing it on an audit hiccup
      // would be worse), but escalate to error-level with a structured,
      // greppable marker carrying the full transition so monitoring can
      // alert AND the lost row is reconstructable from logs.
      this.log.error(
        `[audit-gap] lite_booking_audit insert FAILED ` +
        `booking=${bookingId} ${from ?? '∅'}→${to} actor=${actorId}/${actorRole} ` +
        `meta=${JSON.stringify(metadata)} err=${(e as Error).message}`,
      );
    }
  }

  private toClientBooking(r: LiteBookingRow): ClientBooking {
    return {
      id: r.id,
      client_id: r.client_id,
      status: r.status,
      type: 'timeslot',
      region: r.region_code,
      region_label: r.region_label,
      service: r.service,
      pickup: {
        address: r.pickup_address,
        latitude: Number(r.pickup_lat ?? 0),
        longitude: Number(r.pickup_lng ?? 0),
      },
      dropoff: r.dropoff_address
        ? {
            address: r.dropoff_address,
            latitude: Number(r.dropoff_lat ?? 0),
            longitude: Number(r.dropoff_lng ?? 0),
          }
        : null,
      start_time: new Date(r.pickup_time).toISOString(),
      passengers: r.passengers,
      cpo_count: r.cpo_count,
      vehicle_count: r.vehicle_count,
      driver_only: r.driver_only,
      add_ons: r.add_ons,
      estimated_price: Number(r.total_eur),
      duration_hours: r.duration_hours,
      total_eur: Number(r.total_eur),
      total_aed: Number(r.total_aed),
      referral_campaign_code: r.referral_campaign_code ?? null,
      referral_discount_eur: Number(r.referral_discount_eur ?? 0),
      conversation_id: r.conversation_id,
      created_at: new Date(r.created_at).toISOString(),
      dispatch_mode: r.dispatch_mode ?? null,
      task_type: r.task_type ?? null,
      exec_transport: r.exec_transport ?? null,
      payment_method: r.payment_method ?? null,
      notes: r.notes ?? null,
      booking_mode: r.booking_mode ?? null,
      // 2026-09-04 — freshness token (raised to the mission's updated_at by
      // applyMissionProjection) + the stage for surfaces that carry no mission.
      updated_at: new Date(r.updated_at ?? r.created_at).toISOString(),
      stage: customerStageFor(r.status, null, r.booking_mode ?? null),
      ...(r.status === 'NO_PROVIDER'
        ? {
            no_provider_fallback: {
              hotline_e164: this.config.get<string>('booking.hotlineE164') ?? '',
              can_widen:    true,  // re-dispatch with a wider region/radius (ops-driven)
              can_escalate: true,
            },
          }
        : {}),
    };
  }

  // ─── Step 16 — identity handshake + NO_PROVIDER escalation ─────────────────

  /** Client reads the on-arrival verify code for their booking (owner-scoped) plus the
   *  assigned lead's name/call-sign so they can visually confirm the guard. 400 until
   *  crew is assigned — there is no guard to verify before then. The code is derived
   *  (shared deriveVerifyCode), rotating + bound to the lead's agent id, never stored;
   *  the lead reads the same value from their mission endpoint. NEVER logged. */
  async getVerifyCode(clientId: string, id: string): Promise<{
    code: string; rotates_at: string;
    arrival_code: string; arrival_rotates_at: string;
    lead: {display_name: string | null; call_sign: string | null};
  }> {
    const booking = await this.db.qOne<{id: string}>(
      `SELECT id FROM lite_bookings WHERE id = $1 AND client_id = $2`,
      [id, clientId],
    );
    if (!booking) throw new NotFoundException('Booking not found');
    const lead = await this.db.qOne<{agent_id: string; call_sign: string | null; display_name: string | null}>(
      `SELECT mc.agent_id, mc.call_sign, a.display_name
         FROM mission_crew mc
         JOIN missions m ON m.id = mc.mission_id
         LEFT JOIN agents a ON a.user_id = mc.agent_id
        WHERE m.booking_id = $1 AND mc.is_lead = TRUE AND mc.status <> 'off'
        LIMIT 1`,
      [id],
    );
    if (!lead) throw new BadRequestException('no_crew_assigned');
    const secret = this.config.get<string>('jwt.actionSecret') ?? '';
    const {code, rotates_at} = deriveVerifyCode(secret, id, lead.agent_id, Date.now());
    // FRAUD-2 / P0 — the client-bound ARRIVAL code the principal shows the guard,
    // who enters it (POST /agents/me/missions/:id/verify-arrival) to prove presence.
    // Bound to the client's id, so the guard cannot self-derive it. NEVER logged.
    const arrival = deriveVerifyCode(secret, id, clientId, Date.now());
    return {
      code, rotates_at,
      arrival_code: arrival.code, arrival_rotates_at: arrival.rotates_at,
      lead: {display_name: lead.display_name, call_sign: lead.call_sign},
    };
  }

  /** Client reports the arriving person is NOT the dispatched guard: stamp the
   *  marker (owner-scoped). The booking-scoped SOS that accompanies it is raised by
   *  the caller (ClientArrivalController, DispatchModule) — kept OUT of this service
   *  so BookingModule need not import SosModule (which imports OpsModule, which imports
   *  BookingModule → a module cycle). Throws 404 if the booking isn't the client's. */
  async markNotMyGuard(clientId: string, id: string): Promise<void> {
    const upd = await this.db.q<{id: string}>(
      `UPDATE lite_bookings SET not_my_guard_at = NOW()
        WHERE id = $1 AND client_id = $2 RETURNING id`,
      [id, clientId],
    );
    if (upd.length === 0) throw new NotFoundException('Booking not found');
  }

  /** Client escalates a stranded (NO_PROVIDER) booking to a human. Side-channel
   *  ONLY — NO status flip (NO_PROVIDER is terminal). Records the escalation for ops
   *  follow-up and hands back the hotline. Owner-scoped. */
  async escalate(clientId: string, id: string): Promise<{ok: true; hotline_e164: string}> {
    const row = await this.db.qOne<{status: BookingStatus}>(
      `SELECT status FROM lite_bookings WHERE id = $1 AND client_id = $2`,
      [id, clientId],
    );
    if (!row) throw new NotFoundException('Booking not found');
    await this.audit(id, row.status, row.status, clientId, 'CLIENT', {action: 'escalate'});
    return {ok: true, hotline_e164: this.config.get<string>('booking.hotlineE164') ?? ''};
  }

  // ─── Step 19 — client auto-dispatch provider reveal ────────────────────────

  /**
   * Client reads the COARSE provider reveal for the agency that accepted their auto
   * booking: name / call-sign / ★rating / missions completed. Owner-scoped (the client
   * must own the booking). Deliberately reads ONLY from `agents` — never a pickup/dropoff
   * coord or address (LB1: precise location stays agency-only post-accept). 404 with
   * `no_provider_yet` while still DISPATCHING (no agency assigned).
   */
  async getProvider(clientId: string, id: string): Promise<{
    display_name: string | null;
    call_sign: string | null;
    rating: number | null;
    jobs_total: number;
  }> {
    const booking = await this.db.qOne<{assigned_provider_user_id: string | null}>(
      `SELECT assigned_provider_user_id FROM lite_bookings WHERE id = $1 AND client_id = $2`,
      [id, clientId],
    );
    if (!booking) throw new NotFoundException('Booking not found');
    if (!booking.assigned_provider_user_id) throw new NotFoundException('no_provider_yet');
    const provider = await this.db.qOne<{
      display_name: string | null; call_sign: string | null; rating: string | null; jobs_total: number;
    }>(
      `SELECT display_name, call_sign, rating, jobs_total FROM agents WHERE user_id = $1`,
      [booking.assigned_provider_user_id],
    );
    if (!provider) throw new NotFoundException('Provider not found');
    return {
      display_name: provider.display_name,
      call_sign: provider.call_sign,
      rating: provider.rating !== null ? Number(provider.rating) : null,
      jobs_total: provider.jobs_total,
    };
  }
}
