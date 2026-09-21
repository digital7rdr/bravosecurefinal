'use client';

/**
 * Bravo Secure Pro — the application review QUEUE.
 *
 * B-819 (founder, 2026-09-07, screenshot): the page opened on nine status
 * buckets rendered as nine full-width stacked blocks that filled the entire
 * viewport, with the applications themselves below the fold. Root cause was
 * `button.filter-ch { width: 100% }` — the vertical filter RAIL's shape,
 * applied to a horizontal wrap row (fixed at the CSS, and horizontal buckets
 * now go through the shared `StatusTabs`).
 *
 * The redesign treats this as what it is — a work queue — and answers the
 * operator's questions in their order:
 *
 *   1. Is anything waiting on ME?      → the amber banner, only when it is
 *   2. Where is the rest of the work?  → every bucket carries a live count,
 *                                        including a muted zero ("none" and
 *                                        "not loaded" must not look alike)
 *   3. Let me scan them                → a real table: labelled, sortable,
 *                                        aligned columns instead of four
 *                                        free-floating blocks per card, with
 *                                        the WAITING age the queue turns on
 *   4. Open one                        → the whole row, mouse or keyboard
 *
 * Built from the house primitives (PageHeader / StatusTabs / DataTable /
 * StatusPill), so nothing here invents a second dialect: the raw enum, the
 * hand-rolled header and the hand-rolled row cards are all gone.
 *
 * Unchanged: the POLL_MSN "real-time feel", oldest-first server order on the
 * actionable buckets, the 50-per-page / 200-cap window (IS-08 / CA-10 / OP-17).
 */
import {useMemo, useState} from 'react';
import {PageHeader} from '@/components/PageHeader';
import {StatusTabs, type StatusTab} from '@/components/StatusTabs';
import {DataTable, type Column} from '@/components/DataTable';
import {StatusPill} from '@/components/StatusPill';
import {proAppsApi, useProApplications, POLL_MSN, type ProApplicationRow, type ProApplicationStatus} from '@/lib/api';
import {usePagedList} from '@/lib/usePagedList';
import {
  durationLabel, intendedUseLabel, isProActionable, isProStale,
  waitingDays, waitingLabel, PRO_ACTIONABLE_STATUSES,
} from '@/lib/proapps';
import {PRO_APPLICATION_STATUS} from '@/lib/status';
import {formatDateTimeShortUtc, formatDateUtc} from '@/lib/datetime';
import {routes} from '@/lib/routes';

/**
 * Buckets in the order an operator works them: what is waiting on ops, then
 * what is in flight, then what is closed. `startsGroup` draws the divider.
 * Labels come from the status registry (IA-17) so a tab can never disagree
 * with the pill on the row it filters to.
 */
const TAB_ORDER: Array<{key: string; startsGroup?: boolean}> = [
  {key: 'PENDING_PROPOSAL'},
  {key: 'REVISION_REQUESTED'},
  {key: 'PROPOSAL_CREATED', startsGroup: true},
  {key: 'ACCEPTED'},
  {key: 'ACTIVE'},
  {key: 'EXPIRED', startsGroup: true},
  {key: 'REJECTED'},
  {key: 'CANCELLED'},
  {key: 'all', startsGroup: true},
];

// OP-17 — page-index LOAD MORE (50 per page, 200 cap as before).
const PAGE = 50;
const MAX_LIMIT = 200;
const idOf = (r: ProApplicationRow) => r.id;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

