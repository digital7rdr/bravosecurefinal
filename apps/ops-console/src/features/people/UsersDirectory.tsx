'use client';

/**
 * IA-02 / IA-11 — the People directory, scoped by who the person IS.
 *
 * One page called "Users" held clients, CPOs and provider agencies behind a
 * role chip, and its "Tier" column said Lite / Pro / Enterprise with no clue
 * that this is the MESSENGER subscription and nothing to do with Secure Pro
 * plans. Two fixes: the role scope is a route (Clients vs All Users, with CPOs
 * and agencies on their own pages), and the tier column is labelled for what it
 * is.
 */

import {useEffect, useState} from 'react';
import {ApiError, opsDataApi, POLL_DASH, useOpsMe, type OpsUserRow} from '@/lib/api';
import {canCreateUsers} from '@/lib/rbac';
import {AddUserModal} from './AddUserModal';
import {usePagedList} from '@/lib/usePagedList';
import {formatDateTimeUtc} from '@/lib/datetime';
import {roleLabel} from '@/lib/format';
import {PageHeader} from '@/components/PageHeader';
import {RouteTabs} from '@/components/RouteTabs';
import {DataTable, type Column} from '@/components/DataTable';
import {routes} from '@/lib/routes';

export type DirectoryScope = 'clients' | 'all';

const KYCS: Array<{label: string; value?: string}> = [
  {label: 'All KYC'},
  {label: 'None', value: 'none'},
  {label: 'Pending', value: 'pending'},
  {label: 'Verified', value: 'approved'},
];

/** IA-02 — always "Messenger tier". The bare word Pro is banned in labels. */
const TIERS: Array<{label: string; value?: string}> = [
  {label: 'Any tier'},
  {label: 'Messenger Lite', value: 'lite'},
  {label: 'Messenger Pro', value: 'pro'},
  {label: 'Messenger Enterprise', value: 'enterprise'},
];

const ROLES: Array<{label: string; value?: string}> = [
  {label: 'Everyone'},
  {label: 'Clients', value: 'individual'},
  {label: 'Agents (CPOs)', value: 'agent'},
  {label: 'Provider agencies', value: 'service_provider'},
];

const LIMIT_MAX = 500;
// OP-17 — page-index LOAD MORE (100 per page, 500 cap as before).
const PAGE = 100;
const idOf = (u: OpsUserRow) => u.id;

