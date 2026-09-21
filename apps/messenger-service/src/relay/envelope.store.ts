import {Injectable, Logger} from '@nestjs/common';
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {RedisService} from '../redis/redis.service';
import type {RetractToken, EnvelopeId} from '../common/ids';
import type {ReceiptOutcome, StoredEnvelope} from './envelope.types';
import type {SessionAddress} from '../gateway/protocol';

/**
 * Audit P0-7 — Per-recipient pending-queue ceiling.
 *
 * Without a cap, a single authenticated submitter (or a stolen JWT)
 * can torch a recipient's relay state by POSTing millions of envelopes
 * to the same `pending:{user}:{device}` ZSET. The pull cap clamps the
 * batch at 1000, so anything older than the most-recent 1000 envelopes
 * becomes invisible to the user (still on the relay until dwell expiry,
 * still consuming Redis memory + sealed-archive rows for 90 days).
 *
 * 10_000 is generous for a steady-state inbox (Signal's own dwell-side
 * default is also four-figure) but tight enough that a runaway attacker
 * hits a hard wall before they can fill a node. The cap is in addition
 * to — not a replacement for — P0-5 rate limiting; the throttler bounds
 * REQUESTS PER SECOND, this bounds STORED ENVELOPES per recipient.
 */
const MAX_PENDING_PER_DEVICE_DEFAULT = 10_000;

/**
 * Audit P0-7 — Lua atomicity guarantee.
 *
 * Why a Lua script and not a Node.js check-then-write:
 *   ZCARD + (conditional SET/ZADD) split across two Node round-trips
 *   races with concurrent submitters. Two ingest workers both see
 *   `count == MAX-1`, both pass the check, both insert → ceiling
 *   silently breached by N concurrent writers. Redis runs Lua scripts
 *   atomically (single-threaded reactor), so the check + writes commit
 *   or fail as a unit, no matter how many connections are pushing.
 *
 * Return value: `1` on success, `0` on rejection (queue full).
 *
 * KEYS[1] = envKey
 * KEYS[2] = pendingKey
 * KEYS[3] = pending-index SET (Scale P0-5 — registers pendingKey so the
 *           orphan sweep iterates a SET of known queues via SSCAN instead
 *           of SCANning the entire multi-million-key namespace)
 * ARGV[1] = payload (JSON-serialized StoredEnvelope)
 * ARGV[2] = ttlSeconds
 * ARGV[3] = timestamp (ZSET score)
 * ARGV[4] = envelopeId (ZSET member)
 * ARGV[5] = maxPending (ceiling)
 */
// Exported for envelope.store.put-lua.spec.ts ONLY (audit #20): the specs
// force RELAY_DISABLE_LUA_CAP, so without a pin the PRODUCTION eval path —
// this script, its KEYS/ARGV order and the 0-result contract — was
// exercised by nothing. Same pattern as the mobile V20 migration export.
export const PUT_WITH_CAP_LUA = `
  local cur = redis.call('ZCARD', KEYS[2])
  if cur >= tonumber(ARGV[5]) then
    return 0
  end
  redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
  redis.call('ZADD', KEYS[2], tonumber(ARGV[3]), ARGV[4])
  redis.call('SADD', KEYS[3], KEYS[2])
  return 1
`;

/**
 * Scale P0-5 — SET of every live `pending:{user}:{device}` key, maintained
 * by `put` (Lua + fallback) and pruned by the sweep when a queue is empty.
 * Never parsed as a pending key itself (`parsePendingKey` rejects it).
 */
export const PENDING_INDEX_KEY = 'pending:index';
/** One-time legacy backfill marker — see `seedPendingIndexOnce`. */
const PENDING_INDEX_SEEDED_KEY = 'pending:index:seeded';

/**
 * Audit P0-7 — Custom error so the service layer can map to HTTP 429
 * (and the WS layer can surface a typed reason) without sniffing the
 * message string. Thrown only from `put()` when the recipient's pending
 * queue is at the ceiling. The submitter retains the right to retry
 * later; nothing was persisted.
 */
export class PendingQueueFullError extends Error {
  constructor(public readonly recipient: SessionAddress, public readonly limit: number) {
    super('pending_queue_full');
    this.name = 'PendingQueueFullError';
  }
}

/**
 * Redis data model
 *
 *   env:{envelopeId}              STRING  — JSON-serialized StoredEnvelope, TTL = dwell
 *   pending:{userId}:{deviceId}   ZSET    — score=timestamp, member=envelopeId
 *
 * The main key carries the authoritative TTL; the pending ZSET is an
 * index. When the main key expires, orphan members remain in the ZSET
 * until a pull() or the daily sweep cleans them. We never read
 * envelope content from the ZSET — it's purely for ordering/discovery.
 */
