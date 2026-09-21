import {ExecutionContext, Injectable, Logger} from '@nestjs/common';
import {ThrottlerGuard, type ThrottlerLimitDetail} from '@nestjs/throttler';
import {UserThrottlerGuard} from './user-throttler.guard';

// Nest's GUARDS_METADATA key — what @UseGuards writes on classes/handlers.
const GUARDS_METADATA = '__guards__';

/**
 * Audit Rev2 API-01 — the ThrottlerModule in AppModule was INERT: with no
 * `APP_GUARD` binding, nothing ever consulted it, so every `@Throttle(...)`
 * decorator in auth-service was dead metadata and /auth/register, /auth/login,
 * /wallet/topup, /users/lookup and every ops route had ZERO rate limiting.
 * messenger-service fixed exactly this and it was never brought across. Bound
 * as `APP_GUARD` in AppModule, this guard enforces the module default on every
 * HTTP route, with two carve-outs (copied verbatim from messenger-service):
 *
 *  1. Non-HTTP contexts are skipped — `switchToHttp()` would yield no req/res.
 *
 *  2. Routes whose controller/handler already binds a ThrottlerGuard subclass
 *     via `@UseGuards` (the 8 controllers that use UserThrottlerGuard — sos,
 *     dispatch, family, vbg, news, …) are skipped. Those keep their tuned
 *     per-USER buckets; stacking this global bucket on top would re-apply each
 *     route's tight `@Throttle` on an IP bucket instead — turning
 *     sos.controller's {limit:3, ttl:60s} into 3 panic-raises per minute per
 *     NAT, resurrecting the exact bug audit fix #12 killed.
 *
 * Health checks and the Stripe webhooks carry `@SkipThrottle()` instead (a
 * throttled /ready crashloops the pod; a throttled webhook makes Stripe retry
 * for 3 days and voids the API-06 dedupe).
 *
 * Tracker: inherits UserThrottlerGuard keying (per-user when a caller is
 * attached; IP otherwise). APP_GUARDs run before route guards, so the global
 * bucket is IP-keyed — and `trust proxy` is now a hop count (main.ts), so that
 * IP is the real client, not a spoofable leftmost X-Forwarded-For.
 */
@Injectable()
export class GlobalHttpThrottlerGuard extends UserThrottlerGuard {
  private readonly log = new Logger(GlobalHttpThrottlerGuard.name);

  // E2E-20 (2026-09-03) — ENFORCE BY DEFAULT. This used to read
  // `THROTTLE_ENFORCE === 'true'`, and that variable appeared in NO .env, compose
  // or infra file in the repo, so the "shadow one release, then flip" plan above
  // could never be executed: nothing was ever set, nobody ever read a
  // [throttle-shadow] line, and the whole rate limiter was decorative. A control
  // that is off everywhere and named nowhere is not a staged rollout, it is an
  // absent control — and the failure it lets through is fleet-wide (one runaway
  // client loop saturates the 20-connection pg pool and every request then blocks
  // on connectionTimeoutMillis=5000).
  //
  // Default ON with an explicit escape hatch: set THROTTLE_ENFORCE=false to fall
  // back to shadow logging for one deploy if a rollout does surface a 429 spike.
  // The value is documented with its default in .env.example, .env.staging.example,
  // infra/env/auth.env.example and docker-compose.yml, so it is visible whether it
  // is set or not.
  //
  // Two things make defaulting ON safe here, both landed with this change:
  //  1. The global bucket in AppModule was raised from 120/min to 3000/min per IP
  //     and re-scoped as a DDoS BACKSTOP, not a rate limit. It is IP-keyed, and an
  //     IP is a whole office or a whole CGNAT pool: the ops console alone is
  //     ~120-200 req/min per seat. The real per-actor limits are the per-USER
  //     `@Throttle` decorators on routes binding UserThrottlerGuard.
  //  2. The pollers the original comment worried about are already carved out:
  //     telemetry, SOS, dispatch, family, vbg/news and the room-intent routes all
  //     bind UserThrottlerGuard (per-USER buckets) and `shouldSkip` below returns
  //     true for them; /ready and the Stripe webhook carry @SkipThrottle().
  //
  // ⚠️ E2E-10 (scale lane) — the throttler storage is the in-memory default, so
  // every limit here is multiplied by the replica count. See the `// Why:` note in
  // AppModule: Redis-backed ThrottlerStorage is REQUIRED before a second replica.
  private readonly enforce = (process.env['THROTTLE_ENFORCE'] ?? 'true').toLowerCase() !== 'false';

  protected override async shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const declared: unknown[] = [
      ...(Reflect.getMetadata(GUARDS_METADATA, context.getClass()) ?? []),
      ...(Reflect.getMetadata(GUARDS_METADATA, context.getHandler()) ?? []),
    ];
    return declared.some(
      g => typeof g === 'function' && (g === ThrottlerGuard || g.prototype instanceof ThrottlerGuard),
    );
  }

  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const req = context.switchToHttp().getRequest<{method?: string; url?: string; ip?: string}>();
    if (!this.enforce) {
      this.log.warn(
        `[throttle-shadow] WOULD 429 ${req?.method ?? '?'} ${req?.url ?? '?'} ` +
        `ip=${req?.ip ?? '?'} limit=${detail.limit} ttl=${detail.ttl}ms ` +
        `— NOT enforced (THROTTLE_ENFORCE=false is set; unset it to enforce)`,
      );
      return;
    }
    // Enforcing still LOGS the breach — a silent 429 is as hard to size as a
    // silent pass, and this line is what tells ops a real limit needs raising.
    this.log.warn(
      `[throttle] 429 ${req?.method ?? '?'} ${req?.url ?? '?'} ` +
      `ip=${req?.ip ?? '?'} limit=${detail.limit} ttl=${detail.ttl}ms`,
    );
    return super.throwThrottlingException(context, detail);
  }
}
