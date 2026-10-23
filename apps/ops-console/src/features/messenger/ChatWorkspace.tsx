'use client';

/**
 * Ops ↔ app-user 1:1 chat (2026-09-30), end-to-end encrypted like the mobile
 * messenger: the same Signal sessions, Sealed Sender v3 wrap, relay and
 * `direct:<peer>` thread grammar. Messages never exist in plaintext on the
 * server; history lives in this browser's vault (IndexedDB, wrapped with the
 * vault key) exactly like the mission group chats.
 *
 * Text only for now. Media, voice notes, calls, reactions, edits and deletes
 * are shown/handled on the mobile app; an inbound attachment appears here as
 * a placeholder line.
 *
 * 2026-10-03 — the people directory is pluggable (ChatDirectory) so the
 * service provider console reuses this exact chat with ITS roster: the ops
 * console searches every app user, a provider sees only its own officers.
 */

import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import useSWR from 'swr';
import {opsDataApi} from '@/lib/api';
import {
  useMessenger, usePresence, useTyping, useReadReceipts,
} from '@/components/messenger/MessengerProvider';
import type {StoredMessage, ConversationSummary} from '@/lib/messenger/runtime';
import type {LinkedRuntime} from '@/lib/messenger/linkedRuntime';
import {isGroupCid} from '@bravo/messenger-core/link/linkProtocol';
import {LinkPhonePanel} from './LinkPhonePanel';
import {
  GroupsList, GroupThread, GroupsUnavailable, AddContactDialog, useLinkedVersion,
} from './LinkedGroups';

/**
 * 2026-10-23 — Chats (1:1 and groups), Contacts and Groups, Signal/Telegram
 * style. Groups and hand-added contacts come from the phone in a linked
 * browser (see LinkedGroups.tsx).
 */
export type ChatTab = 'chats' | 'contacts' | 'groups';

const DIRECT = 'direct:';
const peerOf = (cid: string) => (cid.startsWith(DIRECT) ? cid.slice(DIRECT.length) : null);
const slotOf = (uid: string) => `${DIRECT}${uid}`;

/** One person the chat can show: a thread title and a one-line subtitle. */
export interface ChatPerson {
  id: string;
  name: string;
  subtitle: string;
}

/** Where the chat finds people. */
export interface ChatDirectory {
  /** Matches for the "New chat" search (min 2 characters). */
  search: (q: string) => Promise<ChatPerson[]>;
  /** One person, for a thread whose peer was never in a search result. */
  get: (id: string) => Promise<ChatPerson | null>;
  /** Placeholder of the search box. */
  searchPlaceholder: string;
  /** Turns a search failure into a sentence. */
  searchError?: (e: unknown) => string;
  /** localStorage key for "last seen" per thread (one per console). */
  seenKey: string;
  /** Heading of the chat list. */
  title?: string;
  /** "No one found" for a query (e.g. explain that a full number is needed). */
  noResultsText?: (q: string) => string;
  /** Shown when there are no chats yet. */
  emptyText?: string;
  /**
   * 2026-10-13 — everyone this console may message, for the Contacts tab
   * (ops: app users; provider: the roster). Omitted where browsing everyone
   * is not allowed (the web app finds people by exact phone number only).
   */
  list?: () => Promise<ChatPerson[]>;
}

const ROLE_LABEL: Record<string, string> = {
  individual: 'Client', agent: 'CPO agent', service_provider: 'Provider agency',
};

