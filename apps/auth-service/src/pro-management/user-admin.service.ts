import {ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional} from '@nestjs/common';
import {randomBytes, randomInt} from 'node:crypto';
import {PasswordService} from '../common/services/password.service';
import {DatabaseService} from '../database/database.service';
import {SmsService} from '../common/services/sms.service';
import type {AdminContext} from '../ops/admin.guard';
import {ProManagementService} from './pro-management.service';

export type AppAccountType = 'individual' | 'agency' | 'cpo';

export interface CreateAppUserInput {
  account_type: AppAccountType;
  display_name: string;
  email: string;
  phone_e164: string;
  /** cpo only — the agency (company agent user id) the officer belongs to. */
  agency_user_id?: string;
  /** agency only — ISO-2 coverage country (default AE, as createOrg). */
  coverage_country?: string;
  /** cpo only. */
  call_sign?: string;
}

export interface InviteStatus {
  pending: boolean;
  invited_at: string | null;
  expires_at: string | null;
  expired: boolean;
  /** true once the person claimed the invite (set their own password). */
  claimed: boolean;
}

export const INVITE_DAYS = 14;

/**
 * Ops-created app accounts WITHOUT an admin ever handling a password.
 *
 * Every account is born a PENDING INVITE: password_hash NULL + invited_at +
 * invite_expires_at. The person installs the app and signs up with that phone
 * number; AuthService.registerVerify sees the pending invite, the SMS OTP proves
 * the phone, and the row is CLAIMED (they set their own password). Until then
 * login() refuses the account (NULL password_hash).
 *
 * Agencies and CPOs reuse ProManagementService.createOrg / createCpo UNCHANGED,
 * so the agents / agent_profiles / org_members scaffolding is exactly what Pro
 * Management produces. Those methods demand a temp password; we hand them a
 * random one nobody ever sees and immediately null it.
 */
@Injectable()
export class UserAdminService {
  private readonly log = new Logger(UserAdminService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly proMgmt: ProManagementService,
    private readonly sms: SmsService,
    @Optional() private readonly passwords?: PasswordService,
  ) {}

  async createUser(admin: AdminContext, dto: CreateAppUserInput) {
    const email = dto.email.trim();
    const phone = dto.phone_e164.trim();
    const existing = await this.db.qOne<{id: string}>(
      `SELECT id FROM public.users WHERE (email = $1 OR phone_e164 = $2) AND deleted_at IS NULL`,
      [email, phone],
    );
    if (existing) {throw new ConflictException('user_already_exists');}

    let userId: string;
    if (dto.account_type === 'individual') {
      const row = await this.db.qOne<{id: string}>(
        `INSERT INTO public.users
           (id, email, phone_e164, display_name, role, subscription_tier, password_hash, kyc_status,
            invited_at, invited_by, invite_expires_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'individual', 'lite', NULL, 'approved',
                 now(), $4, now() + make_interval(days => $5))
         RETURNING id`,
        [email, phone, dto.display_name.trim(), admin.user_id, INVITE_DAYS],
      );
      userId = row!.id;
    } else if (dto.account_type === 'agency') {
      const {org} = await this.proMgmt.createOrg(admin, {
        display_name: dto.display_name.trim(), email, phone_e164: phone,
        temp_password: UserAdminService.throwawayPassword(), coverage_country: dto.coverage_country,
      });
      userId = String(org.id);
      await this.convertToInvite(userId, admin.user_id);
    } else {
      if (!dto.agency_user_id) {throw new ConflictException('agency_required');}
      const {member} = await this.proMgmt.createCpo(admin, {
        org_user_id: dto.agency_user_id, display_name: dto.display_name.trim(), email, phone_e164: phone,
        temp_password: UserAdminService.throwawayPassword(), call_sign: dto.call_sign,
      });
      userId = String((member as {member_user_id: string}).member_user_id);
      await this.convertToInvite(userId, admin.user_id);
    }

    const invite = await this.inviteStatus(userId);
    const sms = await this.sendInviteSms(phone, invite.expires_at);
    return {user_id: userId, account_type: dto.account_type, invite, sms_sent: sms};
  }

  async resendInvite(_admin: AdminContext, userId: string) {
    const row = await this.db.qOne<{phone_e164: string | null}>(
      `UPDATE public.users
          SET invite_expires_at = now() + make_interval(days => $2)
        WHERE id = $1 AND invited_at IS NOT NULL AND password_hash IS NULL AND deleted_at IS NULL
        RETURNING phone_e164`,
      [userId, INVITE_DAYS],
    );
    if (!row) {throw new ConflictException('not_a_pending_invite');}
    const invite = await this.inviteStatus(userId);
    const sms = row.phone_e164 ? await this.sendInviteSms(row.phone_e164, invite.expires_at) : false;
    return {user_id: userId, invite, sms_sent: sms};
  }

