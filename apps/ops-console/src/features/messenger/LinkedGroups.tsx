'use client';

/**
 * Groups and contacts in a browser linked to the phone (2026-10-23).
 *
 * Owner: "groups that are created or been added … create group and members to
 * the group … contacts synced from the phone or added manually", and the web
 * linked to the app by QR code, WhatsApp-style. The browser holds no group
 * keys: the phone mirrors every group it is in (plain groups and mission
 * rooms; department channels stay in the workspace), sends what is typed here,
 * and carries out group changes (create, add / remove members, name and
 * description, invite link, leave) and contact changes. Everything travels
 * sealed over the phone link (see linkProtocol / linkedRuntime).
 */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import QRCode from 'qrcode';
import type {LinkGroup, LinkPeer} from '@bravo/messenger-core/link/linkProtocol';
import {parseGroupInvite} from '@bravo/messenger-core/link/groupInvite';
import type {LinkedRuntime} from '@/lib/messenger/linkedRuntime';
import type {StoredMessage, ConversationSummary} from '@/lib/messenger/runtime';

export function initials(name: string) {
  const p = name.trim().split(/\s+/).map(w => w.match(/[\p{L}\p{N}]/u)?.[0]).filter(Boolean) as string[];
  return ((p[0] ?? '?') + (p[1] ?? '')).toUpperCase();
}

export function timeLabel(ms: number) {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
    : d.toLocaleDateString([], {day: 'numeric', month: 'short'});
}

function errText(e: unknown): string {
  return (e as Error)?.message || 'Your phone could not do that. Try again.';
}

/** Re-renders when the phone sends new group or contact data. */
export function useLinkedVersion(linked: LinkedRuntime | null): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!linked) return;
    const a = linked.onGroupsChange(() => setV(n => n + 1));
    const b = linked.onPeersChange(() => setV(n => n + 1));
    return () => { a(); b(); };
  }, [linked]);
  return v;
}

export function personName(linked: LinkedRuntime | null, userId: string, selfId: string | null): string {
  if (userId && userId === selfId) return 'You';
  const p = linked?.peer(userId);
  return p?.name || p?.phone || 'Bravo user';
}

// ── the Groups tab ──────────────────────────────────────────────────────────

