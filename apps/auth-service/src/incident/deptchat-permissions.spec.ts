import {ExecutionContext, ForbiddenException, NotFoundException} from '@nestjs/common';
import type {ConfigService} from '@nestjs/config';
import {DeptChatV2Guard} from '../common/guards/dept-chat-v2.guard';
import {OrgManagerGuard} from '../org/org-manager.guard';
import type {DatabaseService} from '../database/database.service';

/**
 * Dept Chat v2 permission matrix (Step 16). The per-cell enforcement lives in:
 *  - feature visibility  → DeptChatV2Guard (here)
 *  - manager surface     → OrgManagerGuard (here)
 *  - tenant isolation    → service checks (attendance.service.spec: cross-org
 *                          assign; incident.service.spec: submitter-only attach,
 *                          cross-org evidence 403, company-only reopen)
 * This spec proves the two guard cells the matrix hinges on.
 */
const ctxWith = (user: unknown): ExecutionContext =>
  ({switchToHttp: () => ({getRequest: () => ({user})})} as unknown as ExecutionContext);

describe('Dept Chat v2 · permission matrix', () => {
  describe('feature flag (DeptChatV2Guard)', () => {
    it('hides every v2 route when the flag is off (404)', () => {
      const guard = new DeptChatV2Guard({get: () => false} as unknown as ConfigService);
      expect(() => guard.canActivate(ctxWith({sub: 'anyone'}))).toThrow(NotFoundException);
    });
  });

  describe('manager surface (OrgManagerGuard)', () => {
    it('DENIES a normal member (not company, not a manager) — no queue / review / export', async () => {
      // vs2 item 4 — the managed-org lookup is `q` now (a manager may hold
      // several orgs), so the mock has to answer it too. An undefined where
      // the driver always returns an array is a harness gap.
      const db = {
        qOne: jest.fn().mockResolvedValue(null),
        q: jest.fn().mockResolvedValue([]),
      } as unknown as DatabaseService;
      const guard = new OrgManagerGuard(db);
      await expect(guard.canActivate(ctxWith({sub: 'cpo-1'}))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('ALLOWS the company account (Path 1) — full org scope', async () => {
      // P1-2 — the guard's three arms are one UNION read via db.q now.
      const q = jest.fn().mockResolvedValueOnce([{org_user_id: 'org-9', department: null}]);
      const guard = new OrgManagerGuard({q} as unknown as DatabaseService);
      await expect(guard.canActivate(ctxWith({sub: 'org-9'}))).resolves.toBe(true);
    });

    it('ALLOWS a delegated manager (Path 2)', async () => {
      const q = jest.fn().mockResolvedValueOnce([{org_user_id: 'org-9', department: null}]); // manager arm
      const guard = new OrgManagerGuard({q} as unknown as DatabaseService);
      await expect(guard.canActivate(ctxWith({sub: 'mgr-1'}))).resolves.toBe(true);
    });
  });
});
