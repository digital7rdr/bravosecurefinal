'use client';

/**
 * IA-14 / IA-16 — the Executive Protection landing.
 *
 * Executive details are booked ahead in fixed blocks, so the shift question is
 * calendar-shaped ("what starts in the next days, and is any of it unapproved
 * with the lead time running out?"), not queue-shaped. The lead-time rule is
 * read from the live pricing board rather than hardcoded, because it is
 * ops-editable (`exec_min_lead_hours`) and a stale copy here would flag the
 * wrong bookings.
 */

import Link from 'next/link';
import useSWR from 'swr';
import {opsDataApi, useBookings, useDashboard} from '@/lib/api';
import {PageHeader} from '@/components/PageHeader';
import {KpiRow, KpiTile, LandingGrid, WorkQueue, type QueueRow} from '@/components/SectionLanding';
import {EXECUTIVE_SERVICE, routes} from '@/lib/routes';
import {statusMeta} from '@/lib/status';
import {formatDateTimeShortUtc} from '@/lib/datetime';

const DAY_MS = 86_400_000;

export default function ExecutiveOverview() {
  const {data: dash} = useDashboard();
  const {data: bookings, isLoading, error} = useBookings({limit: 200, service: EXECUTIVE_SERVICE});
  const {data: pricing} = useSWR('exec-lead-hours', () => opsDataApi.servicePricing('GLOBAL'), {
    refreshInterval: 300_000,
  });

  const k = dash?.kpis?.executive;
  const all = bookings ?? [];
  const leadHours = Number(
    (pricing?.pricing ?? []).find(p => p.key === 'exec_min_lead_hours')?.value ?? 0,
  );

  const now = Date.now();

  // Approval queue, with the lead-time breach called out: an unapproved detail
  // whose start is inside the minimum lead window cannot be staffed normally.
  const approvals: QueueRow[] = all
    .filter(b => b.status === 'PENDING_OPS')
    .sort((a, b) => new Date(a.pickup_time).getTime() - new Date(b.pickup_time).getTime())
    .map(b => {
      const hoursOut = (new Date(b.pickup_time).getTime() - now) / 3_600_000;
      const breach = leadHours > 0 && hoursOut < leadHours;
      return {
        id: b.id,
        href: routes.executive.booking(b.id),
        primary: `${b.client_name ?? b.region_label} · ${(b.task_type ?? 'site_protection').replace(/_/g, ' ')}`,
        secondary: `${formatDateTimeShortUtc(b.pickup_time)} · ${b.duration_hours ?? '—'}h · ${b.cpo_count}× CPO · ${Number(b.total_eur).toLocaleString()} BC`,
        status: breach
          ? {label: `LEAD < ${leadHours}h`, tone: 'err' as const}
          : {label: statusMeta('booking', b.status).label, tone: statusMeta('booking', b.status).tone},
      };
    });

  // The next seven days of committed work — the thing an Executive operator
  // plans staffing against.
  const upcoming: QueueRow[] = all
    .filter(b => ['OPS_APPROVED', 'PAYMENT_PENDING', 'CONFIRMED', 'DISPATCHING'].includes(b.status))
    .filter(b => {
      const t = new Date(b.pickup_time).getTime();
      return t >= now && t < now + 7 * DAY_MS;
    })
    .sort((a, b) => new Date(a.pickup_time).getTime() - new Date(b.pickup_time).getTime())
    .map(b => ({
      id: b.id,
      href: routes.executive.booking(b.id),
      primary: `${formatDateTimeShortUtc(b.pickup_time)} · ${b.client_name ?? b.region_label}`,
      secondary: `${(b.task_type ?? 'site_protection').replace(/_/g, ' ')} · ${b.duration_hours ?? '—'}h · ${b.cpo_count}× CPO${(b.add_ons ?? []).length ? ` · +${(b.add_ons ?? []).length} add-on${(b.add_ons ?? []).length > 1 ? 's' : ''}` : ''}`,
      status: {label: statusMeta('booking', b.status).label, tone: statusMeta('booking', b.status).tone},
    }));

  return (
    <>
      <PageHeader
        title="Executive Protection"
        subtitle="Fixed-block on-site details, priced per unit. Progress is the CPO's hourly check-in record, and there is no dropoff — the team stays with the principal."
        badges={leadHours > 0
          ? <span className="pill pill-info">MIN LEAD {leadHours}h</span>
          : undefined}
        actions={<Link href={routes.executive.bookings} className="btn btn-sec">ALL DETAILS →</Link>}
      />

      <KpiRow columns={4}>
        <KpiTile
          label="Waiting on ops" value={k?.waiting ?? approvals.length}
          href={routes.executive.bookings} tone="warn" urgent={(k?.waiting ?? approvals.length) > 0}
        />
        <KpiTile
          label="Starting in 24h" value={k?.upcoming_24h ?? 0}
          href={routes.executive.bookings} tone="info" sub="approved or confirmed"
        />
        <KpiTile label="Live details" value={k?.live ?? 0} href={routes.executive.missions} tone="act" />
        <KpiTile
          label="GMV today" value={(k?.gmv_today_bc ?? 0).toLocaleString()}
          href={routes.finance.ledger} sub="BC"
        />
      </KpiRow>

      <LandingGrid columns={2}>
        <WorkQueue
          title="Approval queue"
          rows={approvals}
          loading={isLoading}
          error={Boolean(error)}
          empty="No executive details awaiting approval."
          footer={<Link href={routes.executive.bookings}>Open the full list →</Link>}
        />
        <WorkQueue
          title="Next 7 days"
          rows={upcoming}
          loading={isLoading}
          error={Boolean(error)}
          empty="Nothing committed in the next week."
          max={10}
          footer={<Link href={routes.executive.missions}>Open live details & check-ins →</Link>}
        />
      </LandingGrid>
    </>
  );
}