export function GroupsList({linked, threads, active, seen, onOpen}: {
  linked: LinkedRuntime;
  threads: ConversationSummary[];
  active: string | null;
  seen: Record<string, number>;
  onOpen: (cid: string) => void;
}) {
  useLinkedVersion(linked);
  const [dialog, setDialog] = useState<'new' | 'join' | null>(null);
  const [filter, setFilter] = useState('');
  const groups = linked.groups();
  const f = filter.trim().toLowerCase();
  const shown = f ? groups.filter(g => g.name.toLowerCase().includes(f)) : groups;
  const last = new Map(threads.map(t => [t.conversationId, t]));
  return (
    <>
      <div className="chat-list-actions">
        <button type="button" className="btn btn-pri" onClick={() => setDialog('new')}>New group</button>
        <button type="button" className="btn btn-sec" onClick={() => setDialog('join')}>Join with link</button>
      </div>
      <div className="chat-search">
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter groups" aria-label="Filter groups"/>
      </div>
      <div className="chat-list-scroll">
        {shown.length === 0 && (
          <div className="chat-list-empty">
            {f ? 'No group matches.' : 'No groups yet. Create one here or in the Bravo app, or join one with an invite link. Groups you are added to appear here.'}
          </div>
        )}
        {shown.map(g => {
          const t = last.get(g.cid);
          const lastAt = Math.max(t?.lastAt ?? 0, g.lastAt);
          const unread = (t?.lastDirection === 'in' && (t?.lastAt ?? 0) > (seen[g.cid] ?? 0) && g.cid !== active) || (g.unread > 0 && g.cid !== active && lastAt > (seen[g.cid] ?? 0));
          return (
            <button key={g.cid} type="button" className={`chat-row${g.cid === active ? ' on' : ''}`} onClick={() => onOpen(g.cid)}>
              <span className="chat-avatar grp">{initials(g.name)}</span>
              <span className="chat-row-main">
                <span className="chat-row-top">
                  <span className={`chat-name${unread ? ' unread' : ''}`}>{g.name}</span>
                  {lastAt > 0 && <span className="chat-time">{timeLabel(lastAt)}</span>}
                </span>
                <span className="chat-row-bottom">
                  <span className={`chat-preview${unread ? ' unread' : ''}`}>
                    {t && t.count > 0 ? `${t.lastDirection === 'out' ? 'You: ' : ''}${t.lastBody}` : `${g.members.length} members`}
                  </span>
                  {unread && <i className="chat-unread-dot" aria-label="unread"/>}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {dialog === 'new' && <NewGroupDialog linked={linked} onClose={() => setDialog(null)} onCreated={cid => { setDialog(null); if (cid) onOpen(cid); }}/>}
      {dialog === 'join' && <JoinGroupDialog linked={linked} onClose={() => setDialog(null)}/>}
    </>
  );
}

// ── a group thread ──────────────────────────────────────────────────────────

export function GroupThread({linked, cid, selfId}: {linked: LinkedRuntime; cid: string; selfId: string | null}) {
  useLinkedVersion(linked);
  const group = linked.group(cid);
  const [rows, setRows] = useState<StoredMessage[]>([]);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState(false);
  const bottom = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    const reload = () => void linked.loadConversation(cid, 300).then(r => { if (live) setRows(r); });
    reload();
    const a = linked.onHistoryChange(c => { if (c === cid) reload(); });
    const b = linked.onIncoming(m => { if (m.conversationId === cid) reload(); });
    return () => { live = false; a(); b(); };
  }, [linked, cid]);

  const inboundKey = rows.filter(r => r.direction === 'in').map(r => r.id).join(',');
  useEffect(() => { if (inboundKey) linked.markRead(cid); }, [linked, cid, inboundKey]);
  useEffect(() => { bottom.current?.scrollIntoView({block: 'end'}); }, [rows.length]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setText(''); setErr(null);
    try { await linked.sendGroup(cid, body); } catch (e) { setErr(`Not sent: ${errText(e)}`); }
  };
  const retry = async (m: StoredMessage) => {
    setErr(null);
    await linked.discardMessage(m.conversationId, m.id);
    try { await linked.sendGroup(cid, m.body); } catch (e) { setErr(`Not sent: ${errText(e)}`); }
  };

  const name = group?.name ?? 'Group';
  const members = group?.members ?? [];
  const waiting = rows.some(r => r.direction === 'out' && r.status === 'sending' && Date.now() - r.sentAt > 15_000);
  let lastDay = '';
  return (
    <div className="chat-thread-body">
      <div className="chat-thread-col">
        <header className="chat-thread-head">
          <span className="chat-avatar grp">{initials(name)}</span>
          <span style={{minWidth: 0}}>
            <span className="chat-name">{name}</span>
            <span className="chat-sub">
              {members.length ? members.map(m => personName(linked, m.userId, selfId)).slice(0, 6).join(', ') + (members.length > 6 ? ` +${members.length - 6}` : '') : 'Group'}
            </span>
          </span>
          <button type="button" className="chat-head-btn" onClick={() => setInfo(v => !v)} aria-expanded={info}>Group info</button>
          <span className="chat-e2e-chip" title="End-to-end encrypted; sent from your phone">🔒 Encrypted</span>
        </header>
        <div className="chat-messages">
          {!group && <div className="chat-hint">This group is no longer on your phone.</div>}
          {group && rows.length === 0 && <div className="chat-hint">No messages yet. Messages to this group go out from your phone.</div>}
          {rows.map(m => {
            const day = new Date(m.sentAt).toDateString();
            const showDay = day !== lastDay; lastDay = day;
            const mine = m.direction === 'out';
            return (
              <div key={`${m.conversationId}|${m.id}`}>
                {showDay && <div className="chat-day"><span>{new Date(m.sentAt).toLocaleDateString([], {weekday: 'short', day: 'numeric', month: 'short'})}</span></div>}
                <div className={`chat-bubble-row${mine ? ' mine' : ''}`}>
                  <div className={`chat-bubble${mine ? ' mine' : ''}${m.status === 'failed' ? ' failed' : ''}`}>
                    {!mine && m.senderUserId && <span className="chat-sender">{personName(linked, m.senderUserId, selfId)}</span>}
                    <div className="chat-body">{m.body}</div>
                    <div className="chat-meta">
                      {new Date(m.sentAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}
                      {mine && <span className={`chat-tick${m.status === 'read' ? ' read' : ''}`} aria-label={m.status}>
                        {m.status === 'sending' ? '◷' : m.status === 'failed' ? '!' : m.status === 'read' || m.status === 'delivered' ? '✓✓' : '✓'}
                      </span>}
                    </div>
                  </div>
                  {m.status === 'failed' && <button type="button" className="chat-retry" onClick={() => void retry(m)}>Retry</button>}
                </div>
              </div>
            );
          })}
          <div ref={bottom}/>
        </div>
        {waiting && !err && <div className="chat-error">Waiting for your phone. Messages go out from the Bravo app, so make sure your phone is on and connected to the internet.</div>}
        {err && <div className="chat-error">{err}</div>}
        {group && (
          <form className="chat-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
            <textarea value={text} rows={1} placeholder={`Message ${name}`} onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}/>
            <button type="submit" className="btn btn-pri chat-send" disabled={!text.trim()} aria-label="Send">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/>
              </svg>
            </button>
          </form>
        )}
      </div>
      {info && group && <GroupInfo linked={linked} group={group} selfId={selfId} onClose={() => setInfo(false)}/>}
    </div>
  );
}

function GroupInfo({linked, group, selfId, onClose}: {linked: LinkedRuntime; group: LinkGroup; selfId: string | null; onClose: () => void}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ok: boolean; text: string} | null>(null);
  const [dialog, setDialog] = useState<'edit' | 'add' | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const canManage = group.manageable && linked.hasFeature('groups.manage');
  const canInvite = group.manageable && linked.hasFeature('groups.invite');

  useEffect(() => {
    let live = true;
    if (!invite) { setQr(null); return; }
    void QRCode.toDataURL(invite, {margin: 1, width: 220, errorCorrectionLevel: 'M', color: {dark: '#06142B', light: '#FFFFFF'}})
      .then(u => { if (live) setQr(u); });
    return () => { live = false; };
  }, [invite]);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); if (done) setMsg({ok: true, text: done}); } catch (e) { setMsg({ok: false, text: errText(e)}); }
    finally { setBusy(false); }
  };

  const members = [...group.members].sort((a, b) => Number(b.admin) - Number(a.admin) || personName(linked, a.userId, selfId).localeCompare(personName(linked, b.userId, selfId)));
  return (
    <aside className="chat-info" aria-label="Group info">
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
        <h4>Group info</h4>
        <button type="button" className="chat-link-btn" onClick={onClose}>Close</button>
      </div>
      <div>
        <div className="chat-name" style={{fontSize: 16, whiteSpace: 'normal'}}>{group.name}</div>
        <div className="chat-sub">{group.members.length} members</div>
      </div>
      <div>
        <h4>Description</h4>
        <div className="chat-info-desc" style={{marginTop: 6}}>{group.description || <span className="chat-note">No description.</span>}</div>
      </div>
      {group.admin && linked.hasFeature('groups.manage') && (
        <button type="button" className="btn btn-sec" disabled={busy} onClick={() => setDialog('edit')}>Edit name and description</button>
      )}
      {canInvite && (
        <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
          <h4>Invite link</h4>
          {invite ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {qr && <img className="chat-qr" src={qr} width={220} height={220} alt={`QR code to join ${group.name}`}/>}
              <div className="chat-invite-link">{invite}</div>
              <div style={{display: 'flex', gap: 12, flexWrap: 'wrap'}}>
                <button type="button" className="chat-link-btn" onClick={() => { void navigator.clipboard?.writeText(invite).then(() => setMsg({ok: true, text: 'Link copied.'})); }}>Copy link</button>
                <button type="button" className="chat-link-btn" disabled={busy} onClick={() => void run(async () => setInvite(await linked.groupInvite(group.cid, 'reset')), 'New link made; the old one no longer works.')}>Reset link</button>
                <button type="button" className="chat-link-btn danger" disabled={busy} onClick={() => void run(async () => { await linked.groupInvite(group.cid, 'revoke'); setInvite(null); }, 'Invite link turned off.')}>Turn off</button>
              </div>
              <div className="chat-note">Anyone with this link or QR code can ask to join; your phone adds them automatically.</div>
            </>
          ) : (
            <button type="button" className="btn btn-sec" disabled={busy} onClick={() => void run(async () => setInvite(await linked.groupInvite(group.cid, 'get')))}>
              {busy ? 'Asking your phone…' : 'Show invite link and QR code'}
            </button>
          )}
        </div>
      )}
      <div>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
          <h4>Members · {group.members.length}</h4>
          {canManage && <button type="button" className="chat-link-btn" onClick={() => setDialog('add')}>Add members</button>}
        </div>
        {members.map(m => (
          <div key={m.userId} className="chat-member">
            <span className="chat-avatar sm">{initials(personName(linked, m.userId, selfId))}</span>
            <span className="chat-row-main">
              <span className="chat-name">{personName(linked, m.userId, selfId)}</span>
              {m.phone && m.userId !== selfId && <span className="chat-sub">{m.phone}</span>}
            </span>
            {m.admin && <span className="chat-badge">Admin</span>}
            {canManage && m.userId !== selfId && (
              <button type="button" className="chat-link-btn danger" disabled={busy}
                onClick={() => { if (window.confirm(`Remove ${personName(linked, m.userId, selfId)} from ${group.name}?`)) void run(() => linked.removeGroupMember(group.cid, m.userId), 'Removed.'); }}>
                Remove
              </button>
            )}
          </div>
        ))}
        {!group.manageable && group.admin && <div className="chat-note">Members of this group are managed by dispatch.</div>}
      </div>
      {msg && <div className={msg.ok ? 'chat-ok' : 'chat-error'} style={msg.ok ? undefined : {margin: 0}}>{msg.text}</div>}
      {linked.hasFeature('groups.manage') && (
        <button type="button" className="btn btn-ghost" style={{color: 'var(--err)'}} disabled={busy}
          onClick={() => { if (window.confirm(`Leave ${group.name}? You stop receiving its messages on your phone and here.`)) void run(() => linked.leaveGroup(group.cid), 'You left the group.'); }}>
          Leave group
        </button>
      )}
      {dialog === 'edit' && <EditGroupDialog linked={linked} group={group} onClose={() => setDialog(null)}/>}
      {dialog === 'add' && <AddMembersDialog linked={linked} group={group} selfId={selfId} onClose={() => setDialog(null)}/>}
    </aside>
  );
}

