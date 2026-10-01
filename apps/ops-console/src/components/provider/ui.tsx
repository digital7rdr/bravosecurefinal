'use client';

import {useEffect, useMemo, useState, type ReactNode} from 'react';
import {pillClass} from '@/lib/status';
import {
  pvApi, type CoarseOffer, type OrgMission, type RosterMember,
} from '@/lib/provider/api';
import {
  PRODUCT_LABEL, credits, errorText, missionState, productOf, serviceLabel, when,
} from '@/lib/provider/labels';

/* ── Page title ──────────────────────────────────────────────────────── */

export function PvPage({title, subtitle, right, children}: {
  title: ReactNode; subtitle?: ReactNode; right?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="pv-page">
      <div className="pv-head">
        <div>
          <h1 className="pv-title">{title}</h1>
          {subtitle && <p className="pv-sub">{subtitle}</p>}
        </div>
        {right && <div className="pv-head-right">{right}</div>}
      </div>
      {children}
    </div>
  );
}

export function PvCard({title, right, children, pad = true}: {
  title?: ReactNode; right?: ReactNode; children: ReactNode; pad?: boolean;
}) {
  return (
    <section className="card pv-card">
      {title && (
        <div className="card-header">
          <div className="card-header-title"><span className="bar"/>{title}</div>
          {right && <div className="card-header-act">{right}</div>}
        </div>
      )}
      <div className={pad ? 'pv-card-body' : undefined}>{children}</div>
    </section>
  );
}

