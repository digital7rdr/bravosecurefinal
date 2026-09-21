import 'reflect-metadata';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {BadRequestException} from '@nestjs/common';
import {REQUIRED_ROLES_KEY} from './admin.guard';
import {OpsDataController} from './ops-data.controller';
import {FamilyService} from '../family/family.service';
import {FamilyQuotaService} from '../family/family-quota.service';

/**
 * B-836 — the console roster surface on /ops/users/:id/family.
 *
 * What is pinned here is everything the console's own tests cannot see: the
 * role gate on every route, the A2 eligibility refusals that stop an admin
 * attaching THEMSELVES to a customer's wallet, the batch's per-row isolation,
 * and that the audit trail never carries a phone number.
 */

// ── The role gate, as a source scan (A16/§4: line-based, CRLF-safe) ─────────

const CONTROLLER = join(__dirname, 'ops-data.controller.ts');

/** Comments stripped BEFORE any scan — prose naming a decorator is not a decorator. */
function codeLines(src: string): string[] {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/\/\/.*$/, '').trim());
}

describe('B-836 — every /ops/users/:id/family route is SUPERVISOR+', () => {
  const lines = codeLines(readFileSync(CONTROLLER, 'utf8'));
  const routeAt = lines
    .map((l, i) => ({l, i}))
    .filter(({l}) => /^@(Get|Post|Patch|Put|Delete)\(\s*'users\/:id\/family/.test(l));

  it('the scan actually finds the family routes (never passes vacuously)', () => {
    expect(routeAt.length).toBeGreaterThanOrEqual(7);
  });

  // B-843 (A15) — the doctrine the console block documents CHANGED: the DB no
  // longer enforces "one active membership per person", it enforces one OPEN row
  // per (root, member). An operator reading the old sentence would refuse a
  // legitimate second-root add as a bug.
  it('B-843: the console block states the (root, member) rule, not the one-active-membership one', () => {
    const raw = readFileSync(CONTROLLER, 'utf8');
    expect(raw).toMatch(/ONE-OPEN-ROW-\s*\r?\n?\s*\/\/\s*PER-\(ROOT, MEMBER\) index/);
    expect(raw).toContain('B-843');
    // The stale claim must be gone in every spelling that reads as the old rule.
    expect(raw).not.toMatch(/the\s+one-active-membership index/i);
  });

  // The batch's documented outcome list can no longer contain this code: the
  // check that produced it was deleted with the cross-root rule.
  it('B-843: `member_in_another_family` is no longer a reachable batch outcome', () => {
    const strip = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const f of ['ops-data.controller.ts', '../family/family.service.ts']) {
      expect(strip(readFileSync(join(__dirname, f), 'utf8'))).not.toContain('member_in_another_family');
    }
  });

  it.each([
    `'users/:id/family'`,
    `'users/:id/family/members'`,
    `'users/:id/family/members/batch'`,
    `'users/:id/family/members/:rowId/limit'`,
    `'users/:id/family/members/:rowId/hold'`,
    `'users/:id/family/members/:rowId'`,
    `'users/:id/family/members/:rowId/spend'`,
  ])('%s is a declared route', path => {
    expect(routeAt.some(({l}) => l.includes(path))).toBe(true);
  });

  it('each one carries @RequireRoles(\'SUPERVISOR\', \'ADMIN\') immediately below it', () => {
    const ungated = routeAt.filter(({i}) =>
      !lines.slice(i + 1, i + 4).some(w => w === `@RequireRoles('SUPERVISOR', 'ADMIN')`));
    expect(ungated.map(({l}) => l)).toEqual([]);
  });

  // The scan proves the SPELLING; the metadata proves the GATE.
  it.each([
    'getUserFamily', 'inviteFamilyMember', 'inviteFamilyMembersBatch',
    'setFamilyMemberLimit', 'setFamilyMemberHold', 'revokeFamilyMember', 'familyMemberSpend',
  ])('%s carries the role metadata AdminGuard actually reads', name => {
    const fn = (OpsDataController.prototype as unknown as Record<string, object>)[name];
    expect(fn).toBeDefined();
    expect(Reflect.getMetadata(REQUIRED_ROLES_KEY, fn)).toEqual(['SUPERVISOR', 'ADMIN']);
  });
});

// ── A2 — inviteAsOps eligibility ───────────────────────────────────────────

type Row = Record<string, unknown> | null;

function mkFamily(routes: {holder?: Row; kind?: Row; target?: Row} = {}) {
  const q = jest.fn().mockResolvedValue([]);
  const qOne = jest.fn(async (sql: string) => {
    const s = String(sql).replace(/\s+/g, ' ');
    // The eligibility read: existence + "is this id an ops admin?" in one row.
    if (/LEFT JOIN admin_users au/.test(s)) {
      return routes.holder === undefined ? {is_admin: false} : routes.holder;
    }
    if (/AS user_role/.test(s)) {return routes.kind ?? null;}
    if (/SELECT id, phone_e164 FROM public\.users/.test(s)) {return routes.target ?? null;}
    if (/INSERT INTO public\.family_members/.test(s)) {return {id: 'fm-new'};}
    return null;
  });
  const push = {familyInvite: jest.fn().mockResolvedValue(undefined)};
  const svc = new FamilyService(
    {q, qOne} as never, {reverse: jest.fn()} as never, push as never,
    {emit: jest.fn()} as never, {} as never,
  );
  return {svc, q, qOne};
}

describe('B-836 / A2 — FamilyService.inviteAsOps', () => {
  it('refuses holder_not_eligible when the holder is not an individual account', async () => {
    const {svc, qOne} = mkFamily({kind: {agent_type: 'company'}, target: {id: 'u-m', phone_e164: '+971500000001'}});
    await expect(svc.inviteAsOps('adm-1', 'u-agency', '+971500000001', null))
      .rejects.toThrow(/holder_not_eligible/);
    expect(qOne.mock.calls.some(c => /INSERT INTO public\.family_members/.test(String(c[0])))).toBe(false);
  });

  it('refuses holder_not_eligible when the holder is an ADMIN (an admin may not become a payer)', async () => {
    const {svc, qOne} = mkFamily({holder: {is_admin: true}, target: {id: 'u-m', phone_e164: '+971500000001'}});
    await expect(svc.inviteAsOps('adm-1', 'u-admin', '+971500000001', null))
      .rejects.toThrow(/holder_not_eligible/);
    expect(qOne.mock.calls.some(c => /INSERT INTO public\.family_members/.test(String(c[0])))).toBe(false);
  });

  it('refuses holder_not_eligible for an unknown / soft-deleted holder id', async () => {
    const {svc, qOne} = mkFamily({holder: null, target: {id: 'u-m', phone_e164: '+971500000001'}});
    await expect(svc.inviteAsOps('adm-1', 'u-ghost', '+971500000001', null))
      .rejects.toThrow(/holder_not_eligible/);
    expect(qOne.mock.calls.some(c => /INSERT INTO public\.family_members/.test(String(c[0])))).toBe(false);
  });

  it('refuses cannot_invite_self when the phone resolves to the ACTING ADMIN (not the holder)', async () => {
    const {svc, qOne} = mkFamily({target: {id: 'adm-1', phone_e164: '+971509999999'}});
    await expect(svc.inviteAsOps('adm-1', 'u-holder', '+971509999999', null))
      .rejects.toThrow(/cannot_invite_self/);
    expect(qOne.mock.calls.some(c => /INSERT INTO public\.family_members/.test(String(c[0])))).toBe(false);
  });

  it('delegates to invite() for an eligible holder and a third-party phone', async () => {
    const {svc} = mkFamily({target: {id: 'u-m', phone_e164: '+971500000001'}});
    await expect(svc.inviteAsOps('adm-1', 'u-holder', '+971500000001', 500))
      .resolves.toEqual({id: 'fm-new', status: 'pending'});
  });
});

// ── D7/A14 — the batch route ───────────────────────────────────────────────

type Mocks = Partial<Record<string, jest.Mock>>;

function mkController(parts: {family?: Mocks; data?: Mocks; quota?: Mocks} = {}) {
  const recordAdmin = jest.fn().mockResolvedValue(undefined);
  const family: Mocks = {assertOpsManageableHolder: jest.fn().mockResolvedValue(undefined), ...parts.family};
  const ctrl = new OpsDataController(
    (parts.data ?? {}) as never,
    {recordAdmin} as never,
    family as never,
    (parts.quota ?? {}) as never,
    // B-867 — the identity-document reader; not exercised by the family routes.
    {} as never,
  );
  const req = {admin: {user_id: 'adm-1', role: 'SUPERVISOR', call_sign: 'OPS-7', region: 'AE'}} as never;
  return {ctrl, req, recordAdmin, family};
}

describe('B-836 — the paged roster route', () => {
  it('asks for includeEmail (the console needs it; the holder app must never get it)', async () => {
    const listMembers = jest.fn().mockResolvedValue({members: [], total: 0, counts: {active: 0, pending: 0, held: 0}});
    const isOpsManageableHolder = jest.fn().mockResolvedValue(true);
    const getUserFamilyMemberOf = jest.fn().mockResolvedValue([]);
    const {ctrl} = mkController({family: {listMembers, isOpsManageableHolder}, data: {getUserFamilyMemberOf}});
    const out = await ctrl.getUserFamily('u-holder', {q: 'ali', limit: 25} as never);
    expect(listMembers).toHaveBeenCalledWith('u-holder', {q: 'ali', limit: 25, includeEmail: true});
    expect(out.manageable).toBe(true);
  });
});

describe('B-836 — batch add', () => {
  const okInvite = () => jest.fn(async (_a: string, _h: string, phone: string) => ({id: `fm-${phone.slice(-1)}`, status: 'pending'}));

  it('dedupes inside the batch (first occurrence wins) and never re-invites the duplicate', async () => {
    const inviteAsOpsForCheckedHolder = okInvite();
    const {ctrl, req} = mkController({family: {inviteAsOpsForCheckedHolder}});
    const out = await ctrl.inviteFamilyMembersBatch(
      'u-holder', {phones: ['+971500000001', '+971500000001', '+971500000002']} as never, req,
    );
    expect(out.results).toEqual([
      {phone: '+971500000001', ok: true, id: 'fm-1'},
      {phone: '+971500000001', ok: false, code: 'duplicate_in_batch'},
      {phone: '+971500000002', ok: true, id: 'fm-2'},
    ]);
    expect(out.added).toBe(2);
    expect(out.failed).toBe(1);
    expect(inviteAsOpsForCheckedHolder).toHaveBeenCalledTimes(2);
  });

  it('isolates rows: a refusal and an unexpected throw do not stop the rest', async () => {
    const inviteAsOpsForCheckedHolder = jest.fn()
      .mockRejectedValueOnce(new BadRequestException('not_a_bravo_user'))
      .mockRejectedValueOnce(new Error('pool timeout'))
      .mockResolvedValueOnce({id: 'fm-3', status: 'pending'});
    const {ctrl, req} = mkController({family: {inviteAsOpsForCheckedHolder}});
    const out = await ctrl.inviteFamilyMembersBatch(
      'u-holder', {phones: ['+971500000001', '+971500000002', '+971500000003']} as never, req,
    );
    expect(out.results.map(r => r.code)).toEqual(['not_a_bravo_user', 'error', undefined]);
    expect(out.added).toBe(1);
    expect(out.failed).toBe(2);
  });

  // The holder is a property of the REQUEST, not of a row: resolving it per row
  // is 2 extra queries × 50 and turns one refusal into a 200 with 50 identical
  // failures.
  it('resolves holder eligibility ONCE for the whole batch, not per row', async () => {
    const inviteAsOpsForCheckedHolder = okInvite();
    const {ctrl, req, family} = mkController({family: {inviteAsOpsForCheckedHolder}});
    await ctrl.inviteFamilyMembersBatch(
      'u-holder', {phones: ['+971500000001', '+971500000002', '+971500000003']} as never, req,
    );
    expect(family.assertOpsManageableHolder).toHaveBeenCalledTimes(1);
    expect(family.assertOpsManageableHolder).toHaveBeenCalledWith('u-holder');
  });

  it('an ineligible holder is a 400 BEFORE any row is attempted, and nothing is audited', async () => {
    const assertOpsManageableHolder = jest.fn().mockRejectedValue(new BadRequestException('holder_not_eligible'));
    const inviteAsOpsForCheckedHolder = jest.fn();
    const {ctrl, req, recordAdmin} = mkController({family: {assertOpsManageableHolder, inviteAsOpsForCheckedHolder}});
    await expect(ctrl.inviteFamilyMembersBatch(
      'u-agency', {phones: ['+971500000001', '+971500000002']} as never, req,
    )).rejects.toThrow(/holder_not_eligible/);
    expect(inviteAsOpsForCheckedHolder).not.toHaveBeenCalled();
    expect(recordAdmin).not.toHaveBeenCalled();
  });

  it('D6 — the audit row carries counts and ids ONLY; a phone would outlive a revoke', async () => {
    const inviteAsOpsForCheckedHolder = jest.fn().mockResolvedValue({id: 'fm-1', status: 'pending'});
    const {ctrl, req, recordAdmin} = mkController({family: {inviteAsOpsForCheckedHolder}});
    await ctrl.inviteFamilyMembersBatch('u-holder', {phones: ['+971500000001', '+971500000002']} as never, req);
    expect(recordAdmin).toHaveBeenCalledTimes(1);
    const [, action, subjectType, subjectId, metadata] = recordAdmin.mock.calls[0];
    expect(action).toBe('family.member_invite_batch');
    expect(subjectType).toBe('user');
    expect(subjectId).toBe('u-holder');
    expect(metadata).toEqual({added: 2, failed: 0, ids: ['fm-1', 'fm-1']});
    expect(JSON.stringify(metadata)).not.toMatch(/\+\d{6}/);
  });
});

// ── A3 — the quota audit's actor discriminator lives in metadata JSONB ─────

describe('B-836 / A3 — setQuota(actorMeta) reaches the family_quota_audit row', () => {
  const tx = {q: jest.fn(), qOne: jest.fn()};
  const db = {
    q: jest.fn().mockResolvedValue([]),
    qOne: jest.fn().mockResolvedValue(null),
    withTransaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  beforeEach(() => {
    for (const m of [tx.q, tx.qOne, db.q, db.qOne]) {m.mockReset();}
    tx.q.mockResolvedValue([]);
    tx.qOne.mockResolvedValue({
      id: 'fm-1', holder_id: 'u-holder', member_id: 'u-member', status: 'active',
      spend_limit_credits: 1000, spent_credits: 100, quota_notified_pct: 0,
    });
    db.q.mockResolvedValue([]);
    db.qOne.mockResolvedValue(null);
  });

  const mkQuota = () => new FamilyQuotaService(
    db as never,
    {familyQuotaChanged: jest.fn().mockResolvedValue(undefined)} as never,
    {record: jest.fn().mockResolvedValue(undefined)} as never,
  );

  const auditInsert = () => tx.q.mock.calls
    .find(c => /INSERT INTO public\.family_quota_audit/.test(String(c[0]))) as [string, unknown[]];

  it('merges {actor_role, actor_call} into the audit metadata (there is NO actor_role column)', async () => {
    await mkQuota().setQuota('u-holder', 'fm-1', 2000, 'adm-1', 'console raise', {
      actor_role: 'SUPERVISOR', actor_call: 'OPS-7',
    });
    const ins = auditInsert();
    expect(ins[0].replace(/\s+/g, ' ')).toContain('metadata');
    expect(ins[0]).not.toMatch(/actor_role\s*,/); // a column that does not exist
    const meta = ins[1][ins[1].length - 1];
    expect(JSON.parse(String(meta))).toEqual({actor_role: 'SUPERVISOR', actor_call: 'OPS-7'});
  });

  it('defaults to an empty metadata object for the holder-side (app) path', async () => {
    await mkQuota().setQuota('u-holder', 'fm-1', 2000, 'u-holder');
    const meta = auditInsert()[1].slice(-1)[0];
    expect(JSON.parse(String(meta))).toEqual({});
  });
});
