import type {ThrottlerStorage} from '@nestjs/throttler';
import type {ThrottlerStorageRecord} from '@nestjs/throttler/dist/throttler-storage-record.interface';
import type {RedisService} from '../redis/redis.service';

/**
 * Scale P1-11 — cluster-wide throttle counters.
 *
 * @nestjs/throttler's default storage is an in-process Map, so every
 * `@Throttle` ceiling in this service was per-POD: at N replicas the real
 * limit on `POST /envelopes`, `/backup/*` etc. was N× the stated one, and
 * every write-amplification bound sized against those ceilings was off by
 * the replica count. This backs the counters with the shared Redis the
 * service already runs on (a fixed INCR+PEXPIRE window — the same
 * approximation the WS-side `userRateExceeded` limiter uses).
 *
 * Fail-OPEN on a Redis error: a Redis blip must degrade to "unthrottled",
 * never 500 every HTTP route (the WS limiter and the per-recipient queue
 * caps still bound abuse in that window).
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const k = `thr:${throttlerName}:${key}`;
    const bk = `${k}:blk`;
    try {
      const res = await this.redis.client.multi().incr(k).pttl(k).exec();
      const totalHits = Number(res?.[0]?.[1] ?? 1);
      let pttl = Number(res?.[1]?.[1] ?? -1);
      if (pttl < 0) {
        // First hit of a window (or a counter that lost its TTL): arm it.
        await this.redis.client.pexpire(k, ttl);
        pttl = ttl;
      }
      if (totalHits > limit) {
        const blockMs = blockDuration > 0 ? blockDuration : ttl;
        await this.redis.client.set(bk, '1', 'PX', blockMs, 'NX');
        const bttl = await this.redis.client.pttl(bk);
        return {
          totalHits,
          timeToExpire: Math.ceil(pttl / 1000),
          isBlocked: true,
          timeToBlockExpire: Math.ceil(Math.max(bttl, 0) / 1000),
        };
      }
      return {
        totalHits,
        timeToExpire: Math.ceil(pttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    } catch {
      return {
        totalHits: 1,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }
}
