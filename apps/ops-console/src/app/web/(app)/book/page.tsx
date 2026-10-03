'use client';

/**
 * Book (Bravo Web App): Lite secure transfer or Executive protection, paid with
 * the Bravo credits already in the wallet. Same server contract as the app's
 * booking wizard (store/bookingStore.ts):
 *
 *   estimate → create → (HQ-approved flow) pay with credits once approved
 *
 * With auto dispatch on (GET /auth/me), the booking goes to POST
 * /dispatch/request, which finds a provider at once and holds the credits when
 * one accepts; it needs the location and terms consent. Otherwise POST
 * /bookings files it for HQ approval. Either way ONE Idempotency-Key per
 * submitted body, reused on retry, so a double click never books twice.
 */

import Link from 'next/link';
import {useRouter, useSearchParams} from 'next/navigation';
import {Suspense, useEffect, useMemo, useRef, useState} from 'react';
import useSWR from 'swr';
import {ClientsOnly, useWeb} from '@/components/web/WebShell';
import {PlacePicker} from '@/components/web/PlacePicker';
import {Empty, PvCard, PvPage} from '@/components/provider/ui';
import {
  actionKey, useBalance, webApi, type CreateBody, type EstimateBody, type Place,
} from '@/lib/web/api';
import {EXEC_ADD_ONS, EXEC_HOURS, TASKS, webErrorText} from '@/lib/web/labels';
import {credits} from '@/lib/provider/labels';
import {webRoutes} from '@/lib/web/routes';

/** Versions of the consent text below; the server records them (Step 22). */
const LOCATION_CONSENT_VERSION = '2026-06-22';
const TERMS_VERSION = '2026-06-22';
const LEAD_HOURS = 3;

/** Where the map starts for an area (a convenience; the server decides the area from the pin). */
const AREA_CENTER: Record<string, [number, number]> = {
  AE: [55.2708, 25.2048], SA: [46.6753, 24.7136], BD: [90.4125, 23.8103],
  GB: [-0.1276, 51.5072], ZA: [28.0473, -26.2041],
};

type Product = 'lite' | 'executive';
type TransportMode = 'none' | 'one_way' | 'return' | 'both_ways';

