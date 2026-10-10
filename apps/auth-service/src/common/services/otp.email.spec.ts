import {HttpException} from '@nestjs/common';
import type {ConfigService} from '@nestjs/config';
import {OtpService} from './otp.service';

/**
 * Emailed codes (2026-10-10, home-site registration and the sign-in fallback):
 * server-held like SMS mode, bound to the address, single use, capped per
 * hour — and an email address is never sent to Twilio Verify.
 */
function harness(opts: {emailReady?: boolean; sends?: number} = {}) {
  const codes = new Map<string, {h: string}>();
  const redis = {
    incrOtpSends: jest.fn(async () => opts.sends ?? 1),
    storeOtpCode: jest.fn(async (d: string, r: {h: string}) => { codes.set(d, r); }),
    getOtpCode: jest.fn(async (d: string) => codes.get(d) ?? null),
    incrOtpChecks: jest.fn(async () => 1),
    consumeOtpCode: jest.fn(async (d: string) => codes.delete(d)),
    clearOtpCode: jest.fn(),
  };
  const sent: Array<{to: string; text: string}> = [];
  const messaging = {
    isEmailReady: jest.fn(() => opts.emailReady ?? true),
    sendEmail: jest.fn(async (to: string, _s: string, text: string) => { sent.push({to, text}); return {}; }),
    otpMode: jest.fn(() => null),
    checkVerify: jest.fn(async () => true),
  };
  const cfg: Record<string, unknown> = {'otp.length': 6, 'otp.ttlMinutes': 10, 'jwt.actionSecret': 'test-action-secret-0123456789abcdef'};
  const config = {get: (k: string) => cfg[k]} as unknown as ConfigService;
  const svc = new OtpService(config, redis as never, messaging as never);
  return {svc, redis, messaging, sent, codes};
}

describe('OtpService — emailed codes', () => {
  it('emails a 6-digit code and keeps only a keyed hash of it', async () => {
    const {svc, sent, codes} = harness();
    await svc.sendEmail('Nadia@Example.com');
    expect(sent[0].to).toBe('Nadia@Example.com');
    const code = /is (\d{6})\./.exec(sent[0].text)![1];
    const stored = codes.get('nadia@example.com')!;
    expect(stored.h).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.h).not.toContain(code);
  });

  it('the code works once, for that address only', async () => {
    const {svc, sent} = harness();
    await svc.sendEmail('a@b.com');
    const code = /is (\d{6})\./.exec(sent[0].text)![1];
    expect(await svc.check('c@d.com', code)).toBe(false);
    expect(await svc.check('A@B.com', code)).toBe(true);
    expect(await svc.check('a@b.com', code)).toBe(false);
  });

  it('never asks Twilio Verify about an email address', async () => {
    const {svc, messaging} = harness();
    expect(await svc.check('nobody@b.com', '123456')).toBe(false);
    expect(messaging.checkVerify).not.toHaveBeenCalled();
  });

  it('refuses when email is not configured, and past the hourly cap', async () => {
    await expect(harness({emailReady: false}).svc.sendEmail('a@b.com')).rejects.toThrow(/Email not configured/);
    await expect(harness({sends: 6}).svc.sendEmail('a@b.com')).rejects.toBeInstanceOf(HttpException);
  });
});
