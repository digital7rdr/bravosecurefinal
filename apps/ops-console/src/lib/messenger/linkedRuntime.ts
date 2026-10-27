/**
 * Linked devices (2026-10-12) — the browser messenger mirrored from the
 * user's phone ("linked mode").
 *
 * In linked mode this browser runs NO Signal session with anybody. The phone
 * forwards it the decrypted conversations (contacts, chat list, recent
 * history, every new message and status change) and sends what is typed here
 * on its behalf, over the private link channel (link key from the QR code,
 * AES-GCM, see `@bravo/messenger-core/link/linkProtocol`). The server relays
 * ciphertext only.
 *
 * The history is kept in the same vault-encrypted IndexedDB store the
 * standalone messenger uses, so the chat UI (ChatWorkspace) works unchanged:
 * this class implements the part of the MessengerRuntime surface it calls.
 */
import {io, type Socket} from 'socket.io-client';
import {
  linkCipher, encodeLinkQr, newLinkKey, newLinkMsgId, b64uEncode, b64uDecode, LinkReplayGuard,
  isGroupCid, isLinkAttachment,
  type LinkCipher, type PhoneToWeb, type WebToPhone, type LinkPeer, type LinkMsgRow,
  type LinkGroup, type LinkFeature,
} from '@bravo/messenger-core/link/linkProtocol';
import {getMessengerTicket} from '@/lib/api';
import {MessageStore, type StoredMessage, type ConversationSummary} from './messageStore';
import {wrapString, unwrapString, type WrapKey} from './crypto';
import type {MessengerDb} from './idb';
import {linkApi, messengerBase, browserLabel, LinkHttpError} from './linkClient';
import {uploadFile, downloadFile, type WebAttachment} from './mediaClient';

export interface LinkRecord {
  linkId:     string;
  key:        string;       // base64url link key
  wsDeviceId: number;
  label:      string;
  linkedAt:   number;
}

/** The DecryptedMessage shape the chat UI listens for (see runtime.ts). */
export interface LinkedIncoming {
  envelopeId:     string;
  conversationId: string;
  senderUserId:   string;
  senderDeviceId: number;
  body:           string;
  receivedAt:     number;
}

interface PresenceState { state: 'online' | 'active' | 'away' | 'offline'; lastSeenMs?: number }

const META_LINK = 'link_record_v1';
const META_PEERS = 'link_peers_v1';
const META_SELF = 'link_self_v1';
const META_SYNCED = 'link_synced_v1';
const META_GROUPS = 'link_groups_v1';
const META_CONTACTS = 'link_contacts_v1';
const POLL_MS = 20_000;
/** How long a group / contact command waits for the phone's answer. */
const COMMAND_TIMEOUT_MS = 60_000;

/** A command the phone did not (or could not) carry out. */
export class LinkCommandError extends Error {}

type ManageCommand = Extract<WebToPhone, {t: 'groupCreate' | 'groupAdd' | 'groupRemove' | 'groupEdit' | 'groupLeave' | 'groupInvite' | 'groupJoin' | 'contactSave' | 'contactRemove'}>;
type CommandBody<T> = T extends unknown ? Omit<T, 'id' | 'ts' | 'ref'> : never;
type ManageInput = CommandBody<ManageCommand>;
interface CommandResult { cid?: string | null; link?: string | null }

