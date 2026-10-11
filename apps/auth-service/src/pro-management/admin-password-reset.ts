import {BadRequestException, ConflictException, ForbiddenException, NotFoundException} from '@nestjs/common';
import type {DatabaseService} from '../database/database.service';
import type {PasswordService} from '../common/services/password.service';
import type {AuthService} from '../auth/auth.service';
import {isSuperAdmin, type AdminContext} from '../ops/admin.guard';
import {UserAdminService} from './user-admin.service';

/**
 * Reset a person's password from the ops console (2026-10-11): People →
 * Users → user, and Internal → Admins.
 *
 * Rules:
 *   - Super Admin only (the rank that already mints accounts);
 *   - never your own account (use Change password; this would sign you out
 *     with a password you did not choose);
 *   - not an erased or suspended account;
 *   - the SERVER makes the temporary password (~57 bits); the admin cannot
 *     choose it; it is returned exactly once and never stored or logged in
 *     clear;
 *   - password_set_at is cleared: the password is TEMPORARY (officers are
 *     made to replace it by the app);
 *   - every signed-in device of that person is signed out at once;
 *   - the authenticator app, if any, is left as it is.
 */
export async function adminResetPassword(
  deps: {db: DatabaseService; passwords: PasswordService; auth: AuthService},
  admin: AdminContext,
  targetUserId: string,
): Promise<{password: string; sessions_revoked: number; console_admin: boolean}> {
  if (!isSuperAdmin(admin.role)) throw new ForbiddenException('super_admin_required');
  if (admin.user_id === targetUserId) throw new BadRequestException('use_change_password');

  const row = await deps.db.qOne<{suspended: boolean; console_admin: boolean}>(
    `SELECT (u.suspended_at IS NOT NULL) AS suspended,
            EXISTS(SELECT 1 FROM admin_users au WHERE au.user_id = u.id) AS console_admin
       FROM public.users u WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [targetUserId],
  );
  if (!row) throw new NotFoundException('user_not_found');
  if (row.suspended) throw new ConflictException('user_suspended');

  const password = UserAdminService.signInPassword();
  const hash = await deps.passwords.hash(password);
  const updated = await deps.db.qOne<{id: string}>(
    `UPDATE public.users
        SET password_hash = $2, password_set_at = NULL, invite_expires_at = NULL, updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL AND suspended_at IS NULL
      RETURNING id`,
    [targetUserId, hash],
  );
  if (!updated) throw new NotFoundException('user_not_found');
  const sessions_revoked = await deps.auth.revokeAllUserSessions(targetUserId, 'ops-console').catch(() => 0);
  return {password, sessions_revoked, console_admin: row.console_admin};
}
