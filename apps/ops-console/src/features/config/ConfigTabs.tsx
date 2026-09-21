'use client';

/** The App Configuration tab bar. Lives here, not in a page.tsx: a Next.js
 *  page module may only export `default` plus its reserved route fields. */

import {RouteTabs} from '@/components/RouteTabs';
import {routes} from '@/lib/routes';

export function ConfigTabs() {
  return (
    <RouteTabs
      ariaLabel="App configuration sections"
      tabs={[
        {href: routes.config.root, label: 'Status'},
        {href: routes.config.pricing, label: 'Pricing Board'},
        {href: routes.config.regions, label: 'Regions'},
        {href: routes.config.packages, label: 'Packages'},
        {href: routes.config.tierGrants, label: 'Tier Grants'},
        {href: routes.config.switches, label: 'Switches'},
      ]}
    />
  );
}
