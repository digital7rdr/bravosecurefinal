'use client';

import {useMemo, useState} from 'react';
import {useSWRConfig} from 'swr';
import {NotGranted, useProvider} from '@/components/provider/ProviderShell';
import {Empty, PvCard, PvDialog, PvPage, availability} from '@/components/provider/ui';
import {useToast} from '@/components/Toast';
import {pvApi, usePvInvites, usePvRoster, type RosterMember} from '@/lib/provider/api';
import {errorText, when} from '@/lib/provider/labels';

type Filter = 'all' | 'available' | 'mission' | 'off' | 'suspended';

function randomPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint32Array(14);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

export default function ProviderCrew() {
  const {orgId, can, isOwner, org} = useProvider();
  const roster = can('roster');
  const {data: members, error} = usePvRoster(orgId, roster);
  const {data: invites} = usePvInvites(orgId, roster);
  const {mutate} = useSWRConfig();
  const {push} = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [suspend, setSuspend] = useState<RosterMember | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = () => mutate((k: unknown) => Array.isArray(k) && k[0] === 'pv');

  const rows = useMemo(() => (members ?? [])
    .filter(m => m.status !== 'removed' && m.member_role !== 'employee')
    .filter(m => {
      const a = availability(m);
      if (filter === 'available') return a.ok;
      if (filter === 'mission') return m.on_mission;
      if (filter === 'off') return m.status === 'active' && !m.on_duty && !m.on_mission;
      if (filter === 'suspended') return m.status === 'suspended';
      return true;
    })
    .filter(m => !q || `${m.display_name ?? ''} ${m.call_sign ?? ''} ${m.email ?? ''}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.member_role === b.member_role ? 0 : a.member_role === 'manager' ? -1 : 1)
      || (a.display_name ?? '').localeCompare(b.display_name ?? '')), [members, filter, q]);

  if (!roster) return <PvPage title="Officers"><NotGranted what="Officer roster"/></PvPage>;

  const all = (members ?? []).filter(m => m.status !== 'removed' && m.member_role === 'cpo');
  const free = all.filter(m => availability(m).ok).length;
  const openInvites = (invites ?? []).filter(i => i.status === 'open');

  async function run(id: string, fn: () => Promise<unknown>, ok: string) {
    setBusyId(id);
    try { await fn(); push({kind: 'ok', text: ok}); await refresh(); }
    catch (e) { push({kind: 'err', text: errorText(e)}); }
    finally { setBusyId(null); }
  }

  return (
    <PvPage title="Officers"
      subtitle={`${all.length} officer${all.length === 1 ? '' : 's'} at ${org.name || 'your agency'} · ${free} available now`}
      right={<>
        <button className="btn btn-ghost" onClick={() => setInviting(true)}>Invite with a code</button>
        <button className="btn btn-pri" onClick={() => setAdding(true)}>Add officer</button>
      </>}>
      <PvCard pad={false}>
        <div className="pv-toolbar">
          <div className="pv-seg">
            {([['all', 'All'], ['available', 'Available'], ['mission', 'On a mission'], ['off', 'Off duty'], ['suspended', 'Suspended']] as const).map(([k, l]) => (
              <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>
            ))}
          </div>
          <input className="pv-search" placeholder="Search name, call sign or email" value={q} onChange={e => setQ(e.target.value)} aria-label="Search officers"/>
        </div>
        {error ? <Empty>Could not load the roster. It will retry automatically.</Empty>
          : !members ? <Empty>Loading…</Empty>
          : rows.length === 0 ? <Empty>No officers match.</Empty>
          : (
            <div className="pv-table-wrap">
              <table className="pv-table">
                <thead><tr><th>Officer</th><th>Role</th><th>Now</th><th>Missions</th><th>Branch</th><th aria-label="Actions"/></tr></thead>
                <tbody>
                  {rows.map(m => {
                    const a = availability(m);
                    const busy = busyId === m.member_user_id;
                    return (
                      <tr key={m.member_user_id}>
                        <td>
                          <div className="pv-person">
                            <span className="pv-av">{(m.display_name ?? '?').split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase()}</span>
                            <span>
                              <div>{m.display_name ?? 'Unnamed'} {m.call_sign && <span className="pv-mono pv-cell-sub">· {m.call_sign}</span>}</div>
                              <div className="pv-cell-sub">{m.email ?? ''}</div>
                            </span>
                          </div>
                        </td>
                        <td>
                          {m.member_role === 'manager' ? <span className="pill pill-act">Manager</span> : <span className="pill">Officer</span>}
                          {m.armed_authorized && <span className="pill pill-info" style={{marginLeft: 6}}>Armed</span>}
                        </td>
                        <td>
                          <span className={`pill ${a.ok ? 'pill-ok' : m.on_mission ? 'pill-act' : m.status === 'suspended' ? 'pill-err' : ''}`}>{a.label}</span>
                          {m.status === 'suspended' && <div className="pv-cell-sub">{m.suspended_until ? `until ${when(m.suspended_until)}` : 'until reinstated'}</div>}
                          {m.status === 'active' && m.agent_status && !['ACTIVE', 'APPROVED'].includes(m.agent_status) && (
                            <div className="pv-cell-sub">Onboarding: {m.agent_status.toLowerCase().replace(/_/g, ' ')}</div>
                          )}
                        </td>
                        <td className="pv-num">{m.missions_completed}</td>
                        <td>{m.department ?? <span className="pv-cell-sub">—</span>}</td>
                        <td className="pv-row-actions">
                          {m.status === 'active' && (
                            <button className="btn btn-sm btn-ghost" disabled={busy || m.on_mission}
                              title={m.on_mission ? 'Cannot suspend during a mission' : undefined}
                              onClick={() => setSuspend(m)}>Suspend</button>
                          )}
                          {m.status === 'suspended' && (
                            <button className="btn btn-sm btn-sec" disabled={busy}
                              onClick={() => run(m.member_user_id, () => pvApi.setStatus(m.member_user_id, 'active'), `${m.display_name ?? 'Officer'} reinstated.`)}>Reinstate</button>
                          )}
                          {isOwner && m.status === 'active' && (
                            <button className="btn btn-sm btn-ghost" disabled={busy}
                              onClick={() => run(m.member_user_id, () => pvApi.setRole(m.member_user_id, m.member_role === 'manager' ? 'cpo' : 'manager'),
                                m.member_role === 'manager' ? 'Changed to officer.' : 'Made a manager. Set what they can open under Managers.')}>
                              {m.member_role === 'manager' ? 'Make officer' : 'Make manager'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </PvCard>

      <PvCard title="Invitation codes" right={<span>{openInvites.length} open</span>} pad={false}>
        {!invites ? <Empty>Loading…</Empty> : invites.length === 0 ? (
          <Empty>No codes yet. A code lets an officer who already has the Bravo Secure app join your agency.</Empty>
        ) : (
          <div className="pv-table-wrap">
            <table className="pv-table">
              <thead><tr><th>Code</th><th>For</th><th>Status</th><th>Expires</th><th>Used by</th><th aria-label="Actions"/></tr></thead>
              <tbody>
                {invites.slice(0, 20).map(i => (
                  <tr key={i.code}>
                    <td className="pv-mono pv-strong">{i.code}</td>
                    <td>{i.member_role === 'manager' ? 'Manager' : 'Officer'}{i.call_sign ? ` · ${i.call_sign}` : ''}</td>
                    <td><span className={`pill ${i.status === 'open' ? 'pill-ok' : ''}`}>{i.status}</span></td>
                    <td>{when(i.expires_at)}</td>
                    <td>{i.redeemed_by_name ?? <span className="pv-cell-sub">—</span>}</td>
                    <td className="pv-row-actions">
                      {i.status === 'open' && (
                        <button className="btn btn-sm btn-ghost" disabled={busyId === i.code}
                          onClick={() => run(i.code, () => pvApi.revokeInvite(i.code), 'Code revoked.')}>Revoke</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PvCard>

      <AddOfficerDialog open={adding} canManager={isOwner} onClose={() => setAdding(false)}
        onDone={msg => { setAdding(false); push({kind: 'ok', text: msg, ttlMs: 12_000}); void refresh(); }}/>
      <InviteDialog open={inviting} canManager={isOwner} onClose={() => setInviting(false)} onDone={() => void refresh()}/>
      <SuspendDialog member={suspend} onClose={() => setSuspend(null)}
        onDone={msg => { setSuspend(null); push({kind: 'ok', text: msg}); void refresh(); }}/>
    </PvPage>
  );
}

function Input({label, hint, ...rest}: {label: string; hint?: string} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="pv-field">
      <span className="pv-label">{label}</span>
      <input className="pv-input" {...rest}/>
      {hint && <span className="pv-cell-sub">{hint}</span>}
    </label>
  );
}

function AddOfficerDialog({open, canManager, onClose, onDone}: {open: boolean; canManager: boolean; onClose: () => void; onDone: (msg: string) => void}) {
  const [f, setF] = useState({display_name: '', email: '', phone: '', call_sign: '', password: '', role: 'cpo' as 'cpo' | 'manager'});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF(s => ({...s, [k]: e.target.value}));
  const phone = f.phone.replace(/[\s\-().]/g, '');
  const valid = f.display_name.trim().length >= 2 && /.+@.+\..+/.test(f.email) && /^\+[0-9]{7,15}$/.test(phone) && f.password.length >= 10;

  async function submit() {
    setBusy(true); setErr(null);
    try {
      await pvApi.createCpo({
        display_name: f.display_name.trim(), email: f.email.trim(), phone_e164: phone,
        temp_password: f.password, call_sign: f.call_sign.trim() || undefined, member_role: f.role,
      });
      onDone(`${f.display_name.trim()} added. Give them their temporary password; they choose a new one at first sign-in, then upload their documents.`);
      setF({display_name: '', email: '', phone: '', call_sign: '', password: '', role: 'cpo'});
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  }

  return (
    <PvDialog open={open} title="Add an officer" busy={busy} onClose={onClose}
      description="Creates a Bravo Secure account for the officer under your agency. They sign in to the app with this phone number and the temporary password."
      footer={<>
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn btn-pri" disabled={busy || !valid} onClick={submit}>{busy ? 'Adding…' : 'Add officer'}</button>
      </>}>
      <div className="pv-form">
        <Input label="Full name" value={f.display_name} onChange={set('display_name')} autoComplete="off"/>
        <Input label="Email" type="email" value={f.email} onChange={set('email')} autoComplete="off"/>
        <Input label="Mobile number" hint="With country code, for example +971 50 123 4567." value={f.phone} onChange={set('phone')} inputMode="tel" autoComplete="off"/>
        <Input label="Call sign (optional)" value={f.call_sign} onChange={set('call_sign')} autoComplete="off"/>
        <label className="pv-field">
          <span className="pv-label">Temporary password</span>
          <span style={{display: 'flex', gap: 8}}>
            <input className="pv-input pv-mono" value={f.password} onChange={set('password')} autoComplete="new-password" style={{flex: 1}}/>
            <button type="button" className="btn btn-ghost" onClick={() => setF(s => ({...s, password: randomPassword()}))}>Generate</button>
          </span>
          <span className="pv-cell-sub">At least 10 characters. Share it with the officer privately.</span>
        </label>
        {canManager && (
          <label className="pv-field">
            <span className="pv-label">Role</span>
            <select className="pv-input" value={f.role} onChange={set('role')}>
              <option value="cpo">Officer</option>
              <option value="manager">Manager</option>
            </select>
          </label>
        )}
        {err && <div className="pv-err" role="alert">{err}</div>}
      </div>
    </PvDialog>
  );
}

function InviteDialog({open, canManager, onClose, onDone}: {open: boolean; canManager: boolean; onClose: () => void; onDone: () => void}) {
  const [role, setRole] = useState<'cpo' | 'manager'>('cpo');
  const [callSign, setCallSign] = useState('');
  const [days, setDays] = useState('7');
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const close = () => { setCode(null); setErr(null); setCallSign(''); onClose(); };

  async function mint() {
    setBusy(true); setErr(null);
    try {
      const r = await pvApi.mintInvite({member_role: role, call_sign: callSign.trim() || undefined, expires_in_days: Number(days)});
      setCode(r.code); onDone();
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  }

  return (
    <PvDialog open={open} title="Invite with a code" busy={busy} onClose={close}
      description="For someone who already has the Bravo Secure app. They enter the code under Join your provider."
      footer={code ? <button className="btn btn-pri" onClick={close}>Done</button> : <>
        <button className="btn btn-ghost" disabled={busy} onClick={close}>Cancel</button>
        <button className="btn btn-pri" disabled={busy} onClick={mint}>{busy ? 'Creating…' : 'Create code'}</button>
      </>}>
      {code ? (
        <div className="pv-code-box">
          <span className="pv-label">Invitation code</span>
          <code>{code}</code>
          <button className="btn btn-sm btn-ghost" onClick={() => { void navigator.clipboard?.writeText(code).catch(() => undefined); }}>Copy</button>
        </div>
      ) : (
        <div className="pv-form">
          {canManager && (
            <label className="pv-field">
              <span className="pv-label">Joins as</span>
              <select className="pv-input" value={role} onChange={e => setRole(e.target.value as 'cpo' | 'manager')}>
                <option value="cpo">Officer</option>
                <option value="manager">Manager</option>
              </select>
            </label>
          )}
          <Input label="Call sign (optional)" value={callSign} maxLength={24} onChange={e => setCallSign(e.target.value)}/>
          <label className="pv-field">
            <span className="pv-label">Valid for</span>
            <select className="pv-input" value={days} onChange={e => setDays(e.target.value)}>
              <option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option>
            </select>
          </label>
          {err && <div className="pv-err" role="alert">{err}</div>}
        </div>
      )}
    </PvDialog>
  );
}

function SuspendDialog({member, onClose, onDone}: {member: RosterMember | null; onClose: () => void; onDone: (msg: string) => void}) {
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!member) return null;
  async function submit() {
    if (!member) return;
    setBusy(true); setErr(null);
    try {
      await pvApi.setStatus(member.member_user_id, 'suspended', {
        suspend_reason: reason.trim(),
        suspended_until: until ? new Date(`${until}T23:59:00`).toISOString() : null,
      });
      setReason(''); setUntil('');
      onDone(`${member.display_name ?? 'Officer'} suspended.`);
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <PvDialog open title={`Suspend ${member.display_name ?? 'officer'}?`} busy={busy} onClose={onClose}
      description="They cannot take missions while suspended. They see your reason when they open the app."
      footer={<>
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn btn-danger" disabled={busy || reason.trim().length < 3} onClick={submit}>{busy ? 'Suspending…' : 'Suspend'}</button>
      </>}>
      <div className="pv-form">
        <label className="pv-field">
          <span className="pv-label">Reason</span>
          <textarea className="pv-input" rows={3} value={reason} onChange={e => setReason(e.target.value)} maxLength={280}/>
        </label>
        <Input label="Until (optional)" type="date" value={until} onChange={e => setUntil(e.target.value)} hint="Leave empty to suspend until you reinstate them."/>
        {err && <div className="pv-err" role="alert">{err}</div>}
      </div>
    </PvDialog>
  );
}
