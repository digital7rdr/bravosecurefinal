'use client';

/** My bookings (Bravo Web App): open ones first, then the rest, newest first. */
import Link from 'next/link';
import {useMemo, useState} from 'react';
import {ClientsOnly, useWeb} from '@/components/web/WebShell';
import {Empty, PvCard, PvPage} from '@/components/provider/ui';
import {useBookings} from '@/lib/web/api';
import {STAGE, serviceName, stageOf, whenLong} from '@/lib/web/labels';
import {StagePill} from '@/components/web/StagePill';
import {credits} from '@/lib/provider/labels';
import {webRoutes} from '@/lib/web/routes';

export default function WebBookings() {
  const {client} = useWeb();
  const {data, error} = useBookings(client);
  const [tab, setTab] = useState<'open' | 'past'>('open');
  const rows = useMemo(() => {
    const all = [...(data?.bookings ?? [])].sort((a, b) => b.start_time.localeCompare(a.start_time));
    return all.filter(b => STAGE[stageOf(b)].open === (tab === 'open'));
  }, [data, tab]);

  if (!client) return <PvPage title="Bookings"><ClientsOnly/></PvPage>;

  return (
    <PvPage title="My bookings" subtitle="Follow, pay for and manage your bookings. They are the same as in the app."
      right={<Link className="btn btn-pri" href={webRoutes.book}>New booking</Link>}>
      <PvCard pad={false}>
        <div className="pv-toolbar">
          <div className="pv-seg">
            <button className={tab === 'open' ? 'on' : ''} onClick={() => setTab('open')}>Current</button>
            <button className={tab === 'past' ? 'on' : ''} onClick={() => setTab('past')}>Past</button>
          </div>
        </div>
        {error ? <Empty>Could not load your bookings. It will retry automatically.</Empty>
          : !data ? <Empty>Loading…</Empty>
          : rows.length === 0 ? <Empty>{tab === 'open' ? 'No current bookings.' : 'No past bookings yet.'}</Empty>
          : (
            <ul className="pv-list">
              {rows.map(b => (
                <li key={b.id}>
                  <Link href={webRoutes.booking(b.id)} className="pv-list-row web-booking-row">
                    <span className="pv-list-main">
                      <span className="pv-strong">{serviceName(b.service)}</span>
                      <span className="pv-list-sub">{whenLong(b.start_time)} · {b.pickup?.address ?? b.region_label}</span>
                    </span>
                    <StagePill b={b}/>
                    <span className="pv-num pv-strong">{credits(b.total_eur)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
      </PvCard>
    </PvPage>
  );
}
