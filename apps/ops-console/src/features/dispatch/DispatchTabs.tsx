'use client';

/**
 * IA-04 — the monitor, the request inspector and the test harness are ONE
 * surface with three views; they used to be two separate rail items in a group
 * of their own. Lives outside page.tsx because a Next.js page module may only
 * export `default` plus its reserved route fields — exporting a component from
 * one fails the production type check.
 */

import {RouteTabs} from '@/components/RouteTabs';
import {routes} from '@/lib/routes';

export function DispatchTabs() {
  return (
    <RouteTabs
      ariaLabel="Auto-dispatch views"
      tabs={[
        {href: routes.lite.dispatch, label: 'Monitor'},
        {href: routes.lite.dispatchRequests, label: 'Requests', prefix: true},
        {href: routes.lite.dispatchTest, label: 'Test harness'},
      ]}
    />
  );
}
