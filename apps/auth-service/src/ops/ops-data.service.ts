import {BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional} from '@nestjs/common';
import {
  MAX_OPEN_INVITES, MINT_MAX_ATTEMPTS, clampTtlDays, generateInviteCode, inviteStatus, normalizeCallSign, normalizeInviteCode, normalizeInviteRole,
} from '../org/invite-code';
import type {MintInviteDto} from '../org/dto/org.dto';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {bustAccountGate} from '../common/services/account-gate-cache';
import {escapeLike} from '../common/sql-like';
import type {AdminContext} from './admin.guard';
import {assertRegionScope, isGlobalAdmin, isSuperAdmin} from './admin.guard';
import {IDENTITY_FACTS_UNKNOWN, resolveIdentityDocument} from '../identity/identityGate';

/**
 * Read-only ops data surfaces added by the 2026-07-07 webapp data-coverage
 * audit (DC-01/02/06/07/08/10/15/16/20): finance ledger, disputes, SOS log,
 * VBG oversight, global audit browser, analytics rollups, telemetry replay,
 * broadcast log, and the user directory. Mutations stay in OpsService /
 * dedicated services — the only write here is the session-device revoke.
 */
@Injectable()
export class OpsDataService {
  constructor(
    private readonly db: DatabaseService,
    // E2E-39 — needed only to bust the 30 s account gate on suspend/restore.
    // @Optional so the positional unit specs keep constructing; RedisModule is
    // @Global so DI always provides it in prod.
    @Optional() private readonly redis?: RedisService,
  ) {}

  private effectiveRegion(admin: AdminContext, requested?: string): string | null {
    return !isGlobalAdmin(admin) ? admin.region : (requested ?? null);
  }

  private clampLimit(limit: number | undefined, def: number, max = 500): number {
    const n = Number(limit) || def;
    return Math.min(Math.max(n, 1), max);
  }

  // ─── Disputes (DC-02) ─────────────────────────────────────────────

  listDisputes(admin: AdminContext, status?: string, limit?: number) {
    return this.db.q(
      `SELECT d.id, d.booking_id, d.category, d.reason, d.status,
              d.to_client_credits, d.to_provider_credits,
              d.raised_by, ru.display_name AS raised_by_name,
              d.decided_by, d.created_at, d.decided_at,
              b.region_code, b.region_label, b.service, b.total_eur,
              b.status AS booking_status,
              e.status AS escrow_status, e.gross_credits, e.review_required,
              -- B-807 — the hold's EXECUTED split + terminal markers. The resolve
              -- dialog needs them to tell a settle-from-escrow (DISPUTED) from a
              -- clawback (RELEASED / no-show PARTIAL) and to preview what a split
              -- will actually move; prefixed hold_* so they cannot be confused with
              -- the dispute's own decided to_client/to_provider above.
              e.basis AS hold_basis,
              e.to_provider_credits AS hold_to_provider_credits,
              e.to_client_credits AS hold_to_client_credits,
              e.platform_fee_credits AS hold_platform_fee_credits,
              e.no_show_at AS hold_no_show_at,
              e.settled_at AS hold_settled_at
         FROM booking_disputes d
         JOIN lite_bookings b ON b.id = d.booking_id
         LEFT JOIN users ru ON ru.id = d.raised_by
         LEFT JOIN escrow_holds e ON e.booking_id = d.booking_id
        WHERE ($1::text IS NULL OR d.status = $1)
          AND ($2::text IS NULL OR b.region_code = $2)
        ORDER BY (d.status = 'OPEN') DESC, d.created_at DESC
        LIMIT $3`,
      [status ?? null, this.effectiveRegion(admin), this.clampLimit(limit, 100)],
    );
  }

  // ─── Finance ledger (DC-01) ───────────────────────────────────────
  // Never selects stripe_client_secret / stripe_intent_id — ids stay
  // reconcilable via the Stripe dashboard, secrets never leave the DB.

  listWalletTransactions(q: {user_id?: string; type?: string; status?: string; before?: string; before_id?: string; limit?: number}) {
    return this.db.q(
      // B-854 (A14) — the ACTOR rides out with the row. A family charge lands on
      // the ROOT's wallet, so without this the console's finance list reads a
      // member's (or, once chained, a sub-member's) spend as the root's own; and
      // `via_user_id` is what tells the two apart at a glance.
      //
      // `via_name` because an id renders as nothing: on a chained row `user_id`
      // is the root either way, so the NAME of the intermediary is the only
      // thing that distinguishes "B spent this" from "C spent this through B".
      // The join casts the metadata TEXT back to `uuid` — every value this
      // service writes there is one, and a non-uuid would 22P02 loudly rather
      // than silently widening the join.
      `SELECT t.id, t.user_id, u.display_name, u.role AS user_role,
              t.type, t.status, t.amount_credits, t.amount_fiat_cents,
              t.fiat_currency, t.description, t.booking_id,
              t.created_at, t.settled_at,
              t.actor_user_id, au.display_name AS actor_name,
              t.metadata->>'via_user_id' AS via_user_id,
              vu.display_name AS via_name
         FROM wallet_transactions t
         LEFT JOIN users u ON u.id = t.user_id
         LEFT JOIN users au ON au.id = t.actor_user_id
         LEFT JOIN users vu ON vu.id = (t.metadata->>'via_user_id')::uuid
        WHERE ($1::uuid IS NULL OR t.user_id = $1)
          AND ($2::text IS NULL OR t.type::text = $2)
          AND ($3::text IS NULL OR t.status::text = $3)
          AND ($4::timestamptz IS NULL OR t.created_at < $4
               OR ($5::uuid IS NOT NULL AND t.created_at = $4 AND t.id < $5))
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT $6`,
      [q.user_id ?? null, q.type ?? null, q.status ?? null, q.before ?? null, q.before_id ?? null, this.clampLimit(q.limit, 50, 200)],
    );
  }

