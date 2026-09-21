'use client';

import {useState} from 'react';
import useSWR from 'swr';
import {useDispatchMonitor, useOpsMe, opsApi} from '@/lib/api';
import {canCancelDispatch, canForceAssign, canFlipKillswitch, type AdminRole} from '@/lib/rbac';
import {PageHeader} from '@/components/PageHeader';
import {DispatchTabs} from '@/features/dispatch/DispatchTabs';
import {AreasPanel} from './AreasPanel';


function Countdown({expiresAt}: {expiresAt: string}) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  const s = Math.max(0, Math.round(ms / 1000));
  return <span className={s > 0 ? 'text-warn' : 'text-t3'}>{s > 0 ? `${s}s` : 'expired'}</span>;
}

function offerTint(status: string): string {
  if (status === 'ACCEPTED') return 'text-ok';
  if (status === 'OFFERED') return 'text-warn';
  if (status === 'REJECTED' || status === 'EXPIRED') return 'text-t3';
  return 'text-t3';
}

export default function DispatchMonitorPage() {
  const {data, isLoading, error, mutate} = useDispatchMonitor();
  const me = useOpsMe();
  const role = me.data?.admin.role as AdminRole | undefined;
  const ks = useSWR('dispatch-killswitch', () => opsApi.killswitchState(), {refreshInterval: 5000});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const runAction = async (id: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(id); setMsg(null);
    try { await fn(); setMsg(ok); await mutate(); }
    catch (e) { setMsg(`Failed: ${(e as Error).message}`); }
    finally { setBusy(null); }
  };

  const flipKillswitch = async (enabled: boolean) => {
    if (!window.confirm(`${enabled ? 'Enable' : 'KILL'} auto-dispatch globally?`)) {return;}
    await runAction('ks', () => opsApi.setKillswitch(enabled), `Auto-dispatch ${enabled ? 'enabled' : 'killed'}.`);
    await ks.mutate();
  };

  return (
    <>
      <div className="space-y-6 p-6">
        <PageHeader
          title="Auto-Dispatch Monitor"
          subtitle="The matchmaker's live state: which bookings it is cascading right now, which agency holds each offer, and what it settled recently. Polls every 2 seconds."
        />
        <DispatchTabs />

        {/* Runtime kill switch */}
        <div className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 ${
          ks.data?.enabled ? 'border-ok/40 bg-ok/10' : 'border-err/40 bg-err/10'}`}>
          <div className="text-sm">
            <span className="font-semibold text-t2">Auto-dispatch is </span>
            <span className={ks.data?.enabled ? 'font-bold text-ok' : 'font-bold text-err'}>
              {ks.data ? (ks.data.enabled ? 'LIVE' : 'OFF (legacy flow)') : '…'}
            </span>
            <span className="ml-2 font-mono text-xs text-t3">runtime={ks.data?.runtime ?? '…'}</span>
          </div>
          {canFlipKillswitch(role) && ks.data && (
            <button onClick={() => void flipKillswitch(!ks.data!.enabled)} disabled={busy === 'ks'}
              className={`rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50 ${
                ks.data.enabled ? 'bg-err-solid text-white hover:bg-err-solid/80' : 'bg-ok text-canvas hover:bg-ok/80'}`}>
              {busy === 'ks' ? '…' : ks.data.enabled ? 'Kill auto-dispatch' : 'Enable auto-dispatch'}
            </button>
          )}
        </div>

        {/* Audit PAGE-12 — cancel and force-assign are the only mutations left on
            this page after the test harness moved out, and BOTH must report.
            The banner used to live inside the fire-test card; without it a
            failed override would have been silently swallowed. */}
        {msg && (
          <p role="alert" className={`text-sm ${msg.startsWith('Failed:') ? 'text-err' : 'text-t2'}`}>
            {msg}
          </p>
        )}

        {/* DISPATCHING now */}
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-t3">Dispatching now</h2>
          {isLoading ? <p className="text-sm text-t3">Loading…</p>
            : error ? <p className="text-sm text-err">{(error as Error).message}</p>
            : (data?.dispatching.length ?? 0) === 0 ? <p className="text-sm text-t3">No active dispatches. Fire one above.</p>
            : (
              <div className="space-y-3">
                {data!.dispatching.map(b => (
                  <div key={b.booking_id} className="rounded-xl border border-bd2 bg-s2 p-4">
                    <div className="flex items-center justify-between">
                      <div className="text-sm text-t2">
                        <span className="font-mono text-warn">DISPATCHING</span>{' '}
                        · {b.region_code} · {b.cpo_count} CPO{b.cpo_count > 1 ? 's' : ''}{b.armed_required ? ' · armed' : ''}
                        <span className="ml-2 font-mono text-xs text-t3">{b.booking_id.slice(0, 8)}</span>
                      </div>
                      <span className="flex items-center gap-3">
                        <span className="text-xs text-t3">{b.offers.length} offer(s)</span>
                        {canCancelDispatch(role) && (
                          <button onClick={() => {
                            // Audit PAGE-08 — confirm before cancelling a live customer booking.
                            if (!window.confirm(`Cancel dispatch for booking ${b.booking_id.slice(0, 8)}?\n\nThis stops all offers for a live customer booking.`)) {return;}
                            void runAction(`cancel-${b.booking_id}`,
                              () => opsApi.cancelDispatch(b.booking_id), 'Booking cancelled.');
                          }}
                            disabled={busy === `cancel-${b.booking_id}`}
                            className="rounded-md border border-err/40 px-2.5 py-1 text-xs font-semibold text-err hover:bg-err/10 disabled:opacity-50">
                            Cancel
                          </button>
                        )}
                        {canForceAssign(role) && b.offers.some(o => o.status === 'OFFERED') && (
                          <button onClick={() => {
                            // Audit PAGE-08 — force-assign runs the real accept saga and charges escrow.
                            if (!window.confirm(`Force-assign booking ${b.booking_id.slice(0, 8)} to the live offer?\n\nThis runs the real accept saga and charges escrow to the provider.`)) {return;}
                            void runAction(`force-${b.booking_id}`,
                              () => opsApi.forceAssign(b.booking_id), 'Force-assigned to the live offer.');
                          }}
                            disabled={busy === `force-${b.booking_id}`}
                            className="rounded-md border border-act/40 px-2.5 py-1 text-xs font-semibold text-acc hover:bg-act/10 disabled:opacity-50">
                            Force-assign
                          </button>
                        )}
                      </span>
                    </div>
                    <div className="mt-3 space-y-1">
                      {b.offers.length === 0 ? (
                        <p className="text-sm text-t3">No eligible agency matched yet (or NO_PROVIDER).</p>
                      ) : b.offers.map(o => (
                        <div key={o.offer_id} className="flex items-center justify-between rounded-md bg-s1 px-3 py-2 text-sm">
                          <span className="text-t2">#{o.rank} {o.provider_email ?? o.provider_user_id.slice(0, 8)}{o.distance_km ? ` · ${Number(o.distance_km).toFixed(1)}km` : ''}</span>
                          <span className="flex items-center gap-3">
                            <span className={offerTint(o.status)}>{o.status}</span>
                            {o.status === 'OFFERED' && <Countdown expiresAt={o.expires_at} />}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
        </div>

        {/* Recently settled */}
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-t3">Recently settled (auto)</h2>
          {(data?.recent.length ?? 0) === 0 ? <p className="text-sm text-t3">None yet.</p> : (
            <div className="overflow-hidden rounded-xl border border-bd2">
              <table className="w-full text-sm">
                <thead className="bg-s2 text-left text-xs uppercase text-t3">
                  <tr><th className="px-3 py-2">Booking</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Region</th><th className="px-3 py-2">Agency</th></tr>
                </thead>
                <tbody className="divide-y divide-bd2">
                  {data!.recent.map(r => {
                    // Money-taken / no-mission watch: a CONFIRMED booking has been charged
                    // into escrow on accept but has no mission/crew yet — flag it amber.
                    const charged = r.status === 'CONFIRMED';
                    return (
                      <tr key={r.booking_id} className={charged ? 'bg-warn/10 text-warn' : 'text-t2'}>
                        <td className="px-3 py-2 font-mono text-xs">{r.booking_id.slice(0, 8)}</td>
                        <td className="px-3 py-2">{r.status}{charged ? ' · charged, awaiting crew' : ''}</td>
                        <td className="px-3 py-2">{r.region_code}</td>
                        <td className="px-3 py-2">{r.provider_email ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* B-788a — Dispatch v2: areas, provider ladders, the per-region routing
            switch. Below the live monitor: operations first, configuration second. */}
        <AreasPanel />

      </div>
    </>
  );
}
