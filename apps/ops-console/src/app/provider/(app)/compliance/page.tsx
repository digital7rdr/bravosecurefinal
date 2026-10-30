'use client';

/**
 * Compliance — the app's OrgComplianceScreen on the web. The agency sends its
 * licence and insurance (for its dispatch region, with an expiry and the
 * document itself); Bravo Secure verifies each one before the agency can be
 * sent jobs. The data processing agreement is accepted here too.
 */

import Link from 'next/link';
import {useMemo, useState} from 'react';
import {useSWRConfig} from 'swr';
import {NotGranted, useProvider} from '@/components/provider/ProviderShell';
import {Empty, PvCard, PvPage, Stat} from '@/components/provider/ui';
import {useToast} from '@/components/Toast';
import {
  UPLOAD_TYPES, actsAsAgency, agencyApi, agencyErrorText, regionName, uploadProblem,
  useAgentMe, useComplianceDocs, type AgencyDocType, type ComplianceDoc,
} from '@/lib/provider/api-agency';
import {pvRoutes} from '@/lib/provider/routes';

const STATE: Record<ComplianceDoc['state'], {label: string; cls: string}> = {
  PENDING:  {label: 'In review', cls: 'pill-warn'},
  VERIFIED: {label: 'Verified',  cls: 'pill-ok'},
  REJECTED: {label: 'Rejected',  cls: 'pill-err'},
  EXPIRED:  {label: 'Expired',   cls: 'pill-err'},
};

const DOC_LABEL: Record<string, string> = {licence: 'Licence', insurance: 'Insurance', armed_permit: 'Armed permit'};

function daysLeft(iso: string): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.round((t - Date.now()) / 86_400_000);
}

function dateOnly(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function plusYears(n: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + n);
  return dateOnly(d);
}

