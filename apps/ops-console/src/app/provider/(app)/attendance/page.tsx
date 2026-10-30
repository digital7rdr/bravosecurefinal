'use client';

/**
 * Attendance (provider console, 2026-10-31) — the manager side of the app's
 * Departmental attendance dashboard (AdminAttendanceScreen + AttendanceDayScreen
 * + CorrectionsScreen): the present / late / absent numbers, the people behind
 * them, the check-ins waiting for a decision (approve / reject with a note),
 * the shift list, and append-only corrections.
 *
 * Creating and editing shifts, setting day status and the monthly roster stay
 * in the app for now; this page says so instead of hiding it.
 */

import {useEffect, useMemo, useState, type CSSProperties} from 'react';
import {useSWRConfig} from 'swr';
import {NotGranted, useProvider} from '@/components/provider/ProviderShell';
import {Empty, PvCard, PvDialog, PvPage, Stat} from '@/components/provider/ui';
import {useToast} from '@/components/Toast';
import {pillClass} from '@/lib/status';
import {usePvRoster} from '@/lib/provider/api';
import {
  CORRECTABLE_STATUSES, DAY_PRESETS, HHMM, attendanceLabel, correctionAfter, dayWindow, deptErrorText, isDeptKey,
  placeLabel, pvAttendanceApi, reviewReasonLabel, toHHMM, usePvAttDay, usePvAttPending, usePvAttSessions,
  usePvAttShifts, usePvAttSummary, usePvCorrections,
  type AttendanceStatus, type DayPreset, type ShiftSession,
} from '@/lib/provider/api-dept';
import {when} from '@/lib/provider/labels';

type Tab = 'review' | 'day' | 'shifts' | 'corrections';
type DayStatus = 'present' | 'late' | 'absent';

const TABS: Array<[Tab, string]> = [['review', 'Waiting for review'], ['day', 'Who checked in'], ['shifts', 'Shifts'], ['corrections', 'Corrections']];
const DAY_TABS: Array<[DayStatus, string]> = [['present', 'Present'], ['late', 'Late'], ['absent', 'Absent']];

const hm = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'}) : '—';
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', {weekday: 'short', day: '2-digit', month: 'short'});

