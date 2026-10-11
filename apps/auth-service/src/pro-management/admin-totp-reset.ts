import {BadRequestException, ForbiddenException, NotFoundException} from '@nestjs/common';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import type {AuthService} from '../auth/auth.service';
import {isSuperAdmin, type AdminContext} from '../ops/admin.guard';

/**
 * Authenticator app status and reset from the ops console (2026-10-11):
 * People → Users → user, and Internal → Admins.
 *
 *   none      — no authenticator;
 *   pending   — set-up was started (a QR code was shown) but never finished
 *               with a code: sign-in shows the set-up again;
 *   verified  — on: every sign-in asks for its code.
 *
 * Reset removes the authenticator and its backup codes and clears any
 * lockout, then signs the person out everywhere. Their next sign-in then
 * offers a fresh set-up (QR code) when an authenticator is required (HQ staff,
 * the ops console, or AUTH_SECOND_FACTOR=totp), otherwise a code by text or
 * email (AUTH_SECOND_FACTOR=adaptive). Super Admin only; never your own.
 */
export type TotpAdminStatus = 'none' | 'pending' | 'verified';

export async function authenticatorStatus(db: DatabaseService, userId: string): Promise<{status: TotpAdminStatus; verified_at: string | null; staff: boolean}> {
  const row = await db.qOne<{exists: boolean; verified_at: string | null; has_secret: boolean; staff: boolean}>(
    `SELECT EXISTS(SELECT 1 FROM public.users WHERE id = $1 AND deleted_at IS NULL) AS exists,
            (SELECT verified_at::text FROM public.auth_totp_secrets WHERE user_id = $1) AS verified_at,
            EXISTS(SELECT 1 FROM public.auth_totp_secrets WHERE user_id = $1) AS has_secret,
            EXISTS(SELECT 1 FROM admin_users WHERE user_id = $1 AND active) AS staff`,
    [userId],
  );
  if (!row?.exists) throw new NotFoundException('user_not_found');
  const status: TotpAdminStatus = row.verified_at ? 'verified' : row.has_secret ? 'pending' : 'none';
  return {status, verified_at: row.verified_at, staff: row.staff};
}

export async function adminResetAuthenticator(
  deps: {db: DatabaseService; redis: RedisService; auth: AuthService},
  admin: AdminContext,
  targetUserId: string,
): Promise<{previous: TotpAdminStatus; sessions_revoked: number; staff: boolean}> {
  if (!isSuperAdmin(admin.role)) throw new ForbiddenException('super_admin_required');
  if (admin.user_id === targetUserId) throw new BadRequestException('use_own_security_page');

  const before = await authenticatorStatus(deps.db, targetUserId);
  await deps.db.q(`DELETE FROM public.auth_totp_backup_codes WHERE user_id = $1`, [targetUserId]);
  await deps.db.q(`DELETE FROM public.auth_totp_secrets WHERE user_id = $1`, [targetUserId]);
  // A lockout from earlier wrong codes would otherwise outlive the reset.
  await deps.redis.clearTotpFailures(targetUserId).catch(() => undefined);
  await deps.redis.takeOnce(`totp-lock:${targetUserId}`).catch(() => null);
  const sessions_revoked = await deps.auth.revokeAllUserSessions(targetUserId, 'ops-console').catch(() => 0);
  return {previous: before.status, sessions_revoked, staff: before.staff};
}
