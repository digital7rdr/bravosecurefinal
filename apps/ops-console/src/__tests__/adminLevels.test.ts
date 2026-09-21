/**
 * B-818 (founder, 2026-09-07) — "create admin levels for us: Super Admin
 * (everything), Operation Admin (Bravo Secure services), Communication Admin
 * (messenger, enterprise), Risk Admin (VBG) — and a super admin can create id
 * + password for this."
 *
 * The console's rbac must mirror the server guard EXACTLY (rank × domains), the
 * rail must hide what the server would refuse, and only a super admin gets the
 * account form. Behaviour is asserted on the pure rbac; the mirror and the
 * wiring are source scans anchored on the decision sites.
 */
import fs from 'fs';
import path from 'path';
import {
  ADMIN_LEVELS, ALL_DOMAINS, LEGACY_ROLES, ROLE_LABEL, ROLE_SCOPE,
  canActInDomain, canCreateAdminAccount, canManageAdmins, canApproveBooking, canFlipKillswitch,
  hasRole, isSuperAdmin, roleDomains, roleRank, type AdminRole,
} from '../lib/rbac';
import {NAV_GROUPS} from '../lib/nav';
import {routes} from '../lib/routes';

const ROOT = path.join(__dirname, '..', '..', '..', '..');
function code(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the four levels (pure rbac)', () => {
  it('names exactly the four the founder asked for, each with a label and a scope line', () => {
    expect(ADMIN_LEVELS).toEqual(['SUPER_ADMIN', 'OPERATION_ADMIN', 'COMMUNICATION_ADMIN', 'RISK_ADMIN']);
    for (const r of [...ADMIN_LEVELS, ...LEGACY_ROLES]) {
      expect(ROLE_LABEL[r]).toBeTruthy();
      expect(ROLE_SCOPE[r]).toBeTruthy();
    }
  });

  it('Super Admin controls everything; each domain admin controls only its domain', () => {
    expect(roleDomains('SUPER_ADMIN')).toEqual(ALL_DOMAINS);
    expect(roleDomains('OPERATION_ADMIN')).toEqual(['operations']);
    expect(roleDomains('COMMUNICATION_ADMIN')).toEqual(['communication']);
    expect(roleDomains('RISK_ADMIN')).toEqual(['risk']);
    expect(canActInDomain('RISK_ADMIN', 'risk')).toBe(true);
    expect(canActInDomain('RISK_ADMIN', 'operations')).toBe(false);
    expect(canActInDomain('RISK_ADMIN', 'platform')).toBe(false);
    expect(canActInDomain('SUPER_ADMIN', 'platform')).toBe(true);
    expect(canActInDomain(undefined, 'any')).toBe(false);
  });

  it('a domain admin acts at supervisor level inside its domain, never at the super tier', () => {
    for (const r of ['OPERATION_ADMIN', 'COMMUNICATION_ADMIN', 'RISK_ADMIN'] as const) {
      expect(roleRank(r)).toBe(2);
      expect(hasRole(r, 'SUPERVISOR')).toBe(true);
      expect(hasRole(r, 'ADMIN')).toBe(false);
      expect(canApproveBooking(r)).toBe(true);     // the DOMAIN check is the console rail + the server guard
      expect(canFlipKillswitch(r)).toBe(false);
      expect(canManageAdmins(r)).toBe(false);
      expect(canCreateAdminAccount(r)).toBe(false);
    }
    expect(isSuperAdmin('ADMIN')).toBe(true);
    expect(canCreateAdminAccount('SUPER_ADMIN')).toBe(true);
    expect(canCreateAdminAccount('ADMIN')).toBe(true);
    expect(canManageAdmins('SUPER_ADMIN')).toBe(true);
  });

  it('legacy roles keep their meaning', () => {
    expect(hasRole('OPS', 'SUPERVISOR')).toBe(false);
    expect(hasRole('SUPERVISOR', 'SUPERVISOR')).toBe(true);
    expect(hasRole('SUPERVISOR', 'ADMIN')).toBe(false);
    expect(roleDomains('SUPERVISOR')).toEqual(ALL_DOMAINS);
  });
});

