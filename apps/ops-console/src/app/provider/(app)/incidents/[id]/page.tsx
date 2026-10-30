'use client';

/**
 * One incident (provider console, 2026-10-31) — the app's IncidentDetailScreen:
 * the report, its status steps, the owner, the timeline and internal notes.
 *
 * Evidence photos and videos are end-to-end encrypted to the managers' phones
 * (a sealed key per device), so this page only says how many there are and
 * points to the app. It never fetches or decrypts them.
 */

import Link from 'next/link';
import {useParams} from 'next/navigation';
import {useMemo, useState} from 'react';
import {useSWRConfig} from 'swr';
import {NotGranted, useProvider} from '@/components/provider/ProviderShell';
import {ConfirmDialog, Empty, PvCard, PvPage} from '@/components/provider/ui';
import {useToast} from '@/components/Toast';
import {pillClass} from '@/lib/status';
import {usePvRoster} from '@/lib/provider/api';
import {
  INCIDENT_CATEGORY_LABEL, INCIDENT_STATUS_LABEL, SEVERITY_LABEL, canAssignIncident, deptError, deptErrorText,
  incidentNextSteps, isDeptKey, pvIncidentApi, usePvIncident, usePvIncidentFiles,
  type IncidentStatus,
} from '@/lib/provider/api-dept';
import {when} from '@/lib/provider/labels';
import {pvRoutes} from '@/lib/provider/routes';

const statusName = (s: string | null) => (s ? INCIDENT_STATUS_LABEL[s as IncidentStatus]?.label ?? s.replace(/_/g, ' ') : 'New');