  /**
   * IA-06 — `booking` narrows the hold list to one booking so the booking
   * detail's Money panel is a scoped read, not a scan of the finance list.
   */
  listEscrows(admin: AdminContext, status?: string, limit?: number, bookingId?: string) {
    return this.db.q(
      `SELECT e.id, e.booking_id, e.status, e.basis, e.review_required,
              e.review_reasons, e.no_show_at,
              e.gross_credits, e.to_provider_credits, e.to_client_credits, e.platform_fee_credits,
              e.held_at, e.completed_at, e.release_eligible_at, e.settled_at,
              e.client_id, cu.display_name AS client_name,
              e.provider_user_id, pu.display_name AS provider_name,
              b.region_code, b.region_label, b.service, b.status AS booking_status
         FROM escrow_holds e
         JOIN lite_bookings b ON b.id = e.booking_id
         LEFT JOIN users cu ON cu.id = e.client_id
         LEFT JOIN users pu ON pu.id = e.provider_user_id
        WHERE ($1::text IS NULL OR e.status::text = $1)
          AND ($2::text IS NULL OR b.region_code = $2)
          AND ($4::uuid IS NULL OR e.booking_id = $4)
        ORDER BY e.held_at DESC
        LIMIT $3`,
      [status ?? null, this.effectiveRegion(admin), this.clampLimit(limit, 100), bookingId ?? null],
    );
  }

  listPayouts(admin: AdminContext, limit?: number) {
    return this.db.q(
      `SELECT p.id, p.mission_id, p.booking_id, p.agent_user_id, p.call_sign,
              p.proposed_credits, p.paid_credits, p.deduction_credits, p.deduction_reason,
              p.decided_by, p.decided_at, p.payee_user_id,
              pu.display_name AS payee_name,
              m.short_code AS mission_short_code,
              b.region_code, b.region_label
         FROM mission_payouts p
         LEFT JOIN users pu ON pu.id = COALESCE(p.payee_user_id, p.agent_user_id)
         LEFT JOIN missions m ON m.id = p.mission_id
         LEFT JOIN lite_bookings b ON b.id = p.booking_id
        WHERE ($1::text IS NULL OR b.region_code = $1)
        ORDER BY p.decided_at DESC NULLS LAST
        LIMIT $2`,
      [this.effectiveRegion(admin), this.clampLimit(limit, 100)],
    );
  }

  listInvoices(admin: AdminContext, limit?: number) {
    return this.db.q(
      `SELECT i.id, i.invoice_number, i.booking_id, i.kind, i.issued_at, i.currency,
              i.subtotal_credits, i.tax_rate_pct, i.tax_credits, i.total_credits, i.pdf_url,
              b.region_code, b.region_label, b.service
         FROM invoices i
         LEFT JOIN lite_bookings b ON b.id = i.booking_id
        WHERE ($1::text IS NULL OR b.region_code = $1)
        ORDER BY i.issued_at DESC
        LIMIT $2`,
      [this.effectiveRegion(admin), this.clampLimit(limit, 100)],
    );
  }

  // OP-16 — was unbounded (outside the B-721 LIMIT sweep); polled at 5 s.
  listPromos(limit?: number) {
    return this.db.q(
      `SELECT p.id, p.code, p.credits, p.max_redemptions, p.redeemed_count,
              p.expires_at, p.active, p.created_at,
              (SELECT COUNT(*)::int FROM promo_redemptions r WHERE r.promo_id = p.id) AS redemptions
         FROM promo_codes p
        ORDER BY p.created_at DESC
        LIMIT $1`,
      [this.clampLimit(limit, 100)],
    );
  }

  /** Balance + batches + recent ledger for one user — powers the adjust form's context panel. */
  async walletOverview(userId: string) {
    const [user, balance, batches, transactions] = await Promise.all([
      this.db.qOne(
        `SELECT id, display_name, role, kyc_status, subscription_tier FROM users WHERE id = $1`,
        [userId],
      ),
      this.db.qOne(
        `SELECT bravo_credits, currency, updated_at FROM wallet_balances WHERE user_id = $1`,
        [userId],
      ),
      this.db.q(
        `SELECT id, amount_credits, consumed_credits, issued_at, expires_at, expired_at
           FROM wallet_credit_batches WHERE user_id = $1
          ORDER BY issued_at DESC LIMIT 20`,
        [userId],
      ),
      this.listWalletTransactions({user_id: userId, limit: 20}),
    ]);
    if (!user) throw new NotFoundException('user_not_found');
    return {user, balance: balance ?? {bravo_credits: 0, currency: 'BC', updated_at: null}, batches, transactions};
  }