// ── dialogs ─────────────────────────────────────────────────────────────────

function Dialog({title, children, footer, onClose}: {title: string; children: React.ReactNode; footer: React.ReactNode; onClose: () => void}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="chat-dialog-back" onClick={onClose}>
      <div className="chat-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
        <header>{title}</header>
        <div className="chat-dialog-body">{children}</div>
        <footer>{footer}</footer>
      </div>
    </div>
  );
}

/** Bravo contacts that can be put in a group (address book, added by hand, chat partners). */
function pickable(linked: LinkedRuntime, selfId: string | null, exclude: Set<string>): LinkPeer[] {
  const byId = new Map<string, LinkPeer>();
  for (const p of linked.contactList()) if (p.userId && p.userId !== selfId && !exclude.has(p.userId)) byId.set(p.userId, p);
  return [...byId.values()].sort((a, b) => (a.name ?? a.phone ?? '').localeCompare(b.name ?? b.phone ?? ''));
}

function MemberPicker({people, picked, setPicked}: {people: LinkPeer[]; picked: Set<string>; setPicked: (s: Set<string>) => void}) {
  const [f, setF] = useState('');
  const q = f.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const shown = q ? people.filter(p => (p.name ?? '').toLowerCase().includes(q) || (digits.length >= 3 && (p.phone ?? '').replace(/\D/g, '').includes(digits))) : people;
  return (
    <>
      <input value={f} onChange={e => setF(e.target.value)} placeholder="Search contacts" aria-label="Search contacts"/>
      <div className="chat-pick-list">
        {shown.length === 0 && <div className="chat-note" style={{padding: 8}}>No contacts to add. Add contacts on the Contacts tab or in the app.</div>}
        {shown.map(p => (
          <label key={p.userId} className="chat-pick">
            <input type="checkbox" checked={picked.has(p.userId)} onChange={e => {
              const n = new Set(picked); if (e.target.checked) n.add(p.userId); else n.delete(p.userId); setPicked(n);
            }}/>
            <span className="chat-avatar sm">{initials(p.name ?? p.phone ?? '?')}</span>
            <span className="chat-row-main"><span className="chat-name">{p.name ?? p.phone}</span>{p.name && p.phone && <span className="chat-sub">{p.phone}</span>}</span>
          </label>
        ))}
      </div>
    </>
  );
}

