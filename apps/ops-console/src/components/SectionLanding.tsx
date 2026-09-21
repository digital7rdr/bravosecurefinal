'use client';

/**
 * IA-14 — every section gets a landing page.
 *
 * The pre-restructure console was 23 leaf pages with no "here is what is waiting
 * on you in this business" view, so an operator starting a shift had to open
 * every list to find work. These primitives build the Lite / Executive /
 * Secure Pro / Enterprise / Config / Finance landings from the data each
 * section already polls — no new endpoints for the tiles themselves.
 */

import type {ReactNode} from 'react';
import Link from 'next/link';
import {pillClass, type Tone} from '@/lib/status';

/* ── KPI tile ────────────────────────────────────────────────────────── */

export interface KpiTileProps {
  label: string;
  value: ReactNode;
  /** Every tile links somewhere — a number an operator cannot act on is noise. */
  href: string;
  sub?: ReactNode;
  tone?: Tone;
  /** Raises the tile visually when it is non-zero and needs a human. */
  urgent?: boolean;
}

export function KpiTile({label, value, href, sub, tone, urgent}: KpiTileProps) {
  return (
    <Link href={href} className={`kpi kpi-link ${urgent ? 'kpi-urgent' : ''}`}>
      {tone && <span className="kpi-accent" style={{background: `var(--${toneVar(tone)})`}} />}
      <div className="kpi-cap">{label}</div>
      <div className="kpi-num">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </Link>
  );
}

function toneVar(tone: Tone): string {
  return tone === 'ok' ? 'ok'
    : tone === 'warn' ? 'warn'
    : tone === 'err' ? 'err'
    : tone === 'info' ? 'info'
    : tone === 'live' ? 'act'
    : tone === 'act' ? 'act'
    : 'tx-3';
}

export function KpiRow({children, columns = 5}: {children: ReactNode; columns?: number}) {
  return (
    <div className="kpi-row" style={{gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`}}>
      {children}
    </div>
  );
}

/* ── Work queue ──────────────────────────────────────────────────────── */

export interface QueueRow {
  id: string;
  href: string;
  primary: ReactNode;
  secondary?: ReactNode;
  status?: {label: string; tone: Tone};
  right?: ReactNode;
}

export function WorkQueue({
  title, rows, empty, loading, error, footer, max = 8,
}: {
  title: string;
  rows: QueueRow[];
  empty: string;
  loading?: boolean;
  error?: boolean;
  footer?: ReactNode;
  max?: number;
}) {
  return (
    <div className="card">
      <div className="card-header">
        <div className="card-header-title"><span className="bar" />{title}</div>
        {rows.length > max && <div className="card-header-act">{rows.length} total</div>}
      </div>
      <div>
        {error && <div className="q-empty" style={{color: 'var(--err)'}}>Could not load this queue.</div>}
        {!error && loading && rows.length === 0 && (
          <>
            <div className="skel-row" /><div className="skel-row" /><div className="skel-row" />
          </>
        )}
        {!error && !loading && rows.length === 0 && <div className="q-empty">{empty}</div>}
        {rows.slice(0, max).map(r => (
          <Link key={r.id} href={r.href} className="q-row">
            <div style={{minWidth: 0}}>
              <div className="q-primary">{r.primary}</div>
              {r.secondary && <div className="q-secondary">{r.secondary}</div>}
            </div>
            <div className="q-right">
              {r.right}
              {r.status && <span className={pillClass(r.status.tone)}>{r.status.label}</span>}
            </div>
          </Link>
        ))}
      </div>
      {footer && <div className="q-footer">{footer}</div>}
    </div>
  );
}

/* ── Landing scaffold ────────────────────────────────────────────────── */

export function LandingGrid({children, columns = 2}: {children: ReactNode; columns?: number}) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
      gap: 16, alignItems: 'start',
    }}>
      {children}
    </div>
  );
}
