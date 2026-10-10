import {Test, TestingModule} from '@nestjs/testing';
import {BadRequestException, ServiceUnavailableException} from '@nestjs/common';
import {ConfigService}   from '@nestjs/config';
import {AuthService}     from './auth.service';
import {JwtService}      from './jwt.service';
import {DatabaseService} from '../database/database.service';
import {RedisService}    from '../redis/redis.service';
import {AuditService}    from '../kafka/audit.service';
import {PasswordService} from '../common/services/password.service';
import {OtpService}      from '../common/services/otp.service';
import {TotpChallengeService} from '../common/services/totp-challenge.service';
import {secondFactorMode} from '../config/configuration';

/**
 * AUTH_SECOND_FACTOR=adaptive (2026-10-10, Bravo Secure home site):
 *   • a confirmed authenticator → authenticator code;
 *   • HQ staff, or a sign-in from the ops console → must set one up;
 *   • everyone else → a texted code, or an emailed one to a VERIFIED address
 *     when SMS is not configured; nothing deliverable → 503, never a
 *     password-only sign-in.
 */
const mockDb    = {q: jest.fn(), qOne: jest.fn()};
const mockRedis = {
  storeJti: jest.fn(), revokeJti: jest.fn(), revokeJtis: jest.fn(), isJtiValid: jest.fn(),
  markPushRevoked: jest.fn(), markPushRevokedMany: jest.fn(), clearPushRevoked: jest.fn(),
  client: {get: jest.fn()},
};
const mockAudit = {emit: jest.fn()};
const mockPw    = {hash: jest.fn(), verify: jest.fn()};
const mockOtp   = {generate: jest.fn(), hash: jest.fn(), send: jest.fn(), sendEmail: jest.fn(), check: jest.fn(), smsReady: jest.fn(), emailReady: jest.fn()};
const mockJwt   = {signAccessToken: jest.fn(), newRefreshToken: jest.fn(), refreshTokenHash: jest.fn(), ttlToSeconds: jest.fn()};
const mockTotp  = {status: jest.fn(), enrol: jest.fn(), check: jest.fn()};
const CONFIG: Record<string, unknown> = {
  'auth.secondFactor': 'adaptive',
  'jwt.refreshTtl': '30d', 'jwt.accessTtl': '15m',
  'otp.ttlMinutes': 10, 'otp.maxAttempts': 3, 'otp.devReturnCode': false, 'otp.devBypass': false,
};
const mockConfig = {get: jest.fn()};

const USER = {id: 'u-1', email: 'nadia@example.com', display_name: 'N', role: 'individual', subscription_tier: 'lite', phone_e164: '+971501234567'};
const USER_WITH_PW = {...USER, password_hash: '$argon2id$pw'};
const CHALLENGE = '11111111-1111-4111-8111-111111111111';
const ENROL = {uri: 'otpauth://totp/x', secret: 'S', backupCodes: ['AAAAAAAA']};

/** Answers qOne by what the SQL asks for. */
function db(opts: {staff?: boolean; emailVerified?: boolean; otpRow?: Record<string, unknown> | null}) {
  mockDb.qOne.mockImplementation(async (sql: string) => {
    if (/password_hash FROM public\.users/.test(sql)) return USER_WITH_PW;
    if (/FROM admin_users/.test(sql)) return {n: opts.staff ? 1 : 0};
    if (/SELECT email_verified_at FROM public\.users/.test(sql)) return {email_verified_at: opts.emailVerified ? new Date() : null};
    if (/FROM public\.users WHERE id=\$1 AND deleted_at IS NULL AND suspended_at IS NULL/.test(sql)) return USER;
    if (/FROM auth_otps/.test(sql)) return opts.otpRow ?? null;
    return null;
  });
}

