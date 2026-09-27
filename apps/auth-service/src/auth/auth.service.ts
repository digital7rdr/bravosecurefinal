import {Injectable, ConflictException, UnauthorizedException, NotFoundException, BadRequestException, HttpException, HttpStatus} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {RedisService}    from '../redis/redis.service';
import {AuditService}    from '../kafka/audit.service';
import {PasswordService} from '../common/services/password.service';
import {OtpService}      from '../common/services/otp.service';
import {JwtService}      from './jwt.service';
import {resolveAccountKind, resolveIsOrgManager, resolveManagerContext} from './account-kind';
import {IDENTITY_FACTS_UNKNOWN, resolveIdentityDocument} from '../identity/identityGate';
import type {RegisterDto}       from './dto/register.dto';
import type {RegisterVerifyDto} from './dto/register-verify.dto';
import type {LoginDto}          from './dto/login.dto';
import type {VerifyDto}         from './dto/verify.dto';
import type {RefreshDto}        from './dto/refresh.dto';
import {normalizeDeviceIdentity, type DeviceIdentity} from './dto/device-identity.dto';
import type {SessionDeleteDto}  from './dto/session-delete.dto';

export interface UserRow {
  id: string; email: string; display_name: string;
  role: string; subscription_tier: string; phone_e164: string | null;
  pro_active_until?: string | null;
  pro_renew_status?: string | null;
  avatar_url?: string | null;
}

export interface SessionResult {
  accessToken:  string;
  refreshToken: string;
  expiresIn:    number;
  // Per-device Signal protocol device id (server-assigned, persisted in
  // auth_devices). The client needs the real value for multi-device Signal
  // addressing; it falls back to 1 only when this is absent.
  signalDeviceId: number;
}

/** Audit fix #9 — `refresh()` returns the originating device's platform
 *  so the controller can decide whether to re-set the httpOnly cookie
 *  (web only). Other callers ignore the field. */
