'use client';

/**
 * IA-04 / IA-15 — the auto-dispatch test harness, on its own route.
 *
 * Two problems it inherited from the monitor page. First, a destructive-ish
 * tool (it creates a REAL booking and cascades REAL offers to REAL agencies)
 * sat inline above the read-only monitor, one mis-click away from an operator
 * reading the board. Second, its region picker was a hardcoded four-entry array
 * — so a region added on App Configuration could never be tested, and the list
 * silently disagreed with the regions table shipped in the same release.
 *
 * The picker now reads the ops-managed regions table, and centres on the
 * region's own bounding box: the box is what resolves a booking's pricing
 * region, so testing from its centre exercises the same resolution the real
 * flow uses. A region with no box cannot be tested and says so.
 */

import {useMemo, useState} from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import {opsApi, opsDataApi, useOpsMe, type FireTestDispatchArgs} from '@/lib/api';
import {canForceAssign} from '@/lib/rbac';
import {PageHeader} from '@/components/PageHeader';
import {DispatchTabs} from '@/features/dispatch/DispatchTabs';
import {routes} from '@/lib/routes';

export default function DispatchTestPage() {
  const {data: me} = useOpsMe();
  const canFire = canForceAssign(me?.admin.role);
  const {data: regionData, error: regionErr} = useSWR('ops-regions', () => opsDataApi.regions());

  const regions = useMemo(
    () => (regionData?.regions ?? []).filter(r => r.min_lat != null && r.max_lat != null),
    [regionData],
  );
  const unusable = (regionData?.regions ?? []).length - regions.length;

  const [code, setCode] = useState<string>('');
  const [cpoCount, setCpoCount] = useState(1);
  const [armed, setArmed] = useState(false);
  const [firing, setFiring] = useState(false);
  const [msg, setMsg] = useState<{ok: boolean; text: string; bookingId?: string} | null>(null);

  const region = regions.find(r => r.code === code) ?? regions[0];

  async function fire() {
    if (!region) return;
    // The centre of the region's own bounding box — the same geometry that
    // resolves a real booking's pricing region.
    const lat = (Number(region.min_lat) + Number(region.max_lat)) / 2;
    const lng = (Number(region.min_lng) + Number(region.max_lng)) / 2;
    // eslint-disable-next-line no-alert
    if (!window.confirm(
      `Fire a REAL test booking in ${region.code} — ${region.name}?\n\n`
      + `It creates a booking row and cascades genuine offers to eligible agencies in that region. `
      + `Cancel it from the Requests tab when you are done watching.`)) return;

    setFiring(true); setMsg(null);
    try {
      const args: FireTestDispatchArgs = {
        region_code: region.code,
        region_label: region.name,
        pickup_lat: lat,
        pickup_lng: lng,
        cpo_count: cpoCount,
        armed,
      };
      const r = await opsApi.fireTestDispatch(args);
      setMsg({ok: true, text: `Fired — booking ${r.booking_id.slice(0, 8)} is DISPATCHING.`, bookingId: r.booking_id});
    } catch (e) {
      setMsg({ok: false, text: (e as Error).message});
    } finally {
      setFiring(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Dispatch Test Harness"
        subtitle="Fires a genuine booking through the matchmaker so you can watch an offer reach the nearest eligible agency. It creates real rows and sends real offers — cancel it from Requests when you are done."
        badges={<span className="pill pill-warn">CREATES A REAL BOOKING</span>}
      />
      <DispatchTabs />

      <div className="card" style={{padding: 18, maxWidth: 720}}>
        {regionErr && (
          <div className="modal-err" style={{marginBottom: 12}}>
            Could not load the regions table. Add or launch regions under App Configuration · Regions.
          </div>
        )}

        <div style={{display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end'}}>
          <label style={{display: 'flex', flexDirection: 'column', gap: 6}}>
            <span className="exec-cap">Region</span>
            <select
              value={region?.code ?? ''}
              onChange={e => setCode(e.target.value)}
              style={{
                minWidth: 260, padding: '8px 10px', borderRadius: 8,
                background: 'var(--surf-3)', border: '1px solid var(--bd-2)',
                color: 'var(--tx-1)', fontSize: 12.5,
              }}>
              {regions.length === 0 && <option value="">No region has a bounding box</option>}
              {regions.map(r => (
                <option key={r.code} value={r.code}>
                  {r.code} — {r.name}{r.launched ? '' : ' (not launched)'}
                </option>
              ))}
            </select>
          </label>

          <label style={{display: 'flex', flexDirection: 'column', gap: 6}}>
            <span className="exec-cap">CPOs</span>
            <input
              type="number" min={1} max={4} value={cpoCount}
              onChange={e => setCpoCount(Math.max(1, Math.min(4, Number(e.target.value) || 1)))}
              style={{
                width: 80, padding: '8px 10px', borderRadius: 8,
                background: 'var(--surf-3)', border: '1px solid var(--bd-2)',
                color: 'var(--tx-1)', fontSize: 12.5,
              }}
            />
          </label>

          <label style={{display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 8, fontSize: 12.5}}>
            <input type="checkbox" checked={armed} onChange={e => setArmed(e.target.checked)} />
            Armed
          </label>

          {canFire ? (
            <button
              className="btn btn-pri"
              disabled={firing || !region}
              onClick={() => { void fire(); }}>
              {firing ? 'FIRING…' : 'FIRE TEST DISPATCH'}
            </button>
          ) : (
            <span className="cfg-meta" style={{paddingBottom: 10}}>SUPERVISOR OR ADMIN ONLY</span>
          )}
        </div>

        {unusable > 0 && (
          <div className="cfg-meta" style={{marginTop: 12, color: 'var(--warn)'}}>
            ⚠ {unusable} region{unusable === 1 ? ' has' : 's have'} no bounding box and cannot be
            tested — a region without one never resolves and prices at global.{' '}
            <Link href={routes.config.regions}>Fix it under App Configuration →</Link>
          </div>
        )}

        {msg && (
          <div
            role="alert"
            className={msg.ok ? 'cfg-meta' : 'modal-err'}
            style={{marginTop: 14, color: msg.ok ? 'var(--ok)' : undefined}}>
            {msg.text}
            {msg.ok && (
              <> <Link href={routes.lite.dispatchRequests}>Watch it in Requests →</Link></>
            )}
          </div>
        )}

        <div className="cfg-meta" style={{marginTop: 16, lineHeight: 1.7}}>
          NO OFFER APPEARING? The nearest eligible agency needs all of: a matching region code, a
          verified and non-expired licence and insurance, at least one active CPO, and that CPO on
          duty with a recent location near the pickup. Check the agency under People · Provider
          Agencies — its compliance column answers the first two.
        </div>
      </div>
    </>
  );
}
