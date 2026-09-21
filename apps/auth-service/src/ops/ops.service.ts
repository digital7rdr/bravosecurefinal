import {BadRequestException, Injectable, Logger, NotFoundException, Optional} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {AuthService} from '../auth/auth.service';
import {SentryService} from '../observability/sentry.service';
import {BookingService} from '../booking/booking.service';
import {AgentService} from '../agents/agent.service';
import {BookingStateMachine} from '../booking/state-machine.service';
import {AgentStateMachine} from '../agents/state-machine.service';
import {CpoAssignmentService} from '../booking/assignment/cpo-assignment.service';
import {VehiclePoolService}   from '../booking/assignment/vehicle-pool.service';
import {
  DEFAULT_SERVICE_PRICING, PricingService, resolveExecAddOns, resolveLeadHours,
  type PricingBreakdownLine, type ServicePricingConfig,
} from '../booking/pricing.service';
import {ConversationsService} from '../conversations/conversations.service';
import {WalletService} from '../wallet/wallet.service';
import {SettlementService} from '../settlement/settlement.service';
import {OpsAuditService} from './ops-audit.service';
import {JobFeedService} from './job-feed.service';
import {SystemMessengerService} from './system-messenger.service';
import {MapboxDirectionsService} from './mapbox-directions.service';
import {BookingPushBridge} from './booking-push-bridge.service';
import {bustAccountGate} from '../common/services/account-gate-cache';
import {escapeLike} from '../common/sql-like';
import {COUNTRY_TO_REGION} from '../common/regions';
import type {AdminContext} from './admin.guard';
import {assertRegionScope, isGlobalAdmin} from './admin.guard';
import {DEFAULT_MISSION_WAYPOINTS} from './mission-defaults';

// Ops-gated auto dispatch — pub/sub handoff channel. OpsService (approve) publishes
// `{bookingId}`; OpsApprovedDispatchService (DispatchModule) subscribes and runs
// dispatch.start(). Redis is the seam because DispatchModule imports OpsModule, so
// OpsService can never inject DispatchService directly (module cycle).
export const OPS_APPROVED_DISPATCH_CHANNEL = 'dispatch:ops-approved';

export interface DashboardKpis {
  pending_approval: number;
  active_missions: number;
  agents_on_duty: number;
  agents_total: number;
  open_jobs: number;
  gmv_today_aed: number;
  /** BC-denominated GMV (== SUM(total_eur), 1:1 peg). */
  gmv_today_bc: number;
  sos_active: number;
  /** Pro applications waiting on ops (PENDING_PROPOSAL + REVISION_REQUESTED). */
  pro_pending: number;
  /** Pro protection-date requests still awaiting officers (REQUESTED). */
  pro_requests: number;
  /**
   * IA-10 — per-product segments. The flat keys above stay for one release so
   * an older console keeps working; new surfaces read these.
   *
   * `waiting` is the ONE number the rail badges and the section landings show:
   * how much of this business is blocked on an operator right now.
   */
  lite: ProductKpis;
  executive: ExecutiveKpis;
  enterprise: EnterpriseKpis;
}

export interface ProductKpis {
  /** PENDING_OPS + NO_PROVIDER + AGENCY_NO_SHOW — everything blocked on a human. */
  waiting: number;
  pending_approval: number;
  dispatching: number;
  stalled: number;
  live: number;
  gmv_today_bc: number;
}

export interface ExecutiveKpis extends ProductKpis {
  /** Approved/confirmed details starting inside the next 24 h. */
  upcoming_24h: number;
}

export interface EnterpriseKpis {
  /** Enterprise join requests still pending — the only ops-actionable queue. */
  waiting: number;
  critical_incidents_24h: number;
}

/** One line of the executive-protection per-unit price composition. */
export interface PriceBreakdownItem {
  id: string;
  label: string;
  qty: number;
  rate_eur: number;
  subtotal_eur: number;
}

export interface PriceBreakdown {
  items: PriceBreakdownItem[];
  rate_eur_per_hour: number;
  duration_hours: number;
  total_eur: number;
}

/**
 * RATING-CARD (#10) — true when a completed booking's AGENCY provider should get
 * a +1 jobs_total. Bump only a real provider that is NOT also a paid crew member
 * (a self-provider CPO is already counted by the crew bump, so bumping again
 * would double-count). Pure + exported for unit testing.
 */
/**
 * CRITIC P0 (2026-09-04) — `agents.region_code` has exactly ONE writer:
 * `agent.service.ts setAgencyProfile`, and its own comment says "Company agents
 * only". Every `type='cpo'` INSERT (`agent.service.ts:226`,
 * `org-cpo.service.ts:365`, `pro-management.service.ts:156`) omits the column, so
 * it is NULL for every individual officer. A naive `WHERE a.region_code = :region`
 * therefore empties the officer directory for every non-global admin — including
 * the whole SUBMITTED approval queue — and a naive `assertRegionScope(admin, '')`
 * 403s the detail page. Only a global ADMIN could see or approve an officer.
 *
 * So an officer's region is DERIVED, most-authoritative first:
 *   1. `agents.region_code`                — set on company/agency rows.
 *   2. the MANAGING ORG's `region_code`    — a managed CPO belongs to its agency's
 *                                            region; this is the reliable signal
 *                                            for the managed roster.
 *   3. `users.home_region`                 — already a region code ('N/A' is the
 *                                            explicit "outside coverage" sentinel
 *                                            and must NOT count as a region).
 *   4. `agent_profiles.coverage.countries[0]` → region, via COUNTRY_TO_REGION.
 *   5. `users.country_code`                → region, same map.
 *
 * ONE expression, used by BOTH the list filter and the by-id assertion, because a
 * list and a detail that derive the region differently produce the worst possible
 * result: a row you can see in the list and get 403 on when you open it.
 */
const REGION_FROM_COUNTRY_CASES = Object.entries(COUNTRY_TO_REGION)
  // Belt-and-braces on our OWN compile-time constant before it is interpolated
  // into SQL text: only ISO-3166 alpha-2 keys and region codes pass, so this can
  // never carry anything but [A-Z]{2} literals. No user input reaches this string.
  .filter(([iso, region]) => /^[A-Z]{2}$/.test(iso) && /^[A-Z]{2}$/.test(region))
  .map(([iso, region]) => `WHEN '${iso}' THEN '${region}'`)
  .join(' ');

/**
 * SQL expression yielding an agent's effective region, or NULL when nothing
 * resolves. Requires the caller's FROM to alias: `a` agents, `p` agent_profiles,
 * `u` users, `orga` the managing org's agents row.
 */
export const AGENT_REGION_SQL = `
  COALESCE(
    NULLIF(a.region_code, ''),
    NULLIF(orga.region_code, ''),
    NULLIF(NULLIF(u.home_region, 'N/A'), ''),
    CASE upper(COALESCE(p.coverage->'countries'->>0, '')) ${REGION_FROM_COUNTRY_CASES} ELSE NULL END,
    CASE upper(COALESCE(u.country_code, ''))              ${REGION_FROM_COUNTRY_CASES} ELSE NULL END
  )`;

/** The join set `AGENT_REGION_SQL` needs, for callers that only want the region. */
export const AGENT_REGION_JOINS = `
    FROM agents a
    LEFT JOIN agent_profiles p ON p.user_id = a.user_id
    LEFT JOIN users u          ON u.id      = a.user_id
    LEFT JOIN agents orga      ON orga.user_id = a.managed_by_org_id`;

export function shouldBumpAgencyJobs(
  providerUserId: string | null | undefined,
  paidUserIds: readonly string[],
): boolean {
  return !!providerUserId && !paidUserIds.includes(providerUserId);
}

@Injectable()
export class OpsService {
  private readonly log = new Logger(OpsService.name);
  constructor(
    private readonly db: DatabaseService,
    private readonly bookings: BookingService,
    private readonly agents: AgentService,
    private readonly bookingFsm: BookingStateMachine,
    private readonly agentFsm: AgentStateMachine,
    private readonly audit: OpsAuditService,
    private readonly jobFeed: JobFeedService,
    private readonly systemMsg: SystemMessengerService,
    private readonly cpoAssign: CpoAssignmentService,
    private readonly vehicles: VehiclePoolService,
    private readonly conversations: ConversationsService,
    private readonly wallet: WalletService,
    private readonly settlement: SettlementService,
    private readonly mapbox: MapboxDirectionsService,
    // Booking-approved push bridge (Redis → messenger-service → FCM).
    private readonly bookingPush: BookingPushBridge,
    // Ops-gated auto dispatch — publish-only trigger for the DispatchModule subscriber.
    // Why: OpsModule must NOT inject DispatchService (DispatchModule imports OpsModule —
    // cycle), so approval hands off via Redis pub/sub, mirroring BookingPushBridge.
    // Optional so existing unit specs that construct OpsService positionally keep working.
    @Optional() private readonly redis?: RedisService,
    // Audit fix 5.4 — optional Sentry breadcrumbs for the audit trail.
    @Optional() private readonly sentry?: SentryService,
    // RS-04 — AuthService revokes a user's sessions when their role is reverted
    // on agent terminate/reject. @Optional so the many positional OpsService
    // unit specs keep constructing; DI always provides it in prod (OpsModule
    // imports AuthModule).
    @Optional() private readonly auth?: AuthService,
    // IS-07 — executive-protection price composition on the booking detail.
    // @Optional (same positional-spec reasoning as above); PricingService is
    // dependency-free so the fallback below is always safe.
    @Optional() private readonly pricing?: PricingService,
  ) {}

  private get pricingSvc(): PricingService {
    return this.pricing ?? new PricingService();
  }

  // ─── Dashboard ────────────────────────────────────────────────────

  async dashboard(region?: string): Promise<{kpis: DashboardKpis; activity: unknown[]}> {
    // Audit fix 0.2 — `regionClause` previously built `AND region_code = '<input>'`
    // by interpolating the param after a naive `replace(/'/g, '')`. Even with the
    // single-quote strip, hex/unicode escapes or comment payloads survive — drop
    // string interpolation entirely and pass `region` as a bound parameter.
    const params: unknown[] = [];
    const regionClause = region
      ? (params.push(region), `AND region_code = $${params.length}`)
      : '';

    const kpi = await this.db.qOne<{
      pending_approval: string; active_missions: string;
      agents_on_duty: string; agents_total: string;
      open_jobs: string; gmv_today_aed: string; gmv_today_bc: string;
      sos_active: string; pro_pending: string; pro_requests: string;
      lite_waiting: string; lite_pending: string; lite_dispatching: string;
      lite_stalled: string; lite_live: string; lite_gmv: string;
      exec_waiting: string; exec_pending: string; exec_dispatching: string;
      exec_stalled: string; exec_live: string; exec_gmv: string; exec_upcoming: string;
      ent_waiting: string; ent_critical: string;
    }>(
      // Why: pro_requests counts REQUESTED dates on ACTIVE plans only (B-841) — escalateUnassigned and requestMission already require ACTIVE, and a REQUESTED date on an EXPIRED plan must not be counted forever.
      `SELECT
        (SELECT COUNT(*)::text FROM lite_bookings WHERE status = 'PENDING_OPS' ${regionClause}) AS pending_approval,
        (SELECT COUNT(*)::text FROM missions WHERE status IN ('CREWED','DISPATCHED','PICKUP','LIVE','SOS')) AS active_missions,
        (SELECT COUNT(*)::text FROM agents WHERE on_duty = TRUE) AS agents_on_duty,
        (SELECT COUNT(*)::text FROM agents) AS agents_total,
        (SELECT COUNT(*)::text FROM jobs WHERE status IN ('PUBLISHED','REVIEW')) AS open_jobs,
        -- Why: half-open range, not created_at::date = CURRENT_DATE — the cast
        -- is non-sargable and forced a full seq scan of lite_bookings, twice,
        -- on a dashboard the console polls (50k audit P1-9).
        (SELECT COALESCE(SUM(total_aed),0)::text FROM lite_bookings
           WHERE created_at >= date_trunc('day', now())
             AND created_at <  date_trunc('day', now()) + interval '1 day') AS gmv_today_aed,
        (SELECT COALESCE(SUM(total_eur),0)::text FROM lite_bookings
           WHERE created_at >= date_trunc('day', now())
             AND created_at <  date_trunc('day', now()) + interval '1 day') AS gmv_today_bc,
        (SELECT COUNT(*)::text FROM sos_events
           WHERE acknowledged_at IS NULL AND resolved_at IS NULL) AS sos_active,
        (SELECT COUNT(*)::text FROM pro_applications
           WHERE status IN ('PENDING_PROPOSAL','REVISION_REQUESTED')) AS pro_pending,
        (SELECT COUNT(*)::text FROM pro_plan_missions pm
           JOIN pro_applications pa ON pa.id = pm.application_id
          WHERE pm.status = 'REQUESTED' AND pa.status = 'ACTIVE') AS pro_requests,

        -- IA-10 — per-product segments. The service column is the product
        -- boundary: executive_protection is its own business, everything else
        -- is Lite. (No backticks in SQL comments: this is a JS template
        -- literal and a backtick would terminate it — CLAUDE.md syntax trap.)
        (SELECT COUNT(*)::text FROM lite_bookings
           WHERE status IN ('PENDING_OPS','NO_PROVIDER','AGENCY_NO_SHOW')
             AND service <> 'executive_protection' ${regionClause}) AS lite_waiting,
        (SELECT COUNT(*)::text FROM lite_bookings
           WHERE status = 'PENDING_OPS'
             AND service <> 'executive_protection' ${regionClause}) AS lite_pending,
        (SELECT COUNT(*)::text FROM lite_bookings
           WHERE status = 'DISPATCHING'
             AND service <> 'executive_protection' ${regionClause}) AS lite_dispatching,
        (SELECT COUNT(*)::text FROM lite_bookings
           WHERE status IN ('NO_PROVIDER','AGENCY_NO_SHOW')
             AND service <> 'executive_protection' ${regionClause}) AS lite_stalled,
        (SELECT COUNT(*)::text FROM lite_bookings
           WHERE status = 'LIVE'
             AND service <> 'executive_protection' ${regionClause}) AS lite_live,
        (SELECT COALESCE(SUM(total_eur),0)::text FROM lite_bookings
           WHERE service <> 'executive_protection'
             AND created_at >= date_trunc('day', now())
             AND created_at <  date_trunc('day', now()) + interval '1 day') AS lite_gmv,

        (SELECT COUNT(*)::text FROM lite_bookings
           WHERE status IN ('PENDING_OPS','NO_PROVIDER','AGENCY_NO_SHOW')
             AND service = 'executive_protection' ${regionClause}) AS exec_waiting,
        (SELECT COUNT(*)::text FROM lite_bookings
           WHERE status = 'PENDING_OPS'
             AND service = 'executive_protection' ${regionClause}) AS exec_pending,
        (SELECT COUNT(*)::text FROM lite_bookings
           WHERE status = 'DISPATCHING'
             AND service = 'executive_protection' ${regionClause}) AS exec_dispatching,
        (SELECT COUNT(*)::text FROM lite_bookings
           WHERE status IN ('NO_PROVIDER','AGENCY_NO_SHOW')
             AND service = 'executive_protection' ${regionClause}) AS exec_stalled,
        (SELECT COUNT(*)::text FROM lite_bookings
           WHERE status = 'LIVE'
             AND service = 'executive_protection' ${regionClause}) AS exec_live,
        (SELECT COALESCE(SUM(total_eur),0)::text FROM lite_bookings
           WHERE service = 'executive_protection'
             AND created_at >= date_trunc('day', now())
             AND created_at <  date_trunc('day', now()) + interval '1 day') AS exec_gmv,
        -- Half-open window on an indexed column (never pickup_time::date).
        (SELECT COUNT(*)::text FROM lite_bookings
           WHERE service = 'executive_protection'
             AND status IN ('OPS_APPROVED','PAYMENT_PENDING','CONFIRMED','DISPATCHING')
             AND pickup_time >= now()
             AND pickup_time <  now() + interval '24 hours' ${regionClause}) AS exec_upcoming,

        (SELECT COUNT(*)::text FROM public.enterprise_join_requests
           WHERE status = 'pending') AS ent_waiting,
        (SELECT COUNT(*)::text FROM public.incident_reports
           WHERE severity = 'critical'
             AND created_at >= now() - interval '24 hours') AS ent_critical`,
      params,
    );

    const activity = await this.audit.recentFeed(10);

    return {
      kpis: {
        pending_approval: Number(kpi?.pending_approval ?? 0),
        active_missions:  Number(kpi?.active_missions  ?? 0),
        agents_on_duty:   Number(kpi?.agents_on_duty   ?? 0),
        agents_total:     Number(kpi?.agents_total     ?? 0),
        open_jobs:        Number(kpi?.open_jobs        ?? 0),
        gmv_today_aed:    Number(kpi?.gmv_today_aed    ?? 0),
        // BC == total_eur (1:1 peg) — the console's BC-denominated GMV KPI.
        gmv_today_bc:     Number(kpi?.gmv_today_bc     ?? 0),
        sos_active:       Number(kpi?.sos_active       ?? 0),
        pro_pending:      Number(kpi?.pro_pending      ?? 0),
        pro_requests:     Number(kpi?.pro_requests     ?? 0),
        lite: {
          waiting:          Number(kpi?.lite_waiting     ?? 0),
          pending_approval: Number(kpi?.lite_pending     ?? 0),
          dispatching:      Number(kpi?.lite_dispatching ?? 0),
          stalled:          Number(kpi?.lite_stalled     ?? 0),
          live:             Number(kpi?.lite_live        ?? 0),
          gmv_today_bc:     Number(kpi?.lite_gmv         ?? 0),
        },
        executive: {
          waiting:          Number(kpi?.exec_waiting     ?? 0),
          pending_approval: Number(kpi?.exec_pending     ?? 0),
          dispatching:      Number(kpi?.exec_dispatching ?? 0),
          stalled:          Number(kpi?.exec_stalled     ?? 0),
          live:             Number(kpi?.exec_live        ?? 0),
          gmv_today_bc:     Number(kpi?.exec_gmv         ?? 0),
          upcoming_24h:     Number(kpi?.exec_upcoming    ?? 0),
        },
        enterprise: {
          waiting:                Number(kpi?.ent_waiting  ?? 0),
          critical_incidents_24h: Number(kpi?.ent_critical ?? 0),
        },
      },
      activity,
    };
  }

