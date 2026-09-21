import {Injectable, Logger, type OnModuleInit, type OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {acquireRedisLock, releaseRedisLock} from '../common/redis-lock';
import {DispatchService} from './dispatch.service';

/**
 * Scheduled / recurring auto-dispatch (BUILD_RUNBOOK Step 24).
 *
 * Ops-gated auto dispatch: a "later" auto request now waits on the ops board
 * (PENDING_OPS) and its approval parks it OPS_APPROVED with NO publish
 * (OpsService.approveBooking) — this sweep is what dispatches it. Every interval it
 * finds OPS_APPROVED auto "later" bookings whose pickup is within the lead window and
 * flips each to DISPATCHING via DispatchService.start() — so a guard booked for 6pm
 * starts searching ~15min before. An UNAPPROVED booking is still PENDING_OPS and is
 * never selected — ops approval is the gate.
 *
 * Multi-pod safe: one pod per tick via a Redis SET NX lock (TTL < interval). Within the
 * tick, start() is itself a conditional status-guarded flip, so even without the lock
 * a booking can't be double-dispatched. Ships DARK behind AUTO_DISPATCH_ENABLED, mirroring
 * the other dispatch sweeps.
 *
 * ─── 2026-09-03 audit changes (E2E-04, E2E-11) ───────────────────────────────
 * Four passes now, in this order, all inside one lock:
 *   1. DUE      — the original: parked rows inside their SERVICE-AWARE lead window.
 *   2. STUCK    — the original INFRA-2 'now' recovery, unchanged.
 *   3. STALE    — E2E-04: parked rows whose start is already PAST the floor are
 *                 CLOSED OUT, not dispatched.
 *   4. RETRY    — E2E-11: a scheduled booking stalled mid-search (DISPATCHING with
 *                 no live offer) is re-driven while its pickup is still ahead.
 */
const SWEEP_INTERVAL_MS = 60_000; // 1 min
const LOCK_KEY = 'lock:scheduled-dispatch';
const LOCK_TTL_MS = 55_000;       // < interval so a crashed sweeper can't pin the lock
const LEAD_WINDOW_MINUTES = Number(process.env['DISPATCH_SCHEDULED_LEAD_MINUTES'] ?? '15');
/**
 * E2E-11 — Executive Protection searches MUCH earlier than a transfer.
 *
 * One 15-minute window used to cover every service. For EP that is indefensible:
 * the product has a 3-hour MINIMUM LEAD and sells fixed 3–24 h blocks, nothing is
 * reserved between submit and the search (escrow is held at agency accept), and
 * exhaustion is terminal — so a client who booked a detail seven days out could
 * be told fifteen minutes before the start that nobody is coming, after a T-60
 * reminder that never mentioned it. 24 h of runway is the difference between
 * "ops force-assigns / calls the client" and "the client is standing alone".
 *
 * Secure Transfer is UNCHANGED (still LEAD_WINDOW_MINUTES): its whole point is
 * short-notice dispatch, and searching a day ahead for a transfer would hold
 * agency attention on a job that does not need it yet.
 */
const EP_LEAD_WINDOW_MINUTES = Number(process.env['DISPATCH_EP_SCHEDULED_LEAD_MINUTES'] ?? '1440');
// INFRA-2 — minutes an approved 'now' booking may sit un-dispatched before this
// sweep re-drives it (the ops-approved pub/sub frame is fire-once; a lost frame
// otherwise strands it forever). Short, since 'now' means the client is waiting.
const STUCK_NOW_GRACE_MINUTES = Number(process.env['DISPATCH_STUCK_NOW_GRACE_MINUTES'] ?? '2');
/**
 * E2E-04 — the LOWER bound the due-selection never had.
 *
 * `pickup_time <= NOW() + lead` with no floor meant a booking approved four hours
 * late still went to the matchmaker: escrow held, crew assigned, the hourly clock
 * started, for a slot the client had already lost. Anything older than this floor
 * is handed to `expireStaleScheduled` instead of `start`.
 *
 * The floor is generous on purpose. It must be LONGER than every legitimate way a
 * row can be a few minutes late (a pod restart, a lock held by a dying sweeper, a
 * clock skew between the app server and Postgres) and SHORTER than a slot a client
 * would still want. 30 min: a booking whose start passed half an hour ago is not
 * one anybody is still waiting for, and no benign delay reaches it.
 */
const STALE_START_FLOOR_MINUTES = Number(process.env['DISPATCH_STALE_START_FLOOR_MINUTES'] ?? '30');
/**
 * E2E-11 — how long a scheduled booking may sit DISPATCHING with NO live offer
 * before this sweep re-drives its cascade.
 *
 * `offerNext` is idempotent (it re-reads the booking status under a lock, counts
 * the booking's own offers against MAX_OFFERS, and the unique partials arbitrate
 * races), so a re-drive is safe: worst case it is a no-op. This is a RETRY of a
 * stalled search, NOT a reopening of a terminal NO_PROVIDER — see
 * `DispatchService.noProvider` for why that is arch-gated.
 */
const RETRY_STALLED_AFTER_MINUTES = Number(process.env['DISPATCH_SCHEDULED_RETRY_MINUTES'] ?? '5');
const BATCH = 50;

@Injectable()
export class ScheduledDispatchService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ScheduledDispatchService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly dispatch: DispatchService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled()) {
      this.log.log('auto-dispatch off — scheduled-dispatch sweeper not started');
      return;
    }
    this.timer = setInterval(() => { void this.sweepOnce(); }, SWEEP_INTERVAL_MS);
    this.log.log(
      `scheduled-dispatch sweeper started (interval=${SWEEP_INTERVAL_MS}ms lead=${LEAD_WINDOW_MINUTES}min ` +
      `ep_lead=${EP_LEAD_WINDOW_MINUTES}min stale_floor=${STALE_START_FLOOR_MINUTES}min)`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private enabled(): boolean {
    return this.config.get<boolean>('featureFlags.autoDispatch') ?? false;
  }

  /** Public for tests — runs one sweep iteration. */
  async sweepOnce(): Promise<{
    started: number; expired_stale: number; retried: number;
    skipped_lock: boolean; skipped_flag: boolean;
  }> {
    if (!this.enabled()) {
      return {started: 0, expired_stale: 0, retried: 0, skipped_lock: false, skipped_flag: true};
    }
    const token = await acquireRedisLock(this.redis.client, LOCK_KEY, LOCK_TTL_MS);
    if (token === null) {
      return {started: 0, expired_stale: 0, retried: 0, skipped_lock: true, skipped_flag: false};
    }
    try {
      const due = await this.db.q<{id: string}>(
        // OPS_APPROVED = ops-gated flow (the only steady-state source). DRAFT is kept as a
        // safe union for in-flight rows created by the pre-gate flow (request-time used to
        // leave "later" bookings DRAFT) — drop it once those rows have drained. PENDING_OPS
        // is deliberately absent: an unapproved booking must never auto-dispatch.
        //
        // E2E-11 — the lead window is SERVICE-AWARE: Executive Protection gets $2,
        // everything else keeps $1. Both are cast to text explicitly, or Postgres
        // cannot resolve the CASE's result type for the `|| ' minutes'` concat.
        // E2E-04 — and the window now has a FLOOR ($3): a row whose start is older
        // than that is not "due", it is stale, and the pass below closes it out.
        `SELECT id FROM lite_bookings
          WHERE dispatch_mode = 'auto' AND booking_mode = 'later'
            AND status IN ('OPS_APPROVED', 'DRAFT') AND dispatch_started_at IS NULL
            AND pickup_time <= NOW() + ((CASE WHEN service = 'executive_protection'
                                              THEN $2::text ELSE $1::text END) || ' minutes')::interval
            AND pickup_time > NOW() - ($3::text || ' minutes')::interval
          ORDER BY pickup_time ASC
          LIMIT ${BATCH}`,
        [LEAD_WINDOW_MINUTES, EP_LEAD_WINDOW_MINUTES, STALE_START_FLOOR_MINUTES],
      );
      // INFRA-2 — recover 'now' bookings whose ops-approved pub/sub frame was lost:
      // approved (OPS_APPROVED), never started (dispatch_started_at IS NULL), and
      // sitting past the grace window. start() is the same idempotent conditional
      // flip, so a booking already picked up by the live pub/sub path is a no-op here.
      const stuckNow = await this.db.q<{id: string}>(
        `SELECT id FROM lite_bookings
          WHERE dispatch_mode = 'auto' AND booking_mode = 'now'
            AND status = 'OPS_APPROVED' AND dispatch_started_at IS NULL
            AND updated_at < NOW() - ($1 || ' minutes')::interval
          ORDER BY updated_at ASC
          LIMIT ${BATCH}`,
        [STUCK_NOW_GRACE_MINUTES],
      );
      const ids = new Set<string>();
      for (const r of due) ids.add(r.id);
      for (const r of stuckNow) ids.add(r.id);
      let started = 0;
      for (const id of ids) {
        // start() is a conditional DRAFT→DISPATCHING flip + offer cascade; a single bad
        // row (e.g. raced into a manual start) must not abort the sweep.
        try {
          await this.dispatch.start(id);
          started++;
        } catch (e) {
          this.log.warn(`scheduled-dispatch start failed for ${id}: ${(e as Error).message}`);
        }
      }
      if (started > 0) this.log.log(`scheduled-dispatch started ${started} due booking(s) (incl. ${stuckNow.length} recovered 'now')`);

      // E2E-04 — rows that fell off the BACK of the window. Same parked cohort as
      // `due`, on the other side of the floor: never dispatch a slot the client
      // already lost. `expireStaleScheduled` is the conditional flip + the existing
      // idempotent refund + the ops page.
      const expiredStale = await this.sweepStaleStarts();
      // E2E-11 — re-drive a scheduled search that stalled with runway left.
      const retried = await this.retryStalledScheduled();

      return {started, expired_stale: expiredStale, retried, skipped_lock: false, skipped_flag: false};
    } finally {
      await releaseRedisLock(this.redis.client, LOCK_KEY, token);
    }
  }

  /**
   * E2E-04 — close out parked bookings whose contracted start is already past.
   *
   * Deliberately scoped to the SAME cohort the due-selection owns (auto + later +
   * OPS_APPROVED/DRAFT + never started). A booking that reached DISPATCHING or
   * CONFIRMED is someone else's row — the relist / crew-SLA / arrival sweeps own
   * those, and cancelling one here could strand an accepted agency's escrow.
   */
  private async sweepStaleStarts(): Promise<number> {
    let expired = 0;
    try {
      const stale = await this.db.q<{id: string}>(
        `SELECT id FROM lite_bookings
          WHERE dispatch_mode = 'auto' AND booking_mode = 'later'
            AND status IN ('OPS_APPROVED', 'DRAFT') AND dispatch_started_at IS NULL
            AND pickup_time <= NOW() - ($1 || ' minutes')::interval
          ORDER BY pickup_time ASC
          LIMIT ${BATCH}`,
        [STALE_START_FLOOR_MINUTES],
      );
      for (const r of stale) {
        try {
          if (await this.dispatch.expireStaleScheduled(r.id)) {expired++;}
        } catch (e) {
          this.log.warn(`stale-start close failed for ${r.id}: ${(e as Error).message}`);
        }
      }
      if (expired > 0) {
        this.log.warn(`scheduled-dispatch closed ${expired} booking(s) whose start was already missed`);
      }
    } catch (e) {
      // Never let this pass abort the sweep — the due/stuck passes above already ran.
      this.log.warn(`stale-start sweep failed: ${(e as Error).message}`);
    }
    return expired;
  }

  /**
   * E2E-11 — re-drive a SCHEDULED booking that is DISPATCHING with no live offer.
   *
   * The cascade only advances on an accept / reject / expire, so a search whose
   * last offer was retired without producing a successor (a pod died mid-cascade,
   * `offerNext` hit its per-provider retry budget, the kill-switch was flipped and
   * flipped back) simply stops. For an on-demand booking the offer-expiry watchdog
   * and the SLO evaluator surface that within minutes. For a booking made days in
   * advance nobody was watching, and the audit's headline EP complaint — "you find
   * out too late" — is exactly this shape.
   *
   * Safe by construction: `offerNext` re-reads the booking under its own guard,
   * counts the booking's existing offers against MAX_OFFERS (so this cannot mint
   * an unbounded cascade), and the `dispatch_offers_one_live_per_booking` partial
   * unique makes a duplicate live offer impossible even if two pods raced.
   */
  private async retryStalledScheduled(): Promise<number> {
    let retried = 0;
    try {
      const stalled = await this.db.q<{id: string}>(
        `SELECT b.id FROM lite_bookings b
          WHERE b.dispatch_mode = 'auto' AND b.booking_mode = 'later'
            AND b.status = 'DISPATCHING'
            AND b.pickup_time > NOW()
            AND b.dispatch_started_at < NOW() - ($1 || ' minutes')::interval
            AND NOT EXISTS (SELECT 1 FROM dispatch_offers o
                             WHERE o.booking_id = b.id AND o.status = 'OFFERED')
          ORDER BY b.pickup_time ASC
          LIMIT ${BATCH}`,
        [RETRY_STALLED_AFTER_MINUTES],
      );
      for (const r of stalled) {
        try {
          await this.dispatch.offerNext(r.id);
          retried++;
        } catch (e) {
          this.log.warn(`scheduled retry failed for ${r.id}: ${(e as Error).message}`);
        }
      }
      if (retried > 0) {
        this.log.log(`scheduled-dispatch re-drove ${retried} stalled scheduled search(es)`);
      }
    } catch (e) {
      this.log.warn(`scheduled retry sweep failed: ${(e as Error).message}`);
    }
    return retried;
  }
}
