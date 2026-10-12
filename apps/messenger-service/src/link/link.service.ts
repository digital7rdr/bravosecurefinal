import {
  Injectable, Logger, NotFoundException, ForbiddenException, ConflictException, GoneException,
} from '@nestjs/common';
import {randomBytes} from 'crypto';
import {RedisService} from '../redis/redis.service';
import {SocketHub} from '../gateway/socket-hub';
import {PushService} from '../push/push.service';
import {LINK_MAX_ACTIVE, LINK_SDID_BASE, linkInstallKey} from './link-policy';

/**
 * Linked devices — server side. See link-policy.ts for the model.
 *
 * Everything lives in Redis (AOF-persisted in production), like the rest of
 * the relay. The server never sees the link key: the browser generates it and
 * shows it only inside the QR code, and every item in a link inbox is an
 * AES-GCM ciphertext the phone or the browser produced. What the server does
 * know is the minimum to route: which install is the phone side, which is the
 * browser side, and that both belong to the same account.
 */

export type LinkSide = 'web' | 'phone';

export interface LinkRecord {
  linkId:       string;
  userId:       string;
  webInstall:   string;
  phoneInstall: string;
  label:        string;
  wsDeviceId:   number;
  createdAt:    number;
  approvedAt:   number;
  lastSeenAt:   number;
}

interface PendingLink {
  linkId:     string;
  userId:     string;
  webInstall: string;
  label:      string;
  createdAt:  number;
}

export const LINK_PENDING_TTL_SEC = 300;
/** An unused link (neither side seen) expires after 60 days. */
export const LINK_IDLE_TTL_SEC = 60 * 24 * 3600;
/** Undelivered inbox items are kept 30 days. */
export const LINK_INBOX_TTL_SEC = 30 * 24 * 3600;
export const LINK_INBOX_MAX = 20_000;
export const LINK_PULL_MAX = 200;

const k = {
  pending: (id: string) => `lnk:pending:${id}`,
  rec:     (id: string) => `lnk:rec:${id}`,
  user:    (u: string)  => `lnk:user:${u}`,
  seq:     (id: string) => `lnk:seq:${id}`,
  inbox:   (id: string, side: LinkSide) => `lnk:q:${id}:${side}`,
};

const LINK_ID_RE = /^[A-Za-z0-9_-]{22}$/;

@Injectable()
export class LinkService {
  private readonly logger = new Logger(LinkService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly hub:   SocketHub,
    private readonly push:  PushService,
  ) {}

  static isLinkId(id: string): boolean { return LINK_ID_RE.test(id); }

  /** Browser: open a pending link. The browser puts linkId + its own key in the QR. */
  async start(userId: string, webInstall: string, label: string): Promise<{linkId: string; expiresAt: number}> {
    // A browser that starts linking again has lost its link key (signed out,
    // cleared site data): retire its old link instead of leaving it stranded.
    const existing = await this.redis.client.get(linkInstallKey(userId, webInstall));
    if (existing) {
      const oldId = existing.split('|')[0];
      try { await this.revoke(userId, oldId); } catch { await this.redis.client.del(linkInstallKey(userId, webInstall)); }
    }
    const linkId = randomBytes(16).toString('base64url');
    const p: PendingLink = {linkId, userId, webInstall, label: cleanLabel(label), createdAt: Date.now()};
    await this.redis.client.set(k.pending(linkId), JSON.stringify(p), 'EX', LINK_PENDING_TTL_SEC);
    return {linkId, expiresAt: p.createdAt + LINK_PENDING_TTL_SEC * 1000};
  }