  // ─── User directory (DC-04) ───────────────────────────────────────
  // password_hash / notif_prefs never selected.

  listUsers(q: {q?: string; role?: string; kyc?: string; tier?: string; limit?: number; offset?: number}) {
    return this.db.q(
      `SELECT u.id, u.display_name, u.phone_e164, u.email, u.role,
              u.subscription_tier, u.kyc_status, u.country_code, u.home_region,
              u.created_at, u.deleted_at,
              w.bravo_credits,
              (idoc.user_id IS NOT NULL) AS identity_document_submitted
         FROM users u
         LEFT JOIN wallet_balances w ON w.user_id = u.id
         LEFT JOIN identity_documents idoc ON idoc.user_id = u.id
        WHERE ($1::text IS NULL OR u.display_name ILIKE $1 ESCAPE '\\'
               OR u.email ILIKE $1 ESCAPE '\\' OR u.phone_e164 ILIKE $1 ESCAPE '\\')
          AND ($2::text IS NULL OR u.role = $2)
          AND ($3::text IS NULL OR u.kyc_status = $3)
          AND ($4::text IS NULL OR u.subscription_tier = $4)
        ORDER BY u.created_at DESC
        LIMIT $5 OFFSET $6`,
      // OP-13 review — same escaping as the bookings/missions search: a typed
      // '%' or '_' used to be a wildcard and a trailing backslash a 500.
      [q.q?.trim() ? `%${escapeLike(q.q.trim())}%` : null, q.role ?? null, q.kyc ?? null, q.tier ?? null, this.clampLimit(q.limit, 100), Math.max(0, Math.floor(q.offset ?? 0))],
    );
  }

  async getUserDetail(userId: string) {
    const user = await this.db.qOne(
      `SELECT id, display_name, phone_e164, email, role, bio, subscription_tier,
              kyc_status, country_code, home_region, language, currency, avatar_url,
              pro_active_until, pro_renew_status, app_lock, location_scope,
              created_at, updated_at, deleted_at, password_set_at,
              suspended_at, suspended_reason, suspended_by
         FROM users WHERE id = $1`,
      [userId],
    );
    if (!user) throw new NotFoundException('user_not_found');
    const [devices, balance, bookings, agent, location, identity_document] = await Promise.all([
      this.db.q(
        // B-794 — device identity (model/brand/OS/app build) rides along so the
        // console can say WHAT the session is on, not just "android".
        // `is_live` is derived, never the jti itself: current_jti is a bearer
        // token identifier and must not leave the service.
        `SELECT id, device_id, platform, signal_device_id,
                device_model, device_brand, os_version, app_version,
                created_at, last_used_at, expires_at, revoked_at,
                (current_jti IS NOT NULL AND revoked_at IS NULL
                 AND expires_at > NOW()) AS is_live
           FROM auth_devices WHERE user_id = $1
          ORDER BY last_used_at DESC NULLS LAST LIMIT 50`,
        [userId],
      ),
      this.db.qOne(
        `SELECT bravo_credits, currency, updated_at FROM wallet_balances WHERE user_id = $1`,
        [userId],
      ),
      this.db.q(
        `SELECT id, status, region_code, service, pickup_time, total_eur, created_at
           FROM lite_bookings WHERE client_id = $1 OR payer_user_id = $1
          ORDER BY created_at DESC LIMIT 10`,
        [userId],
      ),
      this.db.qOne(
        `SELECT user_id, type, status, call_sign, tier, on_duty FROM agents WHERE user_id = $1`,
        [userId],
      ),
      this.lastKnownLocation(userId, String((user as {location_scope?: string}).location_scope ?? 'while_on_duty'))
        .catch(() => ({blocked: 'no_source' as const})),
      // B-867 — existence/type/date only; the images have their own audited route.
      // Best-effort: a missing table (API ahead of its migration) must not blank
      // the whole user page — the card reads "not reported".
      resolveIdentityDocument(this.db, userId).catch(() => IDENTITY_FACTS_UNKNOWN),
    ]);
    return {user, devices, balance, bookings, agent, location, identity_document};
  }

