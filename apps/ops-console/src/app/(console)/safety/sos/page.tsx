'use client';

import {useState} from 'react';
import Link from 'next/link';
import {ConfirmReasonModal} from '@/components/ConfirmReasonModal';
import {TruncationNotice} from '@/components/TruncationNotice';
import {useToast} from '@/components/Toast';
import {opsApi, useOpsMe, useSosEvents, type SosEventRow} from '@/lib/api';
import {canAckSos, canEscalateSos, canResolveSos} from '@/lib/rbac';
import {formatDateTimeUtc} from '@/lib/datetime';
import {routes} from '@/lib/routes';

const STATUSES = ['active', 'resolved', 'all'] as const;
type SosFilter = (typeof STATUSES)[number];

const ESCALATE_TARGETS = ['POLICE', 'EMBASSY', 'CLIENT_FAMILY', 'OTHER'] as const;

/**
 * E2E-42 — `GET /ops/sos` truncates at 200 by default and 500 at most
 * (ops-data.service.ts:359, OpsSosQueryDto `@Max(500)`), with no `offset` — so
 * this is a growing window, not `usePagedList`. The first screen deliberately
 * asks for NO limit so it shares the alert bar's SWR key (see useSosEvents).
 */
const SOS_DEFAULT_CAP = 200;
const SOS_MAX_CAP = 500;

type SosState = 'RESOLVED' | 'ESCALATED' | 'ACKED' | 'UNACKED';

function stateOf(r: SosEventRow): SosState {
  if (r.resolved_at) return 'RESOLVED';
  if (r.escalated_at) return 'ESCALATED';
  if (r.acknowledged_at) return 'ACKED';
  return 'UNACKED';
}

const STATE_CLASS: Record<SosState, string> = {
  RESOLVED: 'text-ok',
  ESCALATED: 'text-err',
  ACKED: 'text-acc',
  UNACKED: 'animate-pulse text-err',
};