export function UsersDirectory({scope}: {scope: DirectoryScope}) {
  const isClients = scope === 'clients';
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [role, setRole] = useState<string | undefined>(isClients ? 'individual' : undefined);
  const [kyc, setKyc] = useState<string | undefined>(undefined);
  const [tier, setTier] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const {data: me} = useOpsMe();
  const canAdd = canCreateUsers(me?.admin.role);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);

  // The clients page pins the role server-side; it is not a chip an operator
  // can clear into "everyone", which is what made the old page ambiguous.
  const effectiveRole = isClients ? 'individual' : role;

  const {rows, isLoading, isLoadingMore, error, hasMore, loadMore, mutate} = usePagedList<OpsUserRow>({
    key: ['ops-users', scope, debouncedQ, effectiveRole ?? '', kyc ?? '', tier ?? ''],
    pageSize: PAGE,
    maxRows: LIMIT_MAX,
    fetchPage: ({limit, offset}) => opsDataApi.listUsers({q: debouncedQ || undefined, role: effectiveRole, kyc, tier, limit, offset}),
    idOf,
    swr: {refreshInterval: POLL_DASH},
  });

  const errText = error instanceof ApiError && error.status === 403
    ? 'Requires the SUPERVISOR or ADMIN role.'
    : (error as Error | undefined)?.message;

  const columns: Array<Column<OpsUserRow>> = [
    {
      key: 'name',
      header: 'Name',
      sortValue: u => u.display_name ?? '',
      cell: u => (
        <span className="dt-client-name">
          {u.display_name ?? '—'}
          {u.deleted_at && <span className="pill pill-err" style={{marginLeft: 8}}>DELETED</span>}
        </span>
      ),
    },
    ...(isClients ? [] : [{
      key: 'role',
      header: 'Type',
      sortValue: (u: OpsUserRow) => u.role,
      cell: (u: OpsUserRow) => <span style={{fontSize: 12}}>{roleLabel(u.role)}</span>,
    } as Column<OpsUserRow>]),
    {
      key: 'tier',
      header: 'Messenger tier',
      sortValue: u => u.subscription_tier,
      cell: u => (
        <span className={u.subscription_tier === 'lite' ? 'pill' : 'pill pill-act'}>
          {u.subscription_tier.toUpperCase()}
        </span>
      ),
    },
    {
      key: 'kyc',
      header: 'KYC',
      sortValue: u => u.kyc_status,
      hideBelow: 1100,
      cell: u => <span style={{fontSize: 12, color: 'var(--tx-3)', textTransform: 'capitalize'}}>{u.kyc_status}</span>,
    },
    {
      // B-867 — ID / passport on file. Individuals only carry a meaningful value;
      // an API that predates the field renders a dash, never a "no".
      key: 'identity',
      header: 'ID doc',
      sortValue: u => (u.identity_document_submitted == null ? -1 : u.identity_document_submitted ? 1 : 0),
      hideBelow: 1100,
      cell: u => u.identity_document_submitted == null || u.role !== 'individual'
        ? <span style={{fontSize: 12, color: 'var(--tx-3)'}}>—</span>
        : <span className={u.identity_document_submitted ? 'pill pill-ok' : 'pill pill-warn'}>{u.identity_document_submitted ? 'ON FILE' : 'MISSING'}</span>,
    },
    {
      key: 'region',
      header: 'Region',
      sortValue: u => u.home_region ?? u.country_code ?? '',
      hideBelow: 1100,
      cell: u => <span style={{fontSize: 12, color: 'var(--tx-3)'}}>{u.home_region ?? u.country_code ?? '—'}</span>,
    },
    {
      key: 'credits',
      header: 'Credits',
      align: 'right',
      sortValue: u => u.bravo_credits ?? -1,
      cell: u => (
        <span className="dt-val">
          {u.bravo_credits != null ? `${u.bravo_credits.toLocaleString()} BC` : '—'}
        </span>
      ),
    },
    {
      key: 'joined',
      header: 'Joined',
      sortValue: u => u.created_at,
      cell: u => <span className="dt-when">{formatDateTimeUtc(u.created_at)}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title={isClients ? 'Clients' : 'All Users'}
        subtitle={isClients
          ? 'People who book Lite and Executive protection or hold a Secure Pro plan. Contact details stay on the detail page behind audited click-to-reveal.'
          : 'Every account on the platform: clients, agents (CPOs) and provider agencies. Contact details stay behind audited click-to-reveal.'}
        badges={<span className="pill">{rows.length} SHOWN</span>}
        actions={canAdd ? (
          <button type="button" className="btn btn-sm btn-pri" onClick={() => setAdding(true)}>+ ADD USER</button>
        ) : undefined}
      />
      {adding && <AddUserModal onClose={() => setAdding(false)} onCreated={() => { void mutate(); }} />}

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

      <div style={{display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 16}}>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search name / phone / email…"
          aria-label="Search users"
          spellCheck={false}
          style={{
            width: 280, padding: '7px 12px', borderRadius: 8,
            background: 'var(--surf-2)', border: '1px solid var(--bd-2)',
            color: 'var(--tx-1)', fontSize: 12.5,
          }}
        />
        {!isClients && ROLES.map(r => (
          <Chip key={r.label} on={role === r.value} onClick={() => setRole(r.value)}>{r.label}</Chip>
        ))}
        {!isClients && <span style={{color: 'var(--tx-3)'}}>|</span>}
        {TIERS.map(t => (
          <Chip key={t.label} on={tier === t.value} onClick={() => setTier(t.value)}>{t.label}</Chip>
        ))}
        <span style={{color: 'var(--tx-3)'}}>|</span>
        {KYCS.map(k => (
          <Chip key={k.label} on={kyc === k.value} onClick={() => setKyc(k.value)}>{k.label}</Chip>
        ))}
      </div>

      <DataTable
        ariaLabel={isClients ? 'Client directory' : 'User directory'}
        rows={rows}
        columns={columns}
        rowKey={u => u.id}
        rowHref={u => (isClients ? routes.people.client(u.id) : routes.people.user(u.id))}
        loading={isLoading}
        error={Boolean(error)}
        empty={error ? errText : 'No accounts match this view.'}
        footer={
          hasMore
            ? (
              <button className="btn btn-sm btn-ghost" onClick={loadMore} disabled={isLoadingMore}>
                {isLoadingMore ? 'LOADING…' : `LOAD MORE (${rows.length} loaded)`}
              </button>
            )
            : <span>{rows.length} loaded{rows.length >= LIMIT_MAX ? ' · server cap reached' : ''}</span>
        }
      />
    </>
  );
}

function Chip({on, onClick, children}: {on: boolean; onClick: () => void; children: React.ReactNode}) {
  return (
    <button type="button" onClick={onClick} className={`btn btn-sm ${on ? 'btn-sec' : 'btn-ghost'}`}>
      {children}
    </button>
  );
}
