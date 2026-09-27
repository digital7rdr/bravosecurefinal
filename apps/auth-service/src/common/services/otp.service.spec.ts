import {Test, TestingModule} from '@nestjs/testing';
import {ConfigService}       from '@nestjs/config';
import {HttpException}       from '@nestjs/common';
import {OtpService}          from './otp.service';
import {RedisService, type OtpCodeRecord} from '../../redis/redis.service';
import {SettingsService}     from '../../settings/settings.service';
import {MessagingService}    from '../../messaging/messaging.service';

// Mock twilio before any imports so the dynamic import() in the provider is intercepted
const mockCreate          = jest.fn().mockResolvedValue({sid: 'SM1'});
const mockVerifyCreate    = jest.fn().mockResolvedValue({});
const mockVerifyCheck     = jest.fn().mockResolvedValue({status: 'approved'});
const mockTwilioClient    = {
  messages: {create: mockCreate},
  verify:   {v2: {services: jest.fn().mockReturnValue({
    verifications: {create: mockVerifyCreate},
    verificationChecks: {create: mockVerifyCheck},
  })}},
};
const mockTwilioCtor      = jest.fn().mockReturnValue(mockTwilioClient);
jest.mock('twilio', () => ({default: mockTwilioCtor, Twilio: mockTwilioCtor}));

function makeConfig(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    'otp.length':        6,
    'otp.ttlMinutes':    10,
    'otp.devReturnCode': false,
    'jwt.actionSecret':  'test-action-secret-0123456789abcdef0123456789',
    'twilio.accountSid': '',
    'twilio.authToken':  '',
    'twilio.fromNumber': '',
    'twilio.verifySid':  '',
  };
  return {get: jest.fn((k: string) => overrides[k] ?? defaults[k])} as unknown as ConfigService;
}

/** In-memory stand-in for the RedisService surface OtpService uses. */
function makeRedis() {
  const codes = new Map<string, OtpCodeRecord>();
  const checks = new Map<string, number>();
  return {
    codes, checks,
    // Audit Rev2 API-01 — send() consults a per-destination counter. Default
    // "1st send this hour"; tests override it to drive the rate-limit branch.
    incrOtpSends: jest.fn().mockResolvedValue(1),
    storeOtpCode: jest.fn(async (d: string, r: OtpCodeRecord) => {codes.set(d, r); checks.delete(d);}),
    getOtpCode: jest.fn(async (d: string) => codes.get(d) ?? null),
    incrOtpChecks: jest.fn(async (d: string) => {const n = (checks.get(d) ?? 0) + 1; checks.set(d, n); return n;}),
    consumeOtpCode: jest.fn(async (d: string) => {checks.delete(d); return codes.delete(d);}),
    clearOtpCode: jest.fn(async (d: string) => {codes.delete(d); checks.delete(d);}),
  };
}
let mockRedis = makeRedis();

async function build(cfg: ConfigService): Promise<OtpService> {
  mockRedis = makeRedis();
  const cfgGet = (k: string) => (cfg as unknown as {get: (k: string) => unknown}).get(k) as string | undefined;
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      OtpService,
      MessagingService,
      {provide: ConfigService, useValue: cfg},
      {provide: RedisService,  useValue: mockRedis},
      // Twilio credentials come through SettingsService.getSync; delegate to
      // the same cfg so makeConfig() overrides drive the mode.
      {provide: SettingsService, useValue: {getSync: cfgGet}},
    ],
  }).compile();
  return module.get(OtpService);
}

const TWILIO_VERIFY = {'twilio.accountSid': 'ACtest', 'twilio.authToken': 'tok', 'twilio.verifySid': 'VAtest'};
const TWILIO_SMS    = {'twilio.accountSid': 'ACtest', 'twilio.authToken': 'tok', 'twilio.fromNumber': '+19999999999'};

/** The code the service put into the last Twilio SMS. */
function lastSmsCode(): string {
  return /code: (\d+)/.exec(mockCreate.mock.calls.at(-1)![0].body)![1];
}

afterEach(() => {
  mockCreate.mockClear(); mockVerifyCreate.mockClear(); mockVerifyCheck.mockClear();
});