  // ─── Booking queue ────────────────────────────────────────────────

  listBookings(
    filter: {status?: string; region?: string; limit?: number; service?: string; q?: string; offset?: number},
    admin?: AdminContext,
  ) {
    const limit = filter.limit ?? 50;
    const offset = Math.max(0, Math.floor(filter.offset ?? 0));
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      conds.push(`b.status = $${conds.length + 1}`);
      params.push(filter.status);
    }
    // OP-13 — search across ALL rows, not the loaded window. LIKE wildcards
    // typed by the operator are escaped (backslash first — B-636 lesson) so
    // "%" cannot match everything and "_" cannot match any char.
    const q = (filter.q ?? '').trim();
    if (q) {
      params.push(`%${escapeLike(q)}%`);
      const p = `$${params.length}`;
      conds.push(`(b.id::text ILIKE ${p} ESCAPE '\\' OR cu.display_name ILIKE ${p} ESCAPE '\\'
                   OR b.pickup_address ILIKE ${p} ESCAPE '\\' OR b.dropoff_address ILIKE ${p} ESCAPE '\\')`);
    }
    // IA-03 — product scoping happens HERE, not in the browser. The console's
    // Lite and Executive lists are the same component with a different service
    // set; filtering client-side over the loaded window meant an Executive
    // booking outside the first 50 rows was invisible to the Executive list
    // AND leaked into the Lite one. Comma list, validated by the DTO.
    // Placeholder index = params.length AFTER the push: the search clause
    // above binds one param for four predicates, so conds.length is no
    // longer the param count.
    if (filter.service) {
      const services = filter.service.split(',').map(x => x.trim()).filter(Boolean);
      if (services.length > 0) {
        params.push(services);
        conds.push(`b.service = ANY($${params.length})`);
      }
    }
    // Audit fix 1.5 — region scoping. If a non-global admin (OPS or
    // SUPERVISOR) hits this endpoint, force the WHERE clause onto their
    // own region regardless of what region they passed in the query
    // (or they didn't pass one at all). Global ADMIN keeps the explicit
    // ?region=… filter so they can drill into any tenant.
    const effectiveRegion = (admin && !isGlobalAdmin(admin))
      ? admin.region
      : filter.region;
    if (effectiveRegion) {
      // Placeholder index = params.length + 1 (NOT conds.length + 1): the
      // search clause above pushes one param for four predicates.
      params.push(effectiveRegion);
      conds.push(`b.region_code = $${params.length}`);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    params.push(limit);
    params.push(offset);
    // payer_name — set only for family-charged bookings (payer ≠ client) so
    // the console can badge "UNDER <owner>" on member bookings.
    //
    // B-854 — `payer_via_*` is the CHAIN: the wallet is one rung above the root
    // the client actually joined, so the console renders "Paid by A via B". Both
    // fields are optional on its side, which means omitting them here degrades
    // SILENTLY to "Paid by A" — a sub-member's spend reading as the root's own,
    // on the one screen an operator uses to answer "who paid for this?".
    // IA-05 — `lane` answers "who is working this booking?", which the console
    // could not previously show at all: approval publishes a job for the manual
    // agent feed AND auto-dispatch may be cascading offers for the same row.
    //   auto   — at least one dispatch offer exists (the engine has it)
    //   manual — no offer, but a job row is on the agent feed
    //   null   — pre-approval, neither exists yet
    // Two EXISTS sub-selects on indexed FKs; no join fan-out on the main row.
    //
    // IA-16 — the Executive columns (task_type, duration_hours, add_ons,
    // exec_transport, driver_only) ride the SAME projection so the Executive
    // list can show block hours and add-ons without a second endpoint. They are
    // NULL/defaults for Lite rows, which render nothing.
    return this.db.q(
      `SELECT b.id, b.status, b.region_code, b.region_label, b.service,
              b.pickup_time, b.pickup_address, b.dropoff_address,
              b.cpo_count, b.vehicle_count, b.total_eur, b.total_aed,
              b.created_at,
              b.task_type, b.duration_hours, b.add_ons, b.driver_only,
              (b.exec_transport IS NOT NULL) AS has_transfer_leg,
              cu.display_name AS client_name,
              CASE WHEN b.payer_user_id IS NOT NULL AND b.payer_user_id <> b.client_id
                   THEN pu.display_name END AS payer_name,
              b.payer_via_user_id,
              vu.display_name AS payer_via_name,
              CASE
                WHEN EXISTS (SELECT 1 FROM public.dispatch_offers o WHERE o.booking_id = b.id)
                  THEN 'auto'
                WHEN EXISTS (SELECT 1 FROM public.jobs j WHERE j.booking_id = b.id)
                  THEN 'manual'
              END AS lane
         FROM lite_bookings b
         LEFT JOIN public.users cu ON cu.id = b.client_id
         LEFT JOIN public.users pu ON pu.id = b.payer_user_id
         LEFT JOIN public.users vu ON vu.id = b.payer_via_user_id
         ${where}
        ORDER BY b.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
  }

  async getBookingDetail(id: string, admin: AdminContext) {
    // B-854 — `b.*` is kept verbatim (every consumer of this detail reads whole
    // columns off it, so narrowing to a list would break them silently); the
    // only addition is the via holder's NAME, which is not a column on the row.
    const b = await this.db.qOne(
      `SELECT b.*, vu.display_name AS payer_via_name
         FROM lite_bookings b
         LEFT JOIN public.users vu ON vu.id = b.payer_via_user_id
        WHERE b.id = $1`, [id],
    );
    if (!b) throw new NotFoundException('Booking not found');
    // Audit AUTH-01 — the list + every mutation are region-scoped, but this
    // by-id read wasn't: a region-scoped admin could enumerate any tenant's
    // booking UUID and read full customer PII. Enforce the same scope here.
    assertRegionScope(admin, (b as {region_code: string}).region_code);
    const [audit, job, missionCrew, legacyCpos, vehicle, client, mission] = await Promise.all([
      this.audit.listForSubject('booking', id, 10),
      this.db.qOne(`SELECT * FROM jobs WHERE booking_id = $1`, [id]),
      // C-7 — auto-dispatched crew lives in mission_crew; the legacy pool alone
      // left this block empty for every auto booking (the client-facing getTeam
      // was already fixed the same way).
      this.cpoAssign.getMissionCrewForBooking(id),
      this.cpoAssign.getForBooking(id),
      this.vehicles.getForBooking(id),
      this.db.qOne<{
        id: string; display_name: string; email: string | null;
        phone: string | null; subscription_tier: string;
        country_code: string | null; kyc_status: string;
        avatar_url: string | null; created_at: Date;
      }>(
        `SELECT id, display_name, email, phone_e164 AS phone,
                subscription_tier, country_code, kyc_status,
                avatar_url, created_at
           FROM users WHERE id = $1`,
        [(b as {client_id: string}).client_id],
      ),
      this.db.qOne<{id: string; short_code: string; status: string}>(
        `SELECT id, short_code, status FROM missions WHERE booking_id = $1
          ORDER BY (status <> 'ABORTED') DESC, created_at DESC LIMIT 1`,
        [id],
      ),
    ]);
    // Family linkage — who actually paid. Set only when a member booked under
    // an owner's wallet (payer ≠ client).
    const payerId = (b as {payer_user_id?: string | null}).payer_user_id ?? null;
    const payer = payerId && payerId !== (b as {client_id: string}).client_id
      ? await this.db.qOne<{id: string; display_name: string | null}>(
          `SELECT id, display_name FROM users WHERE id = $1`, [payerId])
      : null;
    const cpos = missionCrew.length > 0 ? missionCrew : legacyCpos;
    return {
      booking: b, audit, job, team: {cpos, vehicle}, client, mission, payer,
      price_breakdown: await this.buildExecBreakdown(b as Record<string, unknown>),
    };
  }

  /**
   * The structural shape of an EP booking — the slots the persisted breakdown
   * lines fill, in the exact order `PricingService.calculateExecutive` emits
   * them (CPO, vehicle?, driver-only?, then add-ons in submission order).
   */
  private execShape(b: Record<string, unknown>) {
    const cpoCount = Number(b.cpo_count ?? 0);
    const vehicleCount = Number(b.vehicle_count ?? 0);
    const driverOnly = !!b.driver_only;
    return {
      cpoCount, vehicleCount, driverOnly,
      vehicles: driverOnly ? 0 : vehicleCount,
      durationHours: Math.max(1, Number(b.duration_hours ?? 1)),
      addOnIds: (Array.isArray(b.add_ons)
        ? (b.add_ons as unknown[]).map(a => typeof a === 'string' ? a : String((a as {id?: string}).id ?? ''))
        : []).filter(Boolean),
      regionCode: typeof b.region_code === 'string' ? b.region_code : null,
    };
  }

  /**
   * IS-07 — per-unit price composition for executive-protection bookings.
   *
   * E2E-28 — this used to call `calculate()` and `resolveExecAddOns()` with NO
   * cfg, i.e. at the COMPILED defaults, ignoring both the persisted
   * `pricing_breakdown` column (written at charge time, `booking.service.ts`)
   * and the region overlay. Ops then approved against a number the client was
   * never charged. Two branches now, in this order:
   *
   *   1. the PERSISTED lines, when the booking carries them — that is the
   *      itemised quote the client actually saw and paid, and no later ops
   *      pricing edit may rewrite history. The booking's own stored
   *      `rate_eur_per_hour`/`total_eur` are the summary, for the same reason.
   *   2. otherwise a recompute that passes the booking's REGION cfg (legacy
   *      rows predate the column). Still not the client's number, but the
   *      closest honest reconstruction.
   *
   * Null for non-exec services.
   */
  private async buildExecBreakdown(b: Record<string, unknown>): Promise<PriceBreakdown | null> {
    if (b.service !== 'executive_protection') return null;
    const shape = this.execShape(b);
    const persisted = this.itemsFromPersistedBreakdown(b, shape);
    if (persisted) {
      // The stored summary is authoritative, but the console renders these with
      // `.toLocaleString()` — a NULL column would paint "NaN" over a money field.
      // Derive from the same lines when it is unreadable.
      const linesRate = +persisted.reduce((s, it) => s + it.subtotal_eur, 0).toFixed(2);
      const storedRate = Number(b.rate_eur_per_hour);
      const rate = Number.isFinite(storedRate) && storedRate > 0 ? storedRate : linesRate;
      const storedTotal = Number(b.total_eur);
      return {
        items: persisted,
        rate_eur_per_hour: rate,
        duration_hours: shape.durationHours,
        total_eur: Number.isFinite(storedTotal) && storedTotal > 0
          ? storedTotal
          : +(rate * shape.durationHours).toFixed(2),
      };
    }
    const cfg = await this.execPricingConfig(shape.regionCode);
    const addOns = resolveExecAddOns(shape.addOnIds, cfg) ?? [];
    const result = this.pricingSvc.calculate({
      cpoCount: shape.cpoCount, vehicleCount: shape.vehicleCount,
      driverOnly: shape.driverOnly, durationHours: shape.durationHours,
      pickupTime: new Date(String(b.pickup_time ?? Date.now())),
      addOns, regionCode: shape.regionCode ?? undefined,
      service: 'executive_protection',
    }, cfg);
    const items: PriceBreakdownItem[] = [{
      id: 'cpo', label: 'Close Protection Officer', qty: shape.cpoCount,
      rate_eur: cfg.exec_cpo_rate_bc, subtotal_eur: shape.cpoCount * cfg.exec_cpo_rate_bc,
    }];
    if (shape.vehicles > 0) {
      items.push({
        id: 'vehicle', label: 'Vehicle & Driver', qty: shape.vehicles,
        rate_eur: cfg.exec_vehicle_rate_bc, subtotal_eur: shape.vehicles * cfg.exec_vehicle_rate_bc,
      });
    }
    if (shape.driverOnly) {
      items.push({
        id: 'driver_only', label: 'Bravo driver (client vehicle)', qty: 1,
        rate_eur: cfg.exec_driver_only_rate_bc, subtotal_eur: cfg.exec_driver_only_rate_bc,
      });
    }
    for (const a of addOns) {
      items.push({id: a.id, label: a.label, qty: 1, rate_eur: a.price_eur_per_hour, subtotal_eur: a.price_eur_per_hour});
    }
    return {
      items,
      rate_eur_per_hour: result.rate_eur_per_hour,
      duration_hours: shape.durationHours,
      total_eur: result.total_eur,
    };
  }

  /**
   * E2E-28 — map the persisted `pricing_breakdown` lines onto the console's
   * per-unit item shape. The ids MUST survive: the booking page keys add-on
   * rates off `item.id`, so a label-only projection silently drops the "(90
   * BC/hr)" suffix next to every add-on name.
   *
   * Matching is POSITIONAL because that is what the writer guarantees; labels
   * are historic text that may have been re-worded since. If the persisted line
   * count does not equal the slot count the booking's own columns describe, the
   * row is NOT the composition we think it is — return null and let the caller
   * recompute rather than pin a rate onto the wrong line.
   */
  private itemsFromPersistedBreakdown(
    b: Record<string, unknown>,
    shape: ReturnType<OpsService['execShape']>,
  ): PriceBreakdownItem[] | null {
    const raw = b.pricing_breakdown;
    const lines: PricingBreakdownLine[] = Array.isArray(raw)
      ? (raw as unknown[]).filter(
          (l): l is PricingBreakdownLine =>
            !!l && typeof l === 'object' &&
            typeof (l as PricingBreakdownLine).label === 'string' &&
            Number.isFinite(Number((l as PricingBreakdownLine).amount_eur)),
        )
      : [];
    if (lines.length === 0) return null;
    const slots: Array<{id: string; qty: number}> = [{id: 'cpo', qty: shape.cpoCount}];
    if (shape.vehicles > 0) slots.push({id: 'vehicle', qty: shape.vehicles});
    if (shape.driverOnly) slots.push({id: 'driver_only', qty: 1});
    for (const id of shape.addOnIds) slots.push({id, qty: 1});
    if (slots.length !== lines.length) return null;
    return slots.map((slot, i) => {
      const amount = Number(lines[i].amount_eur);
      const qty = slot.qty > 0 ? slot.qty : 1;
      return {
        id: slot.id,
        label: lines[i].label,
        qty: slot.qty,
        rate_eur: +(amount / qty).toFixed(2),
        subtotal_eur: amount,
      };
    });
  }

  /**
   * The pricing config for a booking's own region, fail-open to the compiled
   * defaults. `PricingService.config` is already fail-open internally; the
   * try/catch is for the bare-constructed fallback instance.
   */
  private async execPricingConfig(regionCode: string | null): Promise<ServicePricingConfig> {
    try {
      return await this.pricingSvc.config(regionCode);
    } catch (e) {
      this.log.warn(`exec breakdown config read failed: ${(e as Error).message}`);
      return DEFAULT_SERVICE_PRICING;
    }
  }

  /**
   * E2E-04 — the two stable refusal codes for an ops approval that arrived too
   * late. Exported as constants so the ops console can branch on the string
   * without re-typing it, and so a rename breaks the build rather than the UI.
   *
   *   `booking_start_time_passed`       the block already started. NOT
   *                                     overridable — approving it would hold
   *                                     escrow and start the hourly clock for
   *                                     time the client has already lost.
   *                                     Reject-and-refund is the ops action.
   *   `booking_insufficient_lead_time`  still in the future, but inside the
   *                                     service's own configured lead. The
   *                                     dispatch cascade has less runway than
   *                                     the product promises. Overridable —
   *                                     `ApproveBookingDto.approve_late = true`
   *                                     re-submits as a deliberate decision.
   *
   * Both carry `start_time`; the lead one also carries `lead_hours` +
   * `earliest_start`, exactly like `exec_insufficient_lead_time` on create, so
   * the console never has to hardcode a number.
   */
  static readonly APPROVE_START_PASSED = 'booking_start_time_passed';
  static readonly APPROVE_LEAD_TOO_SHORT = 'booking_insufficient_lead_time';

  /**
   * E2E-04 — approve had NO time check at all, so an EP booking could be
   * approved four hours after its start and would then hold escrow and search
   * for a crew for a block the client had already lost.
   *
   * The lead floor is the service's OWN ops-editable value, resolved through
   * the same `resolveLeadHours(service, cfg)` the create path uses — never a
   * number retyped here.
   */
  private async assertApprovableStartTime(
    r: {
      service: string | null; pickup_time: Date; region_code: string;
      dispatch_mode: string | null; booking_mode: string | null;
    },
    nowMs: number,
    allowLate: boolean,
  ): Promise<void> {
    const startMs = new Date(r.pickup_time).getTime();
    // A row with no readable start is not a row with a BAD start — never block
    // an approval on a column we could not parse.
    if (!Number.isFinite(startMs)) return;
    // Mirrors `booking.service.ts` create() exactly: an ON-DEMAND auto request
    // ("I need a guard now", the headline product) is lead-EXEMPT there, and its
    // pickup_time IS submit-time — so it is always a few minutes in the past by
    // the moment an operator opens the board. Applying either check to it would
    // make the whole Secure Transfer now-lane unapprovable.
    //
    // CRITIC P1 — the service gate is LOAD-BEARING and was missing. At create,
    // Executive Protection takes the `if (dto.service === 'executive_protection')`
    // arm and is lead-gated UNCONDITIONALLY ("EP is ALWAYS SCHEDULED… the exemption
    // is gone"); the auto+'now' exemption lives only in the non-EP `else`. Without
    // `service !== 'executive_protection'` here, an EP row carrying
    // booking_mode:'now' skipped BOTH checks — including the non-overridable
    // past-start one, which is the P0 this guard exists for.
    const isOnDemandAuto =
      r.service !== 'executive_protection' &&
      r.dispatch_mode === 'auto' &&
      (r.booking_mode ?? 'now') === 'now';
    if (isOnDemandAuto) return;
    const startIso = new Date(startMs).toISOString();
    if (startMs <= nowMs) {
      throw new BadRequestException({
        code: OpsService.APPROVE_START_PASSED,
        message: 'This booking\'s start time has already passed. Reject and refund it instead of approving.',
        start_time: startIso,
      });
    }
    if (allowLate) return;
    const cfg = await this.execPricingConfig(r.region_code ?? null);
    const leadHours = resolveLeadHours(r.service, cfg);
    if (leadHours <= 0) return;
    const earliestMs = nowMs + leadHours * 3600_000;
    if (startMs < earliestMs) {
      throw new BadRequestException({
        code: OpsService.APPROVE_LEAD_TOO_SHORT,
        message: `This booking starts inside its ${leadHours}-hour dispatch lead. Approve it only if you are accepting the shortened runway.`,
        lead_hours: leadHours,
        start_time: startIso,
        earliest_start: new Date(earliestMs).toISOString(),
      });
    }
  }

  async approveBooking(
    bookingId: string, admin: AdminContext, dressInstructions: string, notes?: string,
    opts?: {approveLate?: boolean},
  ) {
    const dress = (dressInstructions ?? '').trim();
    if (dress.length < 8) {
      throw new BadRequestException('dress_instructions_required');
    }
    // Audit fix 1.1 — wrap the state read + write in a single transaction
    // so two ops admins clicking "approve" simultaneously can't both
    // pass the status check. The locking strategy is belt-and-braces:
    //   1. SELECT ... FOR UPDATE pins the booking row inside the txn.
    //   2. UPDATE ... WHERE status = 'PENDING_OPS' makes the write
    //      conditional — the second writer hits an empty result and
    //      we throw before touching anything else.
    const row = await this.db.withTransaction(async tx => {
      const r = await tx.qOne<{
        status: string; client_id: string; pickup_address: string;
        dropoff_address: string | null; pickup_time: Date; total_aed: string;
        region_code: string; dispatch_mode: string | null; booking_mode: string | null;
        service: string | null;
      }>(
        `SELECT status, client_id, pickup_address, dropoff_address, pickup_time, total_aed, region_code,
                dispatch_mode, booking_mode, service
           FROM lite_bookings WHERE id = $1 FOR UPDATE`, [bookingId],
      );
      if (!r) throw new NotFoundException('Booking not found');
      // Audit fix 1.5 — non-global admin may only approve bookings in
      // their own region. Throws ForbiddenException → 403.
      assertRegionScope(admin, r.region_code);
      // E2E-04 — refuse (or make the operator confirm) an approval that can no
      // longer be delivered. Inside the txn, on the LOCKED row, before the FSM
      // flip: a booking that fails this must not be half-approved.
      await this.assertApprovableStartTime(r, Date.now(), opts?.approveLate === true);
      this.bookingFsm.assert(r.status as never, 'OPS_APPROVED', 'OPS_HANDLER');
      // Conditional update — guards against an FSM transition we missed
      // and against a parallel writer that beat us to the lock release.
      const upd = await tx.q(
        `UPDATE lite_bookings
            SET status = 'OPS_APPROVED', dress_instructions = $2
          WHERE id = $1 AND status = $3
          RETURNING id`,
        [bookingId, dress, r.status],
      );
      if (upd.length === 0) {
        throw new BadRequestException('booking_state_changed_concurrently');
      }
      return r;
    });
    await this.audit.recordAdmin(admin, 'booking.approve', 'booking', bookingId, {notes, dress_instructions: dress});
    // Audit fix 5.4 — Sentry breadcrumb so a later exception report
    // shows which booking the operator was approving.
    this.sentry?.opsDecisionBreadcrumb('booking.approve', admin, {type: 'booking', id: bookingId});

    // Ops-gated auto dispatch: an approved AUTO booking goes to the matchmaker, not the
    // agent job feed / legacy pay flow. Wake the client, then hand off to DispatchModule:
    //   - 'now'   → publish on `dispatch:ops-approved`; the subscriber runs dispatch.start
    //               (OPS_APPROVED → DISPATCHING) on one pod.
    //   - 'later' → no publish; the scheduled-dispatch cron picks the OPS_APPROVED row up
    //               near pickup_time.
    // Publish is best-effort (mirrors BookingPushBridge): a lost frame leaves the booking
    // OPS_APPROVED for the ops board to re-approve-or-cancel — never a stuck client charge.
    if (row.dispatch_mode === 'auto') {
      void this.bookingPush.bookingApproved(row.client_id, bookingId, 'OPS_APPROVED');
      const isLater = (row.booking_mode ?? 'now') === 'later';
      if (!isLater) {
        try {
          await this.redis?.client.publish(OPS_APPROVED_DISPATCH_CHANNEL, JSON.stringify({bookingId}));
        } catch (e) {
          this.log.warn(`ops-approved dispatch publish failed for ${bookingId}: ${(e as Error).message}`);
        }
      }
      // E2E-48 — the auto path publishes NOTHING to the agent job feed, but the
      // response was indistinguishable from a legacy approve whose publish had
      // simply failed (`job: null` in both), so the console's toast claimed the
      // booking was "published to the job feed". `job_published` is the truth the
      // toast needs; `dispatch_path` says which lane actually has it now.
      // B-817 — the auto lane published NOTHING to the live feed (the legacy
      // lane's job.publish row was the only trace of an approval), so the
      // console's notification centre could not show that a booking had left
      // the ops board. Best-effort like every other emit here.
      await this.audit.emit({
        kind: 'booking.approve', severity: 'ok', actor: admin.call_sign, subject: bookingId.slice(0, 8),
        message: `${admin.call_sign} approved booking ${bookingId.slice(0, 8)} · ${isLater ? 'scheduled for auto-dispatch' : 'auto-dispatch started'}`,
        metadata: {booking_id: bookingId, service: row.service, dispatch_path: isLater ? 'auto_scheduled' : 'auto_dispatch'},
      });
      return {
        ok: true, job: null,
        job_published: false,
        dispatch_path: isLater ? ('auto_scheduled' as const) : ('auto_dispatch' as const),
      };
    }

    // Auto-publish to the agent feed. If the publish fails (e.g. transient
    // collision in the short-code sequence) the approval itself stays
    // authoritative — log and audit, but don't bubble. Ops can re-publish
    // via a manual retry without rolling back the OPS_APPROVED state.
    let job: Awaited<ReturnType<typeof this.jobFeed.publishFromBooking>> | null = null;
    try {
      job = await this.jobFeed.publishFromBooking(bookingId, admin);
    } catch (e) {
      this.log.warn(`Job publish failed after approval ${bookingId}: ${(e as Error).message}`);
      await this.audit.record({
        actor_role: 'SYSTEM', action: 'job.publish_failed',
        subject_type: 'booking', subject_id: bookingId,
        metadata: {error: (e as Error).message},
      });
    }

    // Auto-send a system confirmation message to the client. Best-effort —
    // failure to deliver the card does not fail the approval itself.
    try {
      if (job) {
        await this.systemMsg.sendBookingApproved({
          client_user_id: row.client_id,
          booking_id: bookingId,
          job_short_code: job.short_code,
          pickup_address: row.pickup_address,
          dropoff_address: row.dropoff_address,
          start_time: new Date(row.pickup_time).toISOString(),
          total_aed: Number(row.total_aed),
        });
      }
    } catch (e) {
      // Log but don't throw — the approval is authoritative.
      await this.audit.record({
        actor_role: 'SYSTEM', action: 'system_msg.failed',
        subject_type: 'booking', subject_id: bookingId,
        metadata: {error: (e as Error).message, kind: 'booking_approved'},
      });
    }

    // Fire-and-forget FCM wake so the mobile client gets a notification
    // even when the app is backgrounded. The bridge writes to Redis;
    // messenger-service subscribes and dispatches via FCM. Failure is
    // logged inside the bridge — the in-app 4s poller is the fallback.
    void this.bookingPush.bookingApproved(row.client_id, bookingId, 'OPS_APPROVED');
    // B-809 — wake the providers who can see the new job. Recipient rule mirrors
    // the marketplace feed (`getAvailableJobs`): an ACTIVE agent whose region is
    // the job's, or who has no region set (legacy: sees every region). Same
    // staging-only bypass as the feed. Fire-and-forget, post-commit, bounded.
    if (job) {
      void this.wakeProvidersForPublishedJob(bookingId, job.id, row.region_code);
    }

    // E2E-48 — `job` is null here too when publishFromBooking THREW (the approval
    // stays authoritative on purpose). `job_published` distinguishes that failure
    // from the auto lane's deliberate no-publish.
    return {ok: true, job, job_published: job !== null, dispatch_path: 'job_feed' as const};
  }

  private async wakeProvidersForPublishedJob(bookingId: string, jobId: string, regionCode: string): Promise<void> {
    try {
      const disableRegion = process.env.DISPATCH_DISABLE_REGION_FILTER === 'true'
        && process.env.NODE_ENV !== 'production';
      // Recipients = the accounts that APPLY to marketplace jobs: COMPANY
      // (agency) rows only — org-managed CPOs are `type='cpo'` with no region
      // and live in a shell that has no marketplace, so a type-less query
      // would wake every CPO in every country. APPROVED is included because a
      // company can apply from APPROVED (before deployment_complete). A NULL
      // region on a company row is the legacy "sees every region" case the
      // feed honours; it is small once the type is pinned.
      const rows = await this.db.q<{user_id: string}>(
        `SELECT user_id FROM public.agents
          WHERE type = 'company'
            AND status IN ('ACTIVE', 'APPROVED')
            ${disableRegion ? '' : 'AND (region_code = $1 OR region_code IS NULL)'}
          ORDER BY user_id
          LIMIT 500`,
        disableRegion ? [] : [regionCode],
      );
      if (rows.length === 0) {return;}
      await this.bookingPush.jobPublished(rows.map(r => r.user_id), bookingId, jobId);
    } catch (e) {
      this.log.warn(`job-published wake failed for ${bookingId}: ${(e as Error).message}`);
    }
  }

  async rejectBooking(bookingId: string, admin: AdminContext, reason: string, notes?: string) {
    // Audit fix 1.1 — same atomic FSM pattern as approveBooking.
    const row = await this.db.withTransaction(async tx => {
      const r = await tx.qOne<{status: string; client_id: string; region_code: string}>(
        `SELECT status, client_id, region_code FROM lite_bookings WHERE id = $1 FOR UPDATE`, [bookingId],
      );
      if (!r) throw new NotFoundException('Booking not found');
      // AUTHZ-2 — a region-scoped OPS/SUPERVISOR may only reject bookings in their
      // own region (approveBooking already asserts this; reject was missed). A
      // global ADMIN bypasses. Checked before the FSM flip so a foreign admin can't
      // even probe the booking's state.
      assertRegionScope(admin, r.region_code);
      this.bookingFsm.assert(r.status as never, 'CANCELLED', 'OPS_HANDLER');
      const upd = await tx.q(
        `UPDATE lite_bookings SET status = 'CANCELLED' WHERE id = $1 AND status = $2 RETURNING id`,
        [bookingId, r.status],
      );
      if (upd.length === 0) {
        throw new BadRequestException('booking_state_changed_concurrently');
      }
      return r;
    });
    await this.audit.recordAdmin(admin, 'booking.reject', 'booking', bookingId, {reason, notes});
    await this.audit.emit({
      kind: 'booking.reject', severity: 'warn', actor: admin.call_sign, subject: bookingId.slice(0, 8),
      message: `${admin.call_sign} rejected booking · ${reason}`,
      metadata: {booking_id: bookingId},
    });

    // System message to the client explaining the rejection.
    try {
      await this.systemMsg.sendBookingRejected({
        client_user_id: row.client_id,
        booking_id: bookingId,
        reason, notes,
      });
    } catch (e) {
      await this.audit.record({
        actor_role: 'SYSTEM', action: 'system_msg.failed',
        subject_type: 'booking', subject_id: bookingId,
        metadata: {error: (e as Error).message, kind: 'booking_rejected'},
      });
    }
    // LM-N4 — the card alone never woke a backgrounded client about the rejection.
    void this.bookingPush.bookingRejected(row.client_id, bookingId).catch(() => undefined);

    return {ok: true};
  }

  // ─── Agents (admin view) ─────────────────────────────────────────

  listAgents(
    filter: {status?: string; region?: string; type?: string; limit?: number; offset?: number},
    admin?: AdminContext,
  ) {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.status) { conds.push(`a.status = $${params.length + 1}`); params.push(filter.status); }
    if (filter.type)   { conds.push(`a.type   = $${params.length + 1}`); params.push(filter.type); }
    // E2E-19 — `filter.region` was DECLARED and never used, so a region-scoped
    // OPS/SUPERVISOR read every region's officer directory including email and
    // phone, while the bookings list force-scoped the same admin. Identical
    // pattern to listBookings: a non-global admin is pinned to their OWN region
    // whatever they passed in the query; a global ADMIN keeps the ?region= drill-in.
    //
    // CRITIC P0 — filter on the DERIVED region (AGENT_REGION_SQL), never on the
    // raw `a.region_code`: that column is NULL for every individual officer, so
    // the raw form emptied the whole CPO directory for non-global admins.
    const effectiveRegion = (admin && !isGlobalAdmin(admin))
      ? admin.region
      : filter.region;
    if (effectiveRegion) {
      params.push(effectiveRegion);
      conds.push(`${AGENT_REGION_SQL} = $${params.length}`);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    // DC-09 — the LIMIT used to be a hardcoded 200 with no way to reach older
    // rows; the console now passes ?limit= (DTO-capped at 500) as load-more.
    params.push(Math.min(Math.max(filter.limit ?? 200, 1), 500));
    params.push(Math.max(0, Math.floor(filter.offset ?? 0)));
    return this.db.q(
      `SELECT a.user_id, a.type, a.status, a.tier, a.call_sign, a.display_name,
              a.rate_aed_per_hour, a.rating, a.jobs_total, a.duty_hours_mtd, a.on_duty,
              a.submitted_at, a.approved_at, a.created_at,
              u.email, u.phone_e164 AS phone,
              p.coverage,
              ${AGENT_REGION_SQL} AS effective_region
         FROM agents a
         LEFT JOIN agent_profiles p ON p.user_id = a.user_id
         LEFT JOIN users u          ON u.id      = a.user_id
         LEFT JOIN agents orga      ON orga.user_id = a.managed_by_org_id
         ${where}
        ORDER BY a.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
  }

  /**
   * CRITIC P0 — the ONE region gate for every by-id agent surface (detail, stats,
   * doc review, KYC review). Uses the SAME derivation as the list, so a row that
   * appears in a scoped admin's list can never 403 when they open it.
   *
   * Fails CLOSED only when NOTHING resolves: an agent with no region on the row,
   * no managing org, no home_region, no coverage country and no country_code is
   * genuinely unplaceable, and a region-scoped admin must not act on it. A global
   * ADMIN always bypasses, so such a row is never unreachable by the platform.
   */
  private async assertAgentRegion(userId: string, admin?: AdminContext): Promise<void> {
    if (!admin || isGlobalAdmin(admin)) return;
    const scope = await this.db.qOne<{effective_region: string | null}>(
      `SELECT ${AGENT_REGION_SQL} AS effective_region ${AGENT_REGION_JOINS} WHERE a.user_id = $1`,
      [userId],
    );
    if (!scope) throw new NotFoundException('Agent not found');
    assertRegionScope(admin, scope.effective_region ?? '');
  }

  /** Per-mission deployment checklist for all assigned crew. */
  async getMissionDeployment(missionId: string, admin: AdminContext) {
    // Audit AUTH-01 — region-scope this by-id read. Resolve the mission's
    // region via its booking and assert before returning crew/checks.
    const region = await this.db.qOne<{region_code: string}>(
      `SELECT b.region_code
         FROM missions m JOIN lite_bookings b ON b.id = m.booking_id
        WHERE m.id = $1`,
      [missionId],
    );
    if (!region) throw new NotFoundException('Mission not found');
    assertRegionScope(admin, region.region_code);
    const crew = await this.db.q<{agent_id: string; call_sign: string; role: string}>(
      `SELECT agent_id, call_sign, role FROM mission_crew WHERE mission_id = $1 ORDER BY slot`,
      [missionId],
    );
    const checks = await this.db.q<{
      user_id: string; check_key: string; state: string;
      signed_at: Date | null; notes: string | null;
    }>(
      `SELECT user_id, check_key, state, signed_at, notes
         FROM agent_deployment_checks WHERE mission_id = $1`,
      [missionId],
    );
    return {crew, checks};
  }

  /** Sign off a single deployment check for a crew member on a specific mission. */
  async signoffMissionDeployment(
    missionId: string,
    dto: {agent_id: string; check_key: string; state: 'passed' | 'failed'; notes?: string},
    admin: AdminContext,
  ) {
    await this.db.q(
      `UPDATE agent_deployment_checks
          SET state = $4, signed_by = $3, signed_at = NOW(), notes = $5
        WHERE mission_id = $1 AND user_id = $2 AND check_key = $6`,
      [missionId, dto.agent_id, admin.user_id, dto.state, dto.notes ?? null, dto.check_key],
    );
    await this.audit.recordAdmin(admin, 'mission.deploy_signoff', 'mission', missionId, dto);
    return {ok: true};
  }

  /** Stamp reviewed_at on a compliance-pack doc — called when ops clicks VIEW. */
  // CRITIC P1 — this MUTATES another region's vetting record; scoped like the read.
  async reviewDocument(agentId: string, slot: string, reviewerId: string, admin?: AdminContext) {
    await this.assertAgentRegion(agentId, admin);
    return this.agents.reviewDocument(agentId, slot, reviewerId);
  }

  /** Stamp reviewed_at on a KYC check — called when ops clicks VIEW on KYC panel. */
  async reviewKycCheck(agentId: string, kind: string, reviewerId: string, admin?: AdminContext) {
    await this.assertAgentRegion(agentId, admin);
    return this.agents.reviewKycCheck(agentId, kind, reviewerId);
  }

  /** Full agent record for the ops-console approval page. */
  async getAgentDetail(userId: string, admin?: AdminContext) {
    // E2E-19 — the by-id read was unscoped, so force-scoping only the LIST would
    // have left the same PII one guessed UUID away (the AUTH-01 lesson on
    // getBookingDetail). A global ADMIN bypasses.
    await this.assertAgentRegion(userId, admin);
    const detail = await this.agents.getMe(userId);
    const contact = await this.db.qOne<{email: string | null; phone: string | null}>(
      `SELECT email, phone_e164 AS phone FROM users WHERE id = $1`, [userId],
    );
    // Provider linkage — a managed CPO is onboarded BY a service-provider org
    // (agents.managed_by_org_id). Ops must be able to verify which provider
    // vouches for the officer before approving, so surface the org's company
    // name, its own partner status, and the roster membership state. NULL for
    // legacy self-registered agents.
    const managedBy = await this.db.qOne<{
      org_user_id: string;
      company: string | null;
      email: string | null;
      org_status: string | null;
      member_status: string | null;
      member_call_sign: string | null;
    }>(
      `SELECT a.managed_by_org_id            AS org_user_id,
              COALESCE(oa.display_name, ou.display_name) AS company,
              ou.email,
              oa.status                      AS org_status,
              om.status                      AS member_status,
              om.call_sign                   AS member_call_sign
         FROM agents a
         JOIN users ou       ON ou.id = a.managed_by_org_id
         LEFT JOIN agents oa ON oa.user_id = a.managed_by_org_id
         LEFT JOIN org_members om
                ON om.org_user_id = a.managed_by_org_id
               AND om.member_user_id = a.user_id
        WHERE a.user_id = $1 AND a.managed_by_org_id IS NOT NULL`,
      [userId],
    );
    // DC-08 — agent_audit was written on every status flip but had no reader
    // anywhere; surface the lifecycle trail on the ops agent detail.
    const stateAudit = await this.db.q(
      `SELECT id, from_status, to_status, actor_id, actor_role, metadata, created_at
         FROM agent_audit WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 50`,
      [userId],
    );
    return {
      ...detail,
      contact: contact ?? {email: null, phone: null},
      managed_by: managedBy,
      state_audit: stateAudit,
    };
  }

  /**
   * Ops-side agent decision orchestrator. The agent state machine is
   *   SUBMITTED → UNDER_REVIEW → APPROVED / REJECTED
   * — so if the admin is deciding on a freshly-submitted agent, we
   * auto-chain both transitions.
   */
  async approveAgent(userId: string, admin: AdminContext, notes?: string) {
    const agent = await this.db.qOne<{status: string}>(
      `SELECT status FROM agents WHERE user_id = $1`, [userId],
    );
    if (agent && agent.status === 'SUBMITTED') {
      await this.agents.startReview(userId, admin.user_id);
    }
    await this.agents.decide(userId, admin.user_id, 'APPROVED', notes);
    await this.mirrorAgentToPool(userId);
    await this.audit.recordAdmin(admin, 'agent.approve', 'agent', userId, {notes});
    await this.audit.emit({
      kind: 'agent.approve', severity: 'ok', actor: admin.call_sign, subject: userId.slice(0, 8),
      message: `${admin.call_sign} approved partner ${userId.slice(0, 8)}`,
      metadata: {user_id: userId},
    });
    // Wake the agent's phone so they don't have to re-open the app to
    // see the approval. Falls back to the 3s AgentAdminApproval poll if
    // the push misses.
    void this.bookingPush.agentDecided(userId, 'APPROVED');
  }

  /**
   * Mirror an approved CPO agent into cpo_pool so they're immediately
   * pickable from the booking dispatch UI. cpo_pool.id is set to the
   * agent's user_id so the two stay in 1:1 sync — re-running the mirror
   * is a no-op via ON CONFLICT.
   *
   * Audit fix 2.5 — was hardcoding `armed=TRUE`, `region='AE'`,
   * `specialties=['exec_protection']`. That's a compliance time-bomb:
   * a non-firearms-licensed agent could be picked for an `armed=TRUE`
   * booking, or a UAE-based agent assigned to a Saudi mission. We now
   * derive each field from the real onboarding data:
   *
   *   - `armed`        ← `agent_profiles.capabilities ? 'firearms'`
   *                      (jsonb array contains 'firearms')
   *   - `region_code`  ← first country in `agent_profiles.coverage.countries`
   *                      where on=true; falls back to users.country_code,
   *                      then 'AE' as last resort.
   *   - `specialties`  ← `agent_profiles.coverage.services` filtered to
   *                      keys with `on=true`. Empty array if none set.
   *
   * Reading via SELECT inside the INSERT keeps the operation atomic —
   * one statement, ON CONFLICT idempotent.
   */
  private async mirrorAgentToPool(userId: string): Promise<void> {
    // Pre-check that a real region exists. Previously the query
    // defaulted to 'AE' when neither agent_profiles.coverage nor
    // users.country_code yielded one — silently making a GB-based agent
    // an AE pool member, and routing them to dispatches in the wrong
    // jurisdiction. Refuse to mirror without a real region; the agent
    // stays invisible to dispatch until they complete coverage
    // onboarding (which calls /agents/me/coverage and re-mirrors).
    // Why the parens: a UNION branch that carries its own ORDER BY/LIMIT must
    // be parenthesized in Postgres — without them this is a hard syntax error
    // ("syntax error at or near UNION"), which 500'd every agent approval
    // AFTER decide() had already committed (agent ACTIVE but never mirrored).
    const region = await this.db.qOne<{code: string}>(
      `SELECT code FROM (
         (SELECT (c->>'code')::text AS code
            FROM agent_profiles ap,
                 jsonb_array_elements(COALESCE(ap.coverage->'countries', '[]'::jsonb)) c
           WHERE ap.user_id = $1
             AND COALESCE((c->>'on')::boolean, FALSE) = TRUE
           ORDER BY 1
           LIMIT 1)
         UNION ALL
         (SELECT u.country_code AS code
            FROM users u
           WHERE u.id = $1 AND u.country_code IS NOT NULL AND u.country_code <> ''
           LIMIT 1)
       ) regions
       WHERE code IS NOT NULL AND code <> ''
       LIMIT 1`,
      [userId],
    );
    if (!region) {
      this.log.warn(
        `mirrorAgentToPool skipped agent=${userId.slice(0, 8)} — ` +
        `no coverage country or users.country_code set. Agent will not ` +
        `appear in dispatch picker until coverage onboarding completes.`,
      );
      return;
    }

    await this.db.q(
      `INSERT INTO cpo_pool (id, call_sign, display_name, role, region_code, armed, female, specialties, availability, active)
       SELECT
         a.user_id,
         COALESCE(NULLIF(a.call_sign, ''), 'AGT-' || SUBSTRING(a.user_id::text, 1, 4)),
         COALESCE(NULLIF(a.display_name, ''), SPLIT_PART(u.email, '@', 1)),
         CASE a.tier WHEN 1 THEN 'Senior CPO' ELSE 'CPO' END,
         $2::text,
         -- armed: capabilities jsonb array contains 'firearms'.
         COALESCE(
           (SELECT TRUE
              FROM agent_profiles ap3,
                   jsonb_array_elements_text(COALESCE(ap3.capabilities, '[]'::jsonb)) cap
             WHERE ap3.user_id = a.user_id
               AND cap = 'firearms'
             LIMIT 1),
           FALSE
         ),
         FALSE,
         -- specialties: enabled service keys from coverage.services. NULL
         -- in profile → empty array, never the legacy [exec_protection]
         -- default. Ops can still filter; the dispatch picker just shows
         -- "no specialties on file" until the agent fills in onboarding.
         COALESCE(
           (
             SELECT array_agg((s->>'key')::text)
               FROM agent_profiles ap4,
                    jsonb_array_elements(COALESCE(ap4.coverage->'services', '[]'::jsonb)) s
              WHERE ap4.user_id = a.user_id
                AND COALESCE((s->>'on')::boolean, FALSE) = TRUE
           ),
           ARRAY[]::text[]
         ),
         CASE WHEN a.on_duty THEN 'available'::cpo_availability ELSE 'on_mission'::cpo_availability END,
         TRUE
         FROM agents a JOIN users u ON u.id = a.user_id
        WHERE a.user_id = $1
          AND a.type = 'cpo'
          AND a.status IN ('APPROVED', 'ACTIVE')
       ON CONFLICT (id) DO NOTHING`,
      [userId, region.code],
    );
  }

  async rejectAgent(userId: string, admin: AdminContext, notes: string) {
    const agent = await this.db.qOne<{status: string}>(
      `SELECT status FROM agents WHERE user_id = $1`, [userId],
    );
    if (agent && agent.status === 'SUBMITTED') {
      await this.agents.startReview(userId, admin.user_id);
    }
    await this.agents.decide(userId, admin.user_id, 'REJECTED', notes);
    await this.audit.recordAdmin(admin, 'agent.reject', 'agent', userId, {notes});
    await this.audit.emit({
      kind: 'agent.reject', severity: 'warn', actor: admin.call_sign, subject: userId.slice(0, 8),
      message: `${admin.call_sign} rejected partner ${userId.slice(0, 8)}`,
      metadata: {user_id: userId},
    });
    void this.bookingPush.agentDecided(userId, 'REJECTED');
    // RS-04 — revert the role for a rejected applicant the same way as terminate.
    await this.revertRoleOnAgentExit(userId, admin, 'agent_rejected');
  }

  async getAgentStats(userId: string, admin?: AdminContext) {
    // CRITIC P1 — this returns another region's LIVE current_lat/current_lng plus
    // pickup/dropoff addresses; unscoped it was the same PII leak as the detail
    // page, one guessed UUID away. Same derived gate.
    await this.assertAgentRegion(userId, admin);
    const [activeMission, recentMissions, lastLocation] = await Promise.all([
      this.db.qOne<{
        id: string; short_code: string; status: string;
        current_lat: number | null; current_lng: number | null;
        started_at: string; risk_level: string;
        pickup_address: string | null; dropoff_address: string | null;
      }>(
        `SELECT m.id, m.short_code, m.status, m.current_lat, m.current_lng,
                m.started_at, m.risk_level, b.pickup_address, b.dropoff_address
           FROM missions m
           JOIN mission_crew mc ON mc.mission_id = m.id
           LEFT JOIN lite_bookings b ON b.id = m.booking_id
          WHERE mc.agent_id = $1 AND m.status IN ('CREWED','DISPATCHED','PICKUP','LIVE','SOS')
          ORDER BY m.started_at DESC LIMIT 1`,
        [userId],
      ),
      this.db.q<{
        id: string; short_code: string; status: string;
        started_at: string; ended_at: string | null;
        pickup_address: string | null; total_aed: string | null; total_eur: string | null;
      }>(
        `SELECT m.id, m.short_code, m.status, m.started_at, m.ended_at,
                b.pickup_address, b.total_aed, b.total_eur
           FROM missions m
           JOIN mission_crew mc ON mc.mission_id = m.id
           LEFT JOIN lite_bookings b ON b.id = m.booking_id
          WHERE mc.agent_id = $1
          ORDER BY m.started_at DESC LIMIT 5`,
        [userId],
      ),
      this.db.qOne<{lat: number; lng: number; recorded_at: string}>(
        `SELECT COALESCE(m.current_lat,  a.last_lat)  AS lat,
                COALESCE(m.current_lng,  a.last_lng)  AS lng,
                COALESCE(m.ended_at, m.started_at, a.last_location_at) AS recorded_at
           FROM agents a
           LEFT JOIN (
             SELECT mc.agent_id, m.current_lat, m.current_lng, m.ended_at, m.started_at
               FROM missions m
               JOIN mission_crew mc ON mc.mission_id = m.id
              WHERE mc.agent_id = $1 AND m.current_lat IS NOT NULL
              ORDER BY m.started_at DESC LIMIT 1
           ) m ON TRUE
          WHERE a.user_id = $1
            AND (m.current_lat IS NOT NULL OR a.last_lat IS NOT NULL)`,
        [userId],
      ),
    ]);
    return {activeMission: activeMission ?? null, recentMissions, lastLocation: lastLocation ?? null};
  }

  async terminateAgent(userId: string, admin: AdminContext, notes?: string) {
    await this.db.q(
      `UPDATE agents SET status = 'REJECTED', on_duty = FALSE WHERE user_id = $1`,
      [userId],
    );
    await this.audit.recordAdmin(admin, 'agent.terminate', 'agent', userId, {notes});
    await this.audit.emit({
      kind: 'agent.terminate', severity: 'err', actor: admin.call_sign, subject: userId.slice(0, 8),
      message: `${admin.call_sign} terminated agent ${userId.slice(0, 8)}`,
      metadata: {user_id: userId},
    });
    // RS-04 — drop the terminated agent back to 'individual' so the role can't
    // outlive the agent record (the agents row is now REJECTED above).
    await this.revertRoleOnAgentExit(userId, admin, 'agent_terminated');
    return {ok: true};
  }

  /**
   * RS-04/RS-11 — when an agent identity is terminated or rejected, drop the
   * user back to the plain 'individual' role so a sticky agent/service_provider
   * role can't outlive the agent record. Belt-and-braces guard: only revert when
   * the user has NO remaining active identity that legitimately needs a
   * non-client role —
   *   • an active `agents` row (APPROVED/ACTIVE) — normally none once this one is
   *     REJECTED, kept for future-proofing;
   *   • an active MANAGER org membership (a manager still runs an org);
   *   • active org OWNERSHIP (org_members.org_user_id = user, status='active') —
   *     a service_provider still owning a live CPO roster must keep provider
   *     access or the whole agency is orphaned (audit RS-04 / R-1 hazard).
   * A plain 'cpo' membership does NOT block the revert. On a real revert we also
   * revoke the user's sessions (AuthService.revokeAllUserSessions — the DC-04
   * mechanism) so the stale-role JWT + mobile shell die instead of lingering for
   * the access token's <=15-min TTL.
   */
  private async revertRoleOnAgentExit(userId: string, admin: AdminContext, reason: string): Promise<void> {
    const reverted = await this.db.qOne<{from_role: string}>(
      `WITH prev AS (SELECT id, role AS from_role FROM public.users WHERE id = $1)
       UPDATE public.users u
          SET role = 'individual', updated_at = NOW()
         FROM prev
        WHERE u.id = prev.id
          AND u.role <> 'individual'
          AND NOT EXISTS (
            SELECT 1 FROM agents a
             WHERE a.user_id = $1 AND a.status IN ('APPROVED','ACTIVE')
          )
          AND NOT EXISTS (
            SELECT 1 FROM org_members om
             WHERE om.member_user_id = $1 AND om.status = 'active' AND om.member_role = 'manager'
          )
          AND NOT EXISTS (
            SELECT 1 FROM org_members owns
             WHERE owns.org_user_id = $1 AND owns.status = 'active'
          )
        RETURNING prev.from_role`,
      [userId],
    );
    // OP-06 — the agents row is already REJECTED and the role may have moved;
    // both feed ACCOUNT_KIND_SQL, and the 30 s acct-gate was never busted here.
    await bustAccountGate(this.redis, userId);
    if (!reverted) return;
    await this.audit.recordAdmin(admin, 'user.role.change', 'user', userId, {
      from: reverted.from_role, to: 'individual', reason,
    });
    // Best-effort: DI always provides AuthService in prod (OpsModule imports
    // AuthModule); it is @Optional only so positional unit specs keep working.
    await this.auth?.revokeAllUserSessions(userId);
  }

  // ─── Booking dispatch (manual CPO + vehicle assignment) ───────────

  async listAvailableCpos(region: string) {
    return this.cpoAssign.listAvailable(region);
  }

  async listAvailableVehicles(region: string) {
    return this.vehicles.listAvailable(region);
  }

  /** Applications for a booking's job, joined with agent display info. */
  async listBookingApplicants(bookingId: string) {
    const job = await this.db.qOne<{id: string; cpo_slots: number; status: string}>(
      `SELECT id, cpo_slots, status FROM jobs WHERE booking_id = $1`,
      [bookingId],
    );
    if (!job) return {job: null, applicants: []};

    const applicants = await this.db.q<{
      id: string; agent_id: string; status: string; applied_at: string;
      agent_call_sign: string; display_name: string | null; rating: string | null;
      jobs_total: number; tier: number;
      dress_pledge: string | null; dress_pledged_at: string | null;
    }>(
      `SELECT a.id, a.agent_id, a.status, a.applied_at, a.agent_call_sign,
              a.dress_pledge, a.dress_pledged_at,
              ag.display_name, ag.rating, ag.jobs_total, ag.tier
         FROM job_applications a
         JOIN agents ag ON ag.user_id = a.agent_id
        WHERE a.job_id = $1
        ORDER BY (a.status = 'ASSIGNED') DESC, a.applied_at ASC`,
      [job.id],
    );
    return {job, applicants};
  }

  /**
   * Manual dispatch: ops picks N applications + a vehicle for a CONFIRMED
   * booking. Selected applications flip to ASSIGNED, others to REJECTED.
   * Each picked agent is locked into the booking via cpo_pool (agents are
   * mirrored 1:1 into cpo_pool by `mirrorAgentToPool`). The booking
   * transitions CONFIRMED → LIVE and the job goes DISPATCHED.
   */
  async dispatchBooking(
    bookingId: string,
    admin: AdminContext,
    body: {
      applicationIds: string[];
      vehicleId?: string;
      dressInstructions?: string | null;
      leadAgentId?: string | null;
    },
  ): Promise<{ok: true; status: 'LIVE'; conversation_id: string | null; mission_id: string}> {
    // Audit fix 1.1 / #8 — verify booking is dispatchable (lock + read)
    // but DO NOT transition to LIVE here. The mission insert + crew seed
    // below are what actually create the durable dispatch state; flipping
    // the booking before they succeed leaves the booking at LIVE with no
    // mission row on a downstream failure (messenger-service down, route
    // precompute throwing, etc.) — that requires manual recovery.
    //
    // New ordering: txn 1 (here) locks the row and confirms CONFIRMED;
    // txn 2 (after mission insert) flips CONFIRMED → LIVE conditionally.
    // Concurrency is still safe because:
    //   • The mission_crew partial unique index `agent_id WHERE status <>
    //     'off'` fails the second dispatcher's INSERT.
    //   • The `missions.booking_id` unique index makes the second
    //     dispatcher's mission INSERT either succeed (then ON CONFLICT-
    //     resolve to the existing row) or collide on a fresh short_code.
    //   • The final CONFIRMED → LIVE UPDATE is conditional on status =
    //     'CONFIRMED', so the second dispatcher gets zero rows and bails.
    const row = await this.db.withTransaction(async tx => {
      const r = await tx.qOne<{status: string; cpo_count: number; region_code: string; driver_only: boolean; vehicle_count: number; service: string; client_id: string}>(
        `SELECT status, cpo_count, region_code, driver_only, vehicle_count, service, client_id FROM lite_bookings WHERE id = $1 FOR UPDATE`,
        [bookingId],
      );
      if (!r) throw new NotFoundException('Booking not found');
      // Audit fix 1.5 — region-scope dispatchers too. The downstream
      // mission row is created from this booking, so the same isolation
      // rule applies: a region-scoped admin can't push a UAE booking
      // through if they're a Saudi handler.
      assertRegionScope(admin, r.region_code);
      if (r.status !== 'CONFIRMED') {
        throw new BadRequestException(`Cannot dispatch booking in state ${r.status}`);
      }
      return r;
    });
    if (!Array.isArray(body.applicationIds) || body.applicationIds.length === 0) {
      throw new BadRequestException('no_applicants_selected');
    }
    if (body.applicationIds.length !== row.cpo_count) {
      throw new BadRequestException(
        `Booking requires ${row.cpo_count} agent(s), received ${body.applicationIds.length}`,
      );
    }
    // Driver-only (client vehicle): Bravo assigns a security driver but no
    // Bravo vehicle, so a vehicle pick is neither required nor allowed.
    // Executive Protection protection-only details (vehicle_count 0, no driver) likewise
    // have nothing to drive — requiring a vehicle would force ops to lock a
    // pool vehicle the pricing never charged for.
    const needsVehicle = !row.driver_only && Number(row.vehicle_count ?? 1) > 0;
    if (needsVehicle && !body.vehicleId) {
      throw new BadRequestException('no_vehicle_selected');
    }
    if (!needsVehicle && body.vehicleId) {
      throw new BadRequestException(
        row.driver_only ? 'driver_only_no_vehicle' : 'no_vehicle_needed',
      );
    }

    // Verify the applications belong to THIS booking's job and are still pickable.
    const job = await this.db.qOne<{id: string}>(
      `SELECT id FROM jobs WHERE booking_id = $1`,
      [bookingId],
    );
    if (!job) throw new BadRequestException('booking_has_no_job');

    // CA-01 — load in the operator's PICK ORDER (array_position), so the
    // agentIds[0] lead fallback below matches the first-picked applicant
    // instead of whatever order Postgres returned rows in.
    const apps = await this.db.q<{id: string; agent_id: string; status: string; job_id: string}>(
      `SELECT id, agent_id, status, job_id
         FROM job_applications
        WHERE id = ANY($1::uuid[])
        ORDER BY array_position($1::uuid[], id)`,
      [body.applicationIds],
    );
    if (apps.length !== body.applicationIds.length) {
      throw new BadRequestException('application_not_found');
    }
    if (apps.some(a => a.job_id !== job.id)) {
      throw new BadRequestException('application_belongs_to_other_job');
    }
    if (apps.some(a => a.status !== 'PENDING' && a.status !== 'SHORTLISTED')) {
      throw new BadRequestException('application_already_decided');
    }

    const agentIds = apps.map(a => a.agent_id);
    // Validate the leadAgentId (if provided) belongs to the picked set.
    // Default lead = first picked agent.
    const leadAgentId = body.leadAgentId && agentIds.includes(body.leadAgentId)
      ? body.leadAgentId
      : agentIds[0];
    if (body.leadAgentId && !agentIds.includes(body.leadAgentId)) {
      throw new BadRequestException('lead_must_be_one_of_picked_agents');
    }

    // P1-16 — wrap every internal DB write in a single Tx so a failure
    // halfway through doesn't leave cpo_pool flagged 'on_mission' with
    // no mission row, vehicle locked but no booking_vehicle_assignments,
    // applications flipped ASSIGNED but no jobs.status update, etc.
    //
    // Side effects that hit external services (mission group create on
    // ConversationsService, comms_channel_id link, final LIVE flip,
    // audit emit, push fan-out) intentionally stay outside the Tx —
    // they're best-effort and should not block-roll back the dispatch
    // if e.g. messenger-service is briefly unreachable.
    //
    // The Mapbox call also stays outside the Tx (expensive HTTP) but
    // its UPDATE on missions.route_* sneaks back in afterwards.
    const dressTrim = body.dressInstructions?.trim() || null;
    const txOut = await this.db.withTransaction(async tx => {
      // Lock CPOs (via cpo_pool, where each agent's user_id is mirrored
      // as cpo_pool.id) and the chosen vehicle. Both helpers now accept
      // the active Tx so the row locks survive across the whole method.
      await this.cpoAssign.assignSpecific(bookingId, agentIds, tx);
      // Driver-only bookings have no Bravo vehicle to lock (client supplies it).
      // For all other bookings vehicleId is guaranteed by the guard above.
      if (!row.driver_only && body.vehicleId) {
        await this.vehicles.assignSpecific(bookingId, body.vehicleId, tx);
      }

      // Mark picked applications ASSIGNED, the rest of the open ones REJECTED.
      await tx.q(
        `UPDATE job_applications
            SET status = 'ASSIGNED', decided_at = now(), decided_by = $2
          WHERE id = ANY($1::uuid[])`,
        [body.applicationIds, admin.user_id],
      );
      await tx.q(
        `UPDATE job_applications
            SET status = 'REJECTED', decided_at = now(), decided_by = $2
          WHERE job_id = $1
            AND status IN ('PENDING','SHORTLISTED')
            AND id <> ALL($3::uuid[])`,
        [job.id, admin.user_id, body.applicationIds],
      );
      await tx.q(
        `UPDATE jobs SET status = 'DISPATCHED', slots_filled = $2 WHERE id = $1`,
        [job.id, agentIds.length],
      );

      // Stamp the dress brief (if supplied) ahead of the LIVE transition.
      // The status flip happens at the bottom of the method, once the
      // mission row and crew rows have been written successfully.
      if (dressTrim) {
        await tx.q(
          `UPDATE lite_bookings SET dress_instructions = $2 WHERE id = $1`,
          [bookingId, dressTrim],
        );
      }

      // Create the mission row + crew + waypoints + per-mission deployment
      // checks. Idempotent on the (booking_id) unique index — re-running
      // an already-dispatched booking returns the existing mission.
      const existingMission = await tx.qOne<{id: string; short_code: string}>(
        // LM-B1: an ABORTED history row is not "already dispatched".
        `SELECT id, short_code FROM missions WHERE booking_id = $1 AND status <> 'ABORTED'`,
        [bookingId],
      );
      let missionId: string;
      let missionShort: string;
      if (existingMission) {
        missionId = existingMission.id;
        missionShort = existingMission.short_code;
      } else {
        // Mission short code mirrors the booking ID suffix so ops can match
        // a booking ending in `…5446C42D8CFF` to mission `MSN-5446C42D8CFF`
        // at a glance — no sequential lookup needed.
        missionShort = `MSN-${bookingId.replace(/-/g, '').slice(-12).toUpperCase()}`;
        const veh = await tx.qOne<{
          make_model: string | null; plate: string | null; armor_grade: string | null;
        }>(
          `SELECT make_model, plate, armor_grade FROM vehicle_pool WHERE id = $1`,
          [body.vehicleId],
        );
        const inserted = await tx.qOne<{id: string}>(
          // Ops "instant deploy" skips CREWED/DISPATCHED by design (the operator IS
          // the dispatcher); stamp dispatched_at so the row never reads "not sent".
          `INSERT INTO missions (booking_id, status, short_code,
                                 vehicle_model, vehicle_plate, vehicle_armour, dispatched_at)
           VALUES ($1, 'LIVE', $2, $3, $4, $5, NOW())
           RETURNING id`,
          [bookingId, missionShort, veh?.make_model ?? null, veh?.plate ?? null, veh?.armor_grade ?? null],
        );
        if (!inserted) throw new BadRequestException('Failed to create mission');
        missionId = inserted.id;

        // Attach crew (call_sign read from cpo_pool). The chosen lead gets
        // is_lead=true and role=LEAD; everyone else is CP.
        const crew = await tx.q<{id: string; call_sign: string}>(
          `SELECT id, call_sign FROM cpo_pool WHERE id = ANY($1::uuid[])`,
          [agentIds],
        );
        const crewByAgent = new Map(crew.map(c => [c.id, c.call_sign]));
        // Audit fix 1.2 — restrict ON CONFLICT to the (mission_id, agent_id)
        // primary key only. The partial unique index `agent_id WHERE
        // status <> 'off'` prevents an agent from being active on two
        // missions simultaneously — that violation MUST surface (not be
        // silently dropped) so dispatch fails fast with a clear error.
        //
        // 50k audit P1-13 — one unnest INSERT for the whole crew. Batching
        // loses the per-row 23505 attribution, so the offending agent id is
        // recovered by an explicit pre-check inside the same transaction (a
        // concurrent dispatch between the check and the insert still surfaces
        // as a 23505, now without the id — the invariant itself is intact).
        const busy = await tx.q<{agent_id: string}>(
          `SELECT agent_id FROM mission_crew
            WHERE agent_id = ANY($1::uuid[]) AND status <> 'off'`,
          [agentIds],
        );
        if (busy.length > 0) {
          throw new BadRequestException(`agent_already_assigned:${busy[0].agent_id}`);
        }
        await tx.q(
          `INSERT INTO mission_crew (mission_id, agent_id, slot, role, call_sign, is_lead, team_idx)
           SELECT $1, t.agent_id, t.slot, t.role, t.call_sign, t.is_lead, 0
             FROM unnest($2::uuid[], $3::int[], $4::text[], $5::text[], $6::bool[])
                  AS t(agent_id, slot, role, call_sign, is_lead)
           ON CONFLICT (mission_id, agent_id) DO NOTHING`,
          [
            missionId,
            agentIds,
            agentIds.map((_, i) => i),
            agentIds.map(id => (id === leadAgentId ? 'LEAD' : 'CP')),
            agentIds.map((id, i) => crewByAgent.get(id) ?? `CPO-${i + 1}`),
            agentIds.map(id => id === leadAgentId),
          ],
        );

        // Seed default waypoints — shared constant, see mission-defaults.ts.
        // Executive Protection missions carry hourly check-ins instead of a waypoint
        // timeline, so they seed none.
        if (row.service !== 'executive_protection') {
          await tx.q(
            `INSERT INTO mission_waypoints (mission_id, seq, tag, event)
             SELECT $1, t.seq, t.tag, t.event
               FROM unnest($2::int[], $3::text[], $4::text[]) AS t(seq, tag, event)
             ON CONFLICT DO NOTHING`,
            [
              missionId,
              DEFAULT_MISSION_WAYPOINTS.map(w => w.seq),
              DEFAULT_MISSION_WAYPOINTS.map(w => w.tag),
              DEFAULT_MISSION_WAYPOINTS.map(w => w.event),
            ],
          );
        }

        // Seed per-mission deployment checks. Only for agentIds that have a
        // matching agents row — seeded pool CPOs (without an agents row) skip.
        await tx.q(
          `INSERT INTO agent_deployment_checks (user_id, check_key, state, mission_id)
           SELECT a.user_id, c.k, 'pending', $1
             FROM agents a
            CROSS JOIN unnest($3::text[]) AS c(k)
            WHERE a.user_id = ANY($2::uuid[])
           ON CONFLICT DO NOTHING`,
          [missionId, agentIds, ['dress', 'vehicle', 'equip', 'briefing']],
        );
      }
      return {missionId, missionShort, isFreshMission: !existingMission};
    });
    const missionId = txOut.missionId;
    const missionShort = txOut.missionShort;

    // Mapbox route precompute — outside the Tx (HTTP cost) but still
    // best-effort. Failure logs and continues; the lead app will compute
    // distance client-side from the stored coords. Only attempted on
    // freshly-created missions.
    if (txOut.isFreshMission) {
      const coords = await this.db.qOne<{
        pickup_lat: string | null; pickup_lng: string | null;
        dropoff_lat: string | null; dropoff_lng: string | null;
      }>(
        `SELECT pickup_lat, pickup_lng, dropoff_lat, dropoff_lng
           FROM lite_bookings WHERE id = $1`,
        [bookingId],
      );
      if (coords?.pickup_lat && coords.pickup_lng && coords.dropoff_lat && coords.dropoff_lng) {
        try {
          const route = await this.mapbox.getRoute(
            {lat: Number(coords.pickup_lat),  lng: Number(coords.pickup_lng)},
            {lat: Number(coords.dropoff_lat), lng: Number(coords.dropoff_lng)},
          );
          await this.db.q(
            `UPDATE missions
                SET route_distance_m = $2, route_duration_s = $3, route_polyline = $4
              WHERE id = $1`,
            [missionId, route.distance_m, route.duration_s, route.polyline],
          );
        } catch (e) {
          this.log.warn(`Route precompute failed for ${missionId}: ${(e as Error).message}`);
        }
      }
    }

    // Create the mission group — ops admin + assigned CPOs ONLY. The
    // client is intentionally excluded; principal updates flow through
    // the system message channel, not this operational room. Drops off
    // every CPO's chat list when ops completes the mission; ops keeps it
    // for audit (per-member dissolve in completeBooking).
    // Best-effort — failure logs but doesn't block dispatch.
    let conversationId: string | null = null;
    try {
      const existing = await this.db.qOne<{conversation_id: string | null}>(
        `SELECT conversation_id FROM lite_bookings WHERE id = $1`, [bookingId],
      );
      if (existing?.conversation_id) {
        conversationId = existing.conversation_id;
      } else {
        const code = bookingId.replace(/-/g, '').slice(-8).toUpperCase();
        const members = Array.from(new Set([...agentIds, admin.user_id]));
        const conv = await this.conversations.create(
          admin.user_id,
          'group',
          members,
          `Mission BS-${code}`,
        );
        conversationId = conv.id;
        await this.db.q(
          `UPDATE lite_bookings SET conversation_id = $1 WHERE id = $2`,
          [conversationId, bookingId],
        );
      }
    } catch (e) {
      this.log.warn(`Mission group create failed for ${bookingId}: ${(e as Error).message}`);
    }

    // Wire the conversation into the mission row so the mission detail page
    // can surface the Ops Room channel.
    if (conversationId) {
      await this.db.q(
        `UPDATE missions SET comms_channel_id = $1 WHERE id = $2`,
        [conversationId, missionId],
      );
    }

    // Audit fix #8 — final state flip. Mission row + crew + waypoints
    // were written above; only now do we transition the booking to LIVE.
    // Conditional UPDATE protects against a concurrent dispatcher that
    // raced past the initial CONFIRMED check (the partial unique index
    // on mission_crew should have already blown up such a racer, but
    // belt-and-braces — a zero-row UPDATE means someone else already
    // moved the booking, so we re-read and tolerate the LIVE state).
    const transitioned = await this.db.q<{id: string}>(
      `UPDATE lite_bookings
          SET status = 'LIVE'
        WHERE id = $1 AND status = 'CONFIRMED'
        RETURNING id`,
      [bookingId],
    );
    if (transitioned.length === 0) {
      const current = await this.db.qOne<{status: string}>(
        `SELECT status FROM lite_bookings WHERE id = $1`, [bookingId],
      );
      if (current?.status !== 'LIVE') {
        // We wrote a mission row but the booking is not LIVE — surface a
        // hard error so ops sees it. The mission row remains and is
        // recoverable via the `existingMission` branch on a re-dispatch.
        this.log.error(
          `dispatch_inconsistent_state booking=${bookingId} mission=${missionId} ` +
          `booking_status=${current?.status ?? 'missing'}`,
        );
        throw new BadRequestException('booking_state_changed_concurrently');
      }
    }

    await this.audit.recordAdmin(admin, 'booking.dispatch', 'booking', bookingId, {
      mission_id: missionId, mission_short: missionShort,
      applicationIds: body.applicationIds, agentIds, vehicleId: body.vehicleId, conversationId,
    });
    await this.audit.emit({
      kind: 'booking.dispatch', severity: 'info',
      actor: admin.call_sign, subject: bookingId.slice(0, 8),
      message: `${admin.call_sign} dispatched booking ${bookingId.slice(0, 8)} with ${agentIds.length} agent(s)`,
      metadata: {booking_id: bookingId, mission_id: missionId},
    });
    // Wake each dispatched agent's phone. Before this push existed,
    // agents only learned of dispatch via the 8s `getActiveMission` poll
    // on `AgentDashboardScreen` — backgrounded devices missed dispatches
    // entirely. Fire-and-forget; the in-app poll is the fallback.
    for (const agentId of agentIds) {
      void this.bookingPush.missionDispatched(agentId, missionId, bookingId);
    }
    // E2E-41 — this path pushed the AGENTS only; the principal learned a crew
    // existed on their next 5 s poll. The agency path already wakes the client
    // here (`org-mission.service.ts` crewAssigned) — same bridge, same kind, so
    // an ops-dispatched booking and an agency-dispatched one are indistinguishable
    // to the client app.
    if (row.client_id) {
      void this.bookingPush.crewAssigned(row.client_id, bookingId);
    }
    return {ok: true, status: 'LIVE', conversation_id: conversationId, mission_id: missionId};
  }

  /**
   * Ops closes a LIVE mission. Pays out the escrowed booking total to the
   * assigned CPOs (even split, integer credits — remainder rounded into
   * the platform), releases the CPOs and vehicle back to the pool, deletes
   * the messenger group (FK cascades to members + envelopes — same end
   * result as disappearing messages, just instant), and transitions the
   * booking to COMPLETED.
   */
  /**
   * Compute the proposed payout breakdown for a LIVE booking — even split
   * floor across assigned CPOs, remainder rounded to the platform fee.
   * Used by the ops payout-review modal as the default before any manual
   * deductions are applied.
   */
  async getProposedPayouts(bookingId: string): Promise<{
    booking_id: string;
    escrow_credits: number;
    cpo_count: number;
    even_split: number;
    platform_remainder: number;
    proposed: Array<{user_id: string; call_sign: string; display_name: string; proposed_credits: number}>;
  }> {
    const row = await this.db.qOne<{status: string; total_eur: string}>(
      `SELECT status, total_eur FROM lite_bookings WHERE id = $1`, [bookingId],
    );
    if (!row) throw new NotFoundException('Booking not found');
    const cpos = await this.cpoAssign.getForBooking(bookingId);
    const escrow = Math.round(Number(row.total_eur));
    const evenSplit = cpos.length > 0 ? Math.floor(escrow / cpos.length) : 0;
    const remainder = escrow - evenSplit * cpos.length;
    return {
      booking_id: bookingId,
      escrow_credits: escrow,
      cpo_count: cpos.length,
      even_split: evenSplit,
      platform_remainder: remainder,
      proposed: cpos.map(c => ({
        user_id: c.id,
        call_sign: c.call_sign,
        display_name: c.display_name,
        proposed_credits: evenSplit,
      })),
    };
  }

  async completeBooking(
    bookingId: string,
    admin: AdminContext,
    body?: {
      payouts?: Array<{
        user_id: string;
        credits: number;
        deduction_reason?: string | null;
      }>;
    },
  ): Promise<{
    ok: true; status: 'COMPLETED';
    payouts: Array<{user_id: string; credits: number; deduction_reason: string | null}>;
    platform_fee: number;
    group_purged: boolean;
  }> {
    // Audit fix 1.1 — atomic state pin. completeBooking is the most
    // expensive flow (wallet credit + payouts + group dissolve), so a
    // double-write would mean the CPOs get paid twice. The conditional
    // UPDATE here transitions LIVE → COMPLETED in one shot — the loser
    // of a race sees zero updated rows and we throw before touching
    // the wallet at all.
    const row = await this.db.withTransaction(async tx => {
      const r = await tx.qOne<{
        status: string; total_eur: string; conversation_id: string | null; region_code: string;
        assigned_provider_user_id: string | null;
      }>(
        `SELECT status, total_eur, conversation_id, region_code, assigned_provider_user_id
           FROM lite_bookings WHERE id = $1 FOR UPDATE`,
        [bookingId],
      );
      if (!r) throw new NotFoundException('Booking not found');
      // Audit H3 — region isolation. completeBooking disburses real
      // wallet credits; a region-scoped OPS/SUPERVISOR must not be able to
      // settle (and pay out) a booking outside their region.
      assertRegionScope(admin, r.region_code);
      // LM-V4 — accept CONFIRMED too (FSM: CONFIRMED→COMPLETED by OPS_HANDLER). An
      // auto booking can sit CONFIRMED while its mission ran/stalled; LIVE-only made
      // ops unable to force-complete exactly the stuck bookings it needed to rescue.
      if (r.status !== 'LIVE' && r.status !== 'CONFIRMED') {
        throw new BadRequestException(`Cannot complete booking in state ${r.status}`);
      }
      const upd = await tx.q(
        `UPDATE lite_bookings SET status = 'COMPLETED'
          WHERE id = $1 AND status IN ('LIVE','CONFIRMED') RETURNING id`,
        [bookingId],
      );
      if (upd.length === 0) {
        throw new BadRequestException('booking_state_changed_concurrently');
      }
      // LM-V6 — ops completion in the booking timeline. Fail-closed: an in-txn
      // statement failure aborts the txn anyway, so never swallow it here.
      await tx.q(
        `INSERT INTO lite_booking_audit (booking_id, from_status, to_status, actor_id, actor_role, metadata)
         VALUES ($1, $2, 'COMPLETED', $3, 'OPS_HANDLER', $4::jsonb)`,
        [bookingId, r.status, admin.user_id, JSON.stringify({reason: 'ops_complete'})],
      );
      return r;
    });

    // Step 10/11 — escrow-aware completion (kills the cut-over double-pay hazard). An
    // AUTO-dispatch booking carries an escrow hold; the legacy even-split below mints
    // CPO credits straight from total_eur and would pay the agency a SECOND time. Route
    // it instead through the shared SettlementService — admin force-releases the hold to
    // the AGENCY (escrow → provider + platform fee; the agency settles its own CPOs).
    // D1: admin is the exception path. A LEGACY booking (no hold) falls through unchanged.
    const escrowHold = await this.db.qOne<{provider_user_id: string | null}>(
      `SELECT provider_user_id FROM escrow_holds WHERE booking_id = $1`,
      [bookingId],
    );
    if (escrowHold) {
      const settled = await this.db.withTransaction(async tx => {
        const r = await this.settlement.settleEscrowRelease(
          tx, bookingId,
          {kind: 'admin', userId: admin.user_id, callSign: admin.call_sign},
          {force: true},
        );
        // Fail-closed audit INSIDE the settle txn — booking.complete is a critical action,
        // so a failed audit insert throws and rolls the escrow release back.
        await this.audit.recordAdmin(admin, 'booking.complete', 'booking', bookingId, {
          escrow: true, to_provider: r.toProvider, platform_fee: r.platformFee,
        });
        return r;
      });
      await this.audit.emit({
        kind: 'booking.complete', severity: 'ok', actor: admin.call_sign, subject: bookingId.slice(0, 8),
        message: `${admin.call_sign} released escrow for booking ${bookingId.slice(0, 8)} → agency (+${settled.toProvider} BC)`,
        metadata: {booking_id: bookingId},
      });
      // LM-N4 — wake the agency about its payout + the client about completion.
      if (settled.released && escrowHold.provider_user_id) {
        void this.bookingPush.payoutSettled(escrowHold.provider_user_id, bookingId, settled.toProvider)
          .catch(() => undefined);
      }
      const owner = await this.db.qOne<{client_id: string}>(
        `SELECT client_id FROM lite_bookings WHERE id = $1`, [bookingId],
      );
      if (owner) {
        void this.bookingPush.bookingCompleted(owner.client_id, bookingId).catch(() => undefined);
      }
      return {
        ok: true, status: 'COMPLETED',
        payouts: settled.toProvider > 0 && escrowHold.provider_user_id
          ? [{user_id: escrowHold.provider_user_id, credits: settled.toProvider, deduction_reason: null}]
          : [],
        platform_fee: settled.platformFee,
        group_purged: true,
      };
    }

    // Phase 2 — org-as-payee. The deployed OFFICERS are mission_crew (real
    // users); each resolves to a PAYEE (their applicant org, or themselves for
    // legacy self-CPOs). Ops still picks per-OFFICER amounts; the money lands
    // on the officer's org wallet. Fallback to the legacy cpo_pool roster only
    // when there's no crew row (old bookings dispatched via the pool path).
    const crew = await this.cpoAssign.getCrewForPayout(bookingId);
    const cpos = crew.length > 0
      ? crew.map(c => ({id: c.user_id, call_sign: c.call_sign ?? ''}))
      : (await this.cpoAssign.getForBooking(bookingId)).map(c => ({id: c.id, call_sign: c.call_sign}));
    const escrow = Math.round(Number(row.total_eur));
    const evenSplit = cpos.length > 0 ? Math.floor(escrow / cpos.length) : 0;

    // Per-OFFICER overrides (keyed by mission_crew user_id, per the product
    // decision "key by officer, credit the org").
    const overrideMap = new Map<string, {credits: number; deduction_reason: string | null}>();
    if (body?.payouts && body.payouts.length > 0) {
      const validIds = new Set(cpos.map(c => c.id));
      for (const p of body.payouts) {
        if (!validIds.has(p.user_id)) {
          throw new BadRequestException(`payout_user_not_assigned:${p.user_id}`);
        }
        if (!Number.isInteger(p.credits) || p.credits < 0 || p.credits > evenSplit) {
          throw new BadRequestException(`payout_credits_out_of_range:${p.user_id}`);
        }
        const deducted = evenSplit - p.credits;
        if (deducted > 0 && !p.deduction_reason?.trim()) {
          throw new BadRequestException(`deduction_reason_required:${p.user_id}`);
        }
        overrideMap.set(p.user_id, {
          credits: p.credits,
          deduction_reason: deducted > 0 ? (p.deduction_reason ?? '').trim() : null,
        });
      }
    }

    const mission = await this.db.qOne<{id: string; short_code: string; started_at: string | null}>(
      `SELECT id, short_code, started_at FROM missions WHERE booking_id = $1
        ORDER BY (status <> 'ABORTED') DESC, created_at DESC LIMIT 1`, [bookingId],
    );

    // Mission short code (MSN-XXXXXXXX) is what the ops console + agent
    // mobile both display, so the wallet ledger entry should match. Falls
    // back to the booking-id slice when there's no mission row (legacy
    // bookings that completed before missions were stamped).
    const missionRef = mission?.short_code ?? `BL-${bookingId.replace(/-/g, '').slice(-8).toUpperCase()}`;

    // Resolve each officer → payee, then AGGREGATE by payee before crediting.
    // creditForBooking is idempotent on (user_id, booking_id), so two officers
    // sharing one org payee MUST be credited as a single summed transaction or
    // the second credit is silently dropped and the org is underpaid.
    const perOfficer = await Promise.all(cpos.map(async c => {
      const override = overrideMap.get(c.id);
      const credits = override?.credits ?? evenSplit;
      return {
        officerId: c.id,
        call_sign: c.call_sign,
        credits,
        deductionReason: override?.deduction_reason ?? null,
        deductionCredits: evenSplit - credits,
        payeeId: await this.cpoAssign.resolvePayeeUserId(bookingId, c.id),
      };
    }));
    const payeeTotals = new Map<string, number>();
    for (const o of perOfficer) {
      if (o.credits > 0) payeeTotals.set(o.payeeId, (payeeTotals.get(o.payeeId) ?? 0) + o.credits);
    }

    const payouts: Array<{user_id: string; credits: number; deduction_reason: string | null}> = [];
    let totalPaid = 0;
    if (cpos.length > 0 && escrow > 0) {
      // 1) One summed wallet credit per payee (org wallet for managed CPOs).
      for (const [payeeId, sum] of payeeTotals) {
        try {
          await this.wallet.creditForBooking(
            payeeId, bookingId, sum, `Mission payout · ${missionRef}`,
          );
        } catch (e) {
          this.log.warn(`Payout credit failed for payee ${payeeId} on ${bookingId}: ${(e as Error).message}`);
        }
      }
      // 2) Per-officer audit row + officer push (the officer did the work even
      //    though the org banked the credit). agent_user_id = officer keeps the
      //    ux_mission_payouts_unique idempotency keyed correctly.
      for (const o of perOfficer) {
        try {
          if (mission) {
            await this.db.q(
              `INSERT INTO mission_payouts
                 (mission_id, booking_id, agent_user_id, payee_user_id, call_sign,
                  proposed_credits, paid_credits, deduction_credits, deduction_reason, decided_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
               ON CONFLICT (mission_id, agent_user_id) DO NOTHING`,
              [mission.id, bookingId, o.officerId, o.payeeId, o.call_sign,
               evenSplit, o.credits, o.deductionCredits, o.deductionReason, admin.user_id],
            );
          }
          payouts.push({user_id: o.officerId, credits: o.credits, deduction_reason: o.deductionReason});
          totalPaid += o.credits;
          if (o.credits > 0) {
            void this.bookingPush.payoutSettled(o.officerId, bookingId, o.credits);
          }
        } catch (e) {
          this.log.warn(`Payout audit failed for ${o.officerId} on ${bookingId}: ${(e as Error).message}`);
        }
      }
    }
    const platformFee = escrow - totalPaid;

    // Release units back to the pool so they're pickable for the next mission.
    await Promise.allSettled([
      this.cpoAssign.release(bookingId),
      this.vehicles.release(bookingId),
    ]);

    // Dissolve the mission group on the agent side only. Ops keeps the
    // conversation, message envelopes, and their own admin membership
    // row for post-mission audit / dispute review. Agents (role='member')
    // get unlinked from conversation_members → the room drops out of their
    // listMine response on next poll, identical to ops removing them via
    // removeMember(). Title is suffixed with ' · COMPLETED' so ops's chat
    // list visually distinguishes closed missions from active ones.
    //
    // Why per-member rather than archived_at: listMine filters
    // archived rooms out for everyone, so flipping archived_at would
    // also hide it from ops. Per-member dissolution preserves the
    // ops-side view without a wider listing API change.
    let groupPurged = false;
    if (row.conversation_id) {
      try {
        await this.db.q(
          `DELETE FROM public.conversation_members
            WHERE conversation_id = $1 AND role = 'member'`,
          [row.conversation_id],
        );
        await this.db.q(
          `UPDATE public.conversations
              SET title = CASE
                            WHEN title LIKE '%· COMPLETED' THEN title
                            ELSE COALESCE(title, '') || ' · COMPLETED'
                          END
            WHERE id = $1`,
          [row.conversation_id],
        );
        groupPurged = true;
      } catch (e) {
        this.log.warn(`Group dissolve failed for ${row.conversation_id}: ${(e as Error).message}`);
      }
    }

    // Audit fix 1.1 — booking status was already transitioned LIVE →
    // COMPLETED inside the critical section above. Just close the
    // mission row alongside it. Re-running this method on an already-
    // COMPLETED booking now early-aborts at the top, so we never reach
    // here in the duplicate path.
    // Close the mission row too — without this, the live ops list keeps
    // surfacing the mission because listActive filters on m.status, not
    // b.status. ended_at lets the mission detail screen show actual close
    // time, not just the booking's updated_at.
    await this.db.q(
      // FSM-8 — exclude ABORTED history rows too. A re-dispatched booking can carry
      // ABORTED missions from earlier rounds; matching them here attempts
      // ABORTED->COMPLETED, which the mission FSM trigger rejects (a 500 on an
      // otherwise-fine completion). Only the live/terminal-COMPLETE rows should close.
      `UPDATE missions
          SET status = 'COMPLETED',
              ended_at = COALESCE(ended_at, NOW()),
              ended_by = $2
        WHERE booking_id = $1 AND status NOT IN ('COMPLETED', 'ABORTED')`,
      [bookingId, admin.user_id],
    );

    // Bump the agent-side stats so "JOBS COMPLETED" + "DUTY HOURS · MTD"
    // on the mobile dashboard reflect this completion. duty_hours uses the
    // mission's actual on-clock time when available (started_at → ended_at)
    // and falls back to the booking's pickup_time → now() span when the
    // CPO never explicitly transitioned to PICKUP. Caps at a reasonable
    // 24 h to prevent a forgotten-mission stall from inflating monthly
    // hours and skewing the per-hour rate calculation.
    if (cpos.length > 0 && payouts.length > 0) {
      const dutyHoursPerAgent = await this.computeDutyHours(bookingId, mission?.started_at ?? null);
      const paidIds = payouts.map(p => p.user_id);
      try {
        await this.db.q(
          `UPDATE agents
              SET jobs_total     = jobs_total + 1,
                  duty_hours_mtd = duty_hours_mtd + $2
            WHERE user_id = ANY($1)`,
          [paidIds, dutyHoursPerAgent],
        );
      } catch (e) {
        this.log.warn(`Stats bump failed for ${paidIds.join(',')}: ${(e as Error).message}`);
      }
    }

    // RATING-CARD (#10) — the crew bump above credits only the deployed CPO
    // officers (paidIds), never the AGENCY org user that owns the booking, so an
    // agency's `jobs_total` (its "N jobs" rating card) stayed at 0 for every
    // legacy (non-escrow) completion. Bump the provider once per completion,
    // mirroring what SettlementService already does on the escrow path. Guard
    // against double-counting a CPO who is also their own provider. Best-effort
    // like the crew bump — a failure must never roll the close back.
    if (shouldBumpAgencyJobs(row.assigned_provider_user_id, payouts.map(p => p.user_id))) {
      try {
        await this.db.q(
          `UPDATE agents SET jobs_total = jobs_total + 1 WHERE user_id = $1`,
          [row.assigned_provider_user_id],
        );
      } catch (e) {
        this.log.warn(`Agency jobs_total bump failed for ${row.assigned_provider_user_id}: ${(e as Error).message}`);
      }
    }

    // Mission summary system-broadcast — drops a card into each paid
    // agent's Bravo System DM so they see "Mission MSN-XXX completed
    // · +N BC · X km · Y min" in their messenger after the live group
    // is dissolved. Best-effort: a broadcast failure does not roll the
    // mission close back.
    if (mission && payouts.length > 0) {
      const totalDistanceM = await this.db.qOne<{route_distance_m: number | null; pickup_address: string; dropoff_address: string | null}>(
        `SELECT m.route_distance_m, b.pickup_address, b.dropoff_address
           FROM missions m JOIN lite_bookings b ON b.id = m.booking_id
          WHERE m.id = $1`,
        [mission.id],
      );
      const distKm = totalDistanceM?.route_distance_m
        ? (Number(totalDistanceM.route_distance_m) / 1000).toFixed(1)
        : null;
      for (const p of payouts) {
        try {
          const conv = await this.systemMsg.ensureSystemDirect(p.user_id);
          await this.systemMsg.broadcast({
            conversationId: conv,
            kind:           'mission_complete',
            severity:       'ok',
            title:          `Mission ${missionRef} completed`,
            body:           [
              `Payout · +${p.credits} BC`,
              distKm ? `Distance · ${distKm} km` : null,
              totalDistanceM?.pickup_address && totalDistanceM?.dropoff_address
                ? `${totalDistanceM.pickup_address.split(',')[0]} → ${totalDistanceM.dropoff_address.split(',')[0]}`
                : null,
              p.deduction_reason ? `Deducted reason · ${p.deduction_reason}` : null,
            ].filter(Boolean).join(' · '),
            subject_type: 'mission',
            subject_id:   mission.id,
            payload: {
              mission_short_code: mission.short_code,
              booking_id:         bookingId,
              credits:            p.credits,
              distance_m:         totalDistanceM?.route_distance_m ?? null,
            },
          });
        } catch (e) {
          this.log.warn(`Mission summary broadcast failed for ${p.user_id}: ${(e as Error).message}`);
        }
      }
    }

    await this.audit.recordAdmin(admin, 'booking.complete', 'booking', bookingId, {
      payouts, platform_fee: platformFee, group_purged: groupPurged,
    });
    await this.audit.emit({
      kind: 'booking.complete', severity: 'ok',
      actor: admin.call_sign, subject: bookingId.slice(0, 8),
      message: `${admin.call_sign} closed booking ${bookingId.slice(0, 8)} · paid out ${escrow} BC across ${cpos.length} agent(s)`,
      metadata: {booking_id: bookingId},
    });

    return {ok: true, status: 'COMPLETED', payouts, platform_fee: platformFee, group_purged: groupPurged};
  }

  /**
   * Whole-hours estimate of the mission's on-duty span. Prefers the
   * mission row's own `started_at` (set when ops dispatched and the CPO
   * accepted) and uses NOW() as the end. Caps at 24 h so a forgotten
   * mission that sat in LIVE for days doesn't inflate one agent's
   * monthly hours.
   */
  private async computeDutyHours(bookingId: string, startedAt: string | null): Promise<number> {
    let from: Date | null = startedAt ? new Date(startedAt) : null;
    if (!from) {
      const fallback = await this.db.qOne<{pickup_time: string}>(
        `SELECT pickup_time FROM lite_bookings WHERE id = $1`, [bookingId],
      );
      if (fallback?.pickup_time) from = new Date(fallback.pickup_time);
    }
    if (!from) return 0;
    const ms = Date.now() - from.getTime();
    if (ms <= 0) return 0;
    return Math.min(24, Math.max(1, Math.round(ms / 3_600_000)));
  }

  /**
   * Step 11 §41 — the ONE admin-in-the-loop money point (D1). Resolve an OPEN dispute
   * with a final paired split. While the hold is DISPUTED the money is still in escrow →
   * settle it (escrow → client `to_client`, escrow → provider `to_provider`, remainder =
   * platform fee). If the hold somehow already RELEASED → clawback: refund the client and
   * debit the agency (platform covers any shortfall). Region-scoped; fail-closed audit
   * (`dispute.resolve` ∈ CRITICAL_ACTIONS rolls the whole settlement back if it can't
   * write the audit row). All inside one txn so the dispute row, the money, and the audit
   * commit together or not at all.
   */
  /**
   * Manual BC grant/deduction on a user wallet (audit F-14). Thin pass-through
   * to WalletService.adjustCredits — the ledger row's metadata (admin id +
   * reason) is the audit trail; the controller additionally records an
   * ops_audit row. Positive = grant (topup + expiry batch), negative = deduct
   * (insufficient-guarded).
   */
  async adjustWallet(
    admin: {user_id: string},
    userId: string,
    credits: number,
    reason: string,
  ): Promise<{balance: {bravo_credits: number; currency: string}; transaction_id: string}> {
    const target = await this.db.qOne<{id: string}>(
      `SELECT id FROM public.users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!target) throw new NotFoundException('user_not_found');
    const out = await this.wallet.adjustCredits(admin.user_id, userId, credits, reason);
    // OP-07 — the app used to learn of an ops grant/deduction only on the next
    // wallet screen mount. Fire-and-forget wake; the ledger is already durable.
    void this.bookingPush.walletAdjusted(userId, credits);
    return out;
  }

  async resolveDispute(
    disputeId: string,
    admin: AdminContext,
    dto: {to_client: number; to_provider: number; resolution: string},
  ): Promise<{ok: true; dispute_id: string; outcome: string; to_client: number; to_provider: number; platform_fee: number}> {
    const resolved = await this.db.withTransaction(async tx => {
      const row = await tx.qOne<{
        dispute_status: string; booking_id: string; hold_status: string;
        gross_credits: number; region_code: string;
        client_id: string; provider_user_id: string | null;
        // E2E-06 follow-up — the already-executed split of a terminal hold, plus the
        // marker that says this PARTIAL came from a lead-declared client no-show
        // rather than a cancellation (both settle on cancel_fee_pct, so `basis`
        // alone cannot tell them apart — see the 20260903110000 migration).
        no_show_at: Date | null;
        to_provider_credits: number | null;
        to_client_credits: number | null;
        platform_fee_credits: number | null;
      }>(
        `SELECT d.status AS dispute_status, d.booking_id, eh.status AS hold_status,
                eh.gross_credits, b.region_code,
                b.client_id, eh.provider_user_id,
                eh.no_show_at, eh.to_provider_credits, eh.to_client_credits,
                eh.platform_fee_credits
           FROM booking_disputes d
           JOIN escrow_holds eh ON eh.booking_id = d.booking_id
           JOIN lite_bookings b ON b.id = d.booking_id
          WHERE d.id = $1 FOR UPDATE`,
        [disputeId],
      );
      if (!row) throw new NotFoundException('Dispute not found');
      assertRegionScope(admin, row.region_code);
      if (row.dispute_status !== 'open') throw new BadRequestException('dispute_not_open');

      const gross = row.gross_credits;
      const toProvider = Math.min(gross, Math.max(0, Math.round(dto.to_provider)));
      const toClient = Math.min(gross - toProvider, Math.max(0, Math.round(dto.to_client)));
      const platformFee = gross - toProvider - toClient;

      // The ACTUAL executed split (clawback may differ from the request if the agency is
      // short / the hold's original split bounds it) — this is what we audit + return.
      let outcome: string;
      let execToClient = toClient, execToProvider = toProvider, execPlatform = platformFee;
      // CRITIC P0 — "the dispute is REJECTED, the split stands" is the most common
      // outcome of a dispute, and after the fail-closed guards it had become
      // UNRECORDABLE on both terminal branches: RELEASED with to_provider = gross
      // is a zero pull (clawed:false → 400) and PARTIAL "the fee stands" is
      // `dispute_resolve_no_change`. `resolveDispute` is the SOLE writer of
      // `booking_disputes.status`, so the row stayed open forever with no other
      // endpoint able to close it.
      //
      // The narrow path: when the requested split is EXACTLY the split already
      // executed, no money needs to move. Record the decision and stop — the
      // clawback is never called, so there is nothing to fail closed on.
      // Deliberately an equality on all three legs, not "pull === 0": a request
      // that merely happens to compute a zero pull while asking for a DIFFERENT
      // split is an operator whose intent we could not execute, and that must
      // still refuse below rather than silently record their number.
      const isTerminalHold =
        row.hold_status === 'RELEASED' || (row.hold_status === 'PARTIAL' && !!row.no_show_at);
      const affirmsExecutedSplit =
        isTerminalHold &&
        toProvider === (row.to_provider_credits ?? 0) &&
        toClient === (row.to_client_credits ?? 0) &&
        platformFee === (row.platform_fee_credits ?? 0);
      if (affirmsExecutedSplit) {
        outcome = 'NO_CHANGE';
      } else if (row.hold_status === 'DISPUTED') {
        const finalStatus = toProvider === 0 ? 'REFUNDED' : toClient === 0 ? 'RELEASED' : 'PARTIAL';
        const basis = toProvider === 0 ? 'refund' : toClient === 0 ? 'full_release' : 'partial';
        await this.wallet.settleEscrowSplit(tx, row.booking_id, {
          toProvider, toClient, basis, fromStatuses: ['DISPUTED'], finalStatus,
          reason: `Dispute ${disputeId} resolved`,
        });
        outcome = finalStatus;
      } else if (row.hold_status === 'RELEASED') {
        // Clawback: reclaim (gross − to_provider) from the agency = client refund +
        // platform share. Returns what actually moved (agency may have been short).
        const r = await this.wallet.clawbackReleasedHold(tx, row.booking_id, toClient, platformFee, `Dispute ${disputeId} clawback`);
        // Fail CLOSED — same guard, same reason as the PARTIAL branch below.
        // `clawbackReleasedHold` RETURNS `clawed:false` (it never throws) when its own
        // guards decline: an already-clawed-back hold (basis='clawback'), a hold with
        // no provider, or a zero pull. Without this check the method carried on with
        // the primitive's all-zero return, marked the dispute decided, wrote an audit
        // row stating the platform took the whole gross, and pushed the client a
        // refund notice — all while NO money had moved. A money path that lies is
        // worse than one that refuses.
        if (!r.clawed) {
          throw new BadRequestException(`dispute_resolve_clawback_declined:${row.hold_status}`);
        }
        execToClient = r.toClient; execToProvider = r.toProvider; execPlatform = gross - r.toClient - r.toProvider;
        outcome = 'CLAWBACK';
      } else if (row.hold_status === 'PARTIAL' && row.no_show_at) {
        // E2E-06 follow-up — the operator exit for a CLIENT NO-SHOW fee. The lead
        // declared the no-show at PICKUP and the hold settled terminally to PARTIAL:
        // the agency kept cancel_fee_pct, the client was refunded the rest. Disputing
        // that fee needs a way to reverse or reduce it, and this branch is the only
        // one. It is DELIBERATELY narrow — `no_show_at` is required, so a PARTIAL from
        // a mid-LIVE abort pro-rata or a post-grace cancel fee still falls through to
        // the refusal below, exactly matching the openDispute widening.
        //
        // Same machinery, same guards: `clawbackReleasedHold` is reused verbatim (its
        // `basis === 'clawback'` idempotency gate, its agency-short shortfall handling,
        // its MON-5 fee-row merge, its family-correct refund targeting). No new payout
        // path is opened — money only ever moves FROM the agency TO the client/platform.
        const heldByProvider = row.to_provider_credits ?? 0;
        const alreadyToClient = row.to_client_credits ?? 0;
        const alreadyPlatform = row.platform_fee_credits ?? 0;
        // `dto.to_*` is the FINAL split the operator wants, the same meaning as in the
        // other two branches. Paying the agency MORE than it already holds would be a
        // fresh payout out of nothing (there is no escrow left to draw on — this hold
        // is terminal), so it is refused rather than clamped.
        if (toProvider > heldByProvider) {
          throw new BadRequestException({
            code: 'dispute_resolve_cannot_increase_provider_share',
            message: 'A no-show fee can be reversed or reduced, never increased — the hold is already settled.',
            provider_credits: heldByProvider,
          });
        }
        // CRITIC P1 — a leg that has ALREADY been paid out cannot be reduced: the
        // clawback only ever adds to the client and the platform. Silently clamping
        // a reduction to 0 executed a split DIFFERENT from the one the operator
        // submitted (e.g. {to_client:500, to_provider:100} on 800/200/600 drained
        // the agency's whole 200 while the operator said it keeps 100), and an
        // operator zeroing a non-zero platform share had their intent dropped
        // entirely. Refuse both, with the numbers, instead of guessing.
        if (toClient < alreadyToClient) {
          throw new BadRequestException({
            code: 'dispute_resolve_cannot_reduce_client_refund',
            message: `The client has already been refunded ${alreadyToClient} BC on this booking; a resolution can add to that, never take it back.`,
            requested_to_client: toClient,
            already_to_client: alreadyToClient,
          });
        }
        if (platformFee < alreadyPlatform) {
          throw new BadRequestException({
            code: 'dispute_resolve_cannot_reduce_platform_share',
            message: `The platform has already retained ${alreadyPlatform} BC on this booking; a resolution cannot return it.`,
            requested_platform_fee: platformFee,
            already_platform_fee: alreadyPlatform,
          });
        }
        // Convert the requested FINAL split into the DELTA to reclaim. Passing the
        // final numbers straight through would tell the clawback to pull the whole
        // gross from an agency that only ever received cancel_fee_pct of it.
        // With both reductions refused above, neither Math.max can clamp, so these
        // deltas are exact.
        const deltaToClient = Math.max(0, toClient - alreadyToClient);
        const deltaPlatform = Math.max(0, platformFee - alreadyPlatform);
        // NEVER pull more than the agency actually received. This invariant is the
        // CALLER's to hold: inside `clawbackReleasedHold` the pull is bounded by
        // `gross`, not by `to_provider_credits`, deliberately — on a RELEASED hold
        // the agency IS meant to front the platform's original fee back, so clamping
        // in the primitive would change RELEASED semantics.
        //
        // Why the increase-guard above does not already cover it: when neither
        // Math.max clamps, the pull collapses algebraically to
        // `alreadyProvider − toProvider`, which that guard bounds. The hole opens
        // exactly when a clamp FIRES — the operator asking to give the client (or
        // the platform) LESS than they already hold. The clawback can only ever add,
        // so that leg drops to 0 while the other keeps its full un-netted value.
        // The reachable case is `to_client: 0, to_provider: 0`: the client delta
        // clamps away, the platform delta becomes the whole gross, and an agency
        // that only ever received the cancellation fee is drained for all of it with
        // the platform fronting the shortfall.
        // The bound is what the agency may still be relieved of: what it received
        // MINUS what this resolution says it keeps. `heldByProvider` alone was too
        // loose — with one leg clamped, {to_client:500, to_provider:100} pulled the
        // full 200 while the operator had said the agency keeps 100.
        //
        // With the two reduction refusals above in place this is unreachable by
        // construction (pull collapses to exactly `heldByProvider - toProvider`).
        // It is kept as the explicit statement of the invariant the wallet primitive
        // DELEGATES to its caller — inside `clawbackReleasedHold` the pull is bounded
        // by `gross`, deliberately, because on a RELEASED hold the agency is meant to
        // front the platform's original fee back. If a future change relaxes a
        // reduction rule, this is what stops the over-draw reaching the ledger.
        const pull = deltaToClient + deltaPlatform;
        if (pull > heldByProvider - toProvider) {
          throw new BadRequestException({
            code: 'dispute_resolve_pull_exceeds_provider_credits',
            message: `This resolution would reclaim ${pull} BC from an agency that received ${heldByProvider} BC and keeps ${toProvider} BC under it.`,
            pull,
            provider_credits: heldByProvider,
            provider_keeps: toProvider,
            to_client_delta: deltaToClient,
            platform_delta: deltaPlatform,
          });
        }
        if (pull === 0) {
          throw new BadRequestException('dispute_resolve_no_change');
        }
        const r = await this.wallet.clawbackReleasedHold(
          tx, row.booking_id, deltaToClient, deltaPlatform, `Dispute ${disputeId} no-show clawback`,
        );
        // Fail CLOSED. `clawbackReleasedHold` returns `clawed:false` (never throws) when
        // its own guards decline — an already-clawed-back hold, a missing provider, a
        // state it does not accept. Marking the dispute decided on a zero-move return
        // would tell the operator the money was adjusted when nothing happened.
        if (!r.clawed) {
          throw new BadRequestException(`dispute_resolve_clawback_declined:${row.hold_status}`);
        }
        execToClient = alreadyToClient + r.toClient;
        execToProvider = r.toProvider;
        execPlatform = gross - execToClient - execToProvider;
        outcome = 'CLAWBACK';
      } else {
        throw new BadRequestException(`dispute_resolve_invalid_hold_state:${row.hold_status}`);
      }

      // CRITIC P0 — a NO_CHANGE outcome is the client's claim REJECTED and the
      // executed split affirmed. It cannot be derived from the numbers (on a PARTIAL
      // the affirmed split has both legs non-zero, which the derivation below would
      // call 'resolved'), so it is stated.
      const decision = outcome === 'NO_CHANGE'
        ? 'rejected'
        : execToProvider === 0 ? 'upheld' : execToClient === 0 ? 'rejected' : 'resolved';
      await tx.q(
        `UPDATE booking_disputes
            SET status = $2, to_client_credits = $3, to_provider_credits = $4,
                decided_by = $5, decided_at = NOW()
          WHERE id = $1`,
        [disputeId, decision, execToClient, execToProvider, admin.user_id],
      );
      // Fail-closed audit — a critical action; if the audit row can't be written this
      // throws and the whole settlement (money + dispute flip) rolls back.
      await this.audit.recordAdmin(admin, 'dispute.resolve', 'booking', row.booking_id, {
        dispute_id: disputeId, outcome, to_client: execToClient, to_provider: execToProvider,
        platform_fee: execPlatform, reason: dto.resolution,
      });
      return {
        ok: true as const, dispute_id: disputeId, outcome,
        to_client: execToClient, to_provider: execToProvider, platform_fee: execPlatform,
        _push: {bookingId: row.booking_id, clientId: row.client_id, providerId: row.provider_user_id},
      };
    });
    // LM-N4 — both parties learn the outcome (post-commit): the client sees any
    // refund, the agency sees its share/clawback.
    const {bookingId: bId, clientId, providerId} = resolved._push;
    void this.bookingPush.disputeResolved(clientId, bId, resolved.outcome).catch(() => undefined);
    // CRITIC P0 — NEVER a refund banner on a NO_CHANGE outcome. `to_client` there is
    // the split that ALREADY executed (600 BC on a no-show hold), not money that
    // just moved; pushing it would tell the client they had been refunded again.
    // The `disputeResolved` wake above carries the honest outcome on its own.
    if (resolved.outcome !== 'NO_CHANGE' && resolved.to_client > 0) {
      void this.bookingPush.refundIssued(clientId, bId, resolved.to_client).catch(() => undefined);
    }
    if (providerId) {
      void this.bookingPush.disputeResolved(providerId, bId, resolved.outcome).catch(() => undefined);
    }
    const {_push: _omit, ...out} = resolved;
    return out;
  }

  /**
   * MON-2 — resolve a stranded escrow hold that the proof-of-completion gate sent to
   * review (status='HELD' AND review_required). Before this there was NO operator exit:
   * the release sweep skips a review_required hold, confirm-complete/dispute both reject
   * a HELD hold on a completed booking, and it sat frozen forever — invisible to
   * reconciliation. An admin either RELEASES it to the agency (vouching the completion)
   * or REFUNDS it to the client (the mission could not be verified). Both are terminal.
   * Region-scoped + fail-closed audit; idempotent via the underlying status guards.
   */
  async resolveReviewHold(
    bookingId: string,
    admin: AdminContext,
    dto: {action: 'release' | 'refund'; reason: string},
  ): Promise<{ok: true; booking_id: string; outcome: 'RELEASED' | 'REFUNDED'; credits: number}> {
    const out = await this.db.withTransaction(async tx => {
      const row = await tx.qOne<{
        status: string; review_required: boolean; region_code: string;
        client_id: string; provider_user_id: string | null;
      }>(
        `SELECT eh.status, eh.review_required, b.region_code, b.client_id, eh.provider_user_id
           FROM escrow_holds eh
           JOIN lite_bookings b ON b.id = eh.booking_id
          WHERE eh.booking_id = $1 FOR UPDATE`,
        [bookingId],
      );
      if (!row) throw new NotFoundException('escrow_hold_not_found');
      assertRegionScope(admin, row.region_code);
      if (!(row.status === 'HELD' && row.review_required)) {
        throw new BadRequestException(`hold_not_in_review:${row.status}`);
      }

      let outcome: 'RELEASED' | 'REFUNDED';
      let credits: number;
      if (dto.action === 'release') {
        const r = await this.settlement.settleEscrowRelease(
          tx, bookingId, {kind: 'admin', userId: admin.user_id}, {force: true},
        );
        if (!r.released) throw new BadRequestException('release_failed');
        outcome = 'RELEASED';
        credits = r.toProvider;
      } else {
        const r = await this.wallet.refundEscrowHold(tx, bookingId, `Review resolved (refund): ${dto.reason}`);
        if (!r.refunded) throw new BadRequestException('refund_failed');
        outcome = 'REFUNDED';
        credits = r.credits;
      }
      // Clear the flag (the hold is now terminal either way, but keep the row honest).
      await tx.q(`UPDATE escrow_holds SET review_required = FALSE WHERE booking_id = $1`, [bookingId]);

      await this.audit.recordAdmin(admin, 'escrow.review_resolve', 'booking', bookingId, {
        action: dto.action, outcome, credits, reason: dto.reason,
      });
      return {
        ok: true as const, booking_id: bookingId, outcome, credits,
        _push: {clientId: row.client_id, providerId: row.provider_user_id},
      };
    });
    // Post-commit notifications.
    if (out.outcome === 'REFUNDED') {
      void this.bookingPush.refundIssued(out._push.clientId, bookingId, out.credits).catch(() => undefined);
    } else if (out._push.providerId) {
      void this.bookingPush.payoutSettled(out._push.providerId, bookingId, out.credits).catch(() => undefined);
    }
    const {_push: _omit, ...res} = out;
    return res;
  }
}
