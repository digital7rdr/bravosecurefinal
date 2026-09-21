'use client';

/**
 * IA-07 — who currently holds a comp'd messenger tier, and who gave it to them.
 *
 * The console could GRANT a tier from a client's detail page but had no way to
 * answer "who has a comp right now?" — the question a monthly finance review
 * asks. A PERMANENT grant (a non-lite tier with no expiry, the RS-17 shape) is
 * the unbounded one, so it sorts first and is called out.
 *
 * Read-only by design: the grant and the revoke stay on the person's record,
 * where the operator can see who they are acting on.
 */

import Link from 'next/link';
import {useTierGrants, type TierGrantRow} from '@/lib/api';
import {PageHeader} from '@/components/PageHeader';
import {ConfigTabs} from '@/features/config/ConfigTabs';
import {DataTable, type Column} from '@/components/DataTable';
import {routes} from '@/lib/routes';
import {formatDateTimeUtc, formatDateUtc} from '@/lib/datetime';

export default function TierGrantsPage() {
  const {data, isLoading, error} = useTierGrants();
  const rows = data?.grants ?? [];
  const permanent = rows.filter(r => !r.pro_active_until).length;

  const columns: Array<Column<TierGrantRow>> = [
    {
      key: 'user',
      header: 'Account',
      sortValue: r => r.display_name ?? '',
      cell: r => (
        <div>
          <div className="dt-client-name">{r.display_name ?? '—'}</div>
          <div className="dt-client-sub">{r.email ?? '—'}</div>
        </div>
      ),
    },
    {
      key: 'tier',
      header: 'Messenger tier',
      sortValue: r => r.subscription_tier,
      cell: r => <span className="pill pill-act">{r.subscription_tier.toUpperCase()}</span>,
    },
    {
      key: 'expiry',
      header: 'Expires',
      sortValue: r => r.pro_active_until ?? '',
      cell: r => r.pro_active_until
        ? <span className="dt-when">{formatDateUtc(r.pro_active_until)}</span>
        : <span className="pill pill-warn" title="No expiry — this grant never lapses on its own">PERMANENT</span>,
    },
    {
      key: 'granted',
      header: 'Set by',
      hideBelow: 1100,
      sortValue: r => r.granted_at ?? '',
      cell: r => r.granted_at
        ? (
          <span className="dt-when">
            {r.granted_by ?? 'unknown'}
            <span className="dt-when-sub">{formatDateTimeUtc(r.granted_at)}</span>
          </span>
        )
        : <span style={{color: 'var(--tx-3)', fontSize: 11}}>paid subscription</span>,
    },
    {
      key: 'from',
      header: 'Was',
      hideBelow: 1100,
      cell: r => <span style={{fontSize: 12, color: 'var(--tx-3)'}}>{r.granted_from ?? '—'}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Tier Grants"
        subtitle="Every account on a non-Lite messenger tier. A paid subscriber shows no grantor; an ops comp shows who set it and when."
        badges={permanent > 0
          ? <span className="pill pill-warn">{permanent} PERMANENT</span>
          : undefined}
      />
      <ConfigTabs />

      <DataTable
        ariaLabel="Messenger tier grants"
        rows={rows}
        columns={columns}
        rowKey={r => r.id}
        rowHref={r => routes.people.client(r.id)}
        loading={isLoading}
        error={Boolean(error)}
        empty="No account holds a non-Lite messenger tier."
        footer={
          <span>
            Permanent grants first, then the soonest to expire. Grant or revoke on the person&apos;s
            record — <Link href={routes.people.clients}>People · Clients →</Link>
          </span>
        }
      />
    </>
  );
}
