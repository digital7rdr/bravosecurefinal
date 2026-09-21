import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable,
  SetMetadata,
} from '@nestjs/common';
import {Reflector} from '@nestjs/core';
import {DatabaseService} from '../database/database.service';
import type {AccessClaims} from '../auth/jwt.service';

/**
 * B-818 (founder, 2026-09-07) — four console admin LEVELS on top of the legacy
 * rank ladder. A role is (rank × domains):
 *
 *   SUPER_ADMIN          rank 3 · every domain · mints accounts, changes roles
 *   OPERATION_ADMIN      rank 2 · operations   (Lite, Executive, Secure Pro +
 *                                               the people/finance/config they run on)
 *   COMMUNICATION_ADMIN  rank 2 · communication (messenger, Enterprise workspaces)
 *   RISK_ADMIN           rank 2 · risk          (VBG monitoring, SOS)
 *
 * Legacy: ADMIN ≡ SUPER_ADMIN (rank 3, all domains); SUPERVISOR (2) and OPS (1)
 * see every domain and stay region-scoped. `@RequireRoles(...)` keeps its 92
 * call sites unchanged: it now means "at least the LOWEST rank named", and the
 * guard adds the domain check from the request path (`domainOfPath`), so a
 * RISK_ADMIN is refused on /ops/bookings/:id/approve even though their rank
 * would pass a SUPERVISOR gate. The console mirrors this in lib/rbac.ts.
 */
export type AdminRole =
  | 'OPS' | 'SUPERVISOR' | 'ADMIN'
  | 'SUPER_ADMIN' | 'OPERATION_ADMIN' | 'COMMUNICATION_ADMIN' | 'RISK_ADMIN';

export type AdminDomain = 'operations' | 'communication' | 'risk';
export const ALL_DOMAINS: readonly AdminDomain[] = ['operations', 'communication', 'risk'];

const RANK: Record<AdminRole, 1 | 2 | 3> = {
  OPS: 1, SUPERVISOR: 2, ADMIN: 3,
  SUPER_ADMIN: 3, OPERATION_ADMIN: 2, COMMUNICATION_ADMIN: 2, RISK_ADMIN: 2,
};

export function roleRank(role: AdminRole): 1 | 2 | 3 {
  return RANK[role] ?? 1;
}

export function isSuperAdmin(role: AdminRole): boolean {
  return role === 'ADMIN' || role === 'SUPER_ADMIN';
}

/** The domains a role may act in. Legacy ranked roles see every domain. */
export function roleDomains(role: AdminRole): readonly AdminDomain[] {
  switch (role) {
    case 'OPERATION_ADMIN':     return ['operations'];
    case 'COMMUNICATION_ADMIN': return ['communication'];
    case 'RISK_ADMIN':          return ['risk'];
    default:                    return ALL_DOMAINS;
  }
}

/**
 * "At least the lowest rank named" — the exact semantics every existing
 * `@RequireRoles('SUPERVISOR', 'ADMIN')` / `@RequireRoles('ADMIN')` site had
 * under the ladder, now also satisfied by the new roles at their rank.
 */
export function satisfiesRoles(role: AdminRole, required: readonly AdminRole[]): boolean {
  if (required.length === 0) return true;
  const floor = Math.min(...required.map(r => roleRank(r)));
  return roleRank(role) >= floor;
}

/**
 * Which domain an ops route belongs to, from its path. `'any'` is the shared
 * surface every admin gets (dashboard, feed, own profile, audit reads);
 * `'platform'` is super-only (console accounts). Unknown /ops paths default to
 * 'any' — a NEW domain-specific route must be added here (pinned by spec), the
 * failure mode being "visible to every admin", never "locked out".
 */
export function domainOfPath(path: string): AdminDomain | 'any' | 'platform' {
  // Critic P0 — Express routes case-INsensitively by default, so
  // `/ops/BOOKINGS/:id/approve` reaches the bookings handler; the map must
  // classify it the same way or the whole domain check is one capital away
  // from nothing.
  const p = path.split('?')[0].toLowerCase();
  if (/^\/ops\/admins(\/|$)/.test(p)) return 'platform';
  if (/^\/ops\/(sos|vbg)(\/|$)/.test(p)) return 'risk';
  if (/^\/ops\/(deptchat|departments|enterprise|subscription|audit-log)(\/|$)/.test(p)) return 'communication';
  if (/^\/ops\/(bookings|jobs|missions|agents|applications|armed|compliance|pool|wallets|disputes|finance|users|broadcasts|dispatch|pro-applications|pro-management|protection|service-pricing|regions|referral-codes|referral-campaigns|agencies)(\/|$)/.test(p)) {
    return 'operations';
  }
  return 'any';
}

