'use client';

/**
 * Workspace (Bravo Web App, 2026-10-27).
 *
 * Owner: "We need to be able to add admins in workspace, also … change
 * statuses of members … user, manager and admin", and choose which members a
 * new channel has. The app already had this; the web had nowhere to do it.
 *
 * Shown to the owner, Admins and Managers of a workspace. What each may do is
 * decided by the server (OrgCpoService / OrgModuleGuard); this page only
 * hides the buttons it would refuse:
 *   - roles (User / Manager / Admin): the owner and Admins; nobody changes the
 *     owner; only the owner changes another Admin;
 *   - status (suspend / reinstate / remove): any manager for Users; the owner
 *     or an Admin for Managers; only the owner for Admins;
 *   - channels: anyone who runs the workspace.
 * A channel made here starts its encrypted chat the first time an admin
 * opens the workspace's channels in the Bravo app.
 */
import {useCallback, useEffect, useMemo, useState} from 'react';
import {useWeb} from '@/components/web/WebShell';
import {Empty, PvCard, PvDialog, PvPage, ConfirmDialog} from '@/components/provider/ui';
import {useToast} from '@/components/Toast';
import {workspaceApi, type WsChannel, type WsMember} from '@/lib/web/api';
import {managedWorkspaces, type ManagedWorkspace} from '@/lib/web/access';
import {
  ROLE_LABEL, canChangeRole, canChangeStatus, roleOf, workspaceErrorText, type Role,
} from '@/lib/web/workspace';

export default function WebWorkspace() {
  const {me} = useWeb();
  const mine = useMemo(() => managedWorkspaces(me), [me]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const ws = mine.find(w => w.org_id === orgId) ?? mine[0] ?? null;

  if (!ws) {
    return (
      <PvPage title="Workspace">
        <Empty>You do not run a workspace. The owner of your company’s workspace can make you a Manager or Admin.</Empty>
      </PvPage>
    );
  }
  return (
    <PvPage title={ws.name} subtitle={`Workspace · you are ${ws.level === 'owner' ? 'the owner' : `${ROLE_LABEL[ws.level]}`}`}
      right={mine.length > 1 ? (
        <select className="pv-input" value={ws.org_id} onChange={e => setOrgId(e.target.value)} aria-label="Workspace">
          {mine.map(w => <option key={w.org_id} value={w.org_id}>{w.name}</option>)}
        </select>
      ) : undefined}>
      <WorkspaceBody key={ws.org_id} ws={ws}/>
    </PvPage>
  );
}

function WorkspaceBody({ws}: {ws: ManagedWorkspace}) {
  const api = useMemo(() => workspaceApi(ws.org_id), [ws.org_id]);
  const {push} = useToast();
  const [members, setMembers] = useState<WsMember[] | null>(null);
  const [channels, setChannels] = useState<WsChannel[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [m, c] = await Promise.all([api.members(), api.channels()]);
      setMembers(m.filter(x => x.status !== 'removed'));
      setChannels(c.channels.filter(x => !x.archived));
      setLoadErr(null);
    } catch (e) { setLoadErr(workspaceErrorText(e)); }
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);

  const done = (text: string) => { push({kind: 'ok', text}); void refresh(); };
  const fail = (e: unknown) => push({kind: 'err', text: workspaceErrorText(e)});

  return (
    <>
      {loadErr && <div className="pv-err" role="alert">{loadErr}</div>}
      <div className="pv-grid">
        <MembersCard ws={ws} api={api} members={members} onDone={done} onFail={fail}/>
        <ChannelsCard api={api} members={members} channels={channels} onDone={done}/>
      </div>
    </>
  );
}

type Api = ReturnType<typeof workspaceApi>;

