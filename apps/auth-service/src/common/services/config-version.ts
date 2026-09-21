import type {RedisService} from '../../redis/redis.service';

/**
 * OP-02 / OP-05 — cluster-wide invalidation for the per-pod config caches
 * (PricingService, RegionsService).
 *
 * Both services cache an ops-edited table in a per-process map with a 60 s TTL,
 * and the ops write handlers could only refresh the ONE pod that served the
 * write. With N pods, a price change was quoted old/new/old for a full minute.
 *
 * The fix is a monotonic version per config in shared Redis: every ops write
 * `bump`s it, every reader checks it with a 2 s local mirror (the killswitch
 * pattern — one Redis GET per pod per 2 s, not per request) and drops its
 * cache when the number moved. Fail-open everywhere: no Redis → the 60 s TTL
 * stays the fallback, exactly the pre-fix behaviour.
 */
export type ConfigVersionKey = 'pricing' | 'regions';

const key = (k: ConfigVersionKey) => `cfgver:${k}`;

export async function readConfigVersion(
  redis: RedisService | undefined,
  k: ConfigVersionKey,
): Promise<number | null> {
  if (!redis?.client) return null;
  try {
    const raw = await redis.client.get(key(k));
    const n = raw === null ? 0 : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Call after ANY successful ops write to the config's table. Never throws. */
export async function bumpConfigVersion(
  redis: RedisService | undefined,
  k: ConfigVersionKey,
): Promise<void> {
  if (!redis?.client) return;
  try {
    await redis.client.incr(key(k));
  } catch {
    /* the readers' TTL is the backstop */
  }
}

/**
 * The 2 s mirror a reader keeps in front of `readConfigVersion`. Returns the
 * version to compare the cache against, or null when unknowable (no Redis,
 * Redis error) — a null never invalidates, so an outage degrades to the TTL.
 */
export class ConfigVersionMirror {
  private value: number | null = null;
  private at = 0;

  constructor(
    private readonly k: ConfigVersionKey,
    private readonly ttlMs = 2_000,
  ) {}

  async current(redis: RedisService | undefined, nowMs: number = Date.now()): Promise<number | null> {
    if (this.at !== 0 && nowMs - this.at < this.ttlMs) return this.value;
    const v = await readConfigVersion(redis, this.k);
    // Stamp the attempt on failure too (review round 2): this sits on the
    // booking hot path BEFORE the in-memory TTL short-circuit, so during a
    // Redis outage an unstamped miss re-issued a failing GET per request.
    // One attempt per ttl per pod; the value degrades to the last known.
    this.at = nowMs;
    if (v !== null) this.value = v;
    return this.value;
  }
}
