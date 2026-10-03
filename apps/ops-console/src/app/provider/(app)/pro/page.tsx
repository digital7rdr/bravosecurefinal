'use client';

import {useMemo, useState} from 'react';
import {NotGranted, useProvider} from '@/components/provider/ProviderShell';
import {Empty, PvCard, PvPage, Stat} from '@/components/provider/ui';
import {usePvPro, type ProAssignment} from '@/lib/provider/api';

const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', {day: '2-digit', month: 'short'});
const range = (a: ProAssignment) => (a.starts_on === a.ends_on ? day(a.starts_on) : `${day(a.starts_on)} – ${day(a.ends_on)}`);

const STATUS: Record<ProAssignment['status'], {label: string; cls: string}> = {
  ASSIGNED: {label: 'Assigned', cls: 'pill-info'},
  COMPLETED: {label: 'Completed', cls: 'pill-ok'},
  CANCELLED: {label: 'Cancelled', cls: ''},
};

export default function ProviderPro() {
  const {orgId, can} = useProvider();
  const pro = can('pro');
  const [tab, setTab] = useState<'current' | 'past'>('current');
  const {data: cur} = usePvPro(orgId, 'current', pro);
  const {data: past, error} = usePvPro(orgId, 'past', pro && tab === 'past');
  const list = useMemo(() => (tab === 'current' ? cur?.assignments : past?.assignments) ?? null, [tab, cur, past]);

  if (!pro) return <PvPage title="Secure Pro"><NotGranted what="Secure Pro"/></PvPage>;

  const a = cur?.assignments ?? [];
  const officers = new Set(a.map(x => x.officer_user_id)).size;
  const members = new Set(a.map(x => x.application_id)).size;

  return (
    <PvPage title="Secure Pro"
      subtitle="Secure Pro members your officers protect. Bravo Secure schedules Pro duty; this shows who is on it and when, so you can plan your roster. Each officer opens the mission in the app with their own code.">
      <div className="kpi-row" style={{gridTemplateColumns: 'repeat(4, minmax(0, 1fr))'}}>
        <Stat label="On Pro duty today" value={cur ? a.filter(x => x.on_today).length : '—'} tone="act"/>
        <Stat label="Upcoming assignments" value={cur ? a.length : '—'} tone="info"/>
        <Stat label="Officers assigned" value={cur ? officers : '—'}/>
        <Stat label="Members covered" value={cur ? members : '—'}/>
      </div>

      <PvCard pad={false}>
        <div className="pv-toolbar">
          <div className="pv-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'current'} className={`pv-tab ${tab === 'current' ? 'on' : ''}`} onClick={() => setTab('current')}>
              Current and upcoming<span className="pv-tab-n">{a.length}</span>
            </button>
            <button role="tab" aria-selected={tab === 'past'} className={`pv-tab ${tab === 'past' ? 'on' : ''}`} onClick={() => setTab('past')}>
              Past
            </button>
          </div>
        </div>
        {error && tab === 'past' ? <Empty>Could not load past assignments.</Empty>
          : !list ? <Empty>Loading…</Empty>
          : list.length === 0 ? <Empty>{tab === 'current' ? 'None of your officers is on Secure Pro duty right now.' : 'No past Secure Pro assignments.'}</Empty>
          : (
            <div className="pv-table-wrap">
              <table className="pv-table">
                <thead><tr><th>Officer</th><th>Member</th><th>Area</th><th>Dates</th><th>Status</th></tr></thead>
                <tbody>
                  {list.map(x => (
                    <tr key={x.id}>
                      <td><div>{x.officer_name ?? 'Officer'}</div>{x.officer_call_sign && <div className="pv-cell-sub pv-mono">{x.officer_call_sign}</div>}</td>
                      <td>{x.member_name ?? '—'}</td>
                      <td>{x.coverage_area ?? '—'}</td>
                      <td>
                        <div>{range(x)}</div>
                        {x.dates_in_range.length > 0 && x.dates_in_range.length < 8 && (
                          <div className="pv-cell-sub">Duty days: {x.dates_in_range.map(day).join(', ')}</div>
                        )}
                      </td>
                      <td>
                        <span className={`pill ${STATUS[x.status].cls}`}>{STATUS[x.status].label}</span>
                        {x.on_today && <span className="pill pill-act" style={{marginLeft: 6}}>Today</span>}
                        {x.status === 'ASSIGNED' && <div className="pv-cell-sub">{x.authorized ? 'Officer has opened the mission' : 'Officer has not opened it yet'}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </PvCard>
    </PvPage>
  );
}
