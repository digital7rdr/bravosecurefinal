'use client';

import {useMemo, useState} from 'react';
import {useSWRConfig} from 'swr';
import {NotGranted, useProvider} from '@/components/provider/ProviderShell';
import {Empty, PvCard, PvDialog, PvPage, Stat} from '@/components/provider/ui';
import {useToast} from '@/components/Toast';
import {pvApi, usePvVehicles, type OrgVehicle, type VehicleInput} from '@/lib/provider/api';
import {errorText, when} from '@/lib/provider/labels';

const REVIEW: Record<OrgVehicle['review_status'], {label: string; cls: string; hint: string}> = {
  pending:  {label: 'In review', cls: 'pill-warn', hint: 'Bravo Secure checks new and changed vehicles before they can go on a job.'},
  verified: {label: 'Verified',  cls: 'pill-ok',   hint: 'Can be put on jobs.'},
  rejected: {label: 'Rejected',  cls: 'pill-err',  hint: 'Fix what Bravo Secure asked for and save; it goes back to review.'},
};

type Filter = 'all' | 'ready' | 'review' | 'mission' | 'retired';

export default function ProviderVehicles() {
  const {orgId, can} = useProvider();
  const fleet = can('fleet');
  const {data, error} = usePvVehicles(orgId, fleet);
  const {mutate} = useSWRConfig();
  const {push} = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [edit, setEdit] = useState<OrgVehicle | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const all = useMemo(() => data?.vehicles ?? [], [data]);
  const rows = all.filter(v => {
    if (filter === 'ready') return v.active && v.review_status === 'verified' && !v.on_mission;
    if (filter === 'review') return v.active && v.review_status !== 'verified';
    if (filter === 'mission') return !!v.on_mission;
    if (filter === 'retired') return !v.active;
    return v.active;
  });
  const refresh = () => mutate((k: unknown) => Array.isArray(k) && k[0] === 'pv');

  if (!fleet) return <PvPage title="Vehicles"><NotGranted what="Vehicles"/></PvPage>;

  const active = all.filter(v => v.active);
  async function setActive(v: OrgVehicle, value: boolean) {
    setBusy(v.id);
    try {
      await pvApi.updateVehicle(v.id, {active: value});
      push({kind: 'ok', text: value ? `${v.call_sign} is back in service.` : `${v.call_sign} retired.`});
      await refresh();
    } catch (e) { push({kind: 'err', text: errorText(e)}); }
    finally { setBusy(null); }
  }

  return (
    <PvPage title="Vehicles"
      subtitle="Your agency's own vehicles. Bravo Secure verifies each one; verified vehicles can be put on a job from the mission page."
      right={<button className="btn btn-pri" onClick={() => setEdit('new')}>Add vehicle</button>}>
      <div className="kpi-row" style={{gridTemplateColumns: 'repeat(4, minmax(0, 1fr))'}}>
        <Stat label="In service" value={data ? active.length : '—'}/>
        <Stat label="Ready for a job" value={data ? active.filter(v => v.review_status === 'verified' && !v.on_mission).length : '—'} tone="ok"/>
        <Stat label="On a mission" value={data ? active.filter(v => v.on_mission).length : '—'} tone="act"/>
        <Stat label="In review" value={data ? active.filter(v => v.review_status !== 'verified').length : '—'} tone="warn"/>
      </div>

      <PvCard pad={false}>
        <div className="pv-toolbar">
          <div className="pv-seg">
            {([['all', 'In service'], ['ready', 'Ready'], ['mission', 'On a mission'], ['review', 'In review'], ['retired', 'Retired']] as const).map(([k, l]) => (
              <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>
            ))}
          </div>
        </div>
        {error ? <Empty>Could not load vehicles. It will retry automatically.</Empty>
          : !data ? <Empty>Loading…</Empty>
          : rows.length === 0 ? <Empty>{all.length === 0 ? 'No vehicles yet. Add the cars your crews drive; Bravo Secure verifies them before they go on a job.' : 'No vehicles match.'}</Empty>
          : (
            <div className="pv-table-wrap">
              <table className="pv-table">
                <thead><tr><th>Vehicle</th><th>Plate</th><th>Armour</th><th>Seats</th><th>Review</th><th>Now</th><th aria-label="Actions"/></tr></thead>
                <tbody>
                  {rows.map(v => {
                    const r = REVIEW[v.review_status];
                    return (
                      <tr key={v.id}>
                        <td><div className="pv-mono pv-strong">{v.call_sign}</div><div className="pv-cell-sub">{v.make_model}{v.colour ? ` · ${v.colour}` : ''}</div></td>
                        <td className="pv-mono">{v.plate}</td>
                        <td>{v.armored ? <span className="pill pill-info">{v.armor_grade ? `Armoured ${v.armor_grade}` : 'Armoured'}</span> : <span className="pv-cell-sub">Soft-skin</span>}</td>
                        <td className="pv-num">{v.capacity}</td>
                        <td>
                          <span className={`pill ${r.cls}`} title={r.hint}>{r.label}</span>
                          {v.review_status === 'rejected' && v.review_note && <div className="pv-cell-sub" style={{maxWidth: 260}}>{v.review_note}</div>}
                          {v.review_status === 'verified' && v.reviewed_at && <div className="pv-cell-sub">{when(v.reviewed_at)}</div>}
                        </td>
                        <td>{!v.active ? <span className="pill">Retired</span> : v.on_mission ? <span className="pill pill-act">On {v.on_mission}</span> : <span className="pv-cell-sub">Free</span>}</td>
                        <td className="pv-row-actions">
                          <button className="btn btn-sm btn-ghost" onClick={() => setEdit(v)}>Edit</button>
                          {v.active
                            ? <button className="btn btn-sm btn-ghost" disabled={busy === v.id || !!v.on_mission} title={v.on_mission ? 'Take it off the mission first' : undefined} onClick={() => setActive(v, false)}>Retire</button>
                            : <button className="btn btn-sm btn-sec" disabled={busy === v.id} onClick={() => setActive(v, true)}>Reactivate</button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </PvCard>

      <VehicleDialog vehicle={edit} onClose={() => setEdit(null)}
        onSaved={msg => { setEdit(null); push({kind: 'ok', text: msg}); void refresh(); }}/>
    </PvPage>
  );
}

function VehicleDialog({vehicle, onClose, onSaved}: {vehicle: OrgVehicle | 'new' | null; onClose: () => void; onSaved: (msg: string) => void}) {
  const isNew = vehicle === 'new';
  const v = isNew || !vehicle ? null : vehicle;
  const [f, setF] = useState({call_sign: '', make_model: '', plate: '', colour: '', armored: false, armor_grade: '', capacity: '4', region_code: ''});
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const k = vehicle === null ? null : isNew ? 'new' : v!.id;
  if (k !== key) {
    setKey(k); setErr(null);
    setF(v ? {call_sign: v.call_sign, make_model: v.make_model, plate: v.plate, colour: v.colour ?? '', armored: v.armored,
      armor_grade: v.armor_grade ?? '', capacity: String(v.capacity), region_code: v.region_code ?? ''}
      : {call_sign: '', make_model: '', plate: '', colour: '', armored: false, armor_grade: '', capacity: '4', region_code: ''});
  }
  if (vehicle === null) return null;

  const cap = Number(f.capacity);
  const region = f.region_code.trim().toUpperCase();
  const valid = f.call_sign.trim().length >= 1 && f.make_model.trim().length >= 2 && f.plate.trim().length >= 2
    && Number.isInteger(cap) && cap >= 1 && cap <= 20 && (!region || /^[A-Z]{2}(-[A-Z0-9]{1,4})?$/.test(region));
  const identityChanged = !!v && v.review_status === 'verified' && (
    v.make_model !== f.make_model.trim() || v.plate.replace(/\s/g, '').toUpperCase() !== f.plate.replace(/\s/g, '').toUpperCase()
    || v.armored !== f.armored || (v.armor_grade ?? '') !== f.armor_grade.trim());

  async function save() {
    setBusy(true); setErr(null);
    const dto: VehicleInput = {
      call_sign: f.call_sign.trim(), make_model: f.make_model.trim(), plate: f.plate.trim(),
      colour: f.colour.trim() || null, armored: f.armored, armor_grade: f.armored ? (f.armor_grade.trim() || null) : null,
      capacity: cap, region_code: region || null,
    };
    try {
      if (isNew) { await pvApi.createVehicle(dto); onSaved(`${dto.call_sign} added. Bravo Secure will verify it before it can go on a job.`); }
      else { const r = await pvApi.updateVehicle(v!.id, dto); onSaved(r.vehicle.review_status === 'pending' && v!.review_status !== 'pending' ? `${dto.call_sign} saved and sent back for review.` : `${dto.call_sign} saved.`); }
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  }

  const input = (label: string, name: keyof typeof f, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="pv-field">
      <span className="pv-label">{label}</span>
      <input className="pv-input" value={f[name] as string} onChange={e => setF(s => ({...s, [name]: e.target.value}))} {...extra}/>
    </label>
  );

  return (
    <PvDialog open title={isNew ? 'Add a vehicle' : `Edit ${v!.call_sign}`} busy={busy} onClose={onClose}
      description={isNew ? 'It starts "In review". Bravo Secure verifies it before it can go on a job.' : undefined}
      footer={<>
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn btn-pri" disabled={busy || !valid} onClick={save}>{busy ? 'Saving…' : isNew ? 'Add vehicle' : 'Save'}</button>
      </>}>
      <div className="pv-form">
        <div className="pv-form-2">
          {input('Call sign', 'call_sign', {maxLength: 24, placeholder: 'FS-01'})}
          {input('Plate', 'plate', {maxLength: 20, placeholder: 'Dubai A 12345'})}
        </div>
        {input('Make and model', 'make_model', {maxLength: 80, placeholder: 'Toyota Land Cruiser 300'})}
        <div className="pv-form-2">
          {input('Colour (optional)', 'colour', {maxLength: 40})}
          {input('Seats', 'capacity', {inputMode: 'numeric', maxLength: 2})}
        </div>
        <label className="pv-check">
          <input type="checkbox" checked={f.armored} onChange={e => setF(s => ({...s, armored: e.target.checked}))}/>
          Armoured vehicle
        </label>
        {f.armored && input('Armour grade (optional)', 'armor_grade', {maxLength: 20, placeholder: 'B6'})}
        {input('Region code (optional)', 'region_code', {maxLength: 7, placeholder: 'AE-DU'})}
        {identityChanged && <div className="pv-note" role="status">Changing the plate, make, model or armour sends this vehicle back to review, and takes it off any open mission.</div>}
        {err && <div className="pv-err" role="alert">{err}</div>}
      </div>
    </PvDialog>
  );
}
