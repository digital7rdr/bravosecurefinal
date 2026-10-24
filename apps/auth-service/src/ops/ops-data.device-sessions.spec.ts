/**
 * 2026-10-24 — a console device revoke / suspend / delete ends the sessions
 * the way a sign-out does: the live access tokens stop working at once and the
 * devices' push registrations are dropped. Before, a deleted account kept its
 * messenger socket (and kept placing calls) until its access token expired,
 * and calls to it still woke a phone that may now be signed in to someone else.
 */
import {NotFoundException} from '@nestjs/common';
import {OpsDataService} from './ops-data.service';

const ROWS = [
  {id: 'r1', device_id: 'phone-1', old_jti: 'jti-1'},
  {id: 'r2', device_id: 'phone-2', old_jti: null},
];

function makeSvc(opts: {redisThrows?: boolean; oneRow?: typeof ROWS[number] | null} = {}) {
  const revokeJtis = jest.fn(async (_j: string[]) => { if (opts.redisThrows) throw new Error('redis down'); });
  const markPushRevokedMany = jest.fn(async (_p: Array<{userId: string; deviceId: string}>) => {
    if (opts.redisThrows) throw new Error('redis down');
  });
  const db = {
    q: jest.fn(async (sql: string, _params?: unknown[]) => (/UPDATE auth_devices/.test(sql) ? ROWS : [])),
    qOne: jest.fn(async (sql: string, _params?: unknown[]) => {
      if (/UPDATE auth_devices/.test(sql)) return opts.oneRow === undefined ? ROWS[0] : opts.oneRow;
      if (/SET suspended_at = NOW\(\)/.test(sql)) return {id: 'u-1'};
      return null;
    }),
  };
  const redis = {client: {del: jest.fn(async () => 1)}, revokeJtis, markPushRevokedMany};
  const svc = new OpsDataService(db as never, redis as never);
  return {svc, db, revokeJtis, markPushRevokedMany};
}

describe('console revoke ends the device sessions', () => {
  it('revoking one device kills its access token and its push registration', async () => {
    const {svc, db, revokeJtis, markPushRevokedMany} = makeSvc();
    await expect(svc.revokeUserDevice('u-1', 'r1')).resolves.toEqual({ok: true, device_row_id: 'r1'});
    const sql = String(db.qOne.mock.calls[0][0]);
    expect(sql).toMatch(/current_jti AS old_jti/);
    expect(db.qOne.mock.calls[0][1]).toEqual(['r1', 'u-1']);
    expect(revokeJtis).toHaveBeenCalledWith(['jti-1']);
    expect(markPushRevokedMany).toHaveBeenCalledWith([{userId: 'u-1', deviceId: 'phone-1'}]);
  });

  it('an unknown or already-revoked device is still a 404 and touches nothing', async () => {
    const {svc, revokeJtis, markPushRevokedMany} = makeSvc({oneRow: null});
    await expect(svc.revokeUserDevice('u-1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
    expect(revokeJtis).not.toHaveBeenCalled();
    expect(markPushRevokedMany).not.toHaveBeenCalled();
  });

  it('suspending an account ends every session and drops every push registration', async () => {
    const {svc, revokeJtis, markPushRevokedMany} = makeSvc();
    const r = await svc.suspendUser('adm-1', 'u-1', 'fraud review');
    expect(r.ok).toBe(true);
    expect(revokeJtis).toHaveBeenCalledWith(['jti-1']);
    expect(markPushRevokedMany).toHaveBeenCalledWith([
      {userId: 'u-1', deviceId: 'phone-1'},
      {userId: 'u-1', deviceId: 'phone-2'},
    ]);
  });

  it('a Redis outage does not undo or fail the revoke', async () => {
    const {svc} = makeSvc({redisThrows: true});
    await expect(svc.revokeUserDevice('u-1', 'r1')).resolves.toEqual({ok: true, device_row_id: 'r1'});
  });
});
