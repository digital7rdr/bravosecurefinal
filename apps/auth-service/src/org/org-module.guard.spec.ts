import 'reflect-metadata';
import {ForbiddenException, type ExecutionContext} from '@nestjs/common';
import {Reflector} from '@nestjs/core';
import {GUARDS_METADATA, METHOD_METADATA} from '@nestjs/common/constants';
import {OrgModuleGuard, ORG_MODULES_KEY, ORG_OWNER_ONLY} from './org-module.guard';
import {OrgController} from './org.controller';
import {DispatchController} from '../dispatch/dispatch.controller';
import {DispatchJobsController} from '../dispatch/dispatch-jobs.controller';
import {OrgProviderController} from './org-provider.controller';
import {OrgCpoService} from './org-cpo.service';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {OrgManagerGuard} from './org-manager.guard';
import type {DatabaseService} from '../database/database.service';

const OWNER = '11111111-1111-4111-8111-111111111111';
const MGR   = '22222222-2222-4222-8222-222222222222';

function run(required: string[] | undefined, orgManager: unknown, granted: string[] | null | undefined) {
  const db = {qOne: jest.fn().mockResolvedValue(granted === undefined ? null : {permitted_modules: granted})};
  const reflector = {getAllAndOverride: jest.fn().mockReturnValue(required)} as unknown as Reflector;
  const guard = new OrgModuleGuard(reflector, db as unknown as DatabaseService);
  const ctx = {
    getHandler: () => ({}), getClass: () => ({}),
    switchToHttp: () => ({getRequest: () => ({orgManager})}),
  } as unknown as ExecutionContext;
  return {result: guard.canActivate(ctx), db};
}

const owner   = {user_id: OWNER, org_user_id: OWNER, department: null};
const manager = {user_id: MGR,   org_user_id: OWNER, department: null};

describe('OrgModuleGuard', () => {
  it('routes without a module list are open to every manager', async () => {
    const {result, db} = run(undefined, manager, []);
    await expect(result).resolves.toBe(true);
    expect(db.qOne).not.toHaveBeenCalled();
  });

  it('the owner reaches every module without a lookup', async () => {
    const {result, db} = run(['earn'], owner, []);
    await expect(result).resolves.toBe(true);
    expect(db.qOne).not.toHaveBeenCalled();
  });

  it('owner-only routes refuse a manager whatever they were granted', async () => {
    await expect(run([ORG_OWNER_ONLY], manager, [...OrgCpoService.MANAGER_MODULES]).result)
      .rejects.toThrow('org_owner_only');
  });

  it('a manager with one of the listed modules is admitted', async () => {
    const {result, db} = run(['roster', 'jobs'], manager, ['jobs']);
    await expect(result).resolves.toBe(true);
    // the grant is read for THIS org and THIS manager
    expect(db.qOne.mock.calls[0][1]).toEqual([OWNER, MGR]);
  });

  it('a manager without the module is refused', async () => {
    await expect(run(['earn'], manager, ['jobs', 'roster']).result).rejects.toThrow(ForbiddenException);
  });

  it('NULL grant and no membership row both mean nothing', async () => {
    await expect(run(['jobs'], manager, null).result).rejects.toThrow(ForbiddenException);
    await expect(run(['jobs'], manager, undefined).result).rejects.toThrow(ForbiddenException);
  });

  it('fails closed when OrgManagerGuard did not run', async () => {
    await expect(run(['jobs'], undefined, ['jobs']).result).rejects.toThrow(ForbiddenException);
  });
});

/* ── Binding: every provider route is gated as intended ──────────────── */

const handlers = (cls: {prototype: object}) =>
  Object.getOwnPropertyNames(cls.prototype)
    .filter(n => n !== 'constructor')
    .map(n => ({name: n, fn: (cls.prototype as Record<string, unknown>)[n] as object}))
    .filter(h => Reflect.getMetadata(METHOD_METADATA, h.fn) !== undefined);

const modulesOf = (fn: object) => Reflect.getMetadata(ORG_MODULES_KEY, fn) as string[] | undefined;
const guardsOf = (t: object) => ((Reflect.getMetadata(GUARDS_METADATA, t) ?? []) as Array<{name: string}>).map(g => g.name);

describe('provider route gating (binding)', () => {
  it('every /org/* route except the headcount summary names its modules', () => {
    const ungated = handlers(OrgController).filter(h => !modulesOf(h.fn)).map(h => h.name);
    expect(ungated).toEqual(['getSummary']);
  });

  it('every gated route also binds OrgModuleGuard (metadata alone gates nothing)', () => {
    for (const cls of [OrgController, DispatchController, DispatchJobsController, OrgProviderController]) {
      for (const h of handlers(cls)) {
        if (modulesOf(h.fn)) expect(guardsOf(h.fn)).toContain(OrgModuleGuard.name);
      }
    }
  });

  it('only real module keys are used', () => {
    const known = new Set<string>([...OrgCpoService.MANAGER_MODULES, ORG_OWNER_ONLY]);
    for (const cls of [OrgController, DispatchController, DispatchJobsController, OrgProviderController]) {
      for (const h of handlers(cls)) for (const k of modulesOf(h.fn) ?? []) expect(known.has(k)).toBe(true);
    }
  });

  it('every Phase 2 route names its modules', () => {
    expect(handlers(OrgProviderController).filter(h => !modulesOf(h.fn)).map(h => h.name)).toEqual([]);
    expect(modulesOf(OrgProviderController.prototype.createVehicle)).toEqual(['fleet']);
    expect(modulesOf(OrgProviderController.prototype.assignVehicle)).toEqual(['jobs']);
    expect(modulesOf(OrgProviderController.prototype.proAssignments)).toEqual(['pro']);
    expect(modulesOf(OrgProviderController.prototype.statement)).toEqual(['earn']);
  });

  it('money and permission routes are pinned', () => {
    expect(modulesOf(OrgController.prototype.getEarnings)).toEqual(['earn']);
    expect(modulesOf(OrgController.prototype.setManagerPermissions)).toEqual([ORG_OWNER_ONLY]);
    expect(modulesOf(OrgController.prototype.listManagers)).toEqual([ORG_OWNER_ONLY]);
    expect(modulesOf(DispatchController.prototype.accept)).toEqual(['jobs', 'portal']);
  });

  it('cookie sessions need CSRF on every provider controller (Jwt → Csrf → OrgManager)', () => {
    for (const cls of [OrgController, DispatchController, DispatchJobsController, OrgProviderController]) {
      const g = guardsOf(cls);
      expect(g.slice(0, 3)).toEqual([JwtAuthGuard.name, CsrfGuard.name, OrgManagerGuard.name]);
    }
  });
});
