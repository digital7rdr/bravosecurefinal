/**
 * B-818 — a SUPER admin provisions a console account directly (id + password).
 *
 * RED-first: `createAccount` did not exist; the only door was the email invite.
 * Also pins the last-super protection now counting the SUPER_ADMIN label too —
 * before, demoting the only `ADMIN` was refused but a lone `SUPER_ADMIN` could
 * have been demoted to a domain level and locked the platform surface for good.
 */
import {Test, TestingModule} from '@nestjs/testing';
import {BadRequestException, ConflictException, ForbiddenException} from '@nestjs/common';
import {AdminInvitesService} from './admin-invites.service';
import {DatabaseService} from '../database/database.service';
import {PasswordService} from '../common/services/password.service';
import {AuthService} from '../auth/auth.service';
import {OpsAuditService} from './ops-audit.service';
import type {AdminContext} from './admin.guard';

const mockDb = {q: jest.fn(), qOne: jest.fn(), withTransaction: jest.fn()};
const mockPw = {hash: jest.fn(), verify: jest.fn()};
const mockAuth = {revokeAllUserSessions: jest.fn()};
const mockAudit = {recordAdmin: jest.fn()};

const SUPER: AdminContext = {user_id: 'admin-1', role: 'SUPER_ADMIN', call_sign: 'SUP-01', region: 'AE'};
const LEGACY_ADMIN: AdminContext = {user_id: 'admin-2', role: 'ADMIN', call_sign: 'ADM-01', region: 'AE'};
const RISK: AdminContext = {user_id: 'admin-3', role: 'RISK_ADMIN', call_sign: 'RISK-01', region: 'AE'};

const DTO = {
  display_name: ' Risk One ', call_sign: 'risk-02', role: 'RISK_ADMIN' as const,
  phone_e164: '+971500000002', password: 'correct horse battery',
};

