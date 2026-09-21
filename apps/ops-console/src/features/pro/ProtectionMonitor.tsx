'use client';

/**
 * Protection Monitoring (spec §8). Live sessions table (SWR 2s) with §6
 * server-clock staleness colours + SOS pills; a detail panel with the live
 * map (latest fix), and the two SUPERVISOR/ADMIN mutations — END (reason
 * required) and TRANSFER (edge J). Obsidian tokens, no legacy navy (G8).
 */
import {useMemo, useState} from 'react';
import {BravoMap, type BravoMarker} from '@/components/BravoMapLazy';
import {ConfirmReasonModal} from '@/components/ConfirmReasonModal';
import {
  ApiError, opsProtectionApi, useOpsMe, useProtectionSessions, useProtectionSession, useProtectionTimeline,
  type ProtectionSessionRow, type ProtectionStalenessState,
} from '@/lib/api';
import {formatDateTimeShortUtc} from '@/lib/datetime';
import {useRouter} from 'next/navigation';
import {PageHeader} from '@/components/PageHeader';
import {routes} from '@/lib/routes';
import {canEndProtectionSession} from '@/lib/rbac';

const C = {
  bg: '#06142B', panel: '#0E1420', hair: 'rgba(255,255,255,0.08)', text: '#FFFFFF',
  dim: 'rgba(229,233,242,0.62)', mute: 'rgba(180,188,204,0.45)', accent: '#1E88FF',
  live: '#00C853', delayed: '#F5C76B', unavailable: '#FF3B3B', idle: '#8A93A6',
};
const STALE_COLOR: Record<ProtectionStalenessState, string> = {
  live: C.live, delayed: C.delayed, unavailable: C.unavailable, idle: C.idle,
};
const STALE_LABEL: Record<ProtectionStalenessState, string> = {
  live: 'LIVE', delayed: 'DELAYED', unavailable: 'UNAVAILABLE', idle: 'IDLE',
};

