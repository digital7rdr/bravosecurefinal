'use client';

/**
 * One booking (Bravo Web App): stage, live map, team, the arrival codes, and
 * the client's actions — pay with credits (HQ-approved flow), cancel, confirm
 * completion and rate. Every action uses the app's own route and key.
 */
import Link from 'next/link';
import {useParams} from 'next/navigation';
import {useMemo, useState} from 'react';
import useSWR, {useSWRConfig} from 'swr';
import {ClientsOnly, useWeb} from '@/components/web/WebShell';
import {StagePill} from '@/components/web/StagePill';
import {ConfirmDialog, Empty, PvCard, PvPage} from '@/components/provider/ui';
import {BravoMap, type BravoMarker} from '@/components/BravoMapLazy';
import {useToast} from '@/components/Toast';
import {useBalance, useBooking, webApi} from '@/lib/web/api';
import {STAGE, TASKS, canCancel, needsPayment, serviceName, stageOf, webErrorText, whenLong} from '@/lib/web/labels';
import {credits} from '@/lib/provider/labels';
import {webRoutes} from '@/lib/web/routes';

const CREWED_OR_LATER = new Set(['team_assigned', 'team_dispatched', 'team_arrived', 'service_started', 'sos']);
const MOVING = new Set(['team_dispatched', 'team_arrived', 'service_started', 'sos']);

