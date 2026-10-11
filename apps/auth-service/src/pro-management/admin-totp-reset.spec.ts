import {BadRequestException, ForbiddenException, NotFoundException} from '@nestjs/common';
import {adminResetAuthenticator, authenticatorStatus} from './admin-totp-reset';
import type {AdminContext} from '../ops/admin.guard';

/** Ops console → authenticator status and Reset authenticator (2026-10-11). */

const SUPER: AdminContext = {user_id: 'a-1', role: 'SUPER_ADMIN', call_sign: 'HQ-1', region: 'AE'};

function deps(row: {exists: boolean; verified_at: string | null; has_secret: boolean; staff: boolean}) {
  const sql: string[] = [];
  const db = {
    qOne: jest.fn(async () => row),
    q: jest.fn(async (s: string) => { sql.push(s); return []; }),
  };
  const redis = {clearTotpFailures: jest.fn(async () => undefined), takeOnce: jest.fn(async () => null)};
  const auth = {revokeAllUserSessions: jest.fn(async () => 1)};
  return {d: {db: db as never, redis: redis as never, auth: auth as never}, db, sql, redis, auth};
}

describe('authenticatorStatus', () => {
  it('none / pending (set-up never finished) / verified', async () => {
    expect((await authenticatorStatus(deps({exists: true, verified_at: null, has_secret: false, staff: false}).d.db, 'u')).status).toBe('none');
    expect((await authenticatorStatus(deps({exists: true, verified_at: null, has_secret: true, staff: false}).d.db, 'u')).status).toBe('pending');
    expect((await authenticatorStatus(deps({exists: true, verified_at: '2026-10-01', has_secret: true, staff: true}).d.db, 'u')))
      .toEqual({status: 'verified', verified_at: '2026-10-01', staff: true});
    await expect(authenticatorStatus(deps({exists: false, verified_at: null, has_secret: false, staff: false}).d.db, 'u')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('adminResetAuthenticator', () => {
  it('removes the authenticator and backup codes, clears the lockout, signs out everywhere', async () => {
    const t = deps({exists: true, verified_at: '2026-10-01', has_secret: true, staff: false});
    await expect(adminResetAuthenticator(t.d, SUPER, 'u-9')).resolves.toEqual({previous: 'verified', sessions_revoked: 1, staff: false});
    expect(t.sql.join('\n')).toMatch(/DELETE FROM public\.auth_totp_backup_codes[\s\S]*DELETE FROM public\.auth_totp_secrets/);
    expect(t.redis.clearTotpFailures).toHaveBeenCalledWith('u-9');
    expect(t.redis.takeOnce).toHaveBeenCalledWith('totp-lock:u-9');
    expect(t.auth.revokeAllUserSessions).toHaveBeenCalledWith('u-9', 'ops-console');
  });

  it('Super Admin only; never your own; not an erased account', async () => {
    const row = {exists: true, verified_at: null, has_secret: true, staff: false};
    await expect(adminResetAuthenticator(deps(row).d, {...SUPER, role: 'RISK_ADMIN'}, 'u-9')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(adminResetAuthenticator(deps(row).d, SUPER, 'a-1')).rejects.toBeInstanceOf(BadRequestException);
    const gone = deps({...row, exists: false});
    await expect(adminResetAuthenticator(gone.d, SUPER, 'u-9')).rejects.toBeInstanceOf(NotFoundException);
    expect(gone.sql).toHaveLength(0);
  });
});
