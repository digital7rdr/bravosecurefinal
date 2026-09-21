import {Injectable, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';

export interface ProofGateResult {
  pass: boolean;
  /** Failing check ids — empty when pass. Surfaced ONLY as an aggregate metric, never to the lead. */
  reasons: string[];
}

/**
 * Proof-of-completion gate (BUILD_RUNBOOK Step 10 §40) — the trust control that
 * decides whether a lead's one-tap Finish opens the escrow for release or sends it
 * to human review. Server-side, read-only: it reads ONLY data already collected
 * (mission per-state timestamps + GPS telemetry + the booking's pickup point), so
 * an agency can't fake "completed" by tapping Finish on a job that never happened.
 *
 * PASS  -> the caller may flip escrow_holds HELD->PENDING_RELEASE (money still waits
 *          for the Step 11 dispute-window release sweep — nothing is paid here).
 * FAIL  -> the mission still closes operationally, but the hold is review_required;
 *          it never auto-releases. A structured log line is the metric surface
 *          (no prom-client in this service) — never expose the reason to the lead.
 *
 * Identity handshake (check 5) is treated as "offered" (pass) until the LB12
 * arrival verify-code step lands; do NOT add a "skip the gate in dev" branch.
 *
 * E2E-02 — the gate is SERVICE-AWARE. A location-anchored detail (Executive
 * Protection, or any booking with no transfer leg) is proved by PRESENCE, not by
 * displacement: the FRAUD-1 movement check is replaced for those bookings by the
 * hourly check-in cadence, which is the only EP-native progress record. Nothing is
 * relaxed for a transport mission, and the identity handshake stays mandatory
 * wherever it is mandatory today.
 */
@Injectable()
export class ProofOfCompletionService {
  private readonly log = new Logger(ProofOfCompletionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly cfg: ConfigService,
  ) {}

  async runProofGate(bookingId: string, missionId: string): Promise<ProofGateResult> {
    const radiusM   = this.cfg.get<number>('dispatch.arrivalRadiusM') ?? 150;
    const minPings  = this.cfg.get<number>('dispatch.minPings') ?? 5;
    const minOnTask = this.cfg.get<number>('dispatch.minOnTaskSeconds') ?? 300;
    const requireIdentity = this.cfg.get<boolean>('dispatch.requireIdentityHandshake') ?? false;
    const requireMovement = this.cfg.get<boolean>('dispatch.requireLiveMovement') ?? false;
    const minMovementM    = this.cfg.get<number>('dispatch.minLiveMovementM') ?? 25;
    // E2E-02 — how many hourly check-ins a location-anchored block must carry to count
    // as attended. 1 is the floor that makes "nobody was ever there" fail while a single
    // missed hour on a real detail does NOT strand the agency's money (that is E2E-14's
    // job — an escalation, not a payout gate).
    const minCheckins     = this.cfg.get<number>('dispatch.epMinCheckins') ?? 1;
    const reasons: string[] = [];

    const m = await this.db.qOne<{pickup_at: Date | null; live_at: Date | null; ended_at: Date | null; identity_verified_at: Date | null}>(
      `SELECT pickup_at, live_at, ended_at, identity_verified_at FROM missions WHERE id = $1`,
      [missionId],
    );
    // E2E-02 — service + transfer-leg mode + block length ride along so the gate can
    // pick the right proof shape. Column order is deliberate: pickup_lat/pickup_lng stay
    // adjacent and last so the PostGIS reads below (and the specs that key on them) read
    // the same as before.
    const b = await this.db.qOne<{
      service: string | null; duration_hours: number | null; transport_mode: string | null;
      pickup_time: Date | null;
      pickup_lat: string | null; pickup_lng: string | null;
    }>(
      `SELECT service::text AS service, duration_hours, pickup_time,
              exec_transport->>'mode' AS transport_mode,
              pickup_lat, pickup_lng FROM lite_bookings WHERE id = $1`,
      [bookingId],
    );
    if (!m || !b) {
      return {pass: false, reasons: ['mission_or_booking_missing']};
    }
    // Classify by the TRANSFER LEG, not by the service label. An Executive Protection
    // booking can carry a real transport leg (exec_transport.mode = one_way/return/
    // both_ways), and that mission genuinely moves — treating every EP booking as
    // stationary would hand exactly those missions a pass on BOTH proofs.
    const hasTransferLeg = !!b.transport_mode && b.transport_mode !== 'none';
    // Presence (check 4c) is owed by anything that produces hourly check-ins: every EP
    // block, plus any booking explicitly declaring no transfer leg.
    const requirePresence = b.service === 'executive_protection' || b.transport_mode === 'none';
    // The movement proof (check 4b) is SKIPPED only for a detail with nothing to move
    // between. The service's own comment there concedes "a truly stationary detail would
    // trip it", which is how a residential/site block stranded the agency's money.
    const skipMovement = requirePresence && !hasTransferLeg;

    // (1) Real progression — the mission entered PICKUP then LIVE (not a one-tap jump).
    if (!m.pickup_at || !m.live_at || m.pickup_at > m.live_at) {
      reasons.push('no_progression');
    }

    // (2) Reached pickup — ≥1 GPS fix within radiusM of the pickup point. PostGIS is
    //     schema-qualified (extensions.*) so it resolves regardless of search_path.
    if (b.pickup_lat !== null && b.pickup_lng !== null) {
      const reached = await this.db.qOne<{ok: boolean}>(
        `SELECT EXISTS (
           SELECT 1 FROM mission_telemetry mt
            WHERE mt.mission_id = $1
              AND extensions.ST_DWithin(
                    extensions.ST_SetSRID(extensions.ST_MakePoint(mt.lng, mt.lat), 4326)::extensions.geography,
                    extensions.ST_SetSRID(extensions.ST_MakePoint($2, $3), 4326)::extensions.geography,
                    $4)
         ) AS ok`,
        [missionId, b.pickup_lng, b.pickup_lat, radiusM],
      );
      if (!reached?.ok) {
        reasons.push('never_reached_pickup');
      }
    } else {
      reasons.push('no_pickup_coords');
    }

    // (3) Telemetry coverage — ≥ minPings GPS pings during LIVE (not a 30-second "live").
    if (m.live_at) {
      const cov = await this.db.qOne<{n: string}>(
        `SELECT count(*)::text AS n FROM mission_telemetry
          WHERE mission_id = $1 AND recorded_at >= $2`,
        [missionId, m.live_at],
      );
      if (Number(cov?.n ?? '0') < minPings) {
        reasons.push('insufficient_telemetry');
      }
    }

    // (4) Min on-task time — LIVE duration ≥ minOnTaskSeconds.
    if (m.live_at) {
      const end = m.ended_at ?? new Date();
      const onTaskSec = (end.getTime() - new Date(m.live_at).getTime()) / 1000;
      if (onTaskSec < minOnTask) {
        reasons.push('too_short');
      }
    }

    // (4b) FRAUD-1 — real movement during LIVE. Fabricated telemetry is typically N
    //     identical fixes at the pickup point; a real detail sweeps some ground. The
    //     bounding-box diagonal of the LIVE fixes is a cheap "did they move" proxy.
    //     Gated (requireLiveMovement) because a truly stationary detail would trip it.
    //     E2E-02: NOT applied to a detail with no transfer leg — for those the presence
    //     proof in 4c takes its place. Transport missions are untouched (same flag, same
    //     threshold, same reason id), INCLUDING an EP booking that carries a real leg:
    //     that mission moves, so it owes movement proof as well as presence.
    if (requireMovement && m.live_at && !skipMovement) {
      const spread = await this.db.qOne<{m: number | null}>(
        `SELECT extensions.ST_Distance(
                  extensions.ST_SetSRID(extensions.ST_MakePoint(MIN(lng), MIN(lat)), 4326)::extensions.geography,
                  extensions.ST_SetSRID(extensions.ST_MakePoint(MAX(lng), MAX(lat)), 4326)::extensions.geography) AS m
           FROM mission_telemetry
          WHERE mission_id = $1 AND recorded_at >= $2`,
        [missionId, m.live_at],
      );
      if (Number(spread?.m ?? 0) < minMovementM) {
        reasons.push('no_live_movement');
      }
    }

    // (4c) E2E-02 — PRESENCE proof for a location-anchored detail, replacing 4b. The
    //     hourly check-in is the only progress record an EP block produces
    //     (mission_hourly_checkins, lead-only, server-clocked, one row per elapsed
    //     contracted hour), so "did anyone actually stand this post" is answered by the
    //     cadence, not by metres travelled. Only demanded once the block was live long
    //     enough for at least `minCheckins` hours to have come due — a block that ended
    //     inside its first hour has nothing to confirm and must not be failed for it.
    //     Combined with checks 2 (a fix within arrivalRadiusM of the service location)
    //     and 5 (the identity handshake), the EP proof is: right place, right person,
    //     attended over time.
    if (requirePresence && m.live_at) {
      const end = m.ended_at ?? new Date();
      const graceMs = 120_000; // mirrors the hourly check-in's own 2-minute grace
      // E2E-16 — count due hours from the CONTRACTED start, the same anchor the check-in
      // endpoint and the overdue sweep use. Measuring from live_at instead let a late
      // go-live shrink the count to zero (45 minutes late on a 1 h block ⇒ elapsed 0),
      // which SKIPPED this whole check and passed a full block with no check-ins at all —
      // the gate silently disagreeing with the clock it is supposed to be auditing.
      const contracted = b.pickup_time ? new Date(b.pickup_time).getTime() : Number.NaN;
      const anchor = Number.isFinite(contracted) ? contracted : new Date(m.live_at).getTime();
      const elapsedHours = Math.floor(((end.getTime() - anchor) + graceMs) / 3600_000);
      const confirmable = Math.min(Number(b.duration_hours ?? 0) || 0, elapsedHours);
      if (confirmable >= minCheckins) {
        const c = await this.db.qOne<{n: string}>(
          `SELECT count(*)::text AS n FROM mission_hourly_checkins WHERE mission_id = $1`,
          [missionId],
        );
        if (Number(c?.n ?? '0') < minCheckins) {
          reasons.push('no_presence_checkins');
        }
      }
    }

    // (5) Identity handshake — the assigned lead proved presence by entering the
    //     client-displayed arrival code (AgentService.verifyArrival stamps
    //     missions.identity_verified_at). Gated behind requireIdentityHandshake so
    //     it ships dark until the mobile handshake UI is live on both sides; when
    //     on, a completion with no server-verified identity goes to review_required
    //     (never auto-releases) rather than paying out an unverified guard.
    if (requireIdentity && !m.identity_verified_at) {
      reasons.push('identity_unverified');
    }

    const pass = reasons.length === 0;
    if (!pass) {
      // Metric surface for dispatch_completion_gate_fail_total{reason} (no prom-client here).
      this.log.warn(`dispatch.completion_gate_fail booking=${bookingId} reasons=${reasons.join(',')}`);
    }
    return {pass, reasons};
  }
}
