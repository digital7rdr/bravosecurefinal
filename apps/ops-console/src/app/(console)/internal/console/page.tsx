'use client';

/**
 * IA-07/IA-09 — the console's own facts, filed under Internal.
 *
 * This card used to be the FIRST thing on a page called "Console Settings",
 * above four editors that reprice the platform — so the page's name described
 * its least important content and hid its most dangerous. The read-only facts
 * belong with the house-keeping; the editors moved to App Configuration.
 */

import {useOpsMe} from '@/lib/api';
import useSWR from 'swr';
import {PageHeader} from '@/components/PageHeader';
import {RouteTabs} from '@/components/RouteTabs';
import {routes} from '@/lib/routes';

export default function ConsoleInfoPage() {
  const {data: me} = useOpsMe();
  const admin = me?.admin;

  // The health route the Docker HEALTHCHECK hits (OC-05). Showing it here means
  // an operator can confirm the container is being probed successfully without
  // shell access.
  const {data: health, error: healthErr} = useSWR(
    'api-health',
    () => fetch('/api/health', {cache: 'no-store'}).then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))),
    {refreshInterval: 60_000, shouldRetryOnError: false},
  );

  const fields: Array<[string, string]> = [
    ['Your call sign', admin?.call_sign ?? '—'],
    ['Your role', admin?.role ?? '—'],
    ['Your region', admin?.region ?? '—'],
    ['Session timeout', '15 minutes of inactivity — deferred while an SOS is unresolved'],
    ['Access token', 'Rotates silently every 15 minutes via /auth/session/refresh'],
    ['Two-factor', 'Enforced via OTP at login'],
    ['CSRF protection', 'Double-submit cookie plus an X-CSRF-Token header'],
    ['Idempotency', '24h replay protection on approve, dispatch, complete, ack, decide, terminate and the review-hold exit'],
    ['Health endpoint', healthErr ? '/api/health — not responding' : health ? '/api/health — OK' : '/api/health — checking…'],
  ];

  return (
    <>
      <PageHeader
        title="Console"
        subtitle="What this console is and how your session is protected. Every value here is enforced server-side — there is no client-side toggle for any of them."
      />

      <RouteTabs
        ariaLabel="Internal sections"
        tabs={[
          {href: routes.internal.admins, label: 'Admins'},
          {href: routes.internal.audit, label: 'Audit Log'},
          {href: routes.internal.console, label: 'Console'},
        ]}
      />

      <div className="card" style={{padding: 6}}>
        {fields.map(([label, value]) => (
          <div key={label} style={{
            display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16,
            padding: '12px 14px', borderBottom: '1px solid var(--bd-2)', alignItems: 'center',
          }}>
            <div className="exec-cap">{label}</div>
            <div style={{fontSize: 12.5, color: 'var(--tx-1)'}}>{value}</div>
          </div>
        ))}
      </div>

      <div className="card" style={{marginTop: 16, padding: '14px 16px'}}>
        <div className="cfg-meta" style={{lineHeight: 1.7}}>
          LOOKING FOR PRICING, REGIONS, PACKAGES OR TIER GRANTS? They moved to App Configuration,
          where each one shows what the mobile apps read and how long a change takes to reach a
          device.
        </div>
      </div>
    </>
  );
}