export default function ProviderIncident() {
  const {id} = useParams<{id: string}>();
  const {orgId, isOwner, can, context} = useProvider();
  const allowed = can('dept');
  const me = context.user.id;
  const {data, error} = usePvIncident(orgId, allowed ? id : null);
  const {data: files} = usePvIncidentFiles(orgId, allowed ? id : null);
  const {data: roster} = usePvRoster(orgId, allowed);
  const {mutate} = useSWRConfig();
  const {push} = useToast();
  const [move, setMove] = useState<IncidentStatus | null>(null);
  const [moveNote, setMoveNote] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const names = useMemo(() => new Map((roster ?? []).map(m => [m.member_user_id, m.display_name ?? m.email ?? null])), [roster]);
  // Only the agency itself and active managers can own an incident (server rule).
  const owners = useMemo(() => {
    const list: Array<{id: string; label: string}> = [{id: me, label: 'Me'}];
    if (orgId !== me) list.push({id: orgId, label: 'Agency owner'});
    for (const m of roster ?? []) {
      if (m.member_role === 'manager' && m.status === 'active' && m.member_user_id !== me && m.member_user_id !== orgId) {
        list.push({id: m.member_user_id, label: m.display_name ?? m.email ?? 'Manager'});
      }
    }
    return list;
  }, [roster, me, orgId]);

  if (!allowed) return <PvPage title="Incident"><NotGranted what="Departmental"/></PvPage>;

  const back = <Link href={pvRoutes.incidents} className="btn btn-ghost">All incidents</Link>;
  if (error) return <PvPage title="Incident" right={back}><PvCard><Empty>{deptErrorText(error)}</Empty></PvCard></PvPage>;
  if (!data) return <PvPage title="Incident" right={back}><PvCard><Empty>Loading…</Empty></PvCard></PvPage>;

  const r = data.report;
  const nameOf = (uid: string | null): string | null => {
    if (!uid) return null;
    if (uid === me) return 'You';
    if (uid === orgId) return 'Agency owner';
    return names.get(uid) ?? (uid === r.submitter_id ? 'Reporter' : 'Team member');
  };
  const sev = SEVERITY_LABEL[r.severity] ?? {label: r.severity, tone: 'muted' as const};
  const st = INCIDENT_STATUS_LABEL[r.status] ?? {label: r.status, tone: 'muted' as const};
  const next = incidentNextSteps(r.status, isOwner);
  const assignable = canAssignIncident(r.status);
  const refresh = () => mutate(isDeptKey);

  async function assign(uid: string) {
    if (!uid || uid === r.assigned_to) return;
    setBusy(true);
    try {
      await pvIncidentApi.assign(r.id, uid);
      push({kind: 'ok', text: `Owner set to ${owners.find(o => o.id === uid)?.label ?? 'the selected manager'}.`});
      await refresh();
    } catch (e) { push({kind: 'err', text: deptErrorText(e)}); }
    finally { setBusy(false); }
  }

  async function addNote() {
    const text = note.trim();
    if (!text) return;
    setBusy(true);
    try {
      await pvIncidentApi.addNote(r.id, text, true);
      setNote('');
      push({kind: 'ok', text: 'Note added.'});
      await refresh();
    } catch (e) { push({kind: 'err', text: deptErrorText(e)}); }
    finally { setBusy(false); }
  }

  const fileCount = files?.length ?? 0;

  return (
    <PvPage
      title={<>Incident {r.ref ? <span className="pv-mono">{r.ref}</span> : null}</>}
      subtitle={<>{INCIDENT_CATEGORY_LABEL[r.category] ?? r.category} · reported {when(r.created_at)} by {nameOf(r.submitter_id)}</>}
      right={back}>
      <div className="pv-grid pv-grid-wide">
        <div className="pv-col">
          <PvCard title="Report" right={<><span className={pillClass(sev.tone)}>{sev.label}</span> <span className={pillClass(st.tone)}>{st.label}</span></>}>
            <p style={{margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.6, color: 'var(--tx-1)'}}>{r.description}</p>
            <dl className="pv-facts">
              <div><dt>Category</dt><dd>{INCIDENT_CATEGORY_LABEL[r.category] ?? r.category}</dd></div>
              <div><dt>Department</dt><dd>{r.department ?? 'Whole agency'}</dd></div>
              <div><dt>Last update</dt><dd>{when(r.updated_at)}</dd></div>
              <div style={{gridColumn: '1 / -1'}}><dt>Where</dt><dd>
                {r.location_label ?? 'Not given'}
                {typeof r.location_lat === 'number' && typeof r.location_lng === 'number'
                  ? <span className="pv-cell-sub pv-mono"> · {r.location_lat.toFixed(4)}, {r.location_lng.toFixed(4)}</span> : null}
              </dd></div>
            </dl>
          </PvCard>

          <PvCard title="Evidence">
            {files === undefined ? <p className="pv-cell-sub" style={{margin: 0}}>Checking…</p>
              : fileCount === 0 ? <p className="pv-cell-sub" style={{margin: 0}}>No photos or videos were attached.</p>
              : (
                <p style={{margin: 0, fontSize: 13.5, lineHeight: 1.55}}>
                  {fileCount} {fileCount === 1 ? 'photo or video is' : 'photos or videos are'} attached. They are end-to-end
                  encrypted to your phone, so open this incident in the Bravo Secure app to view them.
                </p>
              )}
          </PvCard>

          <PvCard title="Timeline">
            {data.events.length === 0 ? <p className="pv-cell-sub" style={{margin: 0}}>Nothing yet.</p> : (
              <ul className="pv-list">
                {data.events.map(ev => (
                  <li key={ev.id} style={{padding: '10px 0'}}>
                    <div style={{display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap'}}>
                      <span className="pv-strong" style={{fontSize: 13.5}}>
                        {ev.to_status && ev.to_status !== ev.from_status ? `${statusName(ev.from_status)} → ${statusName(ev.to_status)}`
                          : ev.to_status ? 'Owner changed' : 'Note'}
                      </span>
                      {ev.note_internal ? <span className="pill pill-warn">Managers only</span> : null}
                      <span className="pv-cell-sub">{when(ev.created_at)} · {nameOf(ev.actor_id)}</span>
                    </div>
                    {ev.note ? <div style={{fontSize: 13, marginTop: 4, whiteSpace: 'pre-wrap', color: 'var(--tx-2)'}}>{ev.note}</div> : null}
                  </li>
                ))}
              </ul>
            )}
          </PvCard>
        </div>

        <div className="pv-col">
          <PvCard title="Next step">
            {next.length === 0 ? (
              <p className="pv-cell-sub" style={{margin: 0}}>
                {r.status === 'closed' ? 'This incident is closed. Only the agency owner can reopen it.' : 'No further steps.'}
              </p>
            ) : (
              <div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
                {next.map(to => (
                  <button key={to} className={`btn ${to === 'under_review' && (r.status === 'resolved' || r.status === 'closed') ? 'btn-ghost' : 'btn-pri'}`}
                    disabled={busy} onClick={() => { setMoveNote(''); setMove(to); }}>
                    {to === 'under_review' && (r.status === 'resolved' || r.status === 'closed') ? 'Reopen' : `Mark ${INCIDENT_STATUS_LABEL[to].label.toLowerCase()}`}
                  </button>
                ))}
              </div>
            )}
            <p className="pv-note">The reporter is notified when the status changes.</p>
          </PvCard>

          <PvCard title="Owner">
            <label className="pv-field">
              <span className="pv-label">Who is handling it</span>
              <select className="pv-input" value={r.assigned_to ?? ''} disabled={busy || !assignable}
                onChange={e => void assign(e.target.value)}>
                {!r.assigned_to && <option value="">Unassigned</option>}
                {r.assigned_to && !owners.some(o => o.id === r.assigned_to) && <option value={r.assigned_to}>{nameOf(r.assigned_to)}</option>}
                {owners.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </label>
            {!assignable && <p className="pv-note">Resolved and closed incidents keep their owner.</p>}
          </PvCard>

          <PvCard title="Add a note">
            <label className="pv-field">
              <span className="pv-label">Visible to managers only, never to the reporter</span>
              <textarea className="pv-input" rows={4} maxLength={2000} value={note} onChange={e => setNote(e.target.value)}/>
            </label>
            <div className="pv-actions">
              <button className="btn btn-pri" disabled={busy || !note.trim()} onClick={addNote}>{busy ? 'Saving…' : 'Add note'}</button>
            </div>
          </PvCard>
        </div>
      </div>

      <ConfirmDialog open={move !== null} title="Update status"
        description={<>
          Move this incident to <b>{move ? INCIDENT_STATUS_LABEL[move].label : ''}</b>?
          <textarea className="pv-input" rows={2} maxLength={2000} value={moveNote} onChange={e => setMoveNote(e.target.value)}
            placeholder="Note for managers (optional)" style={{display: 'block', width: '100%', marginTop: 12, boxSizing: 'border-box'}}/>
        </>}
        confirmLabel="Update"
        onClose={() => setMove(null)}
        onConfirm={async () => {
          if (!move) return;
          try {
            await pvIncidentApi.updateStatus(r.id, move, moveNote);
          } catch (e) { throw deptError(e); }
          setMove(null);
          push({kind: 'ok', text: `Moved to ${INCIDENT_STATUS_LABEL[move].label.toLowerCase()}.`});
          await refresh();
        }}/>
    </PvPage>
  );
}
