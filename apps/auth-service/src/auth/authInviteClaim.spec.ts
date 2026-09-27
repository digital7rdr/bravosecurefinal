/**
 * 2026-09-27 — admin-created SMS invites are CLAIMED through the normal signup.
 *
 * An ops admin creates the account with no password (pending invite). The person
 * signs up in the current app with that phone number; the OTP proves the phone
 * and registerVerify UPDATES the invite row (their own password) instead of
 * inserting a new one. Anything that is not a claimable invite for THIS phone
 * keeps the existing already_exists conflict.
 */
import {Test, TestingModule} from '@nestjs/testing';
import {ConflictException} from '@nestjs/common';
import {ConfigService}   from '@nestjs/config';
import {AuthService}     from './auth.service';
import {JwtService}      from './jwt.service';
import {DatabaseService} from '../database/database.service';
import {RedisService}    from '../redis/redis.service';
import {AuditService}    from '../kafka/audit.service';
import {PasswordService} from '../common/services/password.service';
import {OtpService}      from '../common/services/otp.service';

const PHONE = '+971500000001';
const mockDb = {q: jest.fn(), qOne: jest.fn()};
const mockRedis = {
  storeJti: jest.fn(), revokeJti: jest.fn(), revokeJtis: jest.fn(), isJtiValid: jest.fn(),
  markPushRevoked: jest.fn(), markPushRevokedMany: jest.fn(), clearPushRevoked: jest.fn(),
  client: {get: jest.fn()},
};
const mockAudit = {emit: jest.fn()};
const mockPw = {hash: jest.fn(), verify: jest.fn()};
const mockOtp = {generate: jest.fn(), hash: jest.fn(), send: jest.fn(), check: jest.fn()};
const mockJwt = {signAccessToken: jest.fn(), newRefreshToken: jest.fn(), refreshTokenHash: jest.fn(), ttlToSeconds: jest.fn()};
const mockConfig = {get: jest.fn((k: string) => ({'jwt.refreshTtl': '30d', 'jwt.accessTtl': '15m', 'otp.ttlMinutes': 10} as Record<string, unknown>)[k])};

const signup = {email: 'new@x.com', password: 'pass1234', displayName: 'New Person', phoneE164: PHONE};
const verify = {...signup, code: '123456', deviceId: 'd-1', platform: 'android'};
const inviteRow = (over: Record<string, unknown> = {}) => ({id: 'inv-1', phone_e164: PHONE, claimable: true, ...over});

/** Route db.q by SQL so the INSERT and the invite lookup are distinguishable. */
function routeQ(inviteRows: unknown[]) {
  mockDb.q.mockImplementation(async (sql: string) => {
    if (/AS claimable/.test(sql)) {return inviteRows;}
    if (/INSERT INTO public\.users/.test(sql)) {return [{id: 'brand-new'}];}
    return [];
  });
}

