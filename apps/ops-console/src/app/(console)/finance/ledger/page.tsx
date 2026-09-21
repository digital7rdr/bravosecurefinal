'use client';
import {FinanceChrome, LedgerTab} from '@/features/finance/FinancePage';

export default function Page() {
  return (
    <>
      <FinanceChrome title="Wallet Ledger" subtitle="Every Bravo Credit movement: top-ups, payments, refunds, payouts, expiries and each escrow leg. Read straight from the money tables." />
      <LedgerTab  />
    </>
  );
}
