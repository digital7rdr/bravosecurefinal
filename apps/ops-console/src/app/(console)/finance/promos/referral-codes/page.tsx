'use client';

import {FinanceChrome} from '@/features/finance/FinancePage';
import {RouteTabs} from '@/components/RouteTabs';
import {routes} from '@/lib/routes';
import {ReferralCodes} from '@/features/finance/ReferralCodesPage';

export default function Page() {
  return (
    <>
      <FinanceChrome
        title="Promos & Referrals"
        subtitle="Promo codes put credits in a wallet, referral campaigns take a discount off a booking, partner codes record who referred it."
      />
      <RouteTabs
        ariaLabel="Promos sections"
        tabs={[
          {href: routes.finance.promos, label: 'Promo codes'},
          {href: routes.finance.referralCampaigns, label: 'Referral campaigns'},
          {href: routes.finance.referralCodes, label: 'Partner codes'},
        ]}
      />
      <ReferralCodes />
    </>
  );
}
