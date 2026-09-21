'use client';

import {useEffect, useMemo, useState} from 'react';
import useSWR from 'swr';
import {opsApi, type DispatchAreasResponse} from '@/lib/api';

/**
 * B-788a — Areas & providers: the ops surface for Dispatch v2.
 *
 * Per region: the routing switch (nearest = today's ranker; assigned = the
 * priority cascade), the operational areas with their primary / secondary
 * provider, and a flag on any area that has no active assignment (it routes on
 * the regional fallback only). Providers are the ACTIVE company agents in that
 * region — nobody else could ever receive an offer there.
 */
export function AreasPanel() {
  const {data, error, isLoading, mutate} = useSWR('dispatch-areas', () => opsApi.dispatchAreas(), {refreshInterval: 15000});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (id: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(id); setMsg(null);
    try { await fn(); setMsg(ok); await mutate(); }
    catch (e) { setMsg(`Failed: ${(e as Error).message}`); }
    finally { setBusy(null); }
  };

  const providersByRegion = useMemo(() => {
    const m = new Map<string, DispatchAreasResponse['providers']>();
    for (const p of data?.providers ?? []) {
      const k = p.region_code ?? '—';
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return m;
  }, [data]);

  if (error) {return <div className="rounded-xl border border-err/40 bg-err/10 p-4 text-sm text-err">Areas failed to load: {(error as Error).message}</div>;}
  if (isLoading || !data) {return <div className="rounded-xl border border-bd2 bg-s2 p-4 text-sm text-t3">Loading areas…</div>;}

  return (
    <div className="rounded-xl border border-bd2 bg-s2 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-t3">Areas &amp; providers</h2>
          <p className="text-xs text-t3">
            Route by assigned province and provider priority, not distance. A region on <span className="font-mono">nearest</span> still uses today&apos;s 50 km ranker; flip it to <span className="font-mono">assigned</span> once every launched area has a primary.
          </p>
        </div>
        {msg && <div className="text-xs text-t2">{msg}</div>}
      </div>

      <div className="space-y-5">
        {data.regions.map(region => {
          const areas = data.areas.filter(a => a.region_code === region.code);
          const providers = providersByRegion.get(region.code) ?? [];
          const gaps = areas.filter(a => a.active && a.assignments.length === 0);
          return (
            <div key={region.code} className="rounded-lg border border-bd2 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm">
                  <span className="font-semibold text-t1">{region.code}</span>
                  <span className="ml-2 text-t3">{region.name}</span>
                  {!region.launched && <span className="ml-2 rounded bg-s3 px-1.5 py-0.5 text-[10px] text-t3">NOT LAUNCHED</span>}
                  {gaps.length > 0 && region.routing_mode === 'assigned' && (
                    <span className="ml-2 rounded bg-warn/20 px-1.5 py-0.5 text-[10px] text-warn">
                      {gaps.length} area{gaps.length === 1 ? '' : 's'} on fallback only
                    </span>
                  )}
                </div>
                <label className="flex items-center gap-2 text-xs text-t2">
                  Routing
                  <select
                    className="rounded border border-bd2 bg-s1 px-2 py-1 text-xs"
                    value={region.routing_mode}
                    disabled={busy === `mode-${region.code}`}
                    onChange={e => {
                      const next = e.target.value as 'nearest' | 'assigned';
                      if (next === 'assigned' && gaps.length > 0
                          && !window.confirm(`${gaps.length} active area(s) in ${region.code} have no assigned provider and will route on the regional fallback. Flip anyway?`)) {
                        return;
                      }
                      void run(`mode-${region.code}`, () => opsApi.setRegionRoutingMode(region.code, next),
                        `${region.code} now routes: ${next}.`);
                    }}>
                    <option value="nearest">nearest (today)</option>
                    <option value="assigned">assigned providers</option>
                  </select>
                </label>
              </div>

              <table className="w-full text-xs">
                <thead className="text-t3">
                  <tr>
                    <th className="py-1 text-left font-medium">Area</th>
                    <th className="py-1 text-left font-medium">Box</th>
                    <th className="py-1 text-left font-medium">Primary</th>
                    <th className="py-1 text-left font-medium">Secondary</th>
                    <th className="py-1 text-left font-medium">Active</th>
                  </tr>
                </thead>
                <tbody>
                  {areas.map(area => (
                    <AreaRow
                      key={area.id}
                      area={area}
                      providers={providers}
                      busy={busy === `assign-${area.id}` || busy === `area-${area.id}`}
                      onAssign={(assignments) => run(`assign-${area.id}`,
                        () => opsApi.setAreaAssignments(area.id, assignments), `${area.code} providers saved.`)}
                      onToggleActive={() => run(`area-${area.id}`,
                        () => opsApi.updateDispatchArea(area.id, {active: !area.active}),
                        `${area.code} ${area.active ? 'deactivated' : 'activated'}.`)}
                    />
                  ))}
                </tbody>
              </table>

              <NewArea regionCode={region.code} busy={busy === `new-${region.code}`}
                onCreate={body => run(`new-${region.code}`, () => opsApi.createDispatchArea(body), `${body.code} created.`)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

type Area = DispatchAreasResponse['areas'][number];
type Provider = DispatchAreasResponse['providers'][number];

function AreaRow({area, providers, busy, onAssign, onToggleActive}: {
  area: Area; providers: Provider[]; busy: boolean;
  onAssign: (assignments: Array<{provider_user_id: string; priority: number}>) => void;
  onToggleActive: () => void;
}) {
  const primary = area.assignments.find(a => a.priority === 1)?.provider_user_id ?? '';
  const secondary = area.assignments.find(a => a.priority === 2)?.provider_user_id ?? '';
  const [p1, setP1] = useState(primary);
  const [p2, setP2] = useState(secondary);
  // Re-seed on every refetch: the row is keyed by area id and never remounts, so
  // another admin's save would otherwise show here as a phantom "dirty" Save
  // that reverts their change.
  useEffect(() => { setP1(primary); setP2(secondary); }, [primary, secondary]);
  const dirty = p1 !== primary || p2 !== secondary;
  const box = area.min_lat === null ? 'whole region' :
    `${area.min_lat}…${area.max_lat} / ${area.min_lng}…${area.max_lng}`;
  const select = (value: string, onChange: (v: string) => void, exclude: string) => (
    <select className="w-full rounded border border-bd2 bg-s1 px-2 py-1" value={value} disabled={busy}
      onChange={e => onChange(e.target.value)}>
      <option value="">— none —</option>
      {/* A live assignment whose provider is suspended or moved region must stay
          VISIBLE — it still receives every offer until ops changes it. */}
      {value && !providers.some(p => p.user_id === value) && (
        <option value={value}>{value.slice(0, 8)}… (no longer eligible — reassign)</option>
      )}
      {providers.filter(p => p.user_id !== exclude).map(p => (
        <option key={p.user_id} value={p.user_id}>
          {p.display_name ?? p.call_sign ?? p.user_id.slice(0, 8)}{p.on_duty ? '' : ' (off duty)'}
        </option>
      ))}
    </select>
  );
  return (
    <tr className={`border-t border-bd2 ${area.active ? '' : 'opacity-50'}`}>
      <td className="py-1.5 pr-2">
        <div className="font-semibold text-t1">{area.code}</div>
        <div className="text-t3">{area.name}{area.is_default ? ' · default' : ''}</div>
      </td>
      <td className="py-1.5 pr-2 font-mono text-[10px] text-t3">{box}</td>
      <td className="py-1.5 pr-2">{select(p1, setP1, p2)}</td>
      <td className="py-1.5 pr-2">{select(p2, setP2, p1)}</td>
      <td className="py-1.5">
        <div className="flex items-center gap-2">
          {dirty && (
            <button disabled={busy} className="rounded bg-ok px-2 py-1 text-[11px] font-semibold text-canvas disabled:opacity-50"
              onClick={() => onAssign([
                ...(p1 ? [{provider_user_id: p1, priority: 1}] : []),
                ...(p2 ? [{provider_user_id: p2, priority: 2}] : []),
              ])}>
              Save
            </button>
          )}
          {!area.is_default && (
            <button disabled={busy} className="rounded border border-bd2 px-2 py-1 text-[11px] text-t2 disabled:opacity-50"
              onClick={onToggleActive}>
              {area.active ? 'Deactivate' : 'Activate'}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function NewArea({regionCode, busy, onCreate}: {
  regionCode: string; busy: boolean;
  onCreate: (body: {region_code: string; code: string; name: string; min_lat?: number; max_lat?: number; min_lng?: number; max_lng?: number}) => void;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState(`${regionCode}-`);
  const [name, setName] = useState('');
  const [box, setBox] = useState({min_lat: '', max_lat: '', min_lng: '', max_lng: ''});
  if (!open) {
    return <button className="mt-2 text-xs text-accent hover:underline" onClick={() => setOpen(true)}>+ Add area in {regionCode}</button>;
  }
  const n = (v: string) => Number(v);
  // All four box fields, or none — none = the region's catch-all (only accepted
  // by the server when the region has no default yet).
  const boxEmpty = Object.values(box).every(v => v.trim() === '');
  const boxFull = Object.values(box).every(v => v.trim() !== '' && Number.isFinite(Number(v)))
    && n(box.min_lat) < n(box.max_lat) && n(box.min_lng) < n(box.max_lng);
  const valid = /^[A-Z]{2,8}-[A-Z0-9]{1,8}$/.test(code) && name.trim().length > 0 && (boxEmpty || boxFull);
  return (
    <div className="mt-2 grid grid-cols-2 gap-2 rounded border border-bd2 p-2 text-xs md:grid-cols-7">
      <input className="rounded border border-bd2 bg-s1 px-2 py-1" placeholder="ZA-EC" value={code} onChange={e => setCode(e.target.value.toUpperCase())} />
      <input className="rounded border border-bd2 bg-s1 px-2 py-1" placeholder="Eastern Cape" value={name} onChange={e => setName(e.target.value)} />
      {(['min_lat', 'max_lat', 'min_lng', 'max_lng'] as const).map(k => (
        <input key={k} className="rounded border border-bd2 bg-s1 px-2 py-1 font-mono" placeholder={k} value={box[k]}
          onChange={e => setBox({...box, [k]: e.target.value})} />
      ))}
      <div className="flex gap-2">
        <button disabled={!valid || busy} className="rounded bg-ok px-2 py-1 font-semibold text-canvas disabled:opacity-50"
          onClick={() => onCreate({
            region_code: regionCode, code, name: name.trim(),
            ...(boxFull ? {min_lat: n(box.min_lat), max_lat: n(box.max_lat), min_lng: n(box.min_lng), max_lng: n(box.max_lng)} : {}),
          })}>
          Create
        </button>
        <button className="rounded border border-bd2 px-2 py-1 text-t2" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}
