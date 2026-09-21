'use client';

/**
 * IA-16 — the Executive Protection panel the booking detail never had.
 *
 * An Executive detail is a fixed BLOCK of hours with per-unit pricing and
 * optional add-ons; the shared booking detail rendered it as a Lite transfer
 * with two extra rows ("Task", "Transfer Leg") and left the block length, the
 * per-unit composition and the add-on set to be inferred from the total.
 *
 * The numbers come from the booking's STORED `price_breakdown` — never
 * recomputed from the live pricing board. A board edit re-prices the next
 * quote, not a booking that was already charged, and recomputing here would
 * quietly show an operator a price the customer never paid.
 */

import type {PriceBreakdown} from '@/lib/api';
import {formatDateTimeUtc} from '@/lib/datetime';

const ADDON_LABELS: Record<string, string> = {
  female_cpo: 'Female CPO Team',
  recon: 'Advance Assessment Team',
  medical: 'Medical Support',
  comms: 'Secure Communications',
};

export interface ExecTransport {
  mode?: string | null;
  passengers?: number | null;
  pickup_time?: string | null;
  pickup?: {address?: string | null} | null;
  dropoff?: {address?: string | null} | null;
}

export function ExecPricingBreakdown({
  taskType, durationHours, startIso, cpoCount, vehicleCount, driverOnly,
  addOns, breakdown, transport,
}: {
  taskType: string | null | undefined;
  durationHours: number | null | undefined;
  startIso: string | null | undefined;
  cpoCount: number;
  vehicleCount: number;
  driverOnly: boolean | null | undefined;
  addOns: string[] | null | undefined;
  breakdown: PriceBreakdown | null | undefined;
  transport: ExecTransport | null | undefined;
}) {
  const hours = durationHours ?? breakdown?.duration_hours ?? null;
  const end = startIso && hours
    ? new Date(new Date(startIso).getTime() + hours * 3600_000).toISOString()
    : null;

  return (
    <div className="card" style={{marginBottom: 12}}>
      <div className="card-header">
        <div className="card-header-title"><span className="bar" />Executive detail</div>
        <div className="card-header-act">{(taskType ?? 'site_protection').replace(/_/g, ' ')}</div>
      </div>

      <div className="exec-grid">
        <Cell label="Block" value={hours ? `${hours} hours` : '—'} />
        <Cell label="Starts" value={startIso ? formatDateTimeUtc(startIso) : '—'} />
        <Cell label="Ends (computed)" value={end ? formatDateTimeUtc(end) : '—'} />
        <Cell
          label="Units"
          value={driverOnly
            ? `${cpoCount}× CPO · driver only (client vehicle)`
            : `${cpoCount}× CPO · ${vehicleCount}× vehicle + driver`}
        />
      </div>

      <div style={{padding: '10px 14px', borderTop: '1px solid var(--bd-2)'}}>
        <div className="exec-sub">Add-ons</div>
        {(addOns ?? []).length === 0
          ? <div style={{fontSize: 12, color: 'var(--tx-3)'}}>None</div>
          : (
            <div style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>
              {(addOns ?? []).map(a => (
                <span key={a} className="pill pill-info">{ADDON_LABELS[a] ?? a.replace(/_/g, ' ')}</span>
              ))}
            </div>
          )}
      </div>

      {transport && (
        <div style={{padding: '10px 14px', borderTop: '1px solid var(--bd-2)'}}>
          <div className="exec-sub">Transfer leg</div>
          <div style={{fontSize: 12.5, color: 'var(--tx-1)'}}>
            {String(transport.mode ?? '').replace(/_/g, ' ') || 'Transfer'} ·{' '}
            {transport.pickup?.address ?? '—'} → {transport.dropoff?.address ?? '—'}
          </div>
          <div style={{fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--tx-3)', marginTop: 3}}>
            {transport.passengers ?? '—'} PAX ·{' '}
            {transport.pickup_time ? formatDateTimeUtc(transport.pickup_time) : 'at start time'}
          </div>
        </div>
      )}

      <div style={{padding: '10px 14px', borderTop: '1px solid var(--bd-2)'}}>
        <div className="exec-sub">Price composition (as charged)</div>
        {breakdown && breakdown.items.length > 0 ? (
          <>
            {breakdown.items.map(it => (
              <div key={it.id} className="exec-line">
                <span>{it.label}{it.qty > 1 ? ` × ${it.qty}` : ''}</span>
                <span className="mono">{it.subtotal_eur.toLocaleString()} BC</span>
              </div>
            ))}
            <div className="exec-line exec-line-total">
              <span>{breakdown.duration_hours} h × {breakdown.rate_eur_per_hour.toLocaleString()} BC/h</span>
              <span className="mono">{breakdown.total_eur.toLocaleString()} BC</span>
            </div>
          </>
        ) : (
          <div style={{fontSize: 12, color: 'var(--tx-3)'}}>
            No stored composition on this booking — it predates per-unit pricing.
          </div>
        )}
      </div>
    </div>
  );
}

function Cell({label, value}: {label: string; value: string}) {
  return (
    <div>
      <div className="exec-cap">{label}</div>
      <div className="exec-val">{value}</div>
    </div>
  );
}
