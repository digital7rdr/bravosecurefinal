import {BadRequestException, Injectable} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {GULF_TODAY_SQL} from '../pro-applications/gulf-day';

/**
 * Provider console Phase 2 (2026-10-03): the agency's Secure Pro work and its
 * payout statement. Both read-only, both scoped to the org OrgManagerGuard
 * resolved (never a request parameter).
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ProAssignmentView {
  id: string;
  application_id: string;
  member_name: string | null;
  coverage_area: string | null;
  officer_user_id: string;
  officer_name: string | null;
  officer_call_sign: string | null;
  starts_on: string;
  ends_on: string;
  status: 'ASSIGNED' | 'COMPLETED' | 'CANCELLED';
  authorized: boolean;
  on_today: boolean;
  dates_in_range: string[];
  note: string | null;
}

@Injectable()
export class OrgProviderExtrasService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Secure Pro assignments HQ gave to THIS agency's officers.
   *
   * HQ schedules Pro (ops console → Secure Pro); the agency sees which of its
   * officers protect which member, on which dates, so it can plan its roster.
   * The mission code is NOT returned: it is the officer's own key to open the
   * mission in the app and stays between HQ and the officer.
   */
  async proAssignments(orgUserId: string, scope: 'current' | 'past'): Promise<{assignments: ProAssignmentView[]}> {
    const current = scope === 'current';
    const rows = await this.db.q<ProAssignmentView>(
      `SELECT pca.id, pca.application_id,
              mu.display_name AS member_name, pa.coverage_area,
              pca.cpo_user_id AS officer_user_id, cu.display_name AS officer_name,
              om.call_sign AS officer_call_sign,
              pca.starts_on::text AS starts_on, pca.ends_on::text AS ends_on,
              pca.status, (pca.authorized_at IS NOT NULL AND pca.revoked_at IS NULL) AS authorized,
              (pca.status = 'ASSIGNED' AND ${GULF_TODAY_SQL} BETWEEN pca.starts_on AND pca.ends_on) AS on_today,
              COALESCE((
                SELECT array_agg(d::text ORDER BY d)
                  FROM pro_plan_missions pm, unnest(pm.mission_dates) d
                 WHERE pm.id = pca.mission_id AND d BETWEEN pca.starts_on AND pca.ends_on
              ), ARRAY[]::text[]) AS dates_in_range,
              pca.note
         FROM pro_cpo_assignments pca
         JOIN pro_applications pa ON pa.id = pca.application_id
         JOIN public.users mu ON mu.id = pa.user_id
         LEFT JOIN public.users cu ON cu.id = pca.cpo_user_id
         LEFT JOIN org_members om ON om.org_user_id = pca.org_user_id AND om.member_user_id = pca.cpo_user_id
        WHERE pca.org_user_id = $1
          AND ${current
            ? `pca.status = 'ASSIGNED' AND pca.ends_on >= ${GULF_TODAY_SQL}`
            : `(pca.status <> 'ASSIGNED' OR pca.ends_on < ${GULF_TODAY_SQL})`}
        ORDER BY ${current ? 'pca.starts_on ASC' : 'pca.ends_on DESC'}
        LIMIT 300`,
      [orgUserId],
    );
    return {assignments: rows};
  }

  /**
   * Payout statement for a date range: every job whose money is settled or
   * settling, with totals, plus a 12-month summary for the chart/table.
   * Same escrow columns as GET /org/earnings (the money that actually moved).
   * Dates are the job's end (or pick-up when it never started), Gulf time.
   */
  async statement(orgUserId: string, from?: string, to?: string): Promise<{
    from: string; to: string;
    totals: {jobs: number; gross_credits: number; fee_credits: number; net_credits: number; pending_credits: number};
    rows: Array<Record<string, unknown>>;
    months: Array<{month: string; jobs: number; gross_credits: number; fee_credits: number; net_credits: number; pending_credits: number}>;
  }> {
    const today = new Date().toISOString().slice(0, 10);
    const f = from ?? `${today.slice(0, 7)}-01`;
    const t = to ?? today;
    if (!ISO_DATE.test(f) || !ISO_DATE.test(t)) throw new BadRequestException('dates_must_be_YYYY-MM-DD');
    if (f > t) throw new BadRequestException('from_after_to');
    const days = (Date.parse(`${t}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`)) / 86_400_000;
    if (!Number.isFinite(days) || days > 366) throw new BadRequestException('range_max_366_days');

    const DAY = `((COALESCE(m.ended_at, b.pickup_time) AT TIME ZONE 'Asia/Dubai')::date)`;
    const BASE = `
      FROM escrow_holds eh
      JOIN lite_bookings b ON b.id = eh.booking_id
      LEFT JOIN missions m ON m.booking_id = eh.booking_id AND m.status <> 'ABORTED'
     WHERE eh.provider_user_id = $1
       AND eh.status IN ('PENDING_RELEASE', 'RELEASED', 'PARTIAL', 'DISPUTED')`;

    const rows = await this.db.q<{
      booking_id: string; short_code: string | null; service: string; task_type: string | null;
      region_label: string; job_date: string; settled_at: Date | null; hold_status: string;
      gross_credits: number; platform_fee_credits: number | null; to_provider_credits: number | null;
    }>(
      `SELECT eh.booking_id, m.short_code, b.service, b.task_type, b.region_label,
              ${DAY}::text AS job_date, eh.settled_at, eh.status AS hold_status,
              eh.gross_credits, eh.platform_fee_credits, eh.to_provider_credits
         ${BASE}
         AND ${DAY} BETWEEN $2::date AND $3::date
        ORDER BY ${DAY} DESC, eh.booking_id
        LIMIT 5000`,
      [orgUserId, f, t],
    );
    const settled = (s: string) => s === 'RELEASED' || s === 'PARTIAL';
    const totals = {jobs: 0, gross_credits: 0, fee_credits: 0, net_credits: 0, pending_credits: 0};
    for (const r of rows) {
      totals.jobs++;
      if (settled(r.hold_status)) {
        totals.gross_credits += r.gross_credits;
        totals.fee_credits += r.platform_fee_credits ?? 0;
        totals.net_credits += r.to_provider_credits ?? 0;
      } else {
        totals.pending_credits += r.gross_credits;
      }
    }

    const months = await this.db.q<{month: string; jobs: number; gross_credits: number; fee_credits: number; net_credits: number; pending_credits: number}>(
      `SELECT to_char(date_trunc('month', ${DAY}), 'YYYY-MM') AS month,
              count(*)::int AS jobs,
              COALESCE(sum(eh.gross_credits) FILTER (WHERE eh.status IN ('RELEASED','PARTIAL')), 0)::int AS gross_credits,
              COALESCE(sum(eh.platform_fee_credits) FILTER (WHERE eh.status IN ('RELEASED','PARTIAL')), 0)::int AS fee_credits,
              COALESCE(sum(eh.to_provider_credits) FILTER (WHERE eh.status IN ('RELEASED','PARTIAL')), 0)::int AS net_credits,
              COALESCE(sum(eh.gross_credits) FILTER (WHERE eh.status NOT IN ('RELEASED','PARTIAL')), 0)::int AS pending_credits
         ${BASE}
         AND ${DAY} >= (date_trunc('month', now() AT TIME ZONE 'Asia/Dubai') - interval '11 months')::date
        GROUP BY 1
        ORDER BY 1 DESC`,
      [orgUserId],
    );

    return {
      from: f, to: t, totals,
      rows: rows.map(r => ({...r, settled_at: r.settled_at ? new Date(r.settled_at).toISOString() : null})),
      months,
    };
  }
}
