'use client';
import {PageHeader} from '@/components/PageHeader';
import {ConfigTabs} from '@/features/config/ConfigTabs';
import {ModuleAccessCard} from '@/features/config/ModuleAccessCard';

export default function Page() {
  return (
    <>
      <PageHeader
        title="Module Access"
        subtitle="Which product modules each account group can use. Switching a module off blocks starting new use of it on the server immediately; it never cuts off SOS, safety check-ins or a session already in progress. Per-user exceptions live on each user's page." />
      <ConfigTabs />
      <ModuleAccessCard />
    </>
  );
}