export function NewGroupDialog({linked, onClose, onCreated}: {linked: LinkedRuntime; onClose: () => void; onCreated: (cid: string | null) => void}) {
  const selfId = linked.self.userId;
  const people = useMemo(() => pickable(linked, selfId, new Set()), [linked, selfId]);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    setBusy(true); setErr(null);
    try { onCreated(await linked.createGroup(name.trim(), [...picked], desc.trim() || undefined) || null); }
    catch (e) { setErr(errText(e)); setBusy(false); }
  };
  return (
    <Dialog title="New group" onClose={onClose} footer={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-pri" disabled={busy || !name.trim() || picked.size === 0} onClick={() => void create()}>
        {busy ? 'Creating on your phone…' : `Create (${picked.size + 1})`}
      </button>
    </>}>
      <label>Group name<input value={name} onChange={e => setName(e.target.value)} maxLength={64} autoFocus/></label>
      <label>Description (optional)<textarea value={desc} onChange={e => setDesc(e.target.value)} rows={2} maxLength={512}/></label>
      <span className="chat-note">Members</span>
      <MemberPicker people={people} picked={picked} setPicked={setPicked}/>
      <span className="chat-note">The group is created by your phone and encrypted end to end. You are its admin.</span>
      {err && <div className="chat-error" style={{margin: 0}}>{err}</div>}
    </Dialog>
  );
}

