'use client';
import {PageHeader} from '@/components/PageHeader';
import {ConfigTabs} from '@/features/config/ConfigTabs';
import {IntegrationsCard} from '@/features/config/IntegrationsCard';

export default function Page() {
  return (
    <>
      <PageHeader
        title="Integrations"
        subtitle="Third-party keys the servers use — Stripe, Twilio, Mapbox, biometric. A value saved here overrides the deployment environment within about 15 seconds, with no redeploy. Secrets are encrypted at rest and can be replaced but never read back." />
      <ConfigTabs />
      <IntegrationsCard />
    </>
  );
}
