'use client';

/**
 * IA-07 — package copy and messenger subscription prices on one page, in two
 * clearly separated blocks. They were adjacent cards on "Console Settings" with
 * nothing saying which one the apps charge from.
 */

import {PageHeader} from '@/components/PageHeader';
import {ConfigTabs} from '@/features/config/ConfigTabs';
import {PackageCatalogCard} from '@/features/config/PackageCatalogCard';
import {SubscriptionPricingCard} from '@/features/config/SubscriptionPricingCard';

export default function Page() {
  return (
    <>
      <PageHeader
        title="Packages & Catalog"
        subtitle="The plan cards customers see, and what the messenger tiers cost. Card copy is display only; the subscription price below is the number actually charged at subscribe and at every renewal."
      />
      <ConfigTabs />
      <PackageCatalogCard />
      <SubscriptionPricingCard />
      <div className="card" style={{marginTop: 16, padding: '14px 16px'}}>
        <div className="cfg-meta" style={{lineHeight: 1.7}}>
          SECURE PRO PLANS ARE NOT PRICED HERE. A Secure Pro plan is quoted per application in the
          proposal an operator writes — see Secure Pro · Applications. The prices above are the
          MESSENGER subscription tiers only.
        </div>
      </div>
    </>
  );
}
