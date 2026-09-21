import {Test, TestingModule} from '@nestjs/testing';
import {BadRequestException, ConflictException, ForbiddenException} from '@nestjs/common';
import {OrgCpoService} from './org-cpo.service';
import {DatabaseService} from '../database/database.service';
import {PasswordService} from '../common/services/password.service';
import {DepartmentService} from '../department/department.service';
import {AuthService} from '../auth/auth.service';
import {OrgAuditService} from './org-audit.service';
import {MAX_OPEN_INVITES} from './invite-code';

/**
 * B-812 — the provider mints / lists / revokes roster invitation codes.
 * Before this the redeem path was the only code touching provider_invite_codes:
 * "Join your provider" was a door with no key.
 *
 * Critic round pins (all were green-by-mock before): the org audit target is
 * the ROW id (org_audit_log.target_id is a UUID — a code there raised 22P02
 * and was swallowed), a workspace owner without an agency cannot mint, only
 * the OWNER can mint a MANAGER invite, open codes are capped, and the redeem
 * side normalises a dash-less code and answers a re-hire's 23505 with a 409.
 */
const mockDb = {q: jest.fn(), qOne: jest.fn(), withTransaction: jest.fn()};
const mockOrgAudit = {log: jest.fn().mockResolvedValue(undefined)};
const ORG = 'org-user-1';
const OWNER = ORG;
const MANAGER = 'manager-1';
const PROVIDER_ROW = {type: 'company', status: 'ACTIVE'};

/** qOne router: provider lookup → open count → INSERT/UPDATE by SQL shape. */
function routeQOne(opts: {provider?: unknown; open?: number; insert?: (params: unknown[]) => unknown; update?: unknown} = {}) {
  mockDb.qOne.mockImplementation(async (sql: string, params: unknown[]) => {
    if (/FROM public\.agents WHERE user_id/.test(sql)) {return 'provider' in opts ? opts.provider : PROVIDER_ROW;}
    if (/count\(\*\)::text AS n FROM provider_invite_codes/.test(sql)) {return {n: String(opts.open ?? 0)};}
    if (/INSERT INTO provider_invite_codes/.test(sql)) {
      return opts.insert ? opts.insert(params) : {
        id: 'row-uuid-1', code: params[0], member_role: params[2], call_sign: params[3],
        expires_at: new Date('2026-09-13T12:00:00Z'), created_at: new Date('2026-09-06T12:00:00Z'),
      };
    }
    if (/UPDATE provider_invite_codes/.test(sql)) {return 'update' in opts ? opts.update : null;}
    return null;
  });
}
const insertCall = () => mockDb.qOne.mock.calls.find(c => /INSERT INTO provider_invite_codes/.test(String(c[0]))) as [string, unknown[]];

