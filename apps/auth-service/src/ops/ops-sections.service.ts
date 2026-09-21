import {Injectable, NotFoundException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {assertRegionScope, isGlobalAdmin, type AdminContext} from './admin.guard';
import {AttendanceService} from '../attendance/attendance.service';

/**
 * Enterprise organisations (the /enterprise/departments list + detail).
 *
 * An "organisation" here is a TENANT OWNER: the users row that department
 * channels, org_members, shifts, incidents and join requests all hang off
 * (`org_id` / `org_user_id`). Three sources name one, and none is complete on
 * its own — an enterprise-tier account with no channels yet, a workspace row
 * whose owner was later re-tiered, and an agency (provider) that runs channels
 * on the same tables — so the list is their UNION, deduplicated by user id.
 */
export interface EnterpriseOrgRow {
  id: string;
  display_name: string;
  workspace_name: string | null;
  email: string | null;
  phone_e164: string | null;
  home_region: string | null;
  country_code: string | null;
  subscription_tier: string;
  is_workspace: boolean;
  is_agency: boolean;
  created_at: string;
  suspended_at: string | null;
  channels: number;
  channels_provisioned: number;
  departments: number;
  members: number;
  incidents_open: number;
  join_pending: number;
  last_activity_at: string | null;
}

const ORG_TENANTS_CTE = `
  tenants AS (
    SELECT id AS org_id FROM public.users
     WHERE subscription_tier = 'enterprise' AND deleted_at IS NULL
    UNION
    SELECT owner_user_id FROM public.org_workspaces
    UNION
    SELECT DISTINCT org_id FROM public.department_channels WHERE archived_at IS NULL
  )`;

/**
 * Read models for the 2026-09-03 console sections (IA-07 / IA-08 / SK-06b).
 * Every query here is bounded and read-only.
 */

export interface ConfigStatusRow {
  /** Stable key the console maps to its editor route + copy. */
  key: string;
  /** Rows currently stored (0 = never edited, still on code defaults). */
  rows: number;
  last_changed_at: string | null;
  last_changed_by: string | null;
}

@Injectable()
export class OpsSectionsService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * IA-07 — "when did this config last change, and who changed it?" for every
   * ops-editable surface. The console pairs each row with the app read-path and
   * propagation delay it already knows (config/propagation.ts); only the
   * freshness half needs the database.
   *
   * Each table carries its own updated_by shape, so this is five small scalar
   * queries rather than one clever union — cheaper to read and to change.
   */
  async configStatus(): Promise<{configs: ConfigStatusRow[]; server_now: string}> {
    const [pricing, regions, catalog, prices, grants] = await Promise.all([
      this.db.qOne<{n: string; at: Date | null; by: string | null}>(
        `SELECT COUNT(*)::text AS n, MAX(p.updated_at) AS at,
                (SELECT u.display_name FROM public.service_pricing sp
                   LEFT JOIN public.users u ON u.id = sp.updated_by
                  ORDER BY sp.updated_at DESC NULLS LAST LIMIT 1) AS by
           FROM public.service_pricing p`),
      this.db.qOne<{n: string; at: Date | null; by: string | null}>(
        `SELECT COUNT(*)::text AS n, MAX(r.updated_at) AS at, NULL::text AS by
           FROM public.regions r`),
      this.db.qOne<{n: string; at: Date | null; by: string | null}>(
        `SELECT COUNT(*)::text AS n, MAX(c.updated_at) AS at,
                (SELECT u.display_name FROM public.plan_catalog pc
                   LEFT JOIN public.users u ON u.id = pc.updated_by
                  ORDER BY pc.updated_at DESC NULLS LAST LIMIT 1) AS by
           FROM public.plan_catalog c`),
      this.db.qOne<{n: string; at: Date | null; by: string | null}>(
        `SELECT COUNT(*)::text AS n, MAX(s.updated_at) AS at,
                (SELECT u.display_name FROM public.subscription_prices sp
                   LEFT JOIN public.users u ON u.id = sp.updated_by
                  ORDER BY sp.updated_at DESC NULLS LAST LIMIT 1) AS by
           FROM public.subscription_prices s`),
      // Tier grants have no table of their own — they are users.subscription_tier
      // writes, so the ops_audit row IS the record.
      this.db.qOne<{n: string; at: Date | null; by: string | null}>(
        `SELECT COUNT(*)::text AS n, MAX(a.created_at) AS at,
                (SELECT a2.actor_call FROM public.ops_audit a2
                  WHERE a2.action = 'user.tier.change'
                  ORDER BY a2.created_at DESC LIMIT 1) AS by
           FROM public.ops_audit a
          WHERE a.action = 'user.tier.change'`),
    ]);

    const row = (key: string, r: {n: string; at: Date | null; by: string | null} | null): ConfigStatusRow => ({
      key,
      rows: Number(r?.n ?? 0),
      last_changed_at: r?.at ? new Date(r.at).toISOString() : null,
      last_changed_by: r?.by ?? null,
    });

    return {
      configs: [
        row('service_pricing', pricing),
        row('regions', regions),
        row('plan_catalog', catalog),
        row('subscription_prices', prices),
        row('tier_grants', grants),
      ],
      server_now: new Date().toISOString(),
    };
  }

  /**
   * IA-08 — provider agencies. An agency is a `service_provider` user; what an
   * operator actually needs to judge one is compliance validity and dispatch
   * behaviour, so both ride the list row rather than forcing a drill-down.
   *
   * `offers_30d` / `accepted_30d` / `no_show_30d` are the agency's real dispatch
   * record; `docs_expiring` counts credentials valid today but gone within 30
   * days, which is the queue that prevents a no-provider stall next month.
   */
  listAgencies(q: string | undefined, limit: number) {
    return this.db.q(
      `SELECT u.id, u.display_name, u.email, u.phone_e164, u.home_region,
              u.created_at, u.suspended_at,
              (SELECT COUNT(*)::int FROM public.org_members m
                WHERE m.org_user_id = u.id AND m.status = 'active') AS cpo_count,
              (SELECT COUNT(*)::int FROM public.compliance_credentials c
                WHERE c.subject_user_id = u.id AND c.verified
                  AND c.expires_at > now()) AS docs_valid,
              (SELECT COUNT(*)::int FROM public.compliance_credentials c
                WHERE c.subject_user_id = u.id AND c.verified
                  AND c.expires_at > now()
                  AND c.expires_at < now() + interval '30 days') AS docs_expiring,
              (SELECT COUNT(*)::int FROM public.compliance_credentials c
                WHERE c.subject_user_id = u.id
                  AND (NOT c.verified OR c.expires_at <= now())) AS docs_problem,
              (SELECT COUNT(*)::int FROM public.dispatch_offers o
                WHERE o.provider_user_id = u.id
                  AND o.offered_at > now() - interval '30 days') AS offers_30d,
              (SELECT COUNT(*)::int FROM public.dispatch_offers o
                WHERE o.provider_user_id = u.id AND o.status = 'ACCEPTED'
                  AND o.offered_at > now() - interval '30 days') AS accepted_30d,
              (SELECT COUNT(*)::int FROM public.lite_bookings b
                WHERE b.status = 'AGENCY_NO_SHOW'
                  AND b.updated_at > now() - interval '30 days'
                  AND EXISTS (SELECT 1 FROM public.dispatch_offers o2
                               WHERE o2.booking_id = b.id
                                 AND o2.provider_user_id = u.id
                                 AND o2.status = 'ACCEPTED')) AS no_show_30d
         FROM public.users u
        WHERE u.role = 'service_provider'
          AND u.deleted_at IS NULL
          AND ($1::text IS NULL OR u.display_name ILIKE '%' || $1 || '%'
               OR u.email ILIKE '%' || $1 || '%')
        ORDER BY u.display_name ASC
        LIMIT $2`,
      [q?.trim() || null, limit],
    );
  }

  /** One agency: profile, compliance, roster, and its recent dispatch record. */
  async getAgency(id: string, admin: AdminContext) {
    const agency = await this.db.qOne<{id: string; home_region: string | null}>(
      `SELECT id, display_name, email, phone_e164, home_region, country_code,
              created_at, suspended_at, suspended_reason
         FROM public.users
        WHERE id = $1 AND role = 'service_provider'`,
      [id],
    );
    if (!agency) throw new NotFoundException('agency_not_found');
    // Same rule as every other by-id ops read (Audit AUTH-01): a region-scoped
    // admin may not enumerate another tenant's providers by UUID.
    if (agency.home_region) assertRegionScope(admin, agency.home_region);

    const [credentials, armed, roster, offers] = await Promise.all([
      this.db.q(
        `SELECT id, kind, region_code, reference, issued_at, expires_at, verified, created_at
           FROM public.compliance_credentials
          WHERE subject_user_id = $1
          ORDER BY expires_at DESC
          LIMIT 50`, [id]),
      this.db.q(
        `SELECT a.id, a.cpo_user_id, u.display_name AS cpo_name, a.region_code,
                a.permit_ref, a.expires_at, a.authorized, a.created_at
           FROM public.armed_authorizations a
           LEFT JOIN public.users u ON u.id = a.cpo_user_id
          WHERE a.cpo_user_id IN (
                  SELECT member_user_id FROM public.org_members
                   WHERE org_user_id = $1 AND status = 'active')
          ORDER BY a.created_at DESC
          LIMIT 50`, [id]),
      this.db.q(
        `SELECT m.member_user_id AS user_id, u.display_name, u.phone_e164,
                m.status, m.created_at,
                ag.status AS agent_status, ag.on_duty
           FROM public.org_members m
           LEFT JOIN public.users u ON u.id = m.member_user_id
           LEFT JOIN public.agents ag ON ag.user_id = m.member_user_id
          WHERE m.org_user_id = $1
          ORDER BY m.status ASC, u.display_name ASC
          LIMIT 200`, [id]),
      this.db.q(
        `SELECT o.id, o.booking_id, o.rank, o.distance_km, o.status,
                o.offered_at, o.responded_at, o.reject_reason,
                b.status AS booking_status, b.region_label, b.pickup_time, b.service
           FROM public.dispatch_offers o
           LEFT JOIN public.lite_bookings b ON b.id = o.booking_id
          WHERE o.provider_user_id = $1
          ORDER BY o.offered_at DESC
          LIMIT 50`, [id]),
    ]);

    return {agency, credentials, armed, roster, offers};
  }

  /** Enterprise section landing. */
  async enterpriseSummary() {
    const row = await this.db.qOne<{
      workspaces: string; join_pending: string; incidents_open: string;
      incidents_critical_24h: string;
    }>(
      `SELECT
        (SELECT COUNT(*)::text FROM public.users
          WHERE subscription_tier = 'enterprise' AND deleted_at IS NULL) AS workspaces,
        (SELECT COUNT(*)::text FROM public.enterprise_join_requests
          WHERE status = 'pending') AS join_pending,
        (SELECT COUNT(*)::text FROM public.incident_reports
          WHERE status NOT IN ('resolved','closed')) AS incidents_open,
        (SELECT COUNT(*)::text FROM public.incident_reports
          WHERE severity = 'critical'
            AND created_at >= now() - interval '24 hours') AS incidents_critical_24h`,
    );
    return {
      workspaces: Number(row?.workspaces ?? 0),
      join_pending: Number(row?.join_pending ?? 0),
      incidents_open: Number(row?.incidents_open ?? 0),
      incidents_critical_24h: Number(row?.incidents_critical_24h ?? 0),
    };
  }

  /**
   * SK-06(b) — the cross-workspace join queue. READ-ONLY on purpose: deciding a
   * request grants workspace membership and seeds E2EE scope as that org's
   * manager, which is not an ops capability today (audit §11 Q5).
   */
  listJoinRequests(status: string | undefined, limit: number) {
    const st = status && ['pending', 'approved', 'declined'].includes(status) ? status : 'pending';
    return this.db.q(
      `SELECT r.id, r.status, r.created_at, r.decided_at,
              r.applicant_name, r.applicant_email, r.applicant_phone, r.message,
              o.display_name AS workspace_name, o.id AS workspace_id,
              ref.display_name AS referrer_name,
              CASE WHEN c.archived_at IS NULL THEN c.name END AS team_name,
              d.display_name AS decided_by_name
         FROM public.enterprise_join_requests r
         LEFT JOIN public.users o   ON o.id = r.org_user_id
         LEFT JOIN public.users ref ON ref.id = r.referrer_user_id
         LEFT JOIN public.users d   ON d.id = r.decided_by
         LEFT JOIN public.department_channels c ON c.id = r.team_channel_id
        WHERE r.status = $1
        ORDER BY r.created_at ASC
        LIMIT $2`,
      [st, limit],
    );
  }
  /**
   * The organisation list behind /enterprise/departments. One row per tenant
   * owner with the counts an operator triages on; every count is a bounded
   * correlated scalar over an org-keyed column, never a join fan-out.
   *
   * `q` is a bound ILIKE fragment (name / workspace name / email), never
   * interpolated. A region-scoped admin sees only orgs in their region or
   * with no region recorded — the same rule getAgency applies by id.
   */
  async listEnterpriseOrgs(
    q: string | undefined, limit: number, admin: AdminContext,
  ): Promise<EnterpriseOrgRow[]> {
    // B-636 rule: LIKE wildcards typed by a user are ESCAPED (backslash first),
    // so "%" or "_" in the box narrows the list instead of matching everything.
    const needle = q && q.trim() ? q.trim().replace(/[\\%_]/g, m => `\\${m}`) : null;
    const region = isGlobalAdmin(admin) || !admin.region ? null : admin.region;
    return this.db.q<EnterpriseOrgRow>(
      `WITH ${ORG_TENANTS_CTE}
       SELECT u.id, u.display_name, w.name AS workspace_name,
              u.email, u.phone_e164, u.home_region, u.country_code,
              u.subscription_tier, u.created_at, u.suspended_at,
              (w.owner_user_id IS NOT NULL) AS is_workspace,
              (a.user_id IS NOT NULL) AS is_agency,
              (SELECT COUNT(*)::int FROM public.department_channels c
                WHERE c.org_id = u.id AND c.archived_at IS NULL) AS channels,
              (SELECT COUNT(*)::int FROM public.department_channels c
                WHERE c.org_id = u.id AND c.archived_at IS NULL
                  AND c.group_conversation_id IS NOT NULL) AS channels_provisioned,
              (SELECT COUNT(DISTINCT c.department)::int FROM public.department_channels c
                WHERE c.org_id = u.id AND c.archived_at IS NULL AND c.department IS NOT NULL) AS departments,
              (SELECT COUNT(*)::int FROM public.org_members m
                WHERE m.org_user_id = u.id AND m.status = 'active') AS members,
              (SELECT COUNT(*)::int FROM public.incident_reports i
                WHERE i.org_user_id = u.id AND i.status NOT IN ('resolved','closed')) AS incidents_open,
              (SELECT COUNT(*)::int FROM public.enterprise_join_requests r
                WHERE r.org_user_id = u.id AND r.status = 'pending') AS join_pending,
              (SELECT MAX(l.created_at) FROM public.org_audit_log l
                WHERE l.org_user_id = u.id) AS last_activity_at
         FROM tenants t
         JOIN public.users u ON u.id = t.org_id
         LEFT JOIN public.org_workspaces w ON w.owner_user_id = u.id
         LEFT JOIN public.agents a ON a.user_id = u.id AND a.type = 'company'
        WHERE u.deleted_at IS NULL
          AND ($1::text IS NULL
               OR u.display_name ILIKE '%' || $1 || '%'
               OR w.name ILIKE '%' || $1 || '%'
               OR u.email::text ILIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR u.home_region IS NULL OR u.home_region = $2)
        ORDER BY last_activity_at DESC NULLS LAST, u.display_name ASC
        LIMIT $3`,
      [needle, region, limit],
    );
  }

  /**
   * One organisation, everything an operator can see about it without reading
   * message content: profile + workspace settings, the whole (un-archived)
   * channel tree with hierarchy + policy fields, people by role, incidents,
   * join requests, invite links, a 30-day attendance fold and the org audit
   * feed. Post content is E2EE on the relay and is NOT here.
   */
  async getEnterpriseOrg(id: string, admin: AdminContext) {
    const org = await this.db.qOne<EnterpriseOrgRow & {
      role: string; level_names: string[] | null; hidden_modules: string[] | null;
      settings_updated_at: string | null; agency_status: string | null;
      suspended_reason: string | null; channels_archived: number;
    }>(
      `WITH ${ORG_TENANTS_CTE}
       SELECT u.id, u.display_name, w.name AS workspace_name,
              u.email, u.phone_e164, u.home_region, u.country_code,
              u.subscription_tier, u.role, u.created_at, u.suspended_at, u.suspended_reason,
              (w.owner_user_id IS NOT NULL) AS is_workspace,
              (a.user_id IS NOT NULL) AS is_agency,
              a.status::text AS agency_status,
              s.level_names, s.hidden_modules, s.updated_at AS settings_updated_at,
              (SELECT COUNT(*)::int FROM public.department_channels c
                WHERE c.org_id = u.id AND c.archived_at IS NULL) AS channels,
              (SELECT COUNT(*)::int FROM public.department_channels c
                WHERE c.org_id = u.id AND c.archived_at IS NOT NULL) AS channels_archived,
              (SELECT COUNT(*)::int FROM public.department_channels c
                WHERE c.org_id = u.id AND c.archived_at IS NULL
                  AND c.group_conversation_id IS NOT NULL) AS channels_provisioned,
              (SELECT COUNT(DISTINCT c.department)::int FROM public.department_channels c
                WHERE c.org_id = u.id AND c.archived_at IS NULL AND c.department IS NOT NULL) AS departments,
              (SELECT COUNT(*)::int FROM public.org_members m
                WHERE m.org_user_id = u.id AND m.status = 'active') AS members,
              (SELECT COUNT(*)::int FROM public.incident_reports i
                WHERE i.org_user_id = u.id AND i.status NOT IN ('resolved','closed')) AS incidents_open,
              (SELECT COUNT(*)::int FROM public.enterprise_join_requests r
                WHERE r.org_user_id = u.id AND r.status = 'pending') AS join_pending,
              (SELECT MAX(l.created_at) FROM public.org_audit_log l
                WHERE l.org_user_id = u.id) AS last_activity_at
         FROM tenants t
         JOIN public.users u ON u.id = t.org_id
         LEFT JOIN public.org_workspaces w ON w.owner_user_id = u.id
         LEFT JOIN public.agents a ON a.user_id = u.id AND a.type = 'company'
         LEFT JOIN public.org_workspace_settings s ON s.org_user_id = u.id
        WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [id],
    );
    if (!org) throw new NotFoundException('organisation_not_found');
    // Same rule as every other by-id ops read (Audit AUTH-01): a region-scoped
    // admin may not enumerate another region's tenants by UUID.
    if (org.home_region) assertRegionScope(admin, org.home_region);

    const status = AttendanceService.effectiveField('attendance_status');
    const [channels, members, incidents, joinRequests, invites, attendance, shifts, activity] =
      await Promise.all([
        this.db.q(
          `SELECT c.id, c.name, c.description, c.department, c.channel_type, c.access,
                  c.parent_id, c.level, c.post_mode, c.is_broadcast, c.is_lateral,
                  c.created_at, c.name_changed_at,
                  cb.display_name AS created_by_name,
                  (c.group_conversation_id IS NOT NULL) AS provisioned,
                  (SELECT COUNT(*)::int FROM public.department_channel_members m
                    WHERE m.channel_id = c.id) AS member_count,
                  (SELECT COUNT(*)::int FROM public.department_channel_members m
                    WHERE m.channel_id = c.id AND m.role = 'admin') AS admin_count,
                  (SELECT MAX(m.last_read_at) FROM public.department_channel_members m
                    WHERE m.channel_id = c.id) AS last_read_at
             FROM public.department_channels c
             LEFT JOIN public.users cb ON cb.id = c.created_by
            WHERE c.org_id = $1 AND c.archived_at IS NULL
            ORDER BY c.level ASC, c.created_at ASC
            LIMIT 1000`, [id]),
        this.db.q(
          `SELECT m.member_user_id AS user_id, u.display_name, u.avatar_url,
                  m.member_role, m.status, m.department, m.call_sign, m.created_at,
                  m.suspended_until, ag.status::text AS agent_status, ag.on_duty
             FROM public.org_members m
             LEFT JOIN public.users u ON u.id = m.member_user_id
             LEFT JOIN public.agents ag ON ag.user_id = m.member_user_id
            WHERE m.org_user_id = $1 AND m.status <> 'removed'
            ORDER BY CASE m.member_role WHEN 'manager' THEN 0 WHEN 'cpo' THEN 1 ELSE 2 END,
                     m.status ASC, u.display_name ASC
            LIMIT 500`, [id]),
        this.db.q(
          `SELECT i.id, i.ref, i.category, i.severity, i.status, i.department,
                  i.created_at, i.updated_at, su.display_name AS submitter_name,
                  au.display_name AS assigned_to_name
             FROM public.incident_reports i
             LEFT JOIN public.users su ON su.id = i.submitter_id
             LEFT JOIN public.users au ON au.id = i.assigned_to
            WHERE i.org_user_id = $1
            ORDER BY CASE WHEN i.status IN ('resolved','closed') THEN 1 ELSE 0 END,
                     i.updated_at DESC
            LIMIT 50`, [id]),
        this.db.q(
          `SELECT r.id, r.status, r.applicant_name, r.applicant_email, r.applicant_phone,
                  r.created_at, r.decided_at,
                  CASE WHEN c.archived_at IS NULL THEN c.name END AS team_name,
                  ref.display_name AS referrer_name, d.display_name AS decided_by_name
             FROM public.enterprise_join_requests r
             LEFT JOIN public.department_channels c ON c.id = r.team_channel_id
             LEFT JOIN public.users ref ON ref.id = r.referrer_user_id
             LEFT JOIN public.users d ON d.id = r.decided_by
            WHERE r.org_user_id = $1
            ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC
            LIMIT 50`, [id]),
        this.db.qOne<{total: number; active: number; accepted: number; revoked: number}>(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE accepted_at IS NULL AND revoked_at IS NULL
                                     AND (expires_at IS NULL OR expires_at > now()))::int AS active,
                  COUNT(*) FILTER (WHERE accepted_at IS NOT NULL)::int AS accepted,
                  COUNT(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked
             FROM public.enterprise_referral_links
            WHERE org_user_id = $1`, [id]),
        this.db.q<{attendance_status: string | null; n: string}>(
          `SELECT ${status} AS attendance_status, COUNT(*)::text AS n
             FROM public.cpo_shift_sessions ses
            WHERE ses.org_user_id = $1 AND ses.clock_in_at >= now() - interval '30 days'
            GROUP BY 1`, [id]),
        this.db.qOne<{pending_review: number; shifts_upcoming: number; sessions_open: number}>(
          `SELECT (SELECT COUNT(*)::int FROM public.cpo_shift_sessions ses
                    WHERE ses.org_user_id = $1 AND ses.review_status = 'pending') AS pending_review,
                  (SELECT COUNT(*)::int FROM public.cpo_shifts sh
                    WHERE sh.org_user_id = $1 AND sh.archived_at IS NULL AND sh.end_at >= now()) AS shifts_upcoming,
                  (SELECT COUNT(*)::int FROM public.cpo_shift_sessions ses
                    WHERE ses.org_user_id = $1 AND ses.status = 'open') AS sessions_open`, [id]),
        this.db.q(
          `SELECT l.id, l.action, l.target_kind, l.target_id, l.metadata, l.created_at,
                  u.display_name AS actor_name
             FROM public.org_audit_log l
             LEFT JOIN public.users u ON u.id = l.actor_id
            WHERE l.org_user_id = $1
            ORDER BY l.created_at DESC
            LIMIT 100`, [id]),
      ]);

    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of attendance) {
      counts[r.attendance_status ?? 'unspecified'] = Number(r.n);
      total += Number(r.n);
    }

    return {
      org,
      channels,
      members,
      incidents,
      join_requests: joinRequests,
      invites: invites ?? {total: 0, active: 0, accepted: 0, revoked: 0},
      attendance_30d: {
        counts, total,
        pending_review: shifts?.pending_review ?? 0,
        shifts_upcoming: shifts?.shifts_upcoming ?? 0,
        sessions_open: shifts?.sessions_open ?? 0,
      },
      activity,
    };
  }
}
