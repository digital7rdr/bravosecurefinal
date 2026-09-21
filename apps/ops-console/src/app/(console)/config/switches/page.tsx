'use client';

/**
 * IA-07 / IA-15 — runtime switches, plus an honest list of what is NOT one.
 *
 * The auto-dispatch kill switch lived only on the dispatch monitor, and the
 * env-only economics (platform fee, cancellation fee) and the baked-in app
 * flags lived nowhere at all — so an operator hunting for them had no way to
 * learn they are not ops-changeable. Showing them greyed with the reason is
 * more useful than hiding them.
 */

import {useState} from 'react';
import {ApiError, opsApi, useOpsMe} from '@/lib/api';
import useSWR from 'swr';
import {PageHeader} from '@/components/PageHeader';
import {ConfigTabs} from '@/features/config/ConfigTabs';
import {canFlipKillswitch} from '@/lib/rbac';
import {CONFIG_DESCRIPTORS} from '@/features/config/propagation';

export default function SwitchesPage() {
  const {data: me} = useOpsMe();
  const canFlip = canFlipKillswitch(me?.admin.role);
  const {data, mutate, error} = useSWR('dispatch-killswitch', () => opsApi.killswitchState(), {
    refreshInterval: 15_000,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const enabled = data?.enabled ?? true;

  async function flip(next: boolean) {
    // OC-03 — one click here stops or starts every automatic dispatch on the
    // platform. Make the operator read what they are about to do.
    // eslint-disable-next-line no-alert
    if (!window.confirm(next
      ? 'Re-arm auto-dispatch? New bookings will start cascading offers to agencies again.'
      : 'Disarm auto-dispatch? Every new booking will wait for a human until this is turned back on.')) {
      return;
    }
    setBusy(true); setErr(null);
    try {
      await opsApi.setKillswitch(next);
      await mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not change the switch.');
    } finally {
      setBusy(false);
    }
  }

  const locked = CONFIG_DESCRIPTORS.filter(d => d.href === null);

  return (
    <>
      <PageHeader
        title="Switches"
        subtitle="Runtime behaviour ops can change without a deploy, and — below the line — the behaviour that needs one."
      />
      <ConfigTabs />

      <div className="card" style={{marginBottom: 16}}>
        <div className="card-header">
          <div className="card-header-title"><span className="bar" />Auto-dispatch</div>
          <div className="card-header-act">
            {error ? 'STATE UNKNOWN' : enabled ? 'ARMED' : 'DISARMED'}
          </div>
        </div>
        <div style={{padding: '14px 16px'}}>
          <div style={{display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap'}}>
            <span className={enabled ? 'pill pill-ok' : 'pill pill-err'}>
              {enabled ? '● ARMED' : '● DISARMED'}
            </span>
            {canFlip ? (
              <button
                className={enabled ? 'btn btn-sm btn-danger' : 'btn btn-sm btn-ok'}
                disabled={busy}
                onClick={() => { void flip(!enabled); }}>
                {busy ? 'APPLYING…' : enabled ? 'DISARM' : 'RE-ARM'}
              </button>
            ) : (
              <span className="cfg-meta">ADMIN ONLY</span>
            )}
          </div>
          {err && <div className="modal-err">{err}</div>}
          <div className="cfg-meta" style={{marginTop: 10, lineHeight: 1.7}}>
            Shared Redis state, so it reaches every server in under two seconds — the one
            configuration value that propagates immediately. Disarming does not touch bookings
            already cascading; it stops NEW ones from entering the engine, and they wait in
            Pending Ops for a human instead.
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div className="card-header-title"><span className="bar" />Not changeable from the console</div>
        </div>
        {locked.map(d => (
          <div key={d.key} style={{padding: '12px 16px', borderBottom: '1px solid var(--bd-2)'}}>
            <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap'}}>
              <span className="cfg-name">{d.label}</span>
              <span className="pill pill-warn">
                {d.locked === 'deploy' ? 'NEEDS DEPLOY' : 'NEEDS APP RELEASE'}
              </span>
            </div>
            <div className="cfg-meta" style={{marginTop: 5}}>
              {d.appReads} · {d.lands}
              {d.caveat && <div style={{marginTop: 5, color: 'var(--warn)'}}>⚠ {d.caveat}</div>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
