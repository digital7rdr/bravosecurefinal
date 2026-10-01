import {Controller, Get, UseGuards} from '@nestjs/common';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {DatabaseService} from '../database/database.service';
import {OrgCpoService} from './org-cpo.service';

export interface ProviderConsoleOrg {
  org_id: string;
  name: string;
  role: 'owner' | 'manager';
  /** Every module for an owner; exactly the owner's grant for a manager. */
  modules: string[];
  /** Branch scope of a delegated manager; null = whole org. */
  department: string | null;
}

export interface ProviderConsoleContext {
  /** password_temporary: the password was issued by an HQ admin (ops console)
   *  and has not been changed by the person since; the console asks them to. */
  user: {id: string; display_name: string | null; password_temporary: boolean};
  /** Security agencies this person may run. Empty = no access to the console. */
  orgs: ProviderConsoleOrg[];
}

/**
 * GET /org/console/context — who may use the service provider web console,
 * and for which agency.
 *
 * The console is for SERVICE PROVIDERS created in the system: an ACTIVE
 * `company` agent (the agency account itself), or an active delegated manager
 * of one. Enterprise workspaces are deliberately left out even though
 * OrgManagerGuard admits their owners: a workspace is a client company, not a
 * security provider, and has no jobs, crew or payouts to run.
 *
 * JwtAuthGuard only, NOT OrgManagerGuard: a signed-in person with no agency
 * must get an empty list (so the console can say so), not a 403 that reads
 * like an outage. The console sends the chosen org_id back as X-Org-Context
 * on every /org/* and /dispatch/* call; OrgManagerGuard re-checks it against
 * the caller's real memberships, so this list is a convenience, never a grant.
 *
 * Read-only, and it reveals nothing the caller cannot already see in
 * GET /auth/me (managed_org, permitted_modules, owns_agency).
 */
@Controller('org/console')
@UseGuards(JwtAuthGuard)
export class ProviderConsoleController {
  constructor(private readonly db: DatabaseService) {}

  @Get('context')
  async context(@CurrentUser() user: AccessClaims): Promise<ProviderConsoleContext> {
    const [me, rows] = await Promise.all([
      this.db.qOne<{id: string; display_name: string | null; password_temporary: boolean}>(
        `SELECT id, display_name,
                (password_set_at IS NULL AND invited_at IS NOT NULL) AS password_temporary
           FROM public.users WHERE id = $1 AND deleted_at IS NULL`,
        [user.sub],
      ),
      this.db.q<{
        org_id: string; name: string | null; role: 'owner' | 'manager';
        permitted_modules: string[] | null; department: string | null;
      }>(
        `SELECT org_id, name, role, permitted_modules, department FROM (
           SELECT a.user_id AS org_id, u.display_name AS name, 'owner' AS role,
                  NULL::text[] AS permitted_modules, NULL::text AS department,
                  0 AS ord, NULL::timestamptz AS joined_at
             FROM agents a
             JOIN public.users u ON u.id = a.user_id AND u.deleted_at IS NULL
            WHERE a.user_id = $1 AND a.type = 'company' AND a.status = 'ACTIVE'
           UNION ALL
           SELECT m.org_user_id, u.display_name, 'manager',
                  m.permitted_modules, m.department,
                  1, m.created_at
             FROM org_members m
             JOIN agents a ON a.user_id = m.org_user_id AND a.type = 'company' AND a.status = 'ACTIVE'
             JOIN public.users u ON u.id = m.org_user_id AND u.deleted_at IS NULL
            WHERE m.member_user_id = $1 AND m.member_role = 'manager'
              AND m.status = 'active' AND m.org_user_id <> $1
         ) t
         ORDER BY ord ASC, joined_at ASC NULLS FIRST`,
        [user.sub],
      ),
    ]);
    const all = [...OrgCpoService.MANAGER_MODULES] as string[];
    return {
      user: {id: user.sub, display_name: me?.display_name ?? null, password_temporary: !!me?.password_temporary},
      orgs: rows.map(r => ({
        org_id: r.org_id,
        name: r.name ?? '',
        role: r.role,
        modules: r.role === 'owner' ? all : (r.permitted_modules ?? []).filter(k => all.includes(k)),
        department: r.department ?? null,
      })),
    };
  }
}
