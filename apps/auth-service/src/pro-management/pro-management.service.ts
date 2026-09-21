import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import * as crypto from 'node:crypto';
import {DatabaseService} from '../database/database.service';
import {PasswordService} from '../common/services/password.service';
import {OrgCpoService} from '../org/org-cpo.service';
import {MissionEventsService} from '../ops/mission-events.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import {type AdminContext} from '../ops/admin.guard';
import {GULF_TODAY_SQL, todayGulf} from '../pro-applications/gulf-day';
import {
  CreateInternalOrgDto, CreateOpsCpoDto, CreateProAssignmentDto,
  ScheduleRequestWithCposDto, SuspendCpoDto,
} from './dto/pro-management.dto';

// Mission-code alphabet — no 0/O/1/I lookalikes; typed by a CPO on a phone.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function mintMissionCode(): string {
  const bytes = crypto.randomBytes(6);
  let out = 'PMC-';
  for (let i = 0; i < 6; i++) {out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];}
  return out;
}

/**
 * Split sorted YYYY-MM-DD dates into [startsOn, endsOn] runs of consecutive
 * days. [3rd, 4th, 9th] → [[3rd, 4th], [9th, 9th]]: two bookable windows
 * instead of one that swallows the 5th–8th (E2E-50).
 */
export function contiguousRuns(sortedDates: readonly string[]): Array<[string, string]> {
  const runs: Array<[string, string]> = [];
  for (const d of sortedDates) {
    const last = runs[runs.length - 1];
    if (last && nextDay(last[1]) === d) {last[1] = d;} else {runs.push([d, d]);}
  }
  return runs;
}

/** The calendar day after a YYYY-MM-DD date, as YYYY-MM-DD (UTC arithmetic:
 *  the input carries no time, so no zone can shift the successor). */
function nextDay(iso: string): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export interface ProAssignmentRow {
  id: string;
  application_id: string;
  mission_id: string | null;
  cpo_user_id: string;
  org_user_id: string | null;
  starts_on: string;
  ends_on: string;
  status: 'ASSIGNED' | 'COMPLETED' | 'CANCELLED';
  mission_code: string;
  note: string | null;
  created_at: string;
  authorized_at: string | null;
  revoked_at: string | null;
  cpo_name?: string | null;
  org_name?: string | null;
  member_name?: string | null;
}

const ASSIGNMENT_COLS = `
  pca.id, pca.application_id, pca.mission_id, pca.cpo_user_id, pca.org_user_id,
  pca.starts_on::text AS starts_on, pca.ends_on::text AS ends_on,
  pca.status, pca.mission_code, pca.note, pca.created_at,
  pca.authorized_at, pca.revoked_at
`;

export type MissionViewRow = ProAssignmentRow & {
  member_name: string | null;
  member_avatar: string | null;
  coverage_area: string | null;
};

/** The CPO mission-view row — used by the code gate and the restore lookup. */
const MISSION_VIEW_SELECT = `
  SELECT ${ASSIGNMENT_COLS},
         mu.display_name AS member_name, mu.avatar_url AS member_avatar,
         og.display_name AS org_name, pa.coverage_area
    FROM pro_cpo_assignments pca
    JOIN pro_applications pa ON pa.id = pca.application_id
    JOIN users mu ON mu.id = pa.user_id
    LEFT JOIN agents og ON og.user_id = pca.org_user_id
`;

/**
 * Ops-side Pro management: internal organisations, ops-provisioned CPOs, and
 * overlap-safe CPO ↔ Pro-member protection assignments (+ the mission-code
 * gate the CPO app uses). Inherits the org/agents machinery — an org IS the
 * agents(type='company') row; CPO creation delegates to OrgCpoService (the
 * single "make a deployable officer" primitive). Pro missions carry NO payout.
 */
@Injectable()
export class ProManagementService {
  private readonly log = new Logger(ProManagementService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly password: PasswordService,
    private readonly orgCpos: OrgCpoService,
    private readonly events: MissionEventsService,
    private readonly push: BookingPushBridge,
  ) {}

  // ─── Organisations ─────────────────────────────────────────────────────────

  async listOrgs(): Promise<{orgs: Array<Record<string, unknown>>}> {
    const orgs = await this.db.q(
      `SELECT a.user_id AS id, a.display_name, a.status,
              (a.created_by_ops IS NOT NULL) AS internal,
              u.email, u.phone_e164, a.created_at,
              (SELECT COUNT(*)::int FROM org_members om
                WHERE om.org_user_id = a.user_id AND om.member_role = 'cpo' AND om.status = 'active') AS cpo_count,
              (SELECT COUNT(*)::int FROM pro_cpo_assignments pca
                WHERE pca.org_user_id = a.user_id AND pca.status = 'ASSIGNED') AS live_assignments
         FROM agents a
         JOIN users u ON u.id = a.user_id
        WHERE a.type = 'company'
        ORDER BY a.created_at DESC
        LIMIT 200`,
    );
    return {orgs};
  }

