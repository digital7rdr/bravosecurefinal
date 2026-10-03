import {
  applyDecorators, CanActivate, ExecutionContext, ForbiddenException, Injectable,
  SetMetadata, UseGuards,
} from '@nestjs/common';
import {Reflector} from '@nestjs/core';
import {DatabaseService} from '../database/database.service';
import type {OrgManagerContext} from './org-manager.guard';

/**
 * Server-side enforcement of the modules an org OWNER grants a delegated
 * MANAGER (org_members.permitted_modules, edited on the owner's "Manager
 * Permissions" screen).
 *
 * Until now the grant was presentation only: the app hid the rows a manager
 * was not given, but every /org/* and /dispatch/* route admitted any active
 * manager. A manager granted only "CPO Roster" could still accept offers or
 * read the org's earnings by calling the API directly. This guard closes that.
 *
 * Rules, in order:
 *   1. No @OrgModules on the route → allowed (e.g. GET /org/summary, a
 *      headcount every manager's home screen shows).
 *   2. The caller IS the org (company account or workspace owner: the org id
 *      OrgManagerGuard stamped equals the caller's own id) → allowed. The owner
 *      decides; the owner is never restricted.
 *   3. @OrgOwnerOnly → refused for everyone else.
 *   4. A delegated manager → allowed only if their membership in THE ORG THE
 *      REQUEST RESOLVED TO grants at least ONE of the listed modules. Any-of,
 *      because several screens read the same list (the crew picker on the
 *      missions board and the roster both read GET /org/cpos).
 *
 * NULL and [] are the same: no modules (founder rule, see
 * resolveManagerContext). The grant is re-read from the database on every
 * request, never taken from the token, so revoking a module takes effect on
 * the manager's next call.
 *
 * Runs AFTER OrgManagerGuard (handler-level guards always run after the
 * class-level ones), which is what populates req.orgManager.
 */
export const ORG_MODULES_KEY = 'bravo:org_modules';
export const ORG_OWNER_ONLY = '__owner__';

/** The module keys the owner can grant (mirror of OrgCpoService.MANAGER_MODULES). */
export type OrgModuleKey =
  | 'jobs' | 'portal' | 'compliance' | 'roster' | 'orgChart' | 'dept' | 'earn'
  | 'msg' | 'intel' | 'region' | 'fleet' | 'pro';

/** Admit owners, and managers granted at least one of `keys`. */
export const OrgModules = (...keys: OrgModuleKey[]) =>
  applyDecorators(SetMetadata(ORG_MODULES_KEY, keys), UseGuards(OrgModuleGuard));

/** Admit only the org itself (company account / workspace owner). */
export const OrgOwnerOnly = () =>
  applyDecorators(SetMetadata(ORG_MODULES_KEY, [ORG_OWNER_ONLY]), UseGuards(OrgModuleGuard));

@Injectable()
export class OrgModuleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: DatabaseService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      ORG_MODULES_KEY, [ctx.getHandler(), ctx.getClass()],
    );
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<{orgManager?: OrgManagerContext}>();
    const m = req.orgManager;
    // Fail closed: this guard must never be the first gate on a route.
    if (!m) throw new ForbiddenException('org_manager_access_required');

    if (m.user_id === m.org_user_id) return true;                       // rule 2
    if (required.includes(ORG_OWNER_ONLY)) {                             // rule 3
      throw new ForbiddenException('org_owner_only');
    }

    const row = await this.db.qOne<{permitted_modules: string[] | null}>(
      `SELECT permitted_modules FROM org_members
        WHERE org_user_id = $1 AND member_user_id = $2
          AND member_role = 'manager' AND status = 'active'
        ORDER BY created_at ASC
        LIMIT 1`,
      [m.org_user_id, m.user_id],
    );
    const granted = new Set(row?.permitted_modules ?? []);
    if (required.some(k => granted.has(k))) return true;                 // rule 4
    throw new ForbiddenException(`org_module_not_granted:${required.join('|')}`);
  }
}
