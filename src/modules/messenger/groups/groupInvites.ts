/**
 * Group invite links / QR codes (2026-10-23) — the phone side.
 *
 * See `@bravo/messenger-core/link/groupInvite` for the format. In short:
 *  - an admin issues a link for a group (`issueGroupInvite`); the token stays
 *    on this phone (keystore) — the server never learns a group exists;
 *  - whoever opens it sends the admin a sealed 1:1 join request
 *    (`requestToJoinGroup`);
 *  - this phone watches its incoming 1:1 messages (`startGroupInvites`), and
 *    when a request carries the token it issued for a group it still admins,
 *    adds the sender with the normal add + rekey (`addGroupMember`);
 *  - `resetGroupInvite` mints a new token (the old link stops working),
 *    `revokeGroupInvite` turns the link off.
 *
 * Each request is honoured once (its message id is remembered), so a member
 * an admin later removes cannot rejoin by replaying an old request.
 */
import {
  encodeGroupInvite, parseGroupInvite, newGroupInviteToken, joinRequestText, parseJoinRequest,
  type GroupInvite,
} from '@bravo/messenger-core/link/groupInvite';
import {loadSecureDoc, saveSecureDoc} from '../runtime/keychain';
import {getActiveOwnerKey, getMessengerRuntime} from '../runtime/runtime';
import {
  useMessengerStore, resolveDirectConversationIdFromState, directPlaceholderConversation,
} from '../store/messengerStore';
import type {LocalMessage} from '../store/types';
import {isDirectPrefixed} from '../conversationIds';

interface IssuedInvite {
  token:     string;
  createdAt: number;
  /** Join-request message ids already honoured or refused. */
  used:      string[];
}

type Snapshot = ReturnType<typeof useMessengerStore.getState>;

/** Requests older than this are not acted on when found at start-up. */
const STARTUP_SCAN_MS = 14 * 24 * 3600_000;
const USED_KEEP = 200;

let owner: string | null = null;
let invites: Record<string, IssuedInvite> = {};
let loading: Promise<void> | null = null;
let unsub: (() => void) | null = null;
const inFlight = new Set<string>();
const listeners = new Set<() => void>();

function ownerKey(): string | null {
  return getActiveOwnerKey() ?? useMessengerStore.getState()._ownUserId ?? null;
}

function selfId(): string | null {
  return useMessengerStore.getState()._ownAuthUserId ?? null;
}

function emit(): void {
  for (const fn of [...listeners]) {try { fn(); } catch { /* ignore */ }}
}

export function onGroupInvitesChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

