'use client';
import {FinanceChrome, EscrowTab} from '@/features/finance/FinancePage';

export default function Page() {
  return (
    <>
      <FinanceChrome title="Escrow & Review Holds" subtitle="Money held between a booking being paid and a mission being proven complete. Holds parked by the completion gate need an operator to release or refund them." />
      <EscrowTab  />
    </>
  );
}
