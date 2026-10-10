import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {randomBytes} from 'node:crypto';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {AuditService} from '../kafka/audit.service';
import {PasswordService} from '../common/services/password.service';
import {OtpService} from '../common/services/otp.service';
import {AuthService, type UserRow} from '../auth/auth.service';

/**
 * Registration on the Bravo Secure home site (2026-10-10).
 *
 *   start    → details checked, a code TEXTED to the phone and a code EMAILED
 *              to the address; nothing is written to the database yet (the
 *              pending sign-up lives in Redis for 20 minutes).
 *   complete → both codes proven (each one is remembered as soon as it is
 *              right, so a typo in one never burns the other), THEN the
 *              account is created with phone_verified_at and email_verified_at
 *              set, and a session is issued.
 *
 * The authenticator is set up afterwards, optionally, from the home site.
 * An admin-created invite for the same phone (and only that) is claimed, as
 * the app's own registration does.
 */

const TTL_SEC = 20 * 60;
const MAX_TRIES = 6;
const PREFIX = 'signup:';

interface Pending {
  displayName: string;
  email: string;
  phone: string;
  pwHash: string;
  phoneOk: boolean;
  emailOk: boolean;
  tries: number;
  createdAt: number;
}

export interface SignupStartInput {displayName: string; email: string; phoneE164: string; password: string}

const maskPhone = (p: string) => (p.length > 6 ? `${p.slice(0, 4)}•••${p.slice(-2)}` : '•••');
const maskEmail = (e: string) => { const [l, d] = e.split('@'); return `${(l ?? '').slice(0, 2)}•••@${d ?? ''}`; };