describe('AdminInvitesService.createAccount (B-818)', () => {
  let service: AdminInvitesService;
  let tx: {q: jest.Mock; qOne: jest.Mock};

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPw.hash.mockResolvedValue('$argon2id$mock');
    mockAudit.recordAdmin.mockResolvedValue(undefined);
    mockAuth.revokeAllUserSessions.mockResolvedValue(0);
    mockDb.q.mockResolvedValue([]);
    // B-820 — answer by SQL SHAPE: createAccount now looks the phone up first
    // so an existing Bravo account can gain the console role. `null` from that
    // lookup keeps these cases on the create-a-new-user path they pin.
    tx = {
      q: jest.fn().mockResolvedValue([]),
      qOne: jest.fn(async (sql: string) => (
        /SELECT id FROM public\.users WHERE phone_e164/.test(sql) ? null
        : /SELECT user_id FROM admin_users WHERE user_id/.test(sql) ? null
        : {id: 'new-user'}
      )),
    };
    mockDb.withTransaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminInvitesService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: PasswordService, useValue: mockPw},
        {provide: AuthService, useValue: mockAuth},
        {provide: OpsAuditService, useValue: mockAudit},
      ],
    }).compile();
    service = module.get(AdminInvitesService);
  });

  it('refuses a caller below the super tier BEFORE touching the password or the database', async () => {
    await expect(service.createAccount(RISK, DTO)).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockPw.hash).not.toHaveBeenCalled();
    expect(mockDb.withTransaction).not.toHaveBeenCalled();
  });

  it('a SUPER_ADMIN (and the legacy ADMIN) creates users + admin_users + an audit row in ONE transaction', async () => {
    const res = await service.createAccount(SUPER, DTO);
    expect(res).toEqual({ok: true, user_id: 'new-user', call_sign: 'RISK-02', role: 'RISK_ADMIN', existing_account: false});
    expect(mockPw.hash).toHaveBeenCalledWith(DTO.password);
    // users row: hashed password, trimmed name, phone as the login id, email null when omitted.
    const usersInsert = tx.qOne.mock.calls.find(c => /INSERT INTO public.users/.test(String(c[0])))!;
    expect(usersInsert[0]).toMatch(/INSERT INTO public\.users/);
    expect(usersInsert[1]).toEqual([null, '+971500000002', 'Risk One', '$argon2id$mock']);
    // admin_users row: role + upper-cased call sign + the caller's region by default.
    const adminInsert = tx.q.mock.calls.find(c => /INSERT INTO admin_users/.test(c[0]));
    expect(adminInsert?.[1]).toEqual(['new-user', 'Risk One', 'RISK-02', 'RISK_ADMIN', 'AE', '+971500000002']);
    // audit row against the minting super admin; the password never appears anywhere.
    const audit = tx.q.mock.calls.find(c => /INSERT INTO ops_audit/.test(c[0]));
    expect(audit?.[1].slice(0, 4)).toEqual(['admin-1', 'SUPER_ADMIN', 'SUP-01', 'new-user']);
    expect(JSON.stringify(tx.q.mock.calls) + JSON.stringify(tx.qOne.mock.calls)).not.toContain(DTO.password);

    await expect(service.createAccount(LEGACY_ADMIN, DTO)).resolves.toMatchObject({ok: true});
  });

  it('an explicit region and a lower-cased email are honoured', async () => {
    await service.createAccount(SUPER, {...DTO, region: 'SA', email: 'Risk.One@Bravo.Test'});
    expect(tx.qOne.mock.calls.find(c => /INSERT INTO public.users/.test(String(c[0])))![1][0]).toBe('risk.one@bravo.test');
    const adminInsert = tx.q.mock.calls.find(c => /INSERT INTO admin_users/.test(c[0]));
    expect(adminInsert?.[1][4]).toBe('SA');
  });

  it('a duplicate phone/email/call sign (23505) surfaces as user_already_exists', async () => {
    mockDb.withTransaction.mockRejectedValueOnce(Object.assign(new Error('dup'), {code: '23505'}));
    await expect(service.createAccount(SUPER, DTO)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('last-super protection counts BOTH labels of the super tier', () => {
  let service: AdminInvitesService;
  beforeEach(async () => {
    jest.resetAllMocks();
    mockAudit.recordAdmin.mockResolvedValue(undefined);
    mockAuth.revokeAllUserSessions.mockResolvedValue(0);
    mockDb.q.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminInvitesService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: PasswordService, useValue: mockPw},
        {provide: AuthService, useValue: mockAuth},
        {provide: OpsAuditService, useValue: mockAudit},
      ],
    }).compile();
    service = module.get(AdminInvitesService);
  });

  it('demoting the ONLY SUPER_ADMIN to a domain level is refused', async () => {
    mockDb.qOne
      .mockResolvedValueOnce({role: 'SUPER_ADMIN', active: true})   // target
      .mockResolvedValueOnce({n: '0'});                              // other supers
    await expect(service.setAdminRole(SUPER, 'u-9', 'RISK_ADMIN')).rejects.toBeInstanceOf(BadRequestException);
    expect(mockDb.qOne.mock.calls[1][0]).toMatch(/role IN \('ADMIN', 'SUPER_ADMIN'\)/);
  });

  it('SUPER_ADMIN ↔ ADMIN is a rename inside the tier — never counted as a demotion', async () => {
    mockDb.qOne.mockResolvedValueOnce({role: 'ADMIN', active: true});
    await expect(service.setAdminRole(SUPER, 'u-9', 'SUPER_ADMIN')).resolves.toEqual({role: 'SUPER_ADMIN'});
    expect(mockDb.qOne).toHaveBeenCalledTimes(1);
  });

  it('deactivating the only super (either label) is refused', async () => {
    mockDb.qOne
      .mockResolvedValueOnce({role: 'SUPER_ADMIN', active: true})
      .mockResolvedValueOnce({n: '0'});
    await expect(service.setAdminActive(LEGACY_ADMIN, 'u-9', false)).rejects.toThrow('cannot_deactivate_last_admin');
  });
});