  /**
   * B-794 — the freshest position ops may see for one user, or the REASON there
   * isn't one.
   *
   * The rule is deliberately not "ops sees everything": each source is gated by
   * the same consent basis that governs its own WRITE path, re-checked here, so
   * a user who narrows Settings -> Location stops appearing even though older
   * rows survive in the table.
   *
   *  - family fix      mirrors FamilyService.reportLocation exactly:
   *                    `location_scope = 'while_on_duty'` and nothing else.
   *                    Both narrower choices exclude continuous sharing.
   *  - on-duty agent   the agents row is only populated while a CPO reports on
   *                    duty / on mission, so 'never' is the only scope that
   *                    suppresses it.
   *  - VBG telemetry   an ACTIVE vbg_monitoring enrolment is its own, explicit
   *                    consent to be tracked (it is the protection service the
   *                    user asked for), so it is not gated on location_scope —
   *                    but it is labelled as VBG so nobody mistakes it for a
   *                    general fix.
   *
   * Returns either a fix or a machine-readable `blocked` reason, so the console
   * can explain the blank instead of rendering a bare dash.
   *
   * Fails OPEN as `no_source`: this is a supplementary field on a page whose
   * real job is suspend / erase / wallet / sessions. A slow or broken location
   * lookup must not 500 the whole user record.
   */
  private async lastKnownLocation(userId: string, scope: string): Promise<{
    lat: number; lng: number; recorded_at: string; source: 'family' | 'agent' | 'vbg';
    accuracy_m: number | null; label: string | null;
  } | {blocked: 'opted_out' | 'no_source'}> {
    const sharesContinuously = scope === 'while_on_duty';
    const [family, agentFix, vbg] = await Promise.all([
      sharesContinuously
        ? this.db.qOne(
          `SELECT lat, lng, accuracy_m, label, recorded_at
             FROM public.family_member_locations WHERE user_id = $1`,
          [userId],
        )
        : Promise.resolve(null),
      scope === 'never'
        ? Promise.resolve(null)
        : this.db.qOne(
          `SELECT last_lat AS lat, last_lng AS lng,
                  last_location_accuracy_m AS accuracy_m, last_location_at AS recorded_at
             FROM public.agents
            WHERE user_id = $1 AND last_lat IS NOT NULL AND last_location_at IS NOT NULL`,
          [userId],
        ),
      this.db.qOne(
        `SELECT t.lat, t.lng, t.recorded_at
           FROM public.vbg_telemetry_last t
           JOIN public.vbg_monitoring m ON m.user_id = t.user_id AND m.status = 'active'
          WHERE t.user_id = $1`,
        [userId],
      ),
    ]);

    type Fix = {lat: unknown; lng: unknown; recorded_at: unknown; accuracy_m?: unknown; label?: unknown};
    const candidates: Array<{row: Fix; source: 'family' | 'agent' | 'vbg'}> = [];
    if (family)   candidates.push({row: family as Fix, source: 'family'});
    if (agentFix) candidates.push({row: agentFix as Fix, source: 'agent'});
    if (vbg)      candidates.push({row: vbg as Fix, source: 'vbg'});

    if (candidates.length === 0) {
      // Distinguish "they turned it off" from "nothing ever reported" — the
      // console shows a different sentence for each, and a blank dash for
      // both is what made this unanswerable in the first place.
      return {blocked: scope === 'never' ? 'opted_out' : 'no_source'};
    }

    const freshest = candidates.reduce((best, c) =>
      new Date(String(c.row.recorded_at)).getTime() > new Date(String(best.row.recorded_at)).getTime() ? c : best);
    return {
      lat: Number(freshest.row.lat),
      lng: Number(freshest.row.lng),
      recorded_at: new Date(String(freshest.row.recorded_at)).toISOString(),
      source: freshest.source,
      accuracy_m: freshest.row.accuracy_m === null || freshest.row.accuracy_m === undefined
        ? null
        : Number(freshest.row.accuracy_m),
      label: typeof freshest.row.label === 'string' ? freshest.row.label : null,
    };
  }

  /**
   * SK-07/IS-03 — the plan THIS user is a member OF. Hold state (held_until in
   * the future) rides each row.
   *
   * B-835/B-836 — the other direction (members riding this user's plan) is no
   * longer read here: it is served by the paged, searchable
   * `FamilyService.listMembers`, so the console and the app cannot drift.
   */
  async getUserFamilyMemberOf(userId: string) {
    return this.db.q(
      `SELECT fm.id, fm.holder_id, fm.status, fm.held_until,
              fm.spend_limit_credits, fm.spent_credits, fm.invited_at, fm.accepted_at,
              hu.display_name AS holder_name, hu.email AS holder_email
         FROM public.family_members fm
         JOIN public.users hu ON hu.id = fm.holder_id
        WHERE fm.member_id = $1 AND fm.status IN ('pending','active')
        ORDER BY fm.invited_at DESC`,
      [userId],
    );
  }

  /** Revoke one auth device/session. Refresh dies immediately; the access JWT ages out (≤15 min). */
  async revokeUserDevice(userId: string, deviceRowId: string) {
    const row = await this.db.qOne<{id: string}>(
      `UPDATE auth_devices SET revoked_at = NOW(), current_jti = NULL
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
        RETURNING id`,
      [deviceRowId, userId],
    );
    if (!row) throw new NotFoundException('device_not_active');
    return {ok: true as const, device_row_id: row.id};
  }

  private async revokeAllDevices(userId: string): Promise<number> {
    const rows = await this.db.q<{id: string}>(
      `UPDATE auth_devices SET revoked_at = NOW(), current_jti = NULL
        WHERE user_id = $1 AND revoked_at IS NULL
        RETURNING id`,
      [userId],
    );
    return rows.length;
  }

