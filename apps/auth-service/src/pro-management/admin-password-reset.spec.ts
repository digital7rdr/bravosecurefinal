import {BadRequestException, ConflictException, ForbiddenException, NotFoundException} from '@nestjs/common';
import {adminResetPassword} from './admin-password-reset';
import type {AdminContext} from '../ops/admin.guard';

/** Ops console → Reset password (2026-10-11). */

const SUPER: AdminContext = {user_id: 'a-1', role: 'SUPER_ADMIN', call_sign: 'HQ-1', region: 'AE'};

function deps(row: {suspended: boolean; console_admin: boolean} | null = {suspended: false, console_admin: false}) {
  const calls: {sql: string; params: unknown[]}[] = [];
  const db = {
    qOne: jest.fn(async (sql: string, params: unknown[]) => {
      calls.push({sql, params});
      if (/^\s*SELECT/.test(sql)) return row;
      if (/UPDATE public\.users/.test(sql)) return row ? {id: params[0]} : null;
      return null;
    }),
  };
  const passwords = {hash: jest.fn(async (p: string) => `hash:${p}`)};
  const auth = {revokeAllUserSessions: jest.fn(async () => 3)};
  return {d: {db: db as never, passwords: passwords as never, auth: auth as never}, calls, passwords, auth};
}

describe('adminResetPassword', () => {
  it('makes a strong temporary password, stores only its hash, signs out every device', async () => {
    const t = deps();
    const out = await adminResetPassword(t.d, SUPER, 'u-9');
    expect(out.password).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}-[2-9]{4}$/);
    expect(out.sessions_revoked).toBe(3);
    const upd = t.calls.find(c => /UPDATE public\.users/.test(c.sql))!;
    expect(upd.sql).toMatch(/password_set_at = NULL/);
    expect(upd.params).toEqual(['u-9', `hash:${out.password}`]);
    expect(t.auth.revokeAllUserSessions).toHaveBeenCalledWith('u-9', 'ops-console');
  });

  it('works for console admins too, and says so', async () => {
    const out = await adminResetPassword(deps({suspended: false, console_admin: true}).d, SUPER, 'a-2');
    expect(out.console_admin).toBe(true);
  });

  it('Super Admin only; never your own account', async () => {
    await expect(adminResetPassword(deps().d, {...SUPER, role: 'OPERATION_ADMIN'}, 'u-9')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(adminResetPassword(deps().d, SUPER, 'a-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses erased and suspended accounts, changing nothing', async () => {
    const gone = deps(null);
    await expect(adminResetPassword(gone.d, SUPER, 'u-9')).rejects.toBeInstanceOf(NotFoundException);
    const susp = deps({suspended: true, console_admin: false});
    await expect(adminResetPassword(susp.d, SUPER, 'u-9')).rejects.toBeInstanceOf(ConflictException);
    expect(susp.passwords.hash).not.toHaveBeenCalled();
    expect(susp.auth.revokeAllUserSessions).not.toHaveBeenCalled();
  });
});