function AddMembersDialog({linked, group, selfId, onClose}: {linked: LinkedRuntime; group: LinkGroup; selfId: string | null; onClose: () => void}) {
  const people = useMemo(() => pickable(linked, selfId, new Set(group.members.map(m => m.userId))), [linked, selfId, group.members]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    setBusy(true); setErr(null);
    try { await linked.addGroupMembers(group.cid, [...picked]); onClose(); } catch (e) { setErr(errText(e)); setBusy(false); }
  };
  return (
    <Dialog title={`Add to ${group.name}`} onClose={onClose} footer={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-pri" disabled={busy || picked.size === 0} onClick={() => void add()}>{busy ? 'Adding…' : `Add ${picked.size || ''}`.trim()}</button>
    </>}>
      <MemberPicker people={people} picked={picked} setPicked={setPicked}/>
      {err && <div className="chat-error" style={{margin: 0}}>{err}</div>}
    </Dialog>
  );
}

function EditGroupDialog({linked, group, onClose}: {linked: LinkedRuntime; group: LinkGroup; onClose: () => void}) {
  const [name, setName] = useState(group.name);
  const [desc, setDesc] = useState(group.description ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await linked.editGroup(group.cid, {
        ...(name.trim() && name.trim() !== group.name ? {name: name.trim()} : {}),
        ...(desc.trim() !== (group.description ?? '') ? {description: desc.trim()} : {}),
      });
      onClose();
    } catch (e) { setErr(errText(e)); setBusy(false); }
  };
  return (
    <Dialog title="Edit group" onClose={onClose} footer={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-pri" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
    </>}>
      <label>Group name<input value={name} onChange={e => setName(e.target.value)} maxLength={64} autoFocus/></label>
      <label>Description<textarea value={desc} onChange={e => setDesc(e.target.value)} rows={3} maxLength={512} placeholder="What this group is for"/></label>
      {err && <div className="chat-error" style={{margin: 0}}>{err}</div>}
    </Dialog>
  );
}

