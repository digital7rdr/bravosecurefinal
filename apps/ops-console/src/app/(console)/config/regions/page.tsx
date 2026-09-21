'use client';
import {PageHeader} from '@/components/PageHeader';
import {ConfigTabs} from '@/features/config/ConfigTabs';
import {RegionsCard} from '@/features/config/RegionsCard';

export default function Page() {
  return (
    <>
      <PageHeader title="Regions" subtitle="Where the product operates. The bounding box is not decoration: a booking's pricing region is derived from its pickup coordinates, so a region with no box never resolves and prices at global." />
      <ConfigTabs />
      <RegionsCard />
    </>
  );
}

