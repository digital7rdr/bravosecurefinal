'use client';

/**
 * Incidents (provider console, 2026-10-31) — the app's manager incident queue
 * (IncidentQueueScreen): every report filed by the agency's team, filtered on
 * the server by severity, status, category, period and department. A manager
 * scoped to one department only ever gets that department (server-forced).
 */

import Link from 'next/link';
import {useMemo, useState} from 'react';
import {NotGranted, useProvider} from '@/components/provider/ProviderShell';
import {Empty, PvCard, PvPage, Stat} from '@/components/provider/ui';
import {pillClass} from '@/lib/status';
import {usePvRoster} from '@/lib/provider/api';
import {
  INCIDENT_CATEGORIES, INCIDENT_CATEGORY_LABEL, INCIDENT_RANGES, INCIDENT_STATUSES, INCIDENT_STATUS_LABEL,
  SEVERITY_LABEL, deptErrorText, incidentFrom, usePvIncidents,
  type IncidentFilters, type IncidentRange, type IncidentSeverity,
} from '@/lib/provider/api-dept';
import {when} from '@/lib/provider/labels';
import {pvRoutes} from '@/lib/provider/routes';

const SEVERITIES: Array<['all' | IncidentSeverity, string]> = [['all', 'All'], ['critical', 'Critical'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']];

const selectStyle = {minHeight: 32, padding: '4px 10px'} as const;

export default function ProviderIncidents() {
  const {orgId, can} = useProvider();
  const allowed = can('dept');
  const [severity, setSeverity] = useState<'all' | IncidentSeverity>('all');
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [range, setRange] = useState<IncidentRange>('all');
  const [department, setDepartment] = useState('');

  // Memoised on the inputs, so the period start (and the SWR key) only moves
  // when a filter changes, not on every render.
  const filters = useMemo<IncidentFilters>(() => {
    const from = incidentFrom(range);
    return {
      ...(severity !== 'all' ? {severity} : {}),
      ...(status ? {status} : {}),
      ...(category ? {category} : {}),
      ...(from ? {from} : {}),
      ...(department ? {department} : {}),
    };
  }, [severity, status, category, range, department]);

  const {data, error} = usePvIncidents(orgId, filters, allowed);
  const {data: roster} = usePvRoster(orgId, allowed);
  const names = useMemo(() => new Map((roster ?? []).map(m => [m.member_user_id, m.display_name ?? m.email ?? null])), [roster]);
  const departments = useMemo(() =>
    [...new Set((roster ?? []).map(m => m.department).filter((d): d is string => !!d))].sort(), [roster]);

  if (!allowed) return <PvPage title="Incidents"><NotGranted what="Departmental"/></PvPage>;

  const rows = data ?? [];
  const open = rows.filter(r => r.status !== 'resolved' && r.status !== 'closed');
  const nameOf = (id: string | null) => (id ? (id === orgId ? 'Agency owner' : names.get(id) ?? 'Team member') : null);

  return (
    <PvPage title="Incidents"
      subtitle="Reports filed by your team in the app. Open one to move it along, assign an owner or add a note.">
      <div className="kpi-row" style={{gridTemplateColumns: 'repeat(3, minmax(0, 1fr))'}}>
        <Stat label="Open" value={data ? open.length : '—'} tone="act" sub="In this view"/>
        <Stat label="Critical or high, open" value={data ? open.filter(r => r.severity === 'critical' || r.severity === 'high').length : '—'} tone="err"/>
        <Stat label="Open without an owner" value={data ? open.filter(r => !r.assigned_to).length : '—'} tone="warn"/>
      </div>

      <PvCard pad={false}>
        <div className="pv-toolbar">
          <div className="pv-seg" role="group" aria-label="Severity">
            {SEVERITIES.map(([k, l]) => (
              <button key={k} className={severity === k ? 'on' : ''} aria-pressed={severity === k} onClick={() => setSeverity(k)}>{l}</button>
            ))}
          </div>
          <div className="pv-seg" role="group" aria-label="Period">
            {INCIDENT_RANGES.map(([k, l]) => (
              <button key={k} className={range === k ? 'on' : ''} aria-pressed={range === k} onClick={() => setRange(k)}>{l}</button>
            ))}
          </div>
        </div>
        <div className="pv-toolbar" style={{justifyContent: 'flex-start'}}>
          <select className="pv-input" aria-label="Status" value={status} onChange={e => setStatus(e.target.value)} style={selectStyle}>
            <option value="">All statuses</option>
            {INCIDENT_STATUSES.map(s => <option key={s} value={s}>{INCIDENT_STATUS_LABEL[s].label}</option>)}
          </select>
          <select className="pv-input" aria-label="Category" value={category} onChange={e => setCategory(e.target.value)} style={selectStyle}>
            <option value="">All categories</option>
            {INCIDENT_CATEGORIES.map(c => <option key={c} value={c}>{INCIDENT_CATEGORY_LABEL[c]}</option>)}
          </select>
          {departments.length > 0 && (
            <select className="pv-input" aria-label="Department" value={department} onChange={e => setDepartment(e.target.value)} style={selectStyle}>
              <option value="">All departments</option>
              {departments.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
        </div>

        {error ? <Empty>{deptErrorText(error)}</Empty>
          : !data ? <Empty>Loading…</Empty>
          : rows.length === 0 ? <Empty>No incidents match.</Empty>
          : (
            <div className="pv-table-wrap">
              <table className="pv-table">
                <thead><tr><th>Reference</th><th>Category</th><th>Severity</th><th>Status</th><th>Reported</th><th>Where</th><th>Owner</th></tr></thead>
                <tbody>
                  {rows.map(r => {
                    const sev = SEVERITY_LABEL[r.severity] ?? {label: r.severity, tone: 'muted' as const};
                    const st = INCIDENT_STATUS_LABEL[r.status] ?? {label: r.status, tone: 'muted' as const};
                    return (
                      <tr key={r.id}>
                        <td>
                          <Link href={pvRoutes.incident(r.id)} className="pv-mono pv-strong" style={{color: 'var(--glow)', textDecoration: 'none'}}>
                            {r.ref ?? 'Open'}
                          </Link>
                          <div className="pv-cell-sub pv-ellipsis" title={r.description}>{r.description}</div>
                        </td>
                        <td>{INCIDENT_CATEGORY_LABEL[r.category] ?? r.category}{r.department ? <div className="pv-cell-sub">{r.department}</div> : null}</td>
                        <td><span className={pillClass(sev.tone)}>{sev.label}</span></td>
                        <td><span className={pillClass(st.tone)}>{st.label}</span></td>
                        <td>{when(r.created_at)}<div className="pv-cell-sub">by {nameOf(r.submitter_id)}</div></td>
                        <td><div className="pv-ellipsis">{r.location_label ?? <span className="pv-cell-sub">Not given</span>}</div></td>
                        <td>{nameOf(r.assigned_to) ?? <span className="pv-cell-sub">Unassigned</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </PvCard>
    </PvPage>
  );
}
