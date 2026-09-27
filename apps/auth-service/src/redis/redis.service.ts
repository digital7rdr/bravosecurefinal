import {Injectable, OnModuleInit, OnModuleDestroy, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import Redis from 'ioredis';

const JTI_PREFIX = 'jti:';
// Cross-service tombstone read by messenger-service's push-token GC. Its
// presence means "this device's session was genuinely revoked — reap its
// push token." Set ONLY on real revokes (logout / password-change /
// session-delete / single-device takeover), NEVER on access-token refresh
// rotation. TTL matches messenger's 90-day push-token TTL so the signal
// outlives any GC downtime; the GC deletes it once consumed.
const PUSH_REVOKE_PREFIX = 'push-revoke:';
// Contract with messenger-service push GC (50k audit P0-4): every tombstone
// write also SADDs `${userId}:${deviceId}` here so the GC never SCANs the
// whole keyspace. The GC owns member removal.
const PUSH_REVOKE_INDEX_KEY = 'push-revoke:index';
const PUSH_REVOKE_TTL_SECONDS = 90 * 24 * 3600;

/** A server-held OTP: `h` = HMAC of (destination, code). Never the code itself. */
export interface OtpCodeRecord {
  h: string;
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  client!: Redis;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    this.client = new Redis(this.config.get<string>('redisUrl')!, {
      lazyConnect:          true,
      maxRetriesPerRequest: 3,
      enableReadyCheck:     true,
    });
    this.client.on('error', (err: Error) => this.logger.error('Redis error', err.message));
    await this.client.connect();
    this.logger.log('Redis connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  // ── jti allowlist ────────────────────────────────────────────────────────
  async storeJti(jti: string, ttlSeconds: number): Promise<void> {
    await this.client.set(`${JTI_PREFIX}${jti}`, '1', 'EX', ttlSeconds);
  }

  async revokeJti(jti: string): Promise<void> {
    await this.client.del(`${JTI_PREFIX}${jti}`);
  }

  async revokeJtis(jtis: string[]): Promise<void> {
    if (!jtis.length) return;
    await this.client.del(jtis.map(j => `${JTI_PREFIX}${j}`));
  }

  async isJtiValid(jti: string): Promise<boolean> {
    return (await this.client.exists(`${JTI_PREFIX}${jti}`)) === 1;
  }

  // ── push-token revoke tombstone (consumed by messenger-service GC) ────────
  // Why: the previous push-token GC keyed liveness off the 15-min access-token
  // jti, so a KILLED app (which never refreshes) had its FCM/APNs token reaped
  // ~15 min after going quiet — silently killing all background notifications.
  // We now mark a tombstone only on a genuine session revoke; the GC reaps the
  // token on tombstone presence and leaves natural access-token expiry alone.
  async markPushRevoked(userId: string, deviceId: string): Promise<void> {
    const pipe = this.client.pipeline();
    pipe.set(`${PUSH_REVOKE_PREFIX}${userId}:${deviceId}`, '1', 'EX', PUSH_REVOKE_TTL_SECONDS);
    // Why: messenger's GC iterates this index (SMEMBERS) instead of a
    // full-keyspace SCAN (50k audit P0-4). Member format = the tombstone
    // key's tail; the GC SREMs consumed members.
    pipe.sadd(PUSH_REVOKE_INDEX_KEY, `${userId}:${deviceId}`);
    await pipe.exec();
  }

  async markPushRevokedMany(pairs: {userId: string; deviceId: string}[]): Promise<void> {
    if (!pairs.length) return;
    const pipe = this.client.pipeline();
    for (const {userId, deviceId} of pairs) {
      pipe.set(`${PUSH_REVOKE_PREFIX}${userId}:${deviceId}`, '1', 'EX', PUSH_REVOKE_TTL_SECONDS);
    }
    pipe.sadd(PUSH_REVOKE_INDEX_KEY, ...pairs.map(p => `${p.userId}:${p.deviceId}`));
    await pipe.exec();
  }

  // Cleared on every login/refresh (issueSession) so a device that was revoked
  // and then signs back in re-arms its push token instead of being re-reaped.
  async clearPushRevoked(userId: string, deviceId: string): Promise<void> {
    const pipe = this.client.pipeline();
    pipe.del(`${PUSH_REVOKE_PREFIX}${userId}:${deviceId}`);
    pipe.srem(PUSH_REVOKE_INDEX_KEY, `${userId}:${deviceId}`);
    await pipe.exec();
  }

  // ── Generic helpers used by biometric action tokens ─────────────────────
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  async getAndDel(key: string): Promise<string | null> {
    const val = await this.client.get(key);
    if (val !== null) await this.client.del(key);
    return val;
  }

  // ── P0-V2 — per-userId TOTP attempt counter / lockout ────────────────────
  // RFC 6238 §5.2 mandates throttling the verifier. The /auth/totp/verify
  // endpoint is unauthenticated by design (the TOTP code IS the second
  // factor), so per-account throttling — not per-IP — is the only effective
  // gate against a credential-stuffing botnet across residential proxies.
  // Window: 10 attempts → lock for 15 min. Mirrors the login-lockout
  // pattern described in audit Round 5 P0-A2.
  private static readonly TOTP_FAIL_PREFIX = 'totp-fail:';
  private static readonly TOTP_LOCK_PREFIX = 'totp-lock:';
  private static readonly TOTP_USED_PREFIX = 'totp-used:';
  private static readonly OTP_SEND_PREFIX  = 'otp-send:';

  async incrTotpFailures(userId: string, windowSeconds = 900): Promise<number> {
    const key = `${RedisService.TOTP_FAIL_PREFIX}${userId}`;
    const n = await this.client.incr(key);
    if (n === 1) await this.client.expire(key, windowSeconds);
    return n;
  }

  /**
   * Audit Rev2 API-01 — per-DESTINATION OTP-send counter. The IP throttler
   * cannot see number rotation (a fresh IP + fresh number per request lands in
   * a new bucket every time and walks past both our limit and Twilio's own
   * per-destination abuse guard). This counts sends to a single phone/email so a
   * flood at ONE victim number is capped regardless of source IP. Keyed on the
   * already-normalized destination; sliding hourly window. Returns the running
   * count so the caller can reject past its ceiling.
   */
  async incrOtpSends(destination: string, windowSeconds = 3600): Promise<number> {
    const key = `${RedisService.OTP_SEND_PREFIX}${destination}`;
    const n = await this.client.incr(key);
    if (n === 1) await this.client.expire(key, windowSeconds);
    return n;
  }

  // ── server-held OTP codes (Twilio SMS mode, 2026-09-28) ─────────────────────
  // Twilio Verify keeps the code on Twilio's side. In SMS mode Twilio only
  // delivers, so the server holds the code: a keyed hash (never the code) under
  // the normalized destination, one live code per destination, TTL = OTP TTL.
  private static readonly OTP_CODE_PREFIX  = 'otp-code:';
  private static readonly OTP_CHECK_PREFIX = 'otp-chk:';

  /** Replace any live code for this destination and reset its check budget. */
  async storeOtpCode(destination: string, record: OtpCodeRecord, ttlSeconds: number): Promise<void> {
    await this.client.set(`${RedisService.OTP_CODE_PREFIX}${destination}`, JSON.stringify(record), 'EX', ttlSeconds);
    await this.client.del(`${RedisService.OTP_CHECK_PREFIX}${destination}`);
  }

  async getOtpCode(destination: string): Promise<OtpCodeRecord | null> {
    const raw = await this.client.get(`${RedisService.OTP_CODE_PREFIX}${destination}`);
    if (!raw) return null;
    try {
      const rec = JSON.parse(raw) as OtpCodeRecord;
      return typeof rec?.h === 'string' ? rec : null;
    } catch {
      return null;
    }
  }

  /** Counts checks against the live code; expires with it. */
  async incrOtpChecks(destination: string, ttlSeconds: number): Promise<number> {
    const key = `${RedisService.OTP_CHECK_PREFIX}${destination}`;
    const n = await this.client.incr(key);
    if (n === 1) await this.client.expire(key, ttlSeconds);
    return n;
  }

  /**
   * Single-use claim: only the caller whose DEL actually removed the code wins,
   * so two concurrent requests carrying the right code cannot both succeed.
   */
  async consumeOtpCode(destination: string): Promise<boolean> {
    const removed = await this.client.del(`${RedisService.OTP_CODE_PREFIX}${destination}`);
    await this.client.del(`${RedisService.OTP_CHECK_PREFIX}${destination}`);
    return removed === 1;
  }

  async clearOtpCode(destination: string): Promise<void> {
    await this.client.del(
      `${RedisService.OTP_CODE_PREFIX}${destination}`,
      `${RedisService.OTP_CHECK_PREFIX}${destination}`,
    );
  }


  async clearTotpFailures(userId: string): Promise<void> {
    await this.client.del(`${RedisService.TOTP_FAIL_PREFIX}${userId}`);
  }

  /**
   * Audit Rev2 SEC-02 — RFC 6238 §5.2: a TOTP code that has already been
   * accepted must be rejected. Claims one (user, 30s-step) pair exactly once.
   * Returns true when THIS call won the claim, false when the step was
   * already spent (i.e. a replay).
   *
   * `SET NX` makes the claim atomic, so two requests carrying the same code
   * at the same instant cannot both succeed — a plain GET-then-SET would let
   * both through, which is the whole failure mode being closed.
   *
   * TTL 150s, not 90s: window:1 spans three 30s steps, and 90s is the exact
   * floor rather than a margin — a claim must not expire while the code that
   * created it is still inside its own validity window.
   */
  async claimTotpCounter(userId: string, counter: number, ttlSeconds = 150): Promise<boolean> {
    const res = await this.client.set(
      `${RedisService.TOTP_USED_PREFIX}${userId}:${counter}`, '1', 'EX', ttlSeconds, 'NX',
    );
    return res === 'OK';
  }

  async lockTotp(userId: string, lockSeconds = 900): Promise<void> {
    await this.client.set(`${RedisService.TOTP_LOCK_PREFIX}${userId}`, '1', 'EX', lockSeconds);
  }

  async isTotpLocked(userId: string): Promise<boolean> {
    return (await this.client.exists(`${RedisService.TOTP_LOCK_PREFIX}${userId}`)) === 1;
  }

  // ── B-696 — per-userId vault-PIN attempt counter / lockout ──────────────
  // Same shape as the TOTP block above (audit P0-V2 lineage): per-account,
  // not per-IP, because the endpoints are JWT-authed but a stolen access
  // token must not buy an online brute-force of a 4-8 digit PIN. One family
  // of keys covers verify, replace-with-currentPin AND the reset flow's
  // password check — an attacker probing any of the three burns the same
  // budget. Window: 10 failures → lock 15 min; success clears.
  private static readonly VAULT_PIN_FAIL_PREFIX = 'vaultpin-fail:';
  private static readonly VAULT_PIN_LOCK_PREFIX = 'vaultpin-lock:';

  async incrVaultPinFailures(userId: string, windowSeconds = 900): Promise<number> {
    const key = `${RedisService.VAULT_PIN_FAIL_PREFIX}${userId}`;
    const n = await this.client.incr(key);
    if (n === 1) await this.client.expire(key, windowSeconds);
    return n;
  }

  async clearVaultPinFailures(userId: string): Promise<void> {
    await this.client.del(`${RedisService.VAULT_PIN_FAIL_PREFIX}${userId}`);
  }

  async lockVaultPin(userId: string, lockSeconds = 900): Promise<void> {
    await this.client.set(`${RedisService.VAULT_PIN_LOCK_PREFIX}${userId}`, '1', 'EX', lockSeconds);
  }

  async isVaultPinLocked(userId: string): Promise<boolean> {
    return (await this.client.exists(`${RedisService.VAULT_PIN_LOCK_PREFIX}${userId}`)) === 1;
  }
}
