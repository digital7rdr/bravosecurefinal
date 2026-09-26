'use client';

/**
 * Pro Management — the central control center for Bravo Secure Pro
 * operations: internal Organisations, the approved-CPO pool (availability-
 * checked per date window), and CPO ↔ Pro-member protection assignments
 * (overlap-safe; each carries the mission code the CPO enters after login).
 * Pro missions carry NO payout — completing just finishes them.
 */
import {useMemo, useState, type CSSProperties} from 'react';
import {useRouter} from 'next/navigation';
import {CopyId} from '@/components/CopyId';
import {PageHeader} from '@/components/PageHeader';
import {RouteTabs} from '@/components/RouteTabs';
import {StatusTabs} from '@/components/StatusTabs';
import {routes} from '@/lib/routes';
import {
  ApiError, opsDataApi, proAppsApi, proFleetApi, proMgmtApi, useOpsMe, useProApplications,
  useProAssignments, useProFleet, useProMissionRequests, useProOrgs, useProPool,
  useProResources,
  type ProMissionRequestRow, type ProOrgRow, type ProPoolCpo, type ProResourceKind,
  type ProReservedTodayRow,
} from '@/lib/api';
import {canDecideProApplication} from '@/lib/rbac';
import {reservedDateAlert} from '@/lib/proapps';
import {formatDateUtc, formatDateTimeShortUtc} from '@/lib/datetime';

const inputStyle: CSSProperties = {
  height: 38, borderRadius: 8, background: 'var(--surf-3)',
  border: '1px solid var(--bd-2)', padding: '0 12px', color: 'var(--tx-1)',
  fontFamily: 'var(--font-sans)', fontSize: 13, outline: 'none', width: '100%',
};
const labelStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: 1.2,
  color: 'var(--tx-3)', fontWeight: 700, textTransform: 'uppercase',
  display: 'block', marginBottom: 6,
};

function today(): string { return new Date().toISOString().slice(0, 10); }

/**
 * E2E-08 — "what protection is reserved right now, and is it actually covered?"
 *
 * Ops had no answer to this anywhere. The client's calendar painted a reserved
 * date as booked, the team chip said ON DUTY, and if nobody had been assigned —
 * or the day arrived and nothing activated — the failure was silent on every
 * surface until the client called.
 *
 * So this panel is not a list, it is a triage board. Two states are FAILURES
 * and are given the loudest treatment on the page, because a row that merely
 * scrolls past is exactly the outcome this fix exists to prevent:
 *
 *   NO OFFICERS   no assignment covers the row's OWN date — reserved, nobody
 *                 coming. Fires for tomorrow too, which is the point: a day's
 *                 notice is what makes it fixable.
 *   NOT ACTIVATED today's date with `activated_at` null — the day came and the
 *                 mission never started. Only meaningful for `is_today`: a
 *                 tomorrow row has not had its chance yet, and flagging it
 *                 would train operators to ignore the flag.
 *
 * Coverage is read from `officers_on_date`, never `officers_today` — the two
 * differ by one word and the wrong one cries wolf on every staffed tomorrow
 * row. `reservedDateAlert` carries the full reasoning.
 */
