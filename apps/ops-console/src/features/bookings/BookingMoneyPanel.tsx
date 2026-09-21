'use client';

/**
 * IA-06 — the review-hold exit, finally reachable.
 *
 * `POST /ops/bookings/:id/resolve-review` (MON-2) is the ONLY operator exit for
 * an escrow left HELD + `review_required` by the proof-of-completion gate. It
 * shipped with role guards, an audit row and idempotency — and no client method
 * and no button anywhere in the console. The finance escrow tab rendered a
 * "REVIEW" badge on the row and stopped there, so the money sat until someone
 * ran SQL.
 *
 * B-807 — the exit is now a DECISION BRIEF, not a two-button prompt. The
 * operator sees, before pressing anything: what the hold is (gross, parties,
 * dates), WHY the gate parked it (the persisted check ids, each with what was
 * checked and what to verify), and exactly what each outcome moves (the
 * platform fee is fetched from the region's live pricing board, and the split
 * mirrors the server's own rounding — `lib/escrowRules.ts`).
 *
 * This panel is used in two places, deliberately the same component: the
 * booking detail (where the operator is looking at the job) and the finance
 * escrow tab (where they are looking at the money).
 */

import {useState} from 'react';
import useSWR from 'swr';
import {ApiError, opsDataApi, opsSectionsApi, type EscrowRow} from '@/lib/api';
import {StatusPill} from '@/components/StatusPill';
import {formatDateTimeUtc} from '@/lib/datetime';
import {gateReasonRule, reviewReleasePreview} from '@/lib/escrowRules';

const MIN_REASON = 8;

const mono = {fontFamily: 'var(--font-mono)'} as const;
const label = {...mono, fontSize: 9.5, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--tx-3)'} as const;

/**
 * The region's live platform fee (the number releaseEscrowHold will use).
 * `enabled` false = do not fetch (dialog closed). A booking with no region
 * resolves GLOBAL, exactly as `settleEscrowRelease` → `pricing.config(null)`.
 */
function usePlatformFeePct(region: string | null | undefined, enabled: boolean) {
  const resolved = (region ?? '').trim().toUpperCase() || 'GLOBAL';
  // Same SWR key as the pricing board so an open board and an open dialog
  // share one fetch. SUPERVISOR+ (the only role that can open this dialog).
  const key = enabled ? ['ops-service-pricing', resolved] : null;
  const {data, error, isLoading} = useSWR(key, () => opsDataApi.servicePricing(resolved));
  const row = data?.pricing.find(p => p.key === 'platform_fee_pct');
  return {feePct: row ? row.value : null, inherited: row?.inherited ?? true, error, isLoading, region: resolved};
}

function Fact({k, v}: {k: string; v: React.ReactNode}) {
  return (
    <div style={{minWidth: 0}}>
      <div style={label}>{k}</div>
      <div style={{fontSize: 12.5, color: 'var(--tx-1)', marginTop: 2, overflowWrap: 'anywhere'}}>{v}</div>
    </div>
  );
}

