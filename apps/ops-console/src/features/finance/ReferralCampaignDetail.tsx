'use client';

/**
 * One referral campaign (2026-09-05): the share links, the money and usage
 * figures, the day-by-day curve, the status split, every booking that used
 * it, and the switches ops may flip (active, expiry, caps, name, notes).
 * The code and the discount are deliberately NOT editable — the ledger's
 * history must keep meaning what was offered at the time.
 */

import {useEffect, useMemo, useState, type ReactNode} from 'react';
import Link from 'next/link';
import {
  opsApi, useOpsMe, useReferralCampaign, type ReferralCampaignRow, type ReferralRedemptionRow,
} from '@/lib/api';
import {canManageReferralCodes} from '@/lib/rbac';
import {routes, bookingHref} from '@/lib/routes';
import {PageHeader} from '@/components/PageHeader';
import {DataTable, type Column} from '@/components/DataTable';
import {KpiRow, KpiTile} from '@/components/SectionLanding';
import {CopyId} from '@/components/CopyId';
import {StatusPill} from '@/components/StatusPill';
import {pillClass} from '@/lib/status';
import {formatDateTimeShortUtc, formatDateTimeUtc, formatDateUtc} from '@/lib/datetime';
import {referralAppLink, referralWebLink} from '@/lib/referralLinks';
import {STATUS_TONE, SERVICE_OPTIONS, discountLabel, bc} from './ReferralCampaignsPage';

const field: React.CSSProperties = {
  height: 34, padding: '0 10px', borderRadius: 8, border: '1px solid var(--bd-1)',
  background: 'var(--surf-3)', color: 'var(--tx-1)', fontSize: 12.5, minWidth: 0,
};

