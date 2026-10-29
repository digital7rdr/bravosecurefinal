import {
  BadRequestException, ForbiddenException, HttpException, Injectable, Logger, ServiceUnavailableException,
} from '@nestjs/common';
import {randomBytes} from 'node:crypto';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {AuditService} from '../kafka/audit.service';
import {PasswordService} from '../common/services/password.service';
import {OtpService} from '../common/services/otp.service';
import {TotpChallengeService} from '../common/services/totp-challenge.service';
import {AuthService} from '../auth/auth.service';

/**
 * "Forgot your password?" on the Bravo Secure home site (2026-10-11).
 *
 *   start    → the person types their mobile number or email. If an account
 *              matches, a 6-digit code is TEXTED (number, when SMS is set up)
 *              or EMAILED (email address, or a number whose account has a
 *              verified email when SMS is not set up). The answer is the same
 *              whether or not an account matched, so the page cannot be used
 *              to find out who has an account.
 *   complete → the code, then (only if the account has an authenticator) a
 *              code from the authenticator app, then the new password. A
 *              reset by text or email alone must never get round an
 *              authenticator. On success every signed-in device is signed
 *              out and the person signs in again with the new password.
 *
 * Never uses the REGISTER_PHONE_PROOF=stub shortcut: a reset code is always
 * really delivered. HQ staff without an authenticator are sent to an
 * administrator instead (their accounts require one).
 */

const TTL_SEC = 15 * 60;
const MAX_TRIES = 6;
const PREFIX = 'pwreset:';

interface Pending {
  userId: string | null;     // null = no account matched (nothing was sent)
  target: string | null;     // phone or email the code went to
  via: 'sms' | 'email' | null;
  codeOk: boolean;
  tries: number;
  createdAt: number;
}

export type ResetCompleteResult =
  | {done: true}
  | {done: false; needTotp: true};