/** The ops console's directory: every app user, Operation/Super Admin search. */
export const OPS_CHAT_DIRECTORY: ChatDirectory = {
  search: async q => (await opsDataApi.listUsers({q, limit: 8}))
    .filter(u => !u.deleted_at)
    .map(u => ({id: u.id, name: u.display_name ?? u.phone_e164 ?? 'Unnamed',
      subtitle: `${ROLE_LABEL[u.role] ?? u.role} · ${u.phone_e164 ?? u.email ?? '—'}`})),
  get: async id => {
    const u = (await opsDataApi.getUser(id)).user;
    return u ? {id: u.id, name: u.display_name ?? u.phone_e164 ?? 'Bravo user', subtitle: ROLE_LABEL[u.role] ?? u.role} : null;
  },
  searchPlaceholder: 'New chat — search name, phone or email',
  searchError: e => (/403|forbidden|domain/i.test(String((e as Error)?.message)) ? 'Searching people needs Operation Admin or Super Admin.' : 'Search failed.'),
  seenKey: 'bravo_ops_chat_seen_v1',
  list: async () => (await opsDataApi.listUsers({limit: 300}))
    .filter(u => !u.deleted_at)
    .map(u => ({id: u.id, name: u.display_name ?? u.phone_e164 ?? 'Unnamed',
      subtitle: `${ROLE_LABEL[u.role] ?? u.role} · ${u.phone_e164 ?? u.email ?? '—'}`})),
};

const DirectoryCtx = createContext<ChatDirectory>(OPS_CHAT_DIRECTORY);

function readSeenFrom(key: string): Record<string, number> {
  try { return JSON.parse(window.localStorage.getItem(key) ?? '{}') as Record<string, number>; }
  catch { return {}; }
}
function writeSeenTo(key: string, v: Record<string, number>) {
  try { window.localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ }
}

function initials(name: string) {
  // First letter or digit of the first two words that have one: "Omar (Driver)" → "OD".
  const p = name.trim().split(/\s+/).map(w => w.match(/[\p{L}\p{N}]/u)?.[0]).filter(Boolean) as string[];
  return ((p[0] ?? '?') + (p[1] ?? '')).toUpperCase();
}
function timeLabel(ms: number) {
  const d = new Date(ms);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
    : d.toLocaleDateString([], {day: 'numeric', month: 'short'});
}

/** Directory entry for a peer: from search results, else fetched once. */
/** Delivery failures in words an operator can act on. */
function sendError(e: unknown): string {
  const msg = String((e as Error)?.message ?? '');
  if (/404|not.?found|no.?bundle|argument must be|identityKey|prekey/i.test(msg)) {
    return "Not delivered: this person hasn't opened the Bravo messenger yet, so there are no encryption keys to send to. Ask them to open Messenger in the app, then retry.";
  }
  if (/401|403|ticket|cert/i.test(msg)) return 'Not delivered: your messenger session expired. Lock and unlock the messenger, then retry.';
  if (/network|fetch|timeout/i.test(msg)) return 'Not delivered: the message server could not be reached. Check your connection and retry.';
  return `Not delivered: ${msg || 'unknown error'}.`;
}

/** Linked mode: the runtime that mirrors the phone, else null. */
function useLinked(): LinkedRuntime | null {
  const {runtime} = useMessenger();
  return runtime && 'kind' in runtime && runtime.kind === 'linked' ? runtime : null;
}

/** Linked mode: names come from the phone's contacts, like in the app. */
function linkedPerson(linked: LinkedRuntime | null, userId: string | null): ChatPerson | null {
  const p = linked && userId ? linked.peer(userId) : null;
  return p?.name ? {id: p.userId, name: p.name, subtitle: p.phone ?? ''} : null;
}

function usePeerProfile(userId: string | null, cache: Map<string, ChatPerson>) {
  const dir = useContext(DirectoryCtx);
  const linked = useLinked();
  const [, bump] = useState(0);
  useEffect(() => (linked ? linked.onPeersChange(() => bump(n => n + 1)) : undefined), [linked]);
  const fromPhone = linkedPerson(linked, userId);
  const cached = userId ? cache.get(userId) : undefined;
  const {data} = useSWR(userId && !cached && !fromPhone ? ['chat-peer', dir.seenKey, userId] : null,
    () => dir.get(userId!), {revalidateOnFocus: false, shouldRetryOnError: false});
  return fromPhone ?? cached ?? data ?? null;
}