export default function SosPage() {
  const [status, setStatus] = useState<SosFilter>('active');
  // `undefined` until the operator asks for more: that key is the one the
  // console-wide alert bar and the Shell badge already hold, so the optimistic
  // ACK below silences the chime with no round trip. After a LOAD MORE this
  // page forks onto its own key and the bar catches up on its next 2 s poll
  // instead — a deliberate trade, and the reason the default is not just 500.
  // Reset on a filter change: a new view starts at the shared key again.
  const [cap, setCap] = useState<number | undefined>(undefined);
  const {data, isLoading, error, mutate} = useSosEvents(status, cap);
  const {data: me} = useOpsMe();
  // E2E-18 — this page hand-rolled `role === 'SUPERVISOR' || role === 'ADMIN'`
  // for escalate/resolve and gated ACK with NOTHING at all, while /live/[id]
  // asked `canAckSos`. Two dialects for one lane is exactly how the gate
  // drifted from `POST /ops/sos/:id/ack` (SUPERVISOR+ since AUTHZ-5). All
  // three now come from the same helpers the endpoints are mirrored in.
  const role = me?.admin.role;
  const mayAck = canAckSos(role);
  const mayEscalate = canEscalateSos(role);
  const mayResolve = canResolveSos(role);
  // `me` is still loading on first paint: don't claim "not permitted" before
  // the role is known, and don't render a live control either.
  const roleKnown = !!role;
  const [busyId, setBusyId] = useState<string | null>(null);
  const [escalateTo, setEscalateTo] = useState<Record<string, string>>({});
  // IS-15 — validated resolution modal replaces window.prompt.
  const [resolveFor, setResolveFor] = useState<SosEventRow | null>(null);
  const {push} = useToast();
  // Review round 2 — a rolled-back optimistic row keeps a PERSISTENT reason
  // on screen; the toast auto-dismisses.
  const [lastErr, setLastErr] = useState<string | null>(null);

  // OP-17 — optimistic: the row flips (ACKED / ESCALATED / RESOLVED) the
  // instant the operator clicks; SWR rolls it back if the server refuses and
  // revalidates either way. SosAlertBar and the Shell share the 'active'
  // key, so an ack silences the chime without waiting a round trip.
  async function run(id: string, fn: () => Promise<unknown>, patch: (r: SosEventRow) => SosEventRow, label: string) {
    if (busyId) return;
    setBusyId(id);
    const apply = (rows: SosEventRow[] | undefined) => (rows ?? []).map(r => (r.id === id ? patch(r) : r));
    try {
      await mutate(
        async current => { await fn(); return apply(current); },
        {optimisticData: apply, rollbackOnError: true, revalidate: true},
      );
      setLastErr(null);
      push({kind: 'ok', text: label});
    } catch (e) {
      setLastErr(`${label} failed: ${(e as Error).message}`);
      push({kind: 'err', text: `${label} failed: ${(e as Error).message}`});
    } finally {
      setBusyId(null);
    }
  }

  function ack(r: SosEventRow) {
    const at = new Date().toISOString();
    void run(r.id, () => opsApi.ackSos(r.id), x => ({...x, acknowledged_at: x.acknowledged_at ?? at}), 'SOS acknowledged');
  }

  function escalate(r: SosEventRow) {
    const target = escalateTo[r.id] ?? 'POLICE';
    if (!window.confirm(`Escalate this SOS to ${target}?`)) return;
    const at = new Date().toISOString();
    void run(r.id, () => opsApi.escalateSos(r.id, target), x => ({...x, escalated_at: at, escalated_to: target}), `SOS escalated to ${target}`);
  }

  function confirmResolve(resolution: string) {
    const r = resolveFor;
    setResolveFor(null);
    if (!r) return;
    const at = new Date().toISOString();
    void run(r.id, () => opsApi.resolveSos(r.id, resolution), x => ({...x, resolved_at: at, resolution}), 'SOS resolved');
  }

  return (
    <>
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-xl font-bold text-t1">SOS Event Log</h1>
          <p className="text-sm text-t3">
            Every SOS on the platform — including mission-less client/VBG panic events which have no
            mission drill-down. Unacknowledged events pulse red until an operator acks them.
          </p>
          {/* E2E-18 — the console-wide alert bar sends EVERY operator here with
              "RESPOND →", OPS tier included. Say up front that this seat can
              watch but not work the lane, instead of leaving them to discover
              it from an empty Actions column. */}
          {roleKnown && !mayAck && (
            <p role="status" className="mt-2 text-sm text-warn">
              Your role can view this log but cannot acknowledge, escalate or resolve — the whole SOS
              lane is SUPERVISOR+. Raise it with a supervisor on shift.
            </p>
          )}
        </div>

        <div className="flex gap-2">
          {STATUSES.map(s => (
            <button
              key={s}
              onClick={() => { setStatus(s); setCap(undefined); }}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold uppercase ${
                status === s ? 'bg-bd1 text-t1' : 'border border-bd1 text-t3 hover:bg-s1'
              }`}>
              {s}
            </button>
          ))}
        </div>

        {lastErr && <p role="alert" className="text-sm text-err">{lastErr}</p>}
        {isLoading && !data ? <p className="text-sm text-t3">Loading…</p>
          : error ? <p className="text-sm text-err">{(error as Error).message}</p>
          : (data?.length ?? 0) === 0 ? <p className="text-sm text-t3">No SOS events in this view.</p>
          : (
            <div className="overflow-hidden rounded-xl border border-bd2">
              <table className="w-full text-sm">
                <thead className="bg-s2 text-left text-xs uppercase text-t3">
                  <tr>
                    <th className="px-3 py-2">Triggered</th><th className="px-3 py-2">Who</th>
                    <th className="px-3 py-2">Reason</th><th className="px-3 py-2">Mission</th>
                    <th className="px-3 py-2">Region</th><th className="px-3 py-2">Position</th>
                    <th className="px-3 py-2">State</th><th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-bd2">
                  {data!.map(r => {
                    const state = stateOf(r);
                    return (
                      <tr key={r.id} className="text-t2">
                        <td className="px-3 py-2 text-t3">{formatDateTimeUtc(r.triggered_at)}</td>
                        <td className="px-3 py-2 text-t1">{r.agent_call_sign ?? r.user_display_name ?? '—'}</td>
                        <td className="px-3 py-2 text-t3">{r.reason ?? '—'}</td>
                        <td className="px-3 py-2">
                          {r.mission_id ? (
                            <Link href={routes.lite.mission(r.mission_id)} className="font-mono text-xs text-acc hover:underline">
                              {r.mission_short_code ?? r.mission_id.slice(0, 8)}
                            </Link>
                          ) : (
                            <span className="rounded bg-warn/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-warn">
                              PANIC
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-t3">{r.region_label ?? '—'}</td>
                        <td className="px-3 py-2 font-mono text-xs text-t3">
                          {r.lat != null && r.lng != null ? `${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}` : '—'}
                        </td>
                        <td className={`px-3 py-2 font-semibold ${STATE_CLASS[state]}`}>{state}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            {!r.acknowledged_at && mayAck && (
                              <button
                                onClick={() => ack(r)}
                                disabled={busyId === r.id}
                                className="rounded-md border border-act/40 px-2 py-1 text-[10px] font-semibold text-acc hover:bg-act/10 disabled:opacity-50">
                                ACK
                              </button>
                            )}
                            {mayEscalate && r.acknowledged_at && !r.escalated_at && !r.resolved_at && (
                              <>
                                <select
                                  value={escalateTo[r.id] ?? 'POLICE'}
                                  onChange={e => setEscalateTo(p => ({...p, [r.id]: e.target.value}))}
                                  className="rounded-md border border-bd1 bg-s2 px-1.5 py-1 text-[10px] text-t2">
                                  {ESCALATE_TARGETS.map(t => <option key={t} value={t}>{t}</option>)}
                                </select>
                                <button
                                  onClick={() => escalate(r)}
                                  disabled={busyId === r.id}
                                  className="rounded-md border border-err/40 px-2 py-1 text-[10px] font-semibold text-err hover:bg-err/10 disabled:opacity-50">
                                  ESCALATE
                                </button>
                              </>
                            )}
                            {mayResolve && !r.resolved_at && (
                              <button
                                onClick={() => setResolveFor(r)}
                                disabled={busyId === r.id}
                                className="rounded-md border border-ok/40 px-2 py-1 text-[10px] font-semibold text-ok hover:bg-ok/10 disabled:opacity-50">
                                RESOLVE
                              </button>
                            )}
                            {/* An OPS operator can WATCH the SOS lane but not
                                work it. Say so, rather than showing an empty
                                Actions cell that reads like a loading state. */}
                            {roleKnown && !mayAck && !r.resolved_at && (
                              <span className="text-[10px] font-semibold uppercase text-t3" title="POST /ops/sos/:id/ack requires SUPERVISOR or ADMIN">
                                SUPERVISOR+
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {/* E2E-42 — the list stopped at the server cap and said nothing.
                  A safety log that silently hides the oldest events is the one
                  place truncation must never be invisible. */}
              <TruncationNotice
                shown={data!.length}
                cap={cap ?? SOS_DEFAULT_CAP}
                noun="SOS events"
                onLoadMore={cap === undefined ? () => setCap(SOS_MAX_CAP) : undefined}
                // LOAD MORE swaps the SWR key, so `isLoading` is the in-flight
                // signal for the wider window (`keepPreviousData` keeps the
                // current rows on screen underneath it).
                loadingMore={isLoading}
                hint={`${SOS_MAX_CAP} is the server maximum — filter by state to reach older events.`}
              />
            </div>
          )}
      </div>

      <ConfirmReasonModal
        open={resolveFor !== null}
        title="Resolve this SOS?"
        description={resolveFor ? `${resolveFor.agent_call_sign ?? resolveFor.user_display_name ?? 'Event'} · triggered ${formatDateTimeUtc(resolveFor.triggered_at)}` : undefined}
        reasonLabel="Resolution note"
        reasonPlaceholder="What happened and how it was closed out…"
        confirmLabel="RESOLVE SOS"
        busy={busyId !== null}
        onConfirm={confirmResolve}
        onCancel={() => setResolveFor(null)}
      />
    </>
  );
}
