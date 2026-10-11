import {Test, TestingModule} from '@nestjs/testing';
import {HttpException} from '@nestjs/common';
import {ConfigService}   from '@nestjs/config';
import {AuthService}     from './auth.service';
import {JwtService}      from './jwt.service';
import {DatabaseService} from '../database/database.service';
import {RedisService}    from '../redis/redis.service';
import {AuditService}    from '../kafka/audit.service';
import {PasswordService} from '../common/services/password.service';
import {OtpService}      from '../common/services/otp.service';
import {TotpChallengeService} from '../common/services/totp-challenge.service';

/**
 * Sign-in limit (2026-10-11): only WRONG passwords count, per phone/email
 * typed; 10 in 15 minutes locks that account's sign-in until the window
 * ends; a correct password clears the count; Redis trouble never blocks.
 */
const counts = new Map<string, number>();
const mockRedis = {
  storeJti: jest.fn(), revokeJti: jest.fn(), markPushRevokedMany: jest.fn(), clearPushRevoked: jest.fn(),
  loginFailures: jest.fn(async (k: string) => ({count: counts.get(k) ?? 0, retryInSec: counts.has(k) ? 420 : 0})),
  incrLoginFailures: jest.fn(async (k: string) => { counts.set(k, (counts.get(k) ?? 0) + 1); return counts.get(k)!; }),
  clearLoginFailures: jest.fn(async (k: string) => { counts.delete(k); }),
};
const mockDb    = {q: jest.fn(async () => [{id: '11111111-1111-4111-8111-111111111111'}]), qOne: jest.fn()};
const mockPw    = {hash: jest.fn(), verify: jest.fn()};
const mockTotp  = {status: jest.fn(async () => 'verified'), enrol: jest.fn(), check: jest.fn()};
const CONFIG: Record<string, unknown> = {'auth.secondFactor': 'totp'};

const USER = {id: 'u-1', email: 'n@example.com', display_name: 'N', role: 'individual', subscription_tier: 'lite', phone_e164: '+971501234567', password_hash: 'h'};
const login = (svc: AuthService, phone = '+971501234567') => svc.login({phoneE164: phone, password: 'pw'} as never, '1.2.3.4');

describe('AuthService.login — wrong-password limit', () => {
  let service: AuthService;

  beforeEach(async () => {
    counts.clear();
    mockDb.qOne.mockResolvedValue(USER);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: RedisService,    useValue: mockRedis},
        {provide: AuditService,    useValue: {emit: jest.fn()}},
        {provide: PasswordService, useValue: mockPw},
        {provide: OtpService,      useValue: {}},
        {provide: JwtService,      useValue: {}},
        {provide: ConfigService,   useValue: {get: (k: string) => CONFIG[k]}},
        {provide: TotpChallengeService, useValue: mockTotp},
      ],
    }).compile();
    service = module.get(AuthService);
  });

  it('correct sign-ins never count, however many', async () => {
    mockPw.verify.mockResolvedValue(true);
    for (let i = 0; i < 25; i++) await expect(login(service)).resolves.toMatchObject({secondFactor: 'totp'});
  });

  it('10 wrong passwords lock that number with a clear wait time; other numbers are unaffected', async () => {
    mockPw.verify.mockResolvedValue(false);
    for (let i = 0; i < 10; i++) await expect(login(service)).resolves.toMatchObject({userId: null});
    const err = await login(service).catch(e => e) as HttpException;
    expect(err.getStatus()).toBe(429);
    expect(err.getResponse()).toMatchObject({error: 'login_locked', retryInSec: 420});
    expect(String((err.getResponse() as {message: string}).message)).toMatch(/7 minutes/);
    await expect(login(service, '+971509999999')).resolves.toMatchObject({userId: null});
  });

  it('a correct password clears the count', async () => {
    mockPw.verify.mockResolvedValue(false);
    for (let i = 0; i < 9; i++) await login(service);
    mockPw.verify.mockResolvedValue(true);
    await login(service);
    expect(counts.has('+971501234567')).toBe(false);
  });

  it('a Redis failure never blocks sign-in', async () => {
    mockRedis.loginFailures.mockRejectedValueOnce(new Error('redis down'));
    mockPw.verify.mockResolvedValue(true);
    await expect(login(service)).resolves.toMatchObject({secondFactor: 'totp'});
  });
});