describe('the rail mirrors the server domains', () => {
  const byKey = Object.fromEntries(NAV_GROUPS.map(g => [g.key, g]));

  it('every product/service group names its domain; overview and internal are shared/platform', () => {
    expect(byKey.lite.domain).toBe('operations');
    expect(byKey.executive.domain).toBe('operations');
    expect(byKey.pro.domain).toBe('operations');
    expect(byKey.people.domain).toBe('operations');
    expect(byKey.finance.domain).toBe('operations');
    expect(byKey.config.domain).toBe('operations');
    expect(byKey.enterprise.domain).toBe('communication');
    expect(byKey.safety.domain).toBe('risk');
    expect(byKey.overview.domain).toBeUndefined();
    // Internal: the Admins item is rank-gated (ADMIN) and the audit log is shared.
    expect(byKey.internal.domain).toBeUndefined();
    expect(byKey.internal.items.find(i => i.href === routes.internal.admins)?.minRole).toBe('ADMIN');
  });

  it('a Risk Admin sees Overview, Safety and Internal (audit) — nothing else', () => {
    const visible = NAV_GROUPS
      .filter(g => !g.minRole || hasRole('RISK_ADMIN', g.minRole))
      .filter(g => !g.domain || canActInDomain('RISK_ADMIN', g.domain))
      .map(g => g.key);
    expect(visible).toEqual(['overview', 'safety', 'internal']);
  });

  it('a Communication Admin sees Overview, Enterprise and Internal; an Operation Admin sees the service groups', () => {
    const vis = (r: AdminRole) => NAV_GROUPS
      .filter(g => !g.minRole || hasRole(r, g.minRole))
      .filter(g => !g.domain || canActInDomain(r, g.domain))
      .map(g => g.key);
    expect(vis('COMMUNICATION_ADMIN')).toEqual(['overview', 'enterprise', 'internal']);
    expect(vis('OPERATION_ADMIN')).toEqual(['overview', 'lite', 'executive', 'pro', 'people', 'config', 'finance', 'internal']);
    expect(vis('SUPER_ADMIN')).toEqual(NAV_GROUPS.map(g => g.key));
  });

  it('the Shell applies the domain filter beside the rank filter', () => {
    const shell = code('apps/ops-console/src/components/Shell.tsx');
    expect(shell).toMatch(/if \(g\.domain && roleKnown && !canActInDomain\(roleKnown, g\.domain\)\) return null;/);
    // The role must be RECOGNISED first: the legacy three-literal check left a
    // new level as 'unknown', which the OC-12 fallback renders as the FULL rail.
    expect(shell).toMatch(/role in ROLE_LABEL \? \(role as AdminRole\) : undefined;/);
    expect(shell).not.toMatch(/role === 'OPS' \|\| role === 'SUPERVISOR' \|\| role === 'ADMIN'/);
  });
});

