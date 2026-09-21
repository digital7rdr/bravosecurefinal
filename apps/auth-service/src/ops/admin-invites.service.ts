import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import {createHash, randomBytes} from 'crypto';
import {DatabaseService, type Tx} from '../database/database.service';
import {PasswordService} from '../common/services/password.service';
import {AuthService} from '../auth/auth.service';
import {OpsAuditService} from './ops-audit.service';
import {isSuperAdmin, type AdminContext, type AdminRole} from './admin.guard';

const INVITE_TTL_HOURS = 24;

export interface AdminInviteRow {
  id: string;
  email: string;
  display_name: string;
  call_sign: string;
  role: AdminRole;
  region: string;
  invited_by: string;
  expires_at: string;
  redeemed_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface AdminAccountRow {
  user_id: string;
  display_name: string;
  call_sign: string;
  role: AdminRole;
  region: string;
  active: boolean;
  last_active_at: string | null;
  created_at: string;
  email: string | null;
}

/**
 * RS-09 — invite-only admin provisioning + in-band admin role management.
 *
 * Replaces the deleted self-grant-ADMIN registration (the public endpoint
 * stays as a hard-403 stub for monitoring) and the raw-SQL-only role
 * changes. Invariants:
 *   • The invite's role/call_sign/email are BAKED IN by the creating ADMIN;
 *     the redeemer supplies only their own phone + password. A client can
 *     never choose its own admin role — that was the original vulnerability.
 *   • Only the SHA-256 hash of the token is stored; the raw token is
 *     returned exactly once to the creating ADMIN.
 *   • Redemption is single-use and atomic: the mark-redeemed UPDATE and the
 *     users/admin_users inserts share one transaction, so a failed redeem
 *     (e.g. phone already registered) rolls the invite back to pending.
 *   • Every action writes ops_audit (admin.invite.* / admin.role.change).
 */
@Injectable()
export class AdminInvitesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly password: PasswordService,
    private readonly auth: AuthService,
    private readonly audit: OpsAuditService,
  ) {}

  private hashToken(raw: string): string {
    return createHash('sha256').update(raw, 'utf8').digest('hex');
  }

  // ─── Create (ADMIN-only, enforced at the controller) ─────────────────
  async createInvite(admin: AdminContext, dto: {
    email: string; display_name: string; call_sign: string;
    role?: AdminRole; region?: string;
  }): Promise<{invite: AdminInviteRow; token: string}> {
    const email = dto.email.trim().toLowerCase();
    const role: AdminRole = dto.role ?? 'OPS';   // least privilege by default

    const existingUser = await this.db.qOne<{id: string}>(
      `SELECT id FROM public.users WHERE email = $1 AND deleted_at IS NULL`,
      [email],
    );
    if (existingUser) throw new ConflictException('user_already_exists');

    const callSignTaken = await this.db.qOne<{user_id: string}>(
      `SELECT user_id FROM admin_users WHERE call_sign = $1`,
      [dto.call_sign],
    );
    if (callSignTaken) throw new ConflictException('call_sign_taken');

    // An expired invite still occupies the one-pending-per-email slot;
    // sweep it so a re-invite works without a manual revoke.
    await this.db.q(
      `UPDATE public.admin_invites SET revoked_at = NOW()
        WHERE lower(email) = $1 AND redeemed_at IS NULL AND revoked_at IS NULL
          AND expires_at <= NOW()`,
      [email],
    );

    const token = randomBytes(32).toString('base64url');
    let invite: AdminInviteRow | null;
    try {
      invite = await this.db.qOne<AdminInviteRow>(
        `INSERT INTO public.admin_invites
           (email, display_name, call_sign, role, region, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8 || ' hours')::interval)
         RETURNING id, email, display_name, call_sign, role, region, invited_by,
                   expires_at, redeemed_at, revoked_at, created_at`,
        [email, dto.display_name, dto.call_sign, role, dto.region ?? admin.region,
         this.hashToken(token), admin.user_id, String(INVITE_TTL_HOURS)],
      );
    } catch (e) {
      if ((e as {code?: string}).code === '23505') {
        throw new ConflictException('invite_already_pending');
      }
      throw e;
    }
    if (!invite) throw new BadRequestException('invite_create_failed');

    await this.audit.recordAdmin(admin, 'admin.invite.create', 'user', invite.id, {
      role, region: invite.region,
    });
    return {invite, token};
  }

  // ─── List invites (newest first, with derived status) ────────────────
  async listInvites(limit = 50): Promise<Array<AdminInviteRow & {status: string}>> {
    const rows = await this.db.q<AdminInviteRow & {expired: boolean}>(
      `SELECT id, email, display_name, call_sign, role, region, invited_by,
              expires_at, redeemed_at, revoked_at, created_at,
              (expires_at <= NOW()) AS expired
         FROM public.admin_invites
        ORDER BY created_at DESC
        LIMIT $1`,
      [Math.min(Math.max(1, limit), 200)],
    );
    return rows.map(({expired, ...r}) => ({
      ...r,
      status: r.redeemed_at ? 'redeemed'
        : r.revoked_at ? 'revoked'
        : expired ? 'expired'
        : 'pending',
    }));
  }

  // ─── Revoke a pending invite ──────────────────────────────────────────
  async revokeInvite(admin: AdminContext, inviteId: string): Promise<{ok: true}> {
    const row = await this.db.qOne<{id: string}>(
      `UPDATE public.admin_invites SET revoked_at = NOW()
        WHERE id = $1 AND redeemed_at IS NULL AND revoked_at IS NULL
        RETURNING id`,
      [inviteId],
    );
    if (!row) throw new NotFoundException('invite_not_found_or_settled');
    await this.audit.recordAdmin(admin, 'admin.invite.revoke', 'user', inviteId, {});
    return {ok: true};
  }

  // ─── Redeem (PUBLIC endpoint, throttled at the controller) ───────────
  /**
   * B-820 (founder, 2026-09-07) — "on bravo acc it can be no problem, he can
   * still create for ops (ops is a separate thing)".
   *
   * Both provisioning paths used to INSERT a brand-new `public.users` row, so
   * anyone who already had a Bravo app account — which is most of the team,
   * and was the founder's own number — hit `users.phone_e164`'s UNIQUE index
   * and got "That phone or email is already registered". Console authority
   * lives in `admin_users`, not in `users`, so an existing account can simply
   * GAIN the admin row.
   *
   * THE RULE: attaching NEVER touches the existing account's credentials. The
   * password on the form is used only when a user is actually created; an
   * existing person signs in to the console with the Bravo password they
   * already have. Silently rewriting it would let whoever holds an invite (or
   * a super admin acting on the wrong number) take over a live account, and
   * would lock the real owner out of the app.
   */
  private async attachOrCreateUser(
    tx: Tx,
    args: {phone: string; email: string | null; displayName: string; pwHash: string},
  ): Promise<{userId: string; existingAccount: boolean}> {
    const existing = await tx.qOne<{id: string}>(
      `SELECT id FROM public.users WHERE phone_e164 = $1 AND deleted_at IS NULL`,
      [args.phone],
    );
    if (existing) {
      const already = await tx.qOne<{user_id: string}>(
        `SELECT user_id FROM admin_users WHERE user_id = $1`, [existing.id],
      );
      // A second admin row for the same person is not a "grant", it is a
      // duplicate identity. Change the level on the existing row instead.
      if (already) throw new ConflictException('already_an_admin');
      return {userId: existing.id, existingAccount: true};
    }
    const created = await tx.qOne<{id: string}>(
      `INSERT INTO public.users
         (id, email, phone_e164, display_name, role, subscription_tier,
          password_hash, kyc_status, password_set_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'individual', 'lite', $4, 'approved', NOW())
       RETURNING id`,
      [args.email, args.phone, args.displayName, args.pwHash],
    );
    if (!created) throw new BadRequestException('user_create_failed');
    return {userId: created.id, existingAccount: false};
  }

  async redeemInvite(dto: {
    token: string; phone_e164: string; password: string; display_name?: string;
  }): Promise<{ok: true; call_sign: string; role: AdminRole; existing_account: boolean}> {
    const tokenHash = this.hashToken(dto.token);
    const pwHash = await this.password.hash(dto.password);

    try {
      return await this.db.withTransaction(async (tx) => {
        // Atomic single-use claim: the row lock serializes concurrent
        // redeems; the loser sees redeemed_at set and matches nothing.
        const invite = await tx.qOne<AdminInviteRow>(
          `UPDATE public.admin_invites SET redeemed_at = NOW()
            WHERE token_hash = $1 AND redeemed_at IS NULL AND revoked_at IS NULL
              AND expires_at > NOW()
            RETURNING id, email, display_name, call_sign, role, region, invited_by,
                      expires_at, redeemed_at, revoked_at, created_at`,
          [tokenHash],
        );
        if (!invite) throw new BadRequestException('invite_invalid_or_expired');

        // Platform identity: console authority lives in admin_users, NOT
        // users.role (RS-12 taxonomy — console admins are 'individual'), which
        // is why an existing Bravo account can simply gain the admin row
        // (B-820). Its password is left exactly as it was.
        const name = dto.display_name?.trim() || invite.display_name;
        const {userId, existingAccount} = await this.attachOrCreateUser(tx, {
          phone: dto.phone_e164, email: invite.email, displayName: name, pwHash,
        });

        await tx.q(
          `INSERT INTO admin_users (user_id, display_name, call_sign, role, region, phone_e164)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [userId, name, invite.call_sign, invite.role, invite.region, dto.phone_e164],
        );

        await tx.q(
          `UPDATE public.admin_invites SET redeemed_user_id = $2 WHERE id = $1`,
          [invite.id, userId],
        );

        // Audit inside the tx so redeem + audit commit together.
        await tx.q(
          `INSERT INTO ops_audit
             (actor_id, actor_role, actor_call, action, subject_type, subject_id, metadata)
           VALUES ($1, 'SYSTEM', $2, 'admin.invite.redeem', 'user', $3, $4::jsonb)`,
          [userId, invite.call_sign, userId,
           JSON.stringify({
             invite_id: invite.id, role: invite.role, invited_by: invite.invited_by,
             // B-820 — which lane: a fresh account, or console access added to
             // an existing Bravo one (whose password was left untouched).
             existing_account: existingAccount,
           })],
        );

        return {
          ok: true as const, call_sign: invite.call_sign, role: invite.role,
          existing_account: existingAccount,
        };
      });
    } catch (e) {
      // Unique collision (phone/email/call_sign raced into existence since the
      // invite was minted). The tx rolled back, so the invite stays pending
      // and the invitee can retry (e.g. with a different phone).
      if ((e as {code?: string}).code === '23505') {
        throw new ConflictException('user_already_exists');
      }
      throw e;
    }
  }

  // ─── Admin accounts (list + role change) ─────────────────────────────
  /**
   * B-818 — a super admin provisions a console account directly: the login id
   * (phone) and password are set here, the operator signs in with them and the
   * usual OTP. Same rows as the invite redemption writes (users + admin_users),
   * in one transaction, audited against the minting super admin. The plaintext
   * password is hashed and never stored, logged or returned.
   */
  async createAccount(admin: AdminContext, dto: {
    display_name: string; call_sign: string; role: AdminRole;
    phone_e164: string; password: string; email?: string; region?: string;
  }): Promise<{ok: true; user_id: string; call_sign: string; role: AdminRole; existing_account: boolean}> {
    if (!isSuperAdmin(admin.role)) throw new ForbiddenException('super_admin_required');
    const pwHash = await this.password.hash(dto.password);
    const region = (dto.region ?? admin.region ?? 'AE').trim() || 'AE';
    const name = dto.display_name.trim();
    const callSign = dto.call_sign.trim().toUpperCase();
    const phone = dto.phone_e164.trim();
    try {
      return await this.db.withTransaction(async (tx) => {
        // B-820 — an existing Bravo account GAINS the console role; its
        // password is untouched, so the typed one applies only to a brand-new
        // account and the caller is told which happened.
        const {userId, existingAccount} = await this.attachOrCreateUser(tx, {
          phone, email: dto.email?.trim().toLowerCase() || null, displayName: name, pwHash,
        });
        await tx.q(
          `INSERT INTO admin_users (user_id, display_name, call_sign, role, region, phone_e164)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [userId, name, callSign, dto.role, region, phone],
        );
        await tx.q(
          `INSERT INTO ops_audit
             (actor_id, actor_role, actor_call, action, subject_type, subject_id, metadata)
           VALUES ($1, $2, $3, 'admin.account.create', 'user', $4, $5::jsonb)`,
          [admin.user_id, admin.role, admin.call_sign, userId,
           JSON.stringify({role: dto.role, call_sign: callSign, region, existing_account: existingAccount})],
        );
        return {
          ok: true as const, user_id: userId, call_sign: callSign, role: dto.role,
          existing_account: existingAccount,
        };
      });
    } catch (e) {
      const err = e as {code?: string; constraint?: string};
      if (err.code === '23505') {
        throw new ConflictException(/call_sign/.test(err.constraint ?? '') ? 'call_sign_taken' : 'user_already_exists');
      }
      throw e;
    }
  }

  async listAdmins(): Promise<AdminAccountRow[]> {
    return this.db.q<AdminAccountRow>(
      `SELECT au.user_id, au.display_name, au.call_sign, au.role, au.region,
              au.active, au.last_active_at, au.created_at, u.email
         FROM admin_users au
         LEFT JOIN public.users u ON u.id = au.user_id
        ORDER BY au.created_at ASC`,
    );
  }

  async setAdminRole(
    admin: AdminContext, targetUserId: string, newRole: AdminRole,
  ): Promise<{role: AdminRole}> {
    const target = await this.db.qOne<{role: AdminRole; active: boolean}>(
      `SELECT role, active FROM admin_users WHERE user_id = $1`,
      [targetUserId],
    );
    if (!target) throw new NotFoundException('admin_not_found');
    if (target.role === newRole) return {role: newRole};

    // Last-ADMIN guard: the platform must never be left without an account
    // that can manage admins (raw SQL would be the only way back in).
    // B-818 — ADMIN and SUPER_ADMIN are the same tier; the protection is on
    // the TIER (at least one active super admin remains), not the label.
    if (isSuperAdmin(target.role) && !isSuperAdmin(newRole)) {
      const other = await this.db.qOne<{n: string}>(
        `SELECT count(*)::text AS n FROM admin_users
          WHERE role IN ('ADMIN', 'SUPER_ADMIN') AND active = TRUE AND user_id <> $1`,
        [targetUserId],
      );
      if (Number(other?.n ?? 0) === 0) {
        throw new BadRequestException('cannot_demote_last_admin');
      }
    }

    await this.db.q(
      `UPDATE admin_users SET role = $2 WHERE user_id = $1`,
      [targetUserId, newRole],
    );
    await this.audit.recordAdmin(admin, 'admin.role.change', 'user', targetUserId, {
      from: target.role, to: newRole,
    });
    // Kill live sessions so the demoted/promoted console picks up the new
    // role at next login. Server guards fresh-read regardless (RS-05).
    await this.auth.revokeAllUserSessions(targetUserId).catch(() => {});
    return {role: newRole};
  }

  /**
   * OC-09 — admin offboarding. Before this, `admin_users.active` was read by
   * AdminGuard but nothing could set it FALSE: a departed operator could only
   * be demoted to OPS (still full read access) or suspended as a USER. This
   * is the actual off switch.
   */
  async setAdminActive(
    admin: AdminContext, targetUserId: string, active: boolean,
  ): Promise<{active: boolean}> {
    if (targetUserId === admin.user_id) {
      // Deactivating yourself mid-session is only ever a mistake.
      throw new BadRequestException('cannot_deactivate_self');
    }
    const target = await this.db.qOne<{role: AdminRole; active: boolean}>(
      `SELECT role, active FROM admin_users WHERE user_id = $1`,
      [targetUserId],
    );
    if (!target) throw new NotFoundException('admin_not_found');
    if (target.active === active) return {active};

    // Same last-ADMIN guard as demotion: never leave the platform without a
    // working ADMIN account.
    if (!active && isSuperAdmin(target.role)) {
      const other = await this.db.qOne<{n: string}>(
        `SELECT count(*)::text AS n FROM admin_users
          WHERE role IN ('ADMIN', 'SUPER_ADMIN') AND active = TRUE AND user_id <> $1`,
        [targetUserId],
      );
      if (Number(other?.n ?? 0) === 0) {
        throw new BadRequestException('cannot_deactivate_last_admin');
      }
    }

    await this.db.q(
      `UPDATE admin_users SET active = $2 WHERE user_id = $1`,
      [targetUserId, active],
    );
    await this.audit.recordAdmin(
      admin, active ? 'admin.reactivate' : 'admin.deactivate', 'user', targetUserId,
      {role: target.role},
    );
    if (!active) {
      // A deactivated operator must be out NOW, not at next token refresh.
      await this.auth.revokeAllUserSessions(targetUserId).catch(() => {});
    }
    return {active};
  }
}
