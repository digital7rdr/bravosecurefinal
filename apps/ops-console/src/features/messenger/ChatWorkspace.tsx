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
 */

import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import useSWR from 'swr';
import {opsDataApi, type OpsUserRow} from '@/lib/api';
import {
  useMessenger, usePresence, useTyping, useReadReceipts,
} from '@/components/messenger/MessengerProvider';
import type {StoredMessage, ConversationSummary} from '@/lib/messenger/runtime';

const DIRECT = 'direct:';
const peerOf = (cid: string) => (cid.startsWith(DIRECT) ? cid.slice(DIRECT.length) : null);
const slotOf = (uid: string) => `${DIRECT}${uid}`;

const SEEN_KEY = 'bravo_ops_chat_seen_v1';
function readSeen(): Record<string, number> {
  try { return JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, number>; }
  catch { return {}; }
}
function writeSeen(v: Record<string, number>) {
  try { window.localStorage.setItem(SEEN_KEY, JSON.stringify(v)); } catch { /* private mode */ }
}

const ROLE_LABEL: Record<string, string> = {
  individual: 'Client', agent: 'CPO agent', service_provider: 'Provider agency',
};

function initials(name: string) {
  const p = name.trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] ?? '?') + (p[1]?.[0] ?? '')).toUpperCase();
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

function usePeerProfile(userId: string | null, cache: Map<string, OpsUserRow>) {
  const cached = userId ? cache.get(userId) : undefined;
  const {data} = useSWR(userId && !cached ? ['chat-peer', userId] : null,
    () => opsDataApi.getUser(userId!).then(d => d.user), {revalidateOnFocus: false, shouldRetryOnError: false});
  return cached ?? data ?? null;
}

export function ChatWorkspace() {
  const messenger = useMessenger();
  const {state, runtime} = messenger;

  if (state === 'absent') return <div className="chat-empty-state">Loading…</div>;
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
      </div>
    );
  }
  return <UnlockedChat />;
}

function UnlockedChat() {
  const {runtime, userId: selfId} = useMessenger();
  const [threads, setThreads] = useState<ConversationSummary[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [seen, setSeen] = useState<Record<string, number>>({});
  const directory = useRef(new Map<string, OpsUserRow>());
  const [, bump] = useState(0);

  useEffect(() => { setSeen(readSeen()); }, []);

  const reloadThreads = useCallback(() => {
    if (!runtime) return;
    void runtime.listConversations().then(all => setThreads(all.filter(t => t.conversationId.startsWith(DIRECT))));
  }, [runtime]);

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
  const startWith = (u: OpsUserRow) => {
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
  }, [active, activeLast]);

  const peerIds = useMemo(() => threads.map(t => peerOf(t.conversationId)!).filter(Boolean), [threads]);
  const presence = usePresence(peerIds);

  const listed = active && !threads.some(t => t.conversationId === active)
    ? [{conversationId: active, lastBody: '', lastAt: Date.now(), lastDirection: 'out' as const, lastStatus: 'sent' as const, count: 0}, ...threads]
    : threads;

  return (
    <div className="chat-shell card">
      <aside className="chat-list">
        <PeopleSearch onPick={startWith} selfId={selfId} />
        <div className="chat-list-head">Chats</div>
        <div className="chat-list-scroll">
          {listed.length === 0 && (
            <div className="chat-list-empty">
              No chats yet. Search for a client, agent or agency above to start one. Messages they
              send you from the app appear here.
            </div>
          )}
          {listed.map(t => (
            <ThreadRow key={t.conversationId} t={t}
              active={t.conversationId === active}
              unread={t.lastDirection === 'in' && t.lastAt > (seen[t.conversationId] ?? 0) && t.conversationId !== active}
              online={presence.get(peerOf(t.conversationId) ?? '')?.state}
              directory={directory.current}
              onOpen={() => openThread(t.conversationId)} />
          ))}
        </div>
      </aside>
      <section className="chat-thread">
        {active
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

function PeopleSearch({onPick, selfId}: {onPick: (u: OpsUserRow) => void; selfId: string | null}) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const {data, error, isLoading} = useSWR(debounced.length >= 2 ? ['chat-search', debounced] : null,
    () => opsDataApi.listUsers({q: debounced, limit: 8}), {revalidateOnFocus: false, shouldRetryOnError: false});
  const results = (data ?? []).filter(u => u.id !== selfId && !u.deleted_at);
  return (
    <div className="chat-search">
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="New chat — search name, phone or email"
        aria-label="Search people to message" />
      {debounced.length >= 2 && (
        <div className="chat-search-results">
          {isLoading && <div className="chat-search-note">Searching…</div>}
          {error && <div className="chat-search-note">
            {/403|forbidden|domain/i.test(String((error as Error).message)) ? 'Searching people needs Operation Admin or Super Admin.' : 'Search failed.'}
          </div>}
          {!isLoading && !error && results.length === 0 && <div className="chat-search-note">No one found.</div>}
          {results.map(u => (
            <button key={u.id} type="button" className="chat-search-row" onClick={() => { onPick(u); setQ(''); }}>
              <span className="chat-avatar sm">{initials(u.display_name ?? u.phone_e164 ?? '?')}</span>
              <span style={{minWidth: 0}}>
                <span className="chat-name">{u.display_name ?? 'Unnamed'}</span>
                <span className="chat-sub">{ROLE_LABEL[u.role] ?? u.role} · {u.phone_e164 ?? u.email ?? '—'}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ThreadRow({t, active, unread, online, directory, onOpen}: {
  t: ConversationSummary; active: boolean; unread: boolean; online?: string;
  directory: Map<string, OpsUserRow>; onOpen: () => void;
}) {
  const peer = usePeerProfile(peerOf(t.conversationId), directory);
  const name = peer?.display_name ?? peer?.phone_e164 ?? 'Bravo user';
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

function Thread({conversationId, directory}: {conversationId: string; directory: Map<string, OpsUserRow>}) {
  const {runtime} = useMessenger();
  const peerId = peerOf(conversationId)!;
  const peer = usePeerProfile(peerId, directory);
  const name = peer?.display_name ?? peer?.phone_e164 ?? 'Bravo user';
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

  const status = typing ? 'typing…'
    : presence?.state === 'online' || presence?.state === 'active' ? 'online'
    : presence?.lastSeenMs ? `last seen ${timeLabel(presence.lastSeenMs)}` : (ROLE_LABEL[peer?.role ?? ''] ?? '');

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
