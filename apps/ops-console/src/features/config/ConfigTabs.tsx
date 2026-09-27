'use client';

/** The App Configuration tab bar. Lives here, not in a page.tsx: a Next.js
 *  page module may only export `default` plus its reserved route fields. */

import {RouteTabs} from '@/components/RouteTabs';
import {routes} from '@/lib/routes';
import {useOpsMe} from '@/lib/api';
import {canManageIntegrations, canManageModules} from '@/lib/rbac';

export function ConfigTabs() {
  const {data: me} = useOpsMe();
  // Integrations carries live payment/SMS keys — only rank-3 admins see the tab
  // (the backend refuses everyone else with 403 regardless).
  const showIntegrations = canManageIntegrations(me?.admin.role);
  const showModules = canManageModules(me?.admin.role);
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
        ...(showModules ? [{href: routes.config.modules, label: 'Module Access'}] : []),
        ...(showIntegrations ? [{href: routes.config.integrations, label: 'Integrations'}] : []),
      ]}
    />
  );
}
