'use client';

import {useMemo, useState} from 'react';
import {NotGranted, useProvider} from '@/components/provider/ProviderShell';
import {Empty, ProductTag, PvCard, PvPage, Stat} from '@/components/provider/ui';
import {usePvEarnings} from '@/lib/provider/api';
import {credits, productOf, when, type Product} from '@/lib/provider/labels';

const HOLD: Record<string, {label: string; cls: string}> = {
  RELEASED:        {label: 'Paid out', cls: 'pill-ok'},
  PARTIAL:         {label: 'Part paid', cls: 'pill-ok'},
  PENDING_RELEASE: {label: 'Waiting for release', cls: 'pill-warn'},
  DISPUTED:        {label: 'Disputed', cls: 'pill-err'},
};

export default function ProviderEarnings() {
  const {orgId, can} = useProvider();
  const earn = can('earn');
  const {data, error} = usePvEarnings(orgId, earn);
  const [filter, setFilter] = useState<'all' | Product>('all');

  const rows = useMemo(() => (data?.rows ?? []).filter(r => filter === 'all' || productOf(r.service) === filter), [data, filter]);

  if (!earn) return <PvPage title="Earnings"><NotGranted what="Earnings"/></PvPage>;

  return (
    <PvPage title="Earnings" subtitle="What your agency earned per job, after the Bravo Secure platform fee. Amounts are in Bravo credits (BC).">
      <div className="kpi-row" style={{gridTemplateColumns: 'repeat(4, minmax(0, 1fr))'}}>
        <Stat label="Net to your agency" value={data ? credits(data.total_net_credits) : '—'} tone="ok"/>
        <Stat label="Waiting for release" value={data ? credits(data.pending_credits) : '—'} tone="warn"/>
        <Stat label="Job value" value={data ? credits(data.total_gross_credits) : '—'} sub={data ? `platform fee ${credits(data.total_fee_credits)}` : undefined}/>
        <Stat label="Paid jobs" value={data ? data.total_missions : '—'}/>
      </div>

      <PvCard pad={false}>
        <div className="pv-toolbar">
          <div className="pv-seg">
            {([['all', 'All'], ['lite', 'Lite'], ['executive', 'Executive']] as const).map(([k, l]) => (
              <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>
            ))}
          </div>
          <span className="pv-hint">{rows.length} job{rows.length === 1 ? '' : 's'}</span>
        </div>
        {error ? <Empty>Could not load earnings. It will retry automatically.</Empty>
          : !data ? <Empty>Loading…</Empty>
          : rows.length === 0 ? <Empty>No paid jobs yet.</Empty>
          : (
            <div className="pv-table-wrap">
              <table className="pv-table">
                <thead><tr><th>Job</th><th>Area</th><th>Finished</th><th>Payment</th><th className="pv-num">Job value</th><th className="pv-num">Fee</th><th className="pv-num">To you</th></tr></thead>
                <tbody>
                  {rows.map(r => {
                    const h = HOLD[r.hold_status] ?? {label: r.hold_status.toLowerCase(), cls: ''};
                    return (
                      <tr key={r.booking_id}>
                        <td><div className="pv-mono">{r.short_code ?? r.booking_id.slice(0, 8).toUpperCase()}</div><ProductTag service={r.service}/></td>
                        <td>{r.region_label}</td>
                        <td>{when(r.ended_at)}</td>
                        <td><span className={`pill ${h.cls}`}>{h.label}</span></td>
                        <td className="pv-num">{credits(r.gross_credits)}</td>
                        <td className="pv-num">{credits(r.platform_fee_credits)}</td>
                        <td className="pv-num pv-strong">{credits(r.to_provider_credits)}</td>
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
