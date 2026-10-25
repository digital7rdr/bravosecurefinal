/**
 * 2026-10-25 (owner) — Secure Services is for paid plans. A free-plan personal
 * client cannot START a booking, a Secure Pro application or a protection
 * session (403 tier_insufficient); Pro / Enterprise tiers, company-workspace
 * members and clients with a Secure Pro plan under way can.
 */
import {ForbiddenException} from '@nestjs/common';
import {ModuleAccessService, planLockedModules, SECURE_SERVICES_MODULES} from './module-access.service';

jest.mock('../auth/account-kind', () => ({resolveAccountKind: jest.fn()}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {resolveAccountKind} = require('../auth/account-kind') as {resolveAccountKind: jest.Mock};

const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();

function svc(tier: {subscription_tier: string; pro_active_until: string | null} | null, proApps = 0) {
  const db = {
    q: jest.fn(async () => []),
    qOne: jest.fn(async (sql: string) => {
      if (/FROM public\.users/.test(sql)) return tier;
      if (/FROM public\.pro_applications/.test(sql)) return {n: proApps};
      return null;
    }),
  };
  return {s: new ModuleAccessService(db as never, {client: undefined} as never), db};
}
const kind = (account_kind: string, extra: Record<string, unknown> = {}) => ({account_kind, owns_workspace: false, workspaces: [], ...extra});

describe('planLockedModules (pure)', () => {
  it('free plan individual → Secure Services locked', () => {
    expect(planLockedModules('individual', {subscription_tier: 'lite', pro_active_until: null})).toEqual([...SECURE_SERVICES_MODULES]);
  });
  it('Pro / Enterprise with a live window, or a comp grant → open', () => {
    expect(planLockedModules('individual', {subscription_tier: 'pro', pro_active_until: future})).toEqual([]);
    expect(planLockedModules('individual', {subscription_tier: 'enterprise', pro_active_until: null})).toEqual([]);
  });
  it('a lapsed paid window is the free plan', () => {
    expect(planLockedModules('individual', {subscription_tier: 'pro', pro_active_until: past})).toEqual([...SECURE_SERVICES_MODULES]);
  });
  it('company-workspace members, agencies and CPOs are never plan-locked', () => {
    for (const g of ['enterprise', 'agency', 'cpo'] as const) {
      expect(planLockedModules(g, {subscription_tier: 'lite', pro_active_until: null})).toEqual([]);
    }
  });
});

describe('assertEnabled refuses STARTING Secure Services on the free plan', () => {
  beforeEach(() => { resolveAccountKind.mockReset(); resolveAccountKind.mockResolvedValue(kind('individual')); });

  it.each(['secure_lite', 'executive_protection', 'secure_pro'] as const)('%s → 403 tier_insufficient', async key => {
    const {s} = svc({subscription_tier: 'lite', pro_active_until: null});
    const err = await s.assertEnabled('u1', key).catch(e => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toEqual(expect.objectContaining({code: 'tier_insufficient', required_tier: 'pro'}));
  });

  it('a paid plan passes', async () => {
    const {s} = svc({subscription_tier: 'pro', pro_active_until: future});
    await expect(s.assertEnabled('u1', 'secure_lite')).resolves.toBeUndefined();
  });

  it('a Secure Pro plan under way keeps Secure Services', async () => {
    const {s} = svc({subscription_tier: 'lite', pro_active_until: null}, 1);
    await expect(s.assertEnabled('u1', 'secure_pro')).resolves.toBeUndefined();
  });

  it('other modules are not plan-gated', async () => {
    const {s} = svc({subscription_tier: 'lite', pro_active_until: null});
    await expect(s.assertEnabled('u1', 'news')).resolves.toBeUndefined();
  });

  it('a company-workspace member on the free plan passes', async () => {
    resolveAccountKind.mockResolvedValue(kind('individual', {workspaces: [{org_user_id: 'o'}]}));
    const {s} = svc({subscription_tier: 'lite', pro_active_until: null});
    await expect(s.assertEnabled('u1', 'secure_lite')).resolves.toBeUndefined();
  });

  it('a database failure fails OPEN (product gate, not auth)', async () => {
    const {s, db} = svc({subscription_tier: 'lite', pro_active_until: null});
    db.qOne.mockRejectedValue(new Error('db down'));
    await expect(s.planLocked('u1', 'individual')).resolves.toEqual([]);
  });
});
