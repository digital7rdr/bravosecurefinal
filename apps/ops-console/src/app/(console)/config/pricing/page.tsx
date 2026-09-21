'use client';
import {PageHeader} from '@/components/PageHeader';
import {ConfigTabs} from '@/features/config/ConfigTabs';
import {ServicePricingCard} from '@/features/config/ServicePricingCard';

export default function Page() {
  return (
    <>
      <PageHeader title="Pricing Board" subtitle="The numbers the booking price engine charges, per region. Read at charge time: an edit prices the next quote and leaves existing bookings on the totals they were charged." />
      <ConfigTabs />
      <ServicePricingCard />
    </>
  );
}

