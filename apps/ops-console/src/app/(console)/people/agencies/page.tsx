'use client';

/**
 * IA-08 — provider agencies, which had NO page.
 *
 * A `service_provider` organisation receives every Lite auto-dispatch offer and
 * employs the CPOs who run the missions, yet the console offered a filter value
 * on /users and a document-centric /compliance list. An operator could not
 * answer the two questions that decide whether an agency keeps getting work:
 * are their credentials valid, and do they actually show up?
 *
 * Both ride the list row, so the judgement is possible without a drill-down.
 */

import {useEffect, useState} from 'react';
import {useAgencies, type AgencyRow} from '@/lib/api';
import {PageHeader} from '@/components/PageHeader';
import {RouteTabs} from '@/components/RouteTabs';
import {DataTable, type Column} from '@/components/DataTable';
import {routes} from '@/lib/routes';

export default function AgenciesPage() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);

  const {data, isLoading, error} = useAgencies(debounced || undefined);
  const rows = data ?? [];

  const columns: Array<Column<AgencyRow>> = [
    {
      key: 'name',
      header: 'Agency',
      sortValue: a => a.display_name ?? '',
      cell: a => (
        <div>
          <div className="dt-client-name">
            {a.display_name}
            {a.suspended_at && <span className="pill pill-err" style={{marginLeft: 8}}>SUSPENDED</span>}
          </div>
          <div className="dt-client-sub">{a.email ?? a.phone_e164 ?? 'no contact on file'}</div>
        </div>
      ),
    },
    {
      key: 'region',
      header: 'Region',
      sortValue: a => a.home_region ?? '',
      cell: a => <span style={{fontSize: 12, color: 'var(--tx-3)'}}>{a.home_region ?? '—'}</span>,
    },
    {
      key: 'cpos',
      header: 'CPOs',
      align: 'right',
      sortValue: a => a.cpo_count,
      cell: a => <span className="dt-val">{a.cpo_count}</span>,
    },
    {
      key: 'compliance',
      header: 'Compliance',
      // Sort by the thing that needs action: problems first, then expiries.
      sortValue: a => -(a.docs_problem * 1000 + a.docs_expiring),
      cell: a => <ComplianceCell a={a} />,
    },
    {
      key: 'offers',
      header: 'Offers 30d',
      align: 'right',
      hideBelow: 1100,
      sortValue: a => a.offers_30d,
      cell: a => (
        <span className="dt-val">
          {a.accepted_30d}<span className="dt-val-sub">of {a.offers_30d} accepted</span>
        </span>
      ),
    },
    {
      key: 'noshow',
      header: 'No-shows 30d',
      align: 'right',
      sortValue: a => a.no_show_30d,
      cell: a => (
        <span className={a.no_show_30d > 0 ? 'pill pill-err' : 'dt-val'}>
          {a.no_show_30d}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Provider Agencies"
        subtitle="Organisations that receive Lite dispatch offers and employ the CPOs who run the missions. Their compliance validity and their acceptance record decide whether they keep getting work."
        badges={<span className="pill">{rows.length} LISTED</span>}
      />

      <RouteTabs
        ariaLabel="People sections"
        tabs={[
          {href: routes.people.clients, label: 'Clients'},
          {href: routes.people.agents, label: 'Agents (CPOs)', prefix: true},
          {href: routes.people.agencies, label: 'Provider Agencies', prefix: true},
          {href: routes.people.compliance, label: 'Compliance'},
          {href: routes.people.users, label: 'All Users', prefix: true},
        ]}
      />

      <div style={{marginBottom: 14}}>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search agency name or email…"
          aria-label="Search agencies"
          spellCheck={false}
          style={{
            width: 300, padding: '7px 12px', borderRadius: 8,
            background: 'var(--surf-2)', border: '1px solid var(--bd-2)',
            color: 'var(--tx-1)', fontSize: 12.5,
          }}
        />
      </div>

      <DataTable
        ariaLabel="Provider agencies"
        rows={rows}
        columns={columns}
        rowKey={a => a.id}
        rowHref={a => routes.people.agency(a.id)}
        loading={isLoading}
        error={Boolean(error)}
        initialSort={{key: 'compliance', dir: 'asc'}}
        empty="No provider agencies match this search."
        footer={<span>Sorted by what needs attention first: expired or unverified credentials, then those expiring soon.</span>}
      />
    </>
  );
}

function ComplianceCell({a}: {a: AgencyRow}) {
  if (a.docs_problem > 0) {
    return <span className="pill pill-err" title="Expired or unverified credentials">{a.docs_problem} PROBLEM</span>;
  }
  if (a.docs_expiring > 0) {
    return <span className="pill pill-warn" title="Valid today, expiring within 30 days">{a.docs_expiring} EXPIRING</span>;
  }
  if (a.docs_valid > 0) {
    return <span className="pill pill-ok">{a.docs_valid} VALID</span>;
  }
  return <span className="pill" title="Nothing on file — this agency has never submitted credentials">NONE ON FILE</span>;
}
