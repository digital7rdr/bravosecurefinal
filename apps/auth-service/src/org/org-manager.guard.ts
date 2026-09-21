import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable,
} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {activeEnterpriseSql} from '../common/guards/tier.guard';
import type {AccessClaims} from '../auth/jwt.service';
import {readOrgContextHeader, pickOrgContext} from './org-context';

/**
 * OrgManagerGuard — authorizes a caller as a MANAGER of a service-provider org.
 *
 * A service provider is the `company` agent's users.id (the single tenant key,
 * the same id department_channels.org_id references). A manager is either:
 *   - that org user itself (the company account), or
 *   - the OWNER of an Enterprise workspace (their own single-tenant org), or
 *   - an org_members row with member_role='manager', status='active'.
 *
 * ⛔ BUYING A SUBSCRIPTION IS NOT ONE OF THEM (F2).
 *
 * There used to be a fourth arm here: any ACTIVE enterprise-tier user was
 * admitted as manager of an implicit org whose id was their own user id. That
 * made the PAYMENT the authorization — frame A4 says "Admin selection alone must
 * never create authority" and "a user without a verified path must not reach
 * Admin controls", and a tier is not a verified path. Measured before removal: a
 * plain enterprise-tier individual with no workspace and no org reached
 * `POST /department/channels` with a 200.
 *
 * The tier still GATES the paid surface — `WorkspaceService.createWorkspace`
 * requires active Enterprise, and `DeptChatAccessGuard` still admits an
 * enterprise individual to the department MODULE. What it no longer does is
 * grant admin authority: the buyer becomes an admin by CREATING the workspace
 * (Path 1b), which is the verified path. Do NOT re-add a tier arm here without
 * re-adding it to `resolveIsOrgManager` too — see the mirror note there.
 *
 * Modeled on AdminGuard (ops/admin.guard.ts): it RE-READS the DB rather than
 * trusting any claim baked into the JWT, so a stale token can't fabricate org
 * ownership. The JWT shape is intentionally NOT changed (auth-token security
 * stop-condition) — org identity is always derived here from org_members.
 *
 * Apply AFTER JwtAuthGuard so `req.user` is populated. Attaches the resolved
 * manager context to `req.orgManager`.
 *
 * NOTE: this is a DIFFERENT trust tier from admin_users (HQ ops staff). A
 * provider manager must never reach ops-only routes, so do not conflate the two.
 */
export interface OrgManagerContext {
  // The user id of the calling manager.
  user_id: string;
  // The org (service provider) this manager governs. For the company account
  // itself this equals user_id; for a delegated manager it's their org.
  org_user_id: string;
  // Department scope (PDF p.9/p.16): NULL = whole org (company account or an
  // unscoped manager); set = a delegated manager who only sees that
  // department's attendance + incidents. Services apply it as a forced filter.
  department: string | null;
}

/**
 * Attach the resolved context and admit. One writer, so the three arms cannot
 * drift in what they stamp.
 */
function stamp(
  req: {orgManager?: OrgManagerContext},
  userId: string,
  row: {org_user_id: string; department: string | null},
): true {
  req.orgManager = {user_id: userId, org_user_id: row.org_user_id, department: row.department ?? null};
  return true;
}

