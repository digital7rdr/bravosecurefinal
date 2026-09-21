import type {RedisService} from '../../redis/redis.service';

/**
 * Short-TTL Redis cache for the two per-request DB gates (CpoSessionGuard,
 * TierGuard). At 50k users these guards were the dominant DB QPS: every
 * CPO-scoped request re-ran the 6-way ACCOUNT_KIND_SQL join, and every
 * tier-gated handler a users read.
 *
 * Revocation semantics are preserved: every org_members mutation that can
 * change account_kind/membership_status calls `bustAccountGate`, and the DEL
 * is cluster-wide (shared Redis), so a suspended/removed CPO is ejected on
 * their next request exactly as before. The 30s TTL is only a backstop for a
 * missed bust. Fail-open on any Redis error — the guard falls through to the
 * DB read it always did.
 */
const TTL_SECONDS = 30;

const acctKey = (sub: string) => `acct-gate:${sub}`;
const tierKey = (sub: string) => `tier-gate:${sub}`;

export interface CachedAccountGate {
  account_kind: string;
  membership_status: string | null;
}

export interface CachedTierGate {
  subscription_tier: string;
  pro_active_until: string | null;
}

async function readJson<T>(redis: RedisService | undefined, key: string): Promise<T | null> {
  if (!redis?.client) return null;
  try {
    const raw = await redis.client.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

async function writeJson(redis: RedisService | undefined, key: string, value: unknown): Promise<void> {
  if (!redis?.client) return;
  try {
    await redis.client.set(key, JSON.stringify(value), 'EX', TTL_SECONDS);
  } catch {
    /* fail-open */
  }
}

export const readAccountGate = (redis: RedisService | undefined, sub: string) =>
  readJson<CachedAccountGate>(redis, acctKey(sub));
export const writeAccountGate = (redis: RedisService | undefined, sub: string, v: CachedAccountGate) =>
  writeJson(redis, acctKey(sub), v);

export const readTierGate = (redis: RedisService | undefined, sub: string) =>
  readJson<CachedTierGate>(redis, tierKey(sub));
export const writeTierGate = (redis: RedisService | undefined, sub: string, v: CachedTierGate) =>
  writeJson(redis, tierKey(sub), v);

/** Call after ANY write that can change a user's account_kind/membership_status. */
export async function bustAccountGate(redis: RedisService | undefined, sub: string): Promise<void> {
  if (!redis?.client) return;
  try {
    await redis.client.del(acctKey(sub));
  } catch {
    /* the 30s TTL is the backstop */
  }
}

/**
 * OP-03 — call after ANY write to `users.subscription_tier` / `pro_active_until`.
 * The tier gate shipped with the 30 s cache and NO bust: an ops comp grant or a
 * Stripe upgrade left every tier-gated endpoint answering `tier_insufficient`
 * while `/auth/me` (uncached) already reported the new tier. Same shape and
 * fail-open posture as `bustAccountGate`. Bust AFTER the transaction commits —
 * a bust inside it can be refilled with the pre-commit row by a concurrent read.
 */
export async function bustTierGate(redis: RedisService | undefined, sub: string): Promise<void> {
  if (!redis?.client) return;
  try {
    await redis.client.del(tierKey(sub));
  } catch {
    /* the 30s TTL is the backstop */
  }
}