function genRef(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

async function putMetaWrapped(db: MessengerDb, key: WrapKey, name: string, value: unknown): Promise<void> {
  const wrapped = await wrapString(key, JSON.stringify(value));
  await db.put('meta', {key: name, value: b64uEncode(wrapped)});
}

async function getMetaWrapped<T>(db: MessengerDb, key: WrapKey, name: string): Promise<T | null> {
  const row = await db.get('meta', name);
  if (!row?.value) return null;
  try { return JSON.parse(await unwrapString(key, b64uDecode(row.value))) as T; } catch { return null; }
}

export async function readLinkRecord(db: MessengerDb, key: WrapKey): Promise<LinkRecord | null> {
  return getMetaWrapped<LinkRecord>(db, key, META_LINK);
}

/**
 * Pairing: open a pending link, show its QR, wait for the phone to approve.
 * Each QR is valid for 5 minutes; a fresh one replaces it automatically.
 */
export class LinkPairing {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly db: MessengerDb,
    private readonly wrapKey: WrapKey,
    private readonly onQr: (qr: string | null, error: string | null) => void,
    private readonly onLinked: (rec: LinkRecord) => void,
  ) {}

  start(): void { void this.next(); }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async next(): Promise<void> {
    if (this.stopped) return;
    try {
      const label = browserLabel();
      const {linkId, expiresAt} = await linkApi.start(label);
      const key = newLinkKey();
      this.onQr(encodeLinkQr(linkId, key), null);
      const poll = async (): Promise<void> => {
        if (this.stopped) return;
        try {
          const st = await linkApi.status(linkId);
          if (st.status === 'active') {
            const rec: LinkRecord = {linkId, key: b64uEncode(key), wsDeviceId: st.wsDeviceId, label, linkedAt: Date.now()};
            await putMetaWrapped(this.db, this.wrapKey, META_LINK, rec);
            this.stopped = true;
            this.onLinked(rec);
            return;
          }
          if (st.status === 'expired' || Date.now() > expiresAt) { void this.next(); return; }
        } catch { /* transient — keep polling */ }
        this.timer = setTimeout(() => void poll(), 2_000);
      };
      this.timer = setTimeout(() => void poll(), 2_000);
    } catch (e) {
      this.onQr(null, (e as Error).message || 'link_start_failed');
      this.timer = setTimeout(() => void this.next(), 10_000);
    }
  }
}

