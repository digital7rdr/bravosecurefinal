import {Injectable, CanActivate, ExecutionContext, UnauthorizedException, BadRequestException} from '@nestjs/common';
import type {Request} from 'express';
import {JwtService, type AccessClaims} from '../../auth/jwt.service';
import {RedisService} from '../../redis/redis.service';

/**
 * Attached state we hang on the Express request once auth passes.
 * Use the @CurrentCaller() decorator to read it in controllers
 * instead of reaching into req.user directly.
 */
export interface CallerContext {
  claims:         AccessClaims;
  signalDeviceId: number;
}

declare module 'express' {
  interface Request {
    caller?: CallerContext;
  }
}

/**
 * HTTP JWT guard for the relay endpoints.
 *
 * Two requirements on every call:
 *  1. `Authorization: Bearer <JWT>` — verified against shared secret.
 *  2. `X-Signal-Device-Id: <number>` — the caller's Signal device id.
 *     Required because JWT.device_id is auth-service's session uuid,
 *     not the Signal-layer numeric id. The relay needs the Signal id
 *     to key the per-device envelope queue.
 *
 * M10 adds a JTI revocation check via shared Redis.
 */
@Injectable()
export class JwtHttpGuard implements CanActivate {
  constructor(
    private readonly jwt:   JwtService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Scale P1-10 — 2s positive-only in-process JTI cache. A 250-leg group
   * fan-out over HTTP paid 250 Redis EXISTS round-trips for the same jti;
   * a 2s window is invisible against the 60s revocation-sweep SLA the WS
   * side already accepts, and a NEGATIVE result is never cached so a
   * revoked token stays dead immediately. Bounded so a burst of distinct
   * jtis can't grow the map without limit.
   */
  private static readonly JTI_CACHE_TTL_MS = 2_000;
  private static readonly JTI_CACHE_MAX = 10_000;
  private readonly jtiCache = new Map<string, number>();

  private async isJtiValidCached(jti: string): Promise<boolean> {
    const now = Date.now();
    const until = this.jtiCache.get(jti);
    if (until !== undefined && until > now) return true;
    if (until !== undefined) this.jtiCache.delete(jti);
    const valid = await this.redis.isJtiValid(jti);
    if (valid) {
      if (this.jtiCache.size >= JwtHttpGuard.JTI_CACHE_MAX) {
        for (const [k, v] of this.jtiCache) {
          if (v <= now) this.jtiCache.delete(k);
        }
        if (this.jtiCache.size >= JwtHttpGuard.JTI_CACHE_MAX) this.jtiCache.clear();
      }
      this.jtiCache.set(jti, now + JwtHttpGuard.JTI_CACHE_TTL_MS);
    }
    return valid;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('missing_bearer');

    let claims: AccessClaims;
    try {
      claims = await this.jwt.verifyAccessToken(header.slice(7));
    } catch {
      throw new UnauthorizedException('invalid_token');
    }

    // DTO audit P0-V3 — check the shared Redis JTI allowlist that
    // auth-service maintains. `issueSession` in auth writes
    // `jti:<jti>` = '1' with the access-token TTL; `revokeJti` /
    // `revokeJtis` DEL them on logout, `revoke-all`, or password
    // change. Previously this guard only validated the signature +
    // claims shape, so a JWT revoked at auth-service kept working
    // against the relay until its `exp` (15 min default). A stolen
    // token kept draining `/envelopes` and signing
    // `/media/download-url/:key` for the full TTL after the user
    // remote-wiped or rotated identity — exactly the gap the
    // architecture's "session bindings invalidated promptly upon
    // user request" contract is supposed to close.
    if (!(await this.isJtiValidCached(claims.jti))) {
      throw new UnauthorizedException('token_revoked');
    }

    const raw = req.header('x-signal-device-id');
    const n   = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(n) || n < 1) {
      throw new BadRequestException('missing_signal_device_id');
    }

    req.caller = {claims, signalDeviceId: n};
    return true;
  }
}