export default function ProviderCompliance() {
  const {context, orgId, can} = useProvider();
  const granted = can('compliance');
  const self = actsAsAgency(context, orgId);
  const on = granted && self;
  const {data: me, mutate: reloadMe} = useAgentMe(orgId, on);
  const {data: docs, error} = useComplianceDocs(orgId, on);
  const {mutate} = useSWRConfig();
  const {push} = useToast();

  if (!granted) return <PvPage title="Compliance"><NotGranted what="Compliance"/></PvPage>;

  if (!self) {
    return (
      <PvPage title="Compliance">
        <PvCard>
          <p className="text-sm text-t3" style={{margin: 0, lineHeight: 1.6}}>
            Agency documents are sent and tracked from the agency owner&apos;s account. Ask the owner to
            sign in to this console, or to use Compliance in the app.
          </p>
        </PvCard>
      </PvPage>
    );
  }

  const region = me?.agent.region_code ?? null;
  const list = docs ?? [];
  const refreshDocs = () => mutate(['pv', orgId, 'compliance-docs']);

  return (
    <PvPage title="Compliance"
      subtitle="Send your licence and insurance for your dispatch region. Bravo Secure checks each one before your agency can be sent jobs.">
      <div className="kpi-row" style={{gridTemplateColumns: 'repeat(4, minmax(0, 1fr))'}}>
        <Stat label="Verified" value={docs ? list.filter(d => d.state === 'VERIFIED').length : '—'} tone="ok"/>
        <Stat label="In review" value={docs ? list.filter(d => d.state === 'PENDING').length : '—'} tone="warn"/>
        <Stat label="Rejected or expired" value={docs ? list.filter(d => d.state === 'REJECTED' || d.state === 'EXPIRED').length : '—'} tone="err"/>
        <Stat label="Dispatch region" value={me ? regionName(region) : '—'}/>
      </div>

      <div className="pv-grid">
        <AgreementCard region={region} acceptedAt={me?.agent.dpa_accepted_at ?? null} loaded={!!me}
          canRegion={can('region')}
          onSaved={() => { void reloadMe(); }}/>
        <SubmitCard region={region} loaded={!!me} canRegion={can('region')}
          onSubmitted={msg => { push({kind: 'ok', text: msg}); void refreshDocs(); }}/>
      </div>

      <div style={{height: 18}}/>
      <PvCard title="Your documents" pad={false}>
        {error && !docs ? <Empty>{agencyErrorText(error)}</Empty>
          : !docs ? <Empty>Loading…</Empty>
          : list.length === 0 ? <Empty>No documents yet. Send your licence and insurance so your agency can be sent jobs.</Empty>
          : (
            <div className="pv-table-wrap">
              <table className="pv-table">
                <thead><tr><th>Document</th><th>Region</th><th>Reference</th><th>Expires</th><th>Status</th></tr></thead>
                <tbody>
                  {list.map(d => {
                    const s = STATE[d.state] ?? {label: d.state, cls: ''};
                    const left = daysLeft(d.expires_at);
                    return (
                      <tr key={d.id}>
                        <td className="pv-strong">{DOC_LABEL[d.doc_type] ?? d.doc_type}</td>
                        <td>{regionName(d.region_code)}</td>
                        <td className="pv-mono">{d.reference ?? '—'}</td>
                        <td>
                          {d.expires_at ? new Date(d.expires_at).toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric'}) : '—'}
                          {left !== null && <div className="pv-cell-sub">{left < 0 ? 'Expired' : `${left} days left`}</div>}
                        </td>
                        <td>
                          <span className={`pill ${s.cls}`}>{s.label}</span>
                          {d.reject_reason && <div className="pv-cell-sub" style={{maxWidth: 280}}>{d.reject_reason}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </PvCard>
    </PvPage>
  );
}

function RegionNeeded({canRegion}: {canRegion: boolean}) {
  return (
    <div className="pv-note" role="status">
      Set your dispatch region first{canRegion ? <> on the <Link href={pvRoutes.region}>Region</Link> page</> : ' (ask the agency owner)'}.
      Documents are checked for that region.
    </div>
  );
}

function AgreementCard({region, acceptedAt, loaded, canRegion, onSaved}: {
  region: string | null; acceptedAt: string | null; loaded: boolean; canRegion: boolean; onSaved: () => void;
}) {
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const {push} = useToast();

  async function save() {
    if (!region) return;
    setBusy(true); setErr(null);
    try {
      await agencyApi.setAgencyProfile({region_code: region, dpa_accepted: true});
      push({kind: 'ok', text: 'Data processing agreement accepted.'});
      onSaved();
    } catch (e) { setErr(agencyErrorText(e)); } finally { setBusy(false); }
  }

  return (
    <PvCard title="Region and data agreement">
      <dl className="pv-facts pv-facts-col">
        <div><dt>Dispatch region</dt><dd>{loaded ? regionName(region) : '—'}{canRegion && loaded ? <> · <Link href={pvRoutes.region}>Change</Link></> : null}</dd></div>
        <div><dt>Data agreement</dt><dd>{!loaded ? '—' : acceptedAt ? `Accepted ${new Date(acceptedAt).toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric'})}` : 'Not accepted yet'}</dd></div>
      </dl>
      {loaded && !acceptedAt && (
        <div className="pv-form" style={{marginTop: 14}}>
          <label className="pv-check">
            <input type="checkbox" checked={ticked} onChange={e => setTicked(e.target.checked)}/>
            I accept the Data Processing Agreement. My agency will receive clients&apos; exact pick-up and live location for jobs it is sent.
          </label>
          {!region && <RegionNeeded canRegion={canRegion}/>}
          {err && <div className="pv-err" role="alert">{err}</div>}
          <div>
            <button className="btn btn-pri" disabled={busy || !ticked || !region} onClick={save}>
              {busy ? 'Saving…' : 'Accept agreement'}
            </button>
          </div>
        </div>
      )}
    </PvCard>
  );
}

function SubmitCard({region, loaded, canRegion, onSubmitted}: {
  region: string | null; loaded: boolean; canRegion: boolean; onSubmitted: (msg: string) => void;
}) {
  const [docType, setDocType] = useState<AgencyDocType>('licence');
  const [reference, setReference] = useState('');
  const [expires, setExpires] = useState(() => plusYears(1));
  const [file, setFile] = useState<File | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [busy, setBusy] = useState<'upload' | 'submit' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const tomorrow = useMemo(() => { const d = new Date(); d.setDate(d.getDate() + 1); return dateOnly(d); }, []);
  const fileProblem = file ? uploadProblem(file) : null;
  const expiryOk = !!expires && expires >= tomorrow;
  const ready = !!region && !!file && !fileProblem && expiryOk && !busy;

  async function submit() {
    if (!region || !file) return;
    const problem = uploadProblem(file);
    if (problem) { setErr(problem); return; }
    setErr(null);
    try {
      setBusy('upload');
      const fileUrl = await agencyApi.uploadFile(file);
      setBusy('submit');
      // End of the chosen day, so the document is valid through that date.
      const expiresAt = new Date(`${expires}T23:59:59`).toISOString();
      await agencyApi.submitCompliance({
        doc_type: docType, region_code: region, expires_at: expiresAt,
        reference: reference.trim() || undefined, file_url: fileUrl,
      });
      setReference(''); setFile(null); setInputKey(k => k + 1); setExpires(plusYears(1));
      onSubmitted(`${docType === 'licence' ? 'Licence' : 'Insurance'} sent. Bravo Secure will review it.`);
    } catch (e) { setErr(agencyErrorText(e)); } finally { setBusy(null); }
  }

  return (
    <PvCard title="Send a document">
      <div className="pv-form">
        <div className="pv-seg" role="radiogroup" aria-label="Document">
          {(['licence', 'insurance'] as const).map(t => (
            <button key={t} className={docType === t ? 'on' : ''} aria-pressed={docType === t} onClick={() => setDocType(t)}>
              {t === 'licence' ? 'Licence' : 'Insurance'}
            </button>
          ))}
        </div>
        <div className="pv-note">Region: {loaded ? regionName(region) : '—'}. Documents are checked for your dispatch region.</div>
        <div className="pv-form-2">
          <label className="pv-field">
            <span className="pv-label">Reference or certificate number (optional)</span>
            <input className="pv-input" value={reference} maxLength={256} placeholder="SIA-12345"
              onChange={e => setReference(e.target.value)}/>
          </label>
          <label className="pv-field">
            <span className="pv-label">Valid until</span>
            <input className="pv-input" type="date" value={expires} min={tomorrow} onChange={e => setExpires(e.target.value)}/>
          </label>
        </div>
        <div className="pv-seg" aria-label="Quick expiry">
          {[1, 2, 3].map(y => (
            <button key={y} className={expires === plusYears(y) ? 'on' : ''} onClick={() => setExpires(plusYears(y))}>{y} year{y > 1 ? 's' : ''}</button>
          ))}
        </div>
        <label className="pv-field">
          <span className="pv-label">Document (photo or PDF, up to 25 MB)</span>
          <input key={inputKey} className="pv-input" type="file" accept={UPLOAD_TYPES.join(',')}
            onChange={e => { setFile(e.target.files?.[0] ?? null); setErr(null); }}/>
        </label>
        {loaded && !region && <RegionNeeded canRegion={canRegion}/>}
        {fileProblem && <div className="pv-err" role="alert">{fileProblem}</div>}
        {!expiryOk && <div className="pv-err" role="alert">The expiry date must be in the future.</div>}
        {err && <div className="pv-err" role="alert">{err}</div>}
        <div>
          <button className="btn btn-pri" disabled={!ready} onClick={submit}>
            {busy === 'upload' ? 'Uploading…' : busy === 'submit' ? 'Sending…' : 'Send for review'}
          </button>
        </div>
      </div>
    </PvCard>
  );
}