describe('AuthService — AUTH_SECOND_FACTOR=adaptive', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockConfig.get.mockImplementation((key: string) => CONFIG[key]);
    mockJwt.signAccessToken.mockResolvedValue({accessToken: 'tok', jti: 'jti-1'});
    mockJwt.newRefreshToken.mockReturnValue({token: 'ref', hash: 'ref-hash'});
    mockJwt.ttlToSeconds.mockImplementation((s: string) => (s === '15m' ? 900 : 2_592_000));
    mockDb.q.mockResolvedValue([{id: CHALLENGE}]);
    for (const fn of [mockRedis.storeJti, mockRedis.markPushRevokedMany]) fn.mockResolvedValue(undefined);
    mockAudit.emit.mockResolvedValue(undefined);
    mockPw.verify.mockResolvedValue(true);
    mockTotp.status.mockResolvedValue('none');
    mockTotp.enrol.mockResolvedValue(ENROL);
    mockOtp.smsReady.mockReturnValue(true);
    mockOtp.emailReady.mockReturnValue(true);
    mockOtp.send.mockResolvedValue(undefined);
    mockOtp.sendEmail.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: RedisService,    useValue: mockRedis},
        {provide: AuditService,    useValue: mockAudit},
        {provide: PasswordService, useValue: mockPw},
        {provide: OtpService,      useValue: mockOtp},
        {provide: JwtService,      useValue: mockJwt},
        {provide: ConfigService,   useValue: mockConfig},
        {provide: TotpChallengeService, useValue: mockTotp},
      ],
    }).compile();
    service = module.get(AuthService);
  });

  it('parses the mode: totp and adaptive kept, anything else is sms', () => {
    expect(secondFactorMode('adaptive')).toBe('adaptive');
    expect(secondFactorMode(' TOTP ')).toBe('totp');
    expect(secondFactorMode(undefined)).toBe('sms');
    expect(secondFactorMode('carrier-pigeon')).toBe('sms');
  });

  it('a confirmed authenticator → authenticator challenge, nothing sent', async () => {
    db({});
    mockTotp.status.mockResolvedValue('verified');
    const out = await service.login({phoneE164: USER.phone_e164, password: 'ok'}, 'ip');
    expect(out).toMatchObject({userId: USER.id, challengeId: CHALLENGE, secondFactor: 'totp', enrol: null});
    expect(mockOtp.send).not.toHaveBeenCalled();
    expect(mockOtp.sendEmail).not.toHaveBeenCalled();
  });

  it('HQ staff without an authenticator must set one up (no texted code)', async () => {
    db({staff: true});
    const out = await service.login({phoneE164: USER.phone_e164, password: 'ok'}, 'ip');
    expect(out).toMatchObject({secondFactor: 'totp_enrol', enrol: ENROL});
    expect(mockOtp.send).not.toHaveBeenCalled();
  });

  it('a sign-in from the ops console must set one up even for a non-staff account', async () => {
    db({});
    const out = await service.login({phoneE164: USER.phone_e164, password: 'ok'}, 'ip', {staffConsole: true});
    expect(out.secondFactor).toBe('totp_enrol');
  });

  it('everyone else → a texted code to the phone, masked in the answer', async () => {
    db({});
    const out = await service.login({phoneE164: USER.phone_e164, password: 'ok'}, 'ip');
    expect(out).toMatchObject({secondFactor: 'sms', challengeId: null, enrol: null, otpSentTo: '+971•••67'});
    expect(mockOtp.send).toHaveBeenCalledWith(USER.phone_e164, '');
    expect(mockDb.q.mock.calls.some(([sql, args]) => /INSERT INTO auth_otps/.test(sql) && args[1] === 'phone')).toBe(true);
  });

  it('no SMS configured → emailed code, but only to a verified address', async () => {
    mockOtp.smsReady.mockReturnValue(false);
    db({emailVerified: true});
    const out = await service.login({phoneE164: USER.phone_e164, password: 'ok'}, 'ip');
    expect(out).toMatchObject({secondFactor: 'email', otpSentTo: 'na•••@example.com'});
    expect(mockOtp.sendEmail).toHaveBeenCalledWith(USER.email);

    jest.clearAllMocks();
    db({emailVerified: false});
    await expect(service.login({phoneE164: USER.phone_e164, password: 'ok'}, 'ip')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(mockOtp.sendEmail).not.toHaveBeenCalled();
  });

  it('verify with a challengeId → authenticator path; the code path is never used', async () => {
    db({otpRow: {id: CHALLENGE, expires_at: new Date(Date.now() + 60_000), used_at: null, attempt_count: 0}});
    await service.verify({userId: USER.id, code: '123456', challengeId: CHALLENGE, deviceId: 'd', platform: 'web'}, 'ip');
    expect(mockTotp.check).toHaveBeenCalled();
    expect(mockOtp.check).not.toHaveBeenCalled();
  });

  it('verify without a challengeId checks the emailed code against the EMAIL and marks it verified', async () => {
    db({otpRow: {id: 'o1', channel: 'email', expires_at: new Date(Date.now() + 60_000), used_at: null, attempt_count: 0}});
    mockOtp.check.mockResolvedValue(true);
    const out = await service.verify({userId: USER.id, code: '123456', deviceId: 'd', platform: 'web'}, 'ip');
    expect(mockOtp.check).toHaveBeenCalledWith(USER.email, '123456');
    expect(out.accessToken).toBe('tok');
    expect(mockDb.q.mock.calls.some(([sql]) => /email_verified_at=COALESCE/.test(sql))).toBe(true);
  });

  it('a wrong texted code burns an attempt and says how many are left', async () => {
    db({otpRow: {id: 'o1', channel: 'phone', expires_at: new Date(Date.now() + 60_000), used_at: null, attempt_count: 0}});
    mockOtp.check.mockResolvedValue(false);
    const err = await service.verify({userId: USER.id, code: '000000', deviceId: 'd', platform: 'web'}, 'ip').catch(e => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({error: 'otp_invalid', attemptsLeft: 2});
    expect(mockOtp.check).toHaveBeenCalledWith(USER.phone_e164, '000000');
  });
});