  /** Browser: poll its pending link (the socket also gets `link.approved`). */
  async status(userId: string, install: string, linkId: string): Promise<
    {status: 'pending'} | {status: 'active'; wsDeviceId: number} | {status: 'expired'}
  > {
    const rec = await this.load(linkId);
    if (rec && rec.userId === userId && rec.webInstall === install) {
      return {status: 'active', wsDeviceId: rec.wsDeviceId};
    }
    const raw = await this.redis.client.get(k.pending(linkId));
    if (raw) {
      const p = JSON.parse(raw) as PendingLink;
      if (p.userId === userId && p.webInstall === install) return {status: 'pending'};
    }
    return {status: 'expired'};
  }

  /**
   * Phone: approve a scanned QR. The pending link must belong to the SAME
   * account as the phone — a QR shown by somebody else's browser (phishing)
   * reads as "not found" and links nothing.
   */
  async approve(userId: string, phoneInstall: string, linkId: string): Promise<LinkRecord> {
    const raw = await this.redis.client.get(k.pending(linkId));
    if (!raw) throw new NotFoundException('link_not_found');
    const p = JSON.parse(raw) as PendingLink;
    if (p.userId !== userId) throw new NotFoundException('link_not_found');
    if (p.webInstall === phoneInstall) throw new ForbiddenException('cannot_link_self');
    // Single-use: whoever DELs first wins.
    if ((await this.redis.client.del(k.pending(linkId))) !== 1) throw new NotFoundException('link_not_found');

    const active = await this.list(userId);
    if (active.length >= LINK_MAX_ACTIVE) throw new ConflictException('too_many_links');
    const used = new Set(active.map(r => r.wsDeviceId));
    let wsDeviceId = LINK_SDID_BASE;
    while (used.has(wsDeviceId)) wsDeviceId++;

    const now = Date.now();
    const rec: LinkRecord = {
      linkId, userId, webInstall: p.webInstall, phoneInstall, label: p.label,
      wsDeviceId, createdAt: p.createdAt, approvedAt: now, lastSeenAt: now,
    };
    await this.redis.client.multi()
      .set(k.rec(linkId), JSON.stringify(rec), 'EX', LINK_IDLE_TTL_SEC)
      .sadd(k.user(userId), linkId)
      .set(linkInstallKey(userId, p.webInstall), `${linkId}|${wsDeviceId}`, 'EX', LINK_IDLE_TTL_SEC)
      .exec();
    this.hub.emitToUser(userId, 'link.approved', {linkId, wsDeviceId});
    this.logger.log(`link.approved sub=${userId.slice(0, 8)} link=${linkId.slice(0, 6)} ws=${wsDeviceId}`);
    return rec;
  }

  /** Active links for the account (expired records are pruned from the index). */
  async list(userId: string): Promise<LinkRecord[]> {
    const ids = await this.redis.client.smembers(k.user(userId));
    if (ids.length === 0) return [];
    const raws = await this.redis.client.mget(...ids.map(k.rec));
    const out: LinkRecord[] = [];
    const stale: string[] = [];
    raws.forEach((r, i) => {
      if (!r) { stale.push(ids[i]); return; }
      try { out.push(JSON.parse(r) as LinkRecord); } catch { stale.push(ids[i]); }
    });
    if (stale.length) await this.redis.client.srem(k.user(userId), ...stale);
    return out.sort((a, b) => a.approvedAt - b.approvedAt);
  }

  /** Either side (same account) may unlink. */
  async revoke(userId: string, linkId: string): Promise<void> {
    const rec = await this.load(linkId);
    if (!rec || rec.userId !== userId) throw new NotFoundException('link_not_found');
    await this.redis.client.multi()
      .del(k.rec(linkId), k.seq(linkId), k.inbox(linkId, 'web'), k.inbox(linkId, 'phone'))
      .srem(k.user(userId), linkId)
      .del(linkInstallKey(userId, rec.webInstall))
      .exec();
    this.hub.emitToUser(userId, 'link.revoked', {linkId});
    this.logger.log(`link.revoked sub=${userId.slice(0, 8)} link=${linkId.slice(0, 6)}`);
  }

