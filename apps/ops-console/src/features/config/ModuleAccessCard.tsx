'use client';

/**
 * Module Access matrix (2026-09-27). Rows are modules, columns are account
 * groups; both come from GET /ops/module-access, so a new backend module shows
 * up here with no console change. A cell for a group the module does not exist
 * for is "—", never a switch.
 */

import {useState, type CSSProperties} from 'react';
import useSWR from 'swr';
import {ApiError, opsApi, useOpsMe} from '@/lib/api';
import {canManageModules} from '@/lib/rbac';

export function ModuleAccessCard() {
  const {data: me} = useOpsMe();
  const allowed = canManageModules(me?.admin.role);
  const {data, error, mutate} = useSWR(allowed ? 'module-access' : null, () => opsApi.moduleAccess(), {
    refreshInterval: 30_000,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (me && !allowed) {
    return <div className="card"><div className="cfg-meta" style={{padding: '14px 16px'}}>
      SUPER ADMIN ONLY — module access is managed by platform administrators.
    </div></div>;
  }
  if (error) {
    return <div className="card"><div className="modal-err" style={{padding: '14px 16px'}}>
      Could not load module access{error instanceof ApiError ? ` (${error.status})` : ''}.
    </div></div>;
  }
  if (!data) {return <div className="card"><div className="cfg-meta" style={{padding: '14px 16px'}}>Loading…</div></div>;}

  const cell = (g: string, m: string) => data.cells.find(c => c.group === g && c.module === m);

  async function toggle(groupId: string, moduleKey: string, next: boolean) {
    const g = data!.groups.find(x => x.id === groupId)!;
    const m = data!.modules.find(x => x.key === moduleKey)!;
    if (!next) {
      // eslint-disable-next-line no-alert
      if (!window.confirm(`Switch OFF “${m.label}” for ${g.label}?\n\nThe server refuses it immediately: ${m.serverGate}\n\nUsers with a per-user override are not affected.`)) {return;}
    }
    const id = `${groupId}:${moduleKey}`;
    setBusy(id); setErr(null);
    try {
      await opsApi.setGroupModule(groupId, moduleKey, next);
      await mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not change module access');
    } finally {setBusy(null);}
  }

  const offCount = data.cells.filter(c => c.applicable && c.enabled === false).length;

  return (
    <>
      <div className="card" style={{marginBottom: 16}}>
        <div className="card-header">
          <div className="card-header-title"><span className="bar" />Modules by account group</div>
          <div className="card-header-act">{offCount === 0 ? 'EVERYTHING ON' : `${offCount} SWITCHED OFF`}</div>
        </div>
        <div style={{overflowX: 'auto'}}>
          <table style={{width: '100%', borderCollapse: 'collapse', minWidth: 720}}>
            <thead>
              <tr>
                <th style={th}>Module</th>
                {data.groups.map(g => (
                  <th key={g.id} style={{...th, textAlign: 'center'}} title={g.description}>{g.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.modules.map(m => (
                <tr key={m.key} style={{borderTop: '1px solid var(--bd-2)'}}>
                  <td style={{padding: '12px 16px', verticalAlign: 'top'}}>
                    <div className="cfg-name">{m.label}</div>
                    <div className="cfg-meta" style={{marginTop: 4, maxWidth: 380, lineHeight: 1.5}}>
                      {m.description} <span style={{color: 'var(--tx-3)'}}>Off blocks: {m.serverGate}</span>
                    </div>
                  </td>
                  {data.groups.map(g => {
                    const c = cell(g.id, m.key);
                    if (!c?.applicable) {
                      return <td key={g.id} style={{textAlign: 'center', color: 'var(--tx-3)'}} title="Not part of this group's product">—</td>;
                    }
                    const on = c.enabled !== false;
                    const id = `${g.id}:${m.key}`;
                    return (
                      <td key={g.id} style={{textAlign: 'center', padding: '12px 8px'}}>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={on}
                          aria-label={`${m.label} for ${g.label}`}
                          disabled={busy === id}
                          onClick={() => { void toggle(g.id, m.key, !on); }}
                          className={on ? 'pill pill-ok' : 'pill pill-err'}
                          style={{cursor: 'pointer', minWidth: 64}}>
                          {busy === id ? '…' : on ? '● ON' : '○ OFF'}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {err && <div className="modal-err" style={{padding: '0 16px 12px'}}>{err}</div>}
      </div>

      <div className="card" style={{marginBottom: 16}}>
        <div className="card-header"><div className="card-header-title"><span className="bar" />Always on</div></div>
        {data.alwaysOn.map(a => (
          <div key={a.key} style={{padding: '10px 16px', borderBottom: '1px solid var(--bd-2)'}}>
            <span className="cfg-name">{a.label}</span> <span className="pill pill-ok" style={{marginLeft: 8}}>ALWAYS ON</span>
            <div className="cfg-meta" style={{marginTop: 4}}>{a.reason}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-header"><div className="card-header-title"><span className="bar" />Not controllable here yet</div></div>
        {data.notYet.map(a => (
          <div key={a.key} style={{padding: '10px 16px', borderBottom: '1px solid var(--bd-2)'}}>
            <span className="cfg-name">{a.label}</span> <span className="pill pill-warn" style={{marginLeft: 8}}>COMING NEXT</span>
            <div className="cfg-meta" style={{marginTop: 4}}>{a.reason}</div>
          </div>
        ))}
        <div className="cfg-meta" style={{padding: '12px 16px', lineHeight: 1.6}}>
          The mobile apps hide switched-off modules from their next release onwards; older app
          versions still show the tile but the server answers “not available on your account”.
        </div>
      </div>
    </>
  );
}

const th: CSSProperties = {
  textAlign: 'left', padding: '10px 16px', fontSize: 11, letterSpacing: '0.08em',
  textTransform: 'uppercase', color: 'var(--tx-3)', fontWeight: 700, whiteSpace: 'nowrap',
};
