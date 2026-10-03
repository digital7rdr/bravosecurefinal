'use client';

import {useState} from 'react';
import {useSWRConfig} from 'swr';
import {Empty, PvCard} from './ui';
import {useToast} from '@/components/Toast';
import {pvApi, usePvMissionVehicles, usePvVehicles} from '@/lib/provider/api';
import {errorText} from '@/lib/provider/labels';

const OPEN = new Set(['CREWED', 'DISPATCHED', 'PICKUP', 'LIVE', 'SOS']);

/**
 * The agency's own vehicles on one mission (Phase 2). Only verified, active,
 * free vehicles can be added; the server re-checks all of that.
 */
export function MissionVehicles({orgId, missionId, status, needed}: {
  orgId: string; missionId: string; status: string | null; needed?: number;
}) {
  const {data: onMission} = usePvMissionVehicles(orgId, missionId);
  const {data: fleet} = usePvVehicles(orgId, true);
  const {mutate} = useSWRConfig();
  const {push} = useToast();
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const open = status ? OPEN.has(status) : false;

  const assigned = onMission?.vehicles ?? [];
  const free = (fleet?.vehicles ?? []).filter(v => v.active && v.review_status === 'verified' && !v.on_mission);
  const waiting = (fleet?.vehicles ?? []).filter(v => v.active && v.review_status === 'pending').length;
  const refresh = () => mutate((k: unknown) => Array.isArray(k) && k[0] === 'pv');

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try { await fn(); push({kind: 'ok', text: ok}); setPick(''); await refresh(); }
    catch (e) { push({kind: 'err', text: errorText(e)}); }
    finally { setBusy(false); }
  }

  return (
    <PvCard title="Vehicles" right={needed ? <span className="pv-hint">Job asks for {needed}</span> : undefined} pad={false}>
      {!onMission ? <Empty>Loading…</Empty> : assigned.length === 0 ? <Empty>No vehicle on this mission.</Empty> : (
        <ul className="pv-list">
          {assigned.map(v => (
            <li key={v.id} className="pv-list-row">
              <span className="pv-mono pv-strong">{v.call_sign}</span>
              <span className="pv-list-main"><span>{v.make_model}</span><span className="pv-list-sub">{v.plate}{v.armored ? ` · armoured${v.armor_grade ? ` ${v.armor_grade}` : ''}` : ''} · {v.capacity} seats</span></span>
              {open && <button className="btn btn-sm btn-ghost" disabled={busy}
                onClick={() => run(() => pvApi.releaseVehicle(missionId, v.id), `${v.call_sign} taken off the mission.`)}>Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {open && (
        <div className="pv-card-body" style={{display: 'flex', gap: 8, borderTop: '1px solid var(--bd-2)'}}>
          <select className="pv-input" style={{flex: 1}} value={pick} onChange={e => setPick(e.target.value)} aria-label="Vehicle to add">
            <option value="">{free.length ? 'Add a verified vehicle…' : waiting ? 'No verified vehicle free (some are in review)' : 'No verified vehicle free'}</option>
            {free.map(v => <option key={v.id} value={v.id}>{v.call_sign} · {v.make_model} · {v.plate}{v.armored ? ' · armoured' : ''}</option>)}
          </select>
          <button className="btn btn-pri" disabled={!pick || busy}
            onClick={() => run(() => pvApi.assignVehicle(missionId, pick), 'Vehicle added to the mission.')}>Add</button>
        </div>
      )}
    </PvCard>
  );
}
