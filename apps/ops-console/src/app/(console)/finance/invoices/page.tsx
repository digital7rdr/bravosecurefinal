'use client';
import {FinanceChrome, InvoicesTab} from '@/features/finance/FinancePage';

export default function Page() {
  return (
    <>
      <FinanceChrome title="Invoices" subtitle="Issued invoices and their PDFs." />
      <InvoicesTab  />
    </>
  );
}