export default function WebBooking() {
  const {id} = useParams<{id: string}>();
  const {client} = useWeb();
  const {data: b, error} = useBooking(client ? id : null);
  const {data: balance} = useBalance(client);
  const {mutate} = useSWRConfig();
  const {push} = useToast();
  const [confirm, setConfirm] = useState<'pay' | 'cancel' | 'complete' | null>(null);
  const [stars, setStars] = useState(0);

  const stage = b ? stageOf(b) : null;
  const crewed = stage ? CREWED_OR_LATER.has(stage) : false;
  const moving = stage ? MOVING.has(stage) : false;
  const {data: team} = useSWR(b && crewed ? ['web', 'team', id] : null, () => webApi.team(id), {refreshInterval: 30_000});
  const {data: provider} = useSWR(b && b.dispatch_mode === 'auto' && stage && stage !== 'finding_provider' && STAGE[stage].open
    ? ['web', 'provider', id] : null, () => webApi.provider(id), {shouldRetryOnError: false});
  const {data: codes} = useSWR(b && crewed ? ['web', 'codes', id] : null, () => webApi.verifyCode(id),
    {refreshInterval: 30_000, shouldRetryOnError: false});
  const {data: fix} = useSWR(b && moving ? ['web', 'fix', id] : null, () => webApi.latestFix(id),
    {refreshInterval: 5_000, shouldRetryOnError: false});

  const markers = useMemo(() => {
    const out: BravoMarker[] = [];
    if (b?.pickup) out.push({id: 'pickup', lat: b.pickup.latitude, lng: b.pickup.longitude, type: 'pickup', label: 'Pick-up'});
    if (b?.dropoff) out.push({id: 'dropoff', lat: b.dropoff.latitude, lng: b.dropoff.longitude, type: 'dropoff', label: 'Drop-off'});
    if (fix?.latest) out.push({id: 'team', lat: fix.latest.lat, lng: fix.latest.lng, type: 'lead', label: 'Your team'});
    return out;
  }, [b, fix]);

  if (!client) return <PvPage title="Booking"><ClientsOnly/></PvPage>;
  if (error) {
    return <PvPage title="Booking" subtitle={<Link href={webRoutes.bookings}>← My bookings</Link>}>
      <PvCard><Empty>This booking could not be loaded.</Empty></PvCard>
    </PvPage>;
  }
  if (!b || !stage) return <PvPage title="Booking"><PvCard><Empty>Loading…</Empty></PvCard></PvPage>;

  const refresh = () => mutate((k: unknown) => Array.isArray(k) && k[0] === 'web');
  const pay = needsPayment(b);
  const short = pay && balance ? balance.bravo_credits < b.total_eur : false;
  const center = markers.find(m => m.id === 'team') ?? markers[0];
  const task = b.task_type ? TASKS.find(t => t.id === b.task_type)?.label : null;

  async function run(kind: 'pay' | 'cancel' | 'complete') {
    try {
      if (kind === 'pay') { await webApi.payWithCredits(id); push({kind: 'ok', text: 'Paid with your credits. Your booking is confirmed.'}); }
      if (kind === 'cancel') {
        const r = await webApi.cancel(id);
        push({kind: 'ok', text: r.refunded_credits ? `Booking cancelled. ${credits(r.refunded_credits)} returned to your credits.` : 'Booking cancelled.'});
      }
      if (kind === 'complete') { await webApi.confirmComplete(id); push({kind: 'ok', text: 'Thank you. The service is marked complete.'}); }
    } catch (e) {
      push({kind: 'err', text: webErrorText(e)});
    }
    setConfirm(null);
    void refresh();
  }

  async function rate(n: number) {
    setStars(n);
    try { await webApi.rate(id, n); push({kind: 'ok', text: 'Thanks for rating your provider.'}); }
    catch (e) { push({kind: 'err', text: webErrorText(e)}); }
  }

  return (
    <PvPage title={serviceName(b.service)}
      subtitle={<Link href={webRoutes.bookings}>← My bookings</Link>}
      right={<>
        <StagePill b={b}/>
        {pay && <button className="btn btn-pri" disabled={short} onClick={() => setConfirm('pay')}>Pay {credits(b.total_eur)}</button>}
        {stage === 'service_started' && <button className="btn btn-sec" onClick={() => setConfirm('complete')}>Service finished</button>}
        {canCancel(b) && <button className="btn btn-ghost" onClick={() => setConfirm('cancel')}>Cancel booking</button>}
      </>}>
      <div className="pv-banner web-stage" role="status"><span>{STAGE[stage].headline}</span></div>
      {short && <p className="pv-err">Your credits ({credits(balance?.bravo_credits)}) do not cover this booking. Top up in the Bravo Secure app, then pay here.</p>}
      {stage === 'no_provider' && b.no_provider_fallback && (
        <p className="pv-note">No provider could take this job. Call the Bravo Secure hotline on {b.no_provider_fallback.hotline_e164} for help, or book again.</p>
      )}

      <div className="pv-grid pv-grid-wide">
        <PvCard title={moving ? 'Live position' : 'Map'} right={moving ? <span className="pv-hint">Updates every 5 seconds</span> : undefined} pad={false}>
          <div className="pv-map pv-map-tall">
            <BravoMap markers={markers} center={center ? [center.lng, center.lat] : undefined} zoom={center ? 13 : 11}/>
          </div>
          <div className="pv-legend">
            <span><i style={{background: '#00C853'}}/>Pick-up</span>
            {b.dropoff && <span><i style={{background: '#FFC107'}}/>Drop-off</span>}
            {moving && <span><i style={{background: '#1E88FF'}}/>Your team</span>}
          </div>
        </PvCard>

        <div className="pv-col">
          <PvCard title="Booking">
            <dl className="pv-facts pv-facts-col">
              <div><dt>Start</dt><dd>{whenLong(b.start_time)}</dd></div>
              <div><dt>Duration</dt><dd>{b.duration_hours} hour{b.duration_hours === 1 ? '' : 's'}</dd></div>
              {task && <div><dt>Detail</dt><dd>{task}</dd></div>}
              <div><dt>Pick-up</dt><dd>{b.pickup?.address ?? '—'}</dd></div>
              {b.dropoff && <div><dt>Drop-off</dt><dd>{b.dropoff.address ?? '—'}</dd></div>}
              <div><dt>Team</dt><dd>{b.cpo_count} officer{b.cpo_count === 1 ? '' : 's'}{b.vehicle_count ? ` · ${b.vehicle_count} vehicle${b.vehicle_count === 1 ? '' : 's'}` : ''}</dd></div>
              <div><dt>Price</dt><dd className="pv-strong">{credits(b.total_eur)}</dd></div>
              <div><dt>Reference</dt><dd className="pv-mono">{b.id.slice(0, 8).toUpperCase()}</dd></div>
            </dl>
          </PvCard>

          {provider && (
            <PvCard title="Your provider">
              <dl className="pv-facts pv-facts-col">
                <div><dt>Agency</dt><dd>{provider.display_name ?? provider.call_sign ?? '—'}</dd></div>
                <div><dt>Rating</dt><dd>{provider.rating ? `${provider.rating.toFixed(1)} ★` : 'New'} · {provider.jobs_total} jobs</dd></div>
              </dl>
            </PvCard>
          )}

          {crewed && (
            <PvCard title="Your team" pad={false}>
              {!team ? <Empty>Loading…</Empty> : team.cpos.length === 0 ? <Empty>The team is being confirmed.</Empty> : (
                <ul className="pv-list">
                  {team.cpos.map(c => (
                    <li key={c.call_sign} className="pv-list-row">
                      <span className="pv-mono">{c.call_sign}</span>
                      <span className="pv-list-main"><span>{c.display_name}</span><span className="pv-list-sub">{c.role}{c.company ? ` · ${c.company}` : ''}</span></span>
                      {c.verified && <span className="pill pill-ok">Verified</span>}
                    </li>
                  ))}
                  {team.vehicle && (
                    <li className="pv-list-row">
                      <span className="pv-mono">{team.vehicle.plate}</span>
                      <span className="pv-list-main"><span>{team.vehicle.make_model}</span><span className="pv-list-sub">{team.vehicle.armored ? 'Armoured' : 'Vehicle'}</span></span>
                    </li>
                  )}
                </ul>
              )}
            </PvCard>
          )}

          {codes && STAGE[stage].open && (
            <PvCard title="Meeting your team safely">
              <p className="pv-hint" style={{marginTop: 0}}>
                When the lead officer arrives, ask for their code and check it matches. Then show them your code.
                If anything does not match, do not go with them and use SOS in the app.
              </p>
              <dl className="pv-facts pv-facts-col">
                <div><dt>Lead officer</dt><dd>{codes.lead.display_name ?? '—'} {codes.lead.call_sign ? `(${codes.lead.call_sign})` : ''}</dd></div>
                <div><dt>Their code</dt><dd className="pv-mono web-code">{codes.code}</dd></div>
                <div><dt>Your code</dt><dd className="pv-mono web-code">{codes.arrival_code}</dd></div>
              </dl>
            </PvCard>
          )}

          {stage === 'completed' && (
            <PvCard title="Rate your provider">
              <div className="web-stars" role="radiogroup" aria-label="Rating">
                {[1, 2, 3, 4, 5].map(n => (
                  <button key={n} type="button" aria-label={`${n} star${n === 1 ? '' : 's'}`}
                    className={n <= stars ? 'on' : ''} onClick={() => void rate(n)}>★</button>
                ))}
              </div>
            </PvCard>
          )}
        </div>
      </div>

      <ConfirmDialog open={confirm === 'pay'} title={`Pay ${credits(b.total_eur)}?`}
        description="The amount is taken from your Bravo credits and the booking is confirmed."
        confirmLabel="Pay with credits" onClose={() => setConfirm(null)} onConfirm={() => run('pay')}/>
      <ConfirmDialog open={confirm === 'cancel'} title="Cancel this booking?" danger
        description="Credits already taken are returned to your wallet as the cancellation rules allow."
        confirmLabel="Cancel booking" onClose={() => setConfirm(null)} onConfirm={() => run('cancel')}/>
      <ConfirmDialog open={confirm === 'complete'} title="Is the service finished?"
        description="Confirm only once you are safely at your destination. This releases the payment to the provider."
        confirmLabel="Yes, it is finished" onClose={() => setConfirm(null)} onConfirm={() => run('complete')}/>
    </PvPage>
  );
}