  /**
   * 2026-10-01 — first sign-in password for a PENDING invite, issued from the
   * ops console. For when the SMS invite cannot reach the person (SMS is off
   * on this server) — the alternative was a root shell on the server.
   *
   * Rules:
   *   - only a never-claimed invite (invited_at set, no password, not deleted,
   *     not suspended): an account already in use is never touched, so this
   *     is not a takeover tool;
   *   - never an HQ admin account (admins are made on Internal → Admins);
   *   - the server makes the password (~57 bits), the admin cannot choose it,
   *     and it is returned exactly once, never stored or logged in clear;
   *   - password_set_at stays NULL: the password is TEMPORARY. Officers are
   *     made to replace it by the app, the provider console asks the agency
   *     to, and the first change records password_set_at.
   * Issuing it also closes the window in which anyone who knows the phone
   * number could claim the invite through the app's sign-up.
   */
  async issueInvitePassword(_admin: AdminContext, userId: string): Promise<{user_id: string; password: string; account_type: AppAccountType}> {
    if (!this.passwords) throw new Error('PasswordService not provided');
    const row = await this.db.qOne<{is_admin: boolean; agent_type: string | null}>(
      `SELECT EXISTS(SELECT 1 FROM admin_users au WHERE au.user_id = u.id) AS is_admin,
              a.type AS agent_type
         FROM public.users u LEFT JOIN agents a ON a.user_id = u.id
        WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [userId],
    );
    if (!row) throw new NotFoundException('user_not_found');
    if (row.is_admin) throw new ForbiddenException('admin_accounts_not_allowed');

    const password = UserAdminService.signInPassword();
    const hash = await this.passwords.hash(password);
    const updated = await this.db.qOne<{id: string}>(
      `UPDATE public.users
          SET password_hash = $2, password_set_at = NULL, invite_expires_at = NULL
        WHERE id = $1 AND invited_at IS NOT NULL AND password_hash IS NULL
          AND deleted_at IS NULL AND suspended_at IS NULL
        RETURNING id`,
      [userId, hash],
    );
    if (!updated) throw new ConflictException('not_a_pending_invite');
    const account_type: AppAccountType = row.agent_type === 'company' ? 'agency' : row.agent_type ? 'cpo' : 'individual';
    return {user_id: userId, password, account_type};
  }

  /** xxxx-xxxx-xxxx-0000, no look-alike characters (~57 bits). */
  static signInPassword(): string {
    const a = 'abcdefghjkmnpqrstuvwxyz23456789';
    const d = '23456789';
    const pick = (set: string, n: number) => Array.from({length: n}, () => set[randomInt(set.length)]).join('');
    return `${pick(a, 4)}-${pick(a, 4)}-${pick(a, 4)}-${pick(d, 4)}`;
  }

  async inviteStatus(userId: string): Promise<InviteStatus> {
    const r = await this.db.qOne<{invited_at: string | null; invite_expires_at: string | null; has_password: boolean; expired: boolean}>(
      `SELECT invited_at::text AS invited_at, invite_expires_at::text AS invite_expires_at,
              (password_hash IS NOT NULL) AS has_password,
              COALESCE(invite_expires_at <= now(), false) AS expired
         FROM public.users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!r) {throw new NotFoundException('user_not_found');}
    const invited = r.invited_at !== null;
    return {
      pending: invited && !r.has_password,
      invited_at: r.invited_at,
      expires_at: invited && !r.has_password ? r.invite_expires_at : null,
      expired: invited && !r.has_password && r.expired,
      claimed: invited && r.has_password,
    };
  }

  private async convertToInvite(userId: string, adminId: string): Promise<void> {
    await this.db.q(
      `UPDATE public.users
          SET password_hash = NULL, password_set_at = NULL,
              invited_at = now(), invited_by = $2, invite_expires_at = now() + make_interval(days => $3)
        WHERE id = $1`,
      [userId, adminId, INVITE_DAYS],
    );
  }

  private async sendInviteSms(phone: string, expiresAt: string | null): Promise<boolean> {
    const until = expiresAt
      ? new Date(expiresAt).toLocaleDateString('en-GB', {day: 'numeric', month: 'short', timeZone: 'UTC'})
      : `${INVITE_DAYS} days`;
    const body = `Bravo Secure: your account is ready. Install the Bravo Secure app and sign up with this number to activate it. Invite valid until ${until}.`;
    try {
      return (await this.sms.sendSms(phone, body)).sent;
    } catch (e) {
      this.log.warn(`invite SMS failed: ${(e as Error).message}`);
      return false;
    }
  }

  private static throwawayPassword(): string {
    // Satisfies createOrg/createCpo's temp-password contract; nulled right after.
    return randomBytes(24).toString('base64url');
  }
}