function ageText(sec: number | null): string {
  if (sec === null) {return '—';}
  if (sec < 60) {return `${sec}s`;}
  return `${Math.floor(sec / 60)}m`;
}
function durationText(activatedAt: string | null, endedAt: string | null, serverNow: string): string {
  if (!activatedAt) {return '—';}
  // Freeze at ended_at once the session is over — never keep ticking off `now`.
  const end = endedAt ? Date.parse(endedAt) : Date.parse(serverNow);
  const ms = Math.max(0, end - Date.parse(activatedAt));
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function eventLabel(type: string): string {
  const m: Record<string, string> = {
    created: 'Created', activated: 'Activated', protect: 'CPO Protect', sos: 'SOS',
    note: 'Update', ended: 'Ended', aborted: 'Aborted', timeout: 'Timed out', reassigned: 'Reassigned',
  };
  return m[type] ?? type;
}
function roleColor(role: string): string {
  return role === 'cpo' ? C.accent : role === 'ops' ? C.delayed : role === 'system' ? C.mute : C.live;
}

/**
 * IA-01/IA-12 — Secure Pro protection sessions.
 *
 * Two changes beyond the move out of the Safety group (where it sat next to the
 * SOS log, nowhere near the plans it serves):
 *  - the selected session is a ROUTE (/pro/protection/:id), so an operator can
 *    hand a colleague the session they are looking at;
 *  - the role check goes through rbac.ts. This page hand-rolled
 *    `role === 'SUPERVISOR' || role === 'ADMIN'`, one of the two RBAC dialects
 *    OC-12 flagged — a capability that cannot drift silently is the point of
 *    having the module.
 */
export function ProtectionMonitor({selectedId}: {selectedId?: string | null}) {
  const router = useRouter();
  const [status, setStatus] = useState<'live' | 'all'>('live');
  const selected = selectedId ?? null;
  const setSelected = (id: string | null) => {
    router.push(id ? routes.pro.session(id) : routes.pro.protection);
  };
  const {data, error, mutate} = useProtectionSessions(status);
  const {data: me} = useOpsMe();
  const canMutate = canEndProtectionSession(me?.admin?.role);

  // Stable identity so the SOS tally memo does not recompute every render.
  const sessions = useMemo(() => data?.sessions ?? [], [data]);
  const serverNow = data?.server_now ?? new Date(0).toISOString();

  const sosCount = useMemo(() => sessions.filter(s => s.sos_active).length, [sessions]);

  return (
    <>
      <div style={{color: C.text, minHeight: '100%'}}>
        <PageHeader
          title="Secure Pro — Protection Sessions"
          subtitle="Live sessions a plan holder has activated, with their assigned officer. Ending or transferring one is SUPERVISOR+ and audited."
          badges={sosCount > 0 ? <span className="pill pill-err">⚠ {sosCount} SOS ACTIVE</span> : undefined}
          actions={
            <div style={{display: 'flex', gap: 6}}>
              {(['live', 'all'] as const).map(k => (
                <button key={k} onClick={() => setStatus(k)}
                  className={`btn btn-sm ${status === k ? 'btn-sec' : 'btn-ghost'}`}>
                  {k === 'live' ? 'Live' : 'All'}
                </button>
              ))}
            </div>
          }
        />

        {error && <div style={{color: C.unavailable, marginBottom: 12}}>Failed to load sessions.</div>}

        <div style={{display: 'grid', gridTemplateColumns: selected ? '1.4fr 1fr' : '1fr', gap: 16}}>
          {/* Table */}
          <div style={panel()}>
            <table style={{width: '100%', borderCollapse: 'collapse', fontSize: 13}}>
              <thead>
                <tr style={{color: C.mute, textAlign: 'left'}}>
                  <th style={th}>Customer</th><th style={th}>Officer</th><th style={th}>Mission</th>
                  <th style={th}>Protection</th><th style={th}>Duration</th><th style={th}>Last fix</th><th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((sn: ProtectionSessionRow) => {
                  const col = STALE_COLOR[sn.staleness.state];
                  return (
                    <tr key={sn.id} style={{borderTop: `1px solid ${C.hair}`, cursor: 'pointer',
                      background: selected === sn.id ? 'rgba(91,141,239,0.08)' : undefined}}
                      onClick={() => setSelected(sn.id)}>
                      <td style={td}>{sn.customer_name ?? '—'} {sn.sos_active && <span style={pill(C.unavailable)}>SOS</span>}</td>
                      <td style={td}>{sn.cpo_name ?? '—'}</td>
                      <td style={td}>{sn.status}</td>
                      <td style={td}>{sn.protection_status === 'active' ? 'Active' : sn.protection_status === 'ended' ? 'Ended' : 'Not activated'}</td>
                      <td style={{...td, fontVariantNumeric: 'tabular-nums'}}>{durationText(sn.activated_at, sn.ended_at, serverNow)}</td>
                      <td style={td}>
                        {sn.status === 'COMPLETED'
                          ? <span style={{color: C.mute}}>—</span>
                          : <span style={{...pill(col), borderColor: col + '66', color: col}}>
                              {STALE_LABEL[sn.staleness.state]} · {ageText(sn.staleness.age_seconds)}
                            </span>}
                      </td>
                      <td style={td}><button style={linkBtn}>View →</button></td>
                    </tr>
                  );
                })}
                {sessions.length === 0 && (
                  <tr><td style={{...td, color: C.mute}} colSpan={7}>No {status === 'live' ? 'live' : ''} sessions.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {selected && (
            <Detail id={selected} canMutate={canMutate} onClose={() => setSelected(null)} onChanged={() => void mutate()} />
          )}
        </div>
      </div>
    </>
  );
}

function Detail({id, canMutate, onClose, onChanged}: {id: string; canMutate: boolean; onClose: () => void; onChanged: () => void}) {
  const {data, mutate} = useProtectionSession(id);
  const {data: tl} = useProtectionTimeline(id);
  const [endOpen, setEndOpen] = useState(false);
  const [xferOpen, setXferOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mapView, setMapView] = useState<'client' | 'cpo' | 'combined'>('combined');

  const session = data?.session;
  const trail = data?.trail ?? [];
  const cpoTrail = data?.cpo_trail ?? [];
  const notes = data?.notes ?? [];
  const latest = trail[0];
  const cpoLatest = cpoTrail[0];
  const stale = data?.staleness;
  const col = stale ? STALE_COLOR[stale.state] : C.idle;
  const protectActive = Boolean(session?.protect_activated_at);
  const latestNote = notes[notes.length - 1];

  const custMarker: BravoMarker | null = latest
    ? {id: 'cust', lat: latest.lat, lng: latest.lng, label: String(session?.customer_name ?? 'Client'), type: 'pickup'}
    : null;
  const cpoMarker: BravoMarker | null = cpoLatest
    ? {id: 'cpo', lat: cpoLatest.lat, lng: cpoLatest.lng, label: String(session?.cpo_name ?? 'Officer'), type: 'dropoff'}
    : null;
  const view = mapView === 'client'
    ? {markers: [custMarker].filter(Boolean) as BravoMarker[], center: custMarker}
    : mapView === 'cpo'
      ? {markers: [cpoMarker].filter(Boolean) as BravoMarker[], center: cpoMarker}
      : {markers: [custMarker, cpoMarker].filter(Boolean) as BravoMarker[], center: custMarker ?? cpoMarker};

  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); onChanged(); void mutate(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Action failed'); }
    finally { setBusy(false); setEndOpen(false); setXferOpen(false); }
  }

  return (
    <div style={panel()}>
      <div style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12}}>
        <strong>{String(session?.customer_name ?? 'Session')}</strong>
        {stale && session?.status !== 'COMPLETED' && <span style={{...pill(col), borderColor: col + '66', color: col}}>
          {STALE_LABEL[stale.state]} · {ageText(stale.age_seconds)}</span>}
        <button onClick={onClose} style={{...linkBtn, marginLeft: 'auto'}}>Close</button>
      </div>

      {Boolean((session as {sos_active?: boolean} | undefined)?.sos_active) && (
        <div style={{...pill(C.unavailable), display: 'block', padding: 10, marginBottom: 12}}>
          ⚠ SOS ACTIVE — coordinate a response. Ending the session does NOT resolve the SOS.
        </div>
      )}

      {/* 3 maps — Client / CPO / Combined (satellite) */}
      <div style={{display: 'flex', gap: 6, marginBottom: 8}}>
        {(['client', 'cpo', 'combined'] as const).map(v => (
          <button key={v} onClick={() => setMapView(v)} style={tab(mapView === v)}>
            {v === 'client' ? 'Client' : v === 'cpo' ? 'CPO' : 'Combined'}
          </button>
        ))}
      </div>
      <div style={{height: 240, borderRadius: 12, overflow: 'hidden', border: `1px solid ${C.hair}`}}>
        {view.center
          ? <BravoMap center={[view.center.lng, view.center.lat]} markers={view.markers} styleId="satellite" style={{width: '100%', height: '100%'}} />
          : <div style={{height: '100%', display: 'grid', placeItems: 'center', color: C.mute}}>
              {mapView === 'cpo' ? 'No officer location yet' : 'No location yet'}
            </div>}
      </div>

      {/* Mission status vs Protection status (§9 — clearly distinct) */}
      <div style={{display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap'}}>
        <span style={{...pill(C.accent), marginLeft: 0, color: C.accent, borderColor: C.accent + '66'}}>
          MISSION · {String(session?.status ?? '—')}
        </span>
        <span style={{...pill(protectActive ? C.live : C.idle), marginLeft: 0, color: protectActive ? C.live : C.idle, borderColor: (protectActive ? C.live : C.idle) + '66'}}>
          PROTECTION · {tl?.protection_status === 'active' ? 'ACTIVE' : tl?.protection_status === 'ended' ? 'ENDED' : 'NOT ACTIVATED'}
        </span>
      </div>

      <div style={{fontSize: 12, color: C.dim, marginTop: 12, lineHeight: 1.8}}>
        <div>Officer: <span style={{color: C.text}}>{String(session?.cpo_name ?? '—')}</span></div>
        <div>Started: <span style={{color: C.text}}>{session?.activated_at ? formatDateTimeShortUtc(String(session.activated_at)) : '—'}</span></div>
        {latestNote && <div>Latest update: <span style={{color: C.text}}>{latestNote.body}</span> <span style={{color: C.mute}}>({latestNote.sender === 'cpo' ? 'CPO' : 'Client'})</span></div>}
      </div>

      {/* Canonical mission-history timeline (append-only, full audit) */}
      {(tl?.events?.length ?? 0) > 0 && (
        <div style={{marginTop: 12}}>
          <div style={{fontSize: 10, fontWeight: 700, letterSpacing: 1, color: C.mute, textTransform: 'uppercase', marginBottom: 6}}>Activity timeline</div>
          <div style={{maxHeight: 220, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6}}>
            {tl!.events.map(e => (
              <div key={e.id} style={{fontSize: 12, color: C.dim, display: 'flex', gap: 6}}>
                <span style={{color: roleColor(e.actor_role), fontWeight: 700, whiteSpace: 'nowrap'}}>{eventLabel(e.event_type)}</span>
                {e.comment ? <span style={{color: C.text, flex: 1, minWidth: 0}}>{e.comment}</span> : <span style={{flex: 1}} />}
                <span style={{color: C.mute, whiteSpace: 'nowrap'}}>{formatDateTimeShortUtc(e.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {err && <div style={{color: C.unavailable, marginTop: 10}}>{err}</div>}

      {canMutate && String(session?.status ?? '') !== 'COMPLETED' && String(session?.status ?? '') !== 'ABORTED' && (
        <div style={{display: 'flex', gap: 8, marginTop: 14}}>
          <button style={btn(C.unavailable)} disabled={busy} onClick={() => setEndOpen(true)}>End session</button>
          <button style={btn(C.accent)} disabled={busy} onClick={() => setXferOpen(true)}>Transfer</button>
        </div>
      )}

      <ConfirmReasonModal
        open={endOpen} title="End protection session" danger busy={busy}
        description="Ends the live session. The customer stops sharing location. Any SOS stays open."
        reasonLabel="Reason" reasonPlaceholder="Why is ops ending this session?"
        confirmLabel="End session"
        onConfirm={reason => void act(() => opsProtectionApi.end(id, reason))}
        onCancel={() => setEndOpen(false)} />

      <ConfirmReasonModal
        open={xferOpen} title="Transfer to another officer" busy={busy}
        description="Re-pins this session to a different officer (edge J). Notifies both officers and the customer."
        reasonLabel="New officer user ID" reasonPlaceholder="cpo user_id (UUID)" minReasonLength={8}
        confirmLabel="Transfer"
        onConfirm={cpoId => void act(() => opsProtectionApi.transfer(id, cpoId.trim()))}
        onCancel={() => setXferOpen(false)} />
    </div>
  );
}

// ── inline style helpers (obsidian, G8) ──
const th: React.CSSProperties = {padding: '10px 12px', fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase'};
const td: React.CSSProperties = {padding: '10px 12px'};
const linkBtn: React.CSSProperties = {background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontSize: 13, fontWeight: 700};
function panel(): React.CSSProperties {
  return {background: C.panel, border: `1px solid ${C.hair}`, borderRadius: 14, padding: 14, overflow: 'auto'};
}
function pill(color: string): React.CSSProperties {
  return {display: 'inline-block', padding: '2px 8px', borderRadius: 99, border: `1px solid ${color}66`, color, fontSize: 10, fontWeight: 800, letterSpacing: 0.5, marginLeft: 6};
}
function tab(active: boolean): React.CSSProperties {
  return {padding: '6px 14px', borderRadius: 10, border: `1px solid ${active ? C.accent : C.hair}`, background: active ? 'rgba(91,141,239,0.14)' : 'transparent', color: active ? '#4CC2FF' : C.dim, cursor: 'pointer', fontSize: 13, fontWeight: 700};
}
function btn(color: string): React.CSSProperties {
  return {padding: '9px 16px', borderRadius: 10, border: `1px solid ${color}66`, background: color + '18', color, cursor: 'pointer', fontSize: 13, fontWeight: 700};
}