export function Stat({label, value, sub, tone}: {label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'warn' | 'err' | 'info' | 'act'}) {
  return (
    <div className="kpi">
      {tone && <span className="kpi-accent" style={{background: `var(--${tone})`}}/>}
      <div className="kpi-cap">{label}</div>
      <div className="kpi-num">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

export function Empty({children}: {children: ReactNode}) {
  return <div className="pv-empty">{children}</div>;
}

export function ProductTag({service}: {service: string}) {
  const p = productOf(service);
  return <span className={`pv-tag pv-tag-${p}`}>{PRODUCT_LABEL[p]}</span>;
}

export function StatePill({m}: {m: OrgMission}) {
  const s = missionState(m);
  return <span className={pillClass(s.tone)}>{s.label}</span>;
}

/* ── Dialog ──────────────────────────────────────────────────────────── */

export function PvDialog({open, title, description, children, footer, onClose, busy, wide}: {
  open: boolean; title: string; description?: ReactNode; children?: ReactNode;
  footer: ReactNode; onClose: () => void; busy?: boolean; wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [open, busy, onClose]);
  if (!open) return null;
  return (
    <div className="pv-backdrop" onClick={() => !busy && onClose()}>
      <div className={`pv-dialog ${wide ? 'pv-dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}
        onClick={e => e.stopPropagation()}>
        <div className="pv-dialog-head">
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {children && <div className="pv-dialog-body">{children}</div>}
        <div className="pv-dialog-foot">{footer}</div>
      </div>
    </div>
  );
}

/* ── Live offer ──────────────────────────────────────────────────────── */

function useCountdown(iso: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  return Math.max(0, Math.floor((new Date(iso).getTime() - now) / 1000));
}

export function OfferCard({offer, onDone}: {offer: CoarseOffer; onDone: (msg: string, ok: boolean) => void}) {
  const left = useCountdown(offer.expires_at);
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const expired = left === 0;
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');

  async function act(kind: 'accept' | 'reject') {
    setBusy(kind); setErr(null);
    try {
      if (kind === 'accept') {
        await pvApi.acceptOffer(offer.offer_id);
        onDone('Offer accepted. Assign a crew from Jobs → Needs crew.', true);
      } else {
        await pvApi.rejectOffer(offer.offer_id);
        onDone('Offer declined. It has moved to the next agency.', true);
      }
    } catch (e) {
      setErr(errorText(e));
    } finally { setBusy(null); }
  }

  const req = offer.requirements;
  return (
    <div className="pv-offer">
      <div className="pv-offer-top">
        <div className="pv-offer-title">
          <ProductTag service={offer.service}/>
          <span>{serviceLabel(offer)}</span>
        </div>
        <span className={`pv-timer ${left < 30 ? 'pv-timer-low' : ''}`} aria-live="polite">
          {expired ? 'Expired' : `${mm}:${ss} left`}
        </span>
      </div>
      <dl className="pv-facts">
        <div><dt>When</dt><dd>{when(offer.pickup_time)}{offer.booking_mode === 'now' ? ' · now' : ''}</dd></div>
        <div><dt>Area</dt><dd>{offer.region_label}</dd></div>
        <div><dt>Distance</dt><dd>{offer.distance_km != null ? `about ${offer.distance_km} km` : offer.distance_bucket}</dd></div>
        <div><dt>Duration</dt><dd>{offer.duration_hours} h</dd></div>
        <div><dt>Officers</dt><dd>{offer.cpo_count}{offer.vehicle_count ? ` · ${offer.vehicle_count} vehicle${offer.vehicle_count > 1 ? 's' : ''}` : ''}</dd></div>
        <div><dt>Price</dt><dd className="pv-strong">AED {offer.price.aed}</dd></div>
      </dl>
      {(req.armed || req.driver_only || req.add_ons.length > 0) && (
        <div className="pv-reqs">
          {req.armed && <span className="pill pill-warn">Armed officers</span>}
          {req.driver_only && <span className="pill">Driver only</span>}
          {req.add_ons.map(a => <span key={a} className="pill">{a.replace(/_/g, ' ')}</span>)}
        </div>
      )}
      <p className="pv-note">The exact pick-up address is shown after you accept.</p>
      {err && <div className="pv-err" role="alert">{err}</div>}
      <div className="pv-actions">
        <button className="btn btn-ghost" disabled={!!busy || expired} onClick={() => act('reject')}>
          {busy === 'reject' ? 'Declining…' : 'Decline'}
        </button>
        <button className="btn btn-pri" disabled={!!busy || expired} onClick={() => act('accept')}>
          {busy === 'accept' ? 'Accepting…' : 'Accept job'}
        </button>
      </div>
    </div>
  );
}

/* ── Assign crew ─────────────────────────────────────────────────────── */

export function availability(m: RosterMember): {ok: boolean; label: string} {
  if (m.status !== 'active') return {ok: false, label: m.status === 'suspended' ? 'Suspended' : m.status};
  if (m.on_mission) return {ok: false, label: 'On a mission'};
  if (!m.on_duty) return {ok: false, label: 'Off duty'};
  return {ok: true, label: 'Available'};
}

export function AssignCrewDialog({job, roster, onClose, onDone}: {
  job: OrgMission | null; roster: RosterMember[] | undefined;
  onClose: () => void; onDone: (msg: string) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [lead, setLead] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { setPicked([]); setLead(null); setErr(null); }, [job?.booking_id]);

  const officers = useMemo(() => (roster ?? [])
    .filter(m => m.member_role === 'cpo' && m.status !== 'removed')
    .sort((a, b) => Number(availability(b).ok) - Number(availability(a).ok)
      || (a.call_sign ?? a.display_name ?? '').localeCompare(b.call_sign ?? b.display_name ?? '')), [roster]);

  if (!job) return null;
  const need = job.cpo_count;

  function toggle(id: string) {
    setPicked(p => {
      const next = p.includes(id) ? p.filter(x => x !== id) : p.length < need ? [...p, id] : p;
      if (lead && !next.includes(lead)) setLead(next[0] ?? null);
      if (!lead && next.length > 0) setLead(next[0]);
      return next;
    });
  }

  async function submit() {
    if (!job || !lead) return;
    setBusy(true); setErr(null);
    try {
      const r = await pvApi.assignCrew(job.booking_id, {cpo_user_ids: picked, lead_user_id: lead});
      onDone(`Crew assigned. Mission ${r.short_code} is ready to dispatch.`);
    } catch (e) {
      setErr(errorText(e));
    } finally { setBusy(false); }
  }

  return (
    <PvDialog open title="Assign crew" wide busy={busy} onClose={onClose}
      description={<>
        {serviceLabel(job)} · {when(job.pickup_time)} · {job.pickup_address}.
        {' '}Pick <b>{need}</b> officer{need > 1 ? 's' : ''}{job.armed_required ? ', armed' : ''}, then choose the lead.
      </>}
      footer={<>
        <span className="pv-count">{picked.length} of {need} selected</span>
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn btn-pri" disabled={busy || picked.length !== need || !lead} onClick={submit}>
          {busy ? 'Assigning…' : 'Assign crew'}
        </button>
      </>}>
      {officers.length === 0 ? (
        <Empty>No officers on your roster yet. Add them under Officers.</Empty>
      ) : (
        <ul className="pv-picklist">
          {officers.map(o => {
            const a = availability(o);
            const armedMissing = job.armed_required && !o.armed_authorized;
            const disabled = !a.ok || armedMissing;
            const on = picked.includes(o.member_user_id);
            return (
              <li key={o.member_user_id} className={`pv-pick ${on ? 'on' : ''} ${disabled ? 'off' : ''}`}>
                <label>
                  <input type="checkbox" checked={on} disabled={disabled && !on}
                    onChange={() => toggle(o.member_user_id)}/>
                  <span className="pv-pick-name">
                    {o.display_name ?? 'Officer'}{o.call_sign ? <span className="pv-mono"> · {o.call_sign}</span> : null}
                  </span>
                  <span className={`pill ${a.ok && !armedMissing ? 'pill-ok' : ''}`}>
                    {!a.ok ? a.label : armedMissing ? 'Not armed' : a.label}
                  </span>
                  {o.armed_authorized && <span className="pill pill-info">Armed</span>}
                </label>
                {on && (
                  <label className="pv-lead">
                    <input type="radio" name="lead" checked={lead === o.member_user_id}
                      onChange={() => setLead(o.member_user_id)}/>
                    Lead
                  </label>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {err && <div className="pv-err" role="alert" style={{marginTop: 12}}>{err}</div>}
    </PvDialog>
  );
}

/* ── Plain confirm ───────────────────────────────────────────────────── */

export function ConfirmDialog({open, title, description, confirmLabel, danger, onConfirm, onClose}: {
  open: boolean; title: string; description: ReactNode; confirmLabel: string; danger?: boolean;
  onConfirm: () => Promise<void>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) setErr(null); }, [open]);
  return (
    <PvDialog open={open} title={title} description={description} busy={busy} onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-pri'}`} disabled={busy}
          onClick={async () => {
            setBusy(true); setErr(null);
            try { await onConfirm(); } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
          }}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </>}>
      {err ? <div className="pv-err" role="alert">{err}</div> : null}
    </PvDialog>
  );
}

export {credits};
