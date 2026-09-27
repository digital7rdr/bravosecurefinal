import {HttpException, HttpStatus, Injectable, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {createHash, createHmac, hkdfSync, randomInt, timingSafeEqual} from 'node:crypto';
import {RedisService} from '../../redis/redis.service';
import {MessagingService} from '../../messaging/messaging.service';

/**
 * Twilio Verify allows 5 checks per verification; the server-held codes get
 * the same budget so the two modes share one brute-force bound.
 */
const MAX_CODE_CHECKS = 5;

/**
 * One-time codes for register, login and vault-PIN reset. Callers use
 * send(to) then check(to, code).
 *
 * Two Twilio modes (Integrations → Twilio → OTP delivery, see MessagingService):
 *   - verify: Twilio Verify generates, delivers and checks the code (original);
 *   - sms:    this service generates the code, stores an HMAC of it in Redis
 *             for the OTP TTL, sends it with Twilio SMS, and checks it locally,
 *             single-use. (Previously this path texted an EMPTY code.)
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private macKey: Buffer | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly redis:  RedisService,
    private readonly messaging: MessagingService,
  ) {}

  generate(): string {
    const len = this.config.get<number>('otp.length') ?? 6;
    const max = 10 ** len;
    return String(randomInt(0, max)).padStart(len, '0');
  }

  hash(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  private ttlMinutes(): number {
    return this.config.get<number>('otp.ttlMinutes') ?? 10;
  }

  /**
   * HMAC keyed off the action-token secret (HKDF, own label), bound to the
   * destination — a Redis dump alone cannot be brute-forced back to codes, and
   * a code issued to one number never matches another.
   */
  private codeMac(destination: string, code: string): string {
    if (!this.macKey) {
      const secret = this.config.get<string>('jwt.actionSecret') ?? '';
      if (!secret) {throw new Error('OTP code key unavailable (jwt.actionSecret unset)');}
      this.macKey = Buffer.from(hkdfSync('sha256', secret, 'bravo-otp', 'otp-code-mac-v1', 32));
    }
    return createHmac('sha256', this.macKey).update(`${destination}\n${code}`).digest('hex');
  }

  private static normalize(to: string): string {
    return to.trim().toLowerCase();
  }

  /**
   * Deliver a fresh code to `to`. The second argument is ignored and kept only
   * for the existing call sites — codes are always generated here or by Twilio.
   */
  async send(to: string, _unused = ''): Promise<void> {
    if (this.config.get<boolean>('otp.devBypass')) {
      // DEV ONLY — OTP send is a no-op. Any code will pass check(). See configuration.ts.
      return;
    }

    if (this.config.get<boolean>('otp.devReturnCode')) {
      // Dev mode: OTP is returned in the API response body — no logging, no SMS.
      return;
    }

    // Audit Rev2 API-01 — per-destination send cap. Sits in send() (not
    // register) deliberately: send() has TWO callers (register AND login), so a
    // counter in register alone would leave login-triggered sends unmetered.
    // This is the number-rotation defence the IP throttler can't provide — it
    // bounds a flood aimed at ONE number/email regardless of source IP. Keyed
    // on the normalized destination (phone_e164 / lowercased email).
    const maxPerHour = this.config.get<number>('otp.maxSendsPerHour') ?? 5;
    const destination = OtpService.normalize(to);
    // Fail OPEN on a Redis blip: a per-destination CAP must never take down
    // register/login (both call this). Twilio's own per-number abuse guard and
    // the IP throttler still apply, so a limiter outage degrades to "allow",
    // not a 500. Only a live counter over the ceiling blocks.
    let sends = 0;
    try {
      sends = await this.redis.incrOtpSends(destination);
    } catch (e) {
      this.logger.warn(`otp send-cap check skipped (redis unavailable): ${(e as Error).message}`);
    }
    if (sends > maxPerHour) {
      throw new HttpException('otp_send_rate_limited', HttpStatus.TOO_MANY_REQUESTS);
    }

    const mode = this.messaging.otpMode();
    if (!mode) {
      throw new Error('Twilio credentials not configured (need TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM or TWILIO_VERIFY_SID, or set them under Integrations → Twilio)');
    }

    if (mode === 'verify') {
      // A server-held code left over from SMS mode would shadow the Twilio
      // check (check() prefers a local code), so drop it first.
      await this.redis.clearOtpCode(destination).catch(() => undefined);
      await this.messaging.startVerify(to);
      return;
    }

    const code = this.generate();
    const ttl = this.ttlMinutes();
    // Store BEFORE sending: a user must never receive a code the server
    // cannot check. Redis down here → the send fails (closed), unlike the cap.
    await this.redis.storeOtpCode(destination, {h: this.codeMac(destination, code)}, ttl * 60);
    await this.messaging.sendSms(to, `Your Bravo Secure code: ${code}. Valid for ${ttl} minutes.`);
  }

  /**
   * Check a user-submitted code. A server-held code (SMS mode) is checked
   * locally and consumed on success; otherwise Twilio Verify, when configured,
   * owns the check. No pending code anywhere → false.
   */
  async check(to: string, code: string): Promise<boolean> {
    if (this.config.get<boolean>('otp.devBypass')) {
      // DEV ONLY — any non-empty 4-8 digit code passes.
      return /^\d{4,8}$/.test(code);
    }

    const destination = OtpService.normalize(to);
    const live = await this.redis.getOtpCode(destination);
    if (live) {
      const n = await this.redis.incrOtpChecks(destination, this.ttlMinutes() * 60);
      if (n > MAX_CODE_CHECKS) {
        await this.redis.clearOtpCode(destination);
        return false;
      }
      if (!/^\d{4,8}$/.test(code)) {return false;}
      const given = Buffer.from(this.codeMac(destination, code), 'hex');
      const stored = Buffer.from(live.h, 'hex');
      if (given.length !== stored.length || !timingSafeEqual(given, stored)) {return false;}
      return this.redis.consumeOtpCode(destination);
    }

    return this.messaging.checkVerify(to, code);
  }
}
