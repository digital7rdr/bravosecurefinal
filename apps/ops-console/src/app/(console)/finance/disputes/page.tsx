'use client';
import {FinanceChrome, DisputesTab} from '@/features/finance/FinancePage';
import {useOpsMe} from '@/lib/api';
import {canResolveDispute} from '@/lib/rbac';

export default function Page() {
  const {data: me} = useOpsMe();
  return (
    <>
      <FinanceChrome title="Disputes" subtitle="Escrow holds a client or provider has contested. Resolving one splits the hold and closes the case." />
      <DisputesTab canResolve={canResolveDispute(me?.admin.role)} />
    </>
  );
}