function ReservedTodayPanel({
  rows, canDecide, busyId, onOpenPlan, onCancel,
}: {
  rows: ProReservedTodayRow[];
  canDecide: boolean;
  /**
   * The mission currently being acted on, or null. Keyed rather than a page-
   * global `busy`: this panel lists several independent reservations, and a
   * single boolean greyed EVERY row's control while one cancel was in flight,
   * which reads as "the page broke" rather than "that one is working".
   */
  busyId: string | null;
  onOpenPlan: (applicationId: string) => void;
  onCancel: (row: ProReservedTodayRow) => void;
}) {
  const problems = rows.filter(r => reservedDateAlert(r) !== null);

  return (
    <div className="card" style={{border: problems.length > 0 ? '1px solid var(--warn, #F5A524)' : undefined}}>
      <div className="card-header">
        <div className="card-header-title"><span className="bar" />RESERVED · TODAY &amp; TOMORROW</div>
        <div className="card-header-act">
          {rows.length === 0 ? 'NONE'
            : problems.length > 0 ? `${problems.length} NEED ATTENTION · ${rows.length} TOTAL`
            : `${rows.length} COVERED`}
        </div>
      </div>

      {rows.length === 0 ? (
        <div style={{padding: '16px 18px', color: 'var(--tx-3)', fontSize: 12.5}}>
          No Secure Pro dates reserved for today or tomorrow. A reserved date appears here as soon
          as it is scheduled, so an uncovered one cannot pass unnoticed.
        </div>
      ) : (
        rows.map(r => {
          // `no_officers` outranks `not_activated` — see reservedDateAlert.
          const alert = reservedDateAlert(r);
          const noOfficers = alert === 'no_officers';
          const notActivated = alert === 'not_activated';
          const failing = alert !== null;
          return (
            <div
              key={r.id}
              style={{
                padding: '12px 16px', borderTop: '1px solid var(--bd-2)',
                background: failing ? 'rgba(245,165,36,0.06)' : undefined,
              }}>
              <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap'}}>
                <span className={`pill ${r.is_today ? 'pill-act pill-live' : 'pill'}`}>
                  {r.is_today ? '● TODAY' : 'TOMORROW'}
                </span>
                <div style={{flex: '1 1 200px', minWidth: 0}}>
                  <div style={{fontWeight: 700, fontSize: 13, color: 'var(--tx-1)'}}>
                    {r.member_name ?? 'Member'}
                  </div>
                  <div style={{fontSize: 11, color: 'var(--tx-3)', marginTop: 3}}>
                    {/* `date`, not `first_date`: the latter is the min over ALL
                        mission dates and reads as a past day on a multi-date
                        reservation. */}
                    {formatDateUtc(r.date)}
                    {r.mission_dates.length > 1 ? ` · ${r.mission_dates.length} dates` : ''}
                  </div>
                </div>

                {/* Coverage — the founder's actual question, answered as a number. */}
                {noOfficers ? (
                  <span className="pill pill-err pill-live" title="Reserved, but no officer assignment covers this date">
                    ⚠ NO OFFICERS ASSIGNED
                  </span>
                ) : (
                  <span className="pill pill-ok">
                    {r.officers_on_date} OFFICER{r.officers_on_date > 1 ? 'S' : ''} ON COVER
                  </span>
                )}

                {r.activated_at ? (
                  <span className="pill pill-ok" title={`Activated ${formatDateTimeShortUtc(r.activated_at)}`}>
                    ACTIVATED {formatDateTimeShortUtc(r.activated_at)}
                  </span>
                ) : notActivated ? (
                  <span className="pill pill-warn pill-live" title="The reserved day has arrived and no session has started">
                    ⚠ NOT ACTIVATED
                  </span>
                ) : (
                  <span className="pill" style={{color: 'var(--tx-3)'}}>NOT DUE YET</span>
                )}

                <div style={{display: 'flex', gap: 8, marginLeft: 'auto', alignItems: 'center'}}>
                  {canDecide ? (
                    <button
                      className="btn btn-danger btn-sm"
                      disabled={busyId !== null}
                      onClick={() => onCancel(r)}>
                      {busyId === r.id ? 'CANCELLING…' : 'CANCEL RESERVATION'}
                    </button>
                  ) : (
                    // Same convention as /sos: say why the control is absent
                    // rather than leaving an unexplained gap where every other
                    // operator sees a button.
                    <span
                      style={{fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--tx-3)'}}
                      title="POST /ops/pro-applications/:id/missions/:missionId/cancel requires SUPERVISOR or ADMIN">
                      SUPERVISOR+ TO CANCEL
                    </span>
                  )}
                  <button className="btn btn-ghost btn-sm" onClick={() => onOpenPlan(r.application_id)}>
                    OPEN PLAN →
                  </button>
                </div>
              </div>

              {failing ? (
                <div style={{fontSize: 11.5, color: 'var(--warn, #F5A524)', marginTop: 8}}>
                  {noOfficers
                    ? 'The client\'s calendar shows this date as booked. Assign officers on the plan, or cancel the reservation so they are told.'
                    : 'The reserved day has started but no protection session has activated. Check the client and the assigned officer are both reachable.'}
                </div>
              ) : null}

              {r.note ? (
                <div style={{fontSize: 12, color: 'var(--tx-2)', marginTop: 7, fontStyle: 'italic'}}>“{r.note}”</div>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}

// The section list is the ROUTE set now (see the tabs below); it stays here as
// the single source of the section union the route pages pass in.
export const SECTIONS = ['REQUESTS', 'ASSIGNMENTS', 'CPO POOL', 'ORGANIZATIONS', 'FLEET', 'RESOURCES'] as const;

/** IA-02 — never the bare word "Pro": this is Secure Pro, the plan product. */
const SECTION_TITLES: Record<(typeof SECTIONS)[number], string> = {
  REQUESTS:      'Secure Pro — Protection Requests',
  ASSIGNMENTS:   'Secure Pro — Scheduled Assignments',
  'CPO POOL':    'Secure Pro — CPO Pool',
  ORGANIZATIONS: 'Secure Pro — Organisations',
  FLEET:         'Secure Pro — Fleet',
  RESOURCES:     'Secure Pro — Resources',
};

const SECTION_SUBTITLES: Record<(typeof SECTIONS)[number], string> = {
  REQUESTS:      'What protection is running today, and the dates still waiting on officers. Each assignment carries the mission code the CPO enters after login.',
  ASSIGNMENTS:   'Officer-to-member assignments already scheduled. Date-windowed and overlap-safe. Pro missions carry no payout — completing one just finishes it.',
  'CPO POOL':    'Approved officers available to Secure Pro, checked against the date window you are staffing.',
  ORGANIZATIONS: 'INTERNAL delivery organisations for Secure Pro. Not the provider agencies that receive Lite dispatch offers — those live under People.',
  FLEET:         'Vehicles assignable to a Secure Pro plan.',
  RESOURCES:     'Non-vehicle inventory assignable to a plan: radios, medical kits, comms equipment.',
};
type Section = (typeof SECTIONS)[number];

/**
 * IA-01/IA-12 — Secure Pro delivery, one SECTION per route.
 *
 * This was a single 1,099-line page holding six tabs in `useState`, filed in
 * the rail as one item called "Pro Management" — so an operator could not link
 * a colleague to the CPO pool, Back left the page instead of the tab, and a
 * refresh always landed on Requests. The internals are unchanged; the section
 * is now a prop supplied by six thin route pages, and the chips are real links.
 */
export function ProManagement({section}: {section: Section}) {
  const router = useRouter();
  const {data: me} = useOpsMe();
  const canDecide = canDecideProApplication(me?.admin?.role);

  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Incoming protection-date requests (the global queue — 2s cadence).
  const {data: reqData, error: reqError, mutate: mutateReqs} = useProMissionRequests();
  // Assign-officers modal for a request.
  const [reqFor, setReqFor] = useState<ProMissionRequestRow | null>(null);
  const [reqPool, setReqPool] = useState<ProPoolCpo[] | null>(null);
  const [reqPicked, setReqPicked] = useState<Set<string>>(new Set());
  const [reqNote, setReqNote] = useState('');
  // CA-04/IS-04 — decline gets a note-capable confirm modal; FINISH/CANCEL/
  // SUSPEND get an explicit confirm step (no more one-click destruction).
  const [declineFor, setDeclineFor] = useState<ProMissionRequestRow | null>(null);
  const [declineNote, setDeclineNote] = useState('');
  // E2E-07 — releasing an already-SCHEDULED reserved date. A separate door from
  // DECLINE on purpose: decline refuses a date that was never granted, cancel
  // unwinds one that was, and only cancel releases officer assignments.
  const [cancelFor, setCancelFor] = useState<ProReservedTodayRow | null>(null);
  const [cancelNote, setCancelNote] = useState('');
  // Which reservation is mid-cancel — see ReservedTodayPanel's `busyId`.
  const [cancelBusyId, setCancelBusyId] = useState<string | null>(null);
  const [confirmAct, setConfirmAct] = useState<{title: string; body: string; label: string; run: () => void} | null>(null);

  // Assignments
  const [asgStatus, setAsgStatus] = useState('ASSIGNED');
  const {data: asgData, error: asgError, mutate: mutateAsg} = useProAssignments(asgStatus);
  // Pool
  const [poolFrom, setPoolFrom] = useState(today());
  const [poolTo, setPoolTo] = useState(today());
  const {data: poolData, error: poolError, mutate: mutatePool} = useProPool(poolFrom, poolTo);
  // Orgs
  const {data: orgData, error: orgError, mutate: mutateOrgs} = useProOrgs();
  // Fleet + resources catalogs (Issue 30).
  const [fleetShowInactive, setFleetShowInactive] = useState(false);
  const [resShowInactive, setResShowInactive] = useState(false);
  const {data: fleetData, error: fleetError, mutate: mutateFleet} = useProFleet(fleetShowInactive);
  const {data: resData, error: resError, mutate: mutateRes} = useProResources(resShowInactive);
  // Active Pro members (for the assign modal).
  const {data: activeApps} = useProApplications('ACTIVE');

  // Assign modal
  const [assignFor, setAssignFor] = useState<ProPoolCpo | null>(null);
  const [assignApp, setAssignApp] = useState('');
  const [assignStart, setAssignStart] = useState(today());
  const [assignEnd, setAssignEnd] = useState(today());
  const [assignNote, setAssignNote] = useState('');
  // Create CPO modal
  const [cpoOpen, setCpoOpen] = useState(false);
  const [cpoOrg, setCpoOrg] = useState('');
  const [cpoName, setCpoName] = useState('');
  const [cpoEmail, setCpoEmail] = useState('');
  const [cpoPhone, setCpoPhone] = useState('');
  const [cpoPass, setCpoPass] = useState('');
  const [cpoCallSign, setCpoCallSign] = useState('');
  // Create org modal
  const [orgOpen, setOrgOpen] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [orgEmail, setOrgEmail] = useState('');
  const [orgPhone, setOrgPhone] = useState('');
  const [orgPass, setOrgPass] = useState('');
  const [orgCountry, setOrgCountry] = useState('AE');
  // Create vehicle modal (Issue 30 fleet catalog)
  const [vehOpen, setVehOpen] = useState(false);
  const [vehCallSign, setVehCallSign] = useState('');
  const [vehMakeModel, setVehMakeModel] = useState('');
  const [vehPlate, setVehPlate] = useState('');
  const [vehColour, setVehColour] = useState('');
  const [vehArmored, setVehArmored] = useState(true);
  const [vehArmorGrade, setVehArmorGrade] = useState('');
  const [vehCapacity, setVehCapacity] = useState('4');
  const [vehRegion, setVehRegion] = useState('');
  const [vehNotes, setVehNotes] = useState('');
  // Create resource modal
  const [resOpen, setResOpen] = useState(false);
  const [resKind, setResKind] = useState<ProResourceKind>('comms');
  const [resLabel, setResLabel] = useState('');
  const [resIdentifier, setResIdentifier] = useState('');
  const [resNotes, setResNotes] = useState('');
  // Last-created credentials surface (shown ONCE so ops can hand them over).
  const [minted, setMinted] = useState<{kind: string; login: string; password: string} | null>(null);
  // IS-09 — org drill-down: roster + protected members + (SK-08) the org
  // audit log, previously an endpoint with zero consumers.
  const [orgFor, setOrgFor] = useState<ProOrgRow | null>(null);
  const [orgInfo, setOrgInfo] = useState<Awaited<ReturnType<typeof proMgmtApi.orgDetail>> | null>(null);
  const [orgInfoErr, setOrgInfoErr] = useState<string | null>(null);
  const [orgAuditRows, setOrgAuditRows] = useState<Awaited<ReturnType<typeof opsDataApi.orgAudit>> | null>(null);
  const [orgAuditErr, setOrgAuditErr] = useState<string | null>(null);

  function openOrgDetail(o: ProOrgRow) {
    setOrgFor(o); setOrgInfo(null); setOrgInfoErr(null);
    setOrgAuditRows(null); setOrgAuditErr(null);
    void proMgmtApi.orgDetail(o.id)
      .then(r => setOrgInfo(r))
      .catch(e => setOrgInfoErr((e as Error).message));
    void opsDataApi.orgAudit(o.id, 50)
      .then(rows => setOrgAuditRows(rows))
      .catch(e => setOrgAuditErr(
        e instanceof ApiError && e.status === 403
          ? 'Audit log requires SUPERVISOR or ADMIN.'
          : (e as Error).message,
      ));
  }

  const orgOptions = useMemo(() => orgData?.orgs ?? [], [orgData]);

  async function run(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true); setErr(null);
    try {
      await fn();
      after?.();
    } catch (e) {
      const apiErr = e as Error & {body?: {message?: string; conflicts?: Array<{member: string | null; starts_on: string; ends_on: string}>}};
      const conflicts = apiErr.body?.conflicts;
      setErr(conflicts?.length
        ? `Officer unavailable — already assigned to ${conflicts.map(c => `${c.member ?? 'a member'} (${c.starts_on} → ${c.ends_on})`).join('; ')}`
        : apiErr.message);
    } finally {
      setBusy(false);
    }
  }

  function genPassword(): string {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    // CA-18 — rejection sampling: `byte % 54` over-weights the first
    // 256 % 54 characters, measurably shrinking the credential's entropy.
    const limit = 256 - (256 % chars.length);
    let out = '';
    while (out.length < 12) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      for (const b of bytes) {
        if (b < limit && out.length < 12) out += chars[b % chars.length];
      }
    }
    return out;
  }

  // CA-03 — every section renders a DISTINCT error state with a retry, never
  // the empty-state copy (an API failure is not "no data").
  function SectionError({error, retry}: {error: unknown; retry: () => void}) {
    return (
      <div className="card" role="alert" style={{
        padding: 20, textAlign: 'center', border: '1px solid var(--err)',
        color: '#FFB4B4', fontSize: 12.5,
      }}>
        Couldn&apos;t load this section — {(error as Error)?.message ?? 'request failed'}.
        <button className="btn btn-ghost btn-sm" style={{marginLeft: 10}} onClick={retry}>RETRY</button>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title={SECTION_TITLES[section]}
        subtitle={SECTION_SUBTITLES[section]}
      />

      <RouteTabs
        ariaLabel="Secure Pro delivery sections"
        tabs={[
          {href: routes.pro.organisations, label: 'Organisations'},
          {href: routes.pro.pool, label: 'CPO Pool'},
          {href: routes.pro.assignments, label: 'Requests', count: reqData?.requests?.length ?? 0},
          {href: routes.pro.assignmentsScheduled, label: 'Scheduled'},
          {href: routes.pro.fleet, label: 'Vehicles'},
          {href: routes.pro.fleetResources, label: 'Resources'},
        ]}
      />

      {err ? (
        <div role="alert" style={{
          background: 'rgba(220,38,38,0.1)', border: '1px solid var(--err)',
          color: '#FFB4B4', borderRadius: 10, padding: '10px 14px',
          fontSize: 12.5, marginBottom: 14,
        }}>
          API ERROR · {err}
        </div>
      ) : null}

      {minted ? (
        <div role="alert" style={{
          background: 'rgba(74,222,128,0.08)', border: '1px solid var(--ok)',
          color: 'var(--tx-1)', borderRadius: 10, padding: '10px 14px',
          fontSize: 12.5, marginBottom: 14, display: 'flex', gap: 14, alignItems: 'center',
        }}>
          <span style={{minWidth: 0}}>
            {/* IS-22 — copy affordances: these credentials are shown once. */}
            {minted.kind} created — login <b style={{fontFamily: 'var(--font-mono)'}}>{minted.login}<CopyId value={minted.login} title="Copy login" /></b>,
            temp password <b style={{fontFamily: 'var(--font-mono)'}}>{minted.password}<CopyId value={minted.password} title="Copy temp password" /></b> (shown once — hand it over now).
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => setMinted(null)}>DISMISS</button>
        </div>
      ) : null}

      {/* ── REQUESTS — the global incoming queue ── */}
      {section === 'REQUESTS' && reqError && !reqData ? (
        <SectionError error={reqError} retry={() => void mutateReqs()} />
      ) : section === 'REQUESTS' && (
        <div style={{display: 'grid', gap: 10}}>
          <ReservedTodayPanel
            rows={reqData?.reserved_today ?? []}
            canDecide={canDecide}
            busyId={cancelBusyId}
            onOpenPlan={appId => router.push(routes.pro.application(appId))}
            onCancel={r => { setCancelNote(''); setErr(null); setCancelFor(r); }}
          />

          <div style={{
            fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: 1.2,
            color: 'var(--tx-3)', fontWeight: 700, textTransform: 'uppercase', marginTop: 6,
          }}>
            Incoming requests · awaiting officers
          </div>
          {(reqData?.requests ?? []).length === 0 ? (
            <div className="card" style={{padding: 24, textAlign: 'center', color: 'var(--tx-3)', fontSize: 13}}>
              No protection-date requests waiting. New ones appear here within seconds.
            </div>
          ) : (
            (reqData?.requests ?? []).map(r => (
              <div key={r.id} className="card" style={{padding: '13px 16px'}}>
                <div style={{display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap'}}>
                  <div style={{flex: '1 1 220px', minWidth: 0}}>
                    <div style={{fontWeight: 700, fontSize: 13, color: 'var(--tx-1)'}}>
                      {r.member_name ?? 'Member'}
                      {r.requested_by_name && r.requested_by_name !== r.member_name
                        ? <span style={{color: 'var(--tx-3)', fontWeight: 400}}> · by {r.requested_by_name}</span> : null}
                    </div>
                    <div style={{fontSize: 11, color: 'var(--tx-3)', marginTop: 3}}>
                      {r.mission_dates.length} date{r.mission_dates.length > 1 ? 's' : ''} · requested {formatDateUtc(r.created_at)}
                    </div>
                  </div>
                  <span className="pill pill-warn">● AWAITING OFFICERS</span>
                  {canDecide ? (
                    <div style={{display: 'flex', gap: 8}}>
                      <button className="btn btn-pri btn-sm" disabled={busy}
                        onClick={() => {
                          const dates = [...r.mission_dates].sort();
                          setReqFor(r); setReqPool(null); setReqPicked(new Set()); setReqNote(''); setErr(null);
                          void proMgmtApi.pool(dates[0], dates[dates.length - 1])
                            .then(res => setReqPool(res.cpos))
                            .catch(e => { setReqPool([]); setErr((e as Error).message); });
                        }}>
                        ASSIGN CPOS →
                      </button>
                      <button className="btn btn-danger btn-sm" disabled={busy}
                        onClick={() => { setDeclineNote(''); setErr(null); setDeclineFor(r); }}>
                        DECLINE
                      </button>
                    </div>
                  ) : null}
                  <button className="btn btn-ghost btn-sm" onClick={() => router.push(routes.pro.application(r.application_id))}>
                    OPEN PLAN →
                  </button>
                </div>
                <div style={{display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 9}}>
                  {r.mission_dates.map(d => (
                    <span key={d} style={{
                      fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--acc)',
                      border: '1px solid var(--bd-2)', borderRadius: 6, padding: '3px 7px',
                    }}>
                      {formatDateUtc(d)}
                    </span>
                  ))}
                </div>
                {r.note ? (
                  <div style={{fontSize: 12, color: 'var(--tx-2)', marginTop: 8, fontStyle: 'italic'}}>“{r.note}”</div>
                ) : null}
              </div>
            ))
          )}
        </div>
      )}

      {/* ── ASSIGNMENTS ── */}
      {section === 'ASSIGNMENTS' && (
        <>
          {/* B-819 — was a row of `.filter-ch`, which carries the vertical
              rail's `width: 100%`: these four buckets rendered as four
              full-width stacked blocks. Same primitive as every other
              status-bucket row now. */}
          <StatusTabs
            ariaLabel="Filter assignments by status"
            value={asgStatus}
            onChange={setAsgStatus}
            tabs={['ASSIGNED', 'COMPLETED', 'CANCELLED', 'all'].map(st => ({
              key: st,
              label: st === 'all' ? 'All' : st.charAt(0) + st.slice(1).toLowerCase(),
            }))}
          />
          <div style={{display: 'grid', gap: 10}}>
            {asgError && !asgData ? (
              <SectionError error={asgError} retry={() => void mutateAsg()} />
            ) : (asgData?.assignments ?? []).length === 0 ? (
              <div className="card" style={{padding: 24, textAlign: 'center', color: 'var(--tx-3)', fontSize: 13}}>
                No assignments in this bucket. Assign officers from the CPO POOL tab.
              </div>
            ) : (
              (asgData?.assignments ?? []).map(a => (
                <div key={a.id} className="card" style={{padding: '13px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap'}}>
                  <div style={{flex: '1 1 220px', minWidth: 0}}>
                    <div style={{fontWeight: 700, fontSize: 13, color: 'var(--tx-1)'}}>
                      {a.cpo_name ?? 'Officer'} → {a.member_name ?? 'Member'}
                    </div>
                    <div style={{fontSize: 11, color: 'var(--tx-3)', marginTop: 3}}>
                      {formatDateUtc(a.starts_on)} → {formatDateUtc(a.ends_on)}
                      {a.org_name ? ` · ${a.org_name}` : ''}
                    </div>
                  </div>
                  <div style={{fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--acc)', letterSpacing: 1}}>
                    {a.mission_code}
                  </div>
                  <span className={`pill pill-${a.status === 'ASSIGNED' ? 'live' : a.status === 'COMPLETED' ? 'ok' : 'err'}`}>
                    ● {a.status}
                  </span>
                  {a.status === 'ASSIGNED' && canDecide ? (
                    <div style={{display: 'flex', gap: 8}}>
                      <button className="btn btn-ok btn-sm" disabled={busy}
                        onClick={() => setConfirmAct({
                          title: 'FINISH ASSIGNMENT',
                          body: `Mark ${a.cpo_name ?? 'this officer'}'s protection of ${a.member_name ?? 'the member'} (${formatDateUtc(a.starts_on)} → ${formatDateUtc(a.ends_on)}) as completed? The mission code stops working.`,
                          label: 'FINISH →',
                          run: () => void run(() => proMgmtApi.completeAssignment(a.id), () => void mutateAsg()),
                        })}>
                        FINISH
                      </button>
                      <button className="btn btn-danger btn-sm" disabled={busy}
                        onClick={() => setConfirmAct({
                          title: 'CANCEL ASSIGNMENT',
                          body: `Cancel ${a.cpo_name ?? 'this officer'}'s protection of ${a.member_name ?? 'the member'} (${formatDateUtc(a.starts_on)} → ${formatDateUtc(a.ends_on)})? The officer is released and the mission code stops working.`,
                          label: 'CANCEL ASSIGNMENT →',
                          run: () => void run(() => proMgmtApi.cancelAssignment(a.id), () => void mutateAsg()),
                        })}>
                        CANCEL
                      </button>
                    </div>
                  ) : null}
                  <button className="btn btn-ghost btn-sm" onClick={() => router.push(routes.pro.application(a.application_id))}>
                    OPEN PLAN →
                  </button>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {/* ── CPO POOL ── */}
      {section === 'CPO POOL' && (
        <>
          <div className="card" style={{padding: '12px 16px', marginBottom: 12, display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap'}}>
            <div>
              <label style={labelStyle}>Window from</label>
              <input style={{...inputStyle, width: 160}} type="date" value={poolFrom} onChange={e => setPoolFrom(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>To</label>
              <input style={{...inputStyle, width: 160}} type="date" value={poolTo} onChange={e => setPoolTo(e.target.value)} />
            </div>
            <div style={{flex: 1}} />
            {canDecide ? (
              <button className="btn btn-pri" onClick={() => { setCpoPass(genPassword()); setCpoOpen(true); }}>
                + CREATE CPO
              </button>
            ) : null}
          </div>
          <div style={{display: 'grid', gap: 10}}>
            {poolError && !poolData ? (
              <SectionError error={poolError} retry={() => void mutatePool()} />
            ) : null}
            {(poolData?.cpos ?? []).map(c => (
              <div key={c.id} className="card" style={{padding: '13px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap'}}>
                <div style={{flex: '1 1 200px', minWidth: 0}}>
                  <div style={{fontWeight: 700, fontSize: 13, color: 'var(--tx-1)'}}>
                    {c.display_name}{c.call_sign ? ` · ${c.call_sign}` : ''}
                  </div>
                  <div style={{fontSize: 11, color: 'var(--tx-3)', marginTop: 3}}>
                    {c.org_name ?? 'No organisation'}{c.internal ? ' · INTERNAL' : ''} · agent {c.agent_status}
                    {c.next_assignment_start ? ` · next assignment ${formatDateUtc(c.next_assignment_start)}` : ''}
                  </div>
                </div>
                <span className={`pill pill-${c.suspended_now ? 'err' : c.available ? 'ok' : 'warn'}`}>
                  ● {c.suspended_now ? 'SUSPENDED' : c.available ? 'AVAILABLE' : 'BUSY IN WINDOW'}
                </span>
                {canDecide ? (
                  <div style={{display: 'flex', gap: 8}}>
                    <button className="btn btn-pri btn-sm" disabled={busy || c.suspended_now}
                      onClick={() => {
                        setAssignFor(c); setAssignApp(''); setAssignNote('');
                        setAssignStart(poolFrom); setAssignEnd(poolTo);
                        setErr(null);
                      }}>
                      ASSIGN →
                    </button>
                    <button className="btn btn-sec btn-sm" disabled={busy}
                      onClick={() => {
                        const reinstate = () => void run(
                          () => proMgmtApi.suspendCpo(c.id, {suspend: false}),
                          () => void mutatePool(),
                        );
                        if (c.suspended_now) { reinstate(); return; }
                        setConfirmAct({
                          title: 'SUSPEND OFFICER · 14 DAYS',
                          body: `Suspend ${c.display_name}${c.call_sign ? ` (${c.call_sign})` : ''} for 14 days? Their sessions are revoked and they drop out of the assignable pool immediately.`,
                          label: 'SUSPEND 14D →',
                          run: () => void run(
                            () => proMgmtApi.suspendCpo(c.id, {suspend: true, days: 14}),
                            () => void mutatePool(),
                          ),
                        });
                      }}>
                      {c.suspended_now ? 'REINSTATE' : 'SUSPEND 14D'}
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
            {!poolError && (poolData?.cpos ?? []).length === 0 && (
              <div className="card" style={{padding: 24, textAlign: 'center', color: 'var(--tx-3)', fontSize: 13}}>
                No approved CPOs yet — create one, or approve applications under AGENTS.
              </div>
            )}
          </div>
        </>
      )}

      {/* ── ORGANIZATIONS ── */}
      {section === 'ORGANIZATIONS' && (
        <>
          <div style={{display: 'flex', justifyContent: 'flex-end', marginBottom: 12}}>
            {canDecide ? (
              <button className="btn btn-pri" onClick={() => { setOrgPass(genPassword()); setOrgOpen(true); }}>
                + CREATE ORGANIZATION
              </button>
            ) : null}
          </div>
          <div style={{display: 'grid', gap: 10}}>
            {orgError && !orgData ? (
              <SectionError error={orgError} retry={() => void mutateOrgs()} />
            ) : null}
            {(orgData?.orgs ?? []).map(o => (
              <div key={o.id} className="card" style={{padding: '13px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap'}}>
                <div style={{flex: '1 1 220px', minWidth: 0}}>
                  <div style={{fontWeight: 700, fontSize: 13, color: 'var(--tx-1)'}}>
                    {o.display_name}{o.internal ? ' · INTERNAL' : ''}
                  </div>
                  <div style={{fontSize: 11, color: 'var(--tx-3)', marginTop: 3}}>
                    {o.email} · {o.cpo_count} CPO{o.cpo_count === 1 ? '' : 's'} · {o.live_assignments} live assignment{o.live_assignments === 1 ? '' : 's'}
                  </div>
                </div>
                <span className={`pill pill-${o.status === 'ACTIVE' ? 'ok' : o.status === 'REJECTED' ? 'err' : 'warn'}`}>
                  ● {o.status}
                </span>
                <button className="btn btn-sec btn-sm" onClick={() => openOrgDetail(o)}>
                  DETAILS →
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => router.push(routes.people.agent(o.id))}>
                  AGENT RECORD →
                </button>
              </div>
            ))}
            {!orgError && (orgData?.orgs ?? []).length === 0 && (
              <div className="card" style={{padding: 24, textAlign: 'center', color: 'var(--tx-3)', fontSize: 13}}>
                No organisations yet.
              </div>
            )}
          </div>
        </>
      )}

      {/* ── FLEET — Pro vehicle catalog (Issue 30) ── */}
      {section === 'FLEET' && (
        <>
          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap'}}>
            <label style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--tx-3)', cursor: 'pointer'}}>
              <input type="checkbox" checked={fleetShowInactive} onChange={e => setFleetShowInactive(e.target.checked)} />
              Show retired vehicles
            </label>
            {canDecide ? (
              <button className="btn btn-pri" onClick={() => {
                setVehCallSign(''); setVehMakeModel(''); setVehPlate(''); setVehColour('');
                setVehArmored(true); setVehArmorGrade(''); setVehCapacity('4'); setVehRegion('');
                setVehNotes(''); setErr(null); setVehOpen(true);
              }}>
                + ADD VEHICLE
              </button>
            ) : null}
          </div>
          <div style={{display: 'grid', gap: 10}}>
            {fleetError && !fleetData ? (
              <SectionError error={fleetError} retry={() => void mutateFleet()} />
            ) : (fleetData?.vehicles ?? []).length === 0 ? (
              <div className="card" style={{padding: 24, textAlign: 'center', color: 'var(--tx-3)', fontSize: 13}}>
                No vehicles in the Pro fleet yet. Add one, then assign it to a plan from the application screen.
              </div>
            ) : (
              (fleetData?.vehicles ?? []).map(v => (
                <div key={v.id} className="card" style={{padding: '13px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', opacity: v.active ? 1 : 0.5}}>
                  <div style={{flex: '1 1 240px', minWidth: 0}}>
                    <div style={{fontWeight: 700, fontSize: 13, color: 'var(--tx-1)'}}>
                      {v.call_sign} · {v.make_model}
                    </div>
                    <div style={{fontSize: 11, color: 'var(--tx-3)', marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 7, alignItems: 'center'}}>
                      <span style={{fontFamily: 'var(--font-mono)', color: 'var(--acc)', border: '1px solid var(--bd-2)', borderRadius: 6, padding: '2px 7px', letterSpacing: 1}}>
                        {v.plate}
                      </span>
                      {v.colour ? <span>{v.colour}</span> : null}
                      <span>{v.armored ? `Armored${v.armor_grade ? ` · ${v.armor_grade}` : ''}` : 'Unarmored'}</span>
                      <span>· {v.capacity} seats</span>
                      {v.region_code ? <span>· {v.region_code}</span> : null}
                    </div>
                    {v.notes ? <div style={{fontSize: 11.5, color: 'var(--tx-2)', marginTop: 5, fontStyle: 'italic'}}>{v.notes}</div> : null}
                  </div>
                  <span className={`pill pill-${v.active ? 'ok' : 'warn'}`}>● {v.active ? 'ACTIVE' : 'RETIRED'}</span>
                  {canDecide ? (
                    <button className="btn btn-sec btn-sm" disabled={busy}
                      onClick={() => {
                        if (!v.active) { void run(() => proFleetApi.updateFleet(v.id, {active: true}), () => void mutateFleet()); return; }
                        setConfirmAct({
                          title: 'RETIRE VEHICLE',
                          body: `Retire ${v.call_sign} (${v.plate})? It stays on any past assignments but can't be newly assigned. You can reactivate it later.`,
                          label: 'RETIRE →',
                          run: () => void run(() => proFleetApi.updateFleet(v.id, {active: false}), () => void mutateFleet()),
                        });
                      }}>
                      {v.active ? 'RETIRE' : 'REACTIVATE'}
                    </button>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </>
      )}

      {/* ── RESOURCES — assignable inventory (Issue 30) ── */}
      {section === 'RESOURCES' && (
        <>
          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap'}}>
            <label style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--tx-3)', cursor: 'pointer'}}>
              <input type="checkbox" checked={resShowInactive} onChange={e => setResShowInactive(e.target.checked)} />
              Show retired resources
            </label>
            {canDecide ? (
              <button className="btn btn-pri" onClick={() => {
                setResKind('comms'); setResLabel(''); setResIdentifier(''); setResNotes('');
                setErr(null); setResOpen(true);
              }}>
                + ADD RESOURCE
              </button>
            ) : null}
          </div>
          <div style={{display: 'grid', gap: 10}}>
            {resError && !resData ? (
              <SectionError error={resError} retry={() => void mutateRes()} />
            ) : (resData?.resources ?? []).length === 0 ? (
              <div className="card" style={{padding: 24, textAlign: 'center', color: 'var(--tx-3)', fontSize: 13}}>
                No resources in the inventory yet. Add comms / medical / tactical gear, then assign it to a plan.
              </div>
            ) : (
              (resData?.resources ?? []).map(r => (
                <div key={r.id} className="card" style={{padding: '13px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', opacity: r.active ? 1 : 0.5}}>
                  <span className="pill pill-info" style={{textTransform: 'uppercase'}}>{r.kind}</span>
                  <div style={{flex: '1 1 220px', minWidth: 0}}>
                    <div style={{fontWeight: 700, fontSize: 13, color: 'var(--tx-1)'}}>{r.label}</div>
                    <div style={{fontSize: 11, color: 'var(--tx-3)', marginTop: 3}}>
                      {r.identifier
                        ? <span style={{fontFamily: 'var(--font-mono)'}}>SN {r.identifier}</span>
                        : 'No serial'}
                    </div>
                    {r.notes ? <div style={{fontSize: 11.5, color: 'var(--tx-2)', marginTop: 5, fontStyle: 'italic'}}>{r.notes}</div> : null}
                  </div>
                  <span className={`pill pill-${r.active ? 'ok' : 'warn'}`}>● {r.active ? 'ACTIVE' : 'RETIRED'}</span>
                  {canDecide ? (
                    <button className="btn btn-sec btn-sm" disabled={busy}
                      onClick={() => {
                        if (!r.active) { void run(() => proFleetApi.updateResource(r.id, {active: true}), () => void mutateRes()); return; }
                        setConfirmAct({
                          title: 'RETIRE RESOURCE',
                          body: `Retire ${r.label}? It stays on any past assignments but can't be newly assigned. You can reactivate it later.`,
                          label: 'RETIRE →',
                          run: () => void run(() => proFleetApi.updateResource(r.id, {active: false}), () => void mutateRes()),
                        });
                      }}>
                      {r.active ? 'RETIRE' : 'REACTIVATE'}
                    </button>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </>
      )}

      {/* ── Request → assign-officers modal ── */}
      {reqFor ? (
        <div style={{position: 'fixed', inset: 0, background: 'rgba(4,16,31,0.7)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16}}
          onClick={() => { if (!busy) setReqFor(null); }}>
          <div className="card" onClick={e => e.stopPropagation()} style={{width: 'min(600px, 94vw)', maxHeight: '88vh', overflowY: 'auto', border: '1px solid var(--act)'}}>
            <div className="card-header">
              <div className="card-header-title"><span className="bar" />ASSIGN OFFICERS · {(reqFor.member_name ?? 'MEMBER').toUpperCase()}</div>
            </div>
            <div style={{padding: '6px 18px 18px', display: 'grid', gap: 14}}>
              <div style={{fontSize: 12.5, color: 'var(--tx-2)'}}>
                {reqFor.mission_dates.length} date{reqFor.mission_dates.length > 1 ? 's' : ''}:{' '}
                {reqFor.mission_dates.map(formatDateUtc).join(' · ')}
              </div>
              <div>
                <label style={labelStyle}>Available CPOs for this window</label>
                {reqPool === null ? (
                  <div style={{fontSize: 12, color: 'var(--tx-3)'}}>Checking availability…</div>
                ) : reqPool.length === 0 ? (
                  <div style={{fontSize: 12, color: 'var(--tx-3)'}}>
                    No approved CPOs exist yet — create them under CPO POOL.
                  </div>
                ) : (
                  <div style={{display: 'grid', gap: 6, maxHeight: 260, overflowY: 'auto'}}>
                    {reqPool.map(c => {
                      const blocked = !c.available;
                      const on = reqPicked.has(c.id);
                      return (
                        <button
                          key={c.id}
                          disabled={blocked}
                          onClick={() => setReqPicked(prev => {
                            const next = new Set(prev);
                            if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
                            return next;
                          })}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                            background: on ? 'rgba(30,136,255,0.12)' : 'none',
                            border: `1px solid ${on ? 'var(--act)' : 'var(--bd-2)'}`,
                            borderRadius: 10, padding: '9px 12px', cursor: blocked ? 'not-allowed' : 'pointer',
                            textAlign: 'left', font: 'inherit', opacity: blocked ? 0.5 : 1,
                          }}>
                          <span style={{
                            width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                            border: `1.5px solid ${on ? 'var(--act)' : 'var(--bd-2)'}`,
                            background: on ? 'var(--act)' : 'transparent',
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            color: '#fff', fontSize: 11, fontWeight: 800,
                          }}>{on ? '✓' : ''}</span>
                          <span style={{flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--tx-1)'}}>
                            {c.display_name}{c.call_sign ? ` · ${c.call_sign}` : ''}
                            <span style={{color: 'var(--tx-3)'}}> — {c.org_name ?? 'no org'}</span>
                          </span>
                          <span className={`pill pill-${c.suspended_now ? 'err' : c.available ? 'ok' : 'warn'}`}>
                            {c.suspended_now ? 'SUSPENDED' : c.available ? 'AVAILABLE' : 'BUSY'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <div>
                <label style={labelStyle}>Note to client (optional)</label>
                <input style={inputStyle} placeholder="Shown on the client's request card"
                  value={reqNote} onChange={e => setReqNote(e.target.value)} />
              </div>
              {err ? <div style={{fontSize: 11.5, color: 'var(--warn)'}}>{err}</div> : null}
              <div style={{display: 'flex', justifyContent: 'flex-end', gap: 10, borderTop: '1px solid var(--bd-2)', paddingTop: 14}}>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setReqFor(null)}>CANCEL</button>
                <button className="btn btn-pri" disabled={busy || reqPicked.size === 0}
                  onClick={() => void run(
                    () => proMgmtApi.scheduleWithCpos(reqFor.application_id, reqFor.id, {
                      cpo_user_ids: [...reqPicked],
                      ...(reqNote.trim() ? {ops_note: reqNote.trim()} : {}),
                    }),
                    () => { setReqFor(null); void mutateReqs(); void mutateAsg(); },
                  )}>
                  {busy ? 'ASSIGNING…' : `ASSIGN ${reqPicked.size || ''} CPO${reqPicked.size === 1 ? '' : 'S'} & SCHEDULE →`}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Assign modal ── */}
      {assignFor ? (
        <div style={{position: 'fixed', inset: 0, background: 'rgba(4,16,31,0.7)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16}}
          onClick={() => { if (!busy) setAssignFor(null); }}>
          <div className="card" onClick={e => e.stopPropagation()} style={{width: 'min(540px, 94vw)', border: '1px solid var(--act)'}}>
            <div className="card-header">
              <div className="card-header-title"><span className="bar" />ASSIGN {assignFor.display_name.toUpperCase()}</div>
            </div>
            <div style={{padding: '6px 18px 18px', display: 'grid', gap: 12}}>
              <div>
                <label style={labelStyle}>Pro member (active plan) *</label>
                <select style={{...inputStyle, appearance: 'auto'}} value={assignApp} onChange={e => setAssignApp(e.target.value)}>
                  <option value="">Select…</option>
                  {(activeApps?.applications ?? []).map(a => (
                    <option key={a.id} value={a.id}>{a.client_name ?? a.client_email}</option>
                  ))}
                </select>
              </div>
              <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
                <div>
                  <label style={labelStyle}>Protection starts *</label>
                  <input style={inputStyle} type="date" value={assignStart} onChange={e => setAssignStart(e.target.value)} />
                </div>
                <div>
                  <label style={labelStyle}>Ends *</label>
                  <input style={inputStyle} type="date" value={assignEnd} onChange={e => setAssignEnd(e.target.value)} />
                </div>
              </div>
              <div>
                <label style={labelStyle}>Note (optional)</label>
                <input style={inputStyle} value={assignNote} onChange={e => setAssignNote(e.target.value)} placeholder="Instructions for the officer / file" />
              </div>
              {err ? <div style={{fontSize: 11.5, color: 'var(--warn)'}}>{err}</div> : null}
              <div style={{display: 'flex', justifyContent: 'flex-end', gap: 10, borderTop: '1px solid var(--bd-2)', paddingTop: 14}}>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setAssignFor(null)}>CANCEL</button>
                <button className="btn btn-pri" disabled={busy || !assignApp || !assignStart || !assignEnd}
                  onClick={() => void run(
                    () => proMgmtApi.createAssignment({
                      application_id: assignApp, cpo_user_id: assignFor.id,
                      starts_on: assignStart, ends_on: assignEnd,
                      ...(assignNote.trim() ? {note: assignNote.trim()} : {}),
                    }),
                    // The section is a route now, so "show me what I just
                    // created" is a navigation, not a setState.
                    () => { setAssignFor(null); void mutateAsg(); void mutatePool(); router.push(routes.pro.assignmentsScheduled); },
                  )}>
                  {busy ? 'ASSIGNING…' : 'CONFIRM ASSIGNMENT →'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Create CPO modal ── */}
      {cpoOpen ? (
        <div style={{position: 'fixed', inset: 0, background: 'rgba(4,16,31,0.7)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16}}
          onClick={() => { if (!busy) setCpoOpen(false); }}>
          <div className="card" onClick={e => e.stopPropagation()} style={{width: 'min(540px, 94vw)', border: '1px solid var(--act)'}}>
            <div className="card-header">
              <div className="card-header-title"><span className="bar" />CREATE CPO (SYSTEM CREDENTIALS)</div>
            </div>
            <div style={{padding: '6px 18px 18px', display: 'grid', gap: 12}}>
              <div>
                <label style={labelStyle}>Organisation *</label>
                <select style={{...inputStyle, appearance: 'auto'}} value={cpoOrg} onChange={e => setCpoOrg(e.target.value)}>
                  <option value="">Select…</option>
                  {orgOptions.filter(o => o.status === 'ACTIVE').map(o => (
                    <option key={o.id} value={o.id}>{o.display_name}{o.internal ? ' (internal)' : ''}</option>
                  ))}
                </select>
              </div>
              <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
                <div><label style={labelStyle}>Full name *</label>
                  <input style={inputStyle} value={cpoName} onChange={e => setCpoName(e.target.value)} /></div>
                <div><label style={labelStyle}>Call sign</label>
                  <input style={inputStyle} value={cpoCallSign} onChange={e => setCpoCallSign(e.target.value)} /></div>
                <div><label style={labelStyle}>Email (login) *</label>
                  <input style={inputStyle} value={cpoEmail} onChange={e => setCpoEmail(e.target.value)} /></div>
                <div><label style={labelStyle}>Phone E.164 *</label>
                  <input style={inputStyle} value={cpoPhone} onChange={e => setCpoPhone(e.target.value)} placeholder="+9715…" /></div>
              </div>
              <div>
                <label style={labelStyle}>Temp password * (system-generated — regenerate ↻)</label>
                <div style={{display: 'flex', gap: 8}}>
                  <input style={{...inputStyle, fontFamily: 'var(--font-mono)'}} value={cpoPass} onChange={e => setCpoPass(e.target.value)} />
                  <button className="btn btn-sec" onClick={() => setCpoPass(genPassword())}>↻</button>
                </div>
              </div>
              <div style={{display: 'flex', justifyContent: 'flex-end', gap: 10, borderTop: '1px solid var(--bd-2)', paddingTop: 14}}>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setCpoOpen(false)}>CANCEL</button>
                <button className="btn btn-pri" disabled={busy || !cpoOrg || !cpoName.trim() || !cpoEmail.trim() || !cpoPhone.trim() || cpoPass.length < 8}
                  onClick={() => void run(
                    () => proMgmtApi.createCpo({
                      org_user_id: cpoOrg, display_name: cpoName.trim(), email: cpoEmail.trim(),
                      phone_e164: cpoPhone.trim(), temp_password: cpoPass,
                      ...(cpoCallSign.trim() ? {call_sign: cpoCallSign.trim()} : {}),
                    }),
                    () => {
                      setMinted({kind: 'CPO', login: cpoEmail.trim(), password: cpoPass});
                      setCpoOpen(false); setCpoName(''); setCpoEmail(''); setCpoPhone(''); setCpoCallSign('');
                      void mutatePool();
                    },
                  )}>
                  {busy ? 'CREATING…' : 'CREATE CPO →'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Create org modal ── */}
      {orgOpen ? (
        <div style={{position: 'fixed', inset: 0, background: 'rgba(4,16,31,0.7)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16}}
          onClick={() => { if (!busy) setOrgOpen(false); }}>
          <div className="card" onClick={e => e.stopPropagation()} style={{width: 'min(540px, 94vw)', border: '1px solid var(--act)'}}>
            <div className="card-header">
              <div className="card-header-title"><span className="bar" />CREATE INTERNAL ORGANIZATION</div>
            </div>
            <div style={{padding: '6px 18px 18px', display: 'grid', gap: 12}}>
              <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
                <div><label style={labelStyle}>Organisation name *</label>
                  <input style={inputStyle} value={orgName} onChange={e => setOrgName(e.target.value)} /></div>
                <div><label style={labelStyle}>Coverage country *</label>
                  <input style={inputStyle} value={orgCountry} maxLength={2} onChange={e => setOrgCountry(e.target.value.toUpperCase())} /></div>
                <div><label style={labelStyle}>Manager email (login) *</label>
                  <input style={inputStyle} value={orgEmail} onChange={e => setOrgEmail(e.target.value)} /></div>
                <div><label style={labelStyle}>Manager phone E.164 *</label>
                  <input style={inputStyle} value={orgPhone} onChange={e => setOrgPhone(e.target.value)} placeholder="+9715…" /></div>
              </div>
              <div>
                <label style={labelStyle}>Temp password * (system-generated — regenerate ↻)</label>
                <div style={{display: 'flex', gap: 8}}>
                  <input style={{...inputStyle, fontFamily: 'var(--font-mono)'}} value={orgPass} onChange={e => setOrgPass(e.target.value)} />
                  <button className="btn btn-sec" onClick={() => setOrgPass(genPassword())}>↻</button>
                </div>
              </div>
              <div style={{display: 'flex', justifyContent: 'flex-end', gap: 10, borderTop: '1px solid var(--bd-2)', paddingTop: 14}}>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setOrgOpen(false)}>CANCEL</button>
                <button className="btn btn-pri" disabled={busy || !orgName.trim() || !orgEmail.trim() || !orgPhone.trim() || orgPass.length < 8 || !/^[A-Z]{2}$/.test(orgCountry)}
                  onClick={() => void run(
                    () => proMgmtApi.createOrg({
                      display_name: orgName.trim(), email: orgEmail.trim(),
                      phone_e164: orgPhone.trim(), temp_password: orgPass, coverage_country: orgCountry,
                    }),
                    () => {
                      setMinted({kind: 'Organization', login: orgEmail.trim(), password: orgPass});
                      setOrgOpen(false); setOrgName(''); setOrgEmail(''); setOrgPhone('');
                      void mutateOrgs();
                    },
                  )}>
                  {busy ? 'CREATING…' : 'CREATE ORGANIZATION →'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Create vehicle modal (Issue 30 fleet catalog) ── */}
      {vehOpen ? (
        <div style={{position: 'fixed', inset: 0, background: 'rgba(4,16,31,0.7)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16}}
          onClick={() => { if (!busy) setVehOpen(false); }}>
          <div className="card" onClick={e => e.stopPropagation()} style={{width: 'min(600px, 94vw)', maxHeight: '90vh', overflowY: 'auto', border: '1px solid var(--act)'}}>
            <div className="card-header">
              <div className="card-header-title"><span className="bar" />ADD FLEET VEHICLE</div>
            </div>
            <div style={{padding: '6px 18px 18px', display: 'grid', gap: 12}}>
              <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
                <div><label style={labelStyle}>Call sign *</label>
                  <input style={inputStyle} value={vehCallSign} onChange={e => setVehCallSign(e.target.value)} placeholder="e.g. BRAVO-1" /></div>
                <div><label style={labelStyle}>Registration plate *</label>
                  <input style={{...inputStyle, fontFamily: 'var(--font-mono)'}} value={vehPlate} onChange={e => setVehPlate(e.target.value)} placeholder="e.g. DXB-A-12345" /></div>
                <div style={{gridColumn: '1 / -1'}}><label style={labelStyle}>Make &amp; model *</label>
                  <input style={inputStyle} value={vehMakeModel} onChange={e => setVehMakeModel(e.target.value)} placeholder="e.g. Mercedes-Benz S 680 Guard" /></div>
                <div><label style={labelStyle}>Colour</label>
                  <input style={inputStyle} value={vehColour} onChange={e => setVehColour(e.target.value)} placeholder="e.g. Obsidian Black" /></div>
                <div><label style={labelStyle}>Capacity (seats)</label>
                  <input style={inputStyle} inputMode="numeric" value={vehCapacity} onChange={e => setVehCapacity(e.target.value.replace(/[^\d]/g, ''))} /></div>
                <div><label style={labelStyle}>Armour grade</label>
                  <input style={inputStyle} value={vehArmorGrade} onChange={e => setVehArmorGrade(e.target.value)} placeholder="e.g. VR9 / B6" /></div>
                <div><label style={labelStyle}>Region code</label>
                  <input style={inputStyle} value={vehRegion} maxLength={8} onChange={e => setVehRegion(e.target.value)} placeholder="e.g. AE-DXB" /></div>
              </div>
              <label style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--tx-2)', cursor: 'pointer'}}>
                <input type="checkbox" checked={vehArmored} onChange={e => setVehArmored(e.target.checked)} />
                Armoured vehicle
              </label>
              <div><label style={labelStyle}>Notes</label>
                <input style={inputStyle} value={vehNotes} onChange={e => setVehNotes(e.target.value)} placeholder="Servicing, quirks, restrictions…" /></div>
              {err ? <div style={{fontSize: 11.5, color: 'var(--warn)'}}>{err}</div> : null}
              <div style={{display: 'flex', justifyContent: 'flex-end', gap: 10, borderTop: '1px solid var(--bd-2)', paddingTop: 14}}>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setVehOpen(false)}>CANCEL</button>
                <button className="btn btn-pri" disabled={busy || !vehCallSign.trim() || !vehMakeModel.trim() || !vehPlate.trim()}
                  onClick={() => void run(
                    () => proFleetApi.createFleet({
                      call_sign: vehCallSign.trim(), make_model: vehMakeModel.trim(), plate: vehPlate.trim(),
                      armored: vehArmored,
                      ...(vehColour.trim() ? {colour: vehColour.trim()} : {}),
                      ...(vehArmorGrade.trim() ? {armor_grade: vehArmorGrade.trim()} : {}),
                      ...(vehCapacity.trim() ? {capacity: Math.max(1, parseInt(vehCapacity, 10) || 4)} : {}),
                      ...(vehRegion.trim() ? {region_code: vehRegion.trim()} : {}),
                      ...(vehNotes.trim() ? {notes: vehNotes.trim()} : {}),
                    }),
                    () => { setVehOpen(false); void mutateFleet(); },
                  )}>
                  {busy ? 'ADDING…' : 'ADD VEHICLE →'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Create resource modal (Issue 30 inventory) ── */}
      {resOpen ? (
        <div style={{position: 'fixed', inset: 0, background: 'rgba(4,16,31,0.7)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16}}
          onClick={() => { if (!busy) setResOpen(false); }}>
          <div className="card" onClick={e => e.stopPropagation()} style={{width: 'min(540px, 94vw)', border: '1px solid var(--act)'}}>
            <div className="card-header">
              <div className="card-header-title"><span className="bar" />ADD RESOURCE</div>
            </div>
            <div style={{padding: '6px 18px 18px', display: 'grid', gap: 12}}>
              <div style={{display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12}}>
                <div><label style={labelStyle}>Kind *</label>
                  <select style={{...inputStyle, appearance: 'auto'}} value={resKind} onChange={e => setResKind(e.target.value as ProResourceKind)}>
                    <option value="comms">Comms</option>
                    <option value="medical">Medical</option>
                    <option value="tactical">Tactical</option>
                    <option value="other">Other</option>
                  </select></div>
                <div><label style={labelStyle}>Label *</label>
                  <input style={inputStyle} value={resLabel} onChange={e => setResLabel(e.target.value)} placeholder="e.g. Motorola APX comms set" /></div>
              </div>
              <div><label style={labelStyle}>Identifier / serial (ops-internal — never shown to the client)</label>
                <input style={{...inputStyle, fontFamily: 'var(--font-mono)'}} value={resIdentifier} onChange={e => setResIdentifier(e.target.value)} placeholder="Asset tag / serial number" /></div>
              <div><label style={labelStyle}>Notes</label>
                <input style={inputStyle} value={resNotes} onChange={e => setResNotes(e.target.value)} placeholder="Condition, quantity on hand…" /></div>
              {err ? <div style={{fontSize: 11.5, color: 'var(--warn)'}}>{err}</div> : null}
              <div style={{display: 'flex', justifyContent: 'flex-end', gap: 10, borderTop: '1px solid var(--bd-2)', paddingTop: 14}}>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setResOpen(false)}>CANCEL</button>
                <button className="btn btn-pri" disabled={busy || !resLabel.trim()}
                  onClick={() => void run(
                    () => proFleetApi.createResource({
                      kind: resKind, label: resLabel.trim(),
                      ...(resIdentifier.trim() ? {identifier: resIdentifier.trim()} : {}),
                      ...(resNotes.trim() ? {notes: resNotes.trim()} : {}),
                    }),
                    () => { setResOpen(false); void mutateRes(); },
                  )}>
                  {busy ? 'ADDING…' : 'ADD RESOURCE →'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Decline-request modal (CA-04/IS-04) — optional client-visible note ── */}
      {declineFor ? (
        <div style={{position: 'fixed', inset: 0, background: 'rgba(4,16,31,0.7)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16}}
          onClick={() => { if (!busy) setDeclineFor(null); }}>
          <div className="card" onClick={e => e.stopPropagation()} style={{width: 'min(480px, 92vw)', border: '1px solid var(--err)'}}>
            <div className="card-header">
              <div className="card-header-title"><span className="bar" />DECLINE REQUEST · {(declineFor.member_name ?? 'MEMBER').toUpperCase()}</div>
            </div>
            <div style={{padding: '6px 18px 18px', display: 'grid', gap: 12}}>
              <div style={{fontSize: 12.5, color: 'var(--tx-2)'}}>
                Declines {declineFor.mission_dates.length} requested date{declineFor.mission_dates.length > 1 ? 's' : ''} — the client is notified on their request card.
              </div>
              <textarea
                style={{...inputStyle, height: 'auto', minHeight: 80, resize: 'vertical', padding: '10px 12px', lineHeight: 1.5}}
                placeholder="Optional note shown to the client…"
                value={declineNote} onChange={e => setDeclineNote(e.target.value)} />
              {err ? <div style={{fontSize: 11.5, color: 'var(--warn)'}}>{err}</div> : null}
              <div style={{display: 'flex', justifyContent: 'flex-end', gap: 10}}>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setDeclineFor(null)}>CANCEL</button>
                <button className="btn btn-danger" disabled={busy}
                  onClick={() => {
                    const r = declineFor;
                    void run(
                      () => proAppsApi.declineMission(r.application_id, r.id, declineNote.trim() || undefined),
                      () => { setDeclineFor(null); setDeclineNote(''); void mutateReqs(); },
                    );
                  }}>
                  {busy ? 'DECLINING…' : 'DECLINE →'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── E2E-07: cancel a RESERVED date ──────────────────────────────────
          Before this route existed a SCHEDULED date could not be cancelled by
          anyone — not the client (no route), not ops (`decideMission` only
          accepted REQUESTED) — so the client's calendar kept painting it booked
          with no officer behind it.

          The copy states the blast radius deliberately. The server releases
          `pro_cpo_assignments WHERE mission_id = <this mission>`, so a client's
          standing dedicated officer (a different assignment row) survives. An
          operator who does not know that will not touch the button. */}
      {cancelFor ? (
        <div style={{position: 'fixed', inset: 0, background: 'rgba(4,16,31,0.7)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16}}
          onClick={() => { if (!busy) setCancelFor(null); }}>
          <div className="card" onClick={e => e.stopPropagation()} style={{width: 'min(520px, 92vw)', border: '1px solid var(--err)'}}>
            <div className="card-header">
              <div className="card-header-title"><span className="bar" />CANCEL RESERVATION · {(cancelFor.member_name ?? 'MEMBER').toUpperCase()}</div>
            </div>
            <div style={{padding: '6px 18px 18px', display: 'grid', gap: 12}}>
              <div style={{fontSize: 12.5, color: 'var(--tx-2)', lineHeight: 1.55}}>
                {/* Every date on the reservation, listed — cancelling releases
                    the whole mission, not just the one row shown in the panel,
                    so naming only `date` would understate what the button does
                    on a multi-date reservation. */}
                Releases {cancelFor.mission_dates.length} reserved
                date{cancelFor.mission_dates.length > 1 ? 's' : ''}
                {cancelFor.mission_dates.length > 0
                  ? ` (${[...cancelFor.mission_dates].sort().map(formatDateUtc).join(', ')})`
                  : ''}. The client is notified and the date stops showing as booked on their calendar.
              </div>
              <div style={{fontSize: 12, color: 'var(--tx-3)', lineHeight: 1.55, borderLeft: '2px solid var(--bd-2)', paddingLeft: 10}}>
                Officer assignments booked <b>for these dates</b> go back to the pool. A standing
                dedicated officer on this plan is <b>not</b> affected — only the assignments this
                reservation created. No money moves: the plan is prepaid and a date carries no charge.
              </div>
              <textarea
                style={{...inputStyle, height: 'auto', minHeight: 80, resize: 'vertical', padding: '10px 12px', lineHeight: 1.5}}
                placeholder="Optional note shown to the client (e.g. officer unavailable, client called to cancel)…"
                value={cancelNote} onChange={e => setCancelNote(e.target.value)} />
              {err ? <div style={{fontSize: 11.5, color: 'var(--warn)'}}>{err}</div> : null}
              <div style={{display: 'flex', justifyContent: 'flex-end', gap: 10}}>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setCancelFor(null)}>KEEP IT</button>
                <button className="btn btn-danger" disabled={busy}
                  onClick={() => {
                    const r = cancelFor;
                    setCancelBusyId(r.id);
                    void run(
                      () => proAppsApi.cancelMission(r.application_id, r.id, cancelNote.trim() || undefined),
                      () => { setCancelFor(null); setCancelNote(''); void mutateReqs(); void mutateAsg(); },
                    ).finally(() => setCancelBusyId(null));
                  }}>
                  {busy ? 'CANCELLING…' : 'CANCEL RESERVATION →'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Org drill-down (IS-09) — roster + protected members + audit log ── */}
      {orgFor ? (
        <div style={{position: 'fixed', inset: 0, background: 'rgba(4,16,31,0.7)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16}}
          onClick={() => setOrgFor(null)}>
          <div className="card" onClick={e => e.stopPropagation()} style={{width: 'min(640px, 94vw)', maxHeight: '88vh', overflowY: 'auto', border: '1px solid var(--act)'}}>
            <div className="card-header">
              <div className="card-header-title"><span className="bar" />{orgFor.display_name.toUpperCase()}{orgFor.internal ? ' · INTERNAL' : ''}</div>
            </div>
            <div style={{padding: '6px 18px 18px', display: 'grid', gap: 14}}>
              <div style={{fontSize: 12, color: 'var(--tx-3)', fontFamily: 'var(--font-mono)'}}>
                {orgFor.email} · {orgFor.cpo_count} CPO{orgFor.cpo_count === 1 ? '' : 's'} · {orgFor.live_assignments} live ·
                created {formatDateUtc(orgFor.created_at)} · {orgFor.id}<CopyId value={orgFor.id} title="Copy org id" />
              </div>

              <div>
                <label style={labelStyle}>Roster</label>
                {orgInfoErr ? (
                  <div style={{fontSize: 12, color: 'var(--warn)'}}>{orgInfoErr}</div>
                ) : orgInfo === null ? (
                  <div style={{fontSize: 12, color: 'var(--tx-3)'}}>Loading…</div>
                ) : orgInfo.roster.length === 0 ? (
                  <div style={{fontSize: 12, color: 'var(--tx-3)'}}>No members.</div>
                ) : (
                  <div style={{display: 'grid', gap: 4}}>
                    {orgInfo.roster.map(mem => (
                      <div key={mem.user_id} style={{display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--bd-2)', borderRadius: 8, padding: '7px 10px', fontSize: 12}}>
                        <span style={{flex: 1, minWidth: 0, color: 'var(--tx-1)'}}>
                          {mem.display_name}{mem.call_sign ? ` · ${mem.call_sign}` : ''}
                          <span style={{color: 'var(--tx-3)'}}> — {mem.member_role}{mem.agent_status ? ` · agent ${mem.agent_status}` : ''}</span>
                        </span>
                        <span className={`pill pill-${mem.status === 'active' ? 'ok' : 'warn'}`}>{mem.status}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <label style={labelStyle}>Protected members</label>
                {orgInfo === null && !orgInfoErr ? (
                  <div style={{fontSize: 12, color: 'var(--tx-3)'}}>Loading…</div>
                ) : (orgInfo?.protected_members ?? []).length === 0 ? (
                  <div style={{fontSize: 12, color: 'var(--tx-3)'}}>None yet.</div>
                ) : (
                  <div style={{display: 'grid', gap: 4}}>
                    {(orgInfo?.protected_members ?? []).map(pm => (
                      <button key={pm.application_id} className="btn btn-ghost btn-sm" style={{justifyContent: 'space-between', width: '100%'}}
                        onClick={() => router.push(routes.pro.application(pm.application_id))}>
                        <span>{pm.member_name}</span>
                        <span style={{color: 'var(--tx-3)'}}>{pm.application_status} · OPEN PLAN →</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <label style={labelStyle}>Org audit log · last 50</label>
                {orgAuditErr ? (
                  <div style={{fontSize: 12, color: 'var(--warn)'}}>{orgAuditErr}</div>
                ) : orgAuditRows === null ? (
                  <div style={{fontSize: 12, color: 'var(--tx-3)'}}>Loading…</div>
                ) : orgAuditRows.length === 0 ? (
                  <div style={{fontSize: 12, color: 'var(--tx-3)'}}>No audit entries.</div>
                ) : (
                  <div style={{display: 'grid', gap: 3, maxHeight: 220, overflowY: 'auto'}}>
                    {orgAuditRows.map(a => (
                      <div key={a.id} style={{display: 'flex', gap: 10, fontSize: 11, padding: '5px 0', borderBottom: '1px solid var(--bd-2)'}}>
                        <span style={{color: 'var(--tx-3)', fontFamily: 'var(--font-mono)', flexShrink: 0}}>
                          {formatDateTimeShortUtc(a.created_at)}
                        </span>
                        <span style={{color: 'var(--tx-1)', fontFamily: 'var(--font-mono)', minWidth: 0}}>
                          {a.action}{a.target_kind ? ` · ${a.target_kind}${a.target_id ? ` ${a.target_id.slice(0, 8)}` : ''}` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div style={{display: 'flex', justifyContent: 'flex-end'}}>
                <button className="btn btn-ghost" onClick={() => setOrgFor(null)}>CLOSE</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Generic confirm step for destructive one-click actions ── */}
      {confirmAct ? (
        <div style={{position: 'fixed', inset: 0, background: 'rgba(4,16,31,0.7)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16}}
          onClick={() => { if (!busy) setConfirmAct(null); }}>
          <div className="card" onClick={e => e.stopPropagation()} style={{width: 'min(460px, 92vw)', border: '1px solid var(--err)'}}>
            <div className="card-header">
              <div className="card-header-title"><span className="bar" />{confirmAct.title}</div>
            </div>
            <div style={{padding: '6px 18px 18px', display: 'grid', gap: 12}}>
              <div style={{fontSize: 12.5, color: 'var(--tx-2)', lineHeight: 1.5}}>{confirmAct.body}</div>
              <div style={{display: 'flex', justifyContent: 'flex-end', gap: 10}}>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirmAct(null)}>KEEP IT</button>
                <button className="btn btn-danger" disabled={busy}
                  onClick={() => { const act = confirmAct; setConfirmAct(null); act.run(); }}>
                  {confirmAct.label}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