export function canActInDomain(role: AdminRole, domain: AdminDomain | 'any' | 'platform'): boolean {
  if (domain === 'any') return true;
  if (domain === 'platform') return isSuperAdmin(role);
  return roleDomains(role).includes(domain);
}

export const REQUIRED_ROLES_KEY = 'ops_required_roles';

/**
 * Decorator to restrict a handler to specific admin roles.
 * Example: `@RequireRoles('SUPERVISOR', 'ADMIN')`.
 */
export const RequireRoles = (...roles: AdminRole[]) =>
  SetMetadata(REQUIRED_ROLES_KEY, roles);

export interface AdminContext {
  user_id: string;
  role: AdminRole;
  call_sign: string;
  region: string;
}

/**
 * Audit fix 1.5 — region/tenant scoping helper.
 *
 * Bravo runs ops admins per-region (e.g. AE, SA, BD). A Saudi admin
 * approving a UAE booking is a tenant-isolation violation. We enforce
 * `admin.region === record.region` at the service layer for any flow
 * that touches a region-bound record (bookings, missions).
 *
 * Q4 default — `ADMIN` is treated as global (bypasses the region check)
 * because the founders + on-call leads are ADMIN-tier and need the
 * ability to step into any region. `OPS` and `SUPERVISOR` stay scoped.
 * If Q4 ever lands as "no global admins", flip the body to always
 * return false.
 */
export function isGlobalAdmin(admin: {role: AdminRole}): boolean {
  // B-818 — a domain admin controls its whole domain across regions; only the
  // legacy ranked OPS / SUPERVISOR stay pinned to their region.
  return isSuperAdmin(admin.role) || roleDomains(admin.role).length < ALL_DOMAINS.length;
}

/**
 * Throws ForbiddenException if the admin can't operate on a record
 * from the given region. Use at the service layer right after the
 * booking/mission row is read.
 */
export function assertRegionScope(admin: AdminContext, recordRegion: string): void {
  if (isGlobalAdmin(admin)) return;
  if (admin.region && admin.region !== recordRegion) {
    throw new ForbiddenException(`region_scope_violation:${admin.region}!=${recordRegion}`);
  }
}

/**
 * AdminGuard — verifies that the JWT subject is a row in `admin_users`
 * (active = TRUE) and optionally that their role satisfies any
 * `@RequireRoles(…)` metadata on the handler. Attaches the admin record
 * to `req.admin` for controllers to use.
 *
 * Apply AFTER JwtAuthGuard so `req.user` is already populated.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly db: DatabaseService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{
      user?: AccessClaims;
      admin?: AdminContext;
    }>();

    const claims = req.user;
    if (!claims) throw new ForbiddenException('Not authenticated');

    const row = await this.db.qOne<{
      user_id: string; role: AdminRole; call_sign: string; region: string;
    }>(
      `SELECT user_id, role, call_sign, region
         FROM admin_users
        WHERE user_id = $1 AND active = TRUE`,
      [claims.sub],
    );
    if (!row) throw new ForbiddenException('Admin access required');

    // Stamp last_active so the console can show who's online.
    await this.db.q(
      `UPDATE admin_users SET last_active_at = NOW() WHERE user_id = $1`,
      [claims.sub],
    );

    req.admin = row;

    const required = this.reflector.getAllAndOverride<AdminRole[] | undefined>(
      REQUIRED_ROLES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (required && required.length > 0 && !satisfiesRoles(row.role, required)) {
      throw new ForbiddenException(
        `Requires one of: ${required.join(', ')}. You are ${row.role}.`,
      );
    }
    // B-818 — the domain check. Path-based so the 92 @RequireRoles sites stay
    // as they are; a domain admin is refused outside its domain regardless of
    // rank, and only a super admin reaches the platform surface.
    const url = (req as {originalUrl?: string; url?: string}).originalUrl
      ?? (req as {url?: string}).url ?? '';
    const domain = domainOfPath(url);
    if (!canActInDomain(row.role, domain)) {
      throw new ForbiddenException(`domain_scope_violation:${domain}`);
    }
    return true;
  }
}