@Injectable()
export class OrgManagerGuard implements CanActivate {
  constructor(private readonly db: DatabaseService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{
      user?: AccessClaims;
      orgManager?: OrgManagerContext;
      headers?: Record<string, unknown>;
    }>();

    const claims = req.user;
    if (!claims) throw new ForbiddenException('Not authenticated');

    /**
     * vs2 item 4 — MULTI-ORG. Authority follows the organisation being viewed.
     *
     * Founder decision 2026-08-12 (Option A): a manager who belongs to several
     * organisations administers whichever one they are currently looking at, and
     * there is no cap on how many they may hold. Slack/Notion/Workspace all
     * behave this way, and the alternative — "you are a manager here in real
     * life but not in the app" — reads as a bug with nowhere to explain it.
     *
     * ⚠️ THE HEADER IS A REQUEST, NEVER A GRANT. It names WHICH of the caller's
     * memberships to use; it can never create one. Every arm below re-queries
     * the caller's real rows and the header only ever NARROWS that set. A
     * client asking for an org it does not belong to is refused, not obeyed —
     * otherwise this header would be a one-line cross-tenant escalation.
     *
     * Absent header = today's behaviour exactly (first matching arm wins), so
     * every existing caller and every older build is unaffected.
     */
    const requested = readOrgContextHeader(req);

    /**
     * All three arms in ONE round trip (50k audit P1-2 — this guard is mounted
     * class-wide on attendance, roster, department, org and three dispatch
     * controllers, and every delegated manager paid 3 sequential queries per
     * request). The UNION ALL preserves each arm's predicate verbatim and the
     * ORDER BY reproduces the historical precedence exactly:
     *
     *   arm 1 — the caller is itself an ACTIVE `company` agent (its own org).
     *           D4-c: a suspended/deactivated company loses manager access.
     *   arm 2 — the caller OWNS an Enterprise workspace (Scope v2 Phase 6).
     *           THIS IS THE ONLY PATH AN ENTERPRISE BUYER HAS since the
     *           tier-only arm was removed (F2): owners have no agents row and
     *           no org_members row, and it must outrank arm 3 so an owner of A
     *           who is also a delegated manager of B resolves to their OWN A.
     *           Lapse-aware (activeEnterpriseSql), matching the client's
     *           owns_workspace.
     *   arm 3 — delegated manager memberships, possibly SEVERAL; created_at
     *           ASC keeps the no-header default deterministic (the oldest
     *           membership every time).
     *
     * COLLECTED, not returned: a single person can hold all three, so the
     * header chooses among them; with no header the first candidate wins,
     * which is the pre-item-4 arm precedence exactly.
     */
    const candidates = await this.db.q<{org_user_id: string; department: string | null}>(
      `SELECT org_user_id, department FROM (
         SELECT 1 AS arm, a.user_id AS org_user_id, NULL::text AS department,
                NULL::timestamptz AS ordered_at
           FROM agents a
          WHERE a.user_id = $1 AND a.type = 'company' AND a.status = 'ACTIVE'
         UNION ALL
         SELECT 2, w.owner_user_id, NULL::text, NULL::timestamptz
           FROM public.org_workspaces w
           JOIN public.users u ON u.id = w.owner_user_id
          WHERE w.owner_user_id = $1
            AND u.deleted_at IS NULL
            AND ${activeEnterpriseSql('u')}
         UNION ALL
         SELECT 3, m.org_user_id, m.department, m.created_at
           FROM org_members m
          WHERE m.member_user_id = $1
            AND m.member_role = 'manager'
            AND m.status = 'active'
       ) t
       ORDER BY arm ASC, ordered_at ASC NULLS FIRST`,
      [claims.sub],
    );
    // NO HEADER ⇒ the first candidate, exactly the old short-circuit result.
    if (!requested && candidates.length > 0) {
      return stamp(req, claims.sub, candidates[0]);
    }

    // ONE choice, across every org this caller may administer. The header can
    // only ever select from this list — it cannot add to it.
    const chosen = pickOrgContext(candidates, requested);
    if (chosen) {
      /**
       * NO "the header is mandatory for writes" RULE HERE. I added one and it
       * was wrong; this comment is so nobody adds it back.
       *
       * The idea was sound in isolation — a write that could land on either of
       * two orgs should say which, because it 200s and files an audit row
       * naming an org the user never chose. What makes it unshippable is that
       * the CLIENT cannot always send one:
       *
       *   - The context is set in exactly two places (the Workspace Hub tile
       *     and invite-accept) and is deliberately NOT persisted, so it is null
       *     after every cold start. The drawer, the CPO shells, the agent
       *     dashboard and every notification deep-link enter the same surface
       *     with no context at all.
       *   - This guard is mounted class-wide on THREE dispatch controllers.
       *     A delegated manager of an agency who is also a manager of a client
       *     workspace — precisely the persona item 4 enables — would have been
       *     403'd on Accept Offer and Claim Job. That is the agency's revenue
       *     lane, killed by a rule meant to protect a settings screen.
       *
       * A server rule can only require what every door already sends. The
       * wrong-org write is defended on the client instead, at the one screen
       * that can actually see which organisation it is drawing
       * (ModuleVisibilitySheet compares the org the response echoes against the
       * org on screen and refuses to save on a mismatch).
       */
      return stamp(req, claims.sub, chosen);
    }

    // NO TIER ARM. There is deliberately no fourth path reading
    // users.subscription_tier here: buying Enterprise is a PAYMENT, not a
    // verified path to authority (frame A4). The buyer reaches admin by
    // creating a workspace, which Path 1b then admits.
    throw new ForbiddenException('org_manager_access_required');
  }
}

/**
 * Tenant-isolation guard rail. Throws if a manager tries to act on an org that
 * is not their own. Mirrors assertRegionScope (ops/admin.guard.ts) — call at the
 * service layer right after resolving the target org from a request param.
 */
export function assertOrgScope(manager: OrgManagerContext, targetOrgId: string): void {
  if (manager.org_user_id !== targetOrgId) {
    throw new ForbiddenException(
      `org_scope_violation:${manager.org_user_id}!=${targetOrgId}`,
    );
  }
}
