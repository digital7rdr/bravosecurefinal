'use client';

/**
 * Internal → Apps (Super Admin, 2026-10-10): the tiles on the Bravo Secure home
 * site (bravosecure.cloud). For each app: whether it is active, where it opens,
 * where agency owners and managers go instead, which kinds of account may open
 * it, and whether an authenticator is required. The server enforces exactly
 * this on every launch; every change is audited with before/after values.
 */
import {useEffect, useState} from 'react';
import useSWR from 'swr';
import {PageHeader} from '@/components/PageHeader';
import {useToast} from '@/components/Toast';
import {ApiError, opsApi, useOpsMe, type PlatformApp} from '@/lib/api';
import {canManagePlatformApps} from '@/lib/rbac';

const AUDIENCE_LABEL: Record<string, string> = {
  client: 'Clients',
  officer: 'Officers (CPOs)',
  agency: 'Agency owners & managers',
  ops: 'HQ staff',
};

type Draft = Pick<PlatformApp, 'name' | 'tagline' | 'active' | 'url' | 'agency_url' | 'allowed_audiences' | 'requires_totp'>;

const toDraft = (a: PlatformApp): Draft => ({
  name: a.name, tagline: a.tagline, active: a.active, url: a.url, agency_url: a.agency_url,
  allowed_audiences: [...a.allowed_audiences], requires_totp: a.requires_totp,
});

function errorText(e: unknown): string {
  const raw = e instanceof ApiError ? e.message : '';
  const map: Record<string, string> = {
    url_invalid: 'The address must start with https://.',
    agency_url_invalid: 'The agency address must start with https://.',
    url_required_to_activate: 'Add the address before activating the app.',
    audience_invalid: 'Choose who may open the app from the list.',
  };
  return map[raw] ?? (raw || 'Could not save. Try again.');
}

function AppRow({app, onSaved}: {app: PlatformApp; onSaved: () => void}) {
  const [d, setD] = useState<Draft>(() => toDraft(app));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const {push} = useToast();
  useEffect(() => { setD(toDraft(app)); }, [app]);

  const dirty = JSON.stringify(d) !== JSON.stringify(toDraft(app));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD(s => ({...s, [k]: v}));

  async function save() {
    setBusy(true); setErr(null);
    try {
      await opsApi.updatePlatformApp(app.key, {
        ...d,
        url: d.url?.trim() ? d.url.trim() : null,
        agency_url: d.agency_url?.trim() ? d.agency_url.trim() : null,
      });
      push({kind: 'ok', text: `${d.name} saved.`});
      onSaved();
    } catch (e) { setErr(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <div style={{padding: '14px 16px', borderBottom: '1px solid var(--bd-2)'}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap'}}>
        <span className="cfg-name">{app.name}</span>
        <span className={d.active ? 'pill pill-ok' : 'pill'}>{d.active ? 'ACTIVE' : 'INACTIVE'}</span>
        {d.requires_totp && <span className="pill pill-warn">AUTHENTICATOR</span>}
        <span className="cfg-meta" style={{fontFamily: 'var(--font-mono)'}}>{app.key}</span>
        <span style={{flex: 1}}/>
        <label className="cfg-meta" style={{display: 'flex', gap: 6, alignItems: 'center'}}>
          <input type="checkbox" checked={d.active} onChange={e => set('active', e.target.checked)}/> Active
        </label>
      </div>
      <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10, marginTop: 10}}>
        <label className="cfg-meta">Name
          <input className="modal-input" value={d.name} maxLength={60} onChange={e => set('name', e.target.value)}/>
        </label>
        <label className="cfg-meta">Subtitle
          <input className="modal-input" value={d.tagline} maxLength={80} onChange={e => set('tagline', e.target.value)}/>
        </label>
        <label className="cfg-meta">Opens at
          <input className="modal-input" style={{fontFamily: 'var(--font-mono)'}} value={d.url ?? ''} placeholder="https://…"
            spellCheck={false} onChange={e => set('url', e.target.value)}/>
        </label>
        <label className="cfg-meta">Agency owners & managers open (optional)
          <input className="modal-input" style={{fontFamily: 'var(--font-mono)'}} value={d.agency_url ?? ''} placeholder="https://provider…"
            spellCheck={false} onChange={e => set('agency_url', e.target.value)}/>
        </label>
      </div>
      <div style={{display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', marginTop: 10}}>
        <span className="cfg-meta">Who may open it:</span>
        {Object.entries(AUDIENCE_LABEL).map(([k, label]) => (
          <label key={k} className="cfg-meta" style={{display: 'flex', gap: 6, alignItems: 'center'}}>
            <input type="checkbox" checked={d.allowed_audiences.includes(k)}
              onChange={e => set('allowed_audiences', e.target.checked ? [...d.allowed_audiences, k] : d.allowed_audiences.filter(x => x !== k))}/>
            {label}
          </label>
        ))}
        <label className="cfg-meta" style={{display: 'flex', gap: 6, alignItems: 'center'}}>
          <input type="checkbox" checked={d.requires_totp} onChange={e => set('requires_totp', e.target.checked)}/>
          Requires an authenticator app
        </label>
      </div>
      {err && <div className="modal-err">{err}</div>}
      {dirty && (
        <div style={{display: 'flex', gap: 8, marginTop: 10}}>
          <button className="btn btn-sm btn-pri" disabled={busy} onClick={() => void save()}>{busy ? 'SAVING…' : 'SAVE'}</button>
          <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => { setD(toDraft(app)); setErr(null); }}>CANCEL</button>
        </div>
      )}
    </div>
  );
}

export default function PlatformAppsPage() {
  const {data: me} = useOpsMe();
  const allowed = canManagePlatformApps(me?.admin.role);
  const {data, error, mutate} = useSWR(allowed ? 'platform-apps' : null, () => opsApi.platformApps());

  return (
    <>
      <PageHeader title="Apps"
        subtitle="The tiles on the Bravo Secure home page (bravosecure.cloud). Turn apps on or off, set where each one opens and who may open it. People sign in once on the home page; the server checks these settings every time an app is opened. Inactive apps show faded." />
      {!me ? null : !allowed ? (
        <div className="card" style={{padding: 20}}>Only a Super Admin can manage the home page apps.</div>
      ) : error ? (
        <div className="card" style={{padding: 20}}>Could not load the apps. It will retry.</div>
      ) : !data ? (
        <div className="card" style={{padding: 20}}>Loading…</div>
      ) : (
        <div className="card">
          <div className="card-header">
            <div className="card-header-title"><span className="bar"/>Home page apps</div>
            <div className="card-header-act">{data.apps.filter(a => a.active).length}/{data.apps.length} ACTIVE</div>
          </div>
          {data.apps.map(a => <AppRow key={a.key} app={a} onSaved={() => void mutate()}/>)}
          <div className="cfg-meta" style={{padding: '12px 16px', lineHeight: 1.7}}>
            Kinds of account: <b>Clients</b> are personal Bravo accounts; <b>Officers</b> are CPOs of an agency;
            <b> Agency owners & managers</b> run a service provider; <b>HQ staff</b> are ops console admins.
            Every change is written to the audit log.
          </div>
        </div>
      )}
    </>
  );
}
