import {Injectable, Logger, Optional, type OnModuleInit, type OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {acquireRedisLock, releaseRedisLock} from '../common/redis-lock';
import {SentryService} from '../observability/sentry.service';
import {DispatchMetricsService} from '../observability/dispatch-metrics.service';
import {AgentService} from './agent.service';

/**
 * Mission sweeps (SECURE_SERVICES_E2E_AUDIT_2026-09-03 — E2E-05 / E2E-13 / E2E-14).
 *
 * A sibling of the Step-11 escrow-release sweeper, following the identical pattern:
 * `setInterval` (never @nestjs/schedule), ONE fenced Redis lock so multiple pods
 * serialise, LIMIT-bounded batches, per-row conditional claims, a liveness marker, and
 * a per-row try/catch so one bad row cannot abort the tick.
 *
 * It lives in AgentModule rather than BookingModule because all three passes re-enter
 * AgentService — the retry re-runs the SAME settleEscrowOnFinish the lead's Finish runs,
 * and the block-end close routes through the SAME completeMissionCore funnel. Neither is
 * reachable from BookingModule (AgentModule imports BookingModule, so the reverse would
 * be a DI cycle), and duplicating either would create a second money path.
 *
 * Three passes:
 *   A · E2E-05 — a COMPLETED mission whose escrow is still HELD is re-settled. This is
 *       the ONLY thing that rescues a settlement that threw after the completion txn had
 *       already committed; production evidence was 16 completed missions with zero payout
 *       rows. Idempotent by construction (both writes are guarded on status='HELD') and
 *       bounded by settle_attempts, with an alert once a row burns its budget.
 *   B · E2E-13 — an EP mission whose CONTRACTED block (pickup_time + duration_hours) has
 *       ended is closed by the SYSTEM through the normal completion funnel, so the proof
 *       gate, escrow settlement and pushes all still run.
 *   C · E2E-14 — an hourly check-in that came due on a LIVE EP mission and was never
 *       confirmed raises an ops signal + an agency wake. Detection only: it never moves
 *       money and never changes a mission's status.
 *
 * ALWAYS-ON (INFRA-3): passes A and B settle money for work already delivered, so they
 * must not be gated behind AUTO_DISPATCH_ENABLED — a flag flip cannot be allowed to
 * strand an agency's payout. Every pass is a no-op when its query returns nothing.
 */
const SWEEP_INTERVAL_MS = 60_000;          // 1 min, matching the other money sweeps
const LOCK_KEY = 'lock:mission-sweeps';
const LOCK_TTL_MS = 55_000;                // < interval so a crashed sweeper can't pin it
const LIVENESS_KEY = 'dispatch:watchdog:mission-sweeps:last_run';
/**
 * Batch sizes + a wall-clock budget. The offer-expiry lane's standing defect (E2E-24) is
 * a lock TTL shorter than the worst-case batch: the lease lapses mid-tick, a second pod
 * enters, and only the conditional UPDATEs are left holding the line. Each row here costs
 * a settlement or a whole completion funnel, so the batches are small AND every loop
 * stops at `deadline` — the pass gives the lock back rather than working past its lease,
 * and the untouched rows are simply picked up next tick (all three queries are
 * order-stable and re-entrant).
 */
const BATCH = 10;
const CHECKIN_BATCH = 25;
/** Budget for the whole tick, comfortably inside LOCK_TTL_MS. */
const LOCK_BUDGET_MS = 40_000;
/** One overdue nudge per (mission, hour) per this window — the dedupe that keeps a
 *  60-second sweep from paging the agency sixty times an hour for one missed check-in. */
const CHECKIN_ALERT_TTL_SEC = 6 * 3600;

export interface MissionSweepResult {
  /** Holds that recovered all the way to PENDING_RELEASE. */
  settled: number;
  /** Holds whose retry ran but landed on review_required — NOT recovered money. */
  reviewed: number;
  stranded_alerted: number;
  blocks_closed: number;
  checkins_overdue: number;
  skipped_lock: boolean;
}

@Injectable()
export class MissionSweepsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MissionSweepsService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly agents: AgentService,
    // Both @Global; optional so a spec can construct this service directly with the four
    // required deps. Drift alerts go to the metric + Sentry, NEVER the push channel.
    @Optional() private readonly metrics?: DispatchMetricsService,
    @Optional() private readonly sentry?: SentryService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => { void this.sweepOnce(); }, SWEEP_INTERVAL_MS);
    this.log.log(`mission sweeps started (interval=${SWEEP_INTERVAL_MS}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Public for tests — runs one iteration of all three passes under one fenced lock. */
  async sweepOnce(): Promise<MissionSweepResult> {
    const token = await acquireRedisLock(this.redis.client, LOCK_KEY, LOCK_TTL_MS);
    if (token === null) {
      return {
        settled: 0, reviewed: 0, stranded_alerted: 0, blocks_closed: 0,
        checkins_overdue: 0, skipped_lock: true,
      };
    }
    const deadline = Date.now() + LOCK_BUDGET_MS;
    try {
      // Each pass is independently wrapped: a failure in one must not skip the others,
      // and pass A is the money one. Each also stops at `deadline` so the tick cannot
      // outrun the lock lease.
      const retry = await this.retryStrandedSettlements(deadline).catch(e => {
        this.log.warn(`stranded-settlement pass failed: ${(e as Error).message}`);
        return {settled: 0, reviewed: 0};
      });
      const strandedAlerted = await this.alertExhaustedSettlements().catch(e => {
        this.log.warn(`stranded-settlement alert pass failed: ${(e as Error).message}`);
        return 0;
      });
      const blocksClosed = await this.closeEndedExecBlocks(deadline).catch(e => {
        this.log.warn(`exec block-end pass failed: ${(e as Error).message}`);
        return 0;
      });
      const checkinsOverdue = await this.flagOverdueCheckins(deadline).catch(e => {
        this.log.warn(`overdue check-in pass failed: ${(e as Error).message}`);
        return 0;
      });
      await this.redis.client.set(LIVENESS_KEY, String(Date.now()), 'EX', 600).catch(() => undefined);
      return {
        settled: retry.settled, reviewed: retry.reviewed,
        stranded_alerted: strandedAlerted, blocks_closed: blocksClosed,
        checkins_overdue: checkinsOverdue, skipped_lock: false,
      };
    } finally {
      await releaseRedisLock(this.redis.client, LOCK_KEY, token);
    }
  }

  // ─── Pass A · E2E-05 — stranded settlement retry ───────────────────

  /**
   * A booking whose mission COMPLETED but whose escrow is still HELD had its settlement
   * throw after the completion txn committed. Re-run it.
   *
   * `NOT review_required` is load-bearing: a HELD hold with review_required set is NOT
   * stranded, it is a proof-gate FAIL waiting on an operator, and retrying it would
   * pointlessly re-run the gate every minute forever. `no_show_at IS NULL` excludes the
   * E2E-06 terminal, which never passes through this state.
   *
   * The per-row claim is `settle_attempts = <the value this pass read>`, so two pods (or
   * two overlapping ticks) racing the same row leave exactly one winner; the loser's
   * UPDATE matches zero rows and it skips. Nothing is paid here in any case — a
   * successful retry only opens the hold to PENDING_RELEASE, and the money still waits
   * for the dispute-window release sweep.
   */
  private async retryStrandedSettlements(deadline: number): Promise<{settled: number; reviewed: number}> {
    const graceMin = this.config.get<number>('dispatch.settleRetryGraceMinutes') ?? 10;
    const maxAttempts = this.config.get<number>('dispatch.settleMaxAttempts') ?? 5;
    const due = await this.db.q<{booking_id: string; mission_id: string; settle_attempts: number}>(
      `SELECT eh.booking_id, m.id AS mission_id, eh.settle_attempts
         FROM escrow_holds eh
         JOIN lite_bookings b ON b.id = eh.booking_id
         JOIN missions m ON m.booking_id = eh.booking_id AND m.status = 'COMPLETED'
        WHERE eh.status = 'HELD'
          AND NOT eh.review_required
          AND eh.no_show_at IS NULL
          AND b.status = 'COMPLETED'
          AND m.ended_at IS NOT NULL
          AND m.ended_at < NOW() - ($1 || ' minutes')::interval
          AND eh.settle_attempts < $2
          AND (eh.last_settle_attempt_at IS NULL
               OR eh.last_settle_attempt_at < NOW() - ($1 || ' minutes')::interval)
        ORDER BY m.ended_at ASC
        LIMIT ${BATCH}`,
      [String(graceMin), maxAttempts],
    );
    let settled = 0;
    let reviewed = 0;
    for (const r of due) {
      if (Date.now() > deadline) {break; }
      try {
        const claim = await this.db.q<{settle_attempts: number}>(
          `UPDATE escrow_holds
              SET settle_attempts = settle_attempts + 1, last_settle_attempt_at = NOW()
            WHERE booking_id = $1 AND status = 'HELD' AND settle_attempts = $2
            RETURNING settle_attempts`,
          [r.booking_id, r.settle_attempts],
        );
        if (claim.length === 0) {continue; } // another pod/tick owns this row
        const res = await this.agents.retryStrandedSettlement(r.booking_id, r.mission_id);
        if (res.outcome === 'failed') {
          this.log.warn(`stranded settle retry failed booking=${r.booking_id} attempt=${claim[0].settle_attempts}`);
          continue;
        }
        // review_required is NOT a recovery. The hold left HELD, but it now waits on an
        // operator instead of on the release sweep — counting it as recovered would make
        // the metric read healthy for money that is still going nowhere.
        if (res.outcome === 'review_required') {
          reviewed++;
          this.log.warn(
            `stranded settle sent to REVIEW booking=${r.booking_id} attempt=${claim[0].settle_attempts} ` +
            `(proof gate failed — needs an operator, not another retry)`,
          );
          continue;
        }
        settled++;
        this.log.log(
          `stranded settle recovered booking=${r.booking_id} outcome=${res.outcome} attempt=${claim[0].settle_attempts}`,
        );
      } catch (e) {
        this.log.warn(`stranded settle retry threw for ${r.booking_id}: ${(e as Error).message}`);
      }
    }
    if (settled > 0) {this.metrics?.inc('dispatch_settle_retry_recovered_total', undefined, settled); }
    if (reviewed > 0) {this.metrics?.inc('dispatch_settle_retry_review_total', undefined, reviewed); }
    return {settled, reviewed};
  }

  /**
   * A hold that has burned its attempt budget is a human's problem, not a timer's —
   * retrying it forever would hide it. Alert once per row per 6h (settle_alerted_at) via
   * the same metric + Sentry surface the money-drift reconciliation uses. Counts only in
   * the Sentry payload — no PII.
   */
  private async alertExhaustedSettlements(): Promise<number> {
    const maxAttempts = this.config.get<number>('dispatch.settleMaxAttempts') ?? 5;
    const rows = await this.db.q<{booking_id: string; settle_attempts: number}>(
      `SELECT booking_id, settle_attempts FROM escrow_holds
        WHERE status = 'HELD'
          AND NOT review_required
          AND no_show_at IS NULL
          AND settle_attempts >= $1
          AND (settle_alerted_at IS NULL OR settle_alerted_at < NOW() - INTERVAL '6 hours')
        ORDER BY last_settle_attempt_at ASC
        LIMIT ${BATCH}`,
      [maxAttempts],
    );
    if (rows.length === 0) {return 0; }
    for (const r of rows) {
      this.log.error(
        `escrow STRANDED after ${r.settle_attempts} settle attempts — needs operator settle ` +
        `booking=${r.booking_id}`,
      );
    }
    this.metrics?.inc('dispatch_escrow_stranded_total', undefined, rows.length);
    this.sentry?.captureException(new Error('escrow_settle_exhausted'), {
      tags: {kind: 'escrow_settle_exhausted'},
      extra: {count: rows.length, max_attempts: maxAttempts},
    });
    await this.db.q(
      `UPDATE escrow_holds SET settle_alerted_at = NOW() WHERE booking_id = ANY($1::uuid[])`,
      [rows.map(r => r.booking_id)],
    ).catch(() => undefined);
    return rows.length;
  }

  // ─── Pass B · E2E-13 — the EP block actually ends ──────────────────

  /**
   * Nothing in the backend read `pickup_time + duration_hours`, so an Executive
   * Protection block had no end: the mission stayed LIVE until a human noticed. Close it
   * through AgentService.completeMissionAsSystem, which is the SAME completeMissionCore
   * funnel the lead's Finish uses — proof gate, escrow settlement, crew release, Ops-Room
   * teardown and the client completion wake all still run.
   *
   * LIVE only (never SOS — a timer may not close an active emergency), and the close is
   * stamped end_reason='system_block_end' so the audit tells a system close apart from a
   * lead-completed mission. Idempotent: the core's conditional UPDATE matches nothing
   * once the mission has left LIVE. Extension is deliberately NOT implemented — an
   * over-run is still not billed.
   */
  private async closeEndedExecBlocks(deadline: number): Promise<number> {
    const graceMin = this.config.get<number>('dispatch.epBlockEndGraceMinutes') ?? 15;
    const due = await this.db.q<{mission_id: string; booking_id: string}>(
      `SELECT m.id AS mission_id, m.booking_id
         FROM missions m
         JOIN lite_bookings b ON b.id = m.booking_id
        WHERE m.status = 'LIVE'
          AND b.service = 'executive_protection'
          AND b.pickup_time IS NOT NULL
          AND COALESCE(b.duration_hours, 0) > 0
          AND b.pickup_time + make_interval(hours => b.duration_hours)
              < NOW() - ($1 || ' minutes')::interval
        ORDER BY b.pickup_time ASC
        LIMIT ${BATCH}`,
      [String(graceMin)],
    );
    let closed = 0;
    for (const r of due) {
      if (Date.now() > deadline) {break; }
      try {
        const res = await this.agents.completeMissionAsSystem(r.mission_id, 'system_block_end');
        if (res.completed) {
          closed++;
          this.log.log(`EP block closed by system mission=${r.mission_id} booking=${r.booking_id}`);
        }
      } catch (e) {
        this.log.warn(`EP block close failed for ${r.mission_id}: ${(e as Error).message}`);
      }
    }
    if (closed > 0) {this.metrics?.inc('dispatch_exec_block_autoclosed_total', undefined, closed); }
    return closed;
  }

  // ─── Pass C · E2E-14 — a missed hourly check-in has a consequence ──

  /**
   * The LOWEST unconfirmed due hour of a LIVE EP block is overdue when the CONTRACTED
   * clock (pickup_time + N hours, the E2E-16 anchor) plus a grace has passed.
   *
   * Lowest MISSING, not `MAX(hour_index) + 1`: the hours are independently confirmable,
   * so a lead who taps hour 3 while hour 2 was never confirmed pushes the max past the
   * gap and hides it FOREVER — the one case where a check-in was genuinely skipped is
   * the one the max can never see.
   *
   * Detection only: this pass never moves money, never touches a mission's status, and
   * never invents a check-in row. The Redis marker keeps one missed hour from paging the
   * agency every minute.
   */
  private async flagOverdueCheckins(deadline: number): Promise<number> {
    const graceMin = this.config.get<number>('dispatch.checkinOverdueGraceMinutes') ?? 20;
    const rows = await this.db.q<{
      mission_id: string; booking_id: string; provider: string | null;
      pickup_time: Date | null; live_at: Date | null; duration_hours: number;
      confirmed_hours: number[] | null;
    }>(
      `SELECT m.id AS mission_id, m.booking_id, m.live_at,
              b.pickup_time, b.duration_hours,
              b.assigned_provider_user_id AS provider,
              COALESCE(array_agg(h.hour_index) FILTER (WHERE h.hour_index IS NOT NULL), '{}') AS confirmed_hours
         FROM missions m
         JOIN lite_bookings b ON b.id = m.booking_id
         LEFT JOIN mission_hourly_checkins h ON h.mission_id = m.id
        WHERE m.status = 'LIVE'
          AND b.service = 'executive_protection'
          AND COALESCE(b.duration_hours, 0) > 0
        GROUP BY m.id, b.id
        ORDER BY b.pickup_time ASC
        LIMIT ${CHECKIN_BATCH}`,
    );
    let flagged = 0;
    for (const r of rows) {
      if (Date.now() > deadline) {break; }
      try {
        // Same anchor as AgentService.hourlyCheckIn (E2E-16) so "overdue" and
        // "confirmable" can never disagree.
        const anchor = r.pickup_time ? new Date(r.pickup_time).getTime()
          : r.live_at ? new Date(r.live_at).getTime()
          : Number.NaN;
        if (!Number.isFinite(anchor)) {continue; }
        const confirmed = new Set((r.confirmed_hours ?? []).map(Number));
        const duration = Number(r.duration_hours);
        let overdueHour = 0;
        let overdueAt = 0;
        for (let h = 1; h <= duration; h++) {
          if (confirmed.has(h)) {continue; }
          const dueAt = anchor + h * 3600_000;
          if (Date.now() < dueAt + graceMin * 60_000) {break; } // this hour and every later one
          overdueHour = h;
          overdueAt = dueAt;
          break;
        }
        if (overdueHour === 0) {continue; }
        const marker = `mission:checkin-overdue:${r.mission_id}:${overdueHour}`;
        if (await this.redis.client.get(marker)) {continue; }
        await this.agents.notifyCheckinOverdue({
          missionId: r.mission_id,
          bookingId: r.booking_id,
          providerUserId: r.provider,
          hourIndex: overdueHour,
          dueAt: new Date(overdueAt),
        });
        // Marker AFTER a SUCCESSFUL notify. Burning it first meant a throw inside the
        // notify bought six hours of silence on the very hour that failed to page.
        // Re-paging next tick is the safe direction; the pass runs under the sweep's
        // fenced lock, so no other pod can be inside this loop at the same time.
        await this.redis.client.set(marker, '1', 'EX', CHECKIN_ALERT_TTL_SEC)
          .catch(() => undefined);
        flagged++;
      } catch (e) {
        this.log.warn(`overdue check-in flag failed for ${r.mission_id}: ${(e as Error).message}`);
      }
    }
    if (flagged > 0) {this.metrics?.inc('dispatch_checkin_overdue_total', undefined, flagged); }
    return flagged;
  }
}