  /**
   * DC-04 — reversible account suspension. Sets suspended_at (the login/verify/
   * refresh paths gate on it) and revokes every live session so the lockout is
   * immediate (residual access tokens expire within their ≤15-min TTL).
   */
  /**
   * B-818 critic P1 — `users.suspended_at` is the login gate for EVERYONE,
   * console admins included, and suspend is a rank-2 lever. Without this an
   * Operation Admin could suspend every super admin's login and the last-super
   * guards on the admin_users side would never run. A console admin may be
   * suspended/erased only by a super admin, and never the last active super.
   */
  async assertConsoleAdminTarget(admin: AdminContext, targetUserId: string): Promise<void> {
    const target = await this.db.qOne<{role: string; active: boolean}>(
      `SELECT role, active FROM admin_users WHERE user_id = $1`, [targetUserId],
    );
    if (!target) return;
    if (!isSuperAdmin(admin.role)) throw new ForbiddenException('console_admin_target_requires_super');
    if (target.active && isSuperAdmin(target.role as AdminContext['role'])) {
      const other = await this.db.qOne<{n: string}>(
        `SELECT count(*)::text AS n FROM admin_users
          WHERE role IN ('ADMIN', 'SUPER_ADMIN') AND active = TRUE AND user_id <> $1`,
        [targetUserId],
      );
      if (Number(other?.n ?? 0) === 0) throw new BadRequestException('cannot_lock_out_last_admin');
    }
  }

  async suspendUser(adminId: string, userId: string, reason: string) {
    const row = await this.db.qOne<{id: string}>(
      `UPDATE users SET suspended_at = NOW(), suspended_reason = $2, suspended_by = $3
        WHERE id = $1 AND deleted_at IS NULL AND suspended_at IS NULL
        RETURNING id`,
      [userId, reason, adminId],
    );
    if (!row) throw new NotFoundException('user_not_suspendable');
    const revoked = await this.revokeAllDevices(userId);
    // E2E-39 — the terminate path already busts this (`ops.service.ts`
    // revertRoleOnAgentExit) and suspend/restore did not, so a cached
    // account_kind/membership_status could outlive the write by up to the 30 s
    // TTL. Bust AFTER the write, never before: a bust that lands first can be
    // refilled with the pre-write row by a concurrent guard read.
    await bustAccountGate(this.redis, userId);
    return {ok: true as const, revoked_sessions: revoked};
  }

  async restoreUser(userId: string) {
    const row = await this.db.qOne<{id: string}>(
      `UPDATE users SET suspended_at = NULL, suspended_reason = NULL, suspended_by = NULL
        WHERE id = $1 AND suspended_at IS NOT NULL
        RETURNING id`,
      [userId],
    );
    if (!row) throw new NotFoundException('user_not_suspended');
    // E2E-39 — the restore side matters just as much: without it a restored user
    // keeps whatever the gate cached while they were locked out.
    await bustAccountGate(this.redis, userId);
    return {ok: true as const};
  }

  /**
   * DC-04 — GDPR erasure. Soft-delete (keep the row for financial/audit
   * referential integrity) + scrub PII + revoke sessions. Irreversible.
   * deleted_at is already the login tombstone across auth.service.
   */
  async eraseUser(adminId: string, userId: string, reason: string) {
    const row = await this.db.qOne<{id: string}>(
      `UPDATE users
          SET deleted_at = NOW(),
              display_name = 'Deleted User',
              email = NULL,
              phone_e164 = NULL,
              avatar_url = NULL,
              bio = NULL,
              password_hash = NULL,
              suspended_at = NULL, suspended_reason = NULL, suspended_by = NULL
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id`,
      [userId],
    );
    if (!row) throw new NotFoundException('user_not_erasable');
    // B-867 — accounts are soft-deleted, so the identity_documents CASCADE never
    // fires on its own: erase the sealed ID / passport explicitly. The read route
    // also refuses a deleted user, so a failed delete here is not a disclosure.
    await this.db.q(`DELETE FROM public.identity_documents WHERE user_id = $1`, [userId]);
    const revoked = await this.revokeAllDevices(userId);
    // E2E-39 — erasure is the STRONGEST of the three account actions, so it must
    // not be the one that leaves a stale gate. It is also the only one the cache
    // can actually contradict: `deleted_at` is in ACCOUNT_KIND_SQL's own WHERE,
    // so an erased user resolves to the fail-closed default on a fresh read —
    // but a gate entry cached seconds earlier still answers with their old
    // account_kind until the TTL lapses. Bust AFTER the write, like the others.
    await bustAccountGate(this.redis, userId);
    return {ok: true as const, revoked_sessions: revoked, reason};
  }

  // ─── SOS log (DC-06) — includes mission-less client/VBG panics ────
  // Deliberately NOT region-scoped: a panic with no booking has no region,
  // and safety visibility beats tenancy for emergency events.