  /**
   * Post ciphertext items to the OTHER side's inbox. Only the phone may write
   * to the browser and only the browser to the phone.
   */
  async send(userId: string, install: string, linkId: string, to: LinkSide, items: string[]): Promise<{seq: number}> {
    const rec = await this.authorize(userId, install, linkId, to === 'web' ? 'phone' : 'web');
    const last = await this.redis.client.incrby(k.seq(linkId), items.length);
    const first = last - items.length + 1;
    const inbox = k.inbox(linkId, to);
    const pipe = this.redis.client.multi();
    items.forEach((it, i) => pipe.zadd(inbox, first + i, `${first + i}:${it}`));
    pipe.zremrangebyrank(inbox, 0, -(LINK_INBOX_MAX + 1));
    pipe.expire(inbox, LINK_INBOX_TTL_SEC);
    pipe.expire(k.seq(linkId), LINK_INBOX_TTL_SEC);
    await pipe.exec();
    await this.touch(rec);
    this.hub.emitToUser(userId, 'link.pending', {linkId, to, seq: last});
    if (to === 'phone') {
      // The phone may be asleep: wake it so it fetches and relays the
      // browser's message. Opaque payload — no link id, no content.
      void this.push.sendLinkWake(userId).catch(() => undefined);
    }
    return {seq: last};
  }

  /** Read one's own inbox after `after` (exclusive). */
  async inbox(userId: string, install: string, linkId: string, side: LinkSide, after: number, limit: number): Promise<{
    items: Array<{seq: number; data: string}>; more: boolean;
  }> {
    const rec = await this.authorize(userId, install, linkId, side);
    const n = Math.max(1, Math.min(LINK_PULL_MAX, limit || LINK_PULL_MAX));
    const rows = await this.redis.client.zrangebyscore(k.inbox(linkId, side), `(${Math.max(0, after)}`, '+inf', 'LIMIT', 0, n + 1);
    const more = rows.length > n;
    const items = rows.slice(0, n).map(r => {
      const i = r.indexOf(':');
      return {seq: Number(r.slice(0, i)), data: r.slice(i + 1)};
    });
    await this.touch(rec);
    return {items, more};
  }

  /** Drop everything up to and including `upTo` from one's own inbox. */
  async ack(userId: string, install: string, linkId: string, side: LinkSide, upTo: number): Promise<void> {
    await this.authorize(userId, install, linkId, side);
    await this.redis.client.zremrangebyscore(k.inbox(linkId, side), '-inf', upTo);
  }

  private async load(linkId: string): Promise<LinkRecord | null> {
    if (!LinkService.isLinkId(linkId)) return null;
    const raw = await this.redis.client.get(k.rec(linkId));
    if (!raw) return null;
    try { return JSON.parse(raw) as LinkRecord; } catch { return null; }
  }

  /** The caller must be the given side of an active link of their own account. */
  private async authorize(userId: string, install: string, linkId: string, side: LinkSide): Promise<LinkRecord> {
    const rec = await this.load(linkId);
    if (!rec || rec.userId !== userId) throw new GoneException('link_not_found');
    const owner = side === 'web' ? rec.webInstall : rec.phoneInstall;
    if (owner !== install) throw new ForbiddenException('not_link_party');
    return rec;
  }

  /** Refresh the idle TTL at most once a minute per link. */
  private async touch(rec: LinkRecord): Promise<void> {
    const now = Date.now();
    if (now - rec.lastSeenAt < 60_000) return;
    rec.lastSeenAt = now;
    await this.redis.client.multi()
      .set(k.rec(rec.linkId), JSON.stringify(rec), 'EX', LINK_IDLE_TTL_SEC)
      .expire(linkInstallKey(rec.userId, rec.webInstall), LINK_IDLE_TTL_SEC)
      .exec();
  }
}

function cleanLabel(s: string): string {
  // eslint-disable-next-line no-control-regex
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  return t || 'Web browser';
}