const kpiBtn: CSSProperties = {background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit', display: 'block', width: '100%'};

function Person({s, nameOf}: {s: ShiftSession; nameOf?: (id: string) => string | null}) {
  const name = s.display_name ?? nameOf?.(s.cpo_user_id) ?? 'Team member';
  return (
    <>
      <div>{name}{s.call_sign ? <span className="pv-mono pv-cell-sub"> · {s.call_sign}</span> : null}</div>
      {s.department ? <div className="pv-cell-sub">{s.department}</div> : null}
    </>
  );
}

function Where({s}: {s: ShiftSession}) {
  const off = s.within_radius === false && typeof s.distance_m === 'number';
  return (
    <>
      <div className="pv-ellipsis" title={placeLabel(s)}>{placeLabel(s)}</div>
      {s.site_label ? <div className="pv-cell-sub">Site: {s.site_label}</div> : null}
      {off ? <div className="pv-cell-sub" style={{color: 'var(--warn)'}}>{Math.round(s.distance_m as number)} m from the site</div> : null}
    </>
  );
}

export default function ProviderAttendance() {
  const {orgId, can} = useProvider();
  const allowed = can('dept');
  const {mutate} = useSWRConfig();
  const {push} = useToast();

  const [tab, setTab] = useState<Tab>('review');
  const [preset, setPreset] = useState<DayPreset>('today');
  const [department, setDepartment] = useState('');
  const [dayStatus, setDayStatus] = useState<DayStatus>('present');
  const [review, setReview] = useState<{s: ShiftSession; decision: 'approve' | 'reject'} | null>(null);
  const [photoFor, setPhotoFor] = useState<ShiftSession | null>(null);
  const [correct, setCorrect] = useState<ShiftSession | null>(null);

  const win = useMemo(() => dayWindow(preset), [preset]);
  const dept = department || undefined;
  const {data: summary} = usePvAttSummary(orgId, {...win, department: dept}, allowed);
  const {data: pending, error: pendingErr} = usePvAttPending(orgId, dept, allowed);
  const {data: shifts, error: shiftsErr} = usePvAttShifts(orgId, allowed);
  const {data: roster} = usePvRoster(orgId, allowed);
  const {data: people, error: peopleErr} = usePvAttDay(orgId, {...win, status: dayStatus, department: dept}, allowed && tab === 'day');

  const departments = useMemo(() =>
    [...new Set((shifts ?? []).map(s => s.department).filter((d): d is string => !!d))].sort(), [shifts]);
  const names = useMemo(() => new Map((roster ?? []).map(m => [m.member_user_id, m.display_name ?? m.email ?? null])), [roster]);
  const nameOf = (id: string) => names.get(id) ?? null;

  if (!allowed) return <PvPage title="Attendance"><NotGranted what="Departmental"/></PvPage>;

  const refresh = () => mutate(isDeptKey);
  const c = summary?.counts ?? {};
  const openDay = (st: DayStatus) => { setDayStatus(st); setTab('day'); };

  return (
    <PvPage title="Attendance"
      subtitle="Check-ins from your team's app, the ones that need a decision, and corrections. The same records managers see in the app.">
      <PvCard pad={false}>
        <div className="pv-toolbar">
          <div className="pv-seg" role="group" aria-label="Period">
            {DAY_PRESETS.map(([k, l]) => (
              <button key={k} className={preset === k ? 'on' : ''} aria-pressed={preset === k} onClick={() => setPreset(k)}>{l}</button>
            ))}
          </div>
          {departments.length > 0 && (
            <label className="pv-hint" style={{display: 'flex', alignItems: 'center', gap: 8}}>
              Department
              <select className="pv-input" value={department} onChange={e => setDepartment(e.target.value)} style={{minHeight: 32, padding: '4px 10px'}}>
                <option value="">All departments</option>
                {departments.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="kpi-row" style={{gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', padding: 16}}>
          <button style={kpiBtn} onClick={() => openDay('present')} aria-label={`Present: ${c.present ?? 0}. Show who.`}>
            <Stat label="Present" value={summary ? c.present ?? 0 : '—'} tone="ok" sub="Show who"/>
          </button>
          <button style={kpiBtn} onClick={() => openDay('late')} aria-label={`Late: ${c.late ?? 0}. Show who.`}>
            <Stat label="Late" value={summary ? c.late ?? 0 : '—'} tone="warn" sub="Show who"/>
          </button>
          <button style={kpiBtn} onClick={() => openDay('absent')} aria-label={`Absent: ${c.absent ?? 0}. Show who.`}>
            <Stat label="Absent" value={summary ? c.absent ?? 0 : '—'} tone="err" sub="Show who"/>
          </button>
          <button style={kpiBtn} onClick={() => setTab('review')} aria-label="Show check-ins waiting for review">
            <Stat label="Waiting for review" value={summary ? summary.pendingReview : '—'} tone="act" sub="All dates"/>
          </button>
        </div>
      </PvCard>

      <PvCard pad={false}>
        <div className="pv-toolbar">
          <div className="pv-tabs" role="tablist">
            {TABS.map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={`pv-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
                {l}
                {k === 'review' && pending ? <span className="pv-tab-n">{pending.length}</span> : null}
              </button>
            ))}
          </div>
          {tab === 'day' && (
            <div className="pv-seg" role="group" aria-label="Status">
              {DAY_TABS.map(([k, l]) => (
                <button key={k} className={dayStatus === k ? 'on' : ''} aria-pressed={dayStatus === k} onClick={() => setDayStatus(k)}>{l}</button>
              ))}
            </div>
          )}
        </div>

        {tab === 'review' && (
          pendingErr ? <Empty>{deptErrorText(pendingErr)}</Empty>
          : !pending ? <Empty>Loading…</Empty>
          : pending.length === 0 ? <Empty>Nothing is waiting for review.</Empty>
          : (
            <div className="pv-table-wrap">
              <table className="pv-table">
                <thead><tr><th>Person</th><th>Checked in</th><th>Where</th><th>Why it needs review</th><th aria-label="Actions"/></tr></thead>
                <tbody>
                  {pending.map(s => (
                    <tr key={s.id}>
                      <td><Person s={s} nameOf={nameOf}/></td>
                      <td>{when(s.clock_in_at)}{s.clock_out_at ? <div className="pv-cell-sub">Out {hm(s.clock_out_at)}</div> : <div className="pv-cell-sub">Still on shift</div>}</td>
                      <td><Where s={s}/></td>
                      <td>
                        <span className="pill pill-warn">{reviewReasonLabel(s.review_reason) ?? 'Needs review'}</span>
                        {s.review_reason === 'disputed' && s.dispute_note ? <div className="pv-cell-sub" style={{maxWidth: 280, fontStyle: 'italic'}}>&ldquo;{s.dispute_note}&rdquo;</div> : null}
                      </td>
                      <td className="pv-row-actions">
                        {s.has_photo ? <button className="btn btn-sm btn-ghost" onClick={() => setPhotoFor(s)}>Face photo</button> : null}
                        <button className="btn btn-sm btn-ghost" disabled={s.status === 'open'}
                          title={s.status === 'open' ? 'Can be corrected once they check out' : undefined}
                          onClick={() => setCorrect(s)}>Correct</button>
                        <button className="btn btn-sm btn-ghost" onClick={() => setReview({s, decision: 'reject'})}>Reject</button>
                        <button className="btn btn-sm btn-pri" onClick={() => setReview({s, decision: 'approve'})}>Approve</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {tab === 'day' && (
          peopleErr ? <Empty>{deptErrorText(peopleErr)}</Empty>
          : !people ? <Empty>Loading…</Empty>
          : people.length === 0 ? <Empty>Nobody is {DAY_TABS.find(([k]) => k === dayStatus)?.[1].toLowerCase()} in this period.</Empty>
          : (
            <div className="pv-table-wrap">
              <table className="pv-table">
                <thead><tr><th>Person</th><th>Shift</th><th>Checked in</th><th>Checked out</th><th>Where</th><th>Status</th><th aria-label="Actions"/></tr></thead>
                <tbody>
                  {people.map(s => {
                    const st = attendanceLabel(s.attendance_status);
                    return (
                      <tr key={s.id}>
                        <td><Person s={s} nameOf={nameOf}/></td>
                        <td>{s.shift_start_at ? <>{day(s.shift_start_at)}<div className="pv-cell-sub">{hm(s.shift_start_at)}–{hm(s.shift_end_at)}</div></> : <span className="pv-cell-sub">No shift</span>}</td>
                        <td>{s.clock_in_at ? when(s.clock_in_at) : '—'}</td>
                        <td>{hm(s.clock_out_at)}</td>
                        <td>{s.clock_in_at ? <Where s={s}/> : '—'}</td>
                        <td><span className={pillClass(st.tone)}>{st.label}</span></td>
                        <td className="pv-row-actions">
                          {s.has_photo ? <button className="btn btn-sm btn-ghost" onClick={() => setPhotoFor(s)}>Face photo</button> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}

        {tab === 'shifts' && (
          shiftsErr ? <Empty>{deptErrorText(shiftsErr)}</Empty>
          : !shifts ? <Empty>Loading…</Empty>
          : (
            <>
              {shifts.length === 0 ? <Empty>No shifts yet.</Empty> : (
                <div className="pv-table-wrap">
                  <table className="pv-table">
                    <thead><tr><th>When</th><th>Department</th><th>Site</th><th className="pv-num">Check-in radius</th><th className="pv-num">Assigned</th></tr></thead>
                    <tbody>
                      {[...shifts].sort((a, b) => b.start_at.localeCompare(a.start_at))
                        .filter(s => !dept || s.department === dept)
                        .map(s => (
                          <tr key={s.id}>
                            <td>{day(s.start_at)}<div className="pv-cell-sub">{hm(s.start_at)}–{hm(s.end_at)}</div></td>
                            <td>{s.department ?? <span className="pv-cell-sub">Whole agency</span>}</td>
                            <td>{s.site_label ?? <span className="pv-cell-sub">No site set</span>}</td>
                            <td className="pv-num">{s.approved_radius_m} m</td>
                            <td className="pv-num">{s.assigned_count ?? '—'}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="pv-note" style={{padding: '0 16px 16px'}}>
                Create and edit shifts, set leave or day status, and plan the monthly roster in the Bravo Secure app.
              </p>
            </>
          )
        )}

        {tab === 'corrections' && (
          <CorrectionsList orgId={orgId} pending={pending} nameOf={nameOf} onPick={setCorrect}/>
        )}
      </PvCard>

      <ReviewDialog target={review} onClose={() => setReview(null)}
        onDone={msg => { setReview(null); push({kind: 'ok', text: msg}); void refresh(); }}/>
      <PhotoDialog session={photoFor} nameOf={nameOf} onClose={() => setPhotoFor(null)}/>
      <CorrectionDialog orgId={orgId} session={correct} nameOf={nameOf} onClose={() => setCorrect(null)}
        onDone={msg => { push({kind: 'ok', text: msg}); void refresh(); }}/>
    </PvPage>
  );
}

/* ── Approve / reject ────────────────────────────────────────────────── */

function ReviewDialog({target, onClose, onDone}: {
  target: {s: ShiftSession; decision: 'approve' | 'reject'} | null;
  onClose: () => void; onDone: (msg: string) => void;
}) {
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = target?.s.id ?? null;
  useEffect(() => { setNotes(''); setErr(null); }, [id, target?.decision]);
  if (!target) return null;
  const approve = target.decision === 'approve';
  const who = target.s.display_name ?? 'this person';

  async function submit() {
    if (!target) return;
    setBusy(true); setErr(null);
    try {
      await pvAttendanceApi.review(target.s.id, target.decision, notes);
      onDone(approve ? `Check-in for ${who} approved.` : `Check-in for ${who} rejected.`);
    } catch (e) { setErr(deptErrorText(e)); } finally { setBusy(false); }
  }

  return (
    <PvDialog open title={approve ? 'Approve check-in' : 'Reject check-in'} busy={busy} onClose={onClose}
      description={approve
        ? <>Mark the check-in by <b>{who}</b> on {when(target.s.clock_in_at)} as confirmed?</>
        : <>Reject the check-in by <b>{who}</b> on {when(target.s.clock_in_at)}? It stays flagged on their record.</>}
      footer={<>
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button className={`btn ${approve ? 'btn-pri' : 'btn-danger'}`} disabled={busy} onClick={submit}>
          {busy ? 'Saving…' : approve ? 'Approve' : 'Reject'}
        </button>
      </>}>
      <label className="pv-field">
        <span className="pv-label">Note (optional)</span>
        <textarea className="pv-input" rows={3} maxLength={500} value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="Kept with the record"/>
      </label>
      {err && <div className="pv-err" role="alert">{err}</div>}
    </PvDialog>
  );
}

/* ── Face photo (fetched on open, never cached) ──────────────────────── */

function PhotoDialog({session, nameOf, onClose}: {session: ShiftSession | null; nameOf: (id: string) => string | null; onClose: () => void}) {
  const [photo, setPhoto] = useState<{data_url: string; captured_at: string} | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const id = session?.id ?? null;
  useEffect(() => {
    setPhoto(null); setErr(null);
    if (!id) return;
    let alive = true;
    pvAttendanceApi.photo(id)
      .then(p => { if (alive) setPhoto({data_url: p.data_url, captured_at: p.captured_at}); })
      .catch(e => { if (alive) setErr(deptErrorText(e)); });
    return () => { alive = false; };
  }, [id]);
  if (!session) return null;
  const name = session.display_name ?? nameOf(session.cpo_user_id) ?? 'Team member';
  return (
    <PvDialog open title="Check-in face photo" onClose={onClose}
      description={<>{name} · {when(session.clock_in_at)}. Each view is recorded. The photo is deleted once the review is closed and the shift has ended.</>}
      footer={<button className="btn btn-ghost" onClick={onClose}>Close</button>}>
      {err ? <div className="pv-err" role="alert">{err}</div>
        : !photo ? <Empty>Loading…</Empty>
        : (
          // eslint-disable-next-line @next/next/no-img-element -- a data URL from the API; next/image adds nothing here
          <img src={photo.data_url} alt={`Face photo taken at check-in by ${name}`}
            style={{display: 'block', maxWidth: '100%', maxHeight: 420, margin: '0 auto', borderRadius: 10}}/>
        )}
    </PvDialog>
  );
}

/* ── Corrections ─────────────────────────────────────────────────────── */

function CorrectionsList({orgId, pending, nameOf, onPick}: {
  orgId: string; pending: ShiftSession[] | undefined; nameOf: (id: string) => string | null; onPick: (s: ShiftSession) => void;
}) {
  const {data, error} = usePvAttSessions(orgId);
  const pendingIds = useMemo(() => new Set((pending ?? []).map(p => p.id)), [pending]);
  // Open sessions cannot be corrected (the server refuses), so they are not offered.
  const recent = useMemo(() => (data ?? []).filter(s => s.status !== 'open' && !pendingIds.has(s.id)).slice(0, 50), [data, pendingIds]);
  const flagged = (pending ?? []).filter(s => s.status !== 'open');

  const rows = (list: ShiftSession[]) => (
    <div className="pv-table-wrap">
      <table className="pv-table">
        <thead><tr><th>Person</th><th>Date</th><th>In – out</th><th>Status</th><th aria-label="Actions"/></tr></thead>
        <tbody>
          {list.map(s => {
            const st = attendanceLabel(s.attendance_status);
            return (
              <tr key={s.id}>
                <td><Person s={s} nameOf={nameOf}/></td>
                <td>{day(s.clock_in_at)}</td>
                <td className="pv-mono">{hm(s.clock_in_at)} – {hm(s.clock_out_at)}</td>
                <td>
                  <span className={pillClass(st.tone)}>{st.label}</span>
                  {s.review_reason === 'disputed' ? <div className="pv-cell-sub">Disputed by the member</div> : null}
                </td>
                <td className="pv-row-actions"><button className="btn btn-sm btn-ghost" onClick={() => onPick(s)}>Correct</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <p className="pv-note" style={{padding: '0 16px', marginTop: 14}}>
        A correction never overwrites the original. Each change is kept with its reason, who made it and when.
      </p>
      <h3 className="pv-hint" style={{padding: '14px 16px 6px', margin: 0}}>Needs review</h3>
      {flagged.length === 0 ? <Empty>Nothing waiting for review.</Empty> : rows(flagged)}
      <h3 className="pv-hint" style={{padding: '14px 16px 6px', margin: 0}}>Recent sessions</h3>
      {error ? <Empty>{deptErrorText(error)}</Empty>
        : !data ? <Empty>Loading…</Empty>
        : recent.length === 0 ? <Empty>No finished sessions yet.</Empty>
        : rows(recent)}
    </>
  );
}

const FIELD_LABEL: Record<string, string> = {attendance_status: 'Status', clock_in_at: 'Check-in', clock_out_at: 'Check-out'};
function fieldValue(k: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (k === 'attendance_status') return attendanceLabel(String(v)).label;
  if (k.endsWith('_at') && typeof v === 'string') return when(v);
  return String(v);
}

function CorrectionDialog({orgId, session, nameOf, onClose, onDone}: {
  orgId: string; session: ShiftSession | null; nameOf: (id: string) => string | null;
  onClose: () => void; onDone: (msg: string) => void;
}) {
  const [current, setCurrent] = useState<ShiftSession | null>(null);
  const [status, setStatus] = useState<AttendanceStatus | ''>('');
  const [inTime, setInTime] = useState('');
  const [outTime, setOutTime] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const {data: history, error: historyErr, mutate: reloadHistory} = usePvCorrections(orgId, session?.id ?? null);

  const id = session?.id ?? null;
  useEffect(() => {
    setCurrent(session); setStatus(''); setInTime(''); setOutTime(''); setReason(''); setErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when a different session opens
  }, [id]);

  if (!session || !current) return null;
  const name = session.display_name ?? nameOf(session.cpo_user_id) ?? 'Team member';
  const st = attendanceLabel(current.attendance_status);

  async function save() {
    if (!current) return;
    if ((inTime && !HHMM.test(inTime)) || (outTime && !HHMM.test(outTime))) { setErr('Times must be HH:MM, for example 08:30.'); return; }
    const after = correctionAfter(current, {status, inTime, outTime});
    if (Object.keys(after).length === 0) { setErr('Nothing changed. Pick a different status or time first.'); return; }
    if (!reason.trim()) { setErr('A reason is required. It is kept with the change.'); return; }
    setBusy(true); setErr(null);
    try {
      await pvAttendanceApi.recordCorrection({session_id: current.id, reason: reason.trim(), after});
      setCurrent(c => (c ? {...c, ...after} as ShiftSession : c));
      setStatus(''); setInTime(''); setOutTime(''); setReason('');
      await reloadHistory();
      onDone(`Correction saved for ${name}. The original stays in the history.`);
    } catch (e) { setErr(deptErrorText(e)); } finally { setBusy(false); }
  }

  return (
    <PvDialog open wide title={`Correct ${name}'s session`} busy={busy} onClose={onClose}
      description={<>Currently: <b>{st.label}</b>, {when(current.clock_in_at)} to {current.clock_out_at ? when(current.clock_out_at) : 'still open'}.</>}
      footer={<>
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Close</button>
        <button className="btn btn-pri" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save correction'}</button>
      </>}>
      <div className="pv-form">
        <label className="pv-field">
          <span className="pv-label">Status</span>
          <select className="pv-input" value={status} onChange={e => setStatus(e.target.value as AttendanceStatus | '')}>
            <option value="">Keep {st.label.toLowerCase()}</option>
            {CORRECTABLE_STATUSES.map(k => <option key={k} value={k}>{attendanceLabel(k).label}</option>)}
          </select>
        </label>
        <div className="pv-form-2">
          <label className="pv-field">
            <span className="pv-label">Check-in time (now {toHHMM(current.clock_in_at) || '—'})</span>
            <input className="pv-input" type="time" value={inTime} onChange={e => setInTime(e.target.value)}/>
          </label>
          <label className="pv-field">
            <span className="pv-label">Check-out time (now {toHHMM(current.clock_out_at) || '—'})</span>
            <input className="pv-input" type="time" value={outTime} onChange={e => setOutTime(e.target.value)}/>
          </label>
        </div>
        <p className="pv-note" style={{margin: 0}}>Times are on the day of the check-in. A check-out earlier than the check-in counts as the next day.</p>
        <label className="pv-field">
          <span className="pv-label">Reason</span>
          <textarea className="pv-input" rows={2} maxLength={500} value={reason} onChange={e => setReason(e.target.value)}
            placeholder="Why this record is being changed"/>
        </label>
        {err && <div className="pv-err" role="alert">{err}</div>}

        <div>
          <div className="pv-label" style={{marginBottom: 6}}>History</div>
          {historyErr ? <div className="pv-cell-sub">{deptErrorText(historyErr)}</div>
            : !history ? <div className="pv-cell-sub">Loading…</div>
            : history.corrections.length === 0 ? <div className="pv-cell-sub">No corrections yet.</div>
            : (
              <ul className="pv-list">
                {history.corrections.map(h => (
                  <li key={h.id} style={{padding: '8px 0'}}>
                    <div className="pv-cell-sub">{when(h.corrected_at)} · by {nameOf(h.corrected_by) ?? 'a manager'}</div>
                    {Object.keys(h.after_value).map(k => (
                      <div key={k} style={{fontSize: 13}}>
                        {FIELD_LABEL[k] ?? k}: {fieldValue(k, h.before_value[k])} → <b>{fieldValue(k, h.after_value[k])}</b>
                      </div>
                    ))}
                    <div style={{fontSize: 12.5, color: 'var(--tx-2)', fontStyle: 'italic'}}>&ldquo;{h.reason}&rdquo;</div>
                  </li>
                ))}
              </ul>
            )}
        </div>
      </div>
    </PvDialog>
  );
}