export function ChatWorkspace({directory = OPS_CHAT_DIRECTORY, initialTab = 'chats'}: {directory?: ChatDirectory; initialTab?: ChatTab} = {}) {
  const messenger = useMessenger();
  const {state, runtime} = messenger;
  const [confirmLink, setConfirmLink] = useState(false);

  if (state === 'absent') return <div className="chat-empty-state">Loading…</div>;
  if (state === 'link_required') return <LinkPhonePanel />;
  if (state !== 'unlocked' || !runtime) {
    return (
      <div className="chat-locked card">
        <div className="chat-locked-icon" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>
          </svg>
        </div>
        <h3>Unlock your secure messenger</h3>
        <p>
          Chats are end-to-end encrypted, the same as in the Bravo app. Your messages are kept in
          this browser&apos;s vault, protected by your messenger passphrase.
        </p>
        {messenger.error && <div className="auth-err" style={{marginBottom: 14}}>{messenger.error}</div>}
        <button className="btn btn-pri btn-lg" onClick={messenger.requestUnlock}
          disabled={state === 'unlocking'}>
          {state === 'unlocking' ? 'Unlocking…' : 'Unlock messenger'}
        </button>
        {/* 2026-10-23 — accounts with the Bravo app can link this browser to
            the phone (QR code) instead of keeping a separate browser vault. */}
        {messenger.canLink && state !== 'unlocking' && (
          <div style={{marginTop: 18}}>
            {!confirmLink ? (
              <button type="button" className="btn btn-sec" onClick={() => setConfirmLink(true)}>Link with my phone instead</button>
            ) : (
              <>
                <p style={{margin: '0 0 10px', fontSize: 13}}>
                  Your phone&apos;s chats, groups and contacts will show here instead. Chats kept only in this
                  browser&apos;s vault are removed from it.
                </p>
                <button type="button" className="btn btn-pri" onClick={() => void messenger.linkInstead()}>Show the QR code</button>{' '}
                <button type="button" className="btn btn-ghost" onClick={() => setConfirmLink(false)}>Cancel</button>
              </>
            )}
          </div>
        )}
      </div>
    );
  }
  return <DirectoryCtx.Provider value={directory}><UnlockedChat initialTab={initialTab} /></DirectoryCtx.Provider>;
}