function JoinGroupDialog({linked, onClose}: {linked: LinkedRuntime; onClose: () => void}) {
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const inv = parseGroupInvite(link);
  const join = async () => {
    setBusy(true); setErr(null);
    try { await linked.joinGroup(link.trim()); setDone(inv?.name || 'the group'); } catch (e) { setErr(errText(e)); }
    setBusy(false);
  };
  return (
    <Dialog title="Join a group" onClose={onClose} footer={done
      ? <button type="button" className="btn btn-pri" onClick={onClose}>Done</button>
      : <>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-pri" disabled={busy || !inv} onClick={() => void join()}>{busy ? 'Sending…' : 'Ask to join'}</button>
      </>}>
      {done ? (
        <span className="chat-ok">Request sent. “{done}” appears in your groups as soon as its admin&apos;s phone adds you.</span>
      ) : (
        <>
          <label>Invite link<input value={link} onChange={e => setLink(e.target.value)} placeholder="bravo-group:1:…" autoFocus/></label>
          {link && !inv && <span className="chat-note">That is not a Bravo group invite link.</span>}
          {inv && <span className="chat-note">Group: <b>{inv.name || 'Unnamed group'}</b>. Your phone sends its admin an encrypted request.</span>}
          {err && <div className="chat-error" style={{margin: 0}}>{err}</div>}
        </>
      )}
    </Dialog>
  );
}

export function AddContactDialog({linked, onClose, onSaved}: {linked: LinkedRuntime; onClose: () => void; onSaved: (chatCid: string | null) => void}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try { onSaved(await linked.saveContact(name.trim(), phone.trim())); } catch (e) { setErr(errText(e)); setBusy(false); }
  };
  return (
    <Dialog title="New contact" onClose={onClose} footer={<>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-pri" disabled={busy || !name.trim() || !phone.trim()} onClick={() => void save()}>{busy ? 'Saving on your phone…' : 'Save'}</button>
    </>}>
      <label>Name<input value={name} onChange={e => setName(e.target.value)} maxLength={80} autoFocus/></label>
      <label>Phone number<input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+971 50 123 4567" inputMode="tel"/></label>
      <span className="chat-note">Saved in Bravo Messenger on your phone (not uploaded to Bravo&apos;s servers) and shown here.</span>
      {err && <div className="chat-error" style={{margin: 0}}>{err}</div>}
    </Dialog>
  );
}

/** Shown on the Groups tab when groups cannot be used in this browser. */
export function GroupsUnavailable({reason, onLink}: {reason: 'standalone' | 'old_app'; onLink?: () => void}) {
  const [confirming, setConfirming] = useState(false);
  const go = useCallback(() => {
    if (!onLink) return;
    if (!confirming) { setConfirming(true); return; }
    onLink();
  }, [onLink, confirming]);
  return (
    <div className="chat-list-empty">
      {reason === 'old_app'
        ? 'Update the Bravo app on your phone to see and manage your groups here.'
        : onLink
          ? 'Your groups live on your phone. Link this browser to the Bravo app (scan a QR code) to see and manage them here.'
          : 'Groups need the Bravo app on a phone. This account uses this browser as its own secure device, so it has 1:1 chats only.'}
      {onLink && (
        <div style={{marginTop: 12}}>
          <button type="button" className="btn btn-pri" onClick={go}>{confirming ? 'Replace browser chats and link my phone' : 'Link with my phone'}</button>
          {confirming && <div className="chat-note" style={{marginTop: 8}}>Chats kept only in this browser are removed; your phone&apos;s chats, groups and contacts appear instead.</div>}
        </div>
      )}
    </div>
  );
}
