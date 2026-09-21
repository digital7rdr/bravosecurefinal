'use client';

/**
 * IA-14 — the Enterprise landing.
 *
 * Enterprise surfaces were scattered across two groups: Messenger, Departments
 * and Attendance under "Comms & Org", Incident Reports under "Safety" next to
 * the SOS log. They are one business — Messenger Enterprise workspaces — and
 * this is its front door.
 */

import Link from 'next/link';
import {useEnterpriseSummary, useDeptIncidents} from '@/lib/api';
import {PageHeader} from '@/components/PageHeader';
import {KpiRow, KpiTile, LandingGrid, WorkQueue, type QueueRow} from '@/components/SectionLanding';
import {routes} from '@/lib/routes';
import {formatDateTimeShortUtc} from '@/lib/datetime';

export default function EnterpriseOverview() {
  const {data: summary, error} = useEnterpriseSummary();
  const {data: incidents, isLoading, error: incErr} = useDeptIncidents();

  const rows = incidents ?? [];
  const openCritical: QueueRow[] = rows
    .filter(i => i.severity === 'critical' || i.severity === 'high')
    .filter(i => i.status !== 'resolved' && i.status !== 'closed')
    .slice(0, 12)
    .map(i => ({
      id: i.id,
      href: routes.enterprise.incidents,
      primary: `${i.ref ?? i.id.slice(0, 8)} · ${i.category.replace(/_/g, ' ')}`,
      secondary: `${i.org_name ?? 'Workspace'} · ${formatDateTimeShortUtc(i.created_at)}`,
      status: {
        label: i.severity.toUpperCase(),
        tone: i.severity === 'critical' ? ('err' as const) : ('warn' as const),
      },
    }));

  return (
    <>
      <PageHeader
        title="Enterprise"
        subtitle="Messenger Enterprise workspaces: their department channel tree, attendance, incident reports and the people asking to join them."
        badges={error ? <span className="pill pill-err">SUMMARY UNAVAILABLE</span> : undefined}
        actions={<Link href={routes.enterprise.messenger} className="btn btn-sec">OPEN MESSENGER →</Link>}
      />

      <KpiRow columns={4}>
        <KpiTile label="Workspaces" value={summary?.workspaces ?? 0}
          href={routes.enterprise.departments} sub="enterprise-tier accounts" />
        <KpiTile label="Join requests" value={summary?.join_pending ?? 0}
          href={routes.enterprise.joinRequests} tone="warn" urgent={(summary?.join_pending ?? 0) > 0} />
        <KpiTile label="Incidents open" value={summary?.incidents_open ?? 0}
          href={routes.enterprise.incidents} tone="info" />
        <KpiTile label="Critical (24h)" value={summary?.incidents_critical_24h ?? 0}
          href={routes.enterprise.incidents} tone="err"
          urgent={(summary?.incidents_critical_24h ?? 0) > 0} />
      </KpiRow>

      <LandingGrid columns={2}>
        <WorkQueue
          title="High & critical incidents still open"
          rows={openCritical}
          loading={isLoading}
          error={Boolean(incErr)}
          empty="No high or critical incidents open."
          footer={<Link href={routes.enterprise.incidents}>Open all incident reports →</Link>}
        />
        <div className="card">
          <div className="card-header">
            <div className="card-header-title"><span className="bar" />Where each thing is worked</div>
          </div>
          <div style={{padding: '4px 0'}}>
            <NavRow href={routes.enterprise.departments} label="Departments"
              hint="The channel tree per workspace — levels, types and access." />
            <NavRow href={routes.enterprise.attendance} label="Attendance"
              hint="Per-department attendance summaries and CSV export." />
            <NavRow href={routes.enterprise.incidents} label="Incident Reports"
              hint="Reports submitted inside a workspace's department chat." />
            <NavRow href={routes.enterprise.joinRequests} label="Join Requests"
              hint="People asking to join a workspace. Read-only here — a workspace manager decides in their own app." />
            <NavRow href={routes.enterprise.messenger} label="Messenger"
              hint="The ops identity's own encrypted threads and mission rooms." />
          </div>
        </div>
      </LandingGrid>
    </>
  );
}

function NavRow({href, label, hint}: {href: string; label: string; hint: string}) {
  return (
    <Link href={href} className="q-row">
      <div style={{minWidth: 0}}>
        <div className="q-primary">{label}</div>
        <div className="q-secondary" style={{whiteSpace: 'normal'}}>{hint}</div>
      </div>
      <div className="q-right"><span style={{color: 'var(--tx-3)'}}>→</span></div>
    </Link>
  );
}