  listSos(status?: 'active' | 'resolved' | 'all', limit?: number) {
    return this.db.q(
      `SELECT s.id, s.mission_id, s.booking_id, s.agent_id, s.user_id,
              s.agent_call_sign, s.reason, s.status, s.lat, s.lng,
              s.triggered_at, s.acknowledged_at, s.acknowledged_by,
              s.escalated_at, s.escalated_to, s.resolved_at, s.resolved_by, s.resolution,
              m.short_code AS mission_short_code,
              b.region_code, b.region_label,
              u.display_name AS user_display_name
         FROM sos_events s
         LEFT JOIN missions m ON m.id = s.mission_id
         LEFT JOIN lite_bookings b ON b.id = COALESCE(s.booking_id, m.booking_id)
         LEFT JOIN users u ON u.id = COALESCE(s.user_id, s.agent_id)
        WHERE CASE
                WHEN $1::text = 'active'   THEN s.resolved_at IS NULL
                WHEN $1::text = 'resolved' THEN s.resolved_at IS NOT NULL
                ELSE TRUE
              END
        ORDER BY (s.resolved_at IS NULL) DESC, s.triggered_at DESC
        LIMIT $2`,
      [status ?? 'all', this.clampLimit(limit, 200)],
    );
  }

  // ─── VBG oversight (DC-07) ────────────────────────────────────────

  // OP-16 — was unbounded (the only LIMIT was the LATERAL snapshot's LIMIT 1)
  // and polled console-wide every 10 s from the alert bar.
  listVbgMonitoring(limit?: number) {
    return this.db.q(
      `SELECT v.user_id, u.display_name, u.phone_e164, u.home_region,
              v.status, v.interval_min, v.enrolled_at, v.last_heartbeat_at,
              v.missed_count, v.consecutive_fails, v.last_zone_state, v.escalated_at,
              v.lat, v.lng,
              t.lat AS last_lat, t.lng AS last_lng, t.recorded_at AS last_telemetry_at,
              s.risk_score, s.level AS sra_level, s.created_at AS sra_at
         FROM vbg_monitoring v
         JOIN users u ON u.id = v.user_id
         LEFT JOIN vbg_telemetry_last t ON t.user_id = v.user_id
         LEFT JOIN LATERAL (
           SELECT risk_score, level, created_at FROM vbg_sra_snapshots ss
            WHERE ss.user_id = v.user_id ORDER BY ss.created_at DESC LIMIT 1
         ) s ON TRUE
        ORDER BY v.escalated_at DESC NULLS LAST, v.last_heartbeat_at DESC NULLS LAST
        LIMIT $1`,
      [this.clampLimit(limit, 200)],
    );
  }

  // ─── Global audit browser (DC-08) — keyset-paginated ──────────────

  browseAudit(q: {actor_id?: string; action?: string; subject_type?: string; from?: string; to?: string; before?: string; before_id?: string; limit?: number}) {
    return this.db.q(
      `SELECT id, actor_id, actor_role, actor_call, action,
              subject_type, subject_id, metadata, ip_address, created_at
         FROM ops_audit
        WHERE ($1::uuid IS NULL OR actor_id = $1)
          AND ($2::text IS NULL OR action ILIKE $2 || '%')
          AND ($3::text IS NULL OR subject_type = $3)
          AND ($4::timestamptz IS NULL OR created_at >= $4)
          AND ($5::timestamptz IS NULL OR created_at <= $5)
          AND ($6::timestamptz IS NULL OR created_at < $6)
        ORDER BY created_at DESC, id DESC
        LIMIT $7`,
      [q.actor_id ?? null, q.action?.trim() || null, q.subject_type ?? null,
       q.from ?? null, q.to ?? null, q.before ?? null, this.clampLimit(q.limit, 100, 200)],
    );
  }

  /** Readers for the previously write-only trails. */
  listAgentAudit(agentUserId: string, limit = 50) {
    return this.db.q(
      `SELECT id, from_status, to_status, actor_id, actor_role, metadata, created_at
         FROM agent_audit WHERE user_id = $1
        ORDER BY created_at DESC LIMIT $2`,
      [agentUserId, this.clampLimit(limit, 50, 200)],
    );
  }

  listOrgAudit(orgUserId: string, limit = 100) {
    return this.db.q(
      `SELECT id, org_user_id, actor_id, action, target_kind, target_id, metadata, created_at
         FROM org_audit_log WHERE org_user_id = $1
        ORDER BY created_at DESC LIMIT $2`,
      [orgUserId, this.clampLimit(limit, 100, 200)],
    );
  }

  // ─── Telemetry replay (DC-16) ─────────────────────────────────────

  async missionTelemetry(missionId: string, admin: AdminContext) {
    const m = await this.db.qOne<{id: string; region_code: string | null}>(
      `SELECT m.id, b.region_code FROM missions m
         LEFT JOIN lite_bookings b ON b.id = m.booking_id
        WHERE m.id = $1`,
      [missionId],
    );
    if (!m) throw new NotFoundException('mission_not_found');
    if (m.region_code) assertRegionScope(admin, m.region_code);
    const points = await this.db.q(
      `SELECT agent_id, lat, lng, heading_deg, speed_kph, accuracy_m,
              distance_to_dropoff_m, battery_pct, recorded_at
         FROM mission_telemetry WHERE mission_id = $1
        ORDER BY recorded_at ASC LIMIT 5000`,
      [missionId],
    );
    return {mission_id: missionId, points};
  }