/** "2026-10-03T18:30" for an <input type="datetime-local"> in local time. */
function localInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function earliest(): Date {
  const d = new Date(Date.now() + (LEAD_HOURS * 60 + 10) * 60_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  return d;
}

export default function BookPage() {
  return <Suspense fallback={null}><Book/></Suspense>;
}

function Book() {
  const {me, client} = useWeb();
  const router = useRouter();
  const params = useSearchParams();
  const [product, setProduct] = useState<Product>(params.get('product') === 'executive' ? 'executive' : 'lite');
  const exec = product === 'executive';
  const auto = me.auto_dispatch_enabled === true;

  const {data: regions} = useSWR(client ? ['web', 'regions'] : null, webApi.regions);
  const {data: identity} = useSWR(client ? ['web', 'identity'] : null, webApi.identity);
  const {data: balance} = useBalance(client);
  const [region, setRegion] = useState('');
  useEffect(() => {
    if (region || !regions?.length) return;
    setRegion((regions.find(r => r.available) ?? regions[0]).code);
  }, [regions, region]);
  const {data: addOnCatalog} = useSWR(client && region ? ['web', 'addons', region] : null, () => webApi.addOns(region));

  const [pickup, setPickup] = useState<Place | null>(null);
  const [dropoff, setDropoff] = useState<Place | null>(null);
  const [mode, setMode] = useState<'now' | 'later'>('later');
  const [start, setStart] = useState(() => localInput(earliest()));
  const [hours, setHours] = useState<number | null>(null);
  const [passengers, setPassengers] = useState(1);
  const [cpos, setCpos] = useState(1);
  const [vehicles, setVehicles] = useState(1);
  const [driverOnly, setDriverOnly] = useState(false);
  const [addOns, setAddOns] = useState<string[]>([]);
  const [task, setTask] = useState('close_protection');
  const [transport, setTransport] = useState<TransportMode>('none');
  const [tPickup, setTPickup] = useState<Place | null>(null);
  const [tDropoff, setTDropoff] = useState<Place | null>(null);
  const [notes, setNotes] = useState('');
  const [referral, setReferral] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Switching product resets what does not carry over (the app does the same).
  useEffect(() => {
    setHours(null); setAddOns([]); setErr(null);
    setVehicles(exec ? 0 : 1); setDropoff(null); setTransport('none');
    if (exec) setMode('later');
  }, [exec]);

  const near = AREA_CENTER[region] ?? AREA_CENTER.AE;
  const startIso = mode === 'now' ? new Date().toISOString() : new Date(start).toISOString();
  const transportOn = exec && transport !== 'none';
  const effVehicles = exec ? (transportOn ? Math.max(vehicles, 1) : 0) : vehicles;

  const estimateBody = useMemo<EstimateBody | null>(() => {
    if (!pickup || !region) return null;
    return {
      type: exec ? 'timeslot' : 'transfer',
      service: exec ? 'executive_protection' : 'secure_transfer',
      ...(hours ? {duration_hours: hours} : exec ? {duration_hours: 3} : {}),
      add_ons: addOns, region, cpo_count: cpos, vehicle_count: effVehicles,
      driver_only: !exec && driverOnly, passengers,
      pickup_time: startIso,
      pickup: {latitude: pickup.latitude, longitude: pickup.longitude},
      ...(referral.trim() ? {referral_code: referral.trim()} : {}),
    };
  }, [pickup, region, exec, hours, addOns, cpos, effVehicles, driverOnly, passengers, startIso, referral]);

  const estKey = estimateBody ? JSON.stringify(estimateBody) : null;
  const [debouncedKey, setDebouncedKey] = useState<string | null>(null);
  useEffect(() => { const t = setTimeout(() => setDebouncedKey(estKey), 400); return () => clearTimeout(t); }, [estKey]);
  const {data: estimate, error: estErr, isLoading: estimating} = useSWR(
    debouncedKey ? ['web', 'estimate', debouncedKey] : null,
    () => webApi.estimate(JSON.parse(debouncedKey as string) as EstimateBody),
    {revalidateOnFocus: false, shouldRetryOnError: false},
  );

  // The server's duration rule (Lite) — the picker offers exactly what it accepts.
  const liteHours = useMemo(() => {
    const r = estimate?.duration_rule;
    if (!r) return [1, 2, 3, 4, 6, 8, 12];
    if (r.grid?.length) return r.grid;
    const out: number[] = [];
    for (let h = r.min; h <= r.max; h++) out.push(h);
    return out;
  }, [estimate?.duration_rule]);
  const shownHours = hours ?? estimate?.duration_hours ?? (exec ? 3 : estimate?.duration_rule?.default ?? null);
  const total = estimate ? (estimate.total_bc ?? Math.ceil(estimate.total)) : null;
  const short = total !== null && balance ? balance.bravo_credits < total : false;

  const catalog = (addOnCatalog ?? []).filter(a => (exec ? EXEC_ADD_ONS.includes(a.id) : true));
  const needsId = identity?.required === true && identity.status !== 'submitted';
  const tooSoon = mode === 'later' && new Date(start).getTime() < Date.now() + LEAD_HOURS * 3600_000;
  const transportReady = !transportOn || (!!tPickup && !!tDropoff);
  const ready = !!pickup && (exec || !!dropoff) && !!region && !tooSoon && transportReady && (!auto || consent) && !needsId;

  // One key per submitted body: a retry of the same body replays, an edit is a new booking.
  const submitKey = useRef<{body: string; key: string} | null>(null);

  async function submit() {
    if (!pickup || !ready) return;
    setBusy(true); setErr(null);
    const areaLabel = regions?.find(r => r.code === region)?.name;
    const body: CreateBody = {
      type: exec ? 'timeslot' : 'transfer',
      service: exec ? 'executive_protection' : 'secure_transfer',
      pickup, ...(!exec && dropoff ? {dropoff} : {}),
      start_time: startIso,
      ...(shownHours ? {duration_hours: shownHours} : {}),
      add_ons: addOns, payment_method: 'bravo_credits', region, ...(areaLabel ? {region_label: areaLabel} : {}),
      booking_mode: mode, passengers, cpo_count: cpos, vehicle_count: effVehicles,
      driver_only: !exec && driverOnly,
      ...(notes.trim() ? {notes: notes.trim()} : {}),
      ...(referral.trim() ? {referral_code: referral.trim()} : {}),
      ...(exec ? {task_type: task} : {}),
      ...(transportOn && tPickup && tDropoff
        ? {exec_transport: {mode: transport as Exclude<TransportMode, 'none'>, pickup: tPickup, dropoff: tDropoff, passengers}}
        : {}),
      ...(auto ? {
        location_consent: true, terms_accepted: true,
        location_consent_version: LOCATION_CONSENT_VERSION, terms_accepted_version: TERMS_VERSION,
      } : {}),
    };
    const text = JSON.stringify(body);
    if (submitKey.current?.body !== text) submitKey.current = {body: text, key: actionKey('book')};
    try {
      const {booking} = auto
        ? await webApi.requestAuto(body, submitKey.current.key)
        : await webApi.create(body, submitKey.current.key);
      submitKey.current = null;
      router.push(webRoutes.booking(booking.id));
    } catch (e) {
      setErr(webErrorText(e));
      setBusy(false);
    }
  }

  if (!client) return <PvPage title="Book"><ClientsOnly/></PvPage>;

  const counter = (label: string, value: number, set: (n: number) => void, min: number, max: number) => (
    <label className="pv-field web-counter">
      <span className="pv-label">{label}</span>
      <span className="web-stepper">
        <button type="button" className="btn btn-sm btn-ghost" disabled={value <= min} onClick={() => set(value - 1)} aria-label={`Fewer ${label}`}>−</button>
        <span className="pv-strong">{value}</span>
        <button type="button" className="btn btn-sm btn-ghost" disabled={value >= max} onClick={() => set(value + 1)} aria-label={`More ${label}`}>+</button>
      </span>
    </label>
  );

  return (
    <PvPage title="Book protection"
      subtitle="Choose the service, where and when. You pay with the Bravo credits in your wallet."
      right={<div className="pv-seg" role="tablist" aria-label="Service">
        <button className={!exec ? 'on' : ''} onClick={() => setProduct('lite')}>Lite · Secure transfer</button>
        <button className={exec ? 'on' : ''} onClick={() => setProduct('executive')}>Executive protection</button>
      </div>}>

      {needsId && (
        <div className="pv-banner" role="status">
          <span>Add your ID or passport once before your first booking. Bravo Secure checks it to keep every mission safe.</span>
          <Link className="btn btn-sm btn-pri" href={webRoutes.account}>Add ID</Link>
        </div>
      )}

      <div className="pv-grid pv-grid-wide">
        <div className="pv-col">
          <PvCard title={exec ? 'Protection location' : 'Route'}>
            <div className="pv-form">
              <label className="pv-field">
                <span className="pv-label">Area</span>
                <select className="pv-input" value={region} onChange={e => setRegion(e.target.value)}>
                  {(regions ?? []).map(r => (
                    <option key={r.code} value={r.code}>{r.name}{r.available ? '' : ' (limited availability)'}</option>
                  ))}
                </select>
              </label>
              <PlacePicker label={exec ? 'Where should the team meet you?' : 'Pick-up'} value={pickup} onChange={setPickup} near={near}/>
              {!exec && <PlacePicker label="Drop-off" value={dropoff} onChange={setDropoff} pinType="dropoff" near={pickup ? [pickup.longitude, pickup.latitude] : near}/>}
            </div>
          </PvCard>

          {exec && (
            <PvCard title="Secure transfer (optional)">
              <div className="pv-form">
                <div className="pv-seg">
                  {([['none', 'No transfer'], ['one_way', 'One way'], ['return', 'Return'], ['both_ways', 'Both ways']] as const).map(([k, l]) => (
                    <button key={k} type="button" className={transport === k ? 'on' : ''} onClick={() => setTransport(k)}>{l}</button>
                  ))}
                </div>
                {transportOn && <>
                  <PlacePicker label="Transfer pick-up" value={tPickup} onChange={setTPickup} near={pickup ? [pickup.longitude, pickup.latitude] : near}/>
                  <PlacePicker label="Transfer drop-off" value={tDropoff} onChange={setTDropoff} pinType="dropoff" near={pickup ? [pickup.longitude, pickup.latitude] : near}/>
                </>}
              </div>
            </PvCard>
          )}
        </div>

        <div className="pv-col">
          <PvCard title="When">
            <div className="pv-form">
              {!exec && auto && (
                <div className="pv-seg">
                  <button type="button" className={mode === 'now' ? 'on' : ''} onClick={() => setMode('now')}>As soon as possible</button>
                  <button type="button" className={mode === 'later' ? 'on' : ''} onClick={() => setMode('later')}>Schedule</button>
                </div>
              )}
              {mode === 'later' && (
                <label className="pv-field">
                  <span className="pv-label">Start</span>
                  <input className="pv-input" type="datetime-local" value={start} min={localInput(earliest())}
                    onChange={e => setStart(e.target.value)}/>
                  <span className="pv-cell-sub">{tooSoon ? `Choose a start at least ${LEAD_HOURS} hours from now.` : 'Your local time.'}</span>
                </label>
              )}
              <label className="pv-field">
                <span className="pv-label">Duration</span>
                <select className="pv-input" value={shownHours ?? ''} onChange={e => setHours(Number(e.target.value))}>
                  {shownHours === null && <option value="">Pick the location first</option>}
                  {(exec ? EXEC_HOURS : liteHours).map(h => <option key={h} value={h}>{h} hour{h === 1 ? '' : 's'}</option>)}
                </select>
              </label>
              {exec && (
                <label className="pv-field">
                  <span className="pv-label">What is the detail for?</span>
                  <select className="pv-input" value={task} onChange={e => setTask(e.target.value)}>
                    {TASKS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>
                </label>
              )}
            </div>
          </PvCard>

          <PvCard title="Team">
            <div className="pv-form web-counters">
              {counter('Passengers', passengers, setPassengers, 1, 16)}
              {counter('Officers', cpos, setCpos, 1, 10)}
              {(!exec || transportOn) && counter('Vehicles', effVehicles, setVehicles, exec ? 1 : 0, 10)}
              {!exec && (
                <label className="pv-check">
                  <input type="checkbox" checked={driverOnly} onChange={e => setDriverOnly(e.target.checked)}/>
                  <span>I provide the vehicle (officer drives it)</span>
                </label>
              )}
            </div>
            {catalog.length > 0 && (
              <div className="pv-form" style={{marginTop: 12}}>
                <span className="pv-label">Add-ons</span>
                {catalog.map(a => (
                  <label key={a.id} className="pv-check">
                    <input type="checkbox" checked={addOns.includes(a.id)}
                      onChange={e => setAddOns(s => (e.target.checked ? [...s, a.id] : s.filter(x => x !== a.id)))}/>
                    <span>{a.label}{a.description ? <span className="pv-cell-sub"> · {a.description}</span> : null}</span>
                  </label>
                ))}
              </div>
            )}
          </PvCard>

          <PvCard title="Notes for the team">
            <div className="pv-form">
              <textarea className="pv-input" rows={3} maxLength={2000} value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="Anything the team should know (optional)"/>
              <label className="pv-field">
                <span className="pv-label">Referral or discount code</span>
                <input className="pv-input" value={referral} maxLength={32} onChange={e => setReferral(e.target.value)} placeholder="Optional"/>
                {estimate?.referral && (
                  <span className="pv-cell-sub">{estimate.referral.applied ? 'Code applied.' : estimate.referral.message ?? 'This code does not apply.'}</span>
                )}
              </label>
            </div>
          </PvCard>

          <PvCard title="Price">
            {!pickup ? <Empty>Pick the {exec ? 'location' : 'pick-up point'} to see the price.</Empty>
              : estErr ? <div className="pv-err">{webErrorText(estErr)}</div>
              : !estimate || estimating ? <Empty>Calculating…</Empty>
              : (
                <dl className="pv-facts pv-facts-col">
                  <div><dt>Total</dt><dd className="pv-strong web-total">{credits(total)}</dd></div>
                  {estimate.gross_bc && estimate.gross_bc !== total && <div><dt>Before discount</dt><dd>{credits(estimate.gross_bc)}</dd></div>}
                  <div><dt>Your credits</dt><dd>{balance ? credits(balance.bravo_credits) : '—'}</dd></div>
                  <div><dt>Payment</dt><dd>{auto ? 'Held from your credits when a provider accepts' : 'Charged to your credits once Bravo Secure approves'}</dd></div>
                </dl>
              )}
            {short && (
              <p className="pv-err" style={{marginTop: 10}}>
                {auto
                  ? 'Your credits do not cover this booking. Top up in the Bravo Secure app (Wallet), then book here.'
                  : 'Your credits do not cover this booking yet. You can send it now, but top up in the Bravo Secure app before you pay for it.'}
              </p>
            )}
            {auto && (
              <label className="pv-check" style={{marginTop: 12}}>
                <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/>
                <span>
                  I agree to share my pick-up point and live location with the assigned security provider for this
                  mission, and I accept the Bravo Secure terms of service.
                </span>
              </label>
            )}
            {err && <div className="pv-err" role="alert" style={{marginTop: 10}}>{err}</div>}
            <button className="btn btn-pri btn-lg" style={{width: '100%', marginTop: 14}}
              disabled={!ready || busy || (auto && short)} onClick={() => void submit()}>
              {busy ? 'Booking…' : auto ? 'Book and find a provider' : 'Send booking for approval'}
            </button>
          </PvCard>
        </div>
      </div>
    </PvPage>
  );
}
