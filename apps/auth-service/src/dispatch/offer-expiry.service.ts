import {Injectable, Logger, Optional, type OnModuleInit, type OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {acquireRedisLock, releaseRedisLock} from '../common/redis-lock';
import {DispatchService, resolveTrustMockedLocation} from './dispatch.service';
import {DispatchMetricsService} from '../observability/dispatch-metrics.service';

/**
 * Sweep 1 — offer-expiry cascade watchdog (BUILD_RUNBOOK Step 8 / LB9).
 *
 * Every few seconds it finds OFFERED offers that have lapsed (past expires_at,
 * with a clock-skew grace) OR whose holding agency dropped offline / went stale,
 * and calls DispatchService.expire — which EXPIRES the offer and cascades to the
 * next-nearest agency. Without this, an offer the agency simply ignores would
 * freeze the client on "Finding…" forever (the Step 6 cascade only advances on an
 * active reject/expire call).
 *
 * Multi-pod safety (Part III #1 / LB9): auth-service runs many replicas, so the
 * sweep is gated by a Redis `SET NX` lock — only one pod does the work each tick;
 * the lock TTL is shorter than the interval so a crashed sweeper can't pin it.
 * Mirrors booking/payment-pending-expiry.service.ts verbatim in shape.
 *
 * Accept-vs-expire ordering (LB9): both accept() and expire() use the same
 * `WHERE status='OFFERED' RETURNING` guard, so whichever commits first wins and
 * the loser no-ops on 0 rows. The EXPIRY_GRACE_SECONDS buffer keeps an accept
 * landing right at expiry from being clobbered by this sweep.
 */
const SWEEP_INTERVAL_MS = 8_000;          // ~5–10s
const LOCK_KEY = 'lock:dispatch-offer-expiry';
// E2E-24 (2026-09-03) — the lock TTL used to be 7 000 ms, i.e. SHORTER than one
// worst-case batch. A tick could hold 50 rows and each `expire()` runs a
// transaction plus a full `offerNext()` ranking pass (PostGIS + two plpgsql
// functions per surviving row); at ~150 ms per row that batch is ~7.5 s, so the
// lock lapsed MID-BATCH, the next tick acquired it, and two sweeps ran the same
// cascade concurrently. Only the conditional `WHERE status='OFFERED' RETURNING`
// updates kept that from doing damage — mutual exclusion itself was gone exactly
// when load made it matter.
//
// Two changes:
//   1. TTL 7 s → 30 s — comfortably longer than any batch this sweep produces.
//   2. A BUDGET guard — the loop stops before any row that would start after the
//      tick has burned LOCK_BUDGET_MS, so work can never be carried past the
//      lock even if a row is pathologically slow. Leftover rows are picked up by
//      the next tick; the predicate is time-based and self-healing.
//
// BATCH stays 50. It was briefly cut to 10 here, which was a mistake worth
// recording: with the budget guard in place the batch size no longer bounds the
// tick — TIME does — so a smaller batch buys no safety and costs throughput
// outright. The ceiling is `BATCH` per 8 s tick, so 50 is ~375 expiries/min and
// 10 would have been ~75, a 5x cut to the cascade's recovery rate during exactly
// the load spike this sweep exists for.
//
// The TTL is now LONGER than the interval, reversing the old "TTL < interval so a
// crashed sweeper can't pin the lock" rule. That rule traded correctness for
// recovery speed: a crashed pod now parks the lock for at most 30 s (≈4 missed
// ticks, self-healing) instead of letting two live pods overlap every tick. The
// dispatch-SLO evaluator pages on `watchdog_dead` after 60 s of liveness
// staleness, so a genuinely dead sweeper is still caught.
const LOCK_TTL_MS = 30_000;
const LOCK_BUDGET_MS = 20_000;            // stop the batch here — 2/3 of the TTL, never past it
const LIVENESS_KEY = 'dispatch:watchdog:offer:last_run';
const EXPIRY_GRACE_SECONDS = 2;           // clock-skew grace: don't expire an offer the instant an accept may land
const LOCATION_FRESH_MINUTES = 5;         // a holder this stale is treated as offline
const BATCH = 50;
// Staging-only (DISPATCH_TRUST_MOCKED_LOCATION): a mock-GPS provider has no live
// heartbeat, so last_location_at never advances. Without this the ranking would offer
// the agency but THIS watchdog would expire the offer within one sweep as "stale",
// before it can be accepted. Mirror the ranking's relaxation: treat the holder as
// never-stale so its offer survives the full TTL. Same NODE_ENV!=='production' guard.
const TRUST_MOCKED_LOCATION = resolveTrustMockedLocation(
  process.env['DISPATCH_TRUST_MOCKED_LOCATION'], process.env['NODE_ENV'],
);
const EFFECTIVE_STALE_MINUTES = TRUST_MOCKED_LOCATION ? 5_256_000 /* ~10y */ : LOCATION_FRESH_MINUTES;

@Injectable()
export class OfferExpiryService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(OfferExpiryService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly dispatch: DispatchService,
    @Optional() private readonly metrics?: DispatchMetricsService,
  ) {}

  onModuleInit(): void {
    // Ships dark: don't even start the timer until AUTO_DISPATCH_ENABLED.
    if (!this.enabled()) {
      this.log.log('auto-dispatch off — offer-expiry sweeper not started');
      return;
    }
    this.timer = setInterval(() => { void this.sweepOnce(); }, SWEEP_INTERVAL_MS);
    this.log.log(`offer-expiry sweeper started (interval=${SWEEP_INTERVAL_MS}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private enabled(): boolean {
    return this.config.get<boolean>('featureFlags.autoDispatch') ?? false;
  }

  /** Public for tests — runs one sweep iteration. */
  async sweepOnce(): Promise<{expired: number; skipped_lock: boolean; skipped_flag: boolean}> {
    if (!this.enabled()) {
      return {expired: 0, skipped_lock: false, skipped_flag: true};
    }
    const sweepStart = Date.now();
    const token = await acquireRedisLock(this.redis.client, LOCK_KEY, LOCK_TTL_MS);
    if (token === null) {
      return {expired: 0, skipped_lock: true, skipped_flag: false};
    }
    try {
      // A holder is "gone" if past TTL+grace, OR off duty, OR its last fix is stale.
      const due = await this.db.q<{id: string}>(
        `SELECT o.id
           FROM dispatch_offers o
           JOIN agents a ON a.user_id = o.provider_user_id
          WHERE o.status = 'OFFERED'
            AND (o.expires_at < NOW() - ($1 || ' seconds')::interval
                 -- B-788a — a duty flip or a stale GPS fix ends a RADIUS offer only.
                 -- An assigned / regional-fallback offer was made without either
                 -- predicate (a desk dispatcher has no live fix, and scheduled work
                 -- reaches an off-duty primary on purpose), so it lives to its own
                 -- expires_at. Sweeping it here would burn the whole ladder in a
                 -- minute and charge every rung an unearned decline.
                 OR ((o.source IS NULL OR o.source = 'nearest')
                     AND (a.on_duty = FALSE
                          OR a.last_location_at < NOW() - ($2 || ' minutes')::interval)))
          ORDER BY o.expires_at ASC
          LIMIT ${BATCH}`,
        [EXPIRY_GRACE_SECONDS, EFFECTIVE_STALE_MINUTES],
      );
      // Rows this tick actually took responsibility for. Identical to `due.length`
      // unless the budget guard below stops the batch, which is the only case the
      // two can differ — a row whose expire() THREW still counts as attempted
      // (the conditional UPDATE inside expire() is the real idempotency gate).
      let processed = 0;
      for (const r of due) {
        // E2E-24 — never carry work past the lock. Checked BEFORE each row (not
        // after), so the budget bounds the time the NEXT row may consume, and the
        // remainder is left for the next tick rather than run unlocked.
        if (Date.now() - sweepStart > LOCK_BUDGET_MS) {
          this.log.warn(
            `offer-expiry stopped early at ${processed}/${due.length} — tick exceeded ${LOCK_BUDGET_MS}ms of its ${LOCK_TTL_MS}ms lock; remainder deferred to the next sweep`,
          );
          break;
        }
        processed++;
        // expire() is itself the conditional UPDATE … WHERE status='OFFERED'
        // RETURNING + offerNext cascade; a single bad row must not abort the sweep.
        try {
          await this.dispatch.expire(r.id);
        } catch (e) {
          this.log.warn(`offer-expiry failed for ${r.id}: ${(e as Error).message}`);
        }
      }
      const runAt = Date.now();
      await this.redis.client.set(LIVENESS_KEY, String(runAt), 'EX', 600).catch(() => undefined);
      // Step 26 — also surface liveness + sweep duration on /metrics (per-pod gauge;
      // /ready uses the shared Redis key above for the cross-pod check).
      this.metrics?.setGauge('dispatch_watchdog_last_run_ts', runAt, {sweep: 'offer'});
      this.metrics?.observe('dispatch_watchdog_sweep_duration_ms', runAt - sweepStart, {sweep: 'offer'});
      return {expired: processed, skipped_lock: false, skipped_flag: false};
    } finally {
      await releaseRedisLock(this.redis.client, LOCK_KEY, token);
    }
  }
}
