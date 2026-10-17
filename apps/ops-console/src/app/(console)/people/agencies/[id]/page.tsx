'use client';

/**
 * IA-08 — one provider agency: who they are, whether they are allowed to work,
 * who works for them, and what they have actually done with the offers sent to
 * them. Read-only; suspension lives on the account record under All Users,
 * which is where every other account action already is.
 *
 * 2026-10-17 — also the files the agency attached during mobile onboarding
 * (they existed, but this page only read compliance credentials). VIEW shows a
 * file in the document viewer modal and, for SUPERVISOR+, stamps it reviewed;
 * approving the application stays on the review page.
 */

import {use, useState} from 'react';
import Link from 'next/link';
import {useAgency, useOpsMe} from '@/lib/api';
import {canDecideAgent} from '@/lib/rbac';
import {isViewableUrl, markProviderDocReviewed, providerDocLabel} from '@/lib/providerDocs';
import {useDocumentViewer} from '@/components/DocumentViewerModal';
import {PageHeader} from '@/components/PageHeader';
import {StatusPill} from '@/components/StatusPill';
import {routes, bookingHref} from '@/lib/routes';
import {formatDateTimeUtc, formatDateUtc} from '@/lib/datetime';

export default function AgencyDetailPage({params}: {params: Promise<{id: string}>}) {
  const {id} = use(params);
  const {data, isLoading, error, mutate} = useAgency(id);
  const {data: me} = useOpsMe();
  const canStamp = canDecideAgent(me?.admin.role);
  const [docErr, setDocErr] = useState<string | null>(null);
  const viewer = useDocumentViewer();

  const view = async (source: 'doc' | 'kyc', key: string, url: string, title: string) => {
    setDocErr(null);
    viewer.open({url, title, subtitle: data?.agency.display_name});
    try {
      if (await markProviderDocReviewed(id, source, key, canStamp)) {await mutate();}
    } catch (e) {
      setDocErr(`Couldn't mark it reviewed: ${(e as Error).message}`);
    }
  };

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
  // Compliance-pack documents first; a KYC file that only mirrors one of them
  // (the server copies passport / licence / DBS into KYC) is not listed twice.
  const docUrls = new Set((data?.documents ?? []).map(d => d.file_url).filter(Boolean));
  const uploads = [
    ...(data?.documents ?? []).filter(d => d.state === 'done' || d.file_url).map(d => ({
      source: 'doc' as const, key: d.slot, label: providerDocLabel('doc', d.slot, d.title),
      file_url: d.file_url, uploaded_at: d.uploaded_at, reviewed_at: d.reviewed_at, state: d.state,
    })),
    ...(data?.kyc ?? []).filter(k => k.file_url && !docUrls.has(k.file_url)).map(k => ({
      source: 'kyc' as const, key: k.kind, label: providerDocLabel('kyc', k.kind, k.subject),
      file_url: k.file_url, uploaded_at: k.uploaded_at, reviewed_at: k.reviewed_at, state: k.state,
    })),
  ];

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
                    {isViewableUrl(c.file_url) && (
                      <button type="button" className="btn btn-sm btn-ghost" style={{fontSize: 9}}
                        onClick={() => viewer.open({url: c.file_url as string, title: `${c.kind.replace(/_/g, ' ')} · ${c.region_code}`, subtitle: a?.display_name})}>
                        VIEW
                      </button>
                    )}
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

          <Card title={`Onboarding documents · ${uploads.length}`}>
            {data?.onboarding && (
              <div className="q-row" style={{cursor: 'default'}}>
                <div style={{minWidth: 0}}>
                  <div className="q-primary">Application · {data.onboarding.status.replace(/_/g, ' ')}</div>
                  <div className="q-secondary">
                    {data.onboarding.submitted_at ? `submitted ${formatDateUtc(data.onboarding.submitted_at)}` : 'not submitted yet'}
                    {data.onboarding.approved_at ? ` · approved ${formatDateUtc(data.onboarding.approved_at)}` : ''}
                  </div>
                </div>
                <div className="q-right">
                  <Link href={routes.people.agent(id)} className="btn btn-sm btn-ghost" style={{fontSize: 9}}>REVIEW / APPROVE →</Link>
                </div>
              </div>
            )}
            {uploads.length === 0 && (
              <div className="q-empty">No files attached during onboarding.</div>
            )}
            {uploads.map(u => (
              <div key={`${u.source}:${u.key}`} className="q-row" style={{cursor: 'default'}}>
                <div style={{minWidth: 0}}>
                  <div className="q-primary">{u.label}</div>
                  <div className="q-secondary">
                    {u.reviewed_at ? `reviewed ${formatDateUtc(u.reviewed_at)}`
                      : u.uploaded_at ? `uploaded ${formatDateUtc(u.uploaded_at)}` : u.state}
                  </div>
                </div>
                <div className="q-right">
                  {isViewableUrl(u.file_url)
                    ? (
                      <button type="button" className={`btn btn-sm ${u.reviewed_at ? 'btn-ok' : 'btn-ghost'}`} style={{fontSize: 9}}
                        onClick={() => void view(u.source, u.key, u.file_url as string, u.label)}>
                        {u.reviewed_at ? 'REVIEWED' : 'VIEW'}
                      </button>
                    )
                    : <span className="pill">NO FILE</span>}
                </div>
              </div>
            ))}
            {docErr && <div className="q-empty" role="alert" style={{color: 'var(--err)'}}>{docErr}</div>}
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
      {viewer.modal}
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
