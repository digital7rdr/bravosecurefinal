'use client';

/**
 * Region — the app's OrgRegionScreen on the web. The agency's one dispatch
 * region: client requests are matched to agencies in the same region, then
 * sent to the nearest. Same rule as the app: the region can only be changed to
 * the one this device is in right now (browser location, country from Mapbox,
 * a bounding box when that is unavailable).
 */

import {useState} from 'react';
import {NotGranted, useProvider} from '@/components/provider/ProviderShell';
import {PvCard, PvDialog, PvPage} from '@/components/provider/ui';
import {useToast} from '@/components/Toast';
import {
  REGIONS, REGION_NONE, actsAsAgency, agencyApi, agencyErrorText, isSupportedRegion, locateRegion,
  managerRegionTarget, regionName, useAgentMe,
} from '@/lib/provider/api-agency';

type Notice = {title: string; text: string} | null;

export default function ProviderRegion() {
  const {context, orgId, can} = useProvider();
  const granted = can('region');
  const self = actsAsAgency(context, orgId);
  // A manager's save goes to the agency the server resolves for them; only
  // allowed here when that can only be the selected one.
  const managerCanSave = !self && managerRegionTarget(context, orgId);
  const {data: me, error, mutate: reloadMe} = useAgentMe(orgId, granted && self);
  const {push} = useToast();
  const [saved, setSaved] = useState<string | null>(null);
  const [detected, setDetected] = useState<string | null | undefined>(undefined);
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  if (!granted) return <PvPage title="Region"><NotGranted what="Region"/></PvPage>;

  const canSave = self || managerCanSave;
  const current = self ? (saved ?? me?.agent.region_code ?? null) : saved;
  const dpaAccepted = self && !!me?.agent.dpa_accepted_at;

  async function detect(): Promise<string | null> {
    setLocating(true);
    try {
      const r = await locateRegion();
      setDetected(r);
      return r;
    } finally { setLocating(false); }
  }

  async function commit(code: string) {
    setSaving(code);
    try {
      // dpa_accepted only ever records an acceptance; false never withdraws one.
      const r = await agencyApi.setAgencyProfile({region_code: code, dpa_accepted: dpaAccepted});
      setSaved(r.region_code ?? code);
      if (self) void reloadMe();
      push({kind: 'ok', text: `Your dispatch region is now ${regionName(r.region_code ?? code)}. You will receive requests from clients there.`});
    } catch (e) {
      setNotice({title: 'Could not save', text: agencyErrorText(e)});
    } finally { setSaving(null); }
  }

  async function pick(code: string) {
    if (code === current || saving || locating) return;
    setSaving(code);
    const here = await detect();
    if (here === null) {
      setSaving(null);
      setNotice({title: 'Location needed', text: 'We could not read this device\'s location. Allow location access for this site in your browser and try again. You can only choose the region you are in now.'});
      return;
    }
    if (here !== code) {
      setSaving(null);
      const where = here === REGION_NONE ? 'outside the regions Bravo Secure covers' : regionName(here);
      setNotice({
        title: 'Region does not match',
        text: `This device is in ${where}, not ${regionName(code)}. You can only operate in the region you are in. Change it from ${regionName(code)}.`,
      });
      return;
    }
    await commit(code);
  }

  const detectedLabel = locating ? 'Checking…'
    : detected === undefined ? 'Not checked yet'
    : detected === null ? 'Location unavailable'
    : detected === REGION_NONE ? 'Outside supported regions'
    : regionName(detected);

  return (
    <PvPage title="Region"
      subtitle="Client requests are matched to agencies in the same region, then sent to the nearest one. Choose the region your agency operates in.">
      <div className="pv-grid">
        <PvCard title="Your dispatch region">
          <dl className="pv-facts pv-facts-col">
            <div><dt>Dispatch region</dt><dd className="pv-strong">
              {self ? (me ? regionName(current) : error ? 'Could not load' : '—') : current ? regionName(current) : 'Shown on the owner\'s account'}
            </dd></div>
            <div><dt>This device is in</dt><dd>{detectedLabel}</dd></div>
          </dl>
          <div className="pv-actions" style={{justifyContent: 'flex-start', marginTop: 14}}>
            <button className="btn btn-ghost" disabled={locating || !!saving} onClick={() => void detect()}>
              {locating ? 'Checking…' : 'Check my location'}
            </button>
            {self && me && !current && detected && isSupportedRegion(detected) && (
              <button className="btn btn-pri" disabled={!!saving} onClick={() => void commit(detected)}>
                {saving === detected ? 'Saving…' : `Use ${regionName(detected)}`}
              </button>
            )}
          </div>
          {!canSave && (
            <p className="pv-note" style={{marginTop: 14}}>
              Your account runs more than one agency, so this agency&apos;s region can only be changed here
              by its owner.
            </p>
          )}
        </PvCard>

        <PvCard title="Regions" pad={false}>
          <ul className="pv-list">
            {REGIONS.map(r => {
              const selected = current === r.code;
              const busy = saving === r.code;
              return (
                <li key={r.code}>
                  <div className="pv-list-row">
                    <span className="pv-mono pv-strong" style={{width: 32}}>{r.code}</span>
                    <span className="pv-list-main">
                      {r.name}
                      <span className="pv-list-sub">{r.currency}{detected === r.code ? ' · you are here' : ''}</span>
                    </span>
                    {selected
                      ? <span className="pill pill-ok">Current</span>
                      : canSave && (
                        <button className="btn btn-sm btn-ghost" disabled={!!saving || locating || (self && !me)} onClick={() => void pick(r.code)}>
                          {busy ? 'Checking…' : 'Choose'}
                        </button>
                      )}
                  </div>
                </li>
              );
            })}
          </ul>
        </PvCard>
      </div>

      <p className="pv-note" style={{marginTop: 18}}>
        With the wrong region you will not receive nearby requests. If your agency has moved, update the region
        from the new region.
      </p>

      <PvDialog open={!!notice} title={notice?.title ?? ''} onClose={() => setNotice(null)}
        description={notice?.text}
        footer={<button className="btn btn-pri" onClick={() => setNotice(null)}>OK</button>}/>
    </PvPage>
  );
}