export function ReviewHoldAction({
  hold, canResolve, onDone,
}: {hold: EscrowRow; canResolve: boolean; onDone: () => void}) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<'release' | 'refund' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fee = usePlatformFeePct(hold.region_code, open);
  // null while the fee is unknown — the dialog then shows NO amount rather than
  // a 0-fee guess (the server's default is 15%, never 0).
  const release = reviewReleasePreview(hold.gross_credits, fee.feePct);
  const grossLabel = `${Number(hold.gross_credits).toLocaleString()} BC`;
  const reasons = (hold.review_reasons ?? []).map(gateReasonRule);
  const bookingId = hold.booking_id;

  if (!canResolve) {
    return (
      <span style={{...mono, fontSize: 9.5, color: 'var(--tx-3)'}}>
        SUPERVISOR+ TO RESOLVE
      </span>
    );
  }

  function close() {
    if (busy) return;
    setOpen(false); setErr(null); setAction(null);
  }

  async function submit() {
    if (!action) {
      setErr('Choose an outcome first.');
      return;
    }
    if (reason.trim().length < MIN_REASON) {
      setErr(`Give a reason of at least ${MIN_REASON} characters — it lands in the audit trail and is what the next reviewer reads.`);
      return;
    }
    setBusy(true); setErr(null);
    try {
      await opsSectionsApi.resolveReviewHold(bookingId, {action, reason: reason.trim()});
      setOpen(false); setReason(''); setAction(null);
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not resolve the hold.');
    } finally {
      setBusy(false);
    }
  }

  const choice = (
    key: 'release' | 'refund', title: string, amount: string, lines: string[], tone: 'ok' | 'warn',
  ) => {
    const on = action === key;
    return (
      <button
        type="button"
        aria-pressed={on}
        onClick={() => setAction(key)}
        style={{
          textAlign: 'left', cursor: 'pointer', borderRadius: 10, padding: '12px 14px', minWidth: 0,
          background: on ? `color-mix(in srgb, var(--${tone}) 8%, transparent)` : 'var(--surf-3)',
          border: `1px solid ${on ? (tone === 'ok' ? 'var(--ok)' : 'var(--warn)') : 'var(--bd-2)'}`,
          color: 'var(--tx-1)',
        }}>
        <div style={{display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline', flexWrap: 'wrap'}}>
          <span style={{fontFamily: 'var(--font-sans)', fontWeight: 800, fontSize: 13}}>{title}</span>
          <span className="dt-val" style={{color: tone === 'ok' ? 'var(--ok)' : 'var(--warn)'}}>{amount}</span>
        </div>
        <ul style={{margin: '8px 0 0', paddingLeft: 16, fontSize: 11.5, color: 'var(--tx-2)', lineHeight: 1.55}}>
          {lines.map(l => <li key={l}>{l}</li>)}
        </ul>
      </button>
    );
  };

  return (
    <>
      <button className="btn btn-sm btn-ok" onClick={() => setOpen(true)}>RESOLVE REVIEW</button>
      {open && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Resolve review hold" onClick={close}>
          <div className="modal-card" style={{width: 'min(720px, 100%)'}} onClick={e => e.stopPropagation()}>
            <div style={{...label, marginBottom: 6}}>Bravo Ops · Escrow review · booking {bookingId.slice(0, 8)}</div>
            <div className="modal-title">Decide a parked hold</div>
            <p className="modal-body-text">
              The assigned lead pressed Finish, but the server-side proof-of-completion gate could not
              verify the mission from the evidence it collects (timeline, GPS, check-ins, identity).
              The mission is closed operationally; the money is not. It will never auto-release.
              You are the only exit: release pays the provider, refund returns the credits to the client.
              Both are final and audited against your call sign.
            </p>

            {/* ── The hold ─────────────────────────────────────────────── */}
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12,
              padding: '12px 14px', margin: '14px 0', borderRadius: 10, background: 'var(--surf-3)', border: '1px solid var(--bd-2)',
            }}>
              <Fact k="Gross held" v={<span className="dt-val">{Number(hold.gross_credits).toLocaleString()} BC</span>} />
              <Fact k="Client" v={hold.client_name ?? '—'} />
              <Fact k="Provider" v={hold.provider_name ?? '—'} />
              <Fact k="Region" v={hold.region_label || hold.region_code} />
              <Fact k="Held" v={formatDateTimeUtc(hold.held_at)} />
              <Fact k="Finish pressed" v={hold.completed_at ? formatDateTimeUtc(hold.completed_at) : '—'} />
            </div>

            {/* ── Why it was parked ────────────────────────────────────── */}
            <div style={{...label, marginBottom: 6}}>Why the gate parked it</div>
            {reasons.length === 0 ? (
              <p className="modal-body-text" style={{marginBottom: 12}}>
                No check ids were recorded on this hold (it was parked before reasons were persisted, or the
                gate itself threw). Read the auth-service log line <code style={mono}>dispatch.completion_gate_fail</code>{' '}
                for booking {bookingId.slice(0, 8)}, or treat it as unverified.
              </p>
            ) : (
              <ol style={{margin: '0 0 12px', paddingLeft: 18, display: 'grid', gap: 8}}>
                {reasons.map(r => (
                  <li key={r.id} style={{fontSize: 12, color: 'var(--tx-2)', lineHeight: 1.55}}>
                    <span style={{fontFamily: 'var(--font-sans)', fontWeight: 800, color: 'var(--warn)'}}>{r.title}</span>
                    <span style={{...mono, fontSize: 9.5, color: 'var(--tx-3)', marginLeft: 8}}>{r.id}</span>
                    <div><b style={{color: 'var(--tx-1)'}}>Checked:</b> {r.check}</div>
                    <div><b style={{color: 'var(--tx-1)'}}>Verify:</b> {r.verify}</div>
                  </li>
                ))}
              </ol>
            )}

            {/* ── The two outcomes ─────────────────────────────────────── */}
            <div style={{...label, marginBottom: 6}}>Outcome (pick one)</div>
            <div aria-label="Outcome" style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10, marginBottom: 12}}>
              {choice(
                'release', 'Release to provider',
                fee.isLoading ? '…' : release ? `+${release.toProvider.toLocaleString()} BC` : `≤ ${grossLabel}`,
                [
                  `You vouch that the mission was completed. The hold is promoted and paid now — the dispute window is skipped.`,
                  fee.isLoading
                    ? 'Fetching the region\'s platform fee…'
                    : !release
                      ? `Platform fee could not be read from the ${fee.region} pricing board, so the exact payout cannot be shown here. The server applies the region's live fee at release (gross minus fee to the provider). Check App Config › Pricing before releasing.`
                      : `Platform fee ${release.feePct}%${fee.inherited && fee.region !== 'GLOBAL' ? ' (inherited from GLOBAL)' : ''} = ${release.platformFee.toLocaleString()} BC kept by the platform; provider receives ${release.toProvider.toLocaleString()} BC.`,
                  'The provider is notified of the payout; a payout row and the provider\'s completed-jobs count are written.',
                ],
                'ok',
              )}
              {choice(
                'refund', 'Refund to client',
                `−${Number(hold.gross_credits).toLocaleString()} BC`,
                [
                  'The mission could not be verified. The whole gross returns to the client wallet; the provider receives nothing and no platform fee is taken.',
                  'The client is notified of the refund.',
                  'If the provider disagrees, that is a commercial conversation — there is no in-app appeal on a refunded review hold.',
                ],
                'warn',
              )}
            </div>

            <div style={{fontSize: 11, color: 'var(--tx-3)', lineHeight: 1.55, marginBottom: 12}}>
              Before deciding: open the booking, check the mission timeline and live map against each
              failed check above, and where possible confirm with the client. A hold is one booking&apos;s money —
              do not split it here; a split is a dispute (Finance › Disputes), which only a client can open.
            </div>

            <label className="modal-label" htmlFor="rh-reason">Decision note (audited, min {MIN_REASON} chars)</label>
            <textarea
              id="rh-reason"
              className="modal-input"
              rows={3}
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="What did you verify, with whom, and why this outcome?"
            />
            {err && <div className="modal-err" role="alert">{err}</div>}

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={close} disabled={busy}>CANCEL</button>
              <button
                className="btn btn-ok"
                onClick={() => { void submit(); }}
                disabled={busy || !action || reason.trim().length < MIN_REASON}
                title={!action ? 'Choose an outcome' : reason.trim().length < MIN_REASON ? 'Add a decision note' : undefined}>
                {busy ? 'RESOLVING…' : action === 'release' ? (release ? `RELEASE ${release.toProvider.toLocaleString()} BC →` : 'RELEASE TO PROVIDER →') : action === 'refund' ? `REFUND ${grossLabel} →` : 'CHOOSE AN OUTCOME'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** The booking detail's money card: the hold, its state, and its exit. */
export function BookingMoneyPanel({
  holds, canResolve, onChanged, loading,
}: {
  bookingId: string;
  holds: EscrowRow[];
  canResolve: boolean;
  onChanged: () => void;
  loading?: boolean;
}) {
  return (
    <div className="card" style={{marginBottom: 12}}>
      <div className="card-header">
        <div className="card-header-title"><span className="bar" />Money</div>
      </div>
      {loading && holds.length === 0 && <div className="skel-row" />}
      {!loading && holds.length === 0 && (
        <div className="q-empty">No escrow hold on this booking yet.</div>
      )}
      {holds.map(h => {
        const needsReview = h.review_required && !h.settled_at;
        const reasons = (h.review_reasons ?? []).map(gateReasonRule);
        return (
          <div key={h.id} style={{padding: '11px 14px', borderTop: '1px solid var(--bd-2)'}}>
            <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}>
              <StatusPill domain="escrow" value={h.status} />
              {needsReview && <span className="pill pill-warn">REVIEW REQUIRED</span>}
              <span style={{marginLeft: 'auto'}} className="dt-val">
                {Number(h.gross_credits).toLocaleString()} BC
              </span>
            </div>
            <div style={{...mono, fontSize: 10, color: 'var(--tx-3)', marginTop: 6, lineHeight: 1.6}}>
              HELD {formatDateTimeUtc(h.held_at)}
              {h.settled_at ? ` · SETTLED ${formatDateTimeUtc(h.settled_at)}` : ' · NOT SETTLED'}
              <br />
              TO PROVIDER {Number(h.to_provider_credits ?? 0).toLocaleString()} ·
              {' '}TO CLIENT {Number(h.to_client_credits ?? 0).toLocaleString()} ·
              {' '}PLATFORM {Number(h.platform_fee_credits ?? 0).toLocaleString()}
            </div>
            {needsReview && (
              <div style={{marginTop: 10}}>
                <div style={{fontSize: 11, color: 'var(--tx-3)', marginBottom: 8}}>
                  The proof-of-completion gate parked this. Nothing moves until an operator decides.
                  {reasons.length > 0 && (
                    <> Failed: {reasons.map(r => (
                      <span key={r.id} className="pill pill-warn" style={{marginLeft: 6}} title={r.check}>{r.title}</span>
                    ))}</>
                  )}
                </div>
                <ReviewHoldAction hold={h} canResolve={canResolve} onDone={onChanged} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
