'use client';

/**
 * Integrations — runtime third-party keys (2026-09-27).
 *
 * Renders whatever catalog GET /ops/settings returns, grouped by provider, so a
 * new backend setting appears here with no console change. Secrets are
 * WRITE-ONLY: the server returns a masked preview (••••1234), the input is
 * never pre-filled, and the typed value is dropped from state after save.
 */

import {useState} from 'react';
import useSWR from 'swr';
import {ApiError, opsApi, useOpsMe, type IntegrationSetting} from '@/lib/api';
import {canManageIntegrations} from '@/lib/rbac';

const SOURCE_PILL: Record<IntegrationSetting['source'], {cls: string; text: string}> = {
  db: {cls: 'pill pill-ok', text: 'SET IN CONSOLE'},
  env: {cls: 'pill pill-info', text: 'FROM DEPLOY ENV'},
  unset: {cls: 'pill pill-warn', text: 'NOT SET'},
};

function fmtWhen(iso: string | null): string {
  if (!iso) {return '';}
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function IntegrationsCard() {
  const {data: me} = useOpsMe();
  const allowed = canManageIntegrations(me?.admin.role);
  const {data, error, mutate} = useSWR(
    allowed ? 'integration-settings' : null,
    () => opsApi.integrationSettings(),
    {refreshInterval: 30_000},
  );

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<{key: string; msg: string} | null>(null);

  if (me && !allowed) {
    return (
      <div className="card"><div style={{padding: '14px 16px'}} className="cfg-meta">
        SUPER ADMIN ONLY — integration keys are managed by platform administrators.
      </div></div>
    );
  }
  if (error) {
    return (
      <div className="card"><div style={{padding: '14px 16px'}} className="modal-err">
        Could not load integration settings{error instanceof ApiError ? ` (${error.status})` : ''}.
      </div></div>
    );
  }
  if (!data) {
    return <div className="card"><div style={{padding: '14px 16px'}} className="cfg-meta">Loading…</div></div>;
  }

  function startEdit(s: IntegrationSetting) {
    setErr(null);
    setEditing(s.key);
    // Never pre-fill a secret. A non-secret is pre-filled only when the preview
    // is the full value (the server truncates long plain values with "…").
    setDraft(!s.secret && s.preview && !s.preview.endsWith('…') ? s.preview : '');
  }

  function cancel() {
    setEditing(null);
    setDraft('');
  }

  async function save(s: IntegrationSetting) {
    const value = draft.trim();
    if (!value) {setErr({key: s.key, msg: 'Enter a value, or use “Revert to env” to remove it.'}); return;}
    setBusy(s.key); setErr(null);
    try {
      await opsApi.setIntegrationSetting(s.key, value);
      setEditing(null);
      setDraft(''); // drop the secret from memory as soon as it is saved
      await mutate();
    } catch (e) {
      setErr({key: s.key, msg: e instanceof ApiError ? e.message : 'Could not save'});
    } finally {setBusy(null);}
  }

  async function revert(s: IntegrationSetting) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Remove the console value for “${s.label}”? The servers will fall back to the deployment environment${s.secret ? '' : ' value'}, or to nothing if it is not set there.`)) {return;}
    setBusy(s.key); setErr(null);
    try {
      await opsApi.clearIntegrationSetting(s.key);
      await mutate();
    } catch (e) {
      setErr({key: s.key, msg: e instanceof ApiError ? e.message : 'Could not revert'});
    } finally {setBusy(null);}
  }

  return (
    <>
      {!data.encryptionAvailable && (
        <div className="card" style={{marginBottom: 16, borderColor: 'var(--warn)'}}>
          <div style={{padding: '12px 16px'}}>
            <span className="pill pill-warn">SECRETS LOCKED</span>
            <div className="cfg-meta" style={{marginTop: 8, lineHeight: 1.6}}>
              The server has no usable <code>SETTINGS_ENCRYPTION_KEY</code>
              {data.encryptionReason ? ` (${data.encryptionReason})` : ''}, so secret values cannot be
              saved. Non-secret values (price IDs, numbers) still work. Set the key in the auth-service
              environment and restart it — see docs/runbooks/INTEGRATION_SETTINGS.md.
            </div>
          </div>
        </div>
      )}

      {data.categories.map(cat => {
        const rows = data.settings.filter(s => s.category === cat.id);
        if (rows.length === 0) {return null;}
        const setCount = rows.filter(r => r.configured).length;
        return (
          <div className="card" key={cat.id} style={{marginBottom: 16}}>
            <div className="card-header">
              <div className="card-header-title"><span className="bar" />{cat.label}</div>
              <div className="card-header-act">{setCount}/{rows.length} CONFIGURED</div>
            </div>
            {rows.map(s => {
              const pill = SOURCE_PILL[s.source];
              const isEditing = editing === s.key;
              const locked = s.secret && !data.encryptionAvailable;
              return (
                <div key={s.key} style={{padding: '12px 16px', borderBottom: '1px solid var(--bd-2)'}}>
                  <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap'}}>
                    <span className="cfg-name">{s.label}</span>
                    {s.secret && <span className="pill">SECRET</span>}
                    <span className={pill.cls}>{pill.text}</span>
                    <span style={{flex: 1}} />
                    {!isEditing && (
                      <>
                        <button className="btn btn-sm btn-ghost" disabled={busy === s.key || locked}
                          title={locked ? 'Set SETTINGS_ENCRYPTION_KEY on the server first' : undefined}
                          onClick={() => startEdit(s)}>
                          {s.source === 'unset' ? 'SET' : s.secret ? 'REPLACE' : 'EDIT'}
                        </button>
                        {s.source === 'db' && (
                          <button className="btn btn-sm btn-ghost" disabled={busy === s.key}
                            onClick={() => { void revert(s); }}>
                            REVERT TO ENV
                          </button>
                        )}
                      </>
                    )}
                  </div>

                  <div className="cfg-meta" style={{marginTop: 5, fontFamily: 'var(--font-mono)'}}>
                    {s.key}
                    {s.preview !== null && <> · <span style={{color: 'var(--tx-1)'}}>{s.preview}</span></>}
                    {s.source === 'db' && s.updatedAt && <> · updated {fmtWhen(s.updatedAt)}</>}
                  </div>
                  {s.help && <div className="cfg-meta" style={{marginTop: 4}}>{s.help}</div>}

                  {isEditing && (
                    <form style={{display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap'}}
                      onSubmit={e => { e.preventDefault(); void save(s); }}>
                      <input
                        className="modal-input"
                        style={{flex: '1 1 320px', marginTop: 0, fontFamily: 'var(--font-mono)'}}
                        type={s.secret ? 'password' : 'text'}
                        autoComplete={s.secret ? 'new-password' : 'off'}
                        spellCheck={false}
                        autoFocus
                        aria-label={s.label}
                        placeholder={s.placeholder ?? (s.secret ? 'Paste the new value' : '')}
                        value={draft}
                        onChange={e => setDraft(e.target.value)} />
                      <button type="submit" className="btn btn-sm btn-pri" disabled={busy === s.key}>
                        {busy === s.key ? 'SAVING…' : 'SAVE'}
                      </button>
                      <button type="button" className="btn btn-sm btn-ghost" disabled={busy === s.key} onClick={cancel}>
                        CANCEL
                      </button>
                    </form>
                  )}
                  {err?.key === s.key && <div className="modal-err">{err.msg}</div>}
                </div>
              );
            })}
          </div>
        );
      })}

      <div className="cfg-meta" style={{lineHeight: 1.7}}>
        Precedence: a value set here wins; otherwise the server uses its deployment environment.
        Every change is written to the audit log with the key name — never the value. Mobile-app
        keys (the map tile token, Stripe publishable key) are baked into the app build and are not
        managed here yet.
      </div>
    </>
  );
}