describe('OrgCpoService — roster invitation codes (B-812)', () => {
  let service: OrgCpoService;
  beforeEach(async () => {
    jest.resetAllMocks();
    mockOrgAudit.log.mockResolvedValue(undefined);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrgCpoService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: PasswordService, useValue: {hash: jest.fn(), verify: jest.fn()}},
        {provide: DepartmentService, useValue: {}},
        {provide: AuthService, useValue: {}},
        {provide: OrgAuditService, useValue: mockOrgAudit},
      ],
    }).compile();
    service = module.get(OrgCpoService);
  });

  it('mints a BRAVO-XXXXXX code for the GUARD org with the defaults (cpo, no call sign, 7 days); the audit targets the ROW id and carries only a code suffix', async () => {
    routeQOne();
    const r = await service.mintInviteCode(ORG, MANAGER, {});
    expect(r.code).toMatch(/^BRAVO-[A-HJ-NP-Z2-9]{6}$/);
    expect(r).toMatchObject({member_role: 'cpo', call_sign: null, expires_at: '2026-09-13T12:00:00.000Z'});
    const [sql, params] = insertCall();
    expect(sql).toMatch(/NOW\(\) \+ \(\$5 \|\| ' days'\)::interval/);
    expect(sql).toMatch(/RETURNING id, code/);
    expect(params.slice(1)).toEqual([ORG, 'cpo', null, '7', MANAGER]);
    expect(mockOrgAudit.log).toHaveBeenCalledWith(ORG, MANAGER, 'invite.mint', expect.objectContaining({
      targetKind: 'invite', targetId: 'row-uuid-1',
      metadata: expect.objectContaining({code_suffix: r.code.slice(-3)}),
    }));
    const meta = (mockOrgAudit.log.mock.calls[0][3] as {metadata: Record<string, unknown>}).metadata;
    expect(JSON.stringify(meta)).not.toContain(r.code); // never the live credential
  });

  it('normalises the request: upper-cased call sign, ttl clamped to 30', async () => {
    routeQOne();
    await service.mintInviteCode(ORG, OWNER, {call_sign: ' ranger-7 ', expires_in_days: 400});
    expect(insertCall()[1].slice(2, 5)).toEqual(['cpo', 'RANGER-7', '30']);
  });

  it('only the OWNER may mint a MANAGER invite (a scoped delegate would mint an unscoped manager)', async () => {
    routeQOne();
    await expect(service.mintInviteCode(ORG, MANAGER, {member_role: 'manager'})).rejects.toBeInstanceOf(ForbiddenException);
    expect(insertCall()).toBeUndefined();
    const r = await service.mintInviteCode(ORG, OWNER, {member_role: 'manager'});
    expect(r.member_role).toBe('manager');
  });

  it('refuses a caller that is not an approved provider (an Enterprise workspace owner passes the guard too)', async () => {
    routeQOne({provider: null});
    await expect(service.mintInviteCode(ORG, OWNER)).rejects.toBeInstanceOf(BadRequestException);
    routeQOne({provider: {type: 'cpo', status: 'ACTIVE'}});
    await expect(service.mintInviteCode(ORG, OWNER)).rejects.toBeInstanceOf(BadRequestException);
    routeQOne({provider: {type: 'company', status: 'SUSPENDED'}});
    await expect(service.mintInviteCode(ORG, OWNER)).rejects.toBeInstanceOf(BadRequestException);
    routeQOne({provider: {type: 'company', status: 'APPROVED'}});
    await expect(service.mintInviteCode(ORG, OWNER)).resolves.toMatchObject({member_role: 'cpo'});
  });

  it('caps OPEN codes per org', async () => {
    routeQOne({open: MAX_OPEN_INVITES});
    const err = await service.mintInviteCode(ORG, OWNER).catch(e => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({code: 'too_many_open_invites'});
    expect(insertCall()).toBeUndefined();
  });

  it('retries a unique collision with a FRESH code and gives up after the attempt budget', async () => {
    const dup = Object.assign(new Error('dup'), {code: '23505'});
    let n = 0;
    routeQOne({insert: params => { n++; if (n === 1) {throw dup;} return {id: 'row-2', code: params[0], member_role: 'cpo', call_sign: null, expires_at: new Date(), created_at: new Date()}; }});
    const r = await service.mintInviteCode(ORG, OWNER);
    const inserts = mockDb.qOne.mock.calls.filter(c => /INSERT INTO provider_invite_codes/.test(String(c[0])));
    expect(inserts).toHaveLength(2);
    expect(inserts[0][1][0]).not.toBe(inserts[1][1][0]);
    expect(r.code).toBe(inserts[1][1][0]);

    mockDb.qOne.mockReset();
    routeQOne({insert: () => { throw dup; }});
    await expect(service.mintInviteCode(ORG, OWNER)).rejects.toBeInstanceOf(ConflictException);
    expect(mockDb.qOne.mock.calls.filter(c => /INSERT INTO/.test(String(c[0])))).toHaveLength(5);
  });

  it('a non-unique database error is NOT swallowed', async () => {
    routeQOne({insert: () => { throw Object.assign(new Error('boom'), {code: '42P01'}); }});
    await expect(service.mintInviteCode(ORG, OWNER)).rejects.toThrow('boom');
  });

  it('lists the org\'s own codes, open first then newest, with a derived status', async () => {
    mockDb.q.mockResolvedValue([
      {code: 'BRAVO-AAAAAA', member_role: 'cpo', call_sign: null, expires_at: new Date(Date.now() + 86_400_000), created_at: new Date(), redeemed_at: null, revoked_at: null, redeemed_by_name: null},
      {code: 'BRAVO-BBBBBB', member_role: 'cpo', call_sign: 'R7', expires_at: null, created_at: new Date(), redeemed_at: new Date(), revoked_at: null, redeemed_by_name: 'Ranger'},
      {code: 'BRAVO-CCCCCC', member_role: 'manager', call_sign: null, expires_at: new Date(Date.now() - 1000), created_at: new Date(), redeemed_at: null, revoked_at: null, redeemed_by_name: null},
    ]);
    const rows = await service.listInviteCodes(ORG);
    expect(rows.map(r => r.status)).toEqual(['open', 'redeemed', 'expired']);
    const [sql, params] = mockDb.q.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE i\.org_user_id = \$1/);
    expect(sql).toMatch(/ORDER BY \(i\.redeemed_at IS NULL AND i\.revoked_at IS NULL\) DESC, i\.created_at DESC/);
    expect(params).toEqual([ORG]);
  });

  it('revoke is conditional on org + open; a foreign or used code is "not open", never a cross-tenant hit; audit targets the row id', async () => {
    routeQOne({update: {id: 'row-uuid-9', code: 'BRAVO-AAAAAA'}});
    await expect(service.revokeInviteCode(ORG, MANAGER, ' bravo-aaaaaa ')).resolves.toEqual({ok: true, code: 'BRAVO-AAAAAA'});
    const upd = mockDb.qOne.mock.calls.find(c => /UPDATE provider_invite_codes/.test(String(c[0]))) as [string, unknown[]];
    expect(upd[0]).toMatch(/WHERE org_user_id = \$1 AND code = \$2/);
    expect(upd[0]).toMatch(/redeemed_at IS NULL AND revoked_at IS NULL/);
    expect(upd[1]).toEqual([ORG, 'BRAVO-AAAAAA']);
    expect(mockOrgAudit.log).toHaveBeenCalledWith(ORG, MANAGER, 'invite.revoke', expect.objectContaining({targetId: 'row-uuid-9'}));

    routeQOne({update: null});
    await expect(service.revokeInviteCode(ORG, MANAGER, 'BRAVO-ZZZZZZ')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.revokeInviteCode(ORG, MANAGER, '')).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('redeem side (existing path, hardened by the critic round)', () => {
    it('normalises a dash-less code before the conditional claim', async () => {
      mockDb.qOne.mockResolvedValueOnce(null); // no existing cpo membership
      const txQOne = jest.fn().mockResolvedValueOnce(null); // claim matches nothing → clean error
      mockDb.withTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({q: jest.fn(), qOne: txQOne}));
      await expect(service.redeemInviteCode('u1', 'bravo7q2k3m')).rejects.toBeInstanceOf(BadRequestException);
      expect(txQOne.mock.calls[0][1]).toEqual(['BRAVO-7Q2K3M', 'u1']);
    });

    it('a re-hire whose seed hits a primary key answers 409 already_an_agent, not a raw 500', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      mockDb.withTransaction.mockRejectedValueOnce(Object.assign(new Error('duplicate key value violates unique constraint "agents_pkey"'), {code: '23505'}));
      const err = await service.redeemInviteCode('u1', 'BRAVO-AAAAAA').catch(e => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({code: 'already_an_agent'});
    });
  });
});