describe('AuthService — SMS invite claim', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockJwt.signAccessToken.mockResolvedValue({accessToken: 'tok', jti: 'jti-1'});
    mockJwt.newRefreshToken.mockReturnValue({token: 'ref', hash: 'ref-hash'});
    mockJwt.refreshTokenHash.mockReturnValue('hash');
    mockJwt.ttlToSeconds.mockImplementation((s: string) => (s === '15m' ? 900 : 2_592_000));
    mockDb.qOne.mockResolvedValue(null);
    mockAudit.emit.mockResolvedValue(undefined);
    mockPw.hash.mockResolvedValue('$argon2id$hash');
    mockOtp.send.mockResolvedValue(undefined);
    mockOtp.check.mockResolvedValue(false);
    for (const k of Object.keys(mockRedis) as (keyof typeof mockRedis)[]) {
      const v = mockRedis[k];
      if (typeof v === 'function') {(v as jest.Mock).mockResolvedValue(undefined);}
    }
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: RedisService, useValue: mockRedis},
        {provide: AuditService, useValue: mockAudit},
        {provide: PasswordService, useValue: mockPw},
        {provide: OtpService, useValue: mockOtp},
        {provide: JwtService, useValue: mockJwt},
        {provide: ConfigService, useValue: mockConfig},
      ],
    }).compile();
    service = module.get(AuthService);
  });

  describe('register (step 1)', () => {
    it('a pending invite for THIS phone is not a conflict — the OTP is sent', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'inv-1'});
      routeQ([inviteRow()]);
      await expect(service.register(signup as never, '1.1.1.1')).resolves.toEqual({otpSentTo: PHONE});
      expect(mockOtp.send).toHaveBeenCalledWith(PHONE, '');
    });

    it.each([
      ['an expired / already-claimed invite', [inviteRow({claimable: false})]],
      ['an invite for a DIFFERENT phone (matched by email)', [inviteRow({phone_e164: '+971509999999'})]],
      ['a claimable invite AND another account using the email', [inviteRow(), {id: 'someone-else', phone_e164: '+1', claimable: false}]],
    ])('%s stays already_exists', async (_label, rows) => {
      mockDb.qOne.mockResolvedValueOnce({id: 'inv-1'});
      routeQ(rows as unknown[]);
      await expect(service.register(signup as never, '1.1.1.1')).rejects.toBeInstanceOf(ConflictException);
      expect(mockOtp.send).not.toHaveBeenCalled();
    });
  });

  describe('registerVerify (step 2)', () => {
    it('CLAIMS the invite row: UPDATE, never INSERT, and audits invite_claimed', async () => {
      mockOtp.check.mockResolvedValueOnce(true);
      routeQ([inviteRow()]);
      mockDb.qOne
        .mockResolvedValueOnce({id: 'inv-1'})                           // dup-check hits the invite
        .mockResolvedValueOnce({id: 'inv-1'})                           // claim UPDATE … RETURNING
        .mockResolvedValueOnce({id: 'inv-1', email: 'admin-set@x.com', display_name: 'Admin Set',
          role: 'service_provider', subscription_tier: 'lite', phone_e164: PHONE}) // SELECT user
        .mockResolvedValueOnce(null);                                   // issueSession prev jti
      const out = await service.registerVerify(verify as never, '1.1.1.1');

      const sqls = mockDb.qOne.mock.calls.map(c => String(c[0]));
      const claim = mockDb.qOne.mock.calls.find(c => /UPDATE public\.users/.test(String(c[0])))!;
      expect(claim).toBeDefined();
      expect(claim[1]).toEqual(['inv-1', '$argon2id$hash', 'New Person']);
      expect(String(claim[0])).toMatch(/password_hash IS NULL AND invited_at IS NOT NULL/); // race guard
      expect(mockDb.q.mock.calls.some(c => /INSERT INTO public\.users/.test(String(c[0])))).toBe(false);
      expect(sqls.length).toBeGreaterThanOrEqual(3);
      // The admin-provisioned role survives (agency / CPO invites stay agency / CPO).
      expect(out.user.role).toBe('service_provider');
      expect(mockAudit.emit).toHaveBeenCalledWith(expect.objectContaining({outcome: 'success', detail: 'invite_claimed'}));
    });

    it('a claim that lost the race (row already claimed) is already_exists', async () => {
      mockOtp.check.mockResolvedValueOnce(true);
      routeQ([inviteRow()]);
      mockDb.qOne
        .mockResolvedValueOnce({id: 'inv-1'})   // dup-check
        .mockResolvedValueOnce(null);           // UPDATE matched nothing
      await expect(service.registerVerify(verify as never, '1.1.1.1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('with no existing row the normal INSERT path is unchanged', async () => {
      mockOtp.check.mockResolvedValueOnce(true);
      routeQ([]);
      mockDb.qOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({id: 'brand-new', email: signup.email, display_name: 'New Person', role: 'individual', subscription_tier: 'lite', phone_e164: PHONE})
        .mockResolvedValueOnce(null);
      const out = await service.registerVerify(verify as never, '1.1.1.1');
      expect(mockDb.q.mock.calls.some(c => /INSERT INTO public\.users/.test(String(c[0])))).toBe(true);
      expect(mockDb.q.mock.calls.some(c => /AS claimable/.test(String(c[0])))).toBe(false); // no extra lookup
      expect(out.user.id).toBe('brand-new');
    });
  });
});