function UnlockedChat({initialTab}: {initialTab: ChatTab}) {
  const {runtime, userId: selfId} = useMessenger();
  const dir = useContext(DirectoryCtx);
  const readSeen = useCallback(() => readSeenFrom(dir.seenKey), [dir.seenKey]);
  const writeSeen = useCallback((v: Record<string, number>) => writeSeenTo(dir.seenKey, v), [dir.seenKey]);
  const [threads, setThreads] = useState<ConversationSummary[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [tab, setTab] = useState<ChatTab>(initialTab);
  const linked = useLinked();
  const {mode, canLink, linkInstead} = useMessenger();
  useLinkedVersion(linked);
  const groupsOn = !!linked && linked.hasFeature('groups');
  const [seen, setSeen] = useState<Record<string, number>>({});
  const directory = useRef(new Map<string, ChatPerson>());
  const [, bump] = useState(0);

  useEffect(() => { setSeen(readSeen()); }, [readSeen]);

  const reloadThreads = useCallback(() => {
    if (!runtime) return;
    void runtime.listConversations().then(all => setThreads(all.filter(t =>
      t.conversationId.startsWith(DIRECT) || (linked !== null && isGroupCid(t.conversationId)))));
  }, [runtime, linked]);

  useEffect(() => {
    if (!runtime) return;
    reloadThreads();
    const off1 = runtime.onHistoryChange(() => reloadThreads());
    const off2 = runtime.onIncoming(() => reloadThreads());
    return () => { off1(); off2(); };
  }, [runtime, reloadThreads]);

  const openThread = (cid: string) => {
    setActive(cid);
    const next = {...readSeen(), [cid]: Date.now()};
    writeSeen(next); setSeen(next);
  };
  const startWith = (u: ChatPerson) => {
    directory.current.set(u.id, u);
    bump(n => n + 1);
    openThread(slotOf(u.id));
  };

  // Keep the open thread marked seen as messages arrive in it.
  const activeLast = threads.find(t => t.conversationId === active)?.lastAt;
  useEffect(() => {
    if (!active || !activeLast) return;
    const next = {...readSeen(), [active]: Date.now()};
    writeSeen(next); setSeen(next);
  }, [active, activeLast, readSeen, writeSeen]);

  const peerIds = useMemo(() => threads.map(t => peerOf(t.conversationId)).filter((x): x is string => !!x), [threads]);
  const presence = usePresence(peerIds);

  const listed = active && !threads.some(t => t.conversationId === active)
    ? [{conversationId: active, lastBody: '', lastAt: Date.now(), lastDirection: 'out' as const, lastStatus: 'sent' as const, count: 0}, ...threads]
    : threads;

  return (
    <div className="chat-shell card">
      <aside className="chat-list">
        <PeopleSearch onPick={startWith} selfId={selfId} />
        <div className="chat-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'chats'} className={`chat-tab${tab === 'chats' ? ' on' : ''}`} onClick={() => setTab('chats')}>
            {dir.title ?? 'Chats'}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'contacts'} className={`chat-tab${tab === 'contacts' ? ' on' : ''}`} onClick={() => setTab('contacts')}>
            Contacts
          </button>
          <button type="button" role="tab" aria-selected={tab === 'groups'} className={`chat-tab${tab === 'groups' ? ' on' : ''}`} onClick={() => setTab('groups')}>
            Groups
          </button>
        </div>
        <LinkedBanner />
        {tab === 'groups' ? (
          groupsOn && linked
            ? <GroupsList linked={linked} threads={threads} active={active} seen={seen} onOpen={openThread} />
            : <GroupsUnavailable reason={linked ? 'old_app' : 'standalone'} onLink={!linked && mode !== 'linked' && canLink ? () => void linkInstead() : undefined} />
        ) : tab === 'contacts' ? (
          <ContactsList threads={threads} selfId={selfId} directory={directory.current}
            onPick={u => { startWith(u); setTab('chats'); }} onOpenThread={cid => { openThread(cid); setTab('chats'); }} />
        ) : (
        <div className="chat-list-scroll">
          {listed.length === 0 && (
            <div className="chat-list-empty">
              {dir.emptyText ?? 'No chats yet. Search for a client, agent or agency above to start one. Messages they send you from the app appear here.'}
            </div>
          )}
          {listed.map(t => isGroupCid(t.conversationId) ? (
            <GroupThreadRow key={t.conversationId} t={t} linked={linked}
              active={t.conversationId === active}
              unread={t.lastDirection === 'in' && t.lastAt > (seen[t.conversationId] ?? 0) && t.conversationId !== active}
              onOpen={() => openThread(t.conversationId)} />
          ) : (
            <ThreadRow key={t.conversationId} t={t}
              active={t.conversationId === active}
              unread={t.lastDirection === 'in' && t.lastAt > (seen[t.conversationId] ?? 0) && t.conversationId !== active}
              online={presence.get(peerOf(t.conversationId) ?? '')?.state}
              directory={directory.current}
              onOpen={() => openThread(t.conversationId)} />
          ))}
        </div>
        )}
      </aside>
      <section className="chat-thread">
        {active && isGroupCid(active) && linked
          ? <GroupThread key={active} linked={linked} cid={active} selfId={selfId} />
          : active
          ? <Thread key={active} conversationId={active} directory={directory.current} />
          : (
            <div className="chat-empty-state">
              <div className="chat-empty-title">Select a chat</div>
              <div>Pick a conversation on the left, or search for someone to message.</div>
              <div className="chat-e2e">🔒 End-to-end encrypted</div>
            </div>
          )}
      </section>
    </div>
  );
}