  /**
   * Ops-created "internal" organisation: users row (service_provider, login
   * ready — password_set_at stamped like admin-invite accounts) + agents row
   * born ACTIVE (ops created it, nothing to review) + a coverage profile so
   * managed CPOs seeded under it inherit a real coverage country
   * (mirrorAgentToPool refuses agents without one).
   */
  async createOrg(admin: AdminContext, dto: CreateInternalOrgDto): Promise<{org: Record<string, unknown>}> {
    const existing = await this.db.qOne<{id: string}>(
      `SELECT id FROM public.users
        WHERE (email = $1 OR phone_e164 = $2) AND deleted_at IS NULL`,
      [dto.email, dto.phone_e164],
    );
    if (existing) {throw new ConflictException('user_already_exists');}
    const pwHash = await this.password.hash(dto.temp_password);
    const coverage = JSON.stringify({countries: [dto.coverage_country ?? 'AE'], services: []});

    try {
      const org = await this.db.withTransaction(async tx => {
        const user = await tx.qOne<{id: string}>(
          `INSERT INTO public.users
             (id, email, phone_e164, display_name, role, subscription_tier,
              password_hash, kyc_status, password_set_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'service_provider', 'lite', $4, 'approved', NOW())
           RETURNING id`,
          [dto.email, dto.phone_e164, dto.display_name, pwHash],
        );
        await tx.q(
          `INSERT INTO agents (user_id, type, status, display_name, created_by_ops)
           VALUES ($1, 'company', 'ACTIVE', $2, $3)`,
          [user!.id, dto.display_name, admin.user_id],
        );
        await tx.q(
          `INSERT INTO agent_profiles (user_id, coverage)
           VALUES ($1, $2::jsonb) ON CONFLICT (user_id) DO UPDATE SET coverage = EXCLUDED.coverage`,
          [user!.id, coverage],
        );
        return {id: user!.id, display_name: dto.display_name, status: 'ACTIVE', internal: true};
      });
      return {org};
    } catch (e) {
      if ((e as {code?: string}).code === '23505') {
        throw new ConflictException('user_already_exists');
      }
      throw e;
    }
  }

  async orgDetail(id: string): Promise<Record<string, unknown>> {
    const org = await this.db.qOne(
      `SELECT a.user_id AS id, a.display_name, a.status,
              (a.created_by_ops IS NOT NULL) AS internal,
              u.email, u.phone_e164, a.created_at
         FROM agents a JOIN users u ON u.id = a.user_id
        WHERE a.user_id = $1 AND a.type = 'company'`,
      [id],
    );
    if (!org) {throw new NotFoundException('org_not_found');}
    const roster = await this.db.q(
      `SELECT om.member_user_id AS user_id, u.display_name, om.member_role,
              om.status, om.call_sign, om.suspended_until, ag.status AS agent_status
         FROM org_members om
         JOIN users u ON u.id = om.member_user_id
         LEFT JOIN agents ag ON ag.user_id = om.member_user_id
        WHERE om.org_user_id = $1 AND om.status <> 'removed'
        ORDER BY om.member_role, u.display_name
        LIMIT 300`,
      [id],
    );
    // Pro members this org's CPOs protect (present + past assignments).
    const protectedMembers = await this.db.q(
      `SELECT DISTINCT pa.id AS application_id, u.display_name AS member_name,
              pa.status AS application_status
         FROM pro_cpo_assignments pca
         JOIN pro_applications pa ON pa.id = pca.application_id
         JOIN users u ON u.id = pa.user_id
        WHERE pca.org_user_id = $1
        LIMIT 100`,
      [id],
    );
    return {org, roster, protected_members: protectedMembers};
  }

  // ─── CPOs ──────────────────────────────────────────────────────────────────

  /** Ops-provisioned CPO — full delegation to the org machinery, then the
   *  internal marker. Same workflow as the app (system credentials, normal
   *  CPO login + activation, org roster membership). */
  async createCpo(admin: AdminContext, dto: CreateOpsCpoDto): Promise<Record<string, unknown>> {
    const org = await this.db.qOne<{user_id: string}>(
      `SELECT user_id FROM agents WHERE user_id = $1 AND type = 'company'`,
      [dto.org_user_id],
    );
    if (!org) {throw new NotFoundException('org_not_found');}
    const member = await this.orgCpos.createManagedCpo(dto.org_user_id, {
      display_name: dto.display_name,
      email: dto.email,
      phone_e164: dto.phone_e164,
      temp_password: dto.temp_password,
      call_sign: dto.call_sign,
      member_role: 'cpo',
    }, admin.user_id);
    // Ops provisioning IS the vetting: the seeded officer is born deployable
    // (the org path seeds DOCS_PENDING and walks the doc pipeline; the agent
    // FSM has no DOCS_PENDING→APPROVED edge, and operations is the approving
    // authority here anyway).
    await this.db.q(
      `UPDATE agents SET status = 'ACTIVE', created_by_ops = $2 WHERE user_id = $1`,
      [(member as {member_user_id: string}).member_user_id, admin.user_id],
    );
    return {member};
  }

