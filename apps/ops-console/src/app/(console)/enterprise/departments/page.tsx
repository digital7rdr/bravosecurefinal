'use client';

/**
 * Departments — one row per ORGANISATION.
 *
 * This page used to be a flat, cross-tenant channel table: every workspace's
 * channels interleaved by creation date, with no way to tell whose was whose.
 * An operator's question is "which organisations run on this platform, and
 * which one needs me?" — so the list is organisations, with the counts that
 * answer that, and the channel tree lives on each organisation's own page.
 */

import {useMemo, useState} from 'react';
import Link from 'next/link';
import {useEnterpriseOrgs, type EnterpriseOrgRow} from '@/lib/api';
import {PageHeader} from '@/components/PageHeader';
import {DataTable, type Column} from '@/components/DataTable';
import {KpiRow, KpiTile} from '@/components/SectionLanding';
import {routes} from '@/lib/routes';
import {formatDateUtc, formatDateTimeShortUtc} from '@/lib/datetime';

const LIMIT = 200;

function tenantPill(o: EnterpriseOrgRow) {
  if (o.is_workspace && o.is_agency) return <span className="pill pill-info">WORKSPACE · AGENCY</span>;
  if (o.is_agency) return <span className="pill pill-info">AGENCY</span>;
  if (o.is_workspace) return <span className="pill pill-act">WORKSPACE</span>;
  return <span className="pill">CHANNEL OWNER</span>;
}

export default function DepartmentsPage() {
  const [q, setQ] = useState('');
  const {data, isLoading, error} = useEnterpriseOrgs(q.trim() || undefined);
  const rows = useMemo(() => data ?? [], [data]);

  const totals = useMemo(() => rows.reduce((t, o) => ({
    channels: t.channels + o.channels,
    members: t.members + o.members,
    incidents: t.incidents + o.incidents_open,
    join: t.join + o.join_pending,
  }), {channels: 0, members: 0, incidents: 0, join: 0}), [rows]);

  const columns: Array<Column<EnterpriseOrgRow>> = [
    {
      key: 'org', header: 'Organisation', width: '34%',
      sortValue: o => o.display_name.toLowerCase(),
      cell: o => (
        <div style={{minWidth: 0}}>
          <div style={{display: 'flex', alignItems: 'center', gap: 8, minWidth: 0}}>
            <span className="q-primary" style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
              {o.display_name}
            </span>
            {tenantPill(o)}
            {o.suspended_at && <span className="pill pill-err">SUSPENDED</span>}
          </div>
          <div className="q-secondary">
            {o.workspace_name && o.workspace_name !== o.display_name ? `${o.workspace_name} · ` : ''}
            {o.email ?? o.phone_e164 ?? o.id.slice(0, 8)}
            {o.home_region ? ` · ${o.home_region}` : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'channels', header: 'Channels', align: 'right',
      sortValue: o => o.channels,
      cell: o => (
        <div>
          <div className="dt-val">{o.channels}</div>
          <div className="dt-val-sub">{o.channels_provisioned} E2E active</div>
        </div>
      ),
    },
    {
      key: 'departments', header: 'Departments', align: 'right', hideBelow: 1100,
      sortValue: o => o.departments,
      cell: o => <span className="dt-val">{o.departments}</span>,
    },
    {
      key: 'members', header: 'People', align: 'right',
      sortValue: o => o.members,
      cell: o => <span className="dt-val">{o.members}</span>,
    },
    {
      key: 'incidents', header: 'Incidents open', align: 'right', hideBelow: 900,
      sortValue: o => o.incidents_open,
      cell: o => o.incidents_open > 0
        ? <span className="pill pill-err">{o.incidents_open}</span>
        : <span style={{color: 'var(--tx-3)'}}>0</span>,
    },
    {
      key: 'join', header: 'Join pending', align: 'right', hideBelow: 900,
      sortValue: o => o.join_pending,
      cell: o => o.join_pending > 0
        ? <span className="pill pill-warn">{o.join_pending}</span>
        : <span style={{color: 'var(--tx-3)'}}>0</span>,
    },
    {
      key: 'activity', header: 'Last activity', hideBelow: 1100,
      sortValue: o => o.last_activity_at ?? '',
      cell: o => (
        <span className="dt-when">{o.last_activity_at ? formatDateTimeShortUtc(o.last_activity_at) : '—'}</span>
      ),
    },
    {
      key: 'since', header: 'Since', hideBelow: 1100,
      sortValue: o => o.created_at,
      cell: o => <span className="dt-when">{formatDateUtc(o.created_at)}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Departments"
        subtitle="Every organisation running department channels on the platform. Open one for its channel tree, people, incidents, attendance and the organisation graph."
        badges={!isLoading && !error
          ? <span className="pill pill-info">● {rows.length} ORGANISATION{rows.length === 1 ? '' : 'S'}{rows.length >= LIMIT ? ' · FIRST ' + LIMIT : ''}</span>
          : undefined}
        actions={<Link href={routes.enterprise.joinRequests} className="btn btn-sec">JOIN REQUESTS →</Link>}
      />

      <KpiRow columns={4}>
        <KpiTile label="Channels" value={totals.channels} href={routes.enterprise.departments}
          sub="across the organisations listed" />
        <KpiTile label="People" value={totals.members} href={routes.enterprise.departments}
          sub="active org members" />
        <KpiTile label="Incidents open" value={totals.incidents} href={routes.enterprise.incidents}
          tone="err" urgent={totals.incidents > 0} />
        <KpiTile label="Join requests" value={totals.join} href={routes.enterprise.joinRequests}
          tone="warn" urgent={totals.join > 0} />
      </KpiRow>

      <div className="bk-toolbar">
        <label className="bk-search" style={{cursor: 'text'}}>
          <span aria-hidden="true">⌕</span>
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search organisation, workspace or email"
            aria-label="Search organisations"
            style={{flex: 1, background: 'none', border: 'none', color: 'var(--tx-1)', fontSize: 12.5, outline: 'none', minWidth: 0}}
          />
          {q && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setQ('')} aria-label="Clear search"
              style={{height: 24, padding: '0 8px'}}>
              ✕
            </button>
          )}
        </label>
        <div className="bk-toolbar-stats">
          {isLoading && rows.length === 0 ? 'LOADING…' : `${rows.length} SHOWN`}
        </div>
      </div>

      <DataTable
        ariaLabel="Organisations"
        rows={rows}
        columns={columns}
        rowKey={o => o.id}
        rowHref={o => routes.enterprise.org(o.id)}
        loading={isLoading}
        error={Boolean(error)}
        initialSort={{key: 'activity', dir: 'desc'}}
        empty={q.trim()
          ? `No organisation matches “${q.trim()}”.`
          : 'No organisations yet. An organisation appears here once an account is on the Enterprise tier, creates a workspace, or owns a department channel.'}
        footer={rows.length >= LIMIT
          ? <span>Showing the first {LIMIT} organisations by recent activity — narrow with the search box.</span>
          : undefined}
      />
    </>
  );
}