export function ReferralCampaignDetail({id}: {id: string}) {
  const {data: me} = useOpsMe();
  const canManage = canManageReferralCodes(me?.admin.role);
  const {data, isLoading, error, mutate} = useReferralCampaign(id);
  const c = data?.campaign;
  const [origin, setOrigin] = useState('');
  useEffect(() => { setOrigin(window.location.origin); }, []);

  if (error) {
    return (
      <>
        <PageHeader title="Referral campaign" back={{href: routes.finance.referralCampaigns, label: 'Referral campaigns'}} />
        <div className="card" style={{padding: 24, color: 'var(--err)'}}>Could not load this campaign. It may not exist.</div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        crumbs={['Finance', 'Promos & Referrals', c?.code ?? '…']}
        back={{href: routes.finance.referralCampaigns, label: 'Referral campaigns'}}
        title={c ? <span className="mono">{c.code}</span> : (isLoading ? 'Loading…' : 'Campaign')}
        subtitle={c ? `${c.name} · ${discountLabel(c)} · ${c.scope === 'region' ? c.region_code : 'every region'}` : undefined}
        badges={c && <span className={pillClass(STATUS_TONE[c.status])}>{c.status.toUpperCase()}</span>}
        actions={c && canManage && (
          <span style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
            <NotifyButton c={c} onChanged={() => void mutate()} />
            <ActiveToggle c={c} onChanged={() => void mutate()} />
          </span>
        )}
      />

      <KpiRow columns={6}>
        <KpiTile label="Used" value={c ? `${c.redemptions}${c.max_redemptions ? ` / ${c.max_redemptions}` : ''}` : '—'} href="#history"
          tone="act" sub={c ? `${c.unique_users} distinct client${c.unique_users === 1 ? '' : 's'}` : undefined} />
        <KpiTile label="Sold (gross)" value={c ? bc(c.gross_eur) : '—'} href="#history" sub="before the discount" />
        <KpiTile label="Given away" value={c ? bc(c.discount_eur) : '—'} href="#history" tone="warn" />
        <KpiTile label="Charged (net)" value={c ? bc(c.net_eur) : '—'} href="#history" tone="ok" sub="what clients pay" />
        <KpiTile label="Paid bookings" value={c?.paid_bookings ?? '—'} href="#history"
          sub={c ? `${bc(c.paid_net_eur)} confirmed or done` : undefined} />
        <KpiTile label="Valid until" value={c ? (c.expires_at ? formatDateUtc(c.expires_at) : 'no expiry') : '—'} href="#settings"
          sub={c?.starts_at ? `from ${formatDateUtc(c.starts_at)}` : undefined} />
      </KpiRow>

      <div className="org-grid">
        <div>
          <Card title="Share link">
            {c && (
              <>
                <LinkRow k="Web link" v={origin ? referralWebLink(origin, c.code) : '…'} hint="Opens a landing page with the code and an Open-in-app button. Works on a phone with no app." />
                <LinkRow k="App link" v={referralAppLink(c.code)} hint="Opens Bravo Secure directly with the code pre-filled on the next booking." />
                <LinkRow k="Code" v={c.code} hint="Typed on the Team & Add-ons step of a booking." />
              </>
            )}
          </Card>

          <div id="settings" />
          <Card title="Settings">
            {c && (
              <>
                <Row k="Discount" v={discountLabel(c)} />
                <Row k="Scope" v={c.scope === 'region' ? `Region ${c.region_code}` : 'Universal — every region'} />
                <Row k="Services" v={c.services?.length ? c.services.map(s => SERVICE_OPTIONS.find(o => o.key === s)?.label ?? s).join(', ') : 'Every service'} />
                <Row k="Uses per client" v={String(c.per_user_limit)} />
                <Row k="Total uses" v={c.max_redemptions ? `${c.redemptions} of ${c.max_redemptions}` : `${c.redemptions} (unlimited)`} />
                <Row k="Created" v={formatDateTimeUtc(c.created_at)} />
                <Row k="Clients notified" v={c.notified_at
                  ? `${(c.notified_count ?? 0).toLocaleString()} · ${formatDateTimeUtc(c.notified_at)}${(c.notified_count ?? 0) === 0 ? ' (still sending, or nobody was eligible)' : ''}`
                  : 'not yet — a live campaign is announced when minted, or press NOTIFY CLIENTS'} />
                {c.notes && <Row k="Notes" v={c.notes} />}
                {canManage && <EditForm c={c} onSaved={() => void mutate()} />}
              </>
            )}
          </Card>

          <Card title="By booking status">
            {data && data.by_status.length === 0 && <div className="q-empty">Nothing redeemed yet.</div>}
            {(data?.by_status ?? []).map(s => (
              <div key={s.status ?? 'none'} className="q-row" style={{cursor: 'default'}}>
                <div style={{minWidth: 0}}>
                  {s.status ? <StatusPill domain="booking" value={s.status} /> : <span className="pill">BOOKING GONE</span>}
                </div>
                <div className="q-right">
                  <span className="dt-val">{s.n}</span>
                  <span className="dt-val-sub">{bc(s.net)} net</span>
                </div>
              </div>
            ))}
          </Card>
        </div>

        <div>
          <Card title="Last 30 days">
            {data && data.by_day.length === 0 && <div className="q-empty">No redemptions in the last 30 days.</div>}
            {data && data.by_day.length > 0 && <DayBars rows={data.by_day} />}
          </Card>
        </div>
      </div>

      <div id="history" />
      <HistoryTable rows={data?.history ?? []} loading={isLoading} />
    </>
  );
}

function ActiveToggle({c, onChanged}: {c: ReferralCampaignRow; onChanged: () => void}) {
  const [busy, setBusy] = useState(false);
  async function flip() {
    if (busy) return;
    const next = !c.active;
    if (!window.confirm(next
      ? `Reactivate ${c.code}? Clients can apply it again immediately.`
      : `Deactivate ${c.code}? New bookings with this code will be refused; past discounts stay as charged.`)) return;
    setBusy(true);
    try { await opsApi.updateReferralCampaign(c.id, {active: next}); onChanged(); }
    catch (e) { window.alert((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <button type="button" className={`btn btn-sm ${c.active ? 'btn-danger' : 'btn-ok'}`} disabled={busy} onClick={() => void flip()}>
      {busy ? '…' : c.active ? 'DEACTIVATE' : 'REACTIVATE'}
    </button>
  );
}

function NotifyButton({c, onChanged}: {c: ReferralCampaignRow; onChanged: () => void}) {
  const [busy, setBusy] = useState(false);
  const cooled = !!c.notified_at && Date.now() - new Date(c.notified_at).getTime() < 24 * 3600_000;
  async function send() {
    if (busy) return;
    const force = cooled;
    if (!window.confirm(force
      ? `${c.code} was already announced ${formatDateTimeShortUtc(c.notified_at!)}. Send it AGAIN to every eligible client?`
      : `Announce ${c.code} by push to every eligible client now?`)) return;
    setBusy(true);
    try {
      const r = await opsApi.notifyReferralCampaign(c.id, force);
      window.alert(r.queued
        ? `Sending to ${r.eligible.toLocaleString()} eligible client(s). The count updates here when it finishes.`
        : r.skipped === 'not_live' ? 'Not sent: the campaign is not live (inactive, scheduled, expired or exhausted).'
        : r.skipped === 'cooldown' ? 'Not sent: announced less than 24 hours ago.'
        : 'Not sent: the push lane is unavailable on this server.');
      onChanged();
    } catch (e) { window.alert((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <button type="button" className="btn btn-sm btn-sec" disabled={busy || c.status !== 'active'}
      title={c.status !== 'active' ? 'Only a live campaign can be announced' : undefined}
      onClick={() => void send()}>
      {busy ? '…' : cooled ? 'NOTIFY AGAIN' : 'NOTIFY CLIENTS'}
    </button>
  );
}

function EditForm({c, onSaved}: {c: ReferralCampaignRow; onSaved: () => void}) {
  const [name, setName] = useState(c.name);
  const [expires, setExpires] = useState(c.expires_at ? c.expires_at.slice(0, 10) : '');
  const [maxRedemptions, setMaxRedemptions] = useState(c.max_redemptions ? String(c.max_redemptions) : '');
  const [perUser, setPerUser] = useState(String(c.per_user_limit));
  const [notes, setNotes] = useState(c.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      await opsApi.updateReferralCampaign(c.id, {
        name: name.trim() || undefined,
        expires_at: expires ? `${expires}T23:59:59.999Z` : null,
        max_redemptions: maxRedemptions ? Number(maxRedemptions) : null,
        per_user_limit: Math.max(1, Number(perUser) || 1),
        notes: notes.trim() || null,
      });
      setMsg('Saved.');
      onSaved();
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={save} style={{padding: 14, borderTop: '1px solid var(--bd-2)', display: 'grid', gap: 10}}>
      <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10}}>
        <label className="exec-cap" style={{display: 'grid', gap: 4}}>Name
          <input value={name} onChange={e => setName(e.target.value)} maxLength={120} style={field} /></label>
        <label className="exec-cap" style={{display: 'grid', gap: 4}}>Expires (UTC)
          <input type="date" value={expires} onChange={e => setExpires(e.target.value)} style={field} /></label>
        <label className="exec-cap" style={{display: 'grid', gap: 4}}>Total uses
          <input type="number" min={1} value={maxRedemptions} onChange={e => setMaxRedemptions(e.target.value)} placeholder="unlimited" style={field} /></label>
        <label className="exec-cap" style={{display: 'grid', gap: 4}}>Per client
          <input type="number" min={1} max={1000} value={perUser} onChange={e => setPerUser(e.target.value)} style={field} /></label>
      </div>
      <label className="exec-cap" style={{display: 'grid', gap: 4}}>Notes
        <input value={notes} onChange={e => setNotes(e.target.value)} maxLength={500} style={field} /></label>
      <div style={{display: 'flex', gap: 10, alignItems: 'center'}}>
        <button type="submit" className="btn btn-sm btn-sec" disabled={busy}>{busy ? 'SAVING…' : 'SAVE CHANGES'}</button>
        {msg && <span style={{fontSize: 12, color: msg === 'Saved.' ? 'var(--ok)' : 'var(--err)'}}>{msg}</span>}
        <span style={{fontSize: 11, color: 'var(--tx-3)'}}>The code and the discount cannot change — mint a new campaign instead.</span>
      </div>
    </form>
  );
}

function DayBars({rows}: {rows: Array<{day: string; n: string; discount: string; net: string}>}) {
  const max = useMemo(() => Math.max(1, ...rows.map(r => Number(r.n))), [rows]);
  return (
    <div style={{padding: '12px 14px', display: 'grid', gap: 6}}>
      {rows.map(r => (
        <div key={r.day} style={{display: 'grid', gridTemplateColumns: '84px 1fr 120px', gap: 10, alignItems: 'center'}}>
          <span className="dt-when">{r.day.slice(5)}</span>
          <div style={{height: 10, borderRadius: 5, background: 'var(--surf-3)', overflow: 'hidden'}}>
            <div style={{height: '100%', width: `${(Number(r.n) / max) * 100}%`, background: 'var(--act)', borderRadius: 5}} />
          </div>
          <span className="dt-val-sub" style={{textAlign: 'right'}}>{r.n} · {bc(r.net)} net</span>
        </div>
      ))}
    </div>
  );
}

function HistoryTable({rows, loading}: {rows: ReferralRedemptionRow[]; loading: boolean}) {
  const columns: Array<Column<ReferralRedemptionRow>> = [
    {
      key: 'when', header: 'When', sortValue: r => r.created_at,
      cell: r => <span className="dt-when">{formatDateTimeShortUtc(r.created_at)}</span>,
    },
    {
      key: 'user', header: 'Client', sortValue: r => r.user_name ?? '',
      cell: r => (
        <div style={{minWidth: 0}}>
          <div className="q-primary">{r.user_name ?? r.user_id.slice(0, 8)}</div>
          <div className="q-secondary">{r.region_label ?? r.region_code ?? '—'} · {r.service ?? '—'}</div>
        </div>
      ),
    },
    {
      key: 'booking', header: 'Booking', hideBelow: 900,
      cell: r => <Link href={bookingHref({id: r.booking_id, service: r.service ?? 'secure_transfer'})} className="mono" style={{fontSize: 11}}>{r.booking_id.slice(0, 8)}</Link>,
    },
    {key: 'gross', header: 'Gross', align: 'right', hideBelow: 1100, sortValue: r => Number(r.gross_eur), cell: r => <span className="dt-val">{bc(r.gross_eur)}</span>},
    {key: 'disc', header: 'Discount', align: 'right', sortValue: r => Number(r.discount_eur), cell: r => <span style={{color: 'var(--warn)'}}>−{bc(r.discount_eur)}</span>},
    {key: 'net', header: 'Charged', align: 'right', sortValue: r => Number(r.net_eur), cell: r => <span className="dt-val">{bc(r.net_eur)}</span>},
    {
      key: 'status', header: 'Status', sortValue: r => r.booking_status ?? '',
      cell: r => r.booking_status ? <StatusPill domain="booking" value={r.booking_status} /> : <span className="pill">GONE</span>,
    },
  ];
  return (
    <div className="card" style={{marginTop: 4}}>
      <div className="card-header">
        <div className="card-header-title"><span className="bar" />Redemption history · {rows.length}</div>
      </div>
      <DataTable
        ariaLabel="Redemptions"
        rows={rows}
        columns={columns}
        rowKey={r => r.id}
        loading={loading}
        initialSort={{key: 'when', dir: 'desc'}}
        empty="Nobody has used this code yet."
      />
    </div>
  );
}

function Card({title, children}: {title: string; children: ReactNode}) {
  return (
    <div className="card" style={{marginBottom: 12}}>
      <div className="card-header"><div className="card-header-title"><span className="bar" />{title}</div></div>
      {children}
    </div>
  );
}

function Row({k, v}: {k: string; v: ReactNode}) {
  return (
    <div className="org-row">
      <div className="exec-cap">{k}</div>
      <div style={{fontSize: 12.5, color: 'var(--tx-1)', minWidth: 0, overflowWrap: 'anywhere'}}>{v}</div>
    </div>
  );
}

function LinkRow({k, v, hint}: {k: string; v: string; hint: string}) {
  return (
    <div className="org-row" style={{alignItems: 'start'}}>
      <div className="exec-cap" style={{paddingTop: 3}}>{k}</div>
      <div style={{minWidth: 0}}>
        <div className="mono" style={{fontSize: 12, color: 'var(--tx-1)', overflowWrap: 'anywhere'}}>
          {v} <CopyId value={v} title={`Copy ${k.toLowerCase()}`} />
        </div>
        <div style={{fontSize: 11, color: 'var(--tx-3)', marginTop: 3}}>{hint}</div>
      </div>
    </div>
  );
}