export default function ProApplicationsPage() {
  const [tab, setTab] = useState('PENDING_PROPOSAL');
  const [query, setQuery] = useState('');
  const {rows: applications, error, isLoading, isLoadingMore, hasMore, loadMore} = usePagedList<ProApplicationRow>({
    key: ['pro-applications-paged', tab],
    pageSize: PAGE,
    maxRows: MAX_LIMIT,
    fetchPage: ({limit, offset}) => proAppsApi.list(tab, limit, offset).then(r => r.applications),
    idOf,
    swr: {refreshInterval: POLL_MSN},
  });
  // Counts source — the loaded 'all' window (no dedicated count endpoint yet),
  // so they are a floor once the cap is hit. The table footer says so.
  const {data: allData} = useProApplications('all', MAX_LIMIT);

  const {counts, capped} = useMemo(() => {
    const c: Record<string, number> = {};
    const all = allData?.applications ?? [];
    for (const row of all) {
      c[row.status] = (c[row.status] ?? 0) + 1;
      c.all = (c.all ?? 0) + 1;
    }
    return {counts: c, capped: all.length >= MAX_LIMIT};
  }, [allData]);

  const waiting = PRO_ACTIONABLE_STATUSES.reduce((n, s) => n + (counts[s] ?? 0), 0);
  const countsLoaded = Boolean(allData);

  const tabs: StatusTab[] = TAB_ORDER.map(t => {
    const meta = t.key === 'all' ? null : PRO_APPLICATION_STATUS[t.key as ProApplicationStatus];
    return {
      key: t.key,
      label: meta?.label ?? 'All',
      // Undefined (not 0) until the window lands — the muted zero means "none".
      count: countsLoaded ? counts[t.key] ?? 0 : undefined,
      attention: t.key !== 'all' && isProActionable(t.key as ProApplicationStatus),
      startsGroup: t.startsGroup,
      hint: meta?.hint,
    };
  });

  const q = query.trim().toLowerCase();
  const rows = applications.filter(row => !q ||
    row.id.toLowerCase().includes(q) ||
    (row.client_name ?? '').toLowerCase().includes(q) ||
    (row.client_email ?? '').toLowerCase().includes(q));

  /** Buckets that DO hold work — the empty state points at them instead of
   *  leaving the operator on a blank page (G5: no dead ends). */
  const elsewhere = TAB_ORDER
    .filter(t => t.key !== 'all' && t.key !== tab && (counts[t.key] ?? 0) > 0)
    .slice(0, 4);

  const columns: Array<Column<ProApplicationRow>> = [
    {
      key: 'client',
      header: 'Client',
      sortValue: r => (r.client_name ?? r.client_email ?? '').toLowerCase(),
      cell: r => (
        <div className="dt-client">
          <div className="dt-client-av" aria-hidden="true">{initials(r.client_name || r.client_email)}</div>
          <div style={{minWidth: 0}}>
            <div className="dt-client-name" style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
              {r.client_name || r.client_email}
            </div>
            <div className="dt-client-sub" style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
              {r.client_name ? r.client_email : 'no name on file'}
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'request',
      header: 'Request',
      sortValue: r => intendedUseLabel(r).toLowerCase(),
      hideBelow: 900,
      cell: r => (
        <div style={{minWidth: 0}}>
          <div className="dt-route" style={{color: 'var(--tx-1)'}}>
            {intendedUseLabel(r)} <span className="dt-route-arrow">·</span> {durationLabel(r)}
          </div>
          <div className="dt-client-sub" style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
            {r.coverage_area || '—'}
          </div>
        </div>
      ),
    },
    {
      key: 'team',
      header: 'Team',
      sortValue: r => r.cpo_count + r.driver_count + r.support_staff_count,
      hideBelow: 1100,
      cell: r => (
        <span className="dt-crew">
          {r.cpo_count} CPO · {r.driver_count} DRV · {r.support_staff_count} SUP
        </span>
      ),
    },
    {
      key: 'start',
      header: 'Starts',
      sortValue: r => r.start_date,
      hideBelow: 1100,
      cell: r => <span className="dt-when">{formatDateUtc(r.start_date)}</span>,
    },
    {
      key: 'value',
      header: 'Value',
      align: 'right',
      sortValue: r => (r.total_credits === null ? null : Number(r.total_credits)),
      cell: r => (r.total_credits ? (
        <span className="dt-val">
          {Number(r.total_credits).toLocaleString()} BC
          {r.proposal_version && r.proposal_version > 1
            ? <span className="dt-val-sub">proposal v{r.proposal_version}</span>
            : null}
        </span>
      ) : <span className="dt-val-sub" style={{marginTop: 0}}>no proposal yet</span>),
    },
    {
      key: 'waiting',
      header: 'Waiting',
      align: 'right',
      sortValue: r => r.submitted_at,
      cell: r => {
        const days = waitingDays(r.submitted_at);
        const stale = isProStale(r);
        return (
          <span
            className="dt-when"
            title={stale ? `Waiting on ops since ${formatDateTimeShortUtc(r.submitted_at)}` : undefined}>
            <span className={stale ? 'queue-age-stale' : undefined} style={stale ? {fontWeight: 700} : undefined}>
              {waitingLabel(days)}
            </span>
            <span className="dt-when-sub">{formatDateTimeShortUtc(r.submitted_at)}</span>
          </span>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      align: 'right',
      sortValue: r => r.status,
      cell: r => (
        <div style={{display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3}}>
          <StatusPill domain="proApplication" value={r.status} />
          {/* SK-01 — ACTIVE plans show the LAST COVERED DAY, never the
              exclusive period end. */}
          {r.status === 'ACTIVE' && (r.covered_until ?? r.current_period_end) ? (
            <span className="dt-client-sub" style={{color: 'var(--ok)'}}>
              covered to {formatDateUtc((r.covered_until ?? r.current_period_end)!)}
            </span>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Applications"
        subtitle="Every Secure Pro plan request. New and revision-requested applications are waiting on ops — open one to write or re-price its proposal."
        badges={waiting > 0
          ? <span className="pill pill-warn">{waiting} WAITING ON OPS</span>
          : countsLoaded ? <span className="pill pill-ok">QUEUE CLEAR</span> : null}
      />

      {waiting > 0 && (
        <div className="card queue-banner" role="status">
          <span className="queue-banner-num">{waiting}</span>
          <div style={{flex: 1, minWidth: 180}}>
            <div style={{fontSize: 13, fontWeight: 700, color: 'var(--tx-1)'}}>
              {waiting === 1 ? 'application is' : 'applications are'} waiting on ops
            </div>
            <div style={{fontSize: 11.5, color: 'var(--tx-3)', marginTop: 2}}>
              {(counts.PENDING_PROPOSAL ?? 0)} needing a first proposal ·{' '}
              {(counts.REVISION_REQUESTED ?? 0)} the client asked to change
            </div>
          </div>
          {PRO_ACTIONABLE_STATUSES.filter(s => (counts[s] ?? 0) > 0 && s !== tab).map(s => (
            <button key={s} type="button" className="btn btn-sm btn-ghost" onClick={() => setTab(s)}>
              {PRO_APPLICATION_STATUS[s].label.toUpperCase()} ({counts[s]}) →
            </button>
          ))}
        </div>
      )}

      <StatusTabs
        tabs={tabs}
        value={tab}
        onChange={key => { setTab(key); setQuery(''); }}
        ariaLabel="Filter applications by status"
      />

      <div className="card queue-toolbar">
        <span aria-hidden="true" style={{color: 'var(--tx-3)', fontSize: 13}}>⌕</span>
        <input
          aria-label="Filter the loaded applications by client name, email or application id"
          placeholder="Filter these applications — client name, email, application id…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          spellCheck={false}
        />
        {query ? (
          <>
            <span className="dt-client-sub" style={{marginTop: 0, whiteSpace: 'nowrap'}}>
              {rows.length} of {applications.length}
            </span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setQuery('')}>CLEAR</button>
          </>
        ) : null}
      </div>

      <DataTable
        ariaLabel="Secure Pro applications"
        rows={rows}
        columns={columns}
        rowKey={idOf}
        rowHref={r => routes.pro.application(r.id)}
        loading={isLoading}
        error={Boolean(error)}
        empty={
          <div style={{display: 'grid', gap: 10, justifyItems: 'center'}}>
            <span>
              {q
                ? `No loaded application matches “${query.trim()}”.`
                : 'Nothing in this bucket.'}
            </span>
            {/* Never a dead end: name the buckets that DO hold work. */}
            {!q && elsewhere.length > 0 ? (
              <div style={{display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center'}}>
                {elsewhere.map(t => (
                  <button key={t.key} type="button" className="btn btn-sm btn-ghost" onClick={() => setTab(t.key)}>
                    {PRO_APPLICATION_STATUS[t.key as ProApplicationStatus].label.toUpperCase()} ({counts[t.key]}) →
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        }
        footer={
          <div style={{display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap'}}>
            <span>
              {applications.length} loaded
              {capped ? ' · counts are a floor past the 200-row window' : ''}
              {' · sorting and filtering apply to the loaded rows'}
            </span>
            {!q && hasMore ? (
              <button type="button" className="btn btn-sm btn-ghost" style={{marginLeft: 'auto'}}
                disabled={isLoadingMore} onClick={loadMore}>
                {isLoadingMore ? 'LOADING…' : 'LOAD MORE'}
              </button>
            ) : null}
          </div>
        }
      />
    </>
  );
}