  // ─── Broadcast log (DC-20) ────────────────────────────────────────

  listRecentBroadcasts(kind?: string, limit?: number) {
    return this.db.q(
      `SELECT id, conversation_id, kind, title, body, severity,
              subject_type, subject_id, created_by, created_at
         FROM system_broadcasts
        WHERE ($1::text IS NULL OR kind::text = $1)
        ORDER BY created_at DESC
        LIMIT $2`,
      [kind ?? null, this.clampLimit(limit, 100, 200)],
    );
  }

  // ─── Analytics rollups (DC-10, DC-15) ─────────────────────────────

  async analytics(admin: AdminContext, days = 30, requestedRegion?: string) {
    const window = Math.min(Math.max(Number(days) || 30, 1), 365);
    const region = this.effectiveRegion(admin, requestedRegion);
    const [byDay, byStatus, offers, missions, walletFlows, regions, lowPrekeys] = await Promise.all([
      this.db.q(
        `SELECT created_at::date AS day, COUNT(*)::int AS bookings,
                COALESCE(SUM(total_eur), 0)::numeric AS gmv_bc
           FROM lite_bookings
          WHERE created_at >= NOW() - make_interval(days => $1)
            AND ($2::text IS NULL OR region_code = $2)
          GROUP BY 1 ORDER BY 1`,
        [window, region],
      ),
      this.db.q(
        `SELECT status::text, COUNT(*)::int AS count
           FROM lite_bookings
          WHERE created_at >= NOW() - make_interval(days => $1)
            AND ($2::text IS NULL OR region_code = $2)
          GROUP BY 1 ORDER BY 2 DESC`,
        [window, region],
      ),
      this.db.q(
        `SELECT o.status::text, COUNT(*)::int AS count
           FROM dispatch_offers o
           JOIN lite_bookings b ON b.id = o.booking_id
          WHERE o.offered_at >= NOW() - make_interval(days => $1)
            AND ($2::text IS NULL OR b.region_code = $2)
          GROUP BY 1`,
        [window, region],
      ),
      this.db.qOne(
        `SELECT COUNT(*) FILTER (WHERE m.status = 'COMPLETED')::int AS completed,
                COUNT(*) FILTER (WHERE m.status = 'ABORTED')::int   AS aborted,
                COALESCE(AVG(EXTRACT(EPOCH FROM (m.ended_at - m.started_at)))
                  FILTER (WHERE m.status = 'COMPLETED' AND m.ended_at IS NOT NULL AND m.started_at IS NOT NULL), 0)::int AS avg_duration_s,
                (SELECT COUNT(*)::int FROM sos_events s
                  WHERE s.triggered_at >= NOW() - make_interval(days => $1)) AS sos_events
           FROM missions m
           LEFT JOIN lite_bookings b ON b.id = m.booking_id
          WHERE m.created_at >= NOW() - make_interval(days => $1)
            AND ($2::text IS NULL OR b.region_code = $2)`,
        [window, region],
      ),
      this.db.q(
        `SELECT type::text, COUNT(*)::int AS count, COALESCE(SUM(amount_credits), 0)::bigint AS credits
           FROM wallet_transactions
          WHERE created_at >= NOW() - make_interval(days => $1) AND status = 'succeeded'
          GROUP BY 1 ORDER BY 3 DESC`,
        [window],
      ),
      this.db.q(
        `SELECT region_code, COUNT(*)::int AS bookings, COALESCE(SUM(total_eur), 0)::numeric AS gmv_bc
           FROM lite_bookings
          WHERE created_at >= NOW() - make_interval(days => $1)
          GROUP BY 1 ORDER BY 2 DESC`,
        [window],
      ),
      // DC-15 — one-time-prekey low-watermark (X3DH silently degrades when a
      // device runs dry); count (user, device) bundles under 10 keys.
      this.db.qOne<{low: number; total_devices: number}>(
        `SELECT COUNT(*) FILTER (WHERE cnt < 10)::int AS low, COUNT(*)::int AS total_devices
           FROM (SELECT user_id, device_id, COUNT(*)::int AS cnt
                   FROM signal_one_time_prekeys GROUP BY 1, 2) k`,
      ),
    ]);
    return {
      window_days: window,
      region: region ?? 'ALL',
      bookings_by_day: byDay,
      bookings_by_status: byStatus,
      dispatch_offers: offers,
      missions,
      wallet_flows: walletFlows,
      regions,
      signal_prekeys: lowPrekeys ?? {low: 0, total_devices: 0},
    };
  }

  // ─── B-812 — provider roster invitation codes, from the ops console ───────
  //
  // Mirrors OrgCpoService.mint/list/revoke (OpsModule cannot import OrgModule
  // — OrgModule imports OpsModule — so the SQL is repeated here and the RULES
  // are shared through `org/invite-code.ts`). The target must be a COMPANY
  // agent: a code minted for anything else would seed a roster nobody owns.

