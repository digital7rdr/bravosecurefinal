'use client';

/**
 * Referral / discount campaigns (2026-09-05) — the list + mint surface.
 *
 * Ops mints a code (universal or bound to one region, percent or fixed credits,
 * optional service filter, caps and a validity window); clients apply it on a
 * booking and pay less. Each row carries the figures the founder asked for:
 * how many used it, what was sold (gross), what was given away (discount) and
 * what was actually charged (net), split out for bookings that reached payment.
 */

import {useMemo, useState} from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import {
  opsApi, opsDataApi, useOpsMe, useReferralCampaigns, useReferralCampaignsOverview,
  type CreateReferralCampaignBody, type ReferralCampaignRow,
} from '@/lib/api';
import {canManageReferralCodes} from '@/lib/rbac';
import {routes} from '@/lib/routes';
import {DataTable, type Column} from '@/components/DataTable';
import {KpiRow, KpiTile} from '@/components/SectionLanding';
import {pillClass, type Tone} from '@/lib/status';
import {formatDateUtc} from '@/lib/datetime';
import {normaliseReferralCode} from '@/lib/referralLinks';

export const SERVICE_OPTIONS: Array<{key: string; label: string}> = [
  {key: 'secure_transfer', label: 'Secure Transfer'},
  {key: 'executive_protection', label: 'Executive Protection'},
  {key: 'recon_team', label: 'Recon Team'},
  {key: 'emergency_extraction', label: 'Emergency Extraction'},
];

export const STATUS_TONE: Record<ReferralCampaignRow['status'], Tone> = {
  active: 'ok', scheduled: 'info', expired: 'muted', inactive: 'warn', exhausted: 'warn',
};

export function discountLabel(c: Pick<ReferralCampaignRow, 'discount_type' | 'discount_value' | 'max_discount_bc'>): string {
  const v = Number(c.discount_value);
  if (c.discount_type === 'percent') {
    return `${Number.isInteger(v) ? v : v.toFixed(1)}% off${c.max_discount_bc ? ` (max ${c.max_discount_bc} BC)` : ''}`;
  }
  return `${Math.round(v)} BC off`;
}

export function bc(eur: string | number | null | undefined): string {
  return `${Math.round(Number(eur ?? 0)).toLocaleString()} BC`;
}

const field: React.CSSProperties = {
  height: 34, padding: '0 10px', borderRadius: 8, border: '1px solid var(--bd-1)',
  background: 'var(--surf-3)', color: 'var(--tx-1)', fontSize: 12.5, minWidth: 0,
};
const label: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4, fontFamily: 'var(--font-mono)', fontSize: 9.5,
  letterSpacing: 1, textTransform: 'uppercase', color: 'var(--tx-3)',
};