describe('server mirror (source scans)', () => {
  it('the guard, the DTO and the migration all carry the same four labels', () => {
    const guard = code('apps/auth-service/src/ops/admin.guard.ts');
    const dto = code('apps/auth-service/src/ops/dto/ops.dto.ts');
    const mig = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260907100000_admin_levels.sql'), 'utf8');
    for (const r of ADMIN_LEVELS) {
      expect(guard).toContain(`'${r}'`);
      expect(dto).toContain(`'${r}'`);
      expect(mig).toContain(`ADD VALUE IF NOT EXISTS '${r}'`);
    }
  });

  it('the ops_audit actor_role CHECK admits every admin label (critic P0 — a new level could not write an audit row)', () => {
    const mig = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260907110000_ops_audit_actor_role_levels.sql'), 'utf8');
    expect(mig).toMatch(/ADD CONSTRAINT ops_audit_actor_role_chk/);
    for (const r of [...ADMIN_LEVELS, ...LEGACY_ROLES, 'SYSTEM', 'AGENT', 'CLIENT']) {
      expect(mig).toContain(`'${r}'`);
    }
    // The map is case-insensitive like Express routing (critic P0).
    const guard = code('apps/auth-service/src/ops/admin.guard.ts');
    expect(guard).toMatch(/const p = path\.split\('\?'\)\[0\]\.toLowerCase\(\);/);
    // Console admins can be suspended/erased only by a super, never the last one (critic P1).
    const ctrl = code('apps/auth-service/src/ops/ops-data.controller.ts');
    expect(ctrl.match(/await this\.data\.assertConsoleAdminTarget\(req\.admin, id\);/g)).toHaveLength(2);
    // The login id is validated as E.164 on both provisioning DTOs (critic P1).
    const dto = code('apps/auth-service/src/ops/dto/ops.dto.ts');
    expect(dto.match(/@Matches\(\/\^\\\+\\d\{7,15\}\$\//g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // A domain admin's console pauses the polls the server would refuse (critic P2).
    const bar = code('apps/ops-console/src/components/SosAlertBar.tsx');
    expect(bar).toMatch(/useSosEvents\('active', undefined, paused\('risk'\)\)/);
    expect(bar).toMatch(/useVbgMonitoring\(100, \{\.\.\.ALERT_SWR, \.\.\.paused\('risk'\)\}\)/);
    expect(bar).toMatch(/useDispatchMonitor\(\{\.\.\.ALERT_SWR, \.\.\.paused\('operations'\)\}\)/);
    expect(bar).toMatch(/useDeptIncidents\(\{severity: 'critical'\}, \{\.\.\.ALERT_SWR, \.\.\.paused\('communication'\)\}\)/);
    const shell = code('apps/ops-console/src/components/Shell.tsx');
    expect(shell).toMatch(/useSosEvents\('active', undefined, \{isPaused: \(\) => !canActInDomain\(meRole, 'risk'\)\}\)/);
  });

  it('the server path map agrees with the rail: risk = sos/vbg, communication = deptchat/enterprise, platform = admins', () => {
    const guard = code('apps/auth-service/src/ops/admin.guard.ts');
    expect(guard).toMatch(/\(sos\|vbg\)[^\n]*return 'risk'/);
    expect(guard).toMatch(/\(deptchat\|departments\|enterprise\|subscription\|audit-log\)[^\n]*return 'communication'/);
    expect(guard).toMatch(/admins\(\\\/\|\$\)\/\.test\(p\)\) return 'platform'/);
    expect(guard).toMatch(/const domain = domainOfPath\(url\);\s*if \(!canActInDomain\(row\.role, domain\)\)/);
  });

  it('the account door exists server-side (POST /ops/admins, super-only) and on the console API', () => {
    const ctrl = code('apps/auth-service/src/ops/ops-admins.controller.ts');
    expect(ctrl).toMatch(/@Post\(\)\s*createAccount\(@Body\(\) dto: CreateAdminAccountDto/);
    const svc = code('apps/auth-service/src/ops/admin-invites.service.ts');
    expect(svc).toMatch(/if \(!isSuperAdmin\(admin\.role\)\) throw new ForbiddenException\('super_admin_required'\);/);
    expect(svc).toMatch(/const pwHash = await this\.password\.hash\(dto\.password\);/);
    const api = code('apps/ops-console/src/lib/api.ts');
    expect(api).toMatch(/createAdminAccount: \(dto: \{[\s\S]{0,200}?password: string/);
    const page = code('apps/ops-console/src/app/(console)/internal/admins/page.tsx');
    expect(page).toMatch(/const canMint = canCreateAdminAccount\(me\?\.admin\.role\);/);
    expect(page).toMatch(/\{canMint && \(/);
    expect(page).toMatch(/autoComplete="new-password"/);
  });
});