async function ensureLoaded(): Promise<void> {
  const o = ownerKey();
  if (!o) {owner = null; invites = {}; return;}
  if (owner === o) {return;}
  if (loading) {return loading;}
  loading = (async () => {
    try {
      const raw = await loadSecureDoc('invites', o);
      const parsed = raw ? JSON.parse(raw) as Record<string, IssuedInvite> : {};
      invites = parsed && typeof parsed === 'object' ? parsed : {};
      owner = o;
    } catch (e) {
      console.warn('[group-invite] load failed:', (e as Error).message);
      invites = {};
      owner = o;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

async function persist(): Promise<void> {
  if (!owner) {throw new Error('not_signed_in');}
  await saveSecureDoc('invites', owner, JSON.stringify(invites));
  emit();
}

/**
 * Invites are for groups people make themselves. Mission rooms and department
 * channels (server-assigned ids, no salt) are staffed by dispatch, not links.
 */
export function canInviteToGroup(state: Pick<Snapshot, 'groups' | 'conversations'>, groupId: string, self: string | null): boolean {
  const g = state.groups[groupId];
  const conv = state.conversations[groupId];
  if (!g || !self || !g.members[self]?.admin) {return false;}
  if (!g.saltB64) {return false;}
  return !conv || conv.type === 'group';
}

function linkFor(groupId: string, inv: IssuedInvite): string | null {
  const st = useMessengerStore.getState();
  const self = selfId();
  const g = st.groups[groupId];
  if (!g || !self) {return null;}
  return encodeGroupInvite({groupId, adminUserId: self, token: inv.token, name: st.conversations[groupId]?.name ?? g.name});
}

/** The current link for a group, or null when none was issued (or this phone is not an admin). */
export async function getGroupInvite(groupId: string): Promise<string | null> {
  await ensureLoaded();
  const inv = invites[groupId];
  if (!inv || !canInviteToGroup(useMessengerStore.getState(), groupId, selfId())) {return null;}
  return linkFor(groupId, inv);
}

/** Issue a link (or return the existing one). `reset` replaces the token. */
export async function issueGroupInvite(groupId: string, opts: {reset?: boolean} = {}): Promise<string> {
  await ensureLoaded();
  if (!canInviteToGroup(useMessengerStore.getState(), groupId, selfId())) {
    throw new Error('Only a group admin can share an invite link for this group.');
  }
  const prev = invites[groupId];
  if (!prev || opts.reset) {
    invites = {...invites, [groupId]: {token: newGroupInviteToken(), createdAt: Date.now(), used: prev?.used ?? []}};
    await persist();
  }
  const link = linkFor(groupId, invites[groupId]);
  if (!link) {throw new Error('Group not found.');}
  return link;
}

export const resetGroupInvite = (groupId: string) => issueGroupInvite(groupId, {reset: true});

export async function revokeGroupInvite(groupId: string): Promise<void> {
  await ensureLoaded();
  if (!invites[groupId]) {return;}
  const next = {...invites};
  delete next[groupId];
  invites = next;
  await persist();
}

export class JoinLinkError extends Error {}

/** Send the admin a join request for a scanned / pasted link. */
export async function requestToJoinGroup(linkText: string): Promise<{groupName: string; alreadyMember: boolean}> {
  const inv: GroupInvite | null = parseGroupInvite(linkText);
  if (!inv) {throw new JoinLinkError('That is not a Bravo group invite link.');}
  const st = useMessengerStore.getState();
  const self = selfId();
  if (self && st.groups[inv.groupId]?.members[self]) {return {groupName: inv.name, alreadyMember: true};}
  if (self && inv.adminUserId === self) {throw new JoinLinkError('This is your own invite link.');}
  const rt = await getMessengerRuntime('production');
  const cid = resolveDirectConversationIdFromState(st, inv.adminUserId);
  const peer = {userId: inv.adminUserId, deviceId: 1};
  if (isDirectPrefixed(cid) && !st.conversations[cid]) {
    st.upsertConversation(directPlaceholderConversation(cid, inv.adminUserId, peer, new Date().toISOString()));
  }
  await rt.sendText(cid, joinRequestText(inv), {peer});
  return {groupName: inv.name, alreadyMember: false};
}

// ── admin side: honour requests ─────────────────────────────────────────────

function senderOf(state: Snapshot, cid: string, m: LocalMessage): string | null {
  if (m.sender_id === 'self') {return null;}
  const conv = state.conversations[cid];
  if (conv && conv.type !== 'direct') {return null;}
  return conv?.peer?.userId ?? m.peer?.userId ?? (m.sender_id || null);
}

async function honour(cid: string, m: LocalMessage): Promise<void> {
  const req = parseJoinRequest(m.content);
  if (!req || inFlight.has(m.id)) {return;}
  await ensureLoaded();
  const inv = invites[req.groupId];
  if (!inv || inv.token !== req.token || inv.used.includes(m.id)) {return;}
  const state = useMessengerStore.getState();
  const joiner = senderOf(state, cid, m);
  const self = selfId();
  if (!joiner || joiner === self) {return;}
  if (!canInviteToGroup(state, req.groupId, self)) {return;}
  const markUsed = async () => {
    const cur = invites[req.groupId];
    if (!cur) {return;}
    invites = {...invites, [req.groupId]: {...cur, used: [...cur.used, m.id].slice(-USED_KEEP)}};
    await persist().catch(() => undefined);
  };
  if (state.groups[req.groupId]?.members[joiner]) {await markUsed(); return;}
  inFlight.add(m.id);
  try {
    const rt = await getMessengerRuntime('production');
    if (!rt.addGroupMember) {return;}
    await rt.addGroupMember({groupId: req.groupId, newMember: {userId: joiner, deviceId: 1}});
    await markUsed();
    console.log(`[group-invite] added a member to ${req.groupId.slice(0, 8)} from an invite link`);
  } catch (e) {
    // Not marked used: tried again on the next start (e.g. no session yet).
    console.warn('[group-invite] add failed:', (e as Error).message);
  } finally {
    inFlight.delete(m.id);
  }
}

function scan(state: Snapshot, prev: Snapshot | null): void {
  if (Object.keys(invites).length === 0 && owner) {return;}
  const since = Date.now() - STARTUP_SCAN_MS;
  for (const [cid, list] of Object.entries(state.messages)) {
    const before = prev?.messages[cid];
    if (prev && list === before) {continue;}
    const known = new Set((before ?? []).map(x => x.id));
    for (const m of list) {
      if (prev && known.has(m.id)) {continue;}
      if (m.sender_id === 'self' || m.type !== 'text') {continue;}
      if (!prev && Date.parse(m.created_at) < since) {continue;}
      if (!m.content || m.content.indexOf('bravo-join:1:') < 0) {continue;}
      void honour(cid, m);
    }
  }
}

/** Idempotent. Started with the link engine (interactive app and headless drain). */
export function startGroupInvites(): void {
  if (unsub) {return;}
  void ensureLoaded().then(() => scan(useMessengerStore.getState(), null)).catch(() => undefined);
  unsub = useMessengerStore.subscribe((state, prev) => {
    try {
      if (state.hydrationGeneration !== prev.hydrationGeneration) {
        void ensureLoaded().then(() => scan(useMessengerStore.getState(), null));
        return;
      }
      if (state.messages !== prev.messages) {scan(state, prev);}
    } catch (e) {
      console.warn('[group-invite] scan failed:', (e as Error).message);
    }
  });
}

export function stopGroupInvites(): void {
  unsub?.(); unsub = null;
  owner = null; invites = {}; loading = null; inFlight.clear();
  emit();
}

/** Test seam. */
export const _groupInviteInternals = {honour, scan, ensureLoaded, invites: () => invites};