export function ReferralCampaigns() {
  const {data: me} = useOpsMe();
  const canManage = canManageReferralCodes(me?.admin.role);
  const {data: rows, error, isLoading, mutate} = useReferralCampaigns();
  const {data: overview} = useReferralCampaignsOverview();
  const {data: regionData} = useSWR('ops-regions', () => opsDataApi.regions());
  const regions = regionData?.regions ?? [];

  const [showForm, setShowForm] = useState(false);
  const list = useMemo(() => rows ?? [], [rows]);

  const columns: Array<Column<ReferralCampaignRow>> = [
    {
      key: 'code', header: 'Code', width: '24%', sortValue: c => c.code,
      cell: c => (
        <div style={{minWidth: 0}}>
          <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
            <span className="q-primary mono">{c.code}</span>
            <span className={pillClass(STATUS_TONE[c.status])}>{c.status.toUpperCase()}</span>
          </div>
          <div className="q-secondary">{c.name}</div>
        </div>
      ),
    },
    {
      key: 'scope', header: 'Scope', sortValue: c => c.region_code ?? '',
      cell: c => c.scope === 'region'
        ? <span className="pill pill-info">{c.region_code}</span>
        : <span className="pill pill-act">UNIVERSAL</span>,
    },
    {key: 'discount', header: 'Discount', sortValue: c => Number(c.discount_value), cell: c => <span className="dt-val">{discountLabel(c)}</span>},
    {
      key: 'used', header: 'Used', align: 'right', sortValue: c => c.redemptions,
      cell: c => (
        <div>
          <div className="dt-val">{c.redemptions}{c.max_redemptions ? ` / ${c.max_redemptions}` : ''}</div>
          <div className="dt-val-sub">{c.unique_users} user{c.unique_users === 1 ? '' : 's'}</div>
        </div>
      ),
    },
    {key: 'gross', header: 'Sold (gross)', align: 'right', hideBelow: 1100, sortValue: c => Number(c.gross_eur), cell: c => <span className="dt-val">{bc(c.gross_eur)}</span>},
    {key: 'discount_given', header: 'Given away', align: 'right', hideBelow: 1100, sortValue: c => Number(c.discount_eur), cell: c => <span style={{color: 'var(--warn)'}}>−{bc(c.discount_eur)}</span>},
    {
      key: 'net', header: 'Charged (net)', align: 'right', sortValue: c => Number(c.net_eur),
      cell: c => (
        <div>
          <div className="dt-val">{bc(c.net_eur)}</div>
          <div className="dt-val-sub">{c.paid_bookings} paid · {bc(c.paid_net_eur)}</div>
        </div>
      ),
    },
    {
      key: 'window', header: 'Valid', hideBelow: 900, sortValue: c => c.expires_at ?? '9999',
      cell: c => (
        <span className="dt-when">
          {c.starts_at ? `${formatDateUtc(c.starts_at)} → ` : ''}
          {c.expires_at ? formatDateUtc(c.expires_at) : 'no expiry'}
        </span>
      ),
    },
  ];

  return (
    <>
      <KpiRow columns={5}>
        <KpiTile label="Campaigns" value={overview?.campaigns ?? '—'} href={routes.finance.referralCampaigns}
          sub={overview ? `${overview.active} live now` : undefined} />
        <KpiTile label="Redemptions" value={overview?.redemptions ?? '—'} href={routes.finance.referralCampaigns}
          tone="act" sub={overview ? `${overview.redemptions_7d} in the last 7 days` : undefined} />
        <KpiTile label="Users" value={overview?.unique_users ?? '—'} href={routes.finance.referralCampaigns} sub="distinct clients" />
        <KpiTile label="Given away" value={overview ? bc(overview.discount_eur) : '—'} href={routes.finance.referralCampaigns} tone="warn" />
        <KpiTile label="Charged (net)" value={overview ? bc(overview.net_eur) : '—'} href={routes.finance.referralCampaigns} tone="ok" />
      </KpiRow>

      {canManage && (
        <div className="card" style={{marginBottom: 14}}>
          <div className="card-header">
            <div className="card-header-title"><span className="bar" />Mint a campaign</div>
            <button type="button" className="card-header-act" style={{background: 'none', border: 'none'}}
              onClick={() => setShowForm(s => !s)}>
              {showForm ? 'HIDE' : 'NEW CAMPAIGN +'}
            </button>
          </div>
          {showForm && (
            <MintForm
              regions={regions.map(r => ({code: r.code, name: r.name, launched: r.launched}))}
              onMinted={() => { setShowForm(false); void mutate(); }}
            />
          )}
          {!showForm && (
            <div className="q-empty" style={{textAlign: 'left'}}>
              A campaign is a code clients type on the booking&apos;s Team &amp; Add-ons step, or arrive with through a
              shared link. It lowers their total and nothing else — never availability, licensing or who is assigned.
            </div>
          )}
        </div>
      )}

      <DataTable
        ariaLabel="Referral campaigns"
        rows={list}
        columns={columns}
        rowKey={c => c.id}
        rowHref={c => routes.finance.referralCampaign(c.id)}
        loading={isLoading}
        error={Boolean(error)}
        initialSort={{key: 'used', dir: 'desc'}}
        empty={canManage ? 'No campaigns yet — mint the first one above.' : 'No campaigns yet.'}
        footer={<span>Open a campaign for its share link, the day-by-day usage and every booking that used it.</span>}
      />
    </>
  );
}

