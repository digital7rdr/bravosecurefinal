'use client';

/**
 * Provider Vehicles (2026-10-03) — HQ review of the vehicles agencies add in
 * the provider console. A vehicle can go on a job only once it is verified
 * here; rejecting needs a reason, which the agency sees, and takes the vehicle
 * off any open mission. Every decision is audited.
 */

import {useState} from 'react';
import useSWR from 'swr';
import {ApiError, opsApi, type ProviderVehicleRow} from '@/lib/api';
import {PageHeader} from '@/components/PageHeader';
import {formatDateTimeUtc} from '@/lib/datetime';
import {useToast} from '@/components/Toast';

type Status = 'pending' | 'verified' | 'rejected' | 'all';
const TABS: Array<[Status, string]> = [['pending', 'Waiting for review'], ['verified', 'Verified'], ['rejected', 'Rejected'], ['all', 'All']];
const PILL: Record<ProviderVehicleRow['review_status'], string> = {pending: 'pill-warn', verified: 'pill-ok', rejected: 'pill-err'};

export default function ProviderVehiclesPage() {
  const [tab, setTab] = useState<Status>('pending');
  const {data, error, isLoading, mutate} = useSWR(['provider-vehicles', tab], () => opsApi.providerVehicles(tab), {refreshInterval: 60_000});
  const [rejecting, setRejecting] = useState<ProviderVehicleRow | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const {push} = useToast();
  const rows = data?.vehicles ?? [];

  async function decide(v: ProviderVehicleRow, decision: 'verified' | 'rejected', reason?: string) {
    setBusy(v.id);
    try {
      await opsApi.reviewProviderVehicle(v.id, decision, reason);
      push({kind: 'ok', text: decision === 'verified' ? `${v.call_sign} (${v.org_name ?? 'agency'}) verified.` : `${v.call_sign} rejected; the agency sees your reason.`});
      setRejecting(null); setNote('');
      await mutate();
    } catch (e) {
      push({kind: 'err', text: e instanceof ApiError ? e.message : 'Could not save the decision.'});
    } finally { setBusy(null); }
  }

  return (
    <>
      <PageHeader
        title="Provider Vehicles"
        subtitle="Vehicles agencies add in the provider console. Check the plate, make and armour against the registration; only verified vehicles can be put on a job. Editing those details sends a vehicle back here."
        badges={data && tab === 'pending' ? <span className={`pill ${rows.length ? 'pill-warn' : ''}`}>{rows.length} WAITING</span> : undefined}
      />
      <div className="flex gap-2" style={{marginBottom: 14}} role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`btn btn-sm ${tab === k ? 'btn-pri' : 'btn-ghost'}`}>{l}</button>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-bd2">
        <table className="w-full text-sm">
          <thead className="bg-s2 text-left text-xs uppercase text-t3">
            <tr>
              <th className="px-3 py-2">Agency</th><th className="px-3 py-2">Vehicle</th><th className="px-3 py-2">Plate</th>
              <th className="px-3 py-2">Armour</th><th className="px-3 py-2">Seats</th><th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Added</th><th className="px-3 py-2" aria-label="Actions"/>
            </tr>
          </thead>
          <tbody className="divide-y divide-bd2">
            {error && <tr><td colSpan={8} className="px-3 py-4 text-err">Could not load vehicles.</td></tr>}
            {isLoading && !data && <tr><td colSpan={8} className="px-3 py-4 text-t3">Loading…</td></tr>}
            {data && rows.length === 0 && <tr><td colSpan={8} className="px-3 py-4 text-t3">{tab === 'pending' ? 'Nothing waiting for review.' : 'No vehicles.'}</td></tr>}
            {rows.map(v => (
              <tr key={v.id}>
                <td className="px-3 py-2"><div className="text-t1">{v.org_name ?? '—'}</div>{v.region_code && <div className="text-xs text-t3">{v.region_code}</div>}</td>
                <td className="px-3 py-2"><div className="font-mono text-t1">{v.call_sign}</div><div className="text-xs text-t3">{v.make_model}{v.colour ? ` · ${v.colour}` : ''}</div></td>
                <td className="px-3 py-2 font-mono text-t1">{v.plate}</td>
                <td className="px-3 py-2">{v.armored ? `Armoured${v.armor_grade ? ` ${v.armor_grade}` : ''}` : <span className="text-t3">Soft-skin</span>}</td>
                <td className="px-3 py-2">{v.capacity}</td>
                <td className="px-3 py-2">
                  <span className={`pill ${PILL[v.review_status]}`}>{v.review_status}</span>
                  {v.on_mission && <span className="pill pill-act" style={{marginLeft: 6}}>On {v.on_mission}</span>}
                  {v.review_note && <div className="text-xs text-t3" style={{maxWidth: 240}}>{v.review_note}</div>}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-t3">{formatDateTimeUtc(v.updated_at)}</td>
                <td className="px-3 py-2" style={{textAlign: 'right', whiteSpace: 'nowrap'}}>
                  {v.review_status !== 'verified' && (
                    <button className="btn btn-sm btn-pri" disabled={busy === v.id} onClick={() => decide(v, 'verified')}>Verify</button>
                  )}
                  {v.review_status !== 'rejected' && (
                    <button className="btn btn-sm btn-ghost" style={{marginLeft: 6}} disabled={busy === v.id} onClick={() => { setRejecting(v); setNote(''); }}>Reject</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rejecting && (
        <div onClick={() => busy || setRejecting(null)} className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" className="w-full max-w-md rounded-xl border border-err/40 bg-s2 shadow-2xl">
            <div className="border-b border-bd2 px-5 py-4">
              <div className="text-lg font-bold text-t1">Reject {rejecting.call_sign}?</div>
              <div className="mt-2 text-sm text-t3">{rejecting.org_name} sees this reason in the provider console. The vehicle comes off any open mission.</div>
            </div>
            <div className="px-5 py-4">
              <textarea autoFocus rows={3} maxLength={280} value={note} onChange={e => setNote(e.target.value)}
                placeholder="e.g. Plate does not match the registration card"
                className="w-full resize-y rounded-lg border border-bd1 bg-s3 px-3 py-2 text-sm text-t1 placeholder:text-t3"/>
            </div>
            <div className="flex justify-end gap-2 border-t border-bd2 px-5 py-3.5">
              <button className="btn btn-sm btn-ghost" disabled={!!busy} onClick={() => setRejecting(null)}>Cancel</button>
              <button className="btn btn-sm btn-danger" disabled={!!busy || note.trim().length < 3} onClick={() => decide(rejecting, 'rejected', note.trim())}>Reject</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