describe('OtpService', () => {
  // ── generate ──────────────────────────────────────────────────────────────
  describe('generate()', () => {
    it('returns a 6-digit zero-padded numeric string by default', async () => {
      const svc = await build(makeConfig());
      expect(svc.generate()).toMatch(/^\d{6}$/);
    });

    it('respects a custom otp.length of 4', async () => {
      const svc = await build(makeConfig({'otp.length': 4}));
      expect(svc.generate()).toMatch(/^\d{4}$/);
    });

    it('generates different values on successive calls (probabilistic)', async () => {
      const svc = await build(makeConfig());
      const codes = new Set(Array.from({length: 10}, () => svc.generate()));
      expect(codes.size).toBeGreaterThan(1);
    });
  });

  // ── hash ─────────────────────────────────────────────────────────────────
  describe('hash()', () => {
    it('returns a 64-char lowercase hex string (SHA-256)', async () => {
      const svc = await build(makeConfig());
      expect(svc.hash('123456')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic — same input → same output', async () => {
      const svc = await build(makeConfig());
      expect(svc.hash('000000')).toBe(svc.hash('000000'));
    });

    it('is sensitive to input — different code → different hash', async () => {
      const svc = await build(makeConfig());
      expect(svc.hash('111111')).not.toBe(svc.hash('222222'));
    });
  });

  // ── dev modes ─────────────────────────────────────────────────────────────
  describe('send() — dev bypass', () => {
    it('returns without throwing when devReturnCode=true (no network)', async () => {
      const svc = await build(makeConfig({'otp.devReturnCode': true, ...TWILIO_SMS}));
      await expect(svc.send('+15555550101', '123456')).resolves.toBeUndefined();
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  // ── Twilio Verify (original path; default when its SID is set) ────────────
  describe('Twilio Verify mode', () => {
    it('starts a Verify verification when verifySid is set and no mode is chosen', async () => {
      const svc = await build(makeConfig(TWILIO_VERIFY));
      await expect(svc.send('+15555550101', '')).resolves.toBeUndefined();
      expect(mockVerifyCreate).toHaveBeenCalledWith(expect.objectContaining({to: '+15555550101', channel: 'sms'}));
      expect(mockRedis.storeOtpCode).not.toHaveBeenCalled();
    });

    it('checks through Twilio when no server-held code exists', async () => {
      const svc = await build(makeConfig(TWILIO_VERIFY));
      mockVerifyCheck.mockResolvedValueOnce({status: 'approved'});
      await expect(svc.check('+15555550101', '123456')).resolves.toBe(true);
      mockVerifyCheck.mockRejectedValueOnce(Object.assign(new Error('gone'), {status: 404}));
      await expect(svc.check('+15555550101', '123456')).resolves.toBe(false);
    });

    it('drops a leftover server-held code so it cannot shadow the Twilio check', async () => {
      const svc = await build(makeConfig(TWILIO_VERIFY));
      mockRedis.codes.set('+15555550101', {h: 'ab'.repeat(32)});
      await svc.send('+15555550101', '');
      expect(mockRedis.codes.has('+15555550101')).toBe(false);
    });

    it('propagates Twilio errors unchanged (register maps 60203 / 60410 / 21608)', async () => {
      const svc = await build(makeConfig(TWILIO_VERIFY));
      mockVerifyCreate.mockRejectedValueOnce(Object.assign(new Error('max'), {code: 60203, status: 429}));
      await expect(svc.send('+15555550101', '')).rejects.toMatchObject({code: 60203});
    });

    it('an explicit "sms" choice wins even when a Verify SID is set', async () => {
      const svc = await build(makeConfig({...TWILIO_VERIFY, ...TWILIO_SMS, 'twilio.otpMode': 'sms'}));
      await svc.send('+15555550101', '');
      expect(mockVerifyCreate).not.toHaveBeenCalled();
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
  });

  // ── Twilio SMS with a server-held code ────────────────────────────────────
  describe('Twilio SMS mode', () => {
    it('sends a generated code (not the empty caller argument) and verifies it once', async () => {
      const svc = await build(makeConfig(TWILIO_SMS));
      await svc.send('+15555550101', '');
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({to: '+15555550101', from: '+19999999999'}));
      const code = lastSmsCode();
      expect(code).toMatch(/^\d{6}$/);
      await expect(svc.check('+15555550101', code)).resolves.toBe(true);
      // single-use
      await expect(svc.check('+15555550101', code)).resolves.toBe(false);
    });

    it('stores only a keyed hash — never the code — bound to the destination', async () => {
      const svc = await build(makeConfig(TWILIO_SMS));
      await svc.send('+971501234567', '');
      const code = lastSmsCode();
      const rec = mockRedis.codes.get('+971501234567')!;
      expect(rec.h).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(rec)).not.toContain(`"${code}"`);
      mockRedis.codes.set('+971509999999', rec);
      await expect(svc.check('+971509999999', code)).resolves.toBe(false);
      await expect(svc.check('+971501234567', code)).resolves.toBe(true);
    });

    it('rejects a wrong code and burns the code after 5 checks', async () => {
      const svc = await build(makeConfig(TWILIO_SMS));
      await svc.send('+971501234567', '');
      const code = lastSmsCode();
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) {await expect(svc.check('+971501234567', wrong)).resolves.toBe(false);}
      await expect(svc.check('+971501234567', code)).resolves.toBe(false);
      expect(mockRedis.codes.has('+971501234567')).toBe(false);
    });

    it('two concurrent checks with the right code: exactly one wins', async () => {
      const svc = await build(makeConfig(TWILIO_SMS));
      await svc.send('+971501234567', '');
      const code = lastSmsCode();
      const results = await Promise.all([svc.check('+971501234567', code), svc.check('+971501234567', code)]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('a resend replaces the previous code', async () => {
      const svc = await build(makeConfig(TWILIO_SMS));
      await svc.send('+971501234567', '');
      const first = lastSmsCode();
      await svc.send('+971501234567', '');
      const second = lastSmsCode();
      if (first !== second) {await expect(svc.check('+971501234567', first)).resolves.toBe(false);}
      await expect(svc.check('+971501234567', second)).resolves.toBe(true);
    });
  });

  // ── nothing configured ────────────────────────────────────────────────────
  describe('missing credentials', () => {
    it('send() throws when no Twilio credentials are configured', async () => {
      const svc = await build(makeConfig());
      await expect(svc.send('+15555550101', '')).rejects.toThrow(/credentials not configured/i);
    });

    it('a chosen mode without its credentials fails loudly', async () => {
      const svc = await build(makeConfig({'twilio.otpMode': 'sms'}));
      await expect(svc.send('+15555550101', '')).rejects.toThrow(/Twilio SMS not configured/);
    });

    it('check() with no pending code anywhere is false, not a 500', async () => {
      const svc = await build(makeConfig());
      await expect(svc.check('+15555550101', '123456')).resolves.toBe(false);
    });
  });

  // ── per-destination rate limit (Audit Rev2 API-01) ───────────────────────
  describe('send() — per-destination cap', () => {
    it('counts against the NORMALIZED destination', async () => {
      const svc = await build(makeConfig(TWILIO_VERIFY));
      await svc.send('  +15555550101  ', '');
      expect(mockRedis.incrOtpSends).toHaveBeenCalledWith('+15555550101');
    });

    it('rejects with 429 once the count exceeds the hourly ceiling — before any Twilio call', async () => {
      const svc = await build(makeConfig({'otp.maxSendsPerHour': 5, ...TWILIO_SMS}));
      mockRedis.incrOtpSends.mockResolvedValue(6);
      await expect(svc.send('+15555550101', '')).rejects.toThrow(HttpException);
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockRedis.storeOtpCode).not.toHaveBeenCalled();
    });

    it('does not count dev-bypass sends (returns before the counter)', async () => {
      const svc = await build(makeConfig({'otp.devReturnCode': true}));
      await svc.send('+15555550101', '');
      expect(mockRedis.incrOtpSends).not.toHaveBeenCalled();
    });

    it('FAILS OPEN when the counter is unavailable — never 500s register/login', async () => {
      const svc = await build(makeConfig(TWILIO_VERIFY));
      mockRedis.incrOtpSends.mockRejectedValueOnce(new Error('redis down'));
      await expect(svc.send('+15555550101', '')).resolves.toBeUndefined();
      expect(mockVerifyCreate).toHaveBeenCalled();
    });

    it('FAILS CLOSED when a server-held code cannot be stored — no SMS goes out', async () => {
      const svc = await build(makeConfig(TWILIO_SMS));
      mockRedis.storeOtpCode.mockRejectedValueOnce(new Error('redis down'));
      await expect(svc.send('+15555550101', '')).rejects.toThrow('redis down');
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });
});
