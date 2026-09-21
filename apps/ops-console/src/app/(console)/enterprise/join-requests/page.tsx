'use client';

/**
 * SK-06(b) / OC-15 — the enterprise join queue, finally visible.
 *
 * `enterprise_join_requests` has been live data with ZERO ops surface since the
 * table shipped: support could not answer "did my request go through?" without
 * SQL. This is the read side.
 *
 * It is deliberately READ-ONLY. Approving a request grants workspace membership
 * and seeds E2EE scope acting as that workspace's own manager
 * (EnterpriseJoinService.decideJoinRequest takes the org manager's identity, not
 * an ops admin's). Whether ops may act inside a customer's workspace is a
 * product decision, not one to make in a layout change — audit §11 Q5. The page
 * says where the decision is actually made rather than implying ops is stuck.
 */

import {useState} from 'react';
import {useJoinRequests} from '@/lib/api';
import {PageHeader} from '@/components/PageHeader';
import {RouteTabs} from '@/components/RouteTabs';
import {DataTable, type Column} from '@/components/DataTable';
import {routes} from '@/lib/routes';
import {formatDateTimeUtc} from '@/lib/datetime';
import type {JoinRequestRow} from '@/lib/api';

const STATUSES = ['pending', 'approved', 'declined'] as const;

export default function JoinRequestsPage() {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('pending');
  const {data, isLoading, error} = useJoinRequests(status);
  const rows = data ?? [];

  const columns: Array<Column<JoinRequestRow>> = [
    {
      key: 'applicant',
      header: 'Applicant',
      sortValue: r => r.applicant_name ?? '',
      cell: r => (
        <div>
          <div className="dt-client-name">{r.applicant_name ?? '—'}</div>
          <div className="dt-client-sub">{r.applicant_email ?? r.applicant_phone ?? 'no contact on file'}</div>
        </div>
      ),
    },
    {
      key: 'workspace',
      header: 'Workspace',
      sortValue: r => r.workspace_name ?? '',
      cell: r => <span style={{fontSize: 12.5}}>{r.workspace_name ?? '—'}</span>,
    },
    {
      key: 'team',
      header: 'Team requested',
      hideBelow: 1100,
      cell: r => <span className="dt-route">{r.team_name ?? 'No team named'}</span>,
    },
    {
      key: 'referrer',
      header: 'Referred by',
      hideBelow: 1100,
      cell: r => <span className="dt-route">{r.referrer_name ?? '—'}</span>,
    },
    {
      key: 'created',
      header: 'Submitted',
      sortValue: r => r.created_at,
      cell: r => <span className="dt-when">{formatDateTimeUtc(r.created_at)}</span>,
    },
    {
      key: 'decided',
      header: 'Decision',
      cell: r => r.decided_at
        ? (
          <span className="dt-when">
            {formatDateTimeUtc(r.decided_at)}
            <span className="dt-when-sub">{r.decided_by_name ?? 'workspace manager'}</span>
          </span>
        )
        : <span style={{color: 'var(--tx-3)', fontSize: 11}}>—</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Enterprise Join Requests"
        subtitle="People asking to join a Messenger Enterprise workspace. Read-only in the console: the decision grants workspace membership and seeds encryption scope, so it is made by that workspace's own manager in their app."
        badges={<span className="pill">{rows.length} {status.toUpperCase()}</span>}
      />

      <RouteTabs
        ariaLabel="Enterprise sections"
        tabs={[
          {href: routes.enterprise.root, label: 'Overview'},
          {href: routes.enterprise.departments, label: 'Departments'},
          {href: routes.enterprise.attendance, label: 'Attendance'},
          {href: routes.enterprise.incidents, label: 'Incidents'},
          {href: routes.enterprise.joinRequests, label: 'Join Requests', count: status === 'pending' ? rows.length : 0},
        ]}
      />

      <div style={{display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap'}}>
        {STATUSES.map(st => (
          <button
            key={st}
            type="button"
            className={`btn btn-sm ${status === st ? 'btn-sec' : 'btn-ghost'}`}
            onClick={() => setStatus(st)}>
            {st.toUpperCase()}
          </button>
        ))}
      </div>

      <DataTable
        ariaLabel="Enterprise join requests"
        rows={rows}
        columns={columns}
        rowKey={r => r.id}
        loading={isLoading}
        error={Boolean(error)}
        initialSort={{key: 'created', dir: 'asc'}}
        empty={status === 'pending'
          ? 'No workspace has anyone waiting to join.'
          : `No ${status} requests.`}
        footer={<span>Oldest first — the order a workspace manager sees them in.</span>}
      />
    </>
  );
}
