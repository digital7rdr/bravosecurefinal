'use client';

/**
 * Earnings + payout statement (provider console, Phase 2 2026-10-03).
 *
 * One period at a time (default: this month), with a 12-month strip to jump
 * between months, a product filter, and a CSV download of exactly what is on
 * screen. Amounts are the escrow split columns: the money that actually moved.
 */

import {useMemo, useState} from 'react';
import {NotGranted, useProvider} from '@/components/provider/ProviderShell';
import {Empty, ProductTag, PvCard, PvPage, Stat} from '@/components/provider/ui';
import {usePvStatement} from '@/lib/provider/api';
import {credits, productOf, serviceLabel, type Product} from '@/lib/provider/labels';
import {downloadCsv} from '@/lib/csv';

const HOLD: Record<string, {label: string; cls: string}> = {
  RELEASED:        {label: 'Paid out', cls: 'pill-ok'},
  PARTIAL:         {label: 'Part paid', cls: 'pill-ok'},
  PENDING_RELEASE: {label: 'Waiting for release', cls: 'pill-warn'},
  DISPUTED:        {label: 'Disputed', cls: 'pill-err'},
};

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthRange = (ym: string): [string, string] => {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const today = iso(new Date());
  const end = `${ym}-${String(last).padStart(2, '0')}`;
  return [`${ym}-01`, end > today ? today : end];
};
const monthName = (ym: string) => new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-GB', {month: 'short', year: 'numeric'});
const dayName = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric'});

