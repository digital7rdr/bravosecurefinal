/**
 * Linked devices — the phone side (2026-10-12).
 *
 * This phone stays the account's only Signal device. Each browser it is
 * linked to gets a mirror of the chats — 1:1 and (2026-10-23) groups, plus
 * the contacts (address book + added by hand): the phone forwards decrypted
 * conversations, contacts and every new / updated message, and sends what the
 * browser asks it to send. The channel is the messenger-service link inbox,
 * sealed with the per-link key the browser showed in its QR code (see
 * `@bravo/messenger-core/link/linkProtocol`). The server stores ciphertext only.
 *
 * Wiring:
 *  - `startLinkEngine()` — from the FCM bootstrap (interactive app) and from the
 *    headless drain (killed app). Idempotent.
 *  - store subscription → new / changed direct-chat rows are forwarded.
 *  - socket `link.pending` / FCM `link_wake` / a slow poll → `drainLinkInboxes()`
 *    runs the browser's commands (send, sync, read, history).
 *  - `approveLinkFromQr()` — the Linked devices screen after a scan.
 */
import {AppState} from 'react-native';
import {
  linkCipher, parseLinkQr, chunkRows, LinkReplayGuard, newLinkMsgId, b64uEncode, b64uDecode,
  groupCid, groupIdOfCid, isLinkAttachment,
  type LinkAttachment, type LinkCipher, type LinkMsgRow, type LinkMsgStatus, type PhoneToWeb, type WebToPhone,
  type LinkConversation, type LinkPeer, type LinkGroup, type LinkFeature,
} from '@bravo/messenger-core/link/linkProtocol';
import type {ServerFrame, TransportClient} from '@bravo/messenger-core';
import {MSG_BASE_URL} from '@utils/constants';
import {fetchWithRefresh} from '@/services/api';
import {saveLinkSecrets, loadLinkSecrets, clearLinkSecrets} from '../runtime/keychain';
import {onTransport} from '../runtime/transportRegistry';
import {getActiveOwnerKey, getMessengerRuntime} from '../runtime/runtime';
import {
  useMessengerStore, resolveDirectConversationIdFromState, directConversationSlots,
  directPlaceholderConversation,
} from '../store/messengerStore';
import type {LocalMessage, LocalConversation} from '../store/types';
import {directSlotId, isDirectPrefixed, peerFromDirectSlot} from '../conversationIds';
import {resolveDeptConversation} from '../push/deptChannelTarget';
import {withoutJoinMarker} from '@bravo/messenger-core/link/groupInvite';
import {
  loadManualContacts, manualContacts, onManualContactsChange, upsertManualContact, removeManualContact,
} from '../contacts/manualContacts';

/**
 * What this phone's link engine understands (2026-10-23). A browser shows the
 * group and contact controls only when the phone it mirrors says so.
 */
export const LINK_FEATURES: LinkFeature[] = ['groups', 'contacts.manual', 'groups.manage', 'groups.invite', 'groups.join',
  // 2026-10-27 — the browser sends files and opens the ones in its chats.
  'files'];

/** 2026-10-27 — the file on a message, for the browser to open (null when none). */
function attachmentOf(m: LocalMessage): LinkAttachment | null {
  if (m.deleted_for_all || !m.media_object_key || !m.media_key || !m.media_iv) {return null;}
  if (m.type !== 'image' && m.type !== 'audio' && m.type !== 'video' && m.type !== 'file') {return null;}
  return {
    objectKey: m.media_object_key,
    keyB64: m.media_key,
    ivB64: m.media_iv,
    mimeType: m.media_mime ?? 'application/octet-stream',
    size: m.media_meta?.sizeBytes ?? 0,
    name: m.media_meta?.name ?? null,
    kind: m.type,
  };
}

// ── types ────────────────────────────────────────────────────────────────────

interface StoredLink { linkId: string; key: string; label: string; approvedAt: number }
interface ActiveLink extends StoredLink { cipher: LinkCipher }

export interface LinkedDeviceView {
  linkId:     string;
  label:      string;
  approvedAt: number;
  lastSeenAt: number;
  /** True when this phone holds the link key (it can mirror to it). */
  mirrored:   boolean;
}

type MessengerSnapshot = ReturnType<typeof useMessengerStore.getState>;

/** Messages per conversation sent at link time / on a browser "sync". */
const SNAPSHOT_PER_CONVERSATION = 60;
const SNAPSHOT_MAX_CONVERSATIONS = 150;
const FLUSH_DELAY_MS = 300;
const POLL_MS = 45_000;
const ITEMS_PER_POST = 40;

// ── module state ─────────────────────────────────────────────────────────────

let links: ActiveLink[] = [];
let loadedFor: string | null = null;
let loading: Promise<void> | null = null;
let started = false;
let unsubStore: (() => void) | null = null;
let unsubTransport: (() => void) | null = null;
let unsubFrames: (() => void) | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let appStateSub: {remove: () => void} | null = null;

const seen = new Map<string, Set<string>>();     // cid → message ids already forwarded / baselined
const pending = new Map<string, {peerUserId: string; rows: Map<string, LinkMsgRow>}>();
let convsDirty = false;
let groupsDirty = false;
let contactsDirty = false;
let unsubContacts: (() => void) | null = null;
let unsubDiscovery: (() => void) | null = null;
/** What the browsers were last sent as the contact list (skip identical re-sends). */
let lastContactsSig = '';
let lastContactsRefreshAt = 0;
/** Re-read the address book for the browsers at most this often (app opened). */
const CONTACTS_REFRESH_MS = 60_000;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;
/**
 * The approve-time snapshot runs in the background (the Linked devices screen
 * closes straight away). Tracked so the bounded flush (headless wake, tests)
 * waits for it instead of racing it.
 */