  private async assertProvider(userId: string): Promise<void> {
    const a = await this.db.qOne<{type: string}>(`SELECT type FROM public.agents WHERE user_id = $1`, [userId]);
    if (!a) {throw new NotFoundException('provider_not_found');}
    if (a.type !== 'company') {throw new BadRequestException({code: 'not_a_provider', message: 'Invitation codes belong to a service-provider (company) account.'});}
  }

  async listProviderInvites(userId: string): Promise<{provider: boolean; invites: Array<{
    code: string; member_role: string; call_sign: string | null; status: string;
    expires_at: string | null; created_at: string; redeemed_at: string | null; revoked_at: string | null;
    redeemed_by_name: string | null; created_by_name: string | null;
  }>}> {
    const a = await this.db.qOne<{type: string}>(`SELECT type FROM public.agents WHERE user_id = $1`, [userId]);
    if (!a || a.type !== 'company') {return {provider: false, invites: []};}
    const rows = await this.db.q<{
      code: string; member_role: string; call_sign: string | null; expires_at: Date | null; created_at: Date;
      redeemed_at: Date | null; revoked_at: Date | null; redeemed_by_name: string | null; created_by_name: string | null;
    }>(
      `SELECT i.code, i.member_role, i.call_sign, i.expires_at, i.created_at, i.redeemed_at, i.revoked_at,
              ru.display_name AS redeemed_by_name, cu.display_name AS created_by_name
         FROM provider_invite_codes i
         LEFT JOIN public.users ru ON ru.id = i.redeemed_by
         LEFT JOIN public.users cu ON cu.id = i.created_by
        WHERE i.org_user_id = $1
        ORDER BY i.created_at DESC
        LIMIT 200`,
      [userId],
    );
    return {
      provider: true,
      invites: rows.map(r => ({
        code: r.code, member_role: r.member_role, call_sign: r.call_sign, status: inviteStatus(r),
        expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
        created_at: new Date(r.created_at).toISOString(),
        redeemed_at: r.redeemed_at ? new Date(r.redeemed_at).toISOString() : null,
        revoked_at: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
        redeemed_by_name: r.redeemed_by_name, created_by_name: r.created_by_name,
      })),
    };
  }

  async mintProviderInvite(adminUserId: string, userId: string, dto: MintInviteDto = {}): Promise<{
    id: string; code: string; member_role: string; call_sign: string | null; expires_at: string; created_at: string;
  }> {
    await this.assertProvider(userId);
    const role = normalizeInviteRole(dto.member_role);
    const callSign = normalizeCallSign(dto.call_sign);
    const ttlDays = clampTtlDays(dto.expires_in_days);
    const openCount = await this.db.qOne<{n: string}>(
      `SELECT count(*)::text AS n FROM provider_invite_codes
        WHERE org_user_id = $1 AND redeemed_at IS NULL AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())`,
      [userId],
    );
    if (Number(openCount?.n ?? '0') >= MAX_OPEN_INVITES) {
      throw new BadRequestException({code: 'too_many_open_invites', message: `This provider already has ${MAX_OPEN_INVITES} open invitations. Revoke one first.`});
    }
    for (let attempt = 0; attempt < MINT_MAX_ATTEMPTS; attempt++) {
      const code = generateInviteCode();
      try {
        const row = await this.db.qOne<{id: string; code: string; call_sign: string | null; expires_at: Date; created_at: Date}>(
          `INSERT INTO provider_invite_codes (code, org_user_id, member_role, call_sign, expires_at, created_by)
           VALUES ($1, $2, $3, $4, NOW() + ($5 || ' days')::interval, $6)
           RETURNING id, code, call_sign, expires_at, created_at`,
          [code, userId, role, callSign, String(ttlDays), adminUserId],
        );
        if (!row) {continue;}
        return {
          id: row.id, code: row.code, member_role: role, call_sign: row.call_sign,
          expires_at: new Date(row.expires_at).toISOString(), created_at: new Date(row.created_at).toISOString(),
        };
      } catch (e) {
        if ((e as {code?: string}).code === '23505') {continue;}
        throw e;
      }
    }
    throw new ConflictException('invite_code_collision');
  }

  async revokeProviderInvite(userId: string, rawCode: string): Promise<{ok: true; id: string; code: string}> {
    await this.assertProvider(userId);
    const code = normalizeInviteCode(rawCode);
    if (!code) {throw new BadRequestException('invite_code_required');}
    const row = await this.db.qOne<{id: string; code: string}>(
      `UPDATE provider_invite_codes
          SET revoked_at = NOW()
        WHERE org_user_id = $1 AND code = $2
          AND redeemed_at IS NULL AND revoked_at IS NULL
        RETURNING id, code`,
      [userId, code],
    );
    if (!row) {throw new BadRequestException({code: 'invite_not_open', message: 'That invitation is not open (unknown, already used, or already revoked).'});}
    return {ok: true, id: row.id, code: row.code};
  }
}