export interface RefreshResult extends SessionResult {
  platform: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db:       DatabaseService,
    private readonly redis:    RedisService,
    private readonly audit:    AuditService,
    private readonly password: PasswordService,
    private readonly otp:      OtpService,
    private readonly jwt:      JwtService,
    private readonly config:   ConfigService,
  ) {}

  // ── Shared: create access + refresh tokens for a verified device ─────────
  async issueSession(
    user: UserRow,
    deviceId: string,
    platform: string,
    // Single-device enforcement. When true (a fresh LOGIN, not a refresh)
    // every OTHER device of the same platform for this user is evicted.
    // The mobile app is single-device by design; without this the same
    // account signed in on two phones fights over the one WS slot
    // (single-device-takeover churn) — the connection flaps and calls fail
    // with "transport not open". Scoped to `platform` so a mobile login
    // never logs out a web/ops-console session.
    evictOtherDevices = false,
    // B-794 — client-reported device identity. Only the two session-CREATING
    // paths (verify, registerVerify) have it; refresh() passes nothing, and the
    // upsert below COALESCEs so a refresh can never blank a captured name.
    identity?: DeviceIdentity,
  ): Promise<SessionResult> {
    const {token: refreshToken, hash: refreshHash} = this.jwt.newRefreshToken();
    const refreshTtl     = this.config.get<string>('jwt.refreshTtl') ?? '30d';
    const refreshExpires = new Date(Date.now() + this.jwt.ttlToSeconds(refreshTtl) * 1000);
    const accessTtlSec   = this.jwt.ttlToSeconds(this.config.get<string>('jwt.accessTtl') ?? '15m');

    const prev = await this.db.qOne<{current_jti: string | null; signal_device_id: number | null}>(
      `SELECT current_jti, signal_device_id FROM auth_devices WHERE user_id = $1 AND device_id = $2`,
      [user.id, deviceId],
    );
    // signal_device_id — per-user sequential device number. The Supabase
    // auth_devices.signal_device_id column is NOT NULL, so every insert must
    // carry one: reuse the device's existing id, else allocate MAX+1. (Ported
    // from the deployed image's compiled hotfix, which previously lived only in
    // /app/dist and not in any source tree.)
    let signalDeviceId = Number(prev?.signal_device_id ?? 0);
    if (!signalDeviceId) {
      const next = await this.db.qOne<{next: number}>(
        `SELECT COALESCE(MAX(signal_device_id),0)+1 AS next FROM auth_devices WHERE user_id=$1`,
        [user.id],
      );
      signalDeviceId = Number(next?.next ?? 1);
    }
    const {accessToken, jti} = await this.jwt.signAccessToken({sub: user.id, deviceId, role: user.role});
    if (prev?.current_jti) await this.redis.revokeJti(prev.current_jti);
    await this.redis.storeJti(jti, accessTtlSec);

    // COALESCE(EXCLUDED, existing) — NOT a bare assignment. issueSession runs on
    // every refresh too, and refresh() has no identity to report; assigning
    // straight from EXCLUDED would wipe the model/brand/OS captured at login
    // within fifteen minutes of it being stored.
    const dev = normalizeDeviceIdentity(identity);
    await this.db.q(
      `INSERT INTO auth_devices
         (user_id, device_id, platform, refresh_token_hash, expires_at, current_jti, signal_device_id,
          device_model, device_brand, os_version, app_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (user_id, device_id) DO UPDATE
       SET refresh_token_hash=$4, platform=$3, expires_at=$5,
           current_jti=$6, revoked_at=NULL, last_used_at=now(),
           device_model = COALESCE(EXCLUDED.device_model, auth_devices.device_model),
           device_brand = COALESCE(EXCLUDED.device_brand, auth_devices.device_brand),
           os_version   = COALESCE(EXCLUDED.os_version,   auth_devices.os_version),
           app_version  = COALESCE(EXCLUDED.app_version,  auth_devices.app_version)`,
      [user.id, deviceId, platform, refreshHash, refreshExpires, jti, signalDeviceId,
       dev.model, dev.brand, dev.os, dev.app],
    );

    // This device is (re)authenticated — clear any push-revoke tombstone so a
    // previously-revoked device re-arms its background push token on next
    // /push/register instead of being reaped by the messenger-service GC.
    await this.redis.clearPushRevoked(user.id, deviceId);

    // Single-device takeover — evict the user's OTHER same-platform devices
    // so the just-logged-in device is the only live session. Revoke each
    // other device's access jti (the gateway's revoked-socket sweep then
    // disconnects its live WS) and mark its row revoked so it can no longer
    // refresh. Best-effort + post-commit: a failure here must not fail the
    // login the user just completed.
    //
    // Why the `platform !== 'web'` guard (B-71): takeover is a MOBILE concern
    // — one WS slot per account, so two phones must not fight over it. The
    // ops-console (platform 'web') is legitimately multi-tab / multi-browser;
    // force-evicting the account's OTHER web devices on every login made two
    // ops sessions mutually revoke each other, so `/ops/me` returned
    // `token_revoked` seconds after a clean login and the client stormed into
    // an infinite /dashboard⇄/login loop. Web session termination stays driven
    // by explicit logout (DELETE /auth/session) and refresh-token rotation —
    // both unchanged. See docs/architecture/AUTH_COMPLIANCE.md (no single-web
    // requirement is documented; this only removes an unintended side-effect).
    if (evictOtherDevices && platform !== 'web') {
      try {
        const others = await this.db.q<{current_jti: string | null; device_id: string}>(
          `SELECT current_jti, device_id FROM auth_devices
             WHERE user_id=$1 AND device_id<>$2 AND platform=$3 AND revoked_at IS NULL`,
          [user.id, deviceId, platform],
        );
        for (const o of others) {
          if (o.current_jti) {
            try { await this.redis.revokeJti(o.current_jti); } catch { /* best-effort */ }
          }
        }
        await this.db.q(
          `UPDATE auth_devices SET revoked_at=now(), current_jti=NULL
             WHERE user_id=$1 AND device_id<>$2 AND platform=$3 AND revoked_at IS NULL`,
          [user.id, deviceId, platform],
        );
        // Cascade the eviction to push-token cleanup so each evicted device's
        // (possibly killed) app stops receiving this account's wake stream.
        await this.redis.markPushRevokedMany(
          others.map(o => ({userId: user.id, deviceId: o.device_id})),
        );
      } catch { /* never fail a completed login on takeover cleanup */ }
    }

    return {accessToken, refreshToken, expiresIn: accessTtlSec, signalDeviceId};
  }

  // ── register (step 1: dup-check + send OTP only — NO user row created) ────
  async register(dto: RegisterDto, ip: string) {
    const existing = await this.db.qOne(
      `SELECT id FROM public.users WHERE (email=$1 OR phone_e164=$2) AND deleted_at IS NULL`,
      [dto.email, dto.phoneE164],
    );
    // 2026-09-27 — an admin-created SMS invite for THIS phone is not a conflict:
    // the OTP below proves the phone and registerVerify claims the row.
    if (existing && !(await this.claimableInvite(dto.email, dto.phoneE164))) {
      await this.audit.emit({event_type:'auth.register', user_id:null, device_id:null, ip, outcome:'failure', detail:'already_exists'});
      throw new ConflictException('already_exists');
    }

    try {
      await this.otp.send(dto.phoneE164, '');
    } catch (err) {
      // Surface Twilio rate-limit (60203: "Max send attempts reached") as 429
      const twilioErr = err as {code?: number; status?: number; message?: string};
      if (twilioErr?.code === 60203 || twilioErr?.status === 429) {
        await this.audit.emit({event_type:'auth.register', user_id:null, device_id:null, ip, outcome:'failure', detail:'otp_rate_limited'});
        throw new HttpException(
          {error: 'otp_rate_limited', message: 'Too many OTP requests to this number. Wait ~10 minutes and try again.'},
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (twilioErr?.code === 60410) {
        await this.audit.emit({event_type:'auth.register', user_id:null, device_id:null, ip, outcome:'failure', detail:'otp_number_blocked'});
        throw new HttpException(
          {error: 'otp_number_blocked', message: 'This phone number or region is temporarily blocked by the SMS provider. Try a different number.'},
          HttpStatus.FORBIDDEN,
        );
      }
      if (twilioErr?.code === 21608) {
        await this.audit.emit({event_type:'auth.register', user_id:null, device_id:null, ip, outcome:'failure', detail:'otp_unverified_number'});
        throw new HttpException(
          {error: 'otp_unverified_number', message: 'This phone number is not authorized to receive OTPs. Use a Twilio-verified number (trial account).'},
          HttpStatus.FORBIDDEN,
        );
      }
      console.error('[register] Twilio send failed:', err);
      throw err;
    }

    await this.audit.emit({event_type:'auth.register', user_id:null, device_id:null, ip, outcome:'success', detail:'otp_sent'});
    return {otpSentTo: dto.phoneE164};
  }

  // ── register (step 2: Twilio approves → create user + issue session) ──────
  async registerVerify(dto: RegisterVerifyDto, ip: string) {
    const approved = await this.otp.check(dto.phoneE164, dto.code);
    if (!approved) {
      await this.audit.emit({event_type:'auth.register', user_id:null, device_id:dto.deviceId, ip, outcome:'failure', detail:'otp_invalid'});
      throw new BadRequestException('otp_invalid');
    }

    // Auth audit P0-A6 (partial) — fix SQL operator precedence. The
    // previous WHERE bound as `email=$1 OR (phone_e164=$2 AND
    // deleted_at IS NULL)` because `AND` is tighter than `OR`, so a
    // soft-deleted account matching by EMAIL slipped past the
    // existence check and the INSERT then failed with a unique-key
    // violation downstream. Parentheses make the intent explicit:
    // either column matches AND the row is not soft-deleted. The
    // companion "uniform 200 to deny the enumeration oracle" fix is
    // multi-day and tracked separately.
    const existing = await this.db.qOne(
      `SELECT id FROM public.users WHERE (email=$1 OR phone_e164=$2) AND deleted_at IS NULL`,
      [dto.email, dto.phoneE164],
    );
    const inviteId = existing ? await this.claimableInvite(dto.email, dto.phoneE164) : null;
    if (existing && !inviteId) {
      await this.audit.emit({event_type:'auth.register', user_id:null, device_id:dto.deviceId, ip, outcome:'failure', detail:'already_exists'});
      throw new ConflictException('already_exists');
    }

    // DTO audit P0-V1 — server-controlled defaults. The DTO no longer
    // carries `role` or `subscriptionTier`; the registration surface
    // is unauthenticated so any client-supplied value is untrusted.
    // Role transitions (→ 'agent') happen via the agent-onboarding
    // flow and ops approval; Pro upgrades via the wallet path.
    const role = 'individual';
    const tier = 'lite';
    const pwHash = await this.password.hash(dto.password);
    let newUserId: string;
    if (inviteId) {
      // CLAIM the admin-created invite: the person sets their own password; the
      // admin-assigned role / tier / agency membership stay as provisioned. The
      // WHERE re-checks "still unclaimed" so two racing claims cannot both win.
      const claimed = await this.db.qOne<{id: string}>(
        `UPDATE public.users
            SET password_hash = $2, password_set_at = now(), invite_expires_at = NULL,
                display_name = COALESCE(NULLIF(display_name, ''), $3)
          WHERE id = $1 AND password_hash IS NULL AND invited_at IS NOT NULL AND deleted_at IS NULL
          RETURNING id`,
        [inviteId, pwHash, dto.displayName],
      );
      if (!claimed) {
        await this.audit.emit({event_type:'auth.register', user_id:null, device_id:dto.deviceId, ip, outcome:'failure', detail:'already_exists'});
        throw new ConflictException('already_exists');
      }
      newUserId = claimed.id;
    } else {
      const [inserted] = await this.db.q<{id:string}>(
        `INSERT INTO public.users
           (id,email,phone_e164,display_name,role,subscription_tier,password_hash,kyc_status)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,'approved') RETURNING id`,
        [dto.email, dto.phoneE164, dto.displayName, role, tier, pwHash],
      );
      newUserId = inserted.id;
    }

    const user = await this.db.qOne<UserRow>(
      `SELECT id,email,display_name,role,subscription_tier,phone_e164 FROM public.users WHERE id=$1`,
      [newUserId],
    );
    if (!user) throw new NotFoundException('user_not_found');

    const session = await this.issueSession(user, dto.deviceId, dto.platform, false, dto);
    await this.audit.emit({event_type:'auth.register', user_id:user.id, device_id:dto.deviceId, ip, outcome:'success',
      ...(inviteId ? {detail: 'invite_claimed'} : {})});
    return {user, ...session};
  }

  /**
   * 2026-09-27 — admin-created SMS invites. Returns the invite row id when THIS
   * phone has a claimable invite (created by ops, no password yet, not expired,
   * not suspended) AND nothing else matches the email or phone. Any other match
   * stays the existing already_exists conflict. Defensive on the result shape:
   * a caller that got no rows (or a bare mock) simply has no invite.
   */
  private async claimableInvite(email: string, phone: string): Promise<string | null> {
    const rows = await this.db.q<{id: string; phone_e164: string | null; claimable: boolean}>(
      `SELECT id, phone_e164,
              (invited_at IS NOT NULL AND password_hash IS NULL AND suspended_at IS NULL
                 AND invite_expires_at > now()) AS claimable
         FROM public.users
        WHERE (email = $1 OR phone_e164 = $2) AND deleted_at IS NULL`,
      [email, phone],
    );
    if (!Array.isArray(rows)) {return null;}
    const invite = rows.find(r => r.claimable && r.phone_e164 === phone);
    if (!invite) {return null;}
    return rows.every(r => r.id === invite.id) ? invite.id : null;
  }

  // ── login (no account enumeration — always 200) ───────────────────────────
  async login(dto: LoginDto, ip: string) {
    if (!dto.email && !dto.phoneE164) throw new BadRequestException('email_or_phone_required');

    const user = await this.db.qOne<UserRow & {password_hash: string | null}>(
      dto.email
        ? `SELECT id,email,display_name,role,subscription_tier,phone_e164,password_hash FROM public.users WHERE email=$1 AND deleted_at IS NULL AND suspended_at IS NULL`
        : `SELECT id,email,display_name,role,subscription_tier,phone_e164,password_hash FROM public.users WHERE phone_e164=$1 AND deleted_at IS NULL AND suspended_at IS NULL`,
      [dto.email ?? dto.phoneE164!],
    );

    const ok = user?.password_hash ? await this.password.verify(user.password_hash, dto.password) : false;
    if (!ok) {
      await this.audit.emit({event_type:'auth.login', user_id:user?.id??null, device_id:null, ip, outcome:'failure', detail:'invalid_credentials'});
      // Same response shape whether account exists or not — prevent enumeration.
      return {userId: null, otpSentTo: null, devOtpCode: null};
    }

    // Twilio Verify owns the OTP code; local row only tracks attempt_count/expiry.
    const expiresAt = new Date(Date.now() + (this.config.get<number>('otp.ttlMinutes') ?? 10) * 60_000);
    await this.db.q(
      `INSERT INTO auth_otps (user_id,channel,code_hash,expires_at) VALUES ($1,'phone',$2,$3)`,
      [user!.id, 'TWILIO_VERIFY', expiresAt],
    );
    await this.otp.send(user!.phone_e164 ?? user!.email, '');

    // LB-OTP3 — in OTP_DEV_BYPASS mode `check()` accepts ANY code, but the client
    // never learns that, so a QA device whose number Twilio can't reach was stuck
    // on a code that never arrives. Return a throwaway code so the client's
    // existing auto-verify (LoginScreen) fires and skips the OTP screen. Gated on
    // `otp.devBypass`, which `configuration.ts` forces FALSE in production even if
    // the env var is mistakenly set — the code is NEVER returned to a real client.
    const devOtpCode = this.config.get<boolean>('otp.devBypass') ? this.otp.generate() : null;

    await this.audit.emit({event_type:'auth.login', user_id:user!.id, device_id:null, ip, outcome:'success'});
    return {userId: user!.id, otpSentTo: user!.phone_e164 ?? user!.email, devOtpCode};
  }

  // ── verify OTP → tokens ───────────────────────────────────────────────────
  async verify(dto: VerifyDto, ip: string) {
    const user = await this.db.qOne<UserRow>(
      `SELECT id,email,display_name,role,subscription_tier,phone_e164 FROM public.users WHERE id=$1 AND deleted_at IS NULL AND suspended_at IS NULL`,
      [dto.userId],
    );
    if (!user) throw new NotFoundException('user_not_found');
    if (!user.phone_e164) throw new BadRequestException('user_has_no_phone');

    const maxAttempts = this.config.get<number>('otp.maxAttempts') ?? 3;
    const otp = await this.db.qOne<{
      id:string; expires_at:Date; used_at:Date|null; attempt_count:number;
    }>(
      `SELECT id,expires_at,used_at,attempt_count FROM auth_otps WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [dto.userId],
    );

    if (!otp)                              throw new BadRequestException('no_pending_otp');
    if (otp.used_at)                       throw new BadRequestException('otp_already_used');
    if (new Date(otp.expires_at) < new Date()) throw new BadRequestException('otp_expired');
    if (otp.attempt_count >= maxAttempts)  throw new BadRequestException('otp_max_attempts');

    const approved = await this.otp.check(user.phone_e164, dto.code);
    if (!approved) {
      const next = otp.attempt_count + 1;
      if (next >= maxAttempts) {
        await this.db.q(`UPDATE auth_otps SET attempt_count=$1,used_at=now() WHERE id=$2`, [next, otp.id]);
        await this.audit.emit({event_type:'auth.verify', user_id:dto.userId, device_id:dto.deviceId, ip, outcome:'failure', detail:'otp_max_attempts_reached'});
        throw new BadRequestException('otp_max_attempts');
      }
      await this.db.q(`UPDATE auth_otps SET attempt_count=$1 WHERE id=$2`, [next, otp.id]);
      await this.audit.emit({event_type:'auth.verify', user_id:dto.userId, device_id:dto.deviceId, ip, outcome:'failure', detail:'otp_invalid'});
      throw new BadRequestException({error:'otp_invalid', attemptsLeft: maxAttempts - next});
    }

    await this.db.q(`UPDATE auth_otps SET used_at=now() WHERE id=$1`, [otp.id]);
    await this.db.q(`UPDATE public.users SET kyc_status='approved' WHERE id=$1 AND kyc_status='pending'`, [dto.userId]);

    // evictOtherDevices=true — a fresh OTP login takes over as the single
    // active device for this platform (logs out any other phone signed into
    // this account). refresh() deliberately passes the default (false).
    const session = await this.issueSession(user, dto.deviceId, dto.platform, true, dto);
    await this.audit.emit({event_type:'auth.verify', user_id:dto.userId, device_id:dto.deviceId, ip, outcome:'success'});
    return {user, ...session};
  }

  // ── refresh token rotation ────────────────────────────────────────────────
  async refresh(dto: RefreshDto, ip: string): Promise<RefreshResult> {
    const hash   = this.jwt.refreshTokenHash(dto.refreshToken);
    const device = await this.db.qOne<{
      user_id:string; device_id:string; platform:string; expires_at:Date; revoked_at:Date|null;
    }>(
      `SELECT user_id,device_id,platform,expires_at,revoked_at FROM auth_devices WHERE refresh_token_hash=$1`,
      [hash],
    );
    if (!device)           throw new UnauthorizedException('invalid_refresh');
    if (device.revoked_at) throw new UnauthorizedException('revoked');
    if (new Date(device.expires_at) < new Date()) throw new UnauthorizedException('expired');

    const user = await this.db.qOne<UserRow>(
      `SELECT id,email,display_name,role,subscription_tier,phone_e164 FROM public.users WHERE id=$1 AND deleted_at IS NULL AND suspended_at IS NULL`,
      [device.user_id],
    );
    if (!user) throw new NotFoundException('user_not_found');

    const session = await this.issueSession(user, device.device_id, device.platform);
    await this.audit.emit({event_type:'auth.refresh', user_id:device.user_id, device_id:device.device_id, ip, outcome:'success'});
    // Audit fix 0.4 — surface the device's platform so the controller can
    // re-set httpOnly cookies for browser sessions on refresh.
    return {...session, platform: device.platform};
  }

  // ── me ────────────────────────────────────────────────────────────────────
  async getMe(userId: string) {
    const user = await this.db.qOne<UserRow>(
      `SELECT id,email,display_name,role,subscription_tier,phone_e164,pro_active_until,pro_renew_status,avatar_url FROM public.users WHERE id=$1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!user) throw new NotFoundException('user_not_found');
    // Server-computed app routing (§35A) — never a client flag, never a JWT
    // claim. Re-read every call so a suspended CPO flips to "access ended" on
    // the next /auth/me without needing a new token.
    //
    // is_org_manager mirrors OrgManagerGuard (company agent OR active manager
    // membership) — resolved independently of account_kind so a manager who is
    // also a CPO elsewhere (account_kind='cpo') still routes to the manager UI.
    // `managed_org` (null unless a DELEGATED manager) + the modules its owner
    // granted them; account_kind cannot serve that role because a promoted CPO
    // keeps account_kind='cpo' by ACCOUNT_KIND_SQL's deliberate cpo precedence.
    //
    // The four resolvers are independent reads — run them in one round-trip
    // wave instead of sequentially (/auth/me fires on every cold start and
    // foreground; 5 serial queries was the measured hot spot at 50k users).
    const [accountKind, is_org_manager, {managed_org, permitted_modules}, auto_dispatch_enabled, identityDoc] =
      await Promise.all([
        resolveAccountKind(this.db, userId),
        resolveIsOrgManager(this.db, userId),
        resolveManagerContext(this.db, userId),
        this.resolveAutoDispatchEnabled(),
        // B-867 — the same existence read the booking gate makes, so the app
        // and the server can never disagree on whether a booking may start.
        // Best-effort HERE only: an unreachable table must not make every cold
        // start 500 (the app is then fail-open; the booking gate stays hard).
        resolveIdentityDocument(this.db, userId).catch(() => IDENTITY_FACTS_UNKNOWN),
      ]);
    // OP-10 — server-driven Dept Chat v2 flag (the client's EXPO_PUBLIC copy is
    // the fail-open fallback for an older server). Same posture as auto_dispatch.
    const dept_chat_v2_enabled = this.config.get<boolean>('featureFlags.deptChatV2') ?? false;
    return {
      user, ...accountKind, is_org_manager, managed_org, permitted_modules, auto_dispatch_enabled, dept_chat_v2_enabled,
      identity_document_status: identityDoc.status,
      identity_document_required: identityDoc.required,
    };
  }

  /**
   * Server-driven mirror of the auto-dispatch effective state (env AND redis !== 'false'),
   * so the client picks the auto-vs-legacy booking path from /auth/me instead of a fragile
   * build-time EXPO_PUBLIC flag that bakes at Metro time and can drift from the server gate.
   * Mirrors DispatchKillswitchService WITHOUT importing OpsModule (OpsModule imports AuthModule
   * → cycle). Fail-CLOSED to the env gate on any Redis error; never crashes /auth/me.
   */
  private async resolveAutoDispatchEnabled(): Promise<boolean> {
    const envOn = this.config.get<boolean>('featureFlags.autoDispatch') ?? false;
    if (!envOn) {return false;} // dark-launch: env gate dominates, skip Redis
    try {
      const v = await this.redis.client.get('dispatch:enabled');
      return v !== 'false'; // absent/'true' → on; only an explicit 'false' kills it
    } catch {
      return envOn;
    }
  }

  /**
   * Self-service profile update (display name + avatar). Builds the SET clause
   * from only the fields the client actually sent, so one can be patched
   * without touching the other, and `avatar_url: null` clears the photo
   * (a COALESCE would make clearing impossible). Returns the fresh row in the
   * same shape as getMe.
   */
  async updateProfile(
    userId: string,
    dto: {display_name?: string; avatar_url?: string | null},
  ) {
    const sets: string[] = [];
    const params: unknown[] = [userId];
    if (dto.display_name !== undefined) {
      params.push(dto.display_name);
      sets.push(`display_name = $${params.length}`);
    }
    if (dto.avatar_url !== undefined) {
      params.push(dto.avatar_url);
      sets.push(`avatar_url = $${params.length}`);
    }
    if (sets.length === 0) {
      return this.getMe(userId);
    }
    const user = await this.db.qOne<UserRow>(
      `UPDATE public.users SET ${sets.join(', ')}
         WHERE id=$1 AND deleted_at IS NULL
         RETURNING id,email,display_name,role,subscription_tier,phone_e164,pro_active_until,pro_renew_status,avatar_url`,
      params,
    );
    if (!user) throw new NotFoundException('user_not_found');
    return {user};
  }

  /**
   * Audit P0-A5 — credential rotation.
   *
   * The user proves possession of the current password before any
   * change so a stolen access token alone can't lock the legitimate
   * user out. After the rotation:
   *   1. The new hash is persisted.
   *   2. EVERY device session for this user is revoked (JTI Redis
   *      revoke + auth_devices.revoked_at). The compromised session
   *      that motivated the rotation must not survive the rotation.
   *   3. The audit log records the rotation under
   *      `auth.password.changed` for post-incident review.
   */
  async changePassword(userId: string, dto: {currentPassword: string; newPassword: string}, ip: string) {
    const row = await this.db.qOne<{password_hash: string | null}>(
      `SELECT password_hash FROM public.users WHERE id=$1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!row) throw new NotFoundException('user_not_found');
    const ok = row.password_hash ? await this.password.verify(row.password_hash, dto.currentPassword) : false;
    if (!ok) {
      await this.audit.emit({event_type:'auth.password.change_denied', user_id:userId, device_id:null, ip, outcome:'failure', detail:'current_password_mismatch'});
      throw new UnauthorizedException('current_password_invalid');
    }
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('new_password_must_differ');
    }
    const newHash = await this.password.hash(dto.newPassword);
    await this.db.q(
      // password_set_at clears the managed-CPO temp-password flag atomically
      // with the new hash (Step 4) — no separate write to race.
      `UPDATE public.users SET password_hash=$1, password_set_at=now(), updated_at=now() WHERE id=$2`,
      [newHash, userId],
    );
    // Revoke every live session — the whole point of changing the
    // password is "kick the attacker out." Old refresh tokens stop
    // exchanging; the JTI allowlist instantly invalidates every live
    // access JWT.
    const sessions = await this.db.q<{current_jti: string | null; device_id: string}>(
      `SELECT current_jti, device_id FROM auth_devices WHERE user_id=$1 AND revoked_at IS NULL`,
      [userId],
    );
    await this.redis.revokeJtis(sessions.map(s => s.current_jti).filter((j): j is string => j !== null));
    await this.db.q(
      `UPDATE auth_devices SET revoked_at=now(),current_jti=NULL WHERE user_id=$1 AND revoked_at IS NULL`,
      [userId],
    );
    await this.redis.markPushRevokedMany(sessions.map(s => ({userId, deviceId: s.device_id})));
    await this.audit.emit({event_type:'auth.password.changed', user_id:userId, device_id:null, ip, outcome:'success', detail:`sessions_revoked=${sessions.length}`});
    return {ok: true, sessionsRevoked: sessions.length};
  }

  // ── session delete (instant-kill via Redis jti revocation) ───────────────
  async deleteSession(dto: SessionDeleteDto, userId: string, ip: string) {
    if (dto.allDevices) {
      const rows = await this.db.q<{current_jti:string|null; device_id:string}>(
        `SELECT current_jti, device_id FROM auth_devices WHERE user_id=$1 AND revoked_at IS NULL`, [userId]);
      await this.redis.revokeJtis(rows.map(r => r.current_jti).filter((j): j is string => j !== null));
      await this.db.q(`UPDATE auth_devices SET revoked_at=now(),current_jti=NULL WHERE user_id=$1 AND revoked_at IS NULL`, [userId]);
      await this.redis.markPushRevokedMany(rows.map(r => ({userId, deviceId: r.device_id})));
      await this.audit.emit({event_type:'auth.session.revoked', user_id:userId, device_id:null, ip, outcome:'success', detail:'all_devices'});
    } else {
      const row = await this.db.qOne<{current_jti:string|null}>(
        `SELECT current_jti FROM auth_devices WHERE user_id=$1 AND device_id=$2 AND revoked_at IS NULL`,
        [userId, dto.deviceId],
      );
      if (row?.current_jti) await this.redis.revokeJti(row.current_jti);
      await this.db.q(
        `UPDATE auth_devices SET revoked_at=now(),current_jti=NULL WHERE user_id=$1 AND device_id=$2 AND revoked_at IS NULL`,
        [userId, dto.deviceId],
      );
      await this.redis.markPushRevoked(userId, dto.deviceId);
      await this.audit.emit({event_type:'auth.session.revoked', user_id:userId, device_id:dto.deviceId, ip, outcome:'success', detail:'single_device'});
    }
    return {ok: true};
  }

  /**
   * RS-05 — the freshest role straight from the users row. Used when minting a
   * derived credential (e.g. the 5-min messenger ticket) so a role the DB has
   * since changed can't be re-amplified from the presented token's stale claim.
   * Throws if the user is gone / soft-deleted.
   */
  async getCurrentRole(userId: string): Promise<string> {
    const row = await this.db.qOne<{role: string}>(
      `SELECT role FROM public.users WHERE id=$1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!row) throw new NotFoundException('user_not_found');
    return row.role;
  }

  /**
   * RS-01 — revoke every live session for a user (Redis JTI allowlist +
   * auth_devices.revoked_at + push-token revoke). This is the SAME mechanism
   * changePassword / deleteSession(allDevices) use inline, exposed as a method
   * so a role downgrade or a roster mutation (OrgCpoService.setMemberStatus /
   * OpsService agent-terminate) can eject a user exactly the way the DC-04
   * admin-suspend flow does — closing the JTI-only surfaces (messenger ticket,
   * sender-cert, relay) that a per-request guard alone can't cover. Returns the
   * count of sessions revoked.
   */
  async revokeAllUserSessions(userId: string, ip = 'system'): Promise<number> {
    const sessions = await this.db.q<{current_jti: string | null; device_id: string}>(
      `SELECT current_jti, device_id FROM auth_devices WHERE user_id=$1 AND revoked_at IS NULL`,
      [userId],
    );
    await this.redis.revokeJtis(sessions.map(s => s.current_jti).filter((j): j is string => j !== null));
    await this.db.q(
      `UPDATE auth_devices SET revoked_at=now(),current_jti=NULL WHERE user_id=$1 AND revoked_at IS NULL`,
      [userId],
    );
    await this.redis.markPushRevokedMany(sessions.map(s => ({userId, deviceId: s.device_id})));
    await this.audit.emit({event_type:'auth.session.revoked', user_id:userId, device_id:null, ip, outcome:'success', detail:'membership_revoked'});
    return sessions.length;
  }
}