let snapshotting: Promise<void> | null = null;
let draining: Promise<void> | null = null;
let drainAgain = false;
const cursors = new Map<string, number>();
const replay = new LinkReplayGuard();
const listeners = new Set<() => void>();

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetchWithRefresh(`${MSG_BASE_URL}/link${path}`, {
    method,
    headers: {'Content-Type': 'application/json', 'X-Signal-Device-Id': '1'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  if (!res.ok) {
    let code = `http_${res.status}`;
    try { const j = await res.json() as {message?: string}; if (j?.message) {code = String(j.message);} } catch { /* no body */ }
    throw Object.assign(new Error(code), {status: res.status});
  }
  if (res.status === 204) {return undefined as T;}
  return await res.json() as T;
}

// ── secrets ──────────────────────────────────────────────────────────────────

function ownerKey(): string | null {
  return getActiveOwnerKey() ?? useMessengerStore.getState()._ownUserId ?? null;
}

async function ensureLoaded(): Promise<void> {
  const owner = ownerKey();
  if (!owner) {links = []; loadedFor = null; return;}
  if (loadedFor === owner) {return;}
  if (loading) {return loading;}
  loading = (async () => {
    try {
      const raw = await loadLinkSecrets(owner);
      const stored: StoredLink[] = raw ? (JSON.parse(raw) as StoredLink[]) : [];
      const next: ActiveLink[] = [];
      for (const s of stored) {
        try { next.push({...s, cipher: await linkCipher(s.linkId, b64uDecode(s.key))}); } catch { /* skip a bad row */ }
      }
      links = next;
      loadedFor = owner;
    } catch (e) {
      console.warn('[link] load secrets failed:', (e as Error).message);
      links = [];
    } finally {
      loading = null;
    }
  })();
  return loading;
}

async function persist(): Promise<void> {
  const owner = ownerKey();
  if (!owner) {return;}
  const stored: StoredLink[] = links.map(({linkId, key, label, approvedAt}) => ({linkId, key, label, approvedAt}));
  if (stored.length === 0) {await clearLinkSecrets(owner);}
  else {await saveLinkSecrets(owner, JSON.stringify(stored));}
  notify();
}

function notify(): void {
  for (const fn of [...listeners]) {try { fn(); } catch { /* ignore */ }}
}

/** Re-render hook for the Linked devices screen. */
export function onLinkedDevicesChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// ── row mapping ──────────────────────────────────────────────────────────────

function mediaLabel(m: LocalMessage): string {
  switch (m.type) {
    case 'image': return '📷 Photo';
    case 'video': return '🎬 Video';
    case 'audio': return '🎤 Voice message';
    case 'file':  return `📎 ${m.media_meta?.name ?? 'File'}`;
    case 'call':  return '📞 Call';
    default:      return '';
  }
}

function toRow(m: LocalMessage, group = false): LinkMsgRow | null {
  const at = Date.parse(m.created_at);
  if (!Number.isFinite(at)) {return null;}
  let body: string;
  if (m.deleted_for_all) {body = '🚫 This message was deleted';}
  else if (m.type === 'text' || m.type === 'system') {body = withoutJoinMarker(m.content ?? '');}
  else {
    const label = mediaLabel(m);
    const caption = m.type === 'call' ? '' : (m.content ?? '').trim();
    // 2026-10-27 — a file the browser can open needs no "open it in the app".
    const openable = !!attachmentOf(m);
    body = caption && !caption.startsWith('{') ? `${label}\n${caption}`
      : openable || m.type === 'call' ? label : `${label} — open it in the Bravo app`;
  }
  const att = attachmentOf(m);
  const status: LinkMsgStatus = m.status === 'undelivered' ? 'failed' : (m.status as LinkMsgStatus);
  return {
    id: m.id,
    dir: m.sender_id === 'self' ? 'out' : 'in',
    body: body.slice(0, 20_000),
    at,
    status: ['sending', 'sent', 'delivered', 'read', 'failed'].includes(status) ? status : 'sent',
    kind: m.type,
    replyToId: m.reply_to_msg_id ?? null,
    ...(group && m.sender_id !== 'self' ? {from: m.sender_id || m.peer?.userId || null} : {}),
    ...(att ? {att} : {}),
  };
}

/**
 * The phone conversation id of a group this phone mirrors, or null. Plain
 * group chats and mission rooms are mirrored; department channels are not
 * (they live in the workspace, like on the phone).
 */
function mirroredGroupId(state: MessengerSnapshot, cid: string): string | null {
  const c = state.conversations[cid];
  if (!c || c.type !== 'group') {return null;}
  const dept = resolveDeptConversation(cid, {
    deptConversationIds: state.deptConversationIds, deptGroupByChannel: state.deptGroupByChannel,
  });
  return dept ? null : cid;
}

/** userId → the best name / number this phone knows (sync, no network). */
function nameBook(state: MessengerSnapshot): Map<string, {name: string | null; phone: string | null}> {
  const out = new Map<string, {name: string | null; phone: string | null}>();
  const put = (userId: string | null | undefined, name: string | null | undefined, phone: string | null | undefined) => {
    if (!userId) {return;}
    const prev = out.get(userId);
    out.set(userId, {name: prev?.name || name || null, phone: prev?.phone || phone || null});
  };
  for (const r of manualContacts()) {put(r.userId, r.name, r.phoneE164);}
  try {
    const dc = require('../contacts/useDiscoveredContacts') as typeof import('../contacts/useDiscoveredContacts');
    for (const r of dc.latestDiscoveredContacts() ?? []) {put(r.userId, r.localName || r.displayName, r.phoneE164);}
  } catch { /* optional */ }
  for (const c of Object.values(state.conversations)) {
    if (c.type === 'direct' && c.peer?.userId) {
      put(c.peer.userId, c.name && !c.name.startsWith('Bravo · ') ? c.name : null, c.phoneE164 ?? null);
    }
  }
  return out;
}

function groupsView(state: MessengerSnapshot): LinkGroup[] {
  const self = state._ownAuthUserId ?? null;
  const names = nameBook(state);
  const out: LinkGroup[] = [];
  for (const id of state.conversationOrder) {
    if (!mirroredGroupId(state, id)) {continue;}
    const c = state.conversations[id];
    const g = state.groups[id];
    const ids = g ? Object.keys(g.members) : [...new Set([...(c.rosterUserIds ?? []), ...(c.participants ?? [])])];
    const overrides = state.groupMemberNames?.[id] ?? {};
    const admin = !!(self && g?.members[self]?.admin);
    const lastAt = c.last_message ? Date.parse(c.last_message.created_at) : Date.parse(c.created_at);
    out.push({
      cid: groupCid(id),
      name: c.name || g?.name || 'Group',
      description: g?.description ?? null,
      members: ids.filter(Boolean).map(uid => ({
        userId: uid,
        name: overrides[uid] ?? names.get(uid)?.name ?? null,
        phone: names.get(uid)?.phone ?? null,
        admin: !!g?.members[uid]?.admin,
      })),
      admin,
      manageable: admin && !!g?.saltB64,
      unread: c.unread_count ?? 0,
      lastAt: Number.isFinite(lastAt) ? lastAt : 0,
      pinned: !!c.is_pinned,
    });
  }
  return out.sort((a, b) => b.lastAt - a.lastAt);
}

function groupRows(state: MessengerSnapshot, groupId: string): LocalMessage[] {
  return [...(state.messages[groupId] ?? [])].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

function directPeer(state: MessengerSnapshot, cid: string): string | null {
  const conv = state.conversations[cid];
  if (conv) {return conv.type === 'direct' ? (conv.peer?.userId ?? null) : null;}
  return isDirectPrefixed(cid) ? peerFromDirectSlot(cid) : null;
}

/** Every slot's rows for a peer, newest last, de-duplicated by id. */
function peerRows(state: MessengerSnapshot, cid: string): LocalMessage[] {
  const byId = new Map<string, LocalMessage>();
  for (const slot of directConversationSlots(state, cid)) {
    for (const m of state.messages[slot] ?? []) {byId.set(m.id, m);}
  }
  return [...byId.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

function conversationsView(state: MessengerSnapshot): LinkConversation[] {
  const byPeer = new Map<string, LinkConversation>();
  // 2026-10-25 — a chat still on its `Bravo · <hex>` placeholder used to go
  // to the browser with NO name, and the browser showed "Bravo user". Fall
  // back to every name this phone knows (address book, hand-added contacts,
  // other slots of the same person) before giving up.
  const names = nameBook(state);
  for (const id of state.conversationOrder) {
    const c: LocalConversation | undefined = state.conversations[id];
    if (!c || c.type !== 'direct' || !c.peer?.userId) {continue;}
    const peerUserId = c.peer.userId;
    const lastAt = c.last_message ? Date.parse(c.last_message.created_at) : Date.parse(c.created_at);
    const prev = byPeer.get(peerUserId);
    const known = names.get(peerUserId);
    const name = (c.name && !c.name.startsWith('Bravo · ') ? c.name : null)
      ?? prev?.peer.name ?? known?.name ?? null;
    byPeer.set(peerUserId, {
      cid: directSlotId(peerUserId),
      peer: {userId: peerUserId, name, phone: c.phoneE164 ?? prev?.peer.phone ?? known?.phone ?? null},
      unread: (prev?.unread ?? 0) + (c.unread_count ?? 0),
      lastAt: Math.max(prev?.lastAt ?? 0, Number.isFinite(lastAt) ? lastAt : 0),
      pinned: !!c.is_pinned || !!prev?.pinned,
    });
  }
  return [...byPeer.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/**
 * `fresh` re-reads the address book (passively: never a permission prompt)
 * instead of using this session's last sweep.
 */
async function contactsView(state: MessengerSnapshot, opts: {fresh?: boolean} = {}): Promise<LinkPeer[]> {
  const out = new Map<string, LinkPeer>();
  try {
    const dc = require('../contacts/useDiscoveredContacts') as typeof import('../contacts/useDiscoveredContacts');
    let rows = opts.fresh ? null : dc.latestDiscoveredContacts();
    if (!rows) {
      const {getDirectoryUsersClient} = require('../contacts/directoryNames') as typeof import('../contacts/directoryNames');
      const {useAuthStore} = require('@store/authStore') as typeof import('@store/authStore');
      rows = await dc.discoverContactsPassive(getDirectoryUsersClient(), useAuthStore.getState().user?.phone_e164 ?? null);
    }
    for (const r of rows ?? []) {
      out.set(r.userId, {userId: r.userId, name: r.localName || r.displayName, phone: r.phoneE164, source: 'phone'});
    }
  } catch (e) {
    console.warn('[link] contacts unavailable:', (e as Error).message);
  }
  // Added by hand in Messenger: their own name wins over the address book's.
  try { await loadManualContacts(ownerKey()); } catch { /* optional */ }
  const notOnBravo: LinkPeer[] = [];
  for (const r of manualContacts()) {
    const peer: LinkPeer = {userId: r.userId ?? '', name: r.name, phone: r.phoneE164, source: 'manual', contactId: r.id};
    if (r.userId) {out.set(r.userId, peer);} else {notOnBravo.push(peer);}
  }
  for (const c of conversationsView(state)) {
    if (!out.has(c.peer.userId)) {out.set(c.peer.userId, {...c.peer, source: 'chat'});}
  }
  return [...out.values(), ...notOnBravo];
}

// ── sending to browsers ──────────────────────────────────────────────────────

function stamp<T extends {t: string}>(m: T): T & {id: string; ts: number} {
  return {...m, id: newLinkMsgId(), ts: Date.now()};
}

async function sendTo(link: ActiveLink, msgs: PhoneToWeb[]): Promise<void> {
  const items: string[] = [];
  for (const m of msgs) {items.push(await link.cipher.seal('p2w', m));}
  for (let i = 0; i < items.length; i += ITEMS_PER_POST) {
    // A link forgotten while this was sealing (unlink, sign-out, engine
    // stopped) gets nothing more — its browser is no longer ours to feed.
    if (!links.some(l => l.linkId === link.linkId && l.key === link.key)) {return;}
    try {
      await api('POST', `/${link.linkId}/send`, {to: 'web', items: items.slice(i, i + ITEMS_PER_POST)});
    } catch (e) {
      const status = (e as {status?: number}).status;
      if (status === 410 || status === 403) {
        // The browser unlinked (or the link expired): stop mirroring to it.
        await forgetLocal(link.linkId);
        return;
      }
      throw e;
    }
  }
}

async function broadcast(msgs: PhoneToWeb[]): Promise<void> {
  await ensureLoaded();
  await Promise.all(links.map(l => sendTo(l, msgs).catch(e => console.warn('[link] send failed:', (e as Error).message))));
}

function msgsFrames(cid: string, peerUserId: string, rows: LinkMsgRow[], history = false): PhoneToWeb[] {
  return chunkRows(rows).map(chunk => stamp({t: 'msgs' as const, cid, peerUserId, rows: chunk, ...(history ? {history: true} : {})}));
}

async function snapshotFrames(perConversation = SNAPSHOT_PER_CONVERSATION): Promise<PhoneToWeb[]> {
  const state = useMessengerStore.getState();
  const frames: PhoneToWeb[] = [];
  let selfName: string | null = null;
  try {
    const {useAuthStore} = require('@store/authStore') as typeof import('@store/authStore');
    const u = useAuthStore.getState().user as {full_name?: string; name?: string} | null;
    selfName = u?.full_name ?? u?.name ?? null;
  } catch { /* optional */ }
  frames.push(stamp({t: 'hello' as const, self: {userId: state._ownAuthUserId ?? '', name: selfName}, features: LINK_FEATURES}));
  const contacts = await contactsView(state);
  lastContactsSig = JSON.stringify(contacts);
  frames.push(stamp({t: 'contacts' as const, contacts}));
  const convs = conversationsView(state).slice(0, SNAPSHOT_MAX_CONVERSATIONS);
  frames.push(stamp({t: 'convs' as const, conversations: convs, full: true}));
  const groups = groupsView(state).slice(0, SNAPSHOT_MAX_CONVERSATIONS);
  frames.push(stamp({t: 'groups' as const, groups, full: true}));
  const n = Math.max(1, Math.min(200, perConversation));
  for (const c of convs) {
    const rows = peerRows(state, c.cid).slice(-n).map(m => toRow(m)).filter((r): r is LinkMsgRow => !!r);
    if (rows.length) {frames.push(...msgsFrames(c.cid, c.peer.userId, rows, true));}
  }
  for (const g of groups) {
    const id = groupIdOfCid(g.cid)!;
    const rows = groupRows(state, id).slice(-n).map(m => toRow(m, true)).filter((r): r is LinkMsgRow => !!r);
    if (rows.length) {frames.push(...msgsFrames(g.cid, '', rows, true));}
  }
  return frames;
}

// ── store forwarding ─────────────────────────────────────────────────────────

function baseline(state: MessengerSnapshot): void {
  seen.clear();
  for (const [cid, list] of Object.entries(state.messages)) {
    seen.set(cid, new Set(list.map(m => m.id)));
  }
}

/** `key` is the browser thread id: `direct:<peer>` or `group:<id>`. */
function queueRow(key: string, peerUserId: string, row: LinkMsgRow): void {
  let q = pending.get(key);
  if (!q) {q = {peerUserId, rows: new Map()}; pending.set(key, q);}
  q.rows.set(row.id, row);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer) {return;}
  flushTimer = setTimeout(() => { flushTimer = null; void flushNow(); }, FLUSH_DELAY_MS);
}

async function flushNow(): Promise<void> {
  if (flushing) {await flushing; if (pending.size === 0 && !convsDirty && !groupsDirty && !contactsDirty) {return;}}
  flushing = (async () => {
    try {
      if (links.length === 0) {pending.clear(); convsDirty = false; groupsDirty = false; contactsDirty = false; return;}
      const frames: PhoneToWeb[] = [];
      const batch = [...pending.entries()];
      pending.clear();
      for (const [cid, q] of batch) {
        frames.push(...msgsFrames(cid, q.peerUserId, [...q.rows.values()].sort((a, b) => a.at - b.at)));
      }
      if (convsDirty) {
        convsDirty = false;
        frames.push(stamp({t: 'convs' as const, conversations: conversationsView(useMessengerStore.getState()).slice(0, SNAPSHOT_MAX_CONVERSATIONS), full: false}));
      }
      if (groupsDirty) {
        groupsDirty = false;
        frames.push(stamp({t: 'groups' as const, groups: groupsView(useMessengerStore.getState()).slice(0, SNAPSHOT_MAX_CONVERSATIONS), full: true}));
      }
      if (contactsDirty) {
        contactsDirty = false;
        const contacts = await contactsView(useMessengerStore.getState());
        const sig = JSON.stringify(contacts);
        if (sig !== lastContactsSig) {
          lastContactsSig = sig;
          frames.push(stamp({t: 'contacts' as const, contacts}));
        }
      }
      if (frames.length) {await broadcast(frames);}
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

function onStoreChange(state: MessengerSnapshot, prev: MessengerSnapshot): void {
  if (links.length === 0) {return;}
  if (state.hydrationGeneration !== prev.hydrationGeneration) {baseline(state); return;}
  if (state.conversations !== prev.conversations || state.conversationOrder !== prev.conversationOrder) {
    convsDirty = true;
    groupsDirty = true;
    scheduleFlush();
  }
  if (state.groups !== prev.groups || state.groupMemberNames !== prev.groupMemberNames) {
    groupsDirty = true;
    scheduleFlush();
  }
  if (state.messages === prev.messages) {return;}
  for (const [cid, list] of Object.entries(state.messages)) {
    const before = prev.messages[cid];
    if (list === before) {continue;}
    const groupId = mirroredGroupId(state, cid);
    const peerUserId = groupId ? '' : directPeer(state, cid);
    if (!groupId && !peerUserId) {continue;}
    const key = groupId ? groupCid(groupId) : directSlotId(peerUserId!);
    let ids = seen.get(cid);
    if (!ids) {ids = new Set(); seen.set(cid, ids);}
    const prevById = new Map((before ?? []).map(m => [m.id, m]));
    for (const m of list) {
      const p = prevById.get(m.id);
      const isNew = !p && !ids.has(m.id);
      const changed = !!p && (p.status !== m.status || p.content !== m.content || p.deleted_for_all !== m.deleted_for_all);
      if (!isNew && !changed) {continue;}
      ids.add(m.id);
      const row = toRow(m, !!groupId);
      if (row) {queueRow(key, peerUserId ?? '', row);}
    }
  }
}

// ── browser commands ─────────────────────────────────────────────────────────

async function reply(link: ActiveLink, msg: PhoneToWeb): Promise<void> {
  await sendTo(link, [msg]);
}

async function runCommand(link: ActiveLink, cmd: WebToPhone): Promise<void> {
  switch (cmd.t) {
    case 'sync': {
      await sendTo(link, await snapshotFrames(cmd.perConversation));
      return;
    }
    case 'send': {
      const text = String(cmd.text ?? '').slice(0, 20_000);
      // 2026-10-27 — a file the browser encrypted and uploaded itself; the
      // phone seals its key into the message like any attachment it sends.
      const attachment = isLinkAttachment(cmd.attachment) ? {
        objectKey: cmd.attachment.objectKey, keyB64: cmd.attachment.keyB64, ivB64: cmd.attachment.ivB64,
        mimeType: cmd.attachment.mimeType, size: cmd.attachment.size,
        kind: cmd.attachment.kind ?? 'file',
        ...(cmd.attachment.name ? {name: cmd.attachment.name} : {}),
      } : undefined;
      if ((!text.trim() && !attachment) || !cmd.ref) {return;}
      const gid = cmd.cid ? groupIdOfCid(cmd.cid) : null;
      if (gid) {
        try {
          if (!mirroredGroupId(useMessengerStore.getState(), gid)) {throw new Error('group_not_found');}
          const rt = await getMessengerRuntime('production');
          let replyTo: {messageId: string; preview: string} | undefined;
          if (cmd.replyToId) {
            const q = groupRows(useMessengerStore.getState(), gid).find(m => m.id === cmd.replyToId);
            if (q) {replyTo = {messageId: q.id, preview: (q.content ?? '').slice(0, 120)};}
          }
          await rt.sendText(gid, text, {isGroup: true, stableMsgId: cmd.ref, ...(replyTo ? {replyTo} : {}),
            ...(attachment ? {attachment} : {})});
          await reply(link, stamp({t: 'sent' as const, ref: cmd.ref, ok: true}));
        } catch (e) {
          await reply(link, stamp({t: 'sent' as const, ref: cmd.ref, ok: false, error: (e as Error).message?.slice(0, 200) ?? 'send_failed'}));
        }
        return;
      }
      if (!cmd.peerUserId) {return;}
      try {
        const rt = await getMessengerRuntime('production');
        const st = useMessengerStore.getState();
        const cid = resolveDirectConversationIdFromState(st, cmd.peerUserId);
        const peer = {userId: cmd.peerUserId, deviceId: 1};
        if (isDirectPrefixed(cid) && !st.conversations[cid]) {
          st.upsertConversation(directPlaceholderConversation(cid, cmd.peerUserId, peer, new Date().toISOString()));
        }
        let replyTo: {messageId: string; preview: string} | undefined;
        if (cmd.replyToId) {
          const q = peerRows(useMessengerStore.getState(), cid).find(m => m.id === cmd.replyToId);
          if (q) {replyTo = {messageId: q.id, preview: (q.content ?? '').slice(0, 120)};}
        }
        await rt.sendText(cid, text, {peer, stableMsgId: cmd.ref, ...(replyTo ? {replyTo} : {}),
          ...(attachment ? {attachment} : {})});
        await reply(link, stamp({t: 'sent' as const, ref: cmd.ref, ok: true}));
      } catch (e) {
        await reply(link, stamp({t: 'sent' as const, ref: cmd.ref, ok: false, error: (e as Error).message?.slice(0, 200) ?? 'send_failed'}));
      }
      return;
    }
    case 'read': {
      const gid = groupIdOfCid(cmd.cid);
      if (gid) {
        if (!mirroredGroupId(useMessengerStore.getState(), gid)) {return;}
        try { (await getMessengerRuntime('production')).markRead(gid); } catch { /* best-effort */ }
        try { useMessengerStore.getState().clearUnreadForConversation(gid); } catch { /* ignore */ }
        return;
      }
      const peerUserId = cmd.cid && isDirectPrefixed(cmd.cid) ? peerFromDirectSlot(cmd.cid) : null;
      if (!peerUserId) {return;}
      const st = useMessengerStore.getState();
      const cid = resolveDirectConversationIdFromState(st, peerUserId);
      try {
        const rt = await getMessengerRuntime('production');
        for (const slot of directConversationSlots(st, cid)) {
          if (st.messages[slot]?.length) {rt.markRead(slot);}
        }
      } catch { /* receipts are best-effort */ }
      try { useMessengerStore.getState().clearUnreadForConversation(cid); } catch { /* ignore */ }
      return;
    }
    case 'history': {
      const gid = groupIdOfCid(cmd.cid);
      if (gid) {
        if (!mirroredGroupId(useMessengerStore.getState(), gid)) {return;}
        const limit = Math.max(1, Math.min(200, Number(cmd.limit) || 50));
        const older = (): LocalMessage[] => groupRows(useMessengerStore.getState(), gid).filter(m => Date.parse(m.created_at) < cmd.before);
        if (older().length < limit) {
          try { await (await getMessengerRuntime('production')).loadOlderMessages?.(gid, limit); } catch { /* send what we have */ }
        }
        const rows = older().slice(-limit).map(m => toRow(m, true)).filter((r): r is LinkMsgRow => !!r);
        await sendTo(link, rows.length
          ? msgsFrames(cmd.cid, '', rows, true)
          : [stamp({t: 'msgs' as const, cid: cmd.cid, peerUserId: '', rows: [], history: true})]);
        return;
      }
      const peerUserId = cmd.cid && isDirectPrefixed(cmd.cid) ? peerFromDirectSlot(cmd.cid) : null;
      if (!peerUserId) {return;}
      const limit = Math.max(1, Math.min(200, Number(cmd.limit) || 50));
      const cid = resolveDirectConversationIdFromState(useMessengerStore.getState(), peerUserId);
      const older = (): LocalMessage[] => peerRows(useMessengerStore.getState(), cid).filter(m => Date.parse(m.created_at) < cmd.before);
      if (older().length < limit) {
        try {
          const rt = await getMessengerRuntime('production');
          await rt.loadOlderMessages?.(cid, limit);
        } catch { /* send what we have */ }
      }
      const rows = older().slice(-limit).map(m => toRow(m)).filter((r): r is LinkMsgRow => !!r);
      const frames = rows.length
        ? msgsFrames(directSlotId(peerUserId), peerUserId, rows, true)
        : [stamp({t: 'msgs' as const, cid: directSlotId(peerUserId), peerUserId, rows: [], history: true})];
      await sendTo(link, frames);
      return;
    }
    case 'groupCreate': case 'groupAdd': case 'groupRemove': case 'groupEdit': case 'groupLeave':
    case 'groupInvite': case 'groupJoin': case 'contactSave': case 'contactRemove': {
      if (!cmd.ref) {return;}
      try {
        const out = await runManageCommand(cmd);
        await reply(link, stamp({t: 'result' as const, ref: cmd.ref, ok: true, ...out}));
      } catch (e) {
        await reply(link, stamp({t: 'result' as const, ref: cmd.ref, ok: false, error: manageErrorText(e)}));
      }
      return;
    }
    default:
      return;
  }
}

type ManageCmd = Extract<WebToPhone, {t: 'groupCreate' | 'groupAdd' | 'groupRemove' | 'groupEdit' | 'groupLeave' | 'groupInvite' | 'groupJoin' | 'contactSave' | 'contactRemove'}>;

/** A short, human reason for the browser (never a stack or an id dump). */
function manageErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  if ((e as {code?: string} | null)?.code === 'GROUP_MEMBERS_UNREACHABLE') {
    return "The people you picked haven't opened Bravo Messenger yet, so they can't receive the group key.";
  }
  if (/transport not open|network|timed? ?out|offline/i.test(msg)) {return 'Your phone is offline. Try again when it is connected.';}
  if (/only admins|only a group admin/i.test(msg)) {return 'Only a group admin can do that.';}
  if (/already a member|already in group/i.test(msg)) {return 'Already in the group.';}
  if (/not a member/i.test(msg)) {return 'They are no longer in the group.';}
  // Messages written for people (ContactInputError, JoinLinkError) pass through.
  if (msg && msg.length <= 160 && !/[{}]|\b[0-9a-f]{8}-[0-9a-f]{4}/i.test(msg) && /^[A-Z]/.test(msg)) {return msg;}
  return 'Your phone could not do that. Try again.';
}

function groupForCmd(cid: string): string {
  const gid = groupIdOfCid(cid);
  if (!gid || !mirroredGroupId(useMessengerStore.getState(), gid)) {throw new Error('That group is not on your phone any more.');}
  return gid;
}

function manageableGroup(cid: string): string {
  const gid = groupForCmd(cid);
  const st = useMessengerStore.getState();
  const self = st._ownAuthUserId;
  const g = st.groups[gid];
  if (!g || !self || !g.members[self]?.admin) {throw new Error('Only a group admin can do that.');}
  if (!g.saltB64) {throw new Error('Members of this group are managed by dispatch.');}
  return gid;
}

async function runManageCommand(cmd: ManageCmd): Promise<{cid?: string | null; link?: string | null}> {
  const rt = await getMessengerRuntime('production');
  switch (cmd.t) {
    case 'groupCreate': {
      const name = String(cmd.name ?? '').trim();
      const members = [...new Set((cmd.members ?? []).filter(x => typeof x === 'string' && x))].slice(0, 256);
      if (!name) {throw new Error('Enter a group name.');}
      if (members.length === 0) {throw new Error('Pick at least one member.');}
      const res = await rt.createGroupChat({name, members});
      const desc = String(cmd.description ?? '').trim();
      if (desc && rt.setGroupDescription) {
        try { await rt.setGroupDescription({groupId: res.groupId, description: desc}); } catch { /* the group exists; the description can be set later */ }
      }
      groupsDirty = true; scheduleFlush();
      return {cid: groupCid(res.conversationId)};
    }
    case 'groupAdd': {
      const gid = manageableGroup(cmd.cid);
      if (!rt.addGroupMember) {throw new Error('Update the Bravo app on your phone to add members from here.');}
      const failed: string[] = [];
      for (const userId of [...new Set(cmd.userIds ?? [])].slice(0, 50)) {
        if (useMessengerStore.getState().groups[gid]?.members[userId]) {continue;}
        try { await rt.addGroupMember({groupId: gid, newMember: {userId, deviceId: 1}}); } catch { failed.push(userId); }
      }
      groupsDirty = true; scheduleFlush();
      if (failed.length) {
        throw new Error(failed.length === 1
          ? 'One person could not be added — they may not have opened Bravo Messenger yet.'
          : `${failed.length} people could not be added — they may not have opened Bravo Messenger yet.`);
      }
      return {cid: cmd.cid};
    }
    case 'groupRemove': {
      const gid = manageableGroup(cmd.cid);
      if (!rt.removeGroupMember) {throw new Error('Update the Bravo app on your phone to remove members from here.');}
      await rt.removeGroupMember({groupId: gid, removedUserId: cmd.userId});
      groupsDirty = true; scheduleFlush();
      return {cid: cmd.cid};
    }
    case 'groupEdit': {
      const gid = groupForCmd(cmd.cid);
      const st = useMessengerStore.getState();
      if (!st.groups[gid]?.members[st._ownAuthUserId ?? '']?.admin) {throw new Error('Only a group admin can do that.');}
      if (typeof cmd.name === 'string' && cmd.name.trim() && cmd.name.trim() !== (st.conversations[gid]?.name ?? st.groups[gid]?.name)) {
        if (!rt.renameGroup) {throw new Error('Update the Bravo app on your phone to rename groups from here.');}
        await rt.renameGroup({groupId: gid, name: cmd.name});
      }
      if (typeof cmd.description === 'string') {
        if (!rt.setGroupDescription) {throw new Error('Update the Bravo app on your phone to edit descriptions from here.');}
        await rt.setGroupDescription({groupId: gid, description: cmd.description});
      }
      groupsDirty = true; scheduleFlush();
      return {cid: cmd.cid};
    }
    case 'groupLeave': {
      const gid = groupForCmd(cmd.cid);
      if (!rt.leaveGroup) {throw new Error('Update the Bravo app on your phone to leave groups from here.');}
      await rt.leaveGroup({groupId: gid});
      groupsDirty = true; scheduleFlush();
      return {cid: cmd.cid};
    }
    case 'groupInvite': {
      const gid = manageableGroup(cmd.cid);
      const inv = require('../groups/groupInvites') as typeof import('../groups/groupInvites');
      if (cmd.action === 'revoke') {await inv.revokeGroupInvite(gid); return {cid: cmd.cid, link: null};}
      const linkText = cmd.action === 'reset' ? await inv.resetGroupInvite(gid) : await inv.issueGroupInvite(gid);
      return {cid: cmd.cid, link: linkText};
    }
    case 'groupJoin': {
      const inv = require('../groups/groupInvites') as typeof import('../groups/groupInvites');
      const r = await inv.requestToJoinGroup(String(cmd.link ?? ''));
      if (r.alreadyMember) {throw new Error('You are already in that group.');}
      return {};
    }
    case 'contactSave': {
      const {useAuthStore} = require('@store/authStore') as typeof import('@store/authStore');
      const {getDirectoryUsersClient} = require('../contacts/directoryNames') as typeof import('../contacts/directoryNames');
      await loadManualContacts(ownerKey());
      const users = getDirectoryUsersClient();
      const saved = await upsertManualContact({name: cmd.name, phone: cmd.phone}, {
        ownPhoneE164: (useAuthStore.getState().user as {phone_e164?: string | null} | null)?.phone_e164 ?? null,
        lookup: users ? (phones => users.lookup(phones)) : null,
      });
      contactsDirty = true; scheduleFlush();
      return {cid: saved.userId ? directSlotId(saved.userId) : null};
    }
    case 'contactRemove': {
      await loadManualContacts(ownerKey());
      await removeManualContact(cmd.contactId);
      contactsDirty = true; scheduleFlush();
      return {};
    }
  }
}

async function drainOne(link: ActiveLink): Promise<void> {
  for (let round = 0; round < 20; round++) {
    const after = cursors.get(link.linkId) ?? 0;
    let page: {items: Array<{seq: number; data: string}>; more: boolean};
    try {
      page = await api('GET', `/${link.linkId}/inbox?side=phone&after=${after}&limit=100`);
    } catch (e) {
      const status = (e as {status?: number}).status;
      if (status === 410 || status === 403) {await forgetLocal(link.linkId);}
      return;
    }
    if (page.items.length === 0) {return;}
    let upTo = after;
    for (const it of page.items) {
      upTo = Math.max(upTo, it.seq);
      const cmd = await link.cipher.open('w2p', it.data) as WebToPhone | null;
      if (!cmd || !replay.fresh(cmd.id)) {continue;}
      try { await runCommand(link, cmd); } catch (e) {
        console.warn('[link] command failed:', cmd.t, (e as Error).message);
      }
    }
    cursors.set(link.linkId, upTo);
    try { await api('POST', `/${link.linkId}/ack`, {side: 'phone', upTo}); } catch { /* re-acked next round */ }
    if (!page.more) {return;}
  }
}

/**
 * 2026-10-24 — re-read the phone's address book and send the browsers the
 * contact list if it changed (someone saved in the phone's Contacts app since
 * the link was made). Throttled; called when the app comes to the foreground.
 */
export async function refreshLinkedContacts(force = false): Promise<void> {
  await ensureLoaded();
  if (links.length === 0) {return;}
  const now = Date.now();
  if (!force && now - lastContactsRefreshAt < CONTACTS_REFRESH_MS) {return;}
  lastContactsRefreshAt = now;
  try {
    const contacts = await contactsView(useMessengerStore.getState(), {fresh: true});
    const sig = JSON.stringify(contacts);
    if (sig === lastContactsSig) {return;}
    lastContactsSig = sig;
    await broadcast([stamp({t: 'contacts' as const, contacts})]);
  } catch (e) {
    console.warn('[link] contacts refresh failed:', (e as Error).message);
  }
}

/** Run whatever the linked browsers have queued for this phone. */
export async function drainLinkInboxes(): Promise<void> {
  if (draining) {drainAgain = true; return draining;}
  draining = (async () => {
    try {
      do {
        drainAgain = false;
        await ensureLoaded();
        for (const l of [...links]) {await drainOne(l);}
      } while (drainAgain);
    } finally {
      draining = null;
    }
  })();
  return draining;
}

// ── lifecycle ────────────────────────────────────────────────────────────────

function attachTransport(t: TransportClient | null): void {
  unsubFrames?.();
  unsubFrames = null;
  if (!t) {return;}
  const tt = t as TransportClient & {addFrameListener?: (fn: (f: ServerFrame) => void) => () => void};
  unsubFrames = tt.addFrameListener?.((frame: ServerFrame) => {
    const event = frame.event as string;
    if (event === 'link.pending') {
      const d = frame.data as {to?: string} | undefined;
      if (d?.to === 'phone') {void drainLinkInboxes();}
    } else if (event === 'link.revoked') {
      const d = frame.data as {linkId?: string} | undefined;
      if (d?.linkId) {void forgetLocal(d.linkId);}
    } else if (event === 'link.approved') {
      notify();
    }
  }) ?? null;
  // A (re)connect is a good moment to catch up.
  void drainLinkInboxes();
}

/** Idempotent. Safe in the headless lane. */
export function startLinkEngine(): void {
  if (started) {return;}
  started = true;
  try {
    baseline(useMessengerStore.getState());
    unsubStore = useMessengerStore.subscribe((state, prev) => {
      try { onStoreChange(state, prev); } catch (e) {
        console.warn('[link] store change failed:', (e as Error).message);
      }
    });
    unsubTransport = onTransport(attachTransport);
    unsubContacts = onManualContactsChange(() => {
      if (links.length) {contactsDirty = true; scheduleFlush();}
    });
    try {
      (require('../groups/groupInvites') as typeof import('../groups/groupInvites')).startGroupInvites();
    } catch (e) { console.warn('[link] group invites unavailable:', (e as Error).message); }
    pollTimer = setInterval(() => {
      if (links.length && AppState.currentState === 'active') {void drainLinkInboxes();}
    }, POLL_MS);
    appStateSub = AppState.addEventListener('change', st => {
      if (st === 'active') {void drainLinkInboxes(); void refreshLinkedContacts();}
    });
    // A sweep on this phone (Contacts tab, New chat) → the browsers get it.
    try {
      const dc = require('../contacts/useDiscoveredContacts') as typeof import('../contacts/useDiscoveredContacts');
      unsubDiscovery = dc.onDiscoveredContactsChange?.(() => {
        if (links.length) {contactsDirty = true; scheduleFlush();}
      }) ?? null;
    } catch { /* optional */ }
    void ensureLoaded().then(() => drainLinkInboxes()).catch(() => undefined);
  } catch (e) {
    started = false;
    console.warn('[link] start failed:', (e as Error).message);
  }
}

/** Sign-out: stop and forget the in-memory keys (wipeAtRest clears the keychain). */
export function stopLinkEngine(): void {
  started = false;
  unsubStore?.(); unsubStore = null;
  unsubTransport?.(); unsubTransport = null;
  unsubFrames?.(); unsubFrames = null;
  unsubContacts?.(); unsubContacts = null;
  unsubDiscovery?.(); unsubDiscovery = null;
  lastContactsSig = ''; lastContactsRefreshAt = 0;
  if (pollTimer) {clearInterval(pollTimer); pollTimer = null;}
  appStateSub?.remove(); appStateSub = null;
  if (flushTimer) {clearTimeout(flushTimer); flushTimer = null;}
  links = []; loadedFor = null; pending.clear(); seen.clear(); cursors.clear();
}

/** Headless lane: give queued forwards a bounded chance to go out. */
export async function flushLinkBounded(ms = 4000): Promise<void> {
  if (flushTimer) {clearTimeout(flushTimer); flushTimer = null;}
  await Promise.race([
    (async () => { if (snapshotting) {await snapshotting;} await drainLinkInboxes(); await flushNow(); })(),
    new Promise<void>(r => setTimeout(r, ms)),
  ]).catch(() => undefined);
}

/**
 * FCM `link_wake` (warm background or killed app): boot what is needed, run
 * the browser's commands, and give the results a bounded chance to go out
 * before the OS freezes the process again.
 */
export async function handleLinkWake(lane: 'warm' | 'headless'): Promise<void> {
  let release: () => void = () => { /* no hold */ };
  try {
    const {holdReceiveForeground} = require('../push/receiveForegroundHold') as typeof import('../push/receiveForegroundHold');
    release = holdReceiveForeground(lane === 'warm' ? 'warm-wake' : 'headless-wake');
  } catch { /* native module absent */ }
  try {
    const {configureRuntimeFromPersisted} = require('../push/headlessDrain') as typeof import('../push/headlessDrain');
    if (!(await configureRuntimeFromPersisted())) {return;}
    await getMessengerRuntime('production');
    startLinkEngine();
    await flushLinkBounded(10_000);
    // A send flips sending → sent a moment after it is accepted: forward that too.
    await new Promise(r => setTimeout(r, 1_500));
    await flushLinkBounded(3_000);
  } catch (e) {
    console.warn('[link] wake failed:', (e as Error).message);
  } finally {
    release();
  }
}

// ── management (Linked devices screen) ───────────────────────────────────────

async function forgetLocal(linkId: string): Promise<void> {
  await ensureLoaded();
  const before = links.length;
  links = links.filter(l => l.linkId !== linkId);
  cursors.delete(linkId);
  if (links.length !== before) {await persist();}
}

/** Approve the browser whose QR code was scanned, then send it the snapshot. */
export async function approveLinkFromQr(qrText: string): Promise<{label: string}> {
  const parsed = parseLinkQr(qrText);
  if (!parsed) {throw new Error('not_a_link_code');}
  await ensureLoaded();
  const rec = await api<{linkId: string; label: string; approvedAt: number}>('POST', '/approve', {linkId: parsed.linkId});
  const link: ActiveLink = {
    linkId: rec.linkId, key: b64uEncode(parsed.key), label: rec.label, approvedAt: rec.approvedAt,
    cipher: await linkCipher(rec.linkId, parsed.key),
  };
  links = [...links.filter(l => l.linkId !== link.linkId), link];
  await persist();
  if (!started) {startLinkEngine();}
  baseline(useMessengerStore.getState());
  // Snapshot in the background: the screen can close straight away.
  const snap: Promise<void> = snapshotFrames()
    .then(f => sendTo(link, f))
    .catch(e => console.warn('[link] snapshot failed:', (e as Error).message))
    .finally(() => { if (snapshotting === snap) {snapshotting = null;} });
  snapshotting = snap;
  return {label: rec.label};
}

export async function listLinkedDevices(): Promise<LinkedDeviceView[]> {
  await ensureLoaded();
  const res = await api<{links: Array<{linkId: string; label: string; approvedAt: number; lastSeenAt: number; role: string}>}>('GET', '/mine');
  const mine = new Set(links.map(l => l.linkId));
  // A link the server no longer knows is gone: drop its key.
  const live = new Set(res.links.map(l => l.linkId));
  const stale = links.filter(l => !live.has(l.linkId));
  for (const s of stale) {await forgetLocal(s.linkId);}
  return res.links.map(l => ({
    linkId: l.linkId, label: l.label, approvedAt: l.approvedAt, lastSeenAt: l.lastSeenAt,
    mirrored: mine.has(l.linkId),
  }));
}

export async function unlinkDevice(linkId: string): Promise<void> {
  const l = links.find(x => x.linkId === linkId);
  if (l) {
    try { await sendTo(l, [stamp({t: 'bye' as const})]); } catch { /* unlinking anyway */ }
  }
  try { await api('DELETE', `/${linkId}`); } catch (e) {
    if ((e as {status?: number}).status !== 404) {throw e;}
  }
  await forgetLocal(linkId);
}

/** Test seam. */
export const _linkEngineInternals = {toRow, conversationsView, groupsView, onStoreChange, baseline, pending, seen};
