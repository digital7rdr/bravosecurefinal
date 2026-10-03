'use client';

/**
 * Secure Pro (Bravo Web App): request a dedicated protection plan, follow the
 * proposal, accept and activate it with credits, ask for protection dates, and
 * message the Bravo Secure team. Same routes as the app (/pro-applications).
 */
import {useState} from 'react';
import useSWR, {useSWRConfig} from 'swr';
import {ClientsOnly, useWeb} from '@/components/web/WebShell';
import {ConfirmDialog, Empty, PvCard, PvPage} from '@/components/provider/ui';
import {useToast} from '@/components/Toast';
import {useBalance, useProMe, webApi, type ProApplication, type ProCreateBody} from '@/lib/web/api';
import {webErrorText} from '@/lib/web/labels';
import {credits} from '@/lib/provider/labels';

const USES: Array<[string, string]> = [
  ['family_support', 'Family protection'], ['executive_protection', 'Executive protection'],
  ['travel_protection', 'Travel protection'], ['residential_support', 'Residential protection'],
  ['event_support', 'Event protection'], ['custom', 'Something else'],
];
const SERVICES: Array<[string, string]> = [
  ['secure_transfers', 'Secure transfers'], ['medical_support', 'Medical support'],
  ['advance_assessment', 'Advance assessment'], ['secure_communications', 'Secure communications'],
  ['journey_monitoring', 'Journey monitoring'], ['event_support', 'Event support'],
  ['residential_support', 'Residential support'], ['other', 'Other'],
];
const GENDERS: Array<[string, string]> = [['no_preference', 'No preference'], ['male', 'Male'], ['female', 'Female'], ['mixed', 'Mixed']];

const STATUS: Record<ProApplication['status'], {label: string; cls: string; text: string}> = {
  PENDING_PROPOSAL:   {label: 'In review', cls: 'pill-warn', text: 'Bravo Secure is preparing your proposal.'},
  PROPOSAL_CREATED:   {label: 'Proposal ready', cls: 'pill-act', text: 'Your proposal is ready. Accept it, or ask for changes.'},
  REVISION_REQUESTED: {label: 'Changes requested', cls: 'pill-warn', text: 'Bravo Secure is updating the proposal with your changes.'},
  ACCEPTED:           {label: 'Accepted', cls: 'pill-act', text: 'Activate the plan to start your protection. The plan price is taken from your credits once.'},
  ACTIVE:             {label: 'Active', cls: 'pill-ok', text: 'Your plan is active. Ask for protection on the dates you need.'},
  EXPIRED:            {label: 'Expired', cls: '', text: 'This plan has ended.'},
  REJECTED:           {label: 'Declined', cls: 'pill-err', text: 'Bravo Secure could not offer this plan.'},
  CANCELLED:          {label: 'Withdrawn', cls: '', text: 'You withdrew this request.'},
};