export class LinkedRuntime {
  readonly kind = 'linked' as const;
  readonly self: {userId: string; deviceId: number};
  private cipher: LinkCipher | null = null;
  private readonly messages: MessageStore;
  private socket: Socket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private cursor = 0;
  private draining: Promise<void> | null = null;
  private drainAgain = false;
  private readonly replay = new LinkReplayGuard();
  private peers = new Map<string, LinkPeer>();
  private refToCid = new Map<string, string>();
  private readTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  private phoneSeenAt = 0;
  private features = new Set<LinkFeature>();
  private groupMap = new Map<string, LinkGroup>();
  /** The phone's contact list as last sent in full (address book, added by hand, chat partners). */
  private contactBook: LinkPeer[] = [];
  private pendingResults = new Map<string, {resolve: (r: CommandResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  private groupsListeners = new Set<() => void>();

  private incomingListeners = new Set<(m: LinkedIncoming) => void>();
  private historyListeners = new Set<(cid: string) => void>();
  private peersListeners = new Set<() => void>();
  private unlinkedListeners = new Set<() => void>();
  private statusListeners = new Set<() => void>();

  constructor(
    readonly userId: string,
    private readonly db: MessengerDb,
    private readonly wrapKey: WrapKey,
    readonly link: LinkRecord,
  ) {
    this.self = {userId, deviceId: link.wsDeviceId};
    this.messages = new MessageStore(db, wrapKey);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  async startListening(): Promise<void> {
    this.cipher = await linkCipher(this.link.linkId, b64uDecode(this.link.key));
    this.peers = new Map(Object.entries((await getMetaWrapped<Record<string, LinkPeer>>(this.db, this.wrapKey, META_PEERS)) ?? {}));
    const self = await getMetaWrapped<{features?: LinkFeature[]}>(this.db, this.wrapKey, META_SELF);
    this.features = new Set(self?.features ?? []);
    for (const g of (await getMetaWrapped<LinkGroup[]>(this.db, this.wrapKey, META_GROUPS)) ?? []) this.groupMap.set(g.cid, g);
    this.contactBook = (await getMetaWrapped<LinkPeer[]>(this.db, this.wrapKey, META_CONTACTS)) ?? [];
    const synced = await this.db.get('meta', META_SYNCED);
    this.openSocket();
    this.pollTimer = setInterval(() => void this.drain(), POLL_MS);
    // First open after linking: the phone already pushed a snapshot, but ask
    // again in case this tab missed it (it is idempotent).
    if (!synced) {
      await this.command({t: 'sync', id: newLinkMsgId(), ts: Date.now()}).catch(() => undefined);
      await this.db.put('meta', {key: META_SYNCED, value: String(Date.now())});
    }
    void this.drain();
  }

  stopListening(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    try { this.socket?.disconnect(); } catch { /* ignore */ }
    this.socket = null;
  }

  close(): void {
    this.closed = true;
    this.stopListening();
    for (const t of this.readTimers.values()) clearTimeout(t);
    this.failPending('closed');
    try { this.db.close(); } catch { /* ignore */ }
  }

  /** Unlink this browser (either side may): forget the key and the mirrored history. */
  async unlink(): Promise<void> {
    try { await linkApi.revoke(this.link.linkId, this.link.wsDeviceId); } catch (e) {
      if (!(e instanceof LinkHttpError) || (e.status !== 404 && e.status !== 410 && e.status !== 403)) throw e;
    }
    await this.forgetLink();
  }

  private async forgetLink(): Promise<void> {
    this.stopListening();
    const tx = this.db.transaction(['messages', 'meta'], 'readwrite');
    await tx.objectStore('messages').clear();
    for (const k of [META_LINK, META_PEERS, META_SELF, META_SYNCED, META_GROUPS, META_CONTACTS]) await tx.objectStore('meta').delete(k);
    await tx.done;
    this.groupMap.clear(); this.contactBook = []; this.features.clear();
    this.failPending('unlinked');
    for (const fn of [...this.unlinkedListeners]) { try { fn(); } catch { /* ignore */ } }
  }

  async wipe(): Promise<void> {
    this.close();
    await new Promise<void>(res => {
      const req = indexedDB.deleteDatabase(`bravo-messenger-${this.userId}`);
      req.onsuccess = () => res(); req.onerror = () => res(); req.onblocked = () => res();
    });
  }

  private openSocket(): void {
    const base = messengerBase().replace(/^http/, 'ws').replace(/\/ws\/?$/, '');
    const socket = io(base, {
      path: '/ws',
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
      forceNew: true,
      // A function, so every (re)connect presents a fresh 5-minute ticket.
      auth: (cb: (d: object) => void) => {
        void getMessengerTicket().then(
          token => cb({token, signalDeviceId: this.link.wsDeviceId}),
          () => cb({token: '', signalDeviceId: this.link.wsDeviceId}),
        );
      },
    });
    socket.on('connect', () => void this.drain());
    socket.on('link.pending', (d: {linkId?: string; to?: string}) => {
      if (d?.linkId === this.link.linkId && d.to === 'web') void this.drain();
    });
    socket.on('link.revoked', (d: {linkId?: string}) => {
      if (d?.linkId === this.link.linkId) void this.forgetLink();
    });
    this.socket = socket;
  }

  // ── inbound from the phone ─────────────────────────────────────────────

  drain(): Promise<void> {
    if (this.closed || !this.cipher) return Promise.resolve();
    if (this.draining) { this.drainAgain = true; return this.draining; }
    this.draining = (async () => {
      try {
        do {
          this.drainAgain = false;
          for (let round = 0; round < 50; round++) {
            let page;
            try { page = await linkApi.inbox(this.link.linkId, this.link.wsDeviceId, this.cursor); }
            catch (e) {
              if (e instanceof LinkHttpError && (e.status === 410 || e.status === 403)) await this.forgetLink();
              return;
            }
            if (page.items.length === 0) break;
            let upTo = this.cursor;
            for (const it of page.items) {
              upTo = Math.max(upTo, it.seq);
              const msg = await this.cipher!.open('p2w', it.data) as PhoneToWeb | null;
              if (!msg || !this.replay.fresh(msg.id)) continue;
              try { await this.apply(msg); } catch (e) { console.warn('[link] apply failed', msg.t, e); }
            }
            this.cursor = upTo;
            try { await linkApi.ack(this.link.linkId, this.link.wsDeviceId, upTo); } catch { /* re-acked later */ }
            if (!page.more) break;
          }
        } while (this.drainAgain);
      } finally {
        this.draining = null;
      }
    })();
    return this.draining;
  }

  private async apply(msg: PhoneToWeb): Promise<void> {
    this.phoneSeenAt = Date.now();
    for (const fn of [...this.statusListeners]) { try { fn(); } catch { /* ignore */ } }
    switch (msg.t) {
      case 'hello':
        this.features = new Set(msg.features ?? []);
        await putMetaWrapped(this.db, this.wrapKey, META_SELF, {...msg.self, features: msg.features ?? []});
        this.emitGroups();
        return;
      case 'contacts':
        for (const c of msg.contacts) this.mergePeer(c);
        // Every contacts frame is the phone's whole list (older phones too).
        this.contactBook = msg.contacts.filter(c => c && (c.userId || c.phone));
        await putMetaWrapped(this.db, this.wrapKey, META_CONTACTS, this.contactBook);
        await this.savePeers();
        return;
      case 'groups': {
        if (msg.full) this.groupMap.clear();
        for (const g of msg.groups) {
          if (!isGroupCid(g.cid)) continue;
          this.groupMap.set(g.cid, g);
          for (const m of g.members) this.mergePeer({userId: m.userId, name: m.name, phone: m.phone});
        }
        await putMetaWrapped(this.db, this.wrapKey, META_GROUPS, [...this.groupMap.values()]);
        await this.savePeers();
        this.emitGroups();
        return;
      }
      case 'result': {
        const p = this.pendingResults.get(msg.ref);
        if (!p) return;
        this.pendingResults.delete(msg.ref);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve({cid: msg.cid ?? null, link: msg.link ?? null});
        else p.reject(new LinkCommandError(msg.error || 'Your phone could not do that.'));
        return;
      }
      case 'convs':
        for (const c of msg.conversations) this.mergePeer(c.peer);
        await this.savePeers();
        return;
      case 'msgs': {
        if (!msg.cid.startsWith('direct:') && !isGroupCid(msg.cid)) return;
        for (const r of msg.rows) await this.upsertRow(msg.cid, isGroupCid(msg.cid) ? (r.from ?? '') : msg.peerUserId, r, !!msg.history);
        this.emitHistory(msg.cid);
        return;
      }
      case 'status':
        await this.messages.patch(msg.cid, msg.msgId, {status: msg.status});
        this.emitHistory(msg.cid);
        return;
      case 'sent': {
        const cid = this.refToCid.get(msg.ref);
        this.refToCid.delete(msg.ref);
        if (!msg.ok && cid) {
          await this.messages.patch(cid, msg.ref, {status: 'failed'});
          this.emitHistory(cid);
        }
        return;
      }
      case 'bye':
        await this.forgetLink();
        return;
      default:
        return;
    }
  }

  private mergePeer(p: LinkPeer): void {
    if (!p?.userId) return;
    const prev = this.peers.get(p.userId);
    this.peers.set(p.userId, {userId: p.userId, name: p.name || prev?.name || null, phone: p.phone || prev?.phone || null,
      ...(p.source || prev?.source ? {source: p.source ?? prev?.source} : {})});
  }

  private async savePeers(): Promise<void> {
    await putMetaWrapped(this.db, this.wrapKey, META_PEERS, Object.fromEntries(this.peers));
    for (const fn of [...this.peersListeners]) { try { fn(); } catch { /* ignore */ } }
  }

  private async upsertRow(cid: string, peerUserId: string, r: LinkMsgRow, history: boolean): Promise<void> {
    const pk = `${cid}|${r.id}`;
    const existed = !!(await this.db.getKey('messages', pk));
    const row: StoredMessage = {
      conversationId: cid,
      id:             r.id,
      senderUserId:   r.dir === 'out' ? this.userId : peerUserId,
      direction:      r.dir,
      body:           r.body,
      sentAt:         r.at,
      envelopeId:     r.id,
      clientMsgId:    null,
      status:         r.status,
      reactions:      null,
      replyToId:      r.replyToId ?? null,
      attachment:     isLinkAttachment(r.att) ? r.att : null,
    };
    await this.messages.upsert(row);
    if (!existed && !history && r.dir === 'in') {
      const m: LinkedIncoming = {
        envelopeId: r.id, conversationId: cid, senderUserId: peerUserId, senderDeviceId: 1,
        body: r.body, receivedAt: r.at,
      };
      for (const fn of [...this.incomingListeners]) { try { fn(m); } catch { /* ignore */ } }
    }
  }

  // ── outbound to the phone ──────────────────────────────────────────────

  private async command(cmd: WebToPhone): Promise<void> {
    if (!this.cipher) this.cipher = await linkCipher(this.link.linkId, b64uDecode(this.link.key));
    const item = await this.cipher.seal('w2p', cmd);
    await linkApi.send(this.link.linkId, this.link.wsDeviceId, [item]);
  }

  /** Ask the phone to resend contacts, chats and recent history. */
  async resync(): Promise<void> {
    await this.command({t: 'sync', id: newLinkMsgId(), ts: Date.now()});
  }

  async sendDirect(peerUserId: string, body: string): Promise<{id: string; envelopeId: string | null}> {
    const text = body.trim();
    if (!text) throw new Error('empty message');
    const cid = `direct:${peerUserId}`;
    const ref = genRef();
    await this.messages.upsert({
      conversationId: cid, id: ref, senderUserId: this.userId, direction: 'out', body: text, sentAt: Date.now(),
      envelopeId: ref, clientMsgId: ref, status: 'sending', reactions: null, replyToId: null,
    });
    this.refToCid.set(ref, cid);
    this.emitHistory(cid);
    try {
      await this.command({t: 'send', id: newLinkMsgId(), ts: Date.now(), ref, peerUserId, text});
    } catch (e) {
      await this.messages.patch(cid, ref, {status: 'failed'});
      this.emitHistory(cid);
      throw e;
    }
    // The phone answers with the real row (same id) as it goes out.
    return {id: ref, envelopeId: ref};
  }

  /** 2026-10-23 — send to a mirrored group (`group:<id>`); the phone sends it. */
  async sendGroup(cid: string, body: string): Promise<{id: string; envelopeId: string | null}> {
    const text = body.trim();
    if (!text) throw new Error('empty message');
    if (!isGroupCid(cid)) throw new Error('not a group');
    const ref = genRef();
    await this.messages.upsert({
      conversationId: cid, id: ref, senderUserId: this.userId, direction: 'out', body: text, sentAt: Date.now(),
      envelopeId: ref, clientMsgId: ref, status: 'sending', reactions: null, replyToId: null,
    });
    this.refToCid.set(ref, cid);
    this.emitHistory(cid);
    try {
      await this.command({t: 'send', id: newLinkMsgId(), ts: Date.now(), ref, peerUserId: '', cid, text});
    } catch (e) {
      await this.messages.patch(cid, ref, {status: 'failed'});
      this.emitHistory(cid);
      throw e;
    }
    return {id: ref, envelopeId: ref};
  }

  // ── files (2026-10-27) ─────────────────────────────────────────────────

  /**
   * Send a file to a chat (`direct:<peer>` or `group:<id>`). The browser
   * encrypts and uploads it; the phone seals its key into the message and
   * sends it, exactly like a file sent from the app.
   */
  async sendFile(cid: string, file: File): Promise<{id: string; envelopeId: string | null}> {
    if (!this.features.has('files')) throw new Error('phone_app_too_old_for_files');
    const group = isGroupCid(cid);
    const peerUserId = group ? '' : cid.startsWith('direct:') ? cid.slice('direct:'.length) : '';
    if (!group && !peerUserId) throw new Error('not a chat');
    const ref = genRef();
    const label = `📎 ${file.name || 'File'}`;
    await this.messages.upsert({
      conversationId: cid, id: ref, senderUserId: this.userId, direction: 'out', body: label, sentAt: Date.now(),
      envelopeId: ref, clientMsgId: ref, status: 'sending', reactions: null, replyToId: null,
    });
    this.refToCid.set(ref, cid);
    this.emitHistory(cid);
    try {
      const attachment = await uploadFile(file, this.link.wsDeviceId);
      await this.messages.upsert({
        conversationId: cid, id: ref, senderUserId: this.userId, direction: 'out', body: label, sentAt: Date.now(),
        envelopeId: ref, clientMsgId: ref, status: 'sending', reactions: null, replyToId: null, attachment,
      });
      this.emitHistory(cid);
      await this.command({
        t: 'send', id: newLinkMsgId(), ts: Date.now(), ref, peerUserId, text: '',
        ...(group ? {cid} : {}), attachment,
      });
    } catch (e) {
      await this.messages.patch(cid, ref, {status: 'failed'});
      this.emitHistory(cid);
      throw e;
    }
    return {id: ref, envelopeId: ref};
  }

  /** Download and decrypt a file from a message in this browser. */
  async openFile(att: WebAttachment): Promise<Blob> {
    return downloadFile(att, this.link.wsDeviceId);
  }

  /** The linked phone's app can take files from this browser. */
  canSendFiles(): boolean { return this.features.has('files'); }

  // ── groups and contacts (2026-10-23) ───────────────────────────────────

  /** What the linked phone's app supports (older apps: nothing below). */
  hasFeature(f: LinkFeature): boolean { return this.features.has(f); }

  groups(): LinkGroup[] { return [...this.groupMap.values()].sort((a, b) => b.lastAt - a.lastAt); }
  group(cid: string): LinkGroup | null { return this.groupMap.get(cid) ?? null; }

  /** The phone's contacts: address book, added by hand (some not on Bravo yet), chat partners. */
  contactList(): LinkPeer[] { return this.contactBook.length ? [...this.contactBook] : [...this.peers.values()]; }

  /** Ask the phone to do something and wait for its answer. */
  private request(cmd: ManageInput): Promise<CommandResult> {
    const ref = genRef();
    return new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResults.delete(ref);
        reject(new LinkCommandError('Your phone did not answer. Make sure it is on and connected to the internet, then try again.'));
      }, COMMAND_TIMEOUT_MS);
      this.pendingResults.set(ref, {resolve, reject, timer});
      this.command({...cmd, id: newLinkMsgId(), ts: Date.now(), ref} as WebToPhone).catch(e => {
        clearTimeout(timer);
        this.pendingResults.delete(ref);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  private failPending(why: string): void {
    for (const [ref, p] of this.pendingResults) {
      clearTimeout(p.timer);
      p.reject(new LinkCommandError(why === 'unlinked' ? 'This browser is no longer linked to your phone.' : 'Closed.'));
      this.pendingResults.delete(ref);
    }
  }

  async createGroup(name: string, members: string[], description?: string): Promise<string> {
    const r = await this.request({t: 'groupCreate', name, members, description: description ?? null});
    return r.cid ?? '';
  }
  async addGroupMembers(cid: string, userIds: string[]): Promise<void> { await this.request({t: 'groupAdd', cid, userIds}); }
  async removeGroupMember(cid: string, userId: string): Promise<void> { await this.request({t: 'groupRemove', cid, userId}); }
  async editGroup(cid: string, edit: {name?: string; description?: string}): Promise<void> {
    await this.request({t: 'groupEdit', cid, name: edit.name ?? null, description: edit.description ?? null});
  }
  async leaveGroup(cid: string): Promise<void> { await this.request({t: 'groupLeave', cid}); }
  /** The group's invite link ('get' issues one when there is none); null after 'revoke'. */
  async groupInvite(cid: string, action: 'get' | 'reset' | 'revoke'): Promise<string | null> {
    return (await this.request({t: 'groupInvite', cid, action})).link ?? null;
  }
  async joinGroup(link: string): Promise<void> { await this.request({t: 'groupJoin', link}); }
  /** Saved on the phone (never on the server); returns the chat id when they are on Bravo. */
  async saveContact(name: string, phone: string): Promise<string | null> {
    return (await this.request({t: 'contactSave', name, phone})).cid ?? null;
  }
  async removeContact(contactId: string): Promise<void> { await this.request({t: 'contactRemove', contactId}); }

  onGroupsChange(fn: () => void): () => void { this.groupsListeners.add(fn); return () => { this.groupsListeners.delete(fn); }; }
  private emitGroups(): void {
    for (const fn of [...this.groupsListeners]) { try { fn(); } catch { /* ignore */ } }
  }

  async discardMessage(conversationId: string, id: string): Promise<void> {
    await this.messages.remove(conversationId, id);
    this.emitHistory(conversationId);
  }

  /** Mark read on the phone (it sends the read receipts). Debounced per chat. */
  markRead(conversationId: string, _envelopeIds?: string[]): void {
    if (!conversationId.startsWith('direct:') && !isGroupCid(conversationId)) return;
    const prev = this.readTimers.get(conversationId);
    if (prev) clearTimeout(prev);
    this.readTimers.set(conversationId, setTimeout(() => {
      this.readTimers.delete(conversationId);
      void this.command({t: 'read', id: newLinkMsgId(), ts: Date.now(), cid: conversationId}).catch(() => undefined);
    }, 1_200));
  }

  async loadConversation(conversationId: string, limit?: number): Promise<StoredMessage[]> {
    return this.messages.loadConversation(conversationId, limit);
  }

  async listConversations(): Promise<ConversationSummary[]> {
    return this.messages.listSummaries();
  }

  /** Ask the phone for older messages of a chat. */
  async requestOlder(conversationId: string, before: number, limit = 50): Promise<void> {
    await this.command({t: 'history', id: newLinkMsgId(), ts: Date.now(), cid: conversationId, before, limit});
  }

  // ── names (from the phone's contacts) ──────────────────────────────────

  peer(userId: string): LinkPeer | null { return this.peers.get(userId) ?? null; }

  /** The phone's Bravo contacts (and chat partners), as last synced. */
  contacts(): LinkPeer[] { return [...this.peers.values()]; }

  searchPeers(q: string): LinkPeer[] {
    const needle = q.trim().toLowerCase();
    const digits = needle.replace(/\D/g, '');
    if (!needle) return [];
    return [...this.peers.values()].filter(p =>
      (p.name ?? '').toLowerCase().includes(needle) || (digits.length >= 3 && (p.phone ?? '').replace(/\D/g, '').includes(digits)),
    ).slice(0, 20);
  }

  /** The vault this mirror lives in (kept open after an unlink, for re-linking). */
  vaultHandle(): {db: MessengerDb; wrapKey: WrapKey} { return {db: this.db, wrapKey: this.wrapKey}; }

  /** When something last arrived from the phone (0 = not in this session). */
  get lastPhoneActivity(): number { return this.phoneSeenAt; }

  // ── listener surface used by the chat UI ───────────────────────────────

  onIncoming(fn: (m: LinkedIncoming) => void): () => void { this.incomingListeners.add(fn); return () => { this.incomingListeners.delete(fn); }; }
  onHistoryChange(fn: (cid: string) => void): () => void { this.historyListeners.add(fn); return () => { this.historyListeners.delete(fn); }; }
  onPeersChange(fn: () => void): () => void { this.peersListeners.add(fn); return () => { this.peersListeners.delete(fn); }; }
  onUnlinked(fn: () => void): () => void { this.unlinkedListeners.add(fn); return () => { this.unlinkedListeners.delete(fn); }; }
  onPhoneActivity(fn: () => void): () => void { this.statusListeners.add(fn); return () => { this.statusListeners.delete(fn); }; }

  private emitHistory(cid: string): void {
    for (const fn of [...this.historyListeners]) { try { fn(cid); } catch { /* ignore */ } }
  }

  // Presence, typing and read receipts come through the phone's own socket;
  // the mirror does not carry them yet. No-ops keep the chat UI unchanged.
  onPresenceChange(_fn: (userId: string, p: PresenceState) => void): () => void { return () => undefined; }
  onTypingChange(_fn: (peerUserId: string, typing: boolean) => void): () => void { return () => undefined; }
  onReadReceipt(_fn: (peerUserId: string, envelopeIds: string[]) => void): () => void { return () => undefined; }
  subscribePresence(_ids: string[]): void { /* not mirrored */ }
  unsubscribePresence(_ids: string[]): void { /* not mirrored */ }
  sendTyping(_peer: {userId: string; deviceId: number}, _kind: 'start' | 'stop'): void { /* not mirrored */ }
  setActivity(_a: 'active' | 'away'): void { /* not mirrored */ }
  async rememberOnThisBrowser(_on: boolean): Promise<void> { /* the vault key stays remembered in linked mode */ }
}