export default function ProviderEarnings() {
  const {orgId, can, org} = useProvider();
  const earn = can('earn');
  const thisMonth = iso(new Date()).slice(0, 7);
  const [[from, to], setPeriod] = useState<[string, string]>(() => monthRange(thisMonth));
  const [custom, setCustom] = useState(false);
  const [filter, setFilter] = useState<'all' | Product>('all');
  const {data, error} = usePvStatement(orgId, from, to, earn);

  const rows = useMemo(() => (data?.rows ?? []).filter(r => filter === 'all' || productOf(r.service) === filter), [data, filter]);
  const totals = useMemo(() => {
    const t = {jobs: 0, gross: 0, fee: 0, net: 0, pending: 0};
    for (const r of rows) {
      t.jobs++;
      if (r.hold_status === 'RELEASED' || r.hold_status === 'PARTIAL') {
        t.gross += r.gross_credits; t.fee += r.platform_fee_credits ?? 0; t.net += r.to_provider_credits ?? 0;
      } else t.pending += r.gross_credits;
    }
    return t;
  }, [rows]);

  // Twelve month tiles, newest first, zero-filled where nothing happened.
  const months = useMemo(() => {
    const byMonth = new Map((data?.months ?? []).map(m => [m.month, m]));
    const out: Array<{month: string; net: number; jobs: number}> = [];
    const d = new Date(); d.setDate(1);
    for (let i = 0; i < 12; i++) {
      const ym = iso(d).slice(0, 7);
      const m = byMonth.get(ym);
      out.push({month: ym, net: m?.net_credits ?? 0, jobs: m?.jobs ?? 0});
      d.setMonth(d.getMonth() - 1);
    }
    return out;
  }, [data]);

  if (!earn) return <PvPage title="Earnings"><NotGranted what="Earnings"/></PvPage>;

  const selectedMonth = !custom && from.slice(0, 7) === to.slice(0, 7) && from.endsWith('-01') ? from.slice(0, 7) : null;
  const periodLabel = selectedMonth ? monthName(selectedMonth) : `${dayName(from)} – ${dayName(to)}`;

  function exportCsv() {
    const name = (org.name || 'agency').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
    downloadCsv(`bravo-statement-${name}-${from}-to-${to}${filter === 'all' ? '' : `-${filter}`}.csv`,
      ['Date', 'Job', 'Product', 'Service', 'Area', 'Payment', 'Paid on', 'Job value (BC)', 'Platform fee (BC)', 'To agency (BC)'],
      rows.map(r => [
        r.job_date, r.short_code ?? r.booking_id, productOf(r.service) === 'executive' ? 'Executive' : 'Lite',
        serviceLabel(r), r.region_label, HOLD[r.hold_status]?.label ?? r.hold_status,
        r.settled_at ? r.settled_at.slice(0, 10) : '', r.gross_credits, r.platform_fee_credits ?? '', r.to_provider_credits ?? '',
      ] as unknown[]).concat([['', 'TOTAL PAID OUT', '', '', '', '', '', totals.gross, totals.fee, totals.net]]));
  }

  return (
    <PvPage title="Earnings"
      subtitle="Your payout statement: each job's value, the Bravo Secure platform fee and what goes to your agency, in Bravo credits (BC)."
      right={<button className="btn btn-sec" disabled={!data || rows.length === 0} onClick={exportCsv}>Download CSV</button>}>
      <PvCard title="Last 12 months" right={<span className="pv-hint">Paid to your agency, by month</span>} pad={false}>
        <div className="pv-months">
          {months.map(m => (
            <button key={m.month} className={`pv-month ${selectedMonth === m.month ? 'on' : ''}`}
              onClick={() => { setCustom(false); setPeriod(monthRange(m.month)); }}>
              <div className="pv-month-name">{monthName(m.month)}</div>
              <div className="pv-month-net">{credits(m.net)}</div>
              <div className="pv-cell-sub">{m.jobs} job{m.jobs === 1 ? '' : 's'}</div>
            </button>
          ))}
        </div>
      </PvCard>

      <div className="kpi-row" style={{gridTemplateColumns: 'repeat(4, minmax(0, 1fr))'}}>
        <Stat label={`To your agency · ${periodLabel}`} value={data ? credits(totals.net) : '—'} tone="ok"/>
        <Stat label="Waiting for release" value={data ? credits(totals.pending) : '—'} tone="warn"/>
        <Stat label="Job value" value={data ? credits(totals.gross) : '—'} sub={data ? `platform fee ${credits(totals.fee)}` : undefined}/>
        <Stat label="Jobs" value={data ? totals.jobs : '—'}/>
      </div>

      <PvCard pad={false}>
        <div className="pv-toolbar">
          <div className="pv-period">
            <span className="pv-hint">Period</span>
            {custom ? (
              <>
                <input type="date" aria-label="From" value={from} max={to} onChange={e => e.target.value && setPeriod([e.target.value, to])}/>
                <span className="pv-hint">to</span>
                <input type="date" aria-label="To" value={to} min={from} max={iso(new Date())} onChange={e => e.target.value && setPeriod([from, e.target.value])}/>
              </>
            ) : <span className="pv-strong">{periodLabel}</span>}
            <button className="btn btn-sm btn-ghost" onClick={() => { if (custom) { setCustom(false); setPeriod(monthRange(thisMonth)); } else setCustom(true); }}>
              {custom ? 'Back to months' : 'Custom dates'}
            </button>
          </div>
          <div className="pv-seg">
            {([['all', 'All'], ['lite', 'Lite'], ['executive', 'Executive']] as const).map(([k, l]) => (
              <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>
            ))}
          </div>
        </div>
        {error ? <Empty>{(error as {body?: {message?: string}})?.body?.message === 'range_max_366_days' ? 'Choose a period of one year or less.' : 'Could not load the statement. It will retry automatically.'}</Empty>
          : !data ? <Empty>Loading…</Empty>
          : rows.length === 0 ? <Empty>No paid or settling jobs in this period.</Empty>
          : (
            <div className="pv-table-wrap">
              <table className="pv-table">
                <thead><tr><th>Date</th><th>Job</th><th>Area</th><th>Payment</th><th className="pv-num">Job value</th><th className="pv-num">Fee</th><th className="pv-num">To you</th></tr></thead>
                <tbody>
                  {rows.map(r => {
                    const h = HOLD[r.hold_status] ?? {label: r.hold_status.toLowerCase(), cls: ''};
                    return (
                      <tr key={r.booking_id}>
                        <td>{dayName(r.job_date)}</td>
                        <td><div className="pv-mono">{r.short_code ?? r.booking_id.slice(0, 8).toUpperCase()}</div><ProductTag service={r.service}/></td>
                        <td>{r.region_label}</td>
                        <td><span className={`pill ${h.cls}`}>{h.label}</span>{r.settled_at && <div className="pv-cell-sub">{dayName(r.settled_at.slice(0, 10))}</div>}</td>
                        <td className="pv-num">{credits(r.gross_credits)}</td>
                        <td className="pv-num">{credits(r.platform_fee_credits)}</td>
                        <td className="pv-num pv-strong">{credits(r.to_provider_credits)}</td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td colSpan={4} className="pv-strong">Total paid out</td>
                    <td className="pv-num pv-strong">{credits(totals.gross)}</td>
                    <td className="pv-num pv-strong">{credits(totals.fee)}</td>
                    <td className="pv-num pv-strong">{credits(totals.net)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
      </PvCard>
    </PvPage>
  );
}