  /** Suspend (windowed) / reinstate a CPO — reuses the org-tier machinery
   *  (session revoke + channel strip ride along). */
  async setCpoSuspension(admin: AdminContext, cpoUserId: string, dto: SuspendCpoDto): Promise<{ok: true}> {
    const membership = await this.db.qOne<{org_user_id: string}>(
      `SELECT org_user_id FROM org_members
        WHERE member_user_id = $1 AND status IN ('active','suspended')
        -- vs2 item 4: PREFER the cpo membership, do not require it.
        --
        -- This org id becomes the employing-org attribution on the assignment
        -- row, so an officer who is also an office manager somewhere must
        -- resolve to the agency that employs them as an officer. Requiring the
        -- role instead was measured against staging and WRONG: 3 cpo agents
        -- hold a 'manager' membership and 2 hold only that, so the filter
        -- erased them from ops entirely.
        ORDER BY (member_role = 'cpo') DESC, (status = 'active') DESC, created_at ASC
        LIMIT 1`,
      [cpoUserId],
    );
    if (!membership) {throw new NotFoundException('cpo_membership_not_found');}
    if (dto.suspend) {
      const until = dto.days
        ? new Date(Date.now() + dto.days * 86400_000).toISOString()
        : null;
      await this.orgCpos.setMemberStatus(
        membership.org_user_id, cpoUserId, 'suspended', membership.org_user_id,
        {from: new Date().toISOString(), until, reason: dto.reason ?? `Suspended by operations (${admin.call_sign})`},
      );
    } else {
      await this.orgCpos.setMemberStatus(membership.org_user_id, cpoUserId, 'active', membership.org_user_id);
    }
    return {ok: true};
  }

  /**
   * The assignable pool: approved CPOs with live org membership, annotated
   * with availability inside [from..to] (no overlapping ASSIGNED row, not
   * suspended for that window's start).
   */
  async listPool(from?: string, to?: string, applicationId?: string): Promise<{cpos: Array<Record<string, unknown>>}> {
    await this.sweepAssignments();
    const f = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : todayGulf();
    const t = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : f;
    const cpos = await this.db.q(
      `SELECT a.user_id AS id, u.display_name, u.avatar_url, a.status AS agent_status,
              om.org_user_id, og.display_name AS org_name, om.status AS member_status,
              om.call_sign, om.suspended_until,
              (a.created_by_ops IS NOT NULL) AS internal,
              EXISTS (
                SELECT 1 FROM pro_cpo_assignments pca
                 WHERE pca.cpo_user_id = a.user_id AND pca.status = 'ASSIGNED'
                   AND daterange(pca.starts_on, pca.ends_on, '[]') && daterange($1::date, $2::date, '[]')
              ) AS busy_in_window,
              EXISTS (
                SELECT 1 FROM pro_cpo_assignments pcad
                 WHERE $3::uuid IS NOT NULL AND pcad.application_id = $3::uuid
                   AND pcad.cpo_user_id = a.user_id AND pcad.status = 'ASSIGNED'
                   AND daterange(pcad.starts_on, pcad.ends_on, '[]') @> daterange($1::date, $2::date, '[]')
              ) AS dedicated_in_window,
              (SELECT MIN(pca2.starts_on)::text FROM pro_cpo_assignments pca2
                WHERE pca2.cpo_user_id = a.user_id AND pca2.status = 'ASSIGNED'
                  AND pca2.ends_on >= ${GULF_TODAY_SQL}) AS next_assignment_start
         FROM agents a
         JOIN users u ON u.id = a.user_id
         -- vs2 item 4: ONE membership per officer, or a multi-org officer is
         -- listed twice and ops picks whichever row happens to come first.
         -- LATERAL rather than a role filter — see assertCpoEligible: filtering
         -- removes officers who hold only a non-cpo membership.
         JOIN LATERAL (
           SELECT om2.org_user_id, om2.status, om2.call_sign, om2.suspended_until
             FROM org_members om2
            WHERE om2.member_user_id = a.user_id AND om2.status IN ('active','suspended')
            ORDER BY (om2.member_role = 'cpo') DESC, (om2.status = 'active') DESC, om2.created_at ASC
            LIMIT 1
         ) om ON TRUE
         LEFT JOIN agents og ON og.user_id = om.org_user_id
        WHERE a.type = 'cpo' AND a.status IN ('ACTIVE','APPROVED')
        ORDER BY u.display_name
        LIMIT 300`,
      [f, t, applicationId ?? null],
    );
    const now = Date.now();
    return {
      cpos: cpos.map(c => {
        const suspendedNow = (c as {member_status?: string; suspended_until?: Date | null}).member_status === 'suspended' &&
          (!(c as {suspended_until?: Date | null}).suspended_until ||
            new Date((c as {suspended_until?: Date}).suspended_until!).getTime() > now);
        // The member's own dedicated officer overlaps by construction (his
        // dedication window IS the overlap) — he stays selectable.
        const dedicated = !!(c as {dedicated_in_window?: boolean}).dedicated_in_window;
        return {
          ...c,
          suspended_now: suspendedNow,
          dedicated,
          available: !suspendedNow && (dedicated || !(c as {busy_in_window?: boolean}).busy_in_window),
        };
      }),
    };
  }

