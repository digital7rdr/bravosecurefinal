/**
 * B-818 critic P1 — `POST /ops/users/:id/suspend` is a rank-2 lever and
 * `users.suspended_at` is the login gate for console admins too, so an
 * Operation Admin could have suspended every super admin's login while the
 * admin_users last-super guards never ran. RED-first: `assertConsoleAdminTarget`
 * did not exist.
 */
import {BadRequestException, ForbiddenException} from '@nestjs/common';
import {OpsDataService} from './ops-data.service';
import type {AdminContext} from './admin.guard';

const SUPER: AdminContext = {user_id: 'a-1', role: 'SUPER_ADMIN', call_sign: 'SUP-01', region: 'AE'};
const OPERATION: AdminContext = {user_id: 'a-2', role: 'OPERATION_ADMIN', call_sign: 'OPS-A1', region: 'AE'};

function make(qOne: jest.Mock) {
  const db = {qOne, q: jest.fn().mockResolvedValue([]), withTransaction: jest.fn()} as never;
  // Constructor deps beyond the db are unused by the method under test.
  return new OpsDataService(db);
}

describe('OpsDataService.assertConsoleAdminTarget', () => {
  it('a plain user (no admin_users row) is not a console admin — no refusal, one lookup', async () => {
    const qOne = jest.fn().mockResolvedValueOnce(null);
    await expect(make(qOne).assertConsoleAdminTarget(OPERATION, 'u-9')).resolves.toBeUndefined();
    expect(qOne).toHaveBeenCalledTimes(1);
    expect(qOne.mock.calls[0][0]).toMatch(/FROM admin_users WHERE user_id = \$1/);
  });

  it('a console admin target is refused to any non-super caller', async () => {
    const qOne = jest.fn().mockResolvedValueOnce({role: 'RISK_ADMIN', active: true});
    await expect(make(qOne).assertConsoleAdminTarget(OPERATION, 'u-9')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a super may suspend another admin, but never the last active super', async () => {
    const domainTarget = jest.fn().mockResolvedValueOnce({role: 'COMMUNICATION_ADMIN', active: true});
    await expect(make(domainTarget).assertConsoleAdminTarget(SUPER, 'u-9')).resolves.toBeUndefined();

    const lastSuper = jest.fn()
      .mockResolvedValueOnce({role: 'ADMIN', active: true})
      .mockResolvedValueOnce({n: '0'});
    await expect(make(lastSuper).assertConsoleAdminTarget(SUPER, 'u-9')).rejects.toBeInstanceOf(BadRequestException);
    expect(lastSuper.mock.calls[1][0]).toMatch(/role IN \('ADMIN', 'SUPER_ADMIN'\) AND active = TRUE AND user_id <> \$1/);

    const notLast = jest.fn()
      .mockResolvedValueOnce({role: 'SUPER_ADMIN', active: true})
      .mockResolvedValueOnce({n: '2'});
    await expect(make(notLast).assertConsoleAdminTarget(SUPER, 'u-9')).resolves.toBeUndefined();
  });

  it('an already-inactive super is not counted as a lockout', async () => {
    const qOne = jest.fn().mockResolvedValueOnce({role: 'SUPER_ADMIN', active: false});
    await expect(make(qOne).assertConsoleAdminTarget(SUPER, 'u-9')).resolves.toBeUndefined();
    expect(qOne).toHaveBeenCalledTimes(1);
  });
});
