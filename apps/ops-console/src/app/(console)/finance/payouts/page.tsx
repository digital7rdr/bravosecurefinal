'use client';
import {FinanceChrome, PayoutsTab} from '@/features/finance/FinancePage';

export default function Page() {
  return (
    <>
      <FinanceChrome title="Payouts" subtitle="What each CPO was proposed and what they were actually paid, with the deduction and its reason." />
      <PayoutsTab  />
    </>
  );
}