  // ─── Assignments ───────────────────────────────────────────────────────────

  /** Lazy sweep — protection periods past their end auto-complete (no payout,
   *  per founder: "after finish the mission there is no payment — just finish"). */
  private async sweepAssignments(): Promise<void> {
    try {
      await this.db.q(
        `UPDATE pro_cpo_assignments
            SET status = 'COMPLETED', completed_at = now(), updated_at = now()
          WHERE status = 'ASSIGNED' AND ends_on < ${GULF_TODAY_SQL}`,
      );
    } catch (e) {
      this.log.warn(`assignment sweep failed: ${(e as Error).message}`);
    }
  }

  /**
   * The GLOBAL incoming queue — every client protection-date request still
   * awaiting officers, across all plans (oldest first). This is the surface
   * ops watches; per-application cards remain on the detail page.
   *
   * E2E-08 — plus `reserved_today`: the SCHEDULED dates landing today or
   * tomorrow, so "what protection is running right now?" has an ops answer at
   * all (there was none anywhere).
   *
   * A SIBLING KEY, not a wider `requests` array. The console's REQUESTS list
   * renders every row it is given as "AWAITING OFFICERS" with ASSIGN/DECLINE
   * buttons, so mixing SCHEDULED rows in would mislabel them and offer actions
   * the server would refuse. `requests` is byte-for-byte what it was; a console
   * that has not adopted `reserved_today` yet renders exactly as before.
   */
  async listMissionRequests(): Promise<{
    requests: Array<Record<string, unknown>>;
    reserved_today: Array<Record<string, unknown>>;
  }> {
    const requests = await this.db.q(
      `SELECT pm.id, pm.application_id, pm.mission_dates::text[] AS mission_dates,
              pm.note, pm.status, pm.created_at,
              u.display_name AS member_name,
              ru.display_name AS requested_by_name
         FROM pro_plan_missions pm
         JOIN pro_applications pa ON pa.id = pm.application_id
         JOIN users u ON u.id = pa.user_id
         LEFT JOIN users ru ON ru.id = pm.requested_by
        WHERE pm.status = 'REQUESTED' AND pa.status = 'ACTIVE'
        ORDER BY pm.created_at ASC
        LIMIT 100`,
    );
    // `win.d` is THE date that put this row in the set — the earliest of the
    // mission's dates falling inside [today, tomorrow]. Everything date-shaped
    // below keys off it, because `first_date` is the min over ALL dates and can
    // sit in the past on a multi-date reservation.
    //
    // Why `officers_on_date` exists next to `officers_today` (console lane,
    // 2026-09-04): a TOMORROW row staffed by an assignment starting tomorrow
    // reported officers_today = 0, so "no officers" fired on a correctly-staffed
    // reservation. Counting cover on the row's OWN date is the honest check;
    // officers_today stays for compatibility.
    const reserved_today = await this.db.q(
      `SELECT pm.id, pm.application_id, pm.mission_dates::text[] AS mission_dates,
              pm.note, pm.status, pm.created_at, pm.activated_at,
              win.d::text AS date,
              (SELECT min(d) FROM unnest(pm.mission_dates) d)::text AS first_date,
              (win.d = ${GULF_TODAY_SQL}) AS is_today,
              u.display_name AS member_name,
              ru.display_name AS requested_by_name,
              (SELECT count(*)::int FROM pro_cpo_assignments pca
                WHERE pca.application_id = pm.application_id AND pca.status = 'ASSIGNED'
                  AND ${GULF_TODAY_SQL} BETWEEN pca.starts_on AND pca.ends_on) AS officers_today,
              (SELECT count(*)::int FROM pro_cpo_assignments pca
                WHERE pca.application_id = pm.application_id AND pca.status = 'ASSIGNED'
                  AND win.d BETWEEN pca.starts_on AND pca.ends_on) AS officers_on_date
         FROM pro_plan_missions pm
         JOIN pro_applications pa ON pa.id = pm.application_id
         JOIN users u ON u.id = pa.user_id
         LEFT JOIN users ru ON ru.id = pm.requested_by
         -- Aggregate over a possibly-empty set, so this is exactly one row per
         -- mission (min of nothing is NULL) — the row count is unchanged and a
         -- console keyed on pm.id keeps unique keys.
         CROSS JOIN LATERAL (
           SELECT min(d) AS d FROM unnest(pm.mission_dates) d
            WHERE d BETWEEN ${GULF_TODAY_SQL} AND ${GULF_TODAY_SQL} + 1
         ) win
        WHERE pm.status = 'SCHEDULED' AND win.d IS NOT NULL
        ORDER BY win.d ASC, pm.created_at ASC
        LIMIT 100`,
    );
    return {requests, reserved_today};
  }

