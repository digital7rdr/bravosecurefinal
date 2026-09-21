'use client';

/**
 * IA-14 — the Secure Pro landing: the plan funnel end to end.
 *
 * Secure Pro was three rail items in two different groups (Pro Applications and
 * Pro Management under "Operations", Protection under "Safety"), so nobody
 * could see the pipeline: application → proposal → active plan → protection
 * dates → live session. This is that pipeline on one screen.
 */

import Link from 'next/link';
import {
  useProApplications, useProMissionRequests, useProtectionSessions, useDashboard,
} from '@/lib/api';
import {PageHeader} from '@/components/PageHeader';
import {KpiRow, KpiTile, LandingGrid, WorkQueue, type QueueRow} from '@/components/SectionLanding';
import {routes} from '@/lib/routes';
import {statusMeta} from '@/lib/status';
import {formatDateUtc} from '@/lib/datetime';

const SOON_DAYS = 14;

export default function ProOverview() {
  const {data: dash} = useDashboard();
  const {data: pending, isLoading: loadingApps, error: appsError} = useProApplications('PENDING_PROPOSAL');
  const {data: revision} = useProApplications('REVISION_REQUESTED');
  const {data: sent} = useProApplications('PROPOSAL_CREATED');
  const {data: active} = useProApplications('ACTIVE');
  const {data: reqs, isLoading: loadingReqs, error: reqsError} = useProMissionRequests();
  const {data: sessions} = useProtectionSessions('live');

  const apps = [...(pending?.applications ?? []), ...(revision?.applications ?? [])];
  const proposalsOut = sent?.applications ?? [];
  const activePlans = active?.applications ?? [];
  const unassigned = (reqs?.requests ?? []).filter(r => r.status === 'REQUESTED');
  const liveSessions = sessions?.sessions ?? [];

  // A plan inside its last two weeks is the renewal conversation nobody owns
  // unless the console shows it. The list row carries the start date and the
  // duration, not an end date, so derive it — and skip the open-ended plans
  // (duration_months null = a custom term negotiated in the proposal).
  const soonMs = Date.now() + SOON_DAYS * 86_400_000;
  const endingSoon = activePlans.filter(a => {
    if (!a.duration_months) return false;
    const start = new Date(a.start_date);
    const end = new Date(start.getFullYear(), start.getMonth() + a.duration_months, start.getDate());
    return end.getTime() < soonMs;
  });

  const appQueue: QueueRow[] = apps.map(a => ({
    id: a.id,
    href: routes.pro.application(a.id),
    primary: a.client_name ?? a.client_email,
    secondary: `${a.coverage_area || '—'} · ${a.cpo_count}× CPO · submitted ${formatDateUtc(a.submitted_at)}`,
    status: {
      label: statusMeta('proApplication', a.status).label,
      tone: statusMeta('proApplication', a.status).tone,
    },
  }));

  const requestQueue: QueueRow[] = unassigned.map(r => ({
    id: r.id,
    href: routes.pro.assignments,
    primary: `${r.member_name ?? r.requested_by_name ?? 'Plan holder'} · ${r.mission_dates.length} date${r.mission_dates.length === 1 ? '' : 's'}`,
    secondary: `${r.mission_dates.map(d => formatDateUtc(d)).slice(0, 3).join(', ')}${r.mission_dates.length > 3 ? ` +${r.mission_dates.length - 3} more` : ''}`,
    status: {label: 'Needs officers', tone: 'warn'},
  }));

  return (
    <>
      <PageHeader
        title="Secure Pro"
        subtitle="Three-month protection plans: the client applies, ops proposes, the client accepts and pays, ops assigns a dedicated officer, and the plan holder then requests protection on demand. Pro missions carry no per-job payout."
        actions={<Link href={routes.pro.applications} className="btn btn-sec">ALL APPLICATIONS →</Link>}
      />

      <KpiRow columns={5}>
        <KpiTile
          label="Applications" value={dash?.kpis?.pro_pending ?? apps.length}
          href={routes.pro.applications} tone="warn" urgent={apps.length > 0}
          sub="new or revision requested"
        />
        <KpiTile
          label="Proposals out" value={proposalsOut.length}
          href={routes.pro.applications} tone="info" sub="waiting on the client"
        />
        <KpiTile
          label="Active plans" value={activePlans.length}
          href={routes.pro.applications} tone="ok"
          sub={endingSoon.length > 0 ? `${endingSoon.length} ending within ${SOON_DAYS}d` : undefined}
        />
        <KpiTile
          label="Dates unassigned" value={dash?.kpis?.pro_requests ?? unassigned.length}
          href={routes.pro.assignments} tone="warn" urgent={unassigned.length > 0}
        />
        <KpiTile
          label="Sessions live" value={liveSessions.length}
          href={routes.pro.protection} tone="act"
        />
      </KpiRow>

      <LandingGrid columns={2}>
        <WorkQueue
          title="Applications waiting on ops"
          rows={appQueue}
          loading={loadingApps}
          error={Boolean(appsError)}
          empty="No applications waiting for a proposal."
          footer={<Link href={routes.pro.applications}>Open the applications list →</Link>}
        />
        <WorkQueue
          title="Protection dates needing officers"
          rows={requestQueue}
          loading={loadingReqs}
          error={Boolean(reqsError)}
          empty="Every requested date has officers assigned."
          footer={<Link href={routes.pro.pool}>Open the CPO pool →</Link>}
        />
      </LandingGrid>
    </>
  );
}
