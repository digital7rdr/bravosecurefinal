import {Injectable, Logger, type OnModuleInit, type OnModuleDestroy} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {acquireRedisLock, releaseRedisLock} from '../common/redis-lock';
import {OpsAuditService} from '../ops/ops-audit.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import {ProtectionService} from '../protection/protection.service';
import {GULF_TODAY_SQL, gulfDayPlus, todayGulf} from '../pro-applications/gulf-day';

/**
 * E2E-01 — the reserved date actually activates.
 *
 * Before this sweeper NOTHING in the backend was triggered by a Pro mission
 * date: the calendar said "booked", the team chip said "ON DUTY", and unless
 * the client happened to open the app and tap Request Protection with the
 * officer also in-app, no session ever existed and nobody was told. The only
 * writers of pro_plan_missions were the request/decision paths.
 *
 * Four passes per tick, all fenced by ONE Redis lock (multi-pod safe) and all
 * bounded — plus the three protection sweeps, which used to run inline on the
 * console's 2 s poll with no lock and no LIMIT (E2E-35).
 *
 *   1. activate  — SCHEDULED reservation whose dates include TODAY → open the
 *                  protection session server-side and wake both parties.
 *   2. complete  — SCHEDULED reservation whose last date has passed → COMPLETED
 *                  (the status had been in the CHECK since day one with zero
 *                  writers).
 *   3. escalate  — REQUESTED reservation whose first date is nearly here and
 *                  still has no team → ops alert (E2E-08).
 *   4. sweeps    — protection stale-activation / max-duration / activation
 *                  escalation / coordinate retention (E2E-35).
 *
 * Modelled on dispatch/booking-reminder.service.ts: setInterval, fenced Redis
 * lock per tick, a LIMIT-ed batch, and a per-row CONDITIONAL claim so the work
 * is at-most-once even if the lock lapses.
 */
const SWEEP_INTERVAL_MS = 60_000; // 1 min
const LOCK_KEY = 'lock:pro-mission-activation';
const LOCK_TTL_MS = 55_000;       // < interval so a crashed sweeper can't pin the lock
const BATCH = 50;