  async listAssignments(filter: {application_id?: string; cpo_user_id?: string; status?: string}): Promise<{assignments: ProAssignmentRow[]}> {
    await this.sweepAssignments();
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.application_id) {conds.push(`pca.application_id = $${params.length + 1}`); params.push(filter.application_id);}
    if (filter.cpo_user_id) {conds.push(`pca.cpo_user_id = $${params.length + 1}`); params.push(filter.cpo_user_id);}
    if (filter.status && filter.status !== 'all') {conds.push(`pca.status = $${params.length + 1}`); params.push(filter.status);}
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const assignments = await this.db.q<ProAssignmentRow>(
      `SELECT ${ASSIGNMENT_COLS},
              cu.display_name AS cpo_name, og.display_name AS org_name,
              mu.display_name AS member_name
         FROM pro_cpo_assignments pca
         JOIN users cu ON cu.id = pca.cpo_user_id
         LEFT JOIN agents og ON og.user_id = pca.org_user_id
         JOIN pro_applications pa ON pa.id = pca.application_id
         JOIN users mu ON mu.id = pa.user_id
         ${where}
        ORDER BY pca.starts_on DESC, pca.created_at DESC
        LIMIT 300`,
      params,
    );
    return {assignments};
  }

  /** Eligibility gate shared by single-assign and schedule-with-CPOs. */
  private async assertCpoEligible(tx: {qOne: DatabaseService['qOne']}, cpoUserId: string): Promise<{orgUserId: string | null}> {
    const agent = await tx.qOne<{status: string}>(
      `SELECT status FROM agents WHERE user_id = $1 AND type = 'cpo'`, [cpoUserId]);
    if (!agent || !['ACTIVE', 'APPROVED'].includes(agent.status)) {
      throw new BadRequestException('cpo_not_approved');
    }
    const member = await tx.qOne<{org_user_id: string; status: string; suspended_until: Date | null}>(
      `SELECT org_user_id, status, suspended_until FROM org_members
        WHERE member_user_id = $1 AND status IN ('active','suspended')
        -- vs2 item 4: PREFER the cpo membership, do not require it.
        --
        -- This org id becomes the employing-org attribution on the assignment
        -- row, so an officer who is also an office manager somewhere must
        -- resolve to the agency that employs them as an officer. Requiring the
        -- role instead was measured against staging and WRONG: 3 cpo agents
        -- hold a 'manager' membership and 2 hold only that, so the filter
        -- erased them from ops entirely.
        ORDER BY (member_role = 'cpo') DESC, (status = 'active') DESC, created_at ASC
        LIMIT 1`,
      [cpoUserId],
    );
    if (member?.status === 'suspended' &&
        (!member.suspended_until || member.suspended_until.getTime() > Date.now())) {
      throw new BadRequestException('cpo_suspended');
    }
    return {orgUserId: member?.org_user_id ?? null};
  }

  private async conflictsFor(cpoUserId: string, startsOn: string, endsOn: string): Promise<ProAssignmentRow[]> {
    return this.db.q<ProAssignmentRow>(
      `SELECT ${ASSIGNMENT_COLS}, mu.display_name AS member_name
         FROM pro_cpo_assignments pca
         JOIN pro_applications pa ON pa.id = pca.application_id
         JOIN users mu ON mu.id = pa.user_id
        WHERE pca.cpo_user_id = $1 AND pca.status = 'ASSIGNED'
          AND daterange(pca.starts_on, pca.ends_on, '[]') && daterange($2::date, $3::date, '[]')`,
      [cpoUserId, startsOn, endsOn],
    );
  }

  /** An ASSIGNED window on THIS plan that already covers [startsOn..endsOn].
   *  The gist exclusion forbids inserting a second overlapping row for the
   *  officer, so a covered window must REUSE this one, never insert. */
  private async coveringAssignment(
    applicationId: string, cpoUserId: string, startsOn: string, endsOn: string,
  ): Promise<ProAssignmentRow | null> {
    return this.db.qOne<ProAssignmentRow>(
      `SELECT ${ASSIGNMENT_COLS}
         FROM pro_cpo_assignments pca
        WHERE pca.application_id = $1 AND pca.cpo_user_id = $2 AND pca.status = 'ASSIGNED'
          AND daterange(pca.starts_on, pca.ends_on, '[]') @> daterange($3::date, $4::date, '[]')
        LIMIT 1`,
      [applicationId, cpoUserId, startsOn, endsOn],
    );
  }

  async createAssignment(admin: AdminContext, dto: CreateProAssignmentDto): Promise<{assignment: ProAssignmentRow}> {
    await this.sweepAssignments();
    if (dto.ends_on < dto.starts_on) {throw new BadRequestException('ends_before_starts');}
    const app = await this.db.qOne<{id: string; user_id: string; status: string}>(
      `SELECT id, user_id, status FROM pro_applications WHERE id = $1`, [dto.application_id]);
    if (!app) {throw new NotFoundException('pro_application_not_found');}
    if (app.status !== 'ACTIVE') {throw new BadRequestException('plan_not_active');}
    const proposal = await this.db.qOne<{coverage_start: string; coverage_end: string}>(
      `SELECT coverage_start::text AS coverage_start, coverage_end::text AS coverage_end
         FROM pro_proposals WHERE application_id = $1 ORDER BY version DESC LIMIT 1`,
      [dto.application_id],
    );
    if (proposal && (dto.starts_on < proposal.coverage_start || dto.ends_on > proposal.coverage_end)) {
      throw new BadRequestException('dates_outside_coverage');
    }
    const {orgUserId} = await this.assertCpoEligible(this.db, dto.cpo_user_id);

    // Already dedicated to this member over these dates → idempotent no-op.
    const covering = await this.coveringAssignment(dto.application_id, dto.cpo_user_id, dto.starts_on, dto.ends_on);
    if (covering) {return {assignment: covering};}

    // Friendly pre-check (names the clash); the gist constraint is the
    // race-proof authority below.
    const clashes = await this.conflictsFor(dto.cpo_user_id, dto.starts_on, dto.ends_on);
    if (clashes.length > 0) {
      throw new ConflictException({
        message: 'cpo_unavailable_overlap',
        conflicts: clashes.map(c => ({member: c.member_name, starts_on: c.starts_on, ends_on: c.ends_on})),
      });
    }

    const assignment = await this.insertAssignment(admin, {
      applicationId: dto.application_id, missionId: dto.mission_id ?? null,
      cpoUserId: dto.cpo_user_id, orgUserId,
      startsOn: dto.starts_on, endsOn: dto.ends_on, note: dto.note ?? null,
    });
    await this.db.q(
      `INSERT INTO pro_application_events (application_id, actor, event, message)
       VALUES ($1,'ops','cpo.assigned',$2)`,
      [dto.application_id, `Protection officer assigned ${dto.starts_on} → ${dto.ends_on}`],
    );
    void this.events.broadcast(dto.application_id, 'proapp.message', {}).catch(() => undefined);
    // B-852: owner-only on purpose — a dedication is PLAN-level cover, dto.mission_id
    // is optional and no mission row is read here, so there is no requester to tell.
    void this.push.proMissionUpdate(app.user_id, dto.application_id, 'ASSIGNED').catch(() => undefined);
    return {assignment};
  }

  private async insertAssignment(admin: AdminContext, a: {
    applicationId: string; missionId: string | null; cpoUserId: string;
    orgUserId: string | null; startsOn: string; endsOn: string; note: string | null;
  }): Promise<ProAssignmentRow> {
    // Retry the unique mission code; map the gist exclusion to the same 409
    // shape as the pre-check (two admins racing the same officer).
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const row = await this.db.qOne<ProAssignmentRow>(
          `INSERT INTO pro_cpo_assignments
             (application_id, mission_id, cpo_user_id, org_user_id,
              starts_on, ends_on, mission_code, note, assigned_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING ${ASSIGNMENT_COLS.replace(/pca\./g, '')}`,
          [
            a.applicationId, a.missionId, a.cpoUserId, a.orgUserId,
            a.startsOn, a.endsOn, mintMissionCode(), a.note, admin.user_id,
          ],
        );
        return row!;
      } catch (e) {
        const code = (e as {code?: string}).code;
        if (code === '23505' && attempt < 3) {continue;} // mission_code collision — remint
        if (code === '23P01') {
          const clashes = await this.conflictsFor(a.cpoUserId, a.startsOn, a.endsOn);
          throw new ConflictException({
            message: 'cpo_unavailable_overlap',
            conflicts: clashes.map(c => ({member: c.member_name, starts_on: c.starts_on, ends_on: c.ends_on})),
          });
        }
        throw e;
      }
    }
    throw new ConflictException('mission_code_mint_failed');
  }

  /**
   * The founder's flow: SCHEDULING a client's multi-date request = picking
   * real officers. Creates one assignment per CPO spanning the request's
   * dates (all-or-nothing) and flips the request to SCHEDULED with the
   * derived team.
   */
  async scheduleRequestWithCpos(
    admin: AdminContext, applicationId: string, missionRequestId: string,
    dto: ScheduleRequestWithCposDto,
  ): Promise<Record<string, unknown>> {
    await this.sweepAssignments();
    // B-852: requested_by rides along so the person who asked for the date can
    // be told the decision (see the push pair at the end of this method).
    const request = await this.db.qOne<{
      id: string; status: string; mission_dates: string[]; requested_by: string | null;
    }>(
      `SELECT id, status, mission_dates::text[] AS mission_dates, requested_by
         FROM pro_plan_missions WHERE id = $1 AND application_id = $2`,
      [missionRequestId, applicationId],
    );
    if (!request) {throw new NotFoundException('mission_request_not_found');}
    if (request.status !== 'REQUESTED') {throw new BadRequestException('mission_not_requestable');}
    const app = await this.db.qOne<{user_id: string; status: string}>(
      `SELECT user_id, status FROM pro_applications WHERE id = $1`, [applicationId]);
    if (!app || app.status !== 'ACTIVE') {throw new BadRequestException('plan_not_active');}

    const dates = [...request.mission_dates].sort();
    // E2E-50 — one row PER CONTIGUOUS RUN, not one row spanning first→last.
    // pro_cpo_assignments carries a gist exclusion over (cpo_user_id, daterange),
    // so a single row for [Jan 3, Feb 9] made the officer unbookable for the
    // whole five weeks in between — dates nobody reserved.
    const runs = contiguousRuns(dates);
    const cpoIds = [...new Set(dto.cpo_user_ids)];
    if (cpoIds.length < 1) {throw new BadRequestException('at_least_one_cpo');}

    const created: ProAssignmentRow[] = [];
    // Pre-existing dedication rows satisfying the request — reused, never
    // inserted (the gist exclusion forbids a second overlapping row) and
    // never cancelled by the rollback path below.
    const reused: ProAssignmentRow[] = [];
    const names: string[] = [];
    // Why: one batched read instead of a display_name query per officer.
    const nameRows = await this.db.q<{id: string; display_name: string | null}>(
      `SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])`, [cpoIds]);
    const nameById = new Map(nameRows.map(r => [r.id, r.display_name]));
    try {
      for (const cpoUserId of cpoIds) {
        const {orgUserId} = await this.assertCpoEligible(this.db, cpoUserId);
        for (const [startsOn, endsOn] of runs) {
          const covering = await this.coveringAssignment(applicationId, cpoUserId, startsOn, endsOn);
          if (!covering) {
            const clashes = await this.conflictsFor(cpoUserId, startsOn, endsOn);
            if (clashes.length > 0) {
              throw new ConflictException({
                message: 'cpo_unavailable_overlap',
                cpo_user_id: cpoUserId,
                conflicts: clashes.map(c => ({member: c.member_name, starts_on: c.starts_on, ends_on: c.ends_on})),
              });
            }
          }
          if (covering) {
            // A standing dedication can cover several runs at once — count it once.
            if (!reused.some(r => r.id === covering.id)) {reused.push(covering);}
          } else {
            created.push(await this.insertAssignment(admin, {
              applicationId, missionId: missionRequestId, cpoUserId, orgUserId,
              startsOn, endsOn, note: dto.ops_note ?? null,
            }));
          }
        }
        names.push(nameById.get(cpoUserId) ?? 'Officer');
      }
    } catch (e) {
      // All-or-nothing: roll back any partial assignments before surfacing.
      for (const a of created) {
        await this.db.q(
          `UPDATE pro_cpo_assignments
              SET status = 'CANCELLED', revoked_at = now(), updated_at = now()
            WHERE id = $1`,
          [a.id],
        ).catch(() => undefined);
      }
      throw e;
    }

    const assignments = [...reused, ...created];
    // Count OFFICERS, not rows: since E2E-50 one officer can hold several rows
    // (one per contiguous run), and the client renders this as the team size.
    const team = [{role: 'Close Protection Officer', count: names.length, label: names.join(', ')}];
    const mission = await this.db.qOne(
      `UPDATE pro_plan_missions
          SET status = 'SCHEDULED', assigned_team = $3::jsonb, ops_note = $4,
              decided_by = $5, updated_at = now()
        WHERE id = $1 AND application_id = $2 AND status = 'REQUESTED'
        RETURNING id, status, assigned_team, ops_note`,
      [missionRequestId, applicationId, JSON.stringify(team), dto.ops_note ?? null, admin.user_id],
    );
    await this.db.q(
      `INSERT INTO pro_application_events (application_id, actor, event, message)
       VALUES ($1,'ops','mission.scheduled',$2)`,
      [applicationId, `Protection scheduled — ${names.join(', ')} (${dates.length} date${dates.length > 1 ? 's' : ''})`],
    );
    void this.events.broadcast(applicationId, 'proapp.message', {}).catch(() => undefined);
    void this.push.proMissionUpdate(app.user_id, applicationId, 'SCHEDULED').catch(() => undefined);
    // B-852 — and the member who asked for the date, when that is not the owner.
    // Their calendar shows only their OWN requests now, so this push is the only
    // thing that tells them ops booked it. An unknown requester, or the owner's
    // own request, stays a single push.
    if (request.requested_by && request.requested_by !== app.user_id) {
      void this.push.proMissionUpdate(request.requested_by, applicationId, 'SCHEDULED').catch(() => undefined);
    }
    return {mission, assignments};
  }

  async cancelAssignment(admin: AdminContext, id: string): Promise<{assignment: ProAssignmentRow}> {
    const row = await this.db.qOne<ProAssignmentRow>(
      `UPDATE pro_cpo_assignments pca
          SET status = 'CANCELLED', revoked_at = now(), updated_at = now()
        WHERE pca.id = $1 AND pca.status = 'ASSIGNED'
        RETURNING ${ASSIGNMENT_COLS.replace(/pca\./g, '')}`,
      [id],
    );
    if (!row) {throw new BadRequestException('assignment_not_active');}
    return {assignment: row};
  }

  /** Founder: pro missions just FINISH — no payout, no settlement. */
  async completeAssignment(admin: AdminContext, id: string): Promise<{assignment: ProAssignmentRow}> {
    const row = await this.db.qOne<ProAssignmentRow>(
      `UPDATE pro_cpo_assignments pca
          SET status = 'COMPLETED', completed_at = now(), updated_at = now()
        WHERE pca.id = $1 AND pca.status = 'ASSIGNED'
        RETURNING ${ASSIGNMENT_COLS.replace(/pca\./g, '')}`,
      [id],
    );
    if (!row) {throw new BadRequestException('assignment_not_active');}
    return {assignment: row};
  }

  // ─── CPO side — the mission-code gate ─────────────────────────────────────

  /**
   * A CPO types the code after login. Valid only when the code exists AND
   * belongs to THIS CPO AND the assignment is live (ASSIGNED). Returns the
   * dedicated mission view payload; anything else → clean denial.
   */
  async resolveMissionCode(cpoUserId: string, rawCode: string): Promise<Record<string, unknown>> {
    await this.sweepAssignments();
    const code = rawCode.trim().toUpperCase();
    if (!/^PMC-[A-Z2-9]{6}$/.test(code)) {throw new NotFoundException('invalid_mission_code');}
    const row = await this.db.qOne<MissionViewRow>(
      `${MISSION_VIEW_SELECT} WHERE pca.mission_code = $1`,
      [code],
    );
    if (!row || row.cpo_user_id !== cpoUserId) {
      // Same message whether the code is unknown or belongs to another
      // officer — never confirm a foreign code exists.
      throw new NotFoundException('invalid_mission_code');
    }
    if (row.status === 'CANCELLED') {throw new BadRequestException('mission_cancelled');}
    if (row.status === 'COMPLETED') {throw new BadRequestException('mission_already_completed');}

    // Persist the authorization server-side. COALESCE keeps the FIRST stamp, so
    // re-submitting the same code is idempotent (no duplicate authorization).
    // This — not a device-cached code — is what survives reinstall/new phone.
    if (!row.authorized_at) {
      const stamped = await this.db.qOne<{authorized_at: string}>(
        `UPDATE pro_cpo_assignments
            SET authorized_at = COALESCE(authorized_at, now()), updated_at = now()
          WHERE id = $1 AND cpo_user_id = $2 AND status = 'ASSIGNED'
          RETURNING authorized_at`,
        [row.id, cpoUserId],
      );
      row.authorized_at = stamped?.authorized_at ?? row.authorized_at;
    }

    return this.buildMissionView(row);
  }

  /**
   * Restore the CPO's live mission WITHOUT a code. The mission code is a
   * one-time authorization gate: once verified, the assignment row itself is
   * the durable proof, so a reinstall / new device / logout just needs a normal
   * login. Requires the assignment to still be live (ASSIGNED — the sweep
   * completes finished schedules and ops cancellation flips to CANCELLED) AND
   * previously authorized. Never returns a mission the CPO has not yet unlocked.
   */
  async getActiveMission(cpoUserId: string): Promise<Record<string, unknown>> {
    await this.sweepAssignments();
    const row = await this.db.qOne<MissionViewRow>(
      `${MISSION_VIEW_SELECT}
        WHERE pca.cpo_user_id = $1
          AND pca.status = 'ASSIGNED'
          AND pca.authorized_at IS NOT NULL
          AND pca.ends_on >= ${GULF_TODAY_SQL}
        ORDER BY pca.starts_on ASC
        LIMIT 1`,
      [cpoUserId],
    );
    if (!row) {throw new NotFoundException('no_active_assignment');}
    return this.buildMissionView(row);
  }

  /** Shared mission-view payload for both the code gate and the restore path. */
  private async buildMissionView(row: MissionViewRow): Promise<Record<string, unknown>> {
    // The client's scheduled protection dates that fall inside this window.
    const missions = await this.db.q<{mission_dates: string[]; note: string | null}>(
      `SELECT mission_dates::text[] AS mission_dates, note
         FROM pro_plan_missions
        WHERE application_id = $1 AND status = 'SCHEDULED'`,
      [row.application_id],
    );
    const dates = [...new Set(missions.flatMap(m => m.mission_dates))]
      .filter(d => d >= row.starts_on && d <= row.ends_on)
      .sort();
    // E2E-09 — the Gulf day, like every sibling. A UTC "today" here meant that
    // between 20:00 and 24:00 UTC the row the officer was just ADMITTED to
    // (authorizedAssignment matches on GULF_TODAY_SQL) came back live_today:false.
    const today = todayGulf();
    return {
      assignment: row,
      protection_dates: dates,
      live_today: today >= row.starts_on && today <= row.ends_on,
    };
  }
}