const day = (d: string | null | undefined) => (d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric'}) : '—');

export default function WebPro() {
  const {client} = useWeb();
  const {data, error} = useProMe(client);
  const app = data?.application ?? null;
  const live = app && !['EXPIRED', 'REJECTED', 'CANCELLED'].includes(app.status);

  if (!client) return <PvPage title="Secure Pro"><ClientsOnly/></PvPage>;
  return (
    <PvPage title="Secure Pro" subtitle="A dedicated protection team for a period you choose, planned with Bravo Secure.">
      {error ? <PvCard><Empty>Could not load Secure Pro. It will retry automatically.</Empty></PvCard>
        : !data ? <PvCard><Empty>Loading…</Empty></PvCard>
        : live && app ? <Plan app={app}/>
        : <Apply previous={app}/>}
    </PvPage>
  );
}

function Apply({previous}: {previous: ProApplication | null}) {
  const {mutate} = useSWRConfig();
  const {push} = useToast();
  const [f, setF] = useState<ProCreateBody>({
    intended_use: 'family_support', duration_months: 1, start_date: new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10),
    coverage_area: '', cpo_count: 1, driver_count: 0, support_staff_count: 0, gender_preference: 'no_preference', services: [], notes: '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof ProCreateBody>(k: K, v: ProCreateBody[K]) => setF(s => ({...s, [k]: v}));
  const valid = f.coverage_area.trim().length >= 3 && !!f.start_date && f.cpo_count + f.driver_count + f.support_staff_count > 0;

  async function submit() {
    setBusy(true); setErr(null);
    try {
      await webApi.proCreate({...f, coverage_area: f.coverage_area.trim(), notes: f.notes?.trim() || undefined});
      push({kind: 'ok', text: 'Request sent. Bravo Secure will prepare your proposal.'});
      void mutate(['web', 'pro']);
    } catch (e) { setErr(webErrorText(e)); setBusy(false); }
  }

  const num = (label: string, k: 'cpo_count' | 'driver_count' | 'support_staff_count') => (
    <label className="pv-field"><span className="pv-label">{label}</span>
      <input className="pv-input" type="number" min={0} max={50} value={f[k]} onChange={e => set(k, Math.max(0, Math.min(50, Number(e.target.value) || 0)))}/>
    </label>
  );

  return (
    <div className="pv-grid">
      <PvCard title="Request a plan">
        {previous && <p className="pv-hint" style={{marginTop: 0}}>Your last request: {STATUS[previous.status].label.toLowerCase()}.</p>}
        <div className="pv-form">
          <label className="pv-field"><span className="pv-label">What is it for?</span>
            <select className="pv-input" value={f.intended_use} onChange={e => set('intended_use', e.target.value)}>
              {USES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label className="pv-field"><span className="pv-label">Start date</span>
            <input className="pv-input" type="date" value={f.start_date} min={new Date().toISOString().slice(0, 10)} onChange={e => set('start_date', e.target.value)}/>
          </label>
          <label className="pv-field"><span className="pv-label">How many months?</span>
            <input className="pv-input" type="number" min={1} max={60} value={f.duration_months ?? 1} onChange={e => set('duration_months', Math.max(1, Math.min(60, Number(e.target.value) || 1)))}/>
          </label>
          <label className="pv-field"><span className="pv-label">Where? (city, area or route)</span>
            <input className="pv-input" value={f.coverage_area} maxLength={300} onChange={e => set('coverage_area', e.target.value)} placeholder="e.g. Dubai Marina and Downtown"/>
          </label>
          <div className="web-counters">
            {num('Officers', 'cpo_count')}{num('Drivers', 'driver_count')}{num('Support staff', 'support_staff_count')}
          </div>
          <label className="pv-field"><span className="pv-label">Officer preference</span>
            <select className="pv-input" value={f.gender_preference} onChange={e => set('gender_preference', e.target.value)}>
              {GENDERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <span className="pv-label">Also needed</span>
          {SERVICES.map(([k, l]) => (
            <label key={k} className="pv-check">
              <input type="checkbox" checked={f.services.includes(k)}
                onChange={e => set('services', e.target.checked ? [...f.services, k] : f.services.filter(x => x !== k))}/>
              <span>{l}</span>
            </label>
          ))}
          <label className="pv-field"><span className="pv-label">Anything else?</span>
            <textarea className="pv-input" rows={3} maxLength={2000} value={f.notes ?? ''} onChange={e => set('notes', e.target.value)}/>
          </label>
          {err && <div className="pv-err" role="alert">{err}</div>}
          <button className="btn btn-pri" disabled={!valid || busy} onClick={() => void submit()}>{busy ? 'Sending…' : 'Send request'}</button>
        </div>
      </PvCard>
      <PvCard title="How it works">
        <ol className="pv-steps">
          <li><span>You tell us what you need</span></li>
          <li><span>Bravo Secure sends a proposal with the team and the price</span></li>
          <li><span>You accept and activate it with your credits</span></li>
          <li><span>You ask for protection on the dates you need</span></li>
        </ol>
      </PvCard>
    </div>
  );
}

function Plan({app}: {app: ProApplication}) {
  const {mutate} = useSWRConfig();
  const {push} = useToast();
  const {data: balance} = useBalance();
  const s = STATUS[app.status];
  const p = app.proposal;
  const [confirm, setConfirm] = useState<'accept' | 'activate' | 'withdraw' | null>(null);
  const [changes, setChanges] = useState('');
  const [dates, setDates] = useState<string[]>([]);
  const [newDate, setNewDate] = useState('');
  const [msg, setMsg] = useState('');
  const refresh = () => mutate((k: unknown) => Array.isArray(k) && k[0] === 'web');
  const active = app.status === 'ACTIVE';
  const {data: missions} = useSWR(active ? ['web', 'pro-missions', app.id] : null, () => webApi.proMissions(app.id));
  const {data: thread} = useSWR(['web', 'pro-msgs', app.id], () => webApi.proMessages(app.id), {refreshInterval: 30_000});
  const owner = !app.via_owner;

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); push({kind: 'ok', text: ok}); } catch (e) { push({kind: 'err', text: webErrorText(e)}); }
    setConfirm(null); void refresh();
  };

  return (
    <div className="pv-grid pv-grid-wide">
      <div className="pv-col">
        <PvCard title="Your plan" right={<span className={`pill ${s.cls}`}>{s.label}</span>}>
          <p style={{marginTop: 0}}>{s.text}</p>
          {app.via_owner && <p className="pv-hint">This plan belongs to {app.via_owner.name}; you are covered as a family member.</p>}
          <dl className="pv-facts pv-facts-col">
            <div><dt>Area</dt><dd>{app.coverage_area}</dd></div>
            <div><dt>Team asked for</dt><dd>{app.cpo_count} officers · {app.driver_count} drivers · {app.support_staff_count} support</dd></div>
            {active && <div><dt>Covered until</dt><dd>{day(app.covered_until ?? app.current_period_end)}</dd></div>}
          </dl>
        </PvCard>

        {p && !active && (
          <PvCard title={`Proposal ${p.proposal_number}`}>
            <dl className="pv-facts pv-facts-col">
              <div><dt>Coverage</dt><dd>{day(p.coverage_start)} – {day(p.coverage_end)}</dd></div>
              <div><dt>Team</dt><dd>{p.assigned_team.map(t => `${t.count} ${t.label ?? t.role}`).join(' · ') || '—'}</dd></div>
              <div><dt>Price</dt><dd className="pv-strong">{credits(p.total_credits)}</dd></div>
              <div><dt>Valid until</dt><dd>{day(p.valid_until)}</dd></div>
            </dl>
            {p.terms && <p className="pv-hint" style={{whiteSpace: 'pre-wrap', margin: '12px 0'}}>{p.terms}</p>}
            {owner && app.status === 'PROPOSAL_CREATED' && (
              <div className="pv-form">
                <button className="btn btn-pri" onClick={() => setConfirm('accept')}>Accept proposal</button>
                <textarea className="pv-input" rows={2} value={changes} maxLength={2000} placeholder="Or describe the changes you need"
                  onChange={e => setChanges(e.target.value)}/>
                <button className="btn btn-sec" disabled={changes.trim().length < 3}
                  onClick={() => void act(() => webApi.proRequestChanges(app.id, changes.trim()), 'Your changes were sent.')}>Ask for changes</button>
              </div>
            )}
            {owner && app.status === 'ACCEPTED' && (
              <>
                {balance && balance.bravo_credits < p.total_credits && (
                  <p className="pv-err">Your credits ({credits(balance.bravo_credits)}) do not cover the plan. Top up in the Bravo Secure app first.</p>
                )}
                <button className="btn btn-pri" disabled={!!balance && balance.bravo_credits < p.total_credits}
                  onClick={() => setConfirm('activate')}>Activate for {credits(p.total_credits)}</button>
              </>
            )}
          </PvCard>
        )}

        {active && (
          <PvCard title="Protection dates">
            <div className="pv-form">
              <div className="web-dates">
                <input className="pv-input" type="date" value={newDate} min={new Date().toISOString().slice(0, 10)}
                  max={(app.covered_until ?? app.current_period_end ?? '').slice(0, 10) || undefined}
                  onChange={e => setNewDate(e.target.value)}/>
                <button className="btn btn-sec" disabled={!newDate || dates.includes(newDate) || dates.length >= 31}
                  onClick={() => { setDates(d => [...d, newDate].sort()); setNewDate(''); }}>Add date</button>
              </div>
              {dates.length > 0 && (
                <div className="web-chips">
                  {dates.map(d => <button key={d} className="pill" onClick={() => setDates(x => x.filter(y => y !== d))} title="Remove">{day(d)} ×</button>)}
                </div>
              )}
              <button className="btn btn-pri" disabled={dates.length === 0}
                onClick={() => void act(async () => { await webApi.proRequestDates(app.id, dates); setDates([]); }, 'Dates sent to Bravo Secure.')}>
                Ask for protection on {dates.length || ''} date{dates.length === 1 ? '' : 's'}
              </button>
            </div>
            {!missions ? <Empty>Loading…</Empty> : missions.missions.length === 0 ? <Empty>No dates requested yet.</Empty> : (
              <ul className="pv-list" style={{marginTop: 12}}>
                {missions.missions.map(m => (
                  <li key={m.id} className="pv-list-row">
                    <span className="pv-list-main">
                      <span>{m.mission_dates.map(day).join(', ')}</span>
                      <span className="pv-list-sub">{m.ops_note ?? m.note ?? ''}</span>
                    </span>
                    <span className="pill">{m.status.toLowerCase()}</span>
                    {(m.status === 'REQUESTED' || m.status === 'SCHEDULED') && (
                      <button className="btn btn-sm btn-ghost" onClick={() => void act(() => webApi.proCancelDates(app.id, m.id), 'Dates released.')}>Release</button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </PvCard>
        )}
        {owner && ['PENDING_PROPOSAL', 'PROPOSAL_CREATED', 'REVISION_REQUESTED', 'ACCEPTED'].includes(app.status) && (
          <button className="btn btn-ghost" onClick={() => setConfirm('withdraw')}>Withdraw request</button>
        )}
      </div>

      <PvCard title="Messages with Bravo Secure">
        {!thread ? <Empty>Loading…</Empty> : (
          <div className="web-thread">
            {thread.messages.length === 0 && <Empty>No messages yet.</Empty>}
            {thread.messages.map(m => (
              <div key={m.id} className={`web-bubble ${m.sender === 'client' ? 'mine' : ''}`}>
                <div>{m.body}</div>
                <div className="pv-cell-sub">{new Date(m.created_at).toLocaleString('en-GB', {day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'})}</div>
              </div>
            ))}
          </div>
        )}
        <form className="web-compose" onSubmit={e => {
          e.preventDefault();
          if (!msg.trim()) return;
          void act(async () => { await webApi.proSendMessage(app.id, msg.trim()); setMsg(''); }, 'Message sent.');
        }}>
          <input className="pv-input" value={msg} maxLength={2000} onChange={e => setMsg(e.target.value)} placeholder="Write to the Bravo Secure team"/>
          <button className="btn btn-pri" disabled={!msg.trim()}>Send</button>
        </form>
      </PvCard>

      <ConfirmDialog open={confirm === 'accept'} title="Accept this proposal?"
        description="You can activate the plan afterwards. Nothing is charged yet."
        confirmLabel="Accept" onClose={() => setConfirm(null)}
        onConfirm={() => act(() => webApi.proAccept(app.id), 'Proposal accepted.')}/>
      <ConfirmDialog open={confirm === 'activate'} title={`Activate for ${credits(p?.total_credits)}?`}
        description="The plan price is taken from your Bravo credits once, and your protection period starts."
        confirmLabel="Activate plan" onClose={() => setConfirm(null)}
        onConfirm={() => act(() => webApi.proActivate(app.id), 'Your Secure Pro plan is active.')}/>
      <ConfirmDialog open={confirm === 'withdraw'} title="Withdraw your request?" danger
        description="Nothing has been charged. You can send a new request at any time."
        confirmLabel="Withdraw" onClose={() => setConfirm(null)}
        onConfirm={() => act(() => webApi.proCancel(app.id), 'Request withdrawn.')}/>
    </div>
  );
}
