'use client';

/**
 * IA-06/IA-14 — the Finance landing.
 *
 * The money section opened straight onto the ledger, so the one number that
 * means "credits are stuck and only a human can move them" — holds parked by
 * the completion gate — was three clicks and a badge away. It leads here.
 */

import Link from 'next/link';
import {useFinanceEscrows, useFinancePayouts, useDisputes, useDashboard} from '@/lib/api';
import {FinanceChrome, LedgerTab} from '@/features/finance/FinancePage';
import {KpiRow, KpiTile} from '@/components/SectionLanding';
import {routes} from '@/lib/routes';

export default function FinanceOverview() {
  const {data: dash} = useDashboard();
  const {data: escrows} = useFinanceEscrows();
  const {data: payouts} = useFinancePayouts();
  const {data: disputes} = useDisputes();

  const holds = escrows ?? [];
  const inReview = holds.filter(h => h.review_required && !h.settled_at).length;
  const held = holds.filter(h => !h.settled_at).reduce((s, h) => s + Number(h.gross_credits || 0), 0);
  const unpaid = (payouts ?? []).filter(p => p.paid_credits == null).length;
  const openDisputes = (disputes ?? []).length;

  return (
    <>
      <FinanceChrome
        title="Finance"
        subtitle="Wallet ledger, escrow settlement, payouts, disputes, invoices and promos — read straight from the money tables. Ledger reads require SUPERVISOR or above."
      />

      <KpiRow columns={5}>
        <KpiTile
          label="Held in escrow" value={held.toLocaleString()}
          href={routes.finance.escrow} sub="BC, not yet settled"
        />
        <KpiTile
          label="Parked for review" value={inReview}
          href={routes.finance.escrow} tone="warn" urgent={inReview > 0}
          sub="need a release or refund"
        />
        <KpiTile
          label="Payouts unpaid" value={unpaid}
          href={routes.finance.payouts} tone="info"
        />
        <KpiTile
          label="Open disputes" value={openDisputes}
          href={routes.finance.disputes} tone={openDisputes > 0 ? 'err' : undefined}
          urgent={openDisputes > 0}
        />
        <KpiTile
          label="GMV today" value={(dash?.kpis?.gmv_today_bc ?? 0).toLocaleString()}
          href={routes.finance.ledger} sub="BC across every product"
        />
      </KpiRow>

      {inReview > 0 && (
        <div style={{
          padding: '12px 16px', borderRadius: 10, marginBottom: 16,
          background: 'rgba(255,193,7,0.08)', border: '1px solid var(--warn)',
          fontSize: 12.5, color: 'var(--tx-1)',
        }}>
          <b>{inReview} escrow hold{inReview === 1 ? '' : 's'} waiting on an operator.</b>{' '}
          The proof-of-completion gate parked these. Nothing reaches the provider or returns to the
          client until each one is released or refunded —{' '}
          <Link href={routes.finance.escrow}>open Escrow &amp; Review Holds →</Link>
        </div>
      )}

      <LedgerTab />
    </>
  );
}