const normalisePhone = (v: string) => v.trim().replace(/[\s\-().]/g, '').replace(/^00/, '+');

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly password: PasswordService,
    private readonly otp: OtpService,
    private readonly totp: TotpChallengeService,
    private readonly auth: AuthService,
  ) {}

  /** Whether the page should offer a reset at all (some way to send a code). */
  available(): boolean {
    return this.otp.smsReady() || this.otp.emailReady();
  }

  /** 2026-10-30 — which delivery channels are set up (no account facts). */
  channels(): {sms: boolean; email: boolean} {
    return {sms: this.otp.smsReady(), email: this.otp.emailReady()};
  }

  private async load(id: string): Promise<Pending> {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) throw new BadRequestException({error: 'reset_expired', message: 'This reset has expired. Start again.'});
    const raw = await this.redis.get(`${PREFIX}${id}`);
    if (!raw) throw new BadRequestException({error: 'reset_expired', message: 'This reset has expired. Start again.'});
    return JSON.parse(raw) as Pending;
  }

  private async save(id: string, p: Pending): Promise<void> {
    const left = Math.max(60, TTL_SEC - Math.floor((Date.now() - p.createdAt) / 1000));
    await this.redis.set(`${PREFIX}${id}`, JSON.stringify(p), left);
  }

  async start(identifier: string, ip: string): Promise<{resetId: string}> {
    if (!this.available()) {
      throw new ServiceUnavailableException({error: 'reset_unavailable', message: 'Password reset opens once Bravo Secure has set up text and email delivery. Contact Bravo Secure support.'});
    }
    const raw = identifier.trim();
    const byEmail = raw.includes('@');
    const key = byEmail ? raw.toLowerCase() : normalisePhone(raw);
    if (byEmail ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key) : !/^\+\d{7,15}$/.test(key)) {
      throw new BadRequestException({error: 'identifier_invalid', message: byEmail ? 'Check the email address.' : 'Enter the mobile number with its country code, for example +971 50 123 4567.'});
    }

    const user = await this.db.qOne<{id: string; email: string | null; phone_e164: string | null; email_verified_at: string | null}>(
      `SELECT id, email::text AS email, phone_e164, email_verified_at FROM public.users
        WHERE ${byEmail ? 'lower(email::text)=$1' : 'phone_e164=$1'} AND deleted_at IS NULL AND suspended_at IS NULL
        LIMIT 1`, [key]);

    let target: string | null = null;
    let via: Pending['via'] = null;
    if (user) {
      if (byEmail) {
        if (this.otp.emailReady()) { target = key; via = 'email'; }
      } else if (this.otp.smsReady()) {
        target = key; via = 'sms';
      } else if (user.email && user.email_verified_at && this.otp.emailReady()) {
        target = user.email.toLowerCase(); via = 'email';
      }
    }

    const id = randomBytes(24).toString('base64url');
    await this.save(id, {userId: target ? user!.id : null, target, via, codeOk: false, tries: 0, createdAt: Date.now()});

    if (target && via) {
      try {
        if (via === 'sms') await this.otp.send(target, '');
        else await this.otp.sendEmail(target);
      } catch (err) {
        // A send cap is the person's own doing — say so. Anything else is
        // logged and the answer stays the same as for an unknown account.
        if (err instanceof HttpException && err.getStatus() === 429) {
          throw new HttpException({error: 'otp_rate_limited', message: 'Too many codes sent. Wait about an hour and try again.'}, 429);
        }
        this.logger.warn(`password reset: ${via} delivery failed: ${(err as Error)?.message ?? err}`);
      }
    }
    await this.audit.emit({event_type: 'auth.password.reset', user_id: user?.id ?? null, device_id: null, ip,
      outcome: target ? 'success' : 'failure', detail: target ? `code_sent_${via}` : (user ? 'no_channel' : 'no_account')});
    return {resetId: id};
  }

  async complete(id: string, input: {code: string; newPassword: string; totpCode?: string}, ip: string): Promise<ResetCompleteResult> {
    const p = await this.load(id);
    if (p.tries >= MAX_TRIES) {
      await this.redis.takeOnce(`${PREFIX}${id}`);
      throw new ForbiddenException({error: 'reset_locked', message: 'Too many wrong codes. Start the reset again.'});
    }
    p.tries += 1;

    if (!p.codeOk) {
      p.codeOk = !!(p.userId && p.target && /^\d{4,8}$/.test(input.code) && await this.otp.check(p.target, input.code));
      if (!p.codeOk) {
        await this.save(id, p);
        throw new BadRequestException({error: 'code_invalid', message: 'That code is not right. Check the latest text or email and try again.'});
      }
    }
    const userId = p.userId!;

    // An authenticator, when the account has one, is always asked for too.
    const totpOn = (await this.totp.status(userId)) === 'verified';
    const staff = await this.db.qOne(`SELECT 1 FROM admin_users WHERE user_id=$1 AND active`, [userId]);
    if (staff && !totpOn) {
      await this.redis.takeOnce(`${PREFIX}${id}`);
      await this.audit.emit({event_type: 'auth.password.reset', user_id: userId, device_id: null, ip, outcome: 'failure', detail: 'staff_without_totp'});
      throw new ForbiddenException({error: 'reset_needs_admin', message: 'For HQ staff accounts, ask a Bravo Secure administrator to reset your password.'});
    }
    if (totpOn) {
      if (!input.totpCode) {
        await this.save(id, p);
        return {done: false, needTotp: true};
      }
      try {
        await this.totp.check(userId, input.totpCode.replace(/[\s-]/g, ''), null, ip);
      } catch {
        await this.save(id, p);
        throw new BadRequestException({error: 'totp_invalid', message: 'That authenticator code is not right. Type the code your app shows now, or a backup code.'});
      }
    }

    const cur = await this.db.qOne<{password_hash: string | null}>(
      `SELECT password_hash FROM public.users WHERE id=$1 AND deleted_at IS NULL AND suspended_at IS NULL`, [userId]);
    if (!cur) {
      await this.redis.takeOnce(`${PREFIX}${id}`);
      throw new BadRequestException({error: 'reset_expired', message: 'This reset has expired. Start again.'});
    }
    if (cur.password_hash && await this.password.verify(cur.password_hash, input.newPassword)) {
      await this.save(id, p);
      throw new BadRequestException({error: 'new_password_must_differ', message: 'Choose a password you have not used for this account.'});
    }

    // Spent from here on, whatever happens next.
    await this.redis.takeOnce(`${PREFIX}${id}`);
    const hash = await this.password.hash(input.newPassword);
    await this.db.q(
      `UPDATE public.users
          SET password_hash=$2, password_set_at=now(), invite_expires_at=NULL, updated_at=now(),
              phone_verified_at = CASE WHEN $3 = 'sms'   THEN now() ELSE phone_verified_at END,
              email_verified_at = CASE WHEN $3 = 'email' THEN now() ELSE email_verified_at END
        WHERE id=$1`,
      [userId, hash, p.via]);
    // A reset means the old password may be known to someone else: sign out everywhere.
    await this.auth.revokeAllUserSessions(userId, ip).catch(() => 0);
    await this.audit.emit({event_type: 'auth.password.reset', user_id: userId, device_id: null, ip, outcome: 'success',
      detail: `password_reset_${p.via}${totpOn ? '_totp' : ''}`});
    return {done: true};
  }
}
