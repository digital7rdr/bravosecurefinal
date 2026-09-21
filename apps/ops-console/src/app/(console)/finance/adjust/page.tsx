'use client';
import {FinanceChrome, AdjustTab} from '@/features/finance/FinancePage';
import {useOpsMe} from '@/lib/api';
import {canAdjustWallet} from '@/lib/rbac';

export default function Page() {
  const {data: me} = useOpsMe();
  return (
    <>
      <FinanceChrome title="Wallet Adjustments" subtitle="Manual credit grants and deductions. Every adjustment needs a reason and lands in both the wallet ledger and the audit trail." />
      <AdjustTab canAdjust={canAdjustWallet(me?.admin.role)} />
    </>
  );
}