// Why: Number('') is 0 and a typo is NaN — either silently disables the
// escalation or errors every sweep. Same guard shape as BOOKING_REMINDER_LEAD.
function envNum(key: string, fallback: number): number {
  const raw = Number(process.env[key] ?? String(fallback));
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * A REQUESTED reservation this close to its first date with no team is an alert.
 *
 * Why DAYS, not hours: a reserved date is a bare calendar day with no start
 * clock on it, so there is nothing for an hours value to measure from — every
 * setting from 1 to 24 would have behaved identically. 1 = "alert once the date
 * is tomorrow or sooner".
 */
const UNASSIGNED_ESCALATE_DAYS = envNum('PRO_MISSION_UNASSIGNED_ESCALATE_DAYS', 1);
/** A session opened for a reserved date that has not gone ACTIVE is an alert. */
const SESSION_ESCALATE_MIN = envNum('PRO_SESSION_ACTIVATION_ESCALATE_MIN', 15);

export interface ProMissionSweepResult {
  activated: number;
  completed: number;
  escalated: number;
  sessions_escalated: number;
  skipped_lock: boolean;
}

@Injectable()
export class ProMissionActivationService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ProMissionActivationService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly protection: ProtectionService,
    private readonly opsAudit: OpsAuditService,
    private readonly push: BookingPushBridge,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => { void this.sweepOnce(); }, SWEEP_INTERVAL_MS);
    this.log.log(
      `pro-mission activation sweeper started (interval=${SWEEP_INTERVAL_MS}ms ` +
      `unassigned_escalate=${UNASSIGNED_ESCALATE_DAYS}d session_escalate=${SESSION_ESCALATE_MIN}min)`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Public for tests — runs one sweep iteration. NEVER throws: this is driven
   *  by a fire-and-forget setInterval, and an escaping rejection is an
   *  unhandledRejection that terminates the whole auth-service process (e.g.
   *  code deployed before 20260903100000 would otherwise crash-loop every pod). */
  async sweepOnce(): Promise<ProMissionSweepResult> {
    const empty: ProMissionSweepResult = {
      activated: 0, completed: 0, escalated: 0, sessions_escalated: 0, skipped_lock: false,
    };
    try {
      const token = await acquireRedisLock(this.redis.client, LOCK_KEY, LOCK_TTL_MS);
      if (token === null) {return {...empty, skipped_lock: true};}
      try {
        const activated = await this.activateToday();
        const completed = await this.completePast();
        const escalated = await this.escalateUnassigned();
        const sessions_escalated = await this.protection.sweepActivationEscalations(SESSION_ESCALATE_MIN);
        await this.protection.sweepStaleActivations();
        await this.protection.sweepMaxDuration();
        await this.protection.sweepRetention();
        if (activated || completed || escalated || sessions_escalated) {
          this.log.log(
            `pro-mission sweep: activated=${activated} completed=${completed} ` +
            `escalated=${escalated} sessions_escalated=${sessions_escalated}`,
          );
        }
        return {activated, completed, escalated, sessions_escalated, skipped_lock: false};
      } finally {
        await releaseRedisLock(this.redis.client, LOCK_KEY, token);
      }
    } catch (e) {
      this.log.error(`pro-mission sweep failed: ${(e as Error).message}`);
      return empty;
    }
  }

  // ─── Pass 1 — the reserved date arrives ───────────────────────────────────

  private async activateToday(): Promise<number> {
    const today = todayGulf();
    const due = await this.db.q<{id: string; application_id: string; requested_by: string}>(
      `SELECT pm.id, pm.application_id, pm.requested_by
         FROM pro_plan_missions pm
         JOIN pro_applications pa ON pa.id = pm.application_id
        WHERE pm.status = 'SCHEDULED'
          AND pa.status = 'ACTIVE'
          AND $1::date = ANY(pm.mission_dates)
          AND (pm.activated_at IS NULL OR pm.activated_for_date IS DISTINCT FROM $1::date)
        ORDER BY pm.created_at ASC
        LIMIT ${BATCH}`,
      [today],
    );

    let activated = 0;
    for (const m of due) {
      try {
        // Claim BEFORE opening the session — the conditional write is the
        // idempotency gate. The pair (activated_at, activated_for_date) claims
        // per DAY, not per row: mission_dates is an array, so a bare
        // `activated_at IS NULL` would fire on the first reserved date and
        // never again on the rest of a multi-date reservation.
        const claimed = await this.db.q<{id: string}>(
          `UPDATE pro_plan_missions
              SET activated_at = now(), activated_for_date = $2::date, updated_at = now()
            WHERE id = $1 AND status = 'SCHEDULED'
              AND (activated_at IS NULL OR activated_for_date IS DISTINCT FROM $2::date)
            RETURNING id`,
          [m.id, today],
        );
        if (claimed.length === 0) {continue;}

        // Why REQUESTED and not ACTIVE: openForScheduledMission runs the SAME
        // creation path as the customer tap, so plan access, plan-ACTIVE and the
        // covering-officer check all still apply, and the two-device readiness
        // gate keeps governing REQUESTED→ACTIVE exactly as it does for an
        // on-demand session. Pre-activating it here would be weakening that gate
        // for a session neither phone has confirmed it can stream on. "Activated
        // for the day" therefore means the session EXISTS and both parties were
        // woken; escalateSessions() is what makes one that never goes live
        // visible to ops instead of quietly expiring.
        const opened = await this.protection.openForScheduledMission(m.requested_by, m.application_id);
        // The CPO wake (psessionNew) is fired inside the creation path; this is
        // the client half — the person who reserved the date, owner or member.
        // Best-effort like every sibling: a delivery miss must not cost the day
        // (the session exists either way and the client polls it).
        void this.push.proMissionLive(m.requested_by, m.application_id, opened.session.id)
          .catch(() => undefined);
        await this.db.q(
          `INSERT INTO pro_application_events (application_id, actor, event, message)
           VALUES ($1,'system','mission.activated',$2)`,
          [m.application_id, `Protection is live for today (${today})`],
        ).catch(() => undefined);
        activated += 1;
      } catch (e) {
        // The claim is already burned, which is deliberate (at-most-once beats a
        // retry storm), so the failure MUST become an ops signal or the date is
        // silently lost. no_cpo_assigned already emits its own alert inside
        // ProtectionService; this covers every other reason.
        const reason = (e as {response?: {message?: string}; message?: string}).response?.message
          ?? (e as Error).message;
        this.log.error(`pro-mission activation failed for ${m.id}: ${reason}`);
        void this.opsAudit.emit({
          kind: 'protection', severity: 'warn', subject: m.application_id,
          message: `Reserved protection date could not be activated (${reason})`,
          metadata: {mission_id: m.id, mission_date: today, reason, application_id: m.application_id},
        }).catch(() => undefined);
        void this.opsAudit.record({
          actor_role: 'SYSTEM', action: 'pro_mission.activation_failed',
          subject_type: 'application', subject_id: m.application_id,
          metadata: {mission_id: m.id, mission_date: today, reason},
        }).catch(() => undefined);
      }
    }
    return activated;
  }

  // ─── Pass 2 — end of the reserved period ──────────────────────────────────

  /** The missing lifecycle write: COMPLETED was in the CHECK with no writers. */
  private async completePast(): Promise<number> {
    const done = await this.db.q<{id: string; application_id: string}>(
      `WITH victims AS (
         SELECT id FROM pro_plan_missions
          WHERE status = 'SCHEDULED'
            AND (SELECT max(d) FROM unnest(mission_dates) d) < ${GULF_TODAY_SQL}
          ORDER BY created_at ASC
          LIMIT ${BATCH}),
       closed AS (
         UPDATE pro_plan_missions
            SET status = 'COMPLETED', updated_at = now()
          WHERE id IN (SELECT id FROM victims) AND status = 'SCHEDULED'
          RETURNING id, application_id),
       evt AS (
         INSERT INTO pro_application_events (application_id, actor, event, message)
         SELECT application_id, 'system', 'mission.completed',
                'Reserved protection dates completed'
           FROM closed)
       SELECT id, application_id FROM closed`,
    );
    // No push: a reservation quietly finishing is not news the client needs a
    // notification for, and one per closed date would be pure noise. The
    // timeline event above is the record.
    return done.length;
  }

  // ─── Pass 3 — a reserved date nobody was assigned to (E2E-08) ─────────────

  private async escalateUnassigned(): Promise<number> {
    const horizon = gulfDayPlus(Math.max(0, Math.floor(UNASSIGNED_ESCALATE_DAYS)));
    const stale = await this.db.q<{id: string; application_id: string; first_date: string}>(
      `WITH victims AS (
         SELECT pm.id
           FROM pro_plan_missions pm
           JOIN pro_applications pa ON pa.id = pm.application_id
          WHERE pm.status = 'REQUESTED' AND pm.escalated_at IS NULL
            AND pa.status = 'ACTIVE'
            AND (SELECT min(d) FROM unnest(pm.mission_dates) d) <= $1::date
          ORDER BY pm.created_at ASC
          LIMIT ${BATCH}),
       claimed AS (
         UPDATE pro_plan_missions
            SET escalated_at = now()
          WHERE id IN (SELECT id FROM victims) AND escalated_at IS NULL
          RETURNING id, application_id,
                    (SELECT min(d) FROM unnest(mission_dates) d)::text AS first_date)
       SELECT id, application_id, first_date FROM claimed`,
      [horizon],
    );

    for (const m of stale) {
      void this.opsAudit.emit({
        kind: 'protection', severity: 'warn', subject: m.application_id,
        message: `Reserved protection date ${m.first_date} still has no assigned team`,
        metadata: {mission_id: m.id, first_date: m.first_date, application_id: m.application_id},
      }).catch(() => undefined);
      void this.opsAudit.record({
        actor_role: 'SYSTEM', action: 'pro_mission.unassigned',
        subject_type: 'application', subject_id: m.application_id,
        metadata: {mission_id: m.id, first_date: m.first_date},
      }).catch(() => undefined);
    }
    return stale.length;
  }
}