function MintForm({regions, onMinted}: {
  regions: Array<{code: string; name: string; launched: boolean}>;
  onMinted: () => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'universal' | 'region'>('universal');
  const [region, setRegion] = useState('');
  const [type, setType] = useState<'percent' | 'fixed_bc'>('percent');
  const [value, setValue] = useState('10');
  const [cap, setCap] = useState('');
  const [services, setServices] = useState<string[]>([]);
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [perUser, setPerUser] = useState('1');
  const [starts, setStarts] = useState('');
  const [expires, setExpires] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [minted, setMinted] = useState<(ReferralCampaignRow & {eligible_clients?: number}) | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null); setMinted(null);
    try {
      const body: CreateReferralCampaignBody = {
        code: normaliseReferralCode(code),
        name: name.trim(),
        scope,
        ...(scope === 'region' ? {region_code: region} : {}),
        discount_type: type,
        discount_value: Number(value),
        ...(type === 'percent' && cap ? {max_discount_bc: Number(cap)} : {}),
        ...(services.length ? {services} : {}),
        ...(maxRedemptions ? {max_redemptions: Number(maxRedemptions)} : {}),
        per_user_limit: Math.max(1, Number(perUser) || 1),
        ...(starts ? {starts_at: `${starts}T00:00:00.000Z`} : {}),
        ...(expires ? {expires_at: `${expires}T23:59:59.999Z`} : {}),
        ...(notes.trim() ? {notes: notes.trim()} : {}),
      };
      const row = await opsApi.createReferralCampaign(body);
      setMinted(row);
      setCode(''); setName(''); setValue('10'); setCap(''); setServices([]); setMaxRedemptions(''); setNotes('');
      onMinted();
    } catch (e) {
      const msg = (e as Error).message;
      setErr(
        /code_already_exists/.test(msg) ? 'That code already exists.'
        : /region_code_required/.test(msg) ? 'Pick a region for a regional code.'
        : /percent_over_100/.test(msg) ? 'A percent discount cannot exceed 100.'
        : /expires_at_in_past/.test(msg) ? 'The expiry date is in the past.'
        : /starts_after_expiry/.test(msg) ? 'The start date is after the expiry.'
        : /referral_code_invalid_format/.test(msg) ? 'Codes are letters, digits and dashes.'
        : msg,
      );
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} style={{padding: 14, display: 'grid', gap: 12}}>
      <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10}}>
        <label style={label}>Code
          <input value={code} onChange={e => setCode(normaliseReferralCode(e.target.value))} required minLength={2} maxLength={32}
            placeholder="DXB20" style={{...field, fontFamily: 'var(--font-mono)', letterSpacing: 1}} />
        </label>
        <label style={label}>Name
          <input value={name} onChange={e => setName(e.target.value)} required minLength={2} maxLength={120}
            placeholder="Dubai launch · 20% off" style={field} />
        </label>
        <label style={label}>Scope
          <select value={scope} onChange={e => setScope(e.target.value as 'universal' | 'region')} style={field}>
            <option value="universal">Universal (every region)</option>
            <option value="region">One region</option>
          </select>
        </label>
        {scope === 'region' && (
          <label style={label}>Region
            <select value={region} onChange={e => setRegion(e.target.value)} required style={field}>
              <option value="">Pick a region…</option>
              {regions.map(r => <option key={r.code} value={r.code}>{r.code} · {r.name}{r.launched ? '' : ' (not launched)'}</option>)}
            </select>
          </label>
        )}
        <label style={label}>Discount type
          <select value={type} onChange={e => setType(e.target.value as 'percent' | 'fixed_bc')} style={field}>
            <option value="percent">Percent off</option>
            <option value="fixed_bc">Fixed credits off</option>
          </select>
        </label>
        <label style={label}>{type === 'percent' ? 'Percent' : 'Credits (BC)'}
          <input type="number" value={value} onChange={e => setValue(e.target.value)} required min={0.01}
            max={type === 'percent' ? 100 : 100000} step={type === 'percent' ? 0.5 : 1} style={field} />
        </label>
        {type === 'percent' && (
          <label style={label}>Max discount (BC, optional)
            <input type="number" value={cap} onChange={e => setCap(e.target.value)} min={1} placeholder="no cap" style={field} />
          </label>
        )}
        <label style={label}>Total uses (optional)
          <input type="number" value={maxRedemptions} onChange={e => setMaxRedemptions(e.target.value)} min={1} placeholder="unlimited" style={field} />
        </label>
        <label style={label}>Uses per client
          <input type="number" value={perUser} onChange={e => setPerUser(e.target.value)} min={1} max={1000} required style={field} />
        </label>
        <label style={label}>Starts (UTC, optional)
          <input type="date" value={starts} onChange={e => setStarts(e.target.value)} style={field} />
        </label>
        <label style={label}>Expires (end of day, UTC)
          <input type="date" value={expires} onChange={e => setExpires(e.target.value)} style={field} />
        </label>
      </div>
      <div style={{display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center'}}>
        <span style={{...label, flexDirection: 'row'}}>Services</span>
        {SERVICE_OPTIONS.map(s => {
          const on = services.includes(s.key);
          return (
            <button key={s.key} type="button" onClick={() => setServices(v => on ? v.filter(x => x !== s.key) : [...v, s.key])}
              className={`btn btn-sm ${on ? 'btn-pri' : 'btn-ghost'}`} aria-pressed={on}>
              {s.label}
            </button>
          );
        })}
        <span style={{fontSize: 11, color: 'var(--tx-3)'}}>{services.length === 0 ? 'none selected = every service' : `${services.length} selected`}</span>
      </div>
      <label style={label}>Notes (internal, optional)
        <input value={notes} onChange={e => setNotes(e.target.value)} maxLength={500} placeholder="Who this is for, where it is printed…" style={field} />
      </label>
      <div style={{display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap'}}>
        <button type="submit" className="btn btn-pri" disabled={busy}>{busy ? 'MINTING…' : 'MINT CAMPAIGN'}</button>
        {err && <span style={{color: 'var(--err)', fontSize: 12}}>{err}</span>}
        {minted && (
          <span style={{color: 'var(--ok)', fontSize: 12}}>
            <span className="mono">{minted.code}</span> is live
            {typeof minted.eligible_clients === 'number'
              ? ` · announcing it by push to ${minted.eligible_clients.toLocaleString()} eligible client${minted.eligible_clients === 1 ? '' : 's'}`
              : ''}
            {' · '}<Link href={routes.finance.referralCampaign(minted.id)}>open it for the share link →</Link>
          </span>
        )}
      </div>
    </form>
  );
}