function MembersCard({ws, api, members, onDone, onFail}: {
  ws: ManagedWorkspace; api: Api; members: WsMember[] | null;
  onDone: (msg: string) => void; onFail: (e: unknown) => void;
}) {
  const [needle, setNeedle] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [suspend, setSuspend] = useState<WsMember | null>(null);
  const [remove, setRemove] = useState<WsMember | null>(null);
  const name = (m: WsMember) => m.display_name ?? m.email ?? 'Member';

  const add = async () => {
    const v = needle.trim();
    if (!v) return;
    setAdding(true);
    try { await api.addMember(v); setNeedle(''); onDone('Added to the workspace.'); }
    catch (e) { onFail(e); } finally { setAdding(false); }
  };
  const run = async (m: WsMember, fn: () => Promise<unknown>, msg: string) => {
    setBusyId(m.member_user_id);
    try { await fn(); onDone(msg); } catch (e) { onFail(e); } finally { setBusyId(null); }
  };
  const order: Record<Role, number> = {admin: 0, manager: 1, employee: 2};
  const rows = (members ?? []).filter(m => m.member_role !== 'cpo')
    .sort((a, b) => order[roleOf(a)] - order[roleOf(b)] || name(a).localeCompare(name(b)));

  return (
    <PvCard title="Members">
      <form className="pv-actions" style={{marginTop: 0}} onSubmit={e => { e.preventDefault(); void add(); }}>
        <input className="pv-input" style={{flex: 1}} value={needle} onChange={e => setNeedle(e.target.value)}
          placeholder="Add by email or phone (+971…)" aria-label="Email or phone"/>
        <button className="btn btn-pri" disabled={adding || !needle.trim()}>{adding ? 'Adding…' : 'Add'}</button>
      </form>
      {!members ? <Empty>Loading…</Empty> : rows.length === 0 ? <Empty>No members yet.</Empty> : (
        <div className="pv-table-wrap">
          <table className="pv-table">
            <thead><tr><th>Member</th><th>Role</th><th>Status</th><th aria-label="Actions"/></tr></thead>
            <tbody>
              {rows.map(m => {
                const r = roleOf(m);
                const busy = busyId === m.member_user_id;
                return (
                  <tr key={m.member_user_id}>
                    <td>
                      <div>{name(m)}</div>
                      <div className="pv-cell-sub">{m.email ?? ''}</div>
                    </td>
                    <td>
                      {canChangeRole(ws.level, m) ? (
                        <select className="pv-input" value={r} disabled={busy} aria-label={`Role of ${name(m)}`}
                          onChange={e => {
                            const next = e.target.value as Role;
                            void run(m, () => api.setRole(m.member_user_id, next), `${name(m)} is now ${ROLE_LABEL[next] === 'Admin' ? 'an Admin' : `a ${ROLE_LABEL[next]}`}.`);
                          }}>
                          {(['employee', 'manager', 'admin'] as Role[])
                            .map(o => <option key={o} value={o}>{ROLE_LABEL[o]}</option>)}
                        </select>
                      ) : <span className={`pill ${r === 'employee' ? '' : 'pill-act'}`}>{ROLE_LABEL[r]}</span>}
                    </td>
                    <td>
                      <span className={`pill ${m.status === 'suspended' ? 'pill-err' : 'pill-ok'}`}>{m.status === 'suspended' ? 'Suspended' : 'Active'}</span>
                      {m.status === 'suspended' && m.suspend_reason && <div className="pv-cell-sub">{m.suspend_reason}</div>}
                    </td>
                    <td className="pv-row-actions">
                      {canChangeStatus(ws.level, m) && (m.status === 'suspended' ? (
                        <button className="btn btn-sm btn-sec" disabled={busy}
                          onClick={() => void run(m, () => api.setStatus(m.member_user_id, 'active'), `${name(m)} reinstated.`)}>Reinstate</button>
                      ) : (
                        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setSuspend(m)}>Suspend</button>
                      ))}
                      {canChangeStatus(ws.level, m) && (
                        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setRemove(m)}>Remove</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="pv-hint">
        User: the channels they are added to. Manager: runs channels and members. Admin: everything the owner can do,
        except change the owner or another Admin.
      </p>
      <SuspendDialog member={suspend} api={api} onClose={() => setSuspend(null)}
        onDone={msg => { setSuspend(null); onDone(msg); }}/>
      <ConfirmDialog open={!!remove} title={`Remove ${remove ? name(remove) : ''}?`} danger confirmLabel="Remove"
        description="They lose access to this workspace’s channels. Their own Bravo account is not affected."
        onClose={() => setRemove(null)}
        onConfirm={async () => {
          if (!remove) return;
          await api.setStatus(remove.member_user_id, 'removed');
          const n = name(remove);
          setRemove(null);
          onDone(`${n} removed.`);
        }}/>
    </PvCard>
  );
}

function SuspendDialog({member, api, onClose, onDone}: {
  member: WsMember | null; api: Api; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!member) return null;
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.setStatus(member.member_user_id, 'suspended', {
        suspend_reason: reason.trim(),
        suspended_until: until ? new Date(`${until}T23:59:00`).toISOString() : null,
      });
      setReason(''); setUntil('');
      onDone(`${member.display_name ?? 'Member'} suspended.`);
    } catch (e) { setErr(workspaceErrorText(e)); } finally { setBusy(false); }
  };
  return (
    <PvDialog open title={`Suspend ${member.display_name ?? 'member'}?`} busy={busy} onClose={onClose}
      description="They lose workspace access until reinstated. They see your reason when they open the app. Channels you chose them for are given back when they are reinstated."
      footer={<>
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn btn-danger" disabled={busy || reason.trim().length < 3} onClick={() => void submit()}>{busy ? 'Suspending…' : 'Suspend'}</button>
      </>}>
      <div className="pv-form">
        <label className="pv-field">
          <span className="pv-label">Reason</span>
          <textarea className="pv-input" rows={3} value={reason} onChange={e => setReason(e.target.value)} maxLength={280}/>
        </label>
        <label className="pv-field">
          <span className="pv-label">Until (optional)</span>
          <input className="pv-input" type="date" value={until} onChange={e => setUntil(e.target.value)}/>
        </label>
        {err && <div className="pv-err" role="alert">{err}</div>}
      </div>
    </PvDialog>
  );
}

const ACCESS_OPTIONS = [
  {key: 'standard', label: 'Standard — everyone in it posts', access: 'standard', post_mode: 'open'},
  {key: 'read_only', label: 'Read only — managers post', access: 'standard', post_mode: 'read_only'},
  {key: 'restricted', label: 'Restricted — managers only', access: 'restricted', post_mode: 'read_only'},
] as const;

function ChannelsCard({api, members, channels, onDone}: {
  api: Api; members: WsMember[] | null; channels: WsChannel[] | null; onDone: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rows = (channels ?? []).filter(c => !c.is_broadcast);
  return (
    <PvCard title="Channels" right={<button className="btn btn-sm btn-pri" onClick={() => setOpen(true)}>New channel</button>}>
      {!channels ? <Empty>Loading…</Empty> : rows.length === 0 ? <Empty>No channels yet.</Empty> : (
        <div className="pv-table-wrap">
          <table className="pv-table">
            <thead><tr><th>Channel</th><th>Who posts</th><th className="pv-num">Members</th></tr></thead>
            <tbody>
              {rows.map(c => (
                <tr key={c.id}>
                  <td>
                    <div>{'— '.repeat(Math.max(0, c.level - 1))}{c.name}</div>
                    {!c.provisioned && <div className="pv-cell-sub">Starts when an admin opens Workspace channels in the Bravo app</div>}
                  </td>
                  <td>{c.access === 'restricted' ? 'Managers only' : c.post_mode === 'open' ? 'Everyone' : 'Managers'}</td>
                  <td className="pv-num">{c.member_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="pv-hint">Add or remove people in an existing channel from the Bravo app (channel → Members).</p>
      {open && <NewChannelDialog api={api} members={members} channels={rows}
        onClose={() => setOpen(false)} onDone={msg => { setOpen(false); onDone(msg); }}/>}
    </PvCard>
  );
}

function NewChannelDialog({api, members, channels, onClose, onDone}: {
  api: Api; members: WsMember[] | null; channels: WsChannel[];
  onClose: () => void; onDone: (msg: string) => void;
}) {
  const [name, setName] = useState('');
  const [access, setAccess] = useState<(typeof ACCESS_OPTIONS)[number]['key']>('standard');
  const [parent, setParent] = useState('');
  const [mode, setMode] = useState<'everyone' | 'choose'>('everyone');
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const people = (members ?? []).filter(m => m.status === 'active' && m.member_role === 'employee');
  const parents = channels.filter(c => !c.is_lateral && c.level < 3 && c.access !== 'restricted');
  const toggle = (id: string) => setChosen(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const submit = async () => {
    const opt = ACCESS_OPTIONS.find(o => o.key === access)!;
    if (mode === 'choose' && chosen.size === 0) { setErr('Choose at least one member, or pick Everyone.'); return; }
    setBusy(true); setErr(null);
    try {
      await api.createChannel({
        name: name.trim(), access: opt.access, post_mode: opt.post_mode,
        ...(parent ? {parent_id: parent} : {}),
        ...(mode === 'choose' ? {member_ids: [...chosen]} : {}),
      });
      onDone(`Channel “${name.trim()}” created.`);
    } catch (e) { setErr(workspaceErrorText(e)); } finally { setBusy(false); }
  };
  return (
    <PvDialog open wide title="New channel" busy={busy} onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn btn-pri" disabled={busy || !name.trim()} onClick={() => void submit()}>{busy ? 'Creating…' : 'Create channel'}</button>
      </>}>
      <div className="pv-form">
        <label className="pv-field">
          <span className="pv-label">Name</span>
          <input className="pv-input" value={name} maxLength={80} onChange={e => setName(e.target.value)}/>
        </label>
        <label className="pv-field">
          <span className="pv-label">Inside (optional)</span>
          <select className="pv-input" value={parent} onChange={e => setParent(e.target.value)}>
            <option value="">Top level</option>
            {parents.map(c => <option key={c.id} value={c.id}>{'— '.repeat(Math.max(0, c.level - 1))}{c.name}</option>)}
          </select>
        </label>
        <label className="pv-field">
          <span className="pv-label">Access</span>
          <select className="pv-input" value={access} onChange={e => setAccess(e.target.value as typeof access)}>
            {ACCESS_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </label>
        {access !== 'restricted' && (
          <div className="pv-field">
            <span className="pv-label">Members</span>
            <label className="pv-check"><input type="radio" checked={mode === 'everyone'} onChange={() => setMode('everyone')}/> Everyone</label>
            <label className="pv-check"><input type="radio" checked={mode === 'choose'} onChange={() => setMode('choose')}/> Choose members</label>
            {mode === 'choose' && (
              <div style={{display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto', paddingLeft: 4}}>
                {people.length === 0 ? <span className="pv-hint">No members yet. Add people under Members first.</span>
                  : people.map(m => (
                    <label key={m.member_user_id} className="pv-check">
                      <input type="checkbox" checked={chosen.has(m.member_user_id)} onChange={() => toggle(m.member_user_id)}/>
                      {m.display_name ?? m.email ?? 'Member'}
                    </label>
                  ))}
                <span className="pv-hint">{`${chosen.size} selected · managers are always included`}</span>
              </div>
            )}
          </div>
        )}
        {err && <div className="pv-err" role="alert">{err}</div>}
      </div>
    </PvDialog>
  );
}
