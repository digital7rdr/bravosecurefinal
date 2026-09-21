'use client';

/**
 * IA-14 — the Lite section landing.
 *
 * Before the restructure an operator starting a shift had no per-business view:
 * they opened /bookings and read a mixed queue. This answers "what does Lite
 * need from me right now?" in one screen — the blocked work first, the engine's
 * health second, everything else a click away.
 */

import Link from 'next/link';
import useSWR from 'swr';
import {opsApi, useBookings, useDashboard} from '@/lib/api';
import {PageHeader} from '@/components/PageHeader';
import {KpiRow, KpiTile, LandingGrid, WorkQueue, type QueueRow} from '@/components/SectionLanding';
import {LITE_SERVICES, routes, bookingHref} from '@/lib/routes';
import {BOOKING_NEEDS_OPS, statusMeta} from '@/lib/status';
import {formatDateTimeShortUtc} from '@/lib/datetime';

export default function LiteOverview() {
  const {data: dash} = useDashboard();
  const {data: bookings, isLoading, error} = useBookings({
    limit: 200, service: LITE_SERVICES.join(','),
  });
  // Engine health rides the killswitch state (the same key the dispatch
  // monitor reads), not a second monitor poll.
  const {data: killswitch} = useSWR('dispatch-killswitch', () => opsApi.killswitchState(), {refreshInterval: 15_000});

  const k = dash?.kpis?.lite;
  const all = bookings ?? [];

  // "Needs a human" is the whole point of this page: pending approval plus the
  // two auto-dispatch stall outcomes, which no other surface surfaces together.
  const needsOps: QueueRow[] = all
    .filter(b => BOOKING_NEEDS_OPS.includes(b.status))
    .sort((a, b) => new Date(a.pickup_time).getTime() - new Date(b.pickup_time).getTime())
    .map(b => ({
      id: b.id,
      href: bookingHref(b),
      primary: `${b.client_name ?? b.region_label} · ${(b.pickup_address ?? '').split(',')[0]}`,
      secondary: `${b.id.slice(-12).toUpperCase()} · ${formatDateTimeShortUtc(b.pickup_time)} · ${Number(b.total_eur).toLocaleString()} BC`,
      status: {label: statusMeta('booking', b.status).label, tone: statusMeta('booking', b.status).tone},
    }));

  const dispatching: QueueRow[] = all
    .filter(b => b.status === 'DISPATCHING')
    .map(b => ({
      id: b.id,
      href: routes.lite.dispatchRequest(b.id),
      primary: `${b.client_name ?? b.region_label} · ${(b.pickup_address ?? '').split(',')[0]}`,
      secondary: `${b.id.slice(-12).toUpperCase()} · offers cascading · ${formatDateTimeShortUtc(b.pickup_time)}`,
      status: {label: 'Dispatching', tone: 'info'},
    }));

  const engineOn = killswitch?.enabled !== false;

  return (
    <>
      <PageHeader
        title="Lite · Secure Transfer"
        subtitle="On-demand transfers, recon and extraction. Booked per job, escrowed, then auto-dispatched to provider agencies or worked by hand from the job feed."
        badges={
          <span className={engineOn ? 'pill pill-ok' : 'pill pill-err'}>
            AUTO-DISPATCH {engineOn ? 'ARMED' : 'OFF'}
          </span>
        }
        actions={<Link href={routes.lite.bookings} className="btn btn-sec">ALL BOOKINGS →</Link>}
      />

      <KpiRow columns={5}>
        <KpiTile
          label="Waiting on ops" value={k?.waiting ?? needsOps.length}
          href={routes.lite.bookings} tone="warn" urgent={(k?.waiting ?? needsOps.length) > 0}
          sub="pending · no-provider · no-show"
        />
        <KpiTile label="Dispatching" value={k?.dispatching ?? dispatching.length}
          href={routes.lite.dispatchRequests} tone="info" sub="engine holds these" />
        <KpiTile label="Live missions" value={k?.live ?? 0} href={routes.lite.missions} tone="act" />
        <KpiTile label="Open jobs" value={dash?.kpis?.open_jobs ?? 0} href={routes.lite.jobs} tone="info"
          sub="manual lane" />
        <KpiTile label="GMV today" value={(k?.gmv_today_bc ?? 0).toLocaleString()}
          href={routes.finance.ledger} sub="BC" />
      </KpiRow>

      <LandingGrid columns={2}>
        <WorkQueue
          title="Needs a human"
          rows={needsOps}
          loading={isLoading}
          error={Boolean(error)}
          empty="Nothing blocked. Every Lite booking is moving on its own."
          footer={<Link href={routes.lite.bookings}>Open the full booking list →</Link>}
        />
        <WorkQueue
          title="Dispatching now"
          rows={dispatching}
          loading={isLoading}
          error={Boolean(error)}
          empty="The engine is not cascading any offers right now."
          footer={<Link href={routes.lite.dispatch}>Open the dispatch monitor →</Link>}
        />
      </LandingGrid>
    </>
  );
}
