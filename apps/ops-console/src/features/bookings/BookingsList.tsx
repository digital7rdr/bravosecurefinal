'use client';

/**
 * IA-01 / IA-03 / IA-16 — the bookings list, scoped to ONE product.
 *
 * Lite (Secure Transfer + recon + extraction) and Executive Protection used to
 * share a single /bookings page whose only separator was a "service" chip built
 * from whatever rows happened to be loaded. Two consequences, both real: an
 * Executive booking outside the loaded window was invisible to the filter, and
 * an operator working Executive details read a table with no block hours, no
 * add-ons and no task type — the columns their job is about.
 *
 * Now: one component, two products. `services` is sent to the SERVER, and the
 * column set follows the product.
 */

import {useEffect, useMemo, useRef, useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {opsApi, POLL_DASH, type BookingRow, type BookingStatus} from '@/lib/api';
import {paidByLabel} from '@/lib/familyFunding';
import {usePagedList} from '@/lib/usePagedList';
import {useScrollRestoration} from '@/lib/useScrollRestoration';
import {formatDateTimeShortUtc, formatDateUtc, utcDayDelta} from '@/lib/datetime';
import {PageHeader} from '@/components/PageHeader';
import {StatusPill} from '@/components/StatusPill';
import {LITE_SERVICES, EXECUTIVE_SERVICE, routes, bookingHref} from '@/lib/routes';
import {BOOKING_STATUS} from '@/lib/status';
import {WHEN_BUCKETS, bucketCounts, bucketOf, type CountedBucket} from '@/lib/bookingBuckets';

export type BookingProduct = 'lite' | 'executive';

const STATUS_FILTERS: Array<{label: string; value?: BookingStatus}> = [
  {label: 'All'},
  ...(['PENDING_OPS', 'OPS_APPROVED', 'PAYMENT_PENDING', 'DISPATCHING', 'CONFIRMED',
    'LIVE', 'COMPLETED', 'NO_PROVIDER', 'AGENCY_NO_SHOW', 'CANCELLED'] as BookingStatus[])
    .map(v => ({label: BOOKING_STATUS[v].label, value: v})),
];

const REGIONS = ['AE', 'SA', 'BD', 'GB', 'US'];

// OP-17 — page-index LOAD MORE (50 per page, 500 cap as before).
const PAGE = 50;
const MAX_ROWS = 500;
const idOf = (b: BookingRow) => b.id;

/** Human labels for the Lite sub-services (the Executive list has only one). */
const LITE_SERVICE_LABELS: Record<string, string> = {
  secure_transfer: 'Secure Transfer',
  recon_team: 'Recon Team',
  emergency_extraction: 'Emergency Extraction',
};

const ADDON_LABELS: Record<string, string> = {
  female_cpo: 'Female CPO',
  recon: 'Recon',
  medical: 'Medical',
  comms: 'Comms',
};

export function BookingsList({product}: {product: BookingProduct}) {
  const router = useRouter();
  const isExec = product === 'executive';
  const [status, setStatus] = useState<BookingStatus | undefined>(undefined);
  const [region, setRegion] = useState<string | undefined>(undefined);
  const [bucket, setBucket] = useState<CountedBucket | undefined>(undefined);
  const [query, setQuery] = useState('');
  // Lite only — narrow to one of the three Lite services. Executive has a
  // single service, so the chip row is replaced by task-type chips.
  const [subService, setSubService] = useState<string | undefined>(undefined);
  const [taskType, setTaskType] = useState<string | undefined>(undefined);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // OP-13 — the search box used to filter only the loaded window, so a real
  // booking outside it read as "no results" (IS-12). The debounced query now
  // goes to the server as `q` (ILIKE over id / client / pickup / dropoff);
  // the client filter below only narrows the returned page further.
  const [debouncedQ, setDebouncedQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(query.trim()), 400);
    return () => clearTimeout(t);
  }, [query]);

  const service = isExec ? EXECUTIVE_SERVICE : LITE_SERVICES.join(',');
  const {rows: all, error, isLoading, isLoadingMore, hasMore, loadMore} = usePagedList<BookingRow>({
    key: ['bookings', service, status ?? 'all', region ?? 'all', debouncedQ],
    pageSize: PAGE,
    maxRows: MAX_ROWS,
    fetchPage: ({limit, offset}) => opsApi.listBookings({status, region, q: debouncedQ || undefined, limit, offset, service}),
    idOf,
    swr: {refreshInterval: POLL_DASH},
  });

  const tableRef = useRef<HTMLDivElement>(null);
  useScrollRestoration(tableRef, !isLoading && !error);

  const taskTypes = useMemo(
    () => Array.from(new Set(all.map(b => b.task_type).filter(Boolean) as string[])).sort(),
    [all],
  );

  const q = query.trim().toLowerCase();
  // Why: ONE clock for the counts AND the row filter. Two `new Date()` calls
  // either side of a UTC midnight disagree, and the rail then shows "Today 3"
  // over an empty table.
  const {counts, rows} = useMemo(() => {
    const now = new Date();
    return {
      counts: bucketCounts(all, now),
      rows: all
        .filter(b => !bucket || bucketOf(b.status, b.pickup_time, now) === bucket)
        .filter(b => !subService || b.service === subService)
        .filter(b => !taskType || b.task_type === taskType)
        .filter(b => !q ||
          b.id.toLowerCase().includes(q) ||
          (b.client_name ?? '').toLowerCase().includes(q) ||
          (b.region_label ?? '').toLowerCase().includes(q) ||
          (b.service ?? '').toLowerCase().includes(q) ||
          (b.pickup_address ?? '').toLowerCase().includes(q) ||
          (b.dropoff_address ?? '').toLowerCase().includes(q))
        .sort((a, b) => new Date(a.pickup_time).getTime() - new Date(b.pickup_time).getTime()),
    };
  }, [all, bucket, subService, taskType, q]);

  // B-840 — the WHEN rail. The three TIME chips can no longer hold a cancelled
  // booking (status wins in `bucketOf`), so the rail gains a fifth chip that is
  // a SHORTCUT to the server-side status filter — complete across the whole set
  // rather than a floor over the loaded window (B-842), hence no count.
  const cancelledOnly = status === 'CANCELLED' && !bucket;
  const whenChips: Array<{label: string; value?: CountedBucket; count: number; color?: string}> = [
    {label: 'All dates', count: all.length},
    ...WHEN_BUCKETS.map(b => ({label: b.label, value: b.value, count: counts[b.value], color: b.color})),
  ];

  const title = isExec ? 'Executive Bookings' : 'Lite Bookings';
  const subtitle = isExec
    ? 'Fixed-block on-site protection details. Priced per unit, with hourly check-ins instead of waypoints.'
    : 'On-demand Secure Transfer, recon and extraction. Escrowed per booking and dispatched to provider agencies.';

  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        badges={<span className="pill">{error ? 'API OFFLINE' : 'API LIVE'}</span>}
        actions={
          // IA-01 — the cross-product door. An operator who lands on the wrong
          // product must see where the other one lives, not conclude the
          // bookings are missing.
          <Link
            href={isExec ? routes.lite.bookings : routes.executive.bookings}
            className="btn btn-sm btn-ghost">
            {isExec ? 'LITE BOOKINGS →' : 'EXECUTIVE BOOKINGS →'}
          </Link>
        }
      />

      <div className="bk-layout">
        <div className={`card bk-filter-card ${filtersOpen ? 'open' : ''}`}>
          <div className="filter-rail">
            <div className="filter-h">When</div>
            {whenChips.map(f => (
              <button
                key={f.label}
                type="button"
                className={`filter-ch ${(f.value === bucket && !cancelledOnly) ? 'on' : ''}`}
                onClick={() => {setBucket(f.value); if (status === 'CANCELLED') setStatus(undefined);}}>
                <span style={{display: 'flex', alignItems: 'center', gap: 8}}>
                  {f.color && <span style={{width: 6, height: 6, borderRadius: '50%', background: f.color, display: 'inline-block'}} />}
                  {f.label}
                </span>
                <span className="filter-cnt">{f.count}</span>
              </button>
            ))}
            <button
              type="button"
              className={`filter-ch ${cancelledOnly ? 'on' : ''}`}
              onClick={() => {setStatus('CANCELLED'); setBucket(undefined);}}>
              <span style={{display: 'flex', alignItems: 'center', gap: 8}}>
                <span style={{width: 6, height: 6, borderRadius: '50%', background: 'var(--err)', display: 'inline-block'}} />
                Cancelled
              </span>
            </button>

            <div className="filter-h">Status</div>
            {STATUS_FILTERS.map(f => (
              <button
                key={f.label}
                type="button"
                className={`filter-ch ${(f.value === status || (!f.value && !status)) ? 'on' : ''}`}
                onClick={() => {setStatus(f.value); setBucket(undefined);}}>
                <span>{f.label}</span>
              </button>
            ))}

            <div className="filter-h">Region</div>
            <div className="region-grid">
              {REGIONS.map(r => (
                <button
                  key={r}
                  type="button"
                  className={`region-chip ${region === r ? 'on' : ''}`}
                  onClick={() => setRegion(region === r ? undefined : r)}>
                  {r}
                </button>
              ))}
            </div>

            {isExec ? (
              <>
                <div className="filter-h">Task</div>
                <button type="button" className={`filter-ch ${!taskType ? 'on' : ''}`} onClick={() => setTaskType(undefined)}>
                  <span>All tasks</span>
                </button>
                {taskTypes.map(t => (
                  <button
                    key={t}
                    type="button"
                    className={`filter-ch ${taskType === t ? 'on' : ''}`}
                    onClick={() => setTaskType(taskType === t ? undefined : t)}>
                    <span>{t.replace(/_/g, ' ')}</span>
                  </button>
                ))}
              </>
            ) : (
              <>
                <div className="filter-h">Service</div>
                <button type="button" className={`filter-ch ${!subService ? 'on' : ''}`} onClick={() => setSubService(undefined)}>
                  <span>All Lite services</span>
                </button>
                {LITE_SERVICES.map(sv => (
                  <button
                    key={sv}
                    type="button"
                    className={`filter-ch ${subService === sv ? 'on' : ''}`}
                    onClick={() => setSubService(subService === sv ? undefined : sv)}>
                    <span>{LITE_SERVICE_LABELS[sv] ?? sv}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>

        <div className="bk-main">
          <div className="bk-toolbar">
            <button className="btn btn-sm btn-ghost bk-filter-toggle" onClick={() => setFiltersOpen(o => !o)}>
              FILTERS {filtersOpen ? '▴' : '▾'}
            </button>
            <input
              className="bk-search"
              style={{background: 'transparent', border: 'none', outline: 'none', color: 'var(--tx-1)'}}
              placeholder="Search all bookings — booking #, client, pickup, dropoff…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              aria-label="Filter the loaded bookings"
              spellCheck={false}
            />
            <div className="bk-toolbar-stats">
              <span><b style={{color: 'var(--act)'}}>{counts.today}</b> today</span>
              <span><b style={{color: 'var(--info)'}}>{counts.upcoming}</b> upcoming</span>
              <span>Showing <b style={{color: 'var(--tx-1)'}}>{rows.length}</b></span>
            </div>
          </div>

          <div className="dt-wrap" ref={tableRef} style={{flex: 1, overflow: 'auto'}}>
            <table className="dt">
              <thead>
                <tr>
                  <th style={{width: 150}}>Booking #</th>
                  <th style={{width: 150}}>Status</th>
                  {!isExec && <th style={{width: 90}}>Lane</th>}
                  <th>Client</th>
                  {isExec ? <th style={{width: 150}}>Task</th> : <th>Route</th>}
                  <th style={{width: 130}}>{isExec ? 'Starts' : 'When'}</th>
                  {isExec && <th style={{width: 70}} className="num">Block</th>}
                  <th style={{width: 130}}>Crew</th>
                  {isExec && <th style={{width: 170}}>Add-ons</th>}
                  <th className="num" style={{width: 110}}>Value</th>
                  <th style={{width: 130}} />
                </tr>
              </thead>
              <tbody>
                {isLoading && rows.length === 0 && [0, 1, 2, 3, 4].map(i => (
                  <tr key={`sk-${i}`} className="dt-skel">
                    {Array.from({length: isExec ? 10 : 9}).map((_, c) => (
                      <td key={c}><span className="skel-cell" /></td>
                    ))}
                  </tr>
                ))}
                {error && (
                  <tr><td colSpan={11} className="dt-state dt-state-err">
                    Failed to load · {String((error as Error).message)}
                  </td></tr>
                )}
                {!isLoading && !error && rows.length === 0 && (
                  <tr><td colSpan={11} className="dt-state">
                    No {isExec ? 'executive details' : 'Lite bookings'} match the current filter.
                  </td></tr>
                )}
                {rows.map(b => (
                  <tr key={b.id} className="dt-clickable" onClick={() => router.push(bookingHref(b))}>
                    <td className="dt-idcell">{shortRef(b.id)}</td>
                    <td><StatusPill domain="booking" value={b.status} /></td>
                    {!isExec && <td><LaneChip lane={b.lane} /></td>}
                    <td>
                      <div className="dt-client">
                        <div className="dt-client-av">{(b.client_name ?? '—').slice(0, 2).toUpperCase()}</div>
                        <div>
                          <div className="dt-client-name">{b.client_name ?? '—'}</div>
                          <div className="dt-client-sub">{clientSub(b, isExec)}</div>
                        </div>
                      </div>
                    </td>
                    {isExec ? (
                      <td>
                        <span className="dt-route">{(b.task_type ?? 'site_protection').replace(/_/g, ' ')}</span>
                        {b.has_transfer_leg && <span className="pill pill-info" style={{marginLeft: 6}}>+ TRANSFER</span>}
                      </td>
                    ) : (
                      <td>
                        <span className="dt-route">
                          {(b.pickup_address ?? '').split(',')[0]}
                          <span className="dt-route-arrow">→</span>
                          {(b.dropoff_address ?? '—').split(',')[0]}
                        </span>
                      </td>
                    )}
                    <td>
                      <div style={{display: 'flex', flexDirection: 'column', gap: 3}}>
                        <RelChip iso={b.pickup_time} status={b.status} />
                        <span className="dt-when">{formatDateTimeShortUtc(b.pickup_time)}</span>
                      </div>
                    </td>
                    {isExec && <td className="num"><span className="dt-val">{b.duration_hours ?? '—'}h</span></td>}
                    <td><span className="dt-crew">CPO×{b.cpo_count} · VEH×{b.vehicle_count}</span></td>
                    {isExec && (
                      <td>
                        {(b.add_ons ?? []).length === 0
                          ? <span style={{color: 'var(--tx-3)', fontSize: 11}}>—</span>
                          : (b.add_ons ?? []).map(a => (
                              <span key={a} className="pill" style={{marginRight: 4}}>{ADDON_LABELS[a] ?? a}</span>
                            ))}
                      </td>
                    )}
                    <td className="num"><span className="dt-val">{Number(b.total_eur).toLocaleString()} BC</span></td>
                    <td onClick={e => e.stopPropagation()}>
                      <Link href={bookingHref(b)} className="btn btn-sm btn-ghost" style={{float: 'right'}}>
                        {b.status === 'PENDING_OPS' ? 'REVIEW →' : 'OPEN →'}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!isLoading && !error && hasMore && (
              <div style={{padding: '10px 0', textAlign: 'center'}}>
                <button className="btn btn-sm btn-ghost" onClick={loadMore} disabled={isLoadingMore}>
                  {isLoadingMore ? 'LOADING…' : `LOAD MORE (${all.length} loaded)`}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/** IA-05 — who is working this booking: the dispatch engine, or the job feed. */
function LaneChip({lane}: {lane: BookingRow['lane']}) {
  if (lane === 'auto') {
    return <span className="pill pill-info" title="Auto-dispatch is cascading offers to agencies">AUTO</span>;
  }
  if (lane === 'manual') {
    return <span className="pill" title="Published to the agent job feed; agencies apply">MANUAL</span>;
  }
  return <span style={{color: 'var(--tx-3)', fontSize: 11}}>—</span>;
}

function clientSub(b: BookingRow, isExec: boolean): string {
  // B-854 (A8) — one label for "who paid", so a CHAINED charge (the root's
  // wallet, a member's own member's booking) can never read as a plain one-hop
  // family charge. `ops.service.ts`'s list projection does not select the via
  // columns yet, so today this degrades to exactly the pre-B-854 sentence.
  const paidBy = paidByLabel(b);
  return [
    b.region_label ?? '',
    isExec ? '' : (LITE_SERVICE_LABELS[b.service] ?? b.service ?? ''),
    paidBy ? paidBy.replace(/^Paid by /, 'UNDER ').toUpperCase() : '',
  ].filter(Boolean).join(' · ');
}

function shortRef(id: string): string {
  return id.length > 14 ? id.slice(-12).toUpperCase() : id;
}

function RelChip({iso, status}: {iso: string; status: string}) {
  // B-840 — a cancelled booking has no countdown to run: its date is a record,
  // not a deadline. The word CANCELLED is NOT repeated here; the StatusPill two
  // columns left already carries it.
  const cancelled = status === 'CANCELLED';
  const {label, tone} = cancelled ? {label: formatDateUtc(iso), tone: 'past' as const} : relativeWhen(iso);
  const color = tone === 'today' ? 'var(--act)'
    : tone === 'soon' ? 'var(--warn)'
    : tone === 'future' ? 'var(--info)'
    : 'var(--tx-3)';
  return (
    <span style={{
      alignSelf: 'flex-start',
      fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4,
      padding: '1px 6px', borderRadius: 5, textTransform: 'uppercase',
      color, background: `color-mix(in srgb, ${color} 16%, transparent)`,
      border: `1px solid color-mix(in srgb, ${color} 16%, transparent)`,
    }}>{label}</span>
  );
}

function relativeWhen(iso: string): {label: string; tone: 'today' | 'soon' | 'future' | 'past'} {
  const delta = utcDayDelta(iso);
  if (delta === 0)  return {label: 'TODAY', tone: 'today'};
  if (delta === 1)  return {label: 'TOMORROW', tone: 'soon'};
  if (delta === -1) return {label: 'YESTERDAY', tone: 'past'};
  if (delta < 0)    return {label: `${-delta}d ago`, tone: 'past'};
  if (delta <= 7)   return {label: `in ${delta} days`, tone: 'soon'};
  if (delta <= 14)  return {label: 'NEXT WEEK', tone: 'future'};
  return {label: `in ${delta} days`, tone: 'future'};
}