@Injectable()
export class SignupService {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly password: PasswordService,
    private readonly otp: OtpService,
    private readonly auth: AuthService,
    // Appended last (specs construct this positionally).
    private readonly config?: ConfigService,
  ) {}

  /**
   * REGISTER_PHONE_PROOF=stub (owner decision 2026-10-09, TESTING ONLY until
   * Twilio is connected): the phone code is generated and checked as usual
   * but handed back instead of texted. Proves nothing about the phone.
   */
  private get phoneStub(): boolean {
    return this.config?.get<string>('auth.registerPhoneProof') === 'stub';
  }

  /** Registration needs BOTH channels: it proves the phone and the email. */
  available(): boolean {
    return (this.otp.smsReady() || this.phoneStub) && this.otp.emailReady();
  }

  private async load(id: string): Promise<Pending> {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) throw new BadRequestException('signup_expired');
    const raw = await this.redis.get(`${PREFIX}${id}`);
    if (!raw) throw new BadRequestException('signup_expired');
    return JSON.parse(raw) as Pending;
  }

  private async save(id: string, p: Pending): Promise<void> {
    const left = Math.max(60, TTL_SEC - Math.floor((Date.now() - p.createdAt) / 1000));
    await this.redis.set(`${PREFIX}${id}`, JSON.stringify(p), left);
  }

  /** Twilio's own refusals, in words (same codes the app's registration maps). */
  private static async sendSms(otp: OtpService, phone: string): Promise<void> {
    try {
      await otp.send(phone, '');
    } catch (err) {
      const e = err as {code?: number; status?: number};
      if (e instanceof HttpException) throw e;
      if (e?.code === 60203 || e?.status === 429) {
        throw new HttpException({error: 'otp_rate_limited', message: 'Too many codes sent to this number. Wait about 10 minutes and try again.'}, HttpStatus.TOO_MANY_REQUESTS);
      }
      if (e?.code === 60410 || e?.code === 21608 || e?.code === 21211 || e?.code === 60200) {
        throw new BadRequestException({error: 'phone_unreachable', message: 'We could not send a text to this number. Check it, or use another number.'});
      }
      throw new ServiceUnavailableException({error: 'sms_unavailable', message: 'Text messages cannot be sent right now. Try again later.'});
    }
  }

  private static async sendEmail(otp: OtpService, email: string): Promise<void> {
    try {
      await otp.sendEmail(email);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new ServiceUnavailableException({error: 'email_unavailable', message: 'Emails cannot be sent right now. Try again later.'});
    }
  }

  async start(dto: SignupStartInput, ip: string): Promise<{signupId: string; phone: string; email: string; devPhoneCode?: string}> {
    if (!this.available()) {
      throw new ServiceUnavailableException({error: 'registration_unavailable', message: 'Registration opens once Bravo Secure has set up text and email delivery.'});
    }
    const email = dto.email.trim().toLowerCase();
    const phone = dto.phoneE164.trim();
    const existing = await this.db.qOne<{id: string}>(
      `SELECT id FROM public.users WHERE (email=$1 OR phone_e164=$2) AND deleted_at IS NULL`, [email, phone]);
    if (existing && !(await this.auth.claimableInvite(email, phone))) {
      await this.audit.emit({event_type: 'auth.register', user_id: null, device_id: null, ip, outcome: 'failure', detail: 'hub_already_exists'});
      throw new ConflictException({error: 'already_exists', message: 'An account already uses this phone number or email. Sign in instead.'});
    }
    const id = randomBytes(24).toString('base64url');
    const pending: Pending = {
      displayName: dto.displayName.trim(), email, phone,
      pwHash: await this.password.hash(dto.password),
      phoneOk: false, emailOk: false, tries: 0, createdAt: Date.now(),
    };
    await this.save(id, pending);
    const devPhoneCode = await this.phoneCode(phone);
    await SignupService.sendEmail(this.otp, email);
    await this.audit.emit({event_type: 'auth.register', user_id: null, device_id: null, ip, outcome: 'success',
      detail: devPhoneCode ? 'hub_codes_sent_phone_stub' : 'hub_codes_sent'});
    return {signupId: id, phone: maskPhone(phone), email: maskEmail(email), ...(devPhoneCode ? {devPhoneCode} : {})};
  }

  /** Text the phone code; in stub mode return it instead (nothing is sent). */
  private async phoneCode(phone: string): Promise<string | null> {
    if (this.phoneStub) return this.otp.issueStub(phone);
    await SignupService.sendSms(this.otp, phone);
    return null;
  }

  async resend(id: string, channel: 'phone' | 'email'): Promise<{ok: true; devPhoneCode?: string}> {
    const p = await this.load(id);
    if (channel === 'phone' && !p.phoneOk) {
      const devPhoneCode = await this.phoneCode(p.phone);
      if (devPhoneCode) return {ok: true, devPhoneCode};
    }
    if (channel === 'email' && !p.emailOk) await SignupService.sendEmail(this.otp, p.email);
    return {ok: true};
  }

  /**
   * Prove the codes, then create the account. Returns which code is still
   * wrong while one is, so the page can say exactly what to fix.
   */
  async complete(id: string, codes: {phoneCode?: string; emailCode?: string}, ip: string):
    Promise<{done: false; phoneOk: boolean; emailOk: boolean} | {done: true; user: UserRow}> {
    const p = await this.load(id);
    if (p.tries >= MAX_TRIES) {
      await this.redis.takeOnce(`${PREFIX}${id}`);
      throw new ForbiddenException({error: 'signup_locked', message: 'Too many wrong codes. Start the registration again.'});
    }
    p.tries += 1;
    if (!p.phoneOk && codes.phoneCode) p.phoneOk = await this.otp.check(p.phone, codes.phoneCode);
    if (!p.emailOk && codes.emailCode) p.emailOk = await this.otp.check(p.email, codes.emailCode);
    if (!p.phoneOk || !p.emailOk) {
      await this.save(id, p);
      return {done: false, phoneOk: p.phoneOk, emailOk: p.emailOk};
    }
    // Both proven: this pending sign-up is spent whatever happens next.
    await this.redis.takeOnce(`${PREFIX}${id}`);

    const inviteId = await this.auth.claimableInvite(p.email, p.phone);
    let userId: string | undefined;
    try {
      if (inviteId) {
        const row = await this.db.qOne<{id: string}>(
          `UPDATE public.users
              SET password_hash=$2, password_set_at=now(), invite_expires_at=NULL,
                  display_name=COALESCE(NULLIF(display_name, ''), $3),
                  email_verified_at=now(), phone_verified_at=now(),
                  kyc_status=CASE WHEN kyc_status='pending' THEN 'approved' ELSE kyc_status END
            WHERE id=$1 AND password_hash IS NULL AND invited_at IS NOT NULL AND deleted_at IS NULL
            RETURNING id`,
          [inviteId, p.pwHash, p.displayName]);
        userId = row?.id;
      } else {
        const row = await this.db.qOne<{id: string}>(
          `INSERT INTO public.users
             (id, email, phone_e164, display_name, role, subscription_tier, password_hash, password_set_at,
              kyc_status, email_verified_at, phone_verified_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'individual', 'lite', $4, now(), 'approved', now(), now())
           RETURNING id`,
          [p.email, p.phone, p.displayName, p.pwHash]);
        userId = row?.id;
      }
    } catch (e) {
      if ((e as {code?: string})?.code !== '23505') throw e;
    }
    if (!userId) {
      await this.audit.emit({event_type: 'auth.register', user_id: null, device_id: null, ip, outcome: 'failure', detail: 'hub_already_exists'});
      throw new ConflictException({error: 'already_exists', message: 'An account already uses this phone number or email. Sign in instead.'});
    }
    const user = await this.db.qOne<UserRow>(
      `SELECT id,email,display_name,role,subscription_tier,phone_e164 FROM public.users WHERE id=$1`, [userId]);
    await this.audit.emit({event_type: 'auth.register', user_id: userId, device_id: null, ip, outcome: 'success',
      detail: inviteId ? 'hub_invite_claimed' : 'hub_registered'});
    return {done: true, user: user!};
  }
}