@Injectable()
export class EnvelopeStore {
  private readonly logger = new Logger(EnvelopeStore.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Per-recipient queue ceiling. Read from `relay.maxPendingPerDevice`
   * config (env `RELAY_MAX_PENDING_PER_DEVICE`); falls back to a tight
   * default if the operator hasn't set it.
   *
   * Implemented as a getter rather than a constructor read so a test
   * can override the config provider AFTER the store has been
   * instantiated.
   */
  private get maxPending(): number {
    // Audit P0-7 — config injection is intentionally lazy (no @Inject in
    // constructor) so this module stays a leaf in the DI graph. The
    // configuration loader exposes the value at `relay.maxPendingPerDevice`;
    // env-only fallback keeps the path safe during unit tests that don't
    // wire ConfigModule.
    const env = process.env['RELAY_MAX_PENDING_PER_DEVICE'];
    if (env) {
      const n = parseInt(env, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return MAX_PENDING_PER_DEVICE_DEFAULT;
  }

  /**
   * Audit P0-7 — atomic put with per-recipient queue ceiling.
   *
   * Two implementations:
   *   - Production (default): single Redis EVAL of `PUT_WITH_CAP_LUA`
   *     so ZCARD + SET + ZADD execute as one atomic step. No race
   *     window for concurrent submitters to coordinate past the cap.
   *   - Test/fallback (`RELAY_DISABLE_LUA_CAP=true`): non-atomic
   *     ZCARD-then-MULTI. Still checks the cap, but a concurrent
   *     submitter race could let two writes through. Only enabled
   *     against test backends (ioredis-mock's Lua emulator does not
   *     fully implement the runtime, so we avoid relying on it).
   */
  async put(env: StoredEnvelope, ttlSeconds: number): Promise<void> {
    const pkey = pendingKey(env.recipient);
    const ekey = envKey(env.envelopeId);
    const payload = JSON.stringify(env);
    const cap = this.maxPending;

    const disableLua = process.env['RELAY_DISABLE_LUA_CAP'] === 'true';

    if (!disableLua) {
      const client = this.redis.client as unknown as {
        eval: (script: string, keys: number, ...args: (string | number)[]) => Promise<unknown>;
      };
      const result = await client.eval(
        PUT_WITH_CAP_LUA,
        3,
        ekey,
        pkey,
        PENDING_INDEX_KEY,
        payload,
        String(ttlSeconds),
        String(env.timestamp),
        env.envelopeId,
        String(cap),
      );
      if (result === 0 || result === '0') {
        throw new PendingQueueFullError(env.recipient, cap);
      }
      return;
    }

    const cur = await this.redis.client.zcard(pkey);
    if (cur >= cap) {
      throw new PendingQueueFullError(env.recipient, cap);
    }
    const p = this.redis.client.multi();
    p.set(ekey, payload, 'EX', ttlSeconds);
    p.zadd(pkey, env.timestamp, env.envelopeId);
    p.sadd(PENDING_INDEX_KEY, pkey);
    await p.exec();
  }

  async get(envelopeId: string): Promise<StoredEnvelope | null> {
    const raw = await this.redis.client.get(envKey(envelopeId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredEnvelope;
    } catch (e) {
      this.logger.warn(`corrupt envelope ${envelopeId}: ${(e as Error).message}`);
      return null;
    }
  }

  /** Scale P1-1 — batch form of get(): one MGET for the whole ack batch. */
  async getMany(envelopeIds: string[]): Promise<(StoredEnvelope | null)[]> {
    if (envelopeIds.length === 0) return [];
    const raws = await this.redis.client.mget(...envelopeIds.map(envKey));
    return raws.map((raw, i) => {
      if (!raw) return null;
      try {
        return JSON.parse(raw) as StoredEnvelope;
      } catch (e) {
        this.logger.warn(`corrupt envelope ${envelopeIds[i]}: ${(e as Error).message}`);
        return null;
      }
    });
  }

  /** Scale P1-1 — batch read of stored ack tokens (verification is the caller's). */
  async getAckTokens(envelopeIds: string[]): Promise<(string | null)[]> {
    if (envelopeIds.length === 0) return [];
    return this.redis.client.mget(...envelopeIds.map(ackTokenKey));
  }

  /**
   * Scale P1-1 — batch hard-delete: env payload + pending-ZSET member +
   * ack token for every envelope, in ONE pipeline. Caller MUST have already
   * verified recipient ownership + possession proof per envelope (the same
   * contract as `ack` + `deleteAckToken`, which stay for the single path).
   */
  async ackMany(envelopeIds: string[], recipient: SessionAddress): Promise<boolean[]> {
    if (envelopeIds.length === 0) return [];
    const pipe = this.redis.client.pipeline();
    for (const id of envelopeIds) {
      pipe.del(envKey(id));
      pipe.zrem(pendingKey(recipient), id);
      pipe.del(ackTokenKey(id));
    }
    const results = await pipe.exec();
    // Per-item outcome: an item is acked iff none of its three commands
    // errored — a single bad item must not poison the rest of the batch.
    return envelopeIds.map((_, i) => {
      for (let c = 0; c < 3; c++) {
        const [err] = results?.[i * 3 + c] ?? [null];
        if (err) return false;
      }
      return true;
    });
  }

  /**
   * Scale P1-1 — batch settleReceipt: one MGET, then one pipeline of SETs
   * for the slots that exist. Same no-op-when-unopened semantics.
   */
  async settleReceiptsMany(
    items: Array<{envelopeId: string; outcome: 'delivered' | 'discarded'}>,
  ): Promise<void> {
    if (items.length === 0) return;
    const raws = await this.redis.client.mget(...items.map(i => receiptKey(i.envelopeId)));
    const pipe = this.redis.client.pipeline();
    let any = false;
    for (let i = 0; i < items.length; i++) {
      const raw = raws[i];
      if (!raw) continue;
      const stored = raw.split('|')[0];
      pipe.set(
        receiptKey(items[i].envelopeId),
        `${stored}|${items[i].outcome}`,
        'EX', EnvelopeStore.RECEIPT_SETTLED_TTL_SEC,
      );
      any = true;
    }
    if (any) await pipe.exec();
  }

  /**
   * Scale P1-1 — batch takeSubmitter: pipelined GETDELs keep the atomic
   * single-use property per envelope (two concurrent acks can never both
   * read one mapping) while costing one round-trip for the whole batch.
   */
  async takeSubmittersMany(envelopeIds: string[]): Promise<(SessionAddress | null)[]> {
    if (envelopeIds.length === 0) return [];
    const pipe = this.redis.client.pipeline();
    for (const id of envelopeIds) pipe.getdel(submitterKey(id));
    const results = await pipe.exec();
    return envelopeIds.map((id, i) => {
      const [err, raw] = results?.[i] ?? [null, null];
      if (err || typeof raw !== 'string' || raw.length === 0) return null;
      return this.parseSubmitterRaw(id, raw);
    });
  }

  private parseSubmitterRaw(envelopeId: string, raw: string): SessionAddress | null {
    const colonIdx = raw.lastIndexOf(':');
    if (colonIdx <= 0) {
      this.logger.warn(`corrupt submitter mapping for ${envelopeId}: ${raw}`);
      return null;
    }
    const userId = raw.slice(0, colonIdx);
    const deviceId = parseInt(raw.slice(colonIdx + 1), 10);
    if (!userId || !Number.isFinite(deviceId)) {
      this.logger.warn(`corrupt submitter mapping for ${envelopeId}: ${raw}`);
      return null;
    }
    return {userId, deviceId};
  }

  /**
   * Pull pending envelopes for one device, in timestamp order.
   * Drops orphan ZSET members whose main key has expired.
   */
  async listForDevice(
    recipient: SessionAddress,
    afterTs: number,
    limit: number,
  ): Promise<StoredEnvelope[]> {
    const pkey = pendingKey(recipient);
    const ids = await this.redis.client.zrangebyscore(
      pkey,
      `(${afterTs}`,
      '+inf',
      'LIMIT',
      0,
      limit,
    );
    if (ids.length === 0) return [];

    const pipe = this.redis.client.pipeline();
    for (const id of ids) pipe.get(envKey(id));
    const results = await pipe.exec();
    const out: StoredEnvelope[] = [];
    const orphans: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const [err, raw] = results?.[i] ?? [null, null];
      if (err || !raw) { orphans.push(ids[i]); continue; }
      try {
        out.push(JSON.parse(raw as string) as StoredEnvelope);
      } catch {
        orphans.push(ids[i]);
      }
    }
    if (orphans.length) {
      await this.redis.client.zrem(pkey, ...orphans);
    }
    return out;
  }

  /**
   * Hard-delete. Caller MUST have already verified that the requester
   * is the envelope's recipient — this method trusts its arguments.
   */
  async ack(envelopeId: string, recipient: SessionAddress): Promise<void> {
    const p = this.redis.client.multi();
    p.del(envKey(envelopeId));
    p.zrem(pendingKey(recipient), envelopeId);
    await p.exec();
  }

  /**
   * M12 retract-capability — store `retract:{token} → envelopeId` with
   * the same TTL as the envelope itself. Knowledge of the token is
   * the ONLY auth needed for retract (no sender identity on the wire).
   */
  async storeRetractToken(token: RetractToken, envelopeId: EnvelopeId, ttlSeconds: number): Promise<void> {
    await this.redis.client.set(retractKey(token), envelopeId, 'EX', ttlSeconds);
  }

  /**
   * Consume (read + delete) the retract-token mapping. Returns the
   * envelopeId if valid, null otherwise. Single-use by design — a
   * replay attempt finds nothing.
   */
  async consumeRetractToken(token: string): Promise<string | null> {
    const id = await this.redis.client.get(retractKey(token));
    if (!id) return null;
    await this.redis.client.del(retractKey(token));
    return id;
  }

  /**
   * Audit P0-N5 — per-recipient clientMsgId dedup.
   *
   * Atomic claim: SET NX returns true if the dedup key was newly stored
   * and false if it already existed. On the FIRST submit for a given
   * (recipient, clientMsgId), the caller writes the result tuple
   * (envelopeId, retractToken). On every subsequent retry (watchdog
   * timeout, HTTP fallback racing a slow WS ack, app-restart drain),
   * the same key already exists and the caller reuses the cached
   * tuple instead of creating a second envelope.
   *
   * Scope is (recipientUserId, deviceId, clientMsgId) — different
   * senders that happen to mint the same id never collide, and a
   * sender re-using a clientMsgId across different recipients (group
   * fan-out path does exactly this) gets independent dedup state
   * per recipient.
   */
  async claimClientMsgId(
    recipient: SessionAddress,
    clientMsgId: string,
    value: {envelopeId: string; retractToken: string},
    ttlSeconds: number,
  ): Promise<{stored: boolean; existing: {envelopeId: string; retractToken: string} | null}> {
    const key = dedupKey(recipient, clientMsgId);
    const payload = JSON.stringify(value);
    // SET key value NX EX ttl — returns 'OK' on first write, null otherwise.
    const ok = await this.redis.client.set(key, payload, 'EX', ttlSeconds, 'NX');
    if (ok === 'OK') return {stored: true, existing: null};
    const raw = await this.redis.client.get(key);
    if (!raw) {
      // Race: key existed at NX but expired before our GET. Treat as
      // first-write — caller proceeds to create a fresh envelope.
      return {stored: false, existing: null};
    }
    try {
      return {stored: false, existing: JSON.parse(raw) as typeof value};
    } catch (e) {
      this.logger.warn(`corrupt dedup payload for ${key}: ${(e as Error).message}`);
      return {stored: false, existing: null};
    }
  }

  /**
   * Audit P0-7 — release a previously-claimed dedup key. Called from
   * the service when `put()` raises `PendingQueueFullError` AFTER the
   * dedup claim succeeded; without releasing, a legitimate retry after
   * the queue drains would be coalesced into the cached
   * (envelopeId, retractToken) tuple that was never actually written.
   * Best-effort: a failure here is logged but does not propagate (the
   * dedup key TTLs out within the dwell anyway).
   */
  async releaseClientMsgId(recipient: SessionAddress, clientMsgId: string): Promise<void> {
    await this.redis.client.del(dedupKey(recipient, clientMsgId));
  }

  /**
   * Audit P0-T6 — record which submitter device a freshly-minted
   * envelope came from so the recipient's `envelope.ack` can fire an
   * `envelope.delivered` back to that exact device. The mapping lives
   * in a TRANSIENT Redis key keyed by envelopeId; it never enters the
   * persisted `env:*` payload and never enters the long-term backup
   * mirror. Sealed-sender is preserved: the mapping evaporates the
   * moment the ack is processed (or when dwell expires, whichever
   * comes first).
   *
   * Scope is (envelopeId) — uniqueness is guaranteed by the random UUID
   * the service mints at submit. The value is the submitter's
   * (userId, deviceId) tuple so the gateway can target the precise
   * device that issued the send, even if the sender has multiple
   * devices online for the same account.
   */
  async storeSubmitter(
    envelopeId: string,
    submitter: SessionAddress,
    ttlSeconds: number,
  ): Promise<void> {
    await this.redis.client.set(
      submitterKey(envelopeId),
      `${submitter.userId}:${submitter.deviceId}`,
      'EX', ttlSeconds,
    );
  }

  /**
   * Audit P0-T6 — read + delete the submitter mapping. Called from
   * `EnvelopeService.ack` immediately before (or after) the envelope
   * hard-delete, so the gateway can route the `envelope.delivered`
   * frame to the exact submitter device. Single-use; a missing key
   * returns null (the most common reason is a sender that submitted
   * via HTTP and didn't pass through the WS gateway — those senders
   * don't have a live socket to notify, so silent skip is correct).
   */
  async takeSubmitter(envelopeId: string): Promise<SessionAddress | null> {
    // AUDIT-2026-08-13 (Phase-0 item 5) — GETDEL replaces the read-then-DEL
    // pair: atomic single-use, so two concurrent acks for the same envelope
    // (WS + HTTP receipt racing) can never BOTH read the mapping and
    // double-route `envelope.delivered`; the loser gets null (the documented
    // miss path). Requires Redis >= 6.2 (the deployed image is 7.x).
    const raw = await this.redis.client.getdel(submitterKey(envelopeId));
    if (!raw) return null;
    return this.parseSubmitterRaw(envelopeId, raw);
  }

  /**
   * Audit RELAY-C3 (2026-07-02): make the delivered ("double-tick") receipt
   * eventually-consistent. The live emit is fire-and-forget to the submitter's
   * device room, so if the sender is offline at the recipient's ack moment the
   * receipt was lost forever. Queue it here (keyed by sender userId, 7-day TTL)
   * and flush on the sender's next WS connect. The client's applyEnvelopeDelivered
   * is idempotent, so a redundant flush (sender was actually online) is harmless.
   */
  private static readonly PENDING_DELIVERED_TTL_SEC = 7 * 24 * 3600;
  // Cap the set so a sender who never reconnects can't grow it without bound
  // (a chatty sender offline for the full 7-day TTL). SADD is a no-op once the
  // cap is hit — the double-tick is a best-effort hint, dropping the oldest few
  // is acceptable and the client reconciles ticks on its own pulls anyway.
  private static readonly PENDING_DELIVERED_CAP = 5_000;
  /**
   * Scale P1-1 — batch form: one SCARD + one MULTI per (user, disposition)
   * group instead of per envelope. Same cap semantics: adds are skipped
   * once the set is at PENDING_DELIVERED_CAP (best-effort hint queue).
   */
  async addPendingOutcomesMany(
    userId: string,
    envelopeIds: string[],
    kind: 'delivered' | 'undeliverable',
  ): Promise<void> {
    if (envelopeIds.length === 0) return;
    const key = `${kind}-pending:${userId}`;
    const card = await this.redis.client.scard(key);
    const room = EnvelopeStore.PENDING_DELIVERED_CAP - card;
    if (room <= 0) return;
    await this.redis.client
      .multi()
      .sadd(key, ...envelopeIds.slice(0, room))
      .expire(key, EnvelopeStore.PENDING_DELIVERED_TTL_SEC)
      .exec();
  }

  async addPendingDelivered(userId: string, envelopeId: string): Promise<void> {
    const key = `delivered-pending:${userId}`;
    // Audit MEDIUM-4 (2026-07-02): SADD + EXPIRE must be ATOMIC. Non-atomic, a
    // crash between them left a TTL-less key that leaked forever (× every
    // sender who never reconnects). MULTI runs both or neither. Skip the add
    // once the cap is reached to bound worst-case memory.
    const card = await this.redis.client.scard(key);
    if (card >= EnvelopeStore.PENDING_DELIVERED_CAP) {return;}
    await this.redis.client
      .multi()
      .sadd(key, envelopeId)
      .expire(key, EnvelopeStore.PENDING_DELIVERED_TTL_SEC)
      .exec();
  }
  // Audit SRV-03 — non-destructive drain, same contract as the read-receipt
  // peek/remove pair below: the caller emits each id and removes only what
  // emitted, so a crash between the read and the emit can no longer destroy a
  // sender's double-tick. The key keeps its 7-day EXPIRE, so an entry that
  // never delivers still ages out.
  async peekPendingDelivered(userId: string): Promise<string[]> {
    return this.redis.client.smembers(`delivered-pending:${userId}`);
  }
  async removePendingDelivered(userId: string, envelopeIds: string[]): Promise<void> {
    if (envelopeIds.length === 0) return;
    await this.redis.client.srem(`delivered-pending:${userId}`, ...envelopeIds);
  }

  // Handoff §3.6(c) — same queue mechanics (cap, TTL, atomicity) for the
  // honest counterpart: `envelope.undeliverable` receipts for senders
  // offline at the recipient's discarded-ack moment.
  async addPendingUndeliverable(userId: string, envelopeId: string): Promise<void> {
    const key = `undeliverable-pending:${userId}`;
    const card = await this.redis.client.scard(key);
    if (card >= EnvelopeStore.PENDING_DELIVERED_CAP) {return;}
    await this.redis.client
      .multi()
      .sadd(key, envelopeId)
      .expire(key, EnvelopeStore.PENDING_DELIVERED_TTL_SEC)
      .exec();
  }
  async peekPendingUndeliverable(userId: string): Promise<string[]> {
    return this.redis.client.smembers(`undeliverable-pending:${userId}`);
  }
  async removePendingUndeliverable(userId: string, envelopeIds: string[]): Promise<void> {
    if (envelopeIds.length === 0) return;
    await this.redis.client.srem(`undeliverable-pending:${userId}`, ...envelopeIds);
  }

  // F7 — same queue mechanics (cap, TTL, atomicity) for read-receipt
  // frames whose target device had no live socket at forward time.
  // Keyed per (user, device) because read receipts address one specific
  // device; members are the serialized `{from, envelopeIds}` frame data
  // (envelope ids only — never message content).
  async addPendingReadReceipt(addr: SessionAddress, payload: string): Promise<void> {
    const key = `read-receipt-pending:${addr.userId}:${addr.deviceId}`;
    const card = await this.redis.client.scard(key);
    if (card >= EnvelopeStore.PENDING_DELIVERED_CAP) {return;}
    await this.redis.client
      .multi()
      .sadd(key, payload)
      .expire(key, EnvelopeStore.PENDING_DELIVERED_TTL_SEC)
      .exec();
  }
  async takePendingReadReceipts(addr: SessionAddress): Promise<string[]> {
    const key = `read-receipt-pending:${addr.userId}:${addr.deviceId}`;
    const res = await this.redis.client.multi().smembers(key).del(key).exec();
    const smembersReply = res?.[0]?.[1];
    return Array.isArray(smembersReply) ? (smembersReply as string[]) : [];
  }

  // Folded P2 (socket cluster) — non-destructive read-receipt drain
  // primitives. `peek` reads the queued frames WITHOUT deleting; the caller
  // emits each and then `remove`s only the ones that were actually emitted,
  // so a crash (or emit failure) between the read and the emit can no longer
  // lose receipts. Members are the serialized `{from, envelopeIds}` frames
  // (envelope ids only — never message content). The key retains its original
  // 7-day EXPIRE, so a permanently-undeliverable entry still ages out.
  async peekPendingReadReceipts(addr: SessionAddress): Promise<string[]> {
    const key = `read-receipt-pending:${addr.userId}:${addr.deviceId}`;
    return this.redis.client.smembers(key);
  }
  async removePendingReadReceipts(addr: SessionAddress, payloads: string[]): Promise<void> {
    if (payloads.length === 0) return;
    const key = `read-receipt-pending:${addr.userId}:${addr.deviceId}`;
    await this.redis.client.srem(key, ...payloads);
  }

  /**
   * Sweep orphan ZSET entries (members whose main key has expired).
   * Called by the daily cron. Scans the pending ZSETs for the given
   * user; caller iterates users via the SCAN cursor on pending:*.
   */
  async sweepPending(recipient: SessionAddress): Promise<{removed: number; empty: boolean}> {
    const pkey = pendingKey(recipient);
    // Scale P0-5 — bounded per-key work: check only the OLDEST 500 members
    // per pass (orphans cluster at the old end — the main key expired), not
    // the whole up-to-10k ZSET. Anything missed is dropped lazily by
    // listForDevice on the next read, or by a later pass.
    const ids = await this.redis.client.zrange(pkey, 0, 499);
    if (ids.length === 0) return {removed: 0, empty: true};
    const pipe = this.redis.client.pipeline();
    for (const id of ids) pipe.exists(envKey(id));
    const results = await pipe.exec();
    const orphans: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const [, exists] = results?.[i] ?? [null, 0];
      if (exists === 0) orphans.push(ids[i]);
    }
    if (orphans.length) await this.redis.client.zrem(pkey, ...orphans);
    const remaining = await this.redis.client.zcard(pkey);
    return {removed: orphans.length, empty: remaining === 0};
  }

  /**
   * Scale P0-5 — iterate the pending-index SET (SSCAN) instead of a
   * full-keyspace SCAN. Cost is O(index size), i.e. O(live queues).
   */
  async *scanPendingIndex(): AsyncGenerator<string> {
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.client.sscan(
        PENDING_INDEX_KEY, cursor, 'COUNT', 500,
      );
      cursor = next;
      for (const k of keys) yield k;
    } while (cursor !== '0');
  }

  /** Scale P0-5 — drop an (empty or malformed) queue key from the index. */
  async removeFromPendingIndex(pkey: string): Promise<void> {
    await this.redis.client.srem(PENDING_INDEX_KEY, pkey);
  }

  /**
   * Scale P0-5 — one-time backfill: queues written before the index existed
   * are found by ONE legacy full-keyspace SCAN and SADDed; the marker key
   * makes every later call a single EXISTS. An in-flight seeding claim
   * (NX, 1h) stops concurrent replicas from double-scanning.
   */
  async seedPendingIndexOnce(): Promise<void> {
    if (await this.redis.client.exists(PENDING_INDEX_SEEDED_KEY)) return;
    const claimed = await this.redis.client.set(
      `${PENDING_INDEX_SEEDED_KEY}:claim`, '1', 'EX', 3600, 'NX',
    );
    if (claimed !== 'OK') return;
    this.logger.log('pending-index seed: legacy scan starting (one-time)');
    let seeded = 0;
    let batch: string[] = [];
    for await (const key of this.scanPendingKeys()) {
      if (key === PENDING_INDEX_KEY || key.startsWith(PENDING_INDEX_SEEDED_KEY)) continue;
      batch.push(key);
      if (batch.length >= 500) {
        await this.redis.client.sadd(PENDING_INDEX_KEY, ...batch);
        seeded += batch.length;
        batch = [];
      }
    }
    if (batch.length) {
      await this.redis.client.sadd(PENDING_INDEX_KEY, ...batch);
      seeded += batch.length;
    }
    await this.redis.client.set(PENDING_INDEX_SEEDED_KEY, '1');
    this.logger.log(`pending-index seed: done (${seeded} queues indexed)`);
  }

  /**
   * Audit P0-N9 — get-or-mint the per-envelope ack token. Called from
   * the deliver paths (WS fan-out, HTTP pull, WS connect flush) so the
   * token shipped to the recipient is stable across re-deliveries of
   * the same envelope. SET NX returns the existing value untouched on
   * conflict; we then GET to read it back.
   *
   * TTL matches the dwell so the token can never outlive the envelope
   * it protects. 24 random bytes → base64url ≈ 32 chars: enough
   * entropy to make guessing infeasible across the relay's full
   * envelope-id space without bloating the wire.
   */
  async getOrMintAckToken(envelopeId: string, ttlSeconds: number): Promise<string> {
    const key = ackTokenKey(envelopeId);
    const fresh = base64url(randomBytes(24));
    const ok = await this.redis.client.set(key, fresh, 'EX', ttlSeconds, 'NX');
    if (ok === 'OK') return fresh;
    const existing = await this.redis.client.get(key);
    if (existing) return existing;
    // Race: existed at NX, expired before GET. Try once more with NX —
    // either we win or the new occupant wins; either way return that.
    const retryOk = await this.redis.client.set(key, fresh, 'EX', ttlSeconds, 'NX');
    if (retryOk === 'OK') return fresh;
    return (await this.redis.client.get(key)) ?? fresh;
  }

  /**
   * Audit P0-N9 — verify a presented ack token matches the stored one.
   * Constant-time comparison so an attacker can't probe the token byte-
   * by-byte via timing oracles. Returns false when no token has been
   * issued yet (e.g. ack racing in before any deliver) so the caller
   * can decide whether to fall back to the legacy recipient-identity
   * check or reject outright.
   */
  async verifyAckToken(envelopeId: string, presented: string): Promise<boolean> {
    const stored = await this.redis.client.get(ackTokenKey(envelopeId));
    if (!stored) return false;
    // Buffers must be same length for timingSafeEqual; pad if needed
    // to prevent length-leak via thrown exception.
    const a = Buffer.from(stored);
    const b = Buffer.from(presented);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * Audit P0-N9 — drop the ack token after a successful ack. Called
   * from `ack` after the envelope hard-delete so a replayed ack with
   * the same token (e.g. WS retry of a now-deleted envelope) silently
   * no-ops instead of finding a still-valid token.
   */
  async deleteAckToken(envelopeId: string): Promise<void> {
    await this.redis.client.del(ackTokenKey(envelopeId));
  }

  /**
   * OM-03 — open a delivery-receipt slot for an envelope whose submitter
   * has no live socket (every HTTP submit). Shares the envelope's dwell
   * TTL: an envelope that ages out takes its receipt with it.
   */
  private static readonly RECEIPT_SETTLED_TTL_SEC = 7 * 24 * 3600;

  async openReceipt(envelopeId: string, retractToken: string, ttlSeconds: number): Promise<void> {
    await this.redis.client.set(
      receiptKey(envelopeId), receiptDigest(retractToken), 'EX', ttlSeconds,
    );
  }

  /**
   * OM-03 — stamp the terminal outcome on an open receipt. No-op when no
   * receipt was opened (WS submits, legacy clients), so this costs one
   * GET on the ack path and nothing else. The settled value gets its own
   * 7-day TTL — the same window `delivered-pending` uses — so a sender
   * that stays offline past the envelope's dwell still collects it.
   */
  async settleReceipt(envelopeId: string, outcome: 'delivered' | 'discarded'): Promise<void> {
    const raw = await this.redis.client.get(receiptKey(envelopeId));
    if (!raw) return;
    const stored = raw.split('|')[0];
    await this.redis.client.set(
      receiptKey(envelopeId),
      `${stored}|${outcome}`,
      'EX', EnvelopeStore.RECEIPT_SETTLED_TTL_SEC,
    );
  }

  /**
   * OM-03 — capability-gated read. A wrong token and an unknown envelope
   * return the SAME `'unknown'`, so this is not a delivery oracle. The
   * digest comparison is constant-time (mirrors `verifyAckToken`).
   */
  async readReceipt(envelopeId: string, presentedToken: string): Promise<ReceiptOutcome> {
    const raw = await this.redis.client.get(receiptKey(envelopeId));
    return decodeReceipt(raw, presentedToken);
  }

  /**
   * Scale P2-13 — batch form: one MGET for the whole poll instead of one
   * GET per envelope. Same capability gate + constant-time compare per item.
   */
  async readReceiptsMany(
    items: Array<{envelopeId: string; retractToken: string}>,
  ): Promise<ReceiptOutcome[]> {
    if (items.length === 0) return [];
    const raws = await this.redis.client.mget(...items.map(i => receiptKey(i.envelopeId)));
    return items.map((it, i) => decodeReceipt(raws[i] ?? null, it.retractToken));
  }

  /**
   * Sprint-6 — purge every envelope queued for one (userId, deviceId)
   * after the caller's identity rotated. Drops the entire pending ZSET
   * + every env:* payload it referenced + any retract / ack-token keys
   * attached to those envelopes. Idempotent: re-running on an already-
   * empty queue returns 0 and touches nothing.
   *
   * Why this is the correct shape:
   *   The outer ECIES wrap binds the recipient's identity key into its
   *   AAD, so after the recipient rotates identities every queued
   *   envelope for that device is unrecoverable — the matching priv
   *   key was discarded with the old install. Leaving them in the
   *   queue just wastes 30 days of dwell, repeats the "outer sealed
   *   authentication failed" warning on every drain attempt, and can
   *   stall the bootstrap pull behind known-dead envelopes.
   *
   *   We don't (and can't) cryptographically verify that each envelope
   *   was wrapped to the OLD identity vs the NEW one — outerSealed is
   *   opaque to the relay by design. Authorisation rests on the JWT
   *   (the caller proves they own the account) and the deviceId scope
   *   (only the caller's own queue is touched).
   */
  async purgeRecipientQueue(recipient: SessionAddress): Promise<{purged: number}> {
    const pkey = pendingKey(recipient);
    const ids = await this.redis.client.zrange(pkey, 0, -1);
    if (ids.length === 0) {
      return {purged: 0};
    }
    // Best-effort cleanup of the auxiliary keys associated with each
    // envelope. Failures here are non-fatal — the canonical envelope
    // payload + pending index get dropped below, and the auxiliaries
    // will TTL out on their own within the dwell window even if a
    // single DEL trips on a Redis hiccup.
    const pipe = this.redis.client.pipeline();
    for (const id of ids) {
      pipe.del(envKey(id));
      pipe.del(ackTokenKey(id));
      pipe.del(submitterKey(id));
      // OM-03 — drop the receipt slot too, so a purged queue doesn't
      // leave orphan `rcpt:*` keys dwelling for up to 30 days.
      pipe.del(receiptKey(id));
    }
    pipe.del(pkey);
    // Scale P0-5 — the queue is gone; keep the sweep index accurate. (A
    // stale member is harmless — the sweep SREMs empties — but free here.)
    pipe.srem(PENDING_INDEX_KEY, pkey);
    await pipe.exec();
    // Note: we intentionally do NOT walk and DEL the retract:{token}
    // mappings here. Each one is keyed by an unguessable UUID held only
    // by the original sender; there's no efficient reverse-index from
    // envelopeId → retractToken without an extra round-trip per id,
    // and orphan retract tokens are harmless because consumeRetractToken
    // re-checks `get(envelopeId)` and returns `{retracted: false}` when
    // the envelope is already gone. They expire on their own with TTL.
    return {purged: ids.length};
  }

  /** SCAN helper — yields each known pending:{user}:{device} key. */
  async *scanPendingKeys(): AsyncGenerator<string> {
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.client.scan(
        cursor,
        'MATCH',
        'pending:*',
        'COUNT',
        256,
      );
      cursor = next;
      for (const k of keys) yield k;
    } while (cursor !== '0');
  }
}

function envKey(id: string): string {
  return `env:${id}`;
}

function pendingKey(a: SessionAddress): string {
  return `pending:${a.userId}:${a.deviceId}`;
}

function retractKey(token: string): string {
  return `retract:${token}`;
}

/**
 * Audit P0-T6 — transient submitter-mapping key. Lives only long enough
 * for the recipient's ack to fire; never written into the persisted
 * envelope payload, never archived. Scope is (envelopeId).
 */
function submitterKey(envelopeId: string): string {
  return `submitter:${envelopeId}`;
}

/**
 * Audit P0-N5 — per-recipient clientMsgId dedup key. Scope:
 * (recipient.userId, recipient.deviceId, clientMsgId). The recipient
 * is in scope so that a sender fan-out using the same clientMsgId
 * across N peers gets independent dedup state per peer.
 */
function dedupKey(a: SessionAddress, clientMsgId: string): string {
  return `dedup:${a.userId}:${a.deviceId}:${clientMsgId}`;
}

export function parsePendingKey(key: string): SessionAddress | null {
  const m = /^pending:([^:]+):(\d+)$/.exec(key);
  if (!m) return null;
  return {userId: m[1], deviceId: parseInt(m[2], 10)};
}

/**
 * OM-03 — anonymous delivery-receipt slot. Value is the SHA-256 hex of
 * the envelope's retract token, optionally suffixed `|delivered` or
 * `|discarded` once the recipient acks. Holds NO submitter identity:
 * the sender proves entitlement by presenting the capability token it
 * received at submit, the same model as `retract`. Scope: (envelopeId).
 */
function receiptKey(envelopeId: string): string {
  return `rcpt:${envelopeId}`;
}

function receiptDigest(retractToken: string): string {
  return createHash('sha256').update(retractToken, 'utf8').digest('hex');
}

/**
 * OM-03 — shared decode for the single + batch receipt reads. A wrong token
 * and an unknown envelope return the SAME 'unknown' (no delivery oracle);
 * the digest comparison is constant-time.
 */
function decodeReceipt(raw: string | null, presentedToken: string): ReceiptOutcome {
  if (!raw) return 'unknown';
  const [stored, outcome] = raw.split('|');
  const a = Buffer.from(stored, 'utf8');
  const b = Buffer.from(receiptDigest(presentedToken), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'unknown';
  return outcome === 'delivered' || outcome === 'discarded' ? outcome : 'pending';
}

/** Audit P0-N9 — per-envelope possession-proof token. Scope: (envelopeId). */
function ackTokenKey(envelopeId: string): string {
  return `ack_token:${envelopeId}`;
}

/** URL-safe base64 without padding. */
function base64url(buf: Buffer): string {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
