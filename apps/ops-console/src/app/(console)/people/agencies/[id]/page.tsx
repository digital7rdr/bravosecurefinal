'use client';

/**
 * IA-08 — one provider agency: who they are, whether they are allowed to work,
 * who works for them, and what they have actually done with the offers sent to
 * them. Read-only; suspension lives on the account record under All Users,
 * which is where every other account action already is.
 */

import {use} from 'react';
import Link from 'next/link';
import {useAgency} from '@/lib/api';
import {PageHeader} from '@/components/PageHeader';
import {StatusPill} from '@/components/StatusPill';
import {routes, bookingHref} from '@/lib/routes';
import {formatDateTimeUtc, formatDateUtc} from '@/lib/datetime';

export default function AgencyDetailPage({params}: {params: Promise<{id: string}>}) {
  const {id} = use(params);
  const {data, isLoading, error} = useAgency(id);

  if (error) {
    return (
      <>
        <PageHeader title="Provider Agency" back={{href: routes.people.agencies, label: 'Provider agencies'}} />
        <div className="card" style={{padding: 24, color: 'var(--err)'}}>
          Could not load this agency. It may not exist, or it may be outside your region scope.
        </div>
      </>
    );
  }

  const a = data?.agency;
  const now = Date.now();

  return (
    <>
      <PageHeader
        crumbs={['People', 'Provider Agencies', a?.display_name ?? '…']}
        back={{href: routes.people.agencies, label: 'Provider agencies'}}
        title={a?.display_name ?? (isLoading ? 'Loading…' : 'Agency')}
        badges={a?.suspended_at
          ? <span className="pill pill-err">SUSPENDED</span>
          : <span className="pill pill-ok">ACTIVE</span>}
        actions={a && (
          <Link href={routes.people.user(a.id)} className="btn btn-sm btn-ghost">ACCOUNT RECORD →</Link>
        )}
      />

      <div className="agency-grid">
        <div>
          <Card title="Profile">
            <Row k="Email" v={a?.email ?? '—'} />
            <Row k="Phone" v={a?.phone_e164 ?? '—'} />
            <Row k="Home region" v={a?.home_region ?? a?.country_code ?? '—'} />
            <Row k="On platform since" v={a ? formatDateUtc(a.created_at) : '—'} />
            {a?.suspended_at && <Row k="Suspended" v={`${formatDateTimeUtc(a.suspended_at)} · ${a.suspended_reason ?? 'no reason recorded'}`} />}
          </Card>

          <Card title="Compliance credentials">
            {(data?.credentials ?? []).length === 0 && (
              <div className="q-empty">
                Nothing on file. An agency with no verified credentials is not dispatch-eligible.
              </div>
            )}
            {(data?.credentials ?? []).map(c => {
              const expired = new Date(c.expires_at).getTime() <= now;
              return (
                <div key={c.id} className="q-row" style={{cursor: 'default'}}>
                  <div style={{minWidth: 0}}>
                    <div className="q-primary">{c.kind.replace(/_/g, ' ')} · {c.region_code}</div>
                    <div className="q-secondary">
                      {c.reference ? 'ref on file' : 'no reference'} · expires {formatDateUtc(c.expires_at)}
                    </div>
                  </div>
                  <div className="q-right">
                    {expired
                      ? <span className="pill pill-err">EXPIRED</span>
                      : c.verified
                        ? <span className="pill pill-ok">VERIFIED</span>
                        : <span className="pill pill-warn">UNVERIFIED</span>}
                  </div>
                </div>
              );
            })}
            <div className="q-footer">
              <Link href={routes.people.compliance}>Review pending documents →</Link>
            </div>
          </Card>

          <Card title="Armed authorisations">
            {(data?.armed ?? []).length === 0 && <div className="q-empty">No armed permits for this agency&apos;s officers.</div>}
            {(data?.armed ?? []).map(p => (
              <div key={p.id} className="q-row" style={{cursor: 'default'}}>
                <div style={{minWidth: 0}}>
                  <div className="q-primary">{p.cpo_name ?? p.cpo_user_id.slice(0, 8)}</div>
                  <div className="q-secondary">
                    {p.region_code} · {p.permit_ref ? 'permit on file' : 'no permit ref'}
                    {p.expires_at ? ` · expires ${formatDateUtc(p.expires_at)}` : ''}
                  </div>
                </div>
                <div className="q-right">
                  {p.authorized
                    ? <span className="pill pill-ok">AUTHORISED</span>
                    : <span className="pill pill-warn">PENDING</span>}
                </div>
              </div>
            ))}
          </Card>
        </div>

        <div>
          <Card title={`Roster · ${(data?.roster ?? []).length}`}>
            {(data?.roster ?? []).length === 0 && <div className="q-empty">No CPOs on this agency&apos;s roster.</div>}
            {(data?.roster ?? []).map(m => (
              <Link key={m.user_id} href={routes.people.agent(m.user_id)} className="q-row">
                <div style={{minWidth: 0}}>
                  <div className="q-primary">{m.display_name ?? m.user_id.slice(0, 8)}</div>
                  <div className="q-secondary">
                    member since {formatDateUtc(m.created_at)}
                    {m.on_duty ? ' · ON DUTY' : ''}
                  </div>
                </div>
                <div className="q-right">
                  {m.agent_status && <StatusPill domain="agent" value={m.agent_status} dot={false} />}
                  {m.status !== 'active' && <span className="pill">{m.status.toUpperCase()}</span>}
                </div>
              </Link>
            ))}
          </Card>

          <Card title="Dispatch record · last 50 offers">
            {(data?.offers ?? []).length === 0 && (
              <div className="q-empty">This agency has never been sent a dispatch offer.</div>
            )}
            {(data?.offers ?? []).map(o => (
              <Link
                key={o.id}
                href={bookingHref({id: o.booking_id, service: o.service})}
                className="q-row">
                <div style={{minWidth: 0}}>
                  <div className="q-primary">
                    {o.region_label ?? '—'} · rank {o.rank}
                    {o.distance_km ? ` · ${Number(o.distance_km).toFixed(1)} km` : ''}
                  </div>
                  <div className="q-secondary">
                    offered {formatDateTimeUtc(o.offered_at)}
                    {o.reject_reason ? ` · ${o.reject_reason}` : ''}
                  </div>
                </div>
                <div className="q-right">
                  <span className={offerTone(o.status)}>{o.status}</span>
                </div>
              </Link>
            ))}
          </Card>
        </div>
      </div>
    </>
  );
}

function offerTone(status: string): string {
  if (status === 'ACCEPTED') return 'pill pill-ok';
  if (status === 'OFFERED') return 'pill pill-info';
  if (status === 'REJECTED' || status === 'EXPIRED') return 'pill pill-warn';
  return 'pill';
}

function Card({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <div className="card" style={{marginBottom: 12}}>
      <div className="card-header">
        <div className="card-header-title"><span className="bar" />{title}</div>
      </div>
      {children}
    </div>
  );
}

function Row({k, v}: {k: string; v: string}) {
  return (
    <div style={{
      padding: '9px 14px', display: 'grid', gridTemplateColumns: '150px 1fr',
      gap: 10, borderBottom: '1px solid var(--bd-2)', alignItems: 'center',
    }}>
      <div className="exec-cap">{k}</div>
      <div style={{fontSize: 12.5, color: 'var(--tx-1)'}}>{v}</div>
    </div>
  );
}