function PeopleSearch({onPick, selfId}: {onPick: (u: ChatPerson) => void; selfId: string | null}) {
  const dir = useContext(DirectoryCtx);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const linked = useLinked();
  const {data, error, isLoading} = useSWR(debounced.length >= 2 ? ['chat-search', dir.seenKey, debounced] : null,
    () => dir.search(debounced), {revalidateOnFocus: false, shouldRetryOnError: false});
  // Linked mode: the phone's contacts first, then the directory's matches.
  const fromPhone: ChatPerson[] = linked && debounced.length >= 1
    ? linked.searchPeers(debounced).map(p => ({id: p.userId, name: p.name ?? p.phone ?? 'Bravo user', subtitle: p.phone ?? 'Contact'}))
    : [];
  const results = [...fromPhone, ...(data ?? []).filter(u => !fromPhone.some(p => p.id === u.id))].filter(u => u.id !== selfId);
  return (
    <div className="chat-search">
      <input value={q} onChange={e => setQ(e.target.value)} placeholder={dir.searchPlaceholder}
        aria-label="Search people to message" />
      {(debounced.length >= 2 || fromPhone.length > 0) && (
        <div className="chat-search-results">
          {isLoading && <div className="chat-search-note">Searching…</div>}
          {error && fromPhone.length === 0 && <div className="chat-search-note">{dir.searchError ? dir.searchError(error) : 'Search failed.'}</div>}
          {!isLoading && !error && results.length === 0 && debounced.length >= 2 && <div className="chat-search-note">{dir.noResultsText ? dir.noResultsText(debounced) : 'No one found.'}</div>}
          {results.map(u => (
            <button key={u.id} type="button" className="chat-search-row" onClick={() => { onPick(u); setQ(''); }}>
              <span className="chat-avatar sm">{initials(u.name)}</span>
              <span style={{minWidth: 0}}>
                <span className="chat-name">{u.name}</span>
                <span className="chat-sub">{u.subtitle}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A group in the chat list (linked browsers). */
function GroupThreadRow({t, linked, active, unread, onOpen}: {
  t: ConversationSummary; linked: LinkedRuntime | null; active: boolean; unread: boolean; onOpen: () => void;
}) {
  const g = linked?.group(t.conversationId);
  const name = g?.name ?? 'Group';
  return (
    <button type="button" className={`chat-row${active ? ' on' : ''}`} onClick={onOpen}>
      <span className="chat-avatar grp">{initials(name)}</span>
      <span className="chat-row-main">
        <span className="chat-row-top">
          <span className={`chat-name${unread ? ' unread' : ''}`}>{name}</span>
          {t.count > 0 && <span className="chat-time">{timeLabel(t.lastAt)}</span>}
        </span>
        <span className="chat-row-bottom">
          <span className={`chat-preview${unread ? ' unread' : ''}`}>
            {t.count === 0 ? 'Group' : `${t.lastDirection === 'out' ? 'You: ' : ''}${t.lastBody}`}
          </span>
          {unread && <i className="chat-unread-dot" aria-label="unread" />}
        </span>
      </span>
    </button>
  );
}

function ThreadRow({t, active, unread, online, directory, onOpen}: {
  t: ConversationSummary; active: boolean; unread: boolean; online?: string;
  directory: Map<string, ChatPerson>; onOpen: () => void;
}) {
  const peer = usePeerProfile(peerOf(t.conversationId), directory);
  const name = peer?.name ?? 'Bravo user';
  return (
    <button type="button" className={`chat-row${active ? ' on' : ''}`} onClick={onOpen}>
      <span className="chat-avatar">
        {initials(name)}
        {(online === 'online' || online === 'active') && <i className="chat-online" aria-label="online" />}
      </span>
      <span className="chat-row-main">
        <span className="chat-row-top">
          <span className={`chat-name${unread ? ' unread' : ''}`}>{name}</span>
          {t.count > 0 && <span className="chat-time">{timeLabel(t.lastAt)}</span>}
        </span>
        <span className="chat-row-bottom">
          <span className={`chat-preview${unread ? ' unread' : ''}`}>
            {t.count === 0 ? 'New chat' : `${t.lastDirection === 'out' ? 'You: ' : ''}${t.lastBody}`}
          </span>
          {unread && <i className="chat-unread-dot" aria-label="unread" />}
        </span>
      </span>
    </button>
  );
}

function Thread({conversationId, directory}: {conversationId: string; directory: Map<string, ChatPerson>}) {
  const {runtime} = useMessenger();
  const peerId = peerOf(conversationId)!;
  const peer = usePeerProfile(peerId, directory);
  const name = peer?.name ?? 'Bravo user';
  const presence = usePresence([peerId]).get(peerId);
  const typing = useTyping([peerId]).has(peerId);
  const readIds = useReadReceipts();
  const [rows, setRows] = useState<StoredMessage[]>([]);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  const typingSent = useRef(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!runtime) return;
    let live = true;
    const reload = () => void runtime.loadConversation(conversationId, 300).then(r => { if (live) setRows(r); });
    reload();
    const off1 = runtime.onHistoryChange(cid => { if (cid === conversationId) reload(); });
    const off2 = runtime.onIncoming(m => { if (m.conversationId === conversationId) reload(); });
    return () => { live = false; off1(); off2(); };
  }, [runtime, conversationId]);

  // Read receipts back to the peer for what is now on screen.
  const inboundIds = rows.filter(r => r.direction === 'in' && r.envelopeId).map(r => r.envelopeId!);
  const inboundKey = inboundIds.join(',');
  useEffect(() => {
    if (runtime && inboundIds.length) runtime.markRead(conversationId, inboundIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, conversationId, inboundKey]);

  useEffect(() => { bottom.current?.scrollIntoView({block: 'end'}); }, [rows.length, typing]);

  const stopTyping = () => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    if (typingSent.current && runtime) runtime.sendTyping({userId: peerId, deviceId: 1}, 'stop');
    typingSent.current = false;
  };
  const onType = (v: string) => {
    setText(v);
    if (!runtime) return;
    if (!typingSent.current && v.trim()) { runtime.sendTyping({userId: peerId, deviceId: 1}, 'start'); typingSent.current = true; }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(stopTyping, 4000);
  };
  useEffect(() => () => stopTyping(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    const body = text.trim();
    if (!body || !runtime) return;
    setText(''); setErr(null); stopTyping();
    try { await runtime.sendDirect(peerId, body); }
    catch (e) { setErr(sendError(e)); }
  };
  const retry = async (m: StoredMessage) => {
    if (!runtime) return;
    setErr(null);
    await runtime.discardMessage(m.conversationId, m.id);
    try { await runtime.sendDirect(peerId, m.body); } catch (e) { setErr(sendError(e)); }
  };

  // Linked mode: a message waits on the phone; say so if it takes a while.
  const linked = useLinked();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!linked) return;
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, [linked]);
  const waitingOnPhone = !!linked && rows.some(r => r.direction === 'out' && r.status === 'sending' && now - r.sentAt > 15_000);

  const status = typing ? 'typing…'
    : presence?.state === 'online' || presence?.state === 'active' ? 'online'
    : presence?.lastSeenMs ? `last seen ${timeLabel(presence.lastSeenMs)}` : (peer?.subtitle ?? '');

  let lastDay = '';
  return (
    <>
      <header className="chat-thread-head">
        <span className="chat-avatar">{initials(name)}
          {(presence?.state === 'online' || presence?.state === 'active') && <i className="chat-online" />}
        </span>
        <span style={{minWidth: 0}}>
          <span className="chat-name">{name}</span>
          <span className={`chat-sub${typing ? ' typing' : ''}`}>{status}</span>
        </span>
        <span className="chat-e2e-chip" title="End-to-end encrypted with the Bravo messenger protocol">🔒 Encrypted</span>
      </header>
      <div className="chat-messages">
        {rows.length === 0 && <div className="chat-hint">Say hello — this chat is end-to-end encrypted.</div>}
        {rows.map(m => {
          const day = new Date(m.sentAt).toDateString();
          const showDay = day !== lastDay; lastDay = day;
          const mine = m.direction === 'out';
          const read = mine && (m.status === 'read' || (!!m.envelopeId && readIds.has(m.envelopeId)));
          return (
            <div key={`${m.conversationId}|${m.id}`}>
              {showDay && <div className="chat-day"><span>{new Date(m.sentAt).toLocaleDateString([], {weekday: 'short', day: 'numeric', month: 'short'})}</span></div>}
              <div className={`chat-bubble-row${mine ? ' mine' : ''}`}>
                <div className={`chat-bubble${mine ? ' mine' : ''}${m.status === 'failed' ? ' failed' : ''}`}>
                  <div className="chat-body">{m.body}</div>
                  <div className="chat-meta">
                    {new Date(m.sentAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}
                    {mine && (
                      <span className={`chat-tick${read ? ' read' : ''}`} aria-label={m.status}>
                        {m.status === 'sending' ? '◷' : m.status === 'failed' ? '!' : read ? '✓✓' : '✓'}
                      </span>
                    )}
                  </div>
                </div>
                {m.status === 'failed' && (
                  <button type="button" className="chat-retry" onClick={() => void retry(m)}>Retry</button>
                )}
              </div>
            </div>
          );
        })}
        {typing && <div className="chat-bubble-row"><div className="chat-bubble typing"><span/><span/><span/></div></div>}
        <div ref={bottom} />
      </div>
      {waitingOnPhone && !err && (
        <div className="chat-error">Waiting for your phone. Messages go out from the Bravo app, so make sure your phone is on and connected to the internet.</div>
      )}
      {err && <div className="chat-error">{err}</div>}
      <form className="chat-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
        <textarea value={text} rows={1} placeholder="Type a message"
          onChange={e => onType(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button type="submit" className="btn btn-pri chat-send" disabled={!text.trim()} aria-label="Send">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/>
          </svg>
        </button>
      </form>
    </>
  );
}

/** Linked mode: a one-line reminder that this browser mirrors the phone. */
function LinkedBanner() {
  const linked = useLinked();
  const {unlinkBrowser} = useMessenger();
  const [asking, setAsking] = useState(false);
  if (!linked) return null;
  return (
    <div className="chat-search-note" style={{padding: '6px 14px', display: 'flex', gap: 8, alignItems: 'baseline', justifyContent: 'space-between'}}>
      <span>📱 Mirrored from your phone. Chats, groups and contacts sync through the Bravo app.</span>
      {/* 2026-10-23 — every console can log the browser out of the phone. */}
      {!asking
        ? <button type="button" className="chat-link-btn" onClick={() => setAsking(true)}>Unlink</button>
        : <span style={{whiteSpace: 'nowrap'}}>
            <button type="button" className="chat-link-btn danger" onClick={() => void unlinkBrowser()}>Unlink</button>{' · '}
            <button type="button" className="chat-link-btn" onClick={() => setAsking(false)}>Keep</button>
          </span>}
    </div>
  );
}

/**
 * 2026-10-13 — the Contacts tab: everyone you can start a chat with, without
 * having to search first. Linked browsers list the phone's contacts (as the
 * app does); the ops console lists app users and the provider console its
 * roster (ChatDirectory.list); everyone you already chat with is included.
 */
function ContactsList({threads, selfId, directory, onPick, onOpenThread}: {
  threads: ConversationSummary[];
  selfId: string | null;
  directory: Map<string, ChatPerson>;
  onPick: (u: ChatPerson) => void;
  onOpenThread: (cid: string) => void;
}) {
  const dir = useContext(DirectoryCtx);
  const linked = useLinked();
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const canAdd = !!linked && linked.hasFeature('contacts.manual');
  const [peersVersion, bump] = useState(0);
  useEffect(() => (linked ? linked.onPeersChange(() => bump(n => n + 1)) : undefined), [linked]);
  const {data: listed, error, isLoading} = useSWR(dir.list ? ['chat-contacts', dir.seenKey] : null,
    () => dir.list!(), {revalidateOnFocus: false, shouldRetryOnError: false});

  const people = useMemo(() => {
    const byId = new Map<string, ChatPerson & {manualId?: string | null; offBravo?: boolean}>();
    let n = 0;
    for (const p of linked?.contactList() ?? []) {
      const sub = [p.phone, p.source === 'manual' ? 'added by you' : null].filter(Boolean).join(' · ') || 'Contact';
      if (!p.userId) {
        // Added by hand on the phone, not on Bravo yet.
        byId.set(`off:${n++}`, {id: '', name: p.name ?? p.phone ?? 'Contact', subtitle: `${p.phone ?? ''} · not on Bravo yet`, manualId: p.contactId ?? null, offBravo: true});
        continue;
      }
      byId.set(p.userId, {id: p.userId, name: p.name ?? p.phone ?? 'Bravo user', subtitle: sub, manualId: p.source === 'manual' ? (p.contactId ?? null) : null});
    }
    for (const p of listed ?? []) if (!byId.has(p.id)) byId.set(p.id, p);
    for (const t of threads) {
      const id = peerOf(t.conversationId);
      if (!id || byId.has(id)) continue;
      const known = directory.get(id) ?? linkedPerson(linked, id);
      byId.set(id, known ?? {id, name: 'Bravo user', subtitle: 'Chat'});
    }
    byId.delete(selfId ?? '');
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  // `directory` is a mutable ref map; peersVersion re-reads the phone's list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked, listed, threads, selfId, peersVersion]);

  const f = filter.trim().toLowerCase();
  const digits = f.replace(/\D/g, '');
  const shown = f
    ? people.filter(p => p.name.toLowerCase().includes(f) || (digits.length >= 3 && p.subtitle.replace(/\D/g, '').includes(digits)))
    : people;

  return (
    <>
      {canAdd && (
        <div className="chat-list-actions">
          <button type="button" className="btn btn-pri" onClick={() => { setNote(null); setAdding(true); }}>Add contact</button>
        </div>
      )}
      <div className="chat-search">
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter contacts"
          aria-label="Filter contacts" />
      </div>
      {note && <div className="chat-search-note">{note}</div>}
      {adding && linked && (
        <AddContactDialog linked={linked} onClose={() => setAdding(false)} onSaved={cid => {
          setAdding(false);
          if (cid) onOpenThread(cid);
          else setNote('Saved. They are not on Bravo yet; they appear as a chat contact once they join.');
        }} />
      )}
      <div className="chat-list-scroll">
        {isLoading && people.length === 0 && <div className="chat-list-empty">Loading contacts…</div>}
        {error && <div className="chat-search-note">{dir.searchError ? dir.searchError(error) : 'Could not load contacts.'}</div>}
        {!isLoading && shown.length === 0 && (
          <div className="chat-list-empty">
            {f ? 'No contact matches.'
              : linked ? 'No contacts yet. Contacts come from your phone: allow Bravo to read contacts in the app, then they appear here.'
              : 'No contacts yet. Use the search above to find someone and start a chat.'}
          </div>
        )}
        {shown.map((p, i) => {
          const extra = p as ChatPerson & {manualId?: string | null; offBravo?: boolean};
          return (
            <div key={p.id || `off-${i}`} style={{display: 'flex', alignItems: 'center'}}>
              <button type="button" className="chat-row" onClick={() => { if (!extra.offBravo) onPick(p); }} disabled={extra.offBravo}
                style={extra.offBravo ? {cursor: 'default', opacity: 0.7} : undefined}>
                <span className="chat-avatar">{initials(p.name)}</span>
                <span className="chat-row-main">
                  <span className="chat-name">{p.name}</span>
                  <span className="chat-preview">{p.subtitle}</span>
                </span>
              </button>
              {extra.manualId && linked && canAdd && (
                <button type="button" className="chat-link-btn danger" style={{padding: '0 10px'}} title="Remove this contact from your phone"
                  onClick={() => {
                    if (!window.confirm(`Remove ${p.name} from your Bravo contacts? Your chats with them stay.`)) return;
                    void linked.removeContact(extra.manualId!).catch(e => setNote((e as Error).message));
                  }}>
                  Remove
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
