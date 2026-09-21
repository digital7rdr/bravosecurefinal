/**
 * B-818 (founder, 2026-09-07) — four console admin levels on the guard.
 *
 *   SUPER_ADMIN (rank 3, all domains) · OPERATION_ADMIN (2, operations) ·
 *   COMMUNICATION_ADMIN (2, communication) · RISK_ADMIN (2, risk).
 *
 * RED-first: before the change `@RequireRoles('SUPERVISOR','ADMIN')` refused
 * every new role outright (a literal includes), and there was no domain check
 * at all — a RISK_ADMIN would have been either locked out of everything or
 * (with a naive rank fix) able to approve bookings.
 */
import {ForbiddenException} from '@nestjs/common';
import type {Reflector} from '@nestjs/core';
import {
  AdminGuard, REQUIRED_ROLES_KEY, ALL_DOMAINS,
  canActInDomain, domainOfPath, isGlobalAdmin, isSuperAdmin, roleDomains, roleRank, satisfiesRoles,
  type AdminRole,
} from './admin.guard';

function makeCtx(url: string, sub = 'u-1') {
  const req = {user: {sub}, originalUrl: url};
  return {
    switchToHttp: () => ({getRequest: () => req}),
    getHandler:   () => ({}),
    getClass:     () => ({}),
  } as never;
}
function makeReflector(requiredRoles?: AdminRole[]): Reflector {
  return {
    getAllAndOverride: jest.fn((key: string) => (key === REQUIRED_ROLES_KEY ? requiredRoles : undefined)),
  } as unknown as Reflector;
}
function guardFor(role: AdminRole, required?: AdminRole[]) {
  const row = {user_id: 'u-1', role, call_sign: 'X-01', region: 'AE'};
  const db = {qOne: jest.fn().mockResolvedValue(row), q: jest.fn().mockResolvedValue([])} as never;
  return new AdminGuard(db, makeReflector(required));
}

describe('rank × domain model', () => {
  it('ranks: super tier is 3, the three domain admins are supervisor-equivalent (2), OPS is 1', () => {
    expect(roleRank('SUPER_ADMIN')).toBe(3);
    expect(roleRank('ADMIN')).toBe(3);
    for (const r of ['OPERATION_ADMIN', 'COMMUNICATION_ADMIN', 'RISK_ADMIN', 'SUPERVISOR'] as const) {
      expect(roleRank(r)).toBe(2);
    }
    expect(roleRank('OPS')).toBe(1);
  });

  it('domains: a level sees ONLY its own domain; the super tier and legacy ranks see every domain', () => {
    expect(roleDomains('OPERATION_ADMIN')).toEqual(['operations']);
    expect(roleDomains('COMMUNICATION_ADMIN')).toEqual(['communication']);
    expect(roleDomains('RISK_ADMIN')).toEqual(['risk']);
    for (const r of ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'OPS'] as const) {
      expect(roleDomains(r)).toEqual(ALL_DOMAINS);
    }
    expect(isSuperAdmin('ADMIN')).toBe(true);
    expect(isSuperAdmin('SUPER_ADMIN')).toBe(true);
    expect(isSuperAdmin('RISK_ADMIN')).toBe(false);
  });

  it('@RequireRoles keeps its 92 call sites: "at least the lowest rank named"', () => {
    const sup = ['SUPERVISOR', 'ADMIN'] as AdminRole[];
    expect(satisfiesRoles('OPS', sup)).toBe(false);
    expect(satisfiesRoles('SUPERVISOR', sup)).toBe(true);
    expect(satisfiesRoles('RISK_ADMIN', sup)).toBe(true);
    expect(satisfiesRoles('SUPER_ADMIN', sup)).toBe(true);
    const adminOnly = ['ADMIN'] as AdminRole[];
    expect(satisfiesRoles('SUPERVISOR', adminOnly)).toBe(false);
    expect(satisfiesRoles('OPERATION_ADMIN', adminOnly)).toBe(false);
    expect(satisfiesRoles('SUPER_ADMIN', adminOnly)).toBe(true);
    expect(satisfiesRoles('OPS', [])).toBe(true);
  });

  it('the path → domain map covers every ops surface, and an unknown path is the shared surface', () => {
    expect(domainOfPath('/ops/admins')).toBe('platform');
    expect(domainOfPath('/ops/admins/invites')).toBe('platform');
    expect(domainOfPath('/ops/sos/abc/ack')).toBe('risk');
    expect(domainOfPath('/ops/vbg/monitoring?limit=100')).toBe('risk');
    expect(domainOfPath('/ops/deptchat/x')).toBe('communication');
    expect(domainOfPath('/ops/enterprise/orgs')).toBe('communication');
    expect(domainOfPath('/ops/departments')).toBe('communication');
    expect(domainOfPath('/ops/subscription/grants')).toBe('communication');
    for (const p of ['/ops/bookings/1/approve', '/ops/jobs', '/ops/missions/1', '/ops/dispatch/monitor',
      '/ops/pro-applications/1', '/ops/pro-management/x', '/ops/protection/1', '/ops/finance/escrows',
      '/ops/users/1', '/ops/agents/1/decide', '/ops/service-pricing', '/ops/regions', '/ops/referral-codes',
      '/ops/referral-campaigns/1', '/ops/agencies/1', '/ops/wallets/u/adjust', '/ops/disputes']) {
      expect(domainOfPath(p)).toBe('operations');
    }
    for (const p of ['/ops/dashboard', '/ops/activity?limit=50', '/ops/me', '/ops/audit', '/ops/analytics',
      '/ops/config/status', '/ops/something-new']) {
      expect(domainOfPath(p)).toBe('any');
    }
    // A prefix must not bleed: /ops/sosx is not the SOS surface.
    expect(domainOfPath('/ops/sosx')).toBe('any');
    // Critic P0 — Express routes case-insensitively; so must the map.
    expect(domainOfPath('/ops/BOOKINGS/abc/approve')).toBe('operations');
    expect(domainOfPath('/ops/Wallets/u/adjust')).toBe('operations');
    expect(domainOfPath('/ops/ADMINS')).toBe('platform');
    expect(domainOfPath('/ops/audit-log/org/x')).toBe('communication');
  });

  it('canActInDomain: platform is super-only; any is everyone; a domain needs membership', () => {
    expect(canActInDomain('RISK_ADMIN', 'platform')).toBe(false);
    expect(canActInDomain('SUPER_ADMIN', 'platform')).toBe(true);
    expect(canActInDomain('OPS', 'any')).toBe(true);
    expect(canActInDomain('RISK_ADMIN', 'risk')).toBe(true);
    expect(canActInDomain('RISK_ADMIN', 'operations')).toBe(false);
    expect(canActInDomain('SUPERVISOR', 'communication')).toBe(true);
  });

  it('region scope: a domain admin is global inside its domain; legacy OPS/SUPERVISOR stay region-pinned', () => {
    expect(isGlobalAdmin({role: 'RISK_ADMIN'})).toBe(true);
    expect(isGlobalAdmin({role: 'OPERATION_ADMIN'})).toBe(true);
    expect(isGlobalAdmin({role: 'SUPER_ADMIN'})).toBe(true);
    expect(isGlobalAdmin({role: 'SUPERVISOR'})).toBe(false);
    expect(isGlobalAdmin({role: 'OPS'})).toBe(false);
  });
});

