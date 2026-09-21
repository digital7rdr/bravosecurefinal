import {CanActivate, ExecutionContext, ForbiddenException, Injectable, Optional} from '@nestjs/common';
import {DatabaseService} from '../../database/database.service';
import {resolveSessionGate} from '../../auth/account-kind';
import {RedisService} from '../../redis/redis.service';
import {readAccountGate, writeAccountGate} from '../services/account-gate-cache';
import type {AccessClaims} from '../../auth/jwt.service';

/**
 * CpoSessionGuard — mid-session revocation for managed CPOs (§35A §B).
 *
 * Modeled on OrgManagerGuard: the discriminator is never a JWT claim
 * (auth-token security stop-condition), and ONLY callers that resolve to
 * account_kind='cpo' are gated. A CPO whose org_members.status is no longer
 * 'active' (suspended / removed) is ejected with `agency_access_ended`;
 * agency and individual callers pass through untouched.
 *
 * Scale note (50k audit): the raw resolver ran the 6-way ACCOUNT_KIND_SQL
 * join on EVERY request of the whole agent API surface. The result is now
 * cached in Redis for 30s — revocation stays immediate because every
 * org_members mutation calls `bustAccountGate` (cluster-wide DEL); the TTL
 * only backstops a missed bust. Redis down ⇒ falls through to the DB read.
 *
 * Apply AFTER JwtAuthGuard (so req.user is populated) on CPO-scoped routes. Do
 * NOT apply it to /auth/me — the app must still be able to read membership_status
 * there to route a revoked CPO to the "Your agency access has ended" screen.
 * No "skip in dev" branch.
 */
@Injectable()
export class CpoSessionGuard implements CanActivate {
  constructor(
    private readonly db: DatabaseService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{user?: AccessClaims}>();
    const claims = req.user;
    if (!claims) throw new ForbiddenException('Not authenticated');

    let gate = await readAccountGate(this.redis, claims.sub);
    if (!gate) {
      gate = await resolveSessionGate(this.db, claims.sub);
      await writeAccountGate(this.redis, claims.sub, gate);
    }
    if (gate.account_kind === 'cpo' && gate.membership_status !== 'active') {
      throw new ForbiddenException('agency_access_ended');
    }
    return true;
  }
}