describe('AdminGuard end to end (rank, then domain, from the request path)', () => {
  it('RISK_ADMIN passes a SUPERVISOR+ gate on the SOS surface', async () => {
    const g = guardFor('RISK_ADMIN', ['SUPERVISOR', 'ADMIN']);
    await expect(g.canActivate(makeCtx('/ops/sos/abc/ack'))).resolves.toBe(true);
  });

  it('RISK_ADMIN is REFUSED a SUPERVISOR+ gate on the bookings surface — rank passes, domain does not', async () => {
    const g = guardFor('RISK_ADMIN', ['SUPERVISOR', 'ADMIN']);
    await expect(g.canActivate(makeCtx('/ops/bookings/abc/approve')))
      .rejects.toThrow(/domain_scope_violation:operations/);
    // …and not by spelling it in capitals (critic P0).
    await expect(guardFor('RISK_ADMIN', ['SUPERVISOR', 'ADMIN']).canActivate(makeCtx('/ops/BOOKINGS/abc/approve')))
      .rejects.toThrow(/domain_scope_violation:operations/);
  });

  it('OPERATION_ADMIN works bookings and is refused the Enterprise and platform surfaces', async () => {
    await expect(guardFor('OPERATION_ADMIN', ['SUPERVISOR', 'ADMIN']).canActivate(makeCtx('/ops/bookings/abc/approve')))
      .resolves.toBe(true);
    await expect(guardFor('OPERATION_ADMIN', ['SUPERVISOR', 'ADMIN']).canActivate(makeCtx('/ops/deptchat/x')))
      .rejects.toThrow(/domain_scope_violation:communication/);
    await expect(guardFor('OPERATION_ADMIN', ['ADMIN']).canActivate(makeCtx('/ops/admins')))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('COMMUNICATION_ADMIN works the Enterprise queue and is refused the risk surface', async () => {
    await expect(guardFor('COMMUNICATION_ADMIN', ['SUPERVISOR', 'ADMIN']).canActivate(makeCtx('/ops/enterprise/join-requests')))
      .resolves.toBe(true);
    await expect(guardFor('COMMUNICATION_ADMIN', ['SUPERVISOR', 'ADMIN']).canActivate(makeCtx('/ops/vbg/monitoring')))
      .rejects.toThrow(/domain_scope_violation:risk/);
  });

  it('SUPER_ADMIN passes everything, including the platform surface; the shared surface is open to every level', async () => {
    for (const p of ['/ops/admins', '/ops/bookings/1/approve', '/ops/vbg/monitoring', '/ops/deptchat/x']) {
      await expect(guardFor('SUPER_ADMIN', ['ADMIN']).canActivate(makeCtx(p))).resolves.toBe(true);
    }
    for (const r of ['RISK_ADMIN', 'OPERATION_ADMIN', 'COMMUNICATION_ADMIN', 'OPS'] as const) {
      await expect(guardFor(r).canActivate(makeCtx('/ops/dashboard'))).resolves.toBe(true);
      await expect(guardFor(r).canActivate(makeCtx('/ops/activity?limit=50'))).resolves.toBe(true);
    }
  });

  it('legacy roles are unchanged: OPS still fails SUPERVISOR+, SUPERVISOR still fails ADMIN-only', async () => {
    await expect(guardFor('OPS', ['SUPERVISOR', 'ADMIN']).canActivate(makeCtx('/ops/bookings/1/approve')))
      .rejects.toThrow(/Requires one of/);
    await expect(guardFor('SUPERVISOR', ['ADMIN']).canActivate(makeCtx('/ops/admins')))
      .rejects.toThrow(/Requires one of/);
    await expect(guardFor('SUPERVISOR', ['SUPERVISOR', 'ADMIN']).canActivate(makeCtx('/ops/vbg/monitoring')))
      .resolves.toBe(true);
  });
});
