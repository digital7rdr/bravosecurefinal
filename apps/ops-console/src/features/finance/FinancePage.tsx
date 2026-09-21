'use client';

import {useState} from 'react';
import Link from 'next/link';
import {useSWRConfig} from 'swr';
import {SkeletonRows} from '@/components/SkeletonRows';
import {useToast} from '@/components/Toast';
import {
  ApiError, opsApi, opsDataApi, useOpsMe, POLL_DASH,
  useDisputes, useFinanceEscrows, useFinanceInvoices, useFinancePayouts,
  useFinancePromos, useWalletOverview,
  type DisputeRow, type FinanceTxRow,
} from '@/lib/api';
import {financeActorLabel} from '@/lib/familyFunding';
import {usePagedList} from '@/lib/usePagedList';
import {formatDateTimeUtc} from '@/lib/datetime';
import {roleLabel} from '@/lib/format';
import {downloadCsv} from '@/lib/csv';
import {PageHeader} from '@/components/PageHeader';
import {RouteTabs} from '@/components/RouteTabs';
import {routes, bookingHref} from '@/lib/routes';
import {ReviewHoldAction} from '@/features/bookings/BookingMoneyPanel';
import {canResolveReviewHold} from '@/lib/rbac';
import {
  DISPUTE_MODE_RULES, ESCROW_BASIS_LABELS, ESCROW_STATE_RULES, disputeMode, disputePresets, disputePreview,
  escrowStateRule, gateReasonRule, holdTimeline, type DisputeHold, type DisputePreset,
} from '@/lib/escrowRules';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREDITS_MAX = 100_000;


const TX_TYPES = ['all', 'topup', 'payment', 'refund', 'payout', 'expire', 'escrow_hold', 'escrow_refund', 'escrow_release'] as const;
// SK-03 — the real escrow_hold_status enum (20260620000002_escrow_integrity.sql);
// 'SPLIT' was never a value, so its chip could only ever show an empty list.
const ESCROW_STATUSES = ['all', 'HELD', 'PENDING_RELEASE', 'RELEASED', 'REFUNDED', 'PARTIAL', 'DISPUTED'] as const;

const fmt = formatDateTimeUtc;

function errText(e: unknown): string {
  if (e instanceof ApiError && e.status === 403) return 'Requires SUPERVISOR or ADMIN role.';
  return (e as Error).message;
}

function creditsClass(type: string, amount: number): string {
  if (type === 'topup' || type === 'refund' || type === 'escrow_refund') return 'text-ok';
  if (amount < 0 || type === 'payment' || type === 'escrow_hold' || type === 'expire') return 'text-err';
  return 'text-t2';
}

// CA-14 — csvEscape/downloadCsv moved to @/lib/csv with formula-injection
// hardening (leading = + - @ neutralised); shared with the audit page.

/** IS-13 — shared export button: client-side over the rows currently loaded. */
function ExportCsvButton({disabled, onClick}: {disabled: boolean; onClick: () => void}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title="Exports the loaded rows only"
      className="rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-s1 disabled:cursor-not-allowed disabled:opacity-40">
      EXPORT CSV
    </button>
  );
}

const stamp = () => new Date().toISOString().slice(0, 10);

const th = 'px-3 py-2';
const tableWrap = 'overflow-x-auto rounded-xl border border-bd2';
const thead = 'bg-s2 text-left text-xs uppercase text-t3';
const chip = (on: boolean) =>
  `rounded-md px-3 py-1.5 text-xs font-semibold ${on ? 'bg-bd1 text-t1' : 'border border-bd1 text-t3 hover:bg-s1'}`;

function Panel({loading, error, empty, children}: {
  loading: boolean; error: unknown; empty: boolean; children: React.ReactNode;
}) {
  if (loading) return <SkeletonRows rows={6} />;
  if (error)   return <p className="text-sm text-err">{errText(error)}</p>;
  if (empty)   return <p className="text-sm text-t3">Nothing here yet.</p>;
  return <>{children}</>;
}

// OP-14 — the ledger pages by keyset (`before` = the previous page's oldest
// created_at) instead of growing `limit`; 50 per page, 200 cap as before.
const TX_PAGE = 50;
const TX_MAX = 200;
const txId = (r: FinanceTxRow) => r.id;
// OP-14 review — `created_at|id`: the server tie-breaks on id so the three
// ledger rows one escrow release writes at the same now() cannot straddle a
// page boundary and vanish.
const txCursor = (r: FinanceTxRow) => `${r.created_at}|${r.id}`;

export function LedgerTab() {
  const [type, setType] = useState<string>('all');
  const {rows: data, isLoading, isLoadingMore, error, hasMore, loadMore} = usePagedList<FinanceTxRow>({
    key: ['finance-tx', type],
    pageSize: TX_PAGE,
    maxRows: TX_MAX,
    fetchPage: ({limit, cursor}) => {
      const [before, before_id] = (cursor ?? '').split('|');
      return opsDataApi.financeTransactions({
        type: type === 'all' ? undefined : type, limit,
        before: before || undefined, before_id: before_id || undefined,
      });
    },
    idOf: txId,
    cursorOf: txCursor,
    swr: {refreshInterval: POLL_DASH},
  });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {TX_TYPES.map(t => (
          <button key={t} onClick={() => setType(t)} className={chip(type === t)}>{t.replace(/_/g, ' ')}</button>
        ))}
        <div className="flex-1" />
        <ExportCsvButton
          disabled={data.length === 0}
          onClick={() => downloadCsv(
            `wallet_ledger_${stamp()}.csv`,
            // B-854 (A14) — `user` is the WALLET; `actor` is who spent it and
            // `via_name`/`via_user_id` the member they spent through. Without
            // those four a reconciler reads every family charge — and every
            // CHAINED one — as the root's own spend.
            ['created_at', 'user', 'user_id', 'actor', 'actor_user_id', 'via_name', 'via_user_id', 'type', 'status', 'credits', 'fiat_cents', 'fiat_ccy', 'description', 'booking_id', 'settled_at'],
            data.map(r => [r.created_at, r.display_name, r.user_id, r.actor_name, r.actor_user_id, r.via_name, r.via_user_id, r.type, r.status, r.amount_credits, r.amount_fiat_cents, r.fiat_currency, r.description, r.booking_id, r.settled_at]),
          )}
        />
      </div>
      <Panel loading={isLoading} error={error} empty={data.length === 0}>
        <div className={tableWrap}>
          <table className="w-full text-sm">
            <thead className={thead}>
              <tr>
                <th className={th}>Time</th><th className={th}>User</th><th className={th}>Spent by</th>
                <th className={th}>Type</th>
                <th className={th}>Status</th><th className={`${th} text-right`}>Credits</th>
                <th className={th}>Fiat</th><th className={th}>Description</th><th className={th}>Booking</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-bd2">
              {data.map((r: FinanceTxRow) => {
                // B-854 (A14) — the row's wallet is the ROOT's; on a family
                // charge the spender is someone else, and on a CHAINED one it
                // is that member's own member. Null = the owner's own spend.
                const actor = financeActorLabel(r);
                return (
                <tr key={r.id} className="text-t2">
                  <td className={`${th} whitespace-nowrap text-t3`}>{fmt(r.created_at)}</td>
                  <td className={th}>
                    <div>{r.display_name ?? '—'}</div>
                    <div className="font-mono text-[10px] text-t3">{r.user_id.slice(0, 8)}</div>
                  </td>
                  <td className={th}>
                    {actor ? (
                      <>
                        <div>{actor.text}</div>
                        {actor.via && (
                          <div className="text-[10px] tracking-wide text-warn" title="Chained credit — spent by a linked member's own member, from this wallet.">
                            {actor.via}
                          </div>
                        )}
                      </>
                    ) : <span className="text-t3">—</span>}
                  </td>
                  <td className={`${th} font-mono text-xs`}>{r.type}</td>
                  <td className={`${th} text-xs ${r.status === 'succeeded' ? 'text-ok' : r.status === 'failed' ? 'text-err' : 'text-warn'}`}>{r.status}</td>
                  <td className={`${th} text-right font-mono font-semibold ${creditsClass(r.type, r.amount_credits)}`}>
                    {r.amount_credits.toLocaleString()} BC
                  </td>
                  <td className={`${th} text-xs text-t3`}>
                    {r.amount_fiat_cents != null ? `${(r.amount_fiat_cents / 100).toFixed(2)} ${r.fiat_currency ?? ''}` : '—'}
                  </td>
                  <td className={`${th} max-w-[260px] truncate text-t3`} title={r.description ?? ''}>{r.description ?? '—'}</td>
                  <td className={th}>
                    {r.booking_id
                      // A ledger row carries no service, so this lands on the
                      // Lite detail, which rewrites itself to the Executive URL
                      // when the booking turns out to be one.
                      ? <Link href={bookingHref({id: r.booking_id})} className="font-mono text-xs text-acc hover:underline">{r.booking_id.slice(0, 8)}</Link>
                      : <span className="text-t3">—</span>}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {hasMore && (
          <button onClick={loadMore} disabled={isLoadingMore}
            className="rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-s1 disabled:opacity-50">
            {isLoadingMore ? 'LOADING…' : `LOAD MORE (${data.length} loaded)`}
          </button>
        )}
      </Panel>
    </div>
  );
}

export function EscrowTab() {
  const [status, setStatus] = useState<string>('all');
  const {data, isLoading, error, mutate} = useFinanceEscrows(status === 'all' ? undefined : status);
  const {data: me} = useOpsMe();
  // IA-06 — the review-hold exit. A hold parked by the proof-of-completion gate
  // had a badge here and no action anywhere in the console; the money sat until
  // someone ran SQL against it.
  const canResolve = canResolveReviewHold(me?.admin.role);
  const inReview = (data ?? []).filter(r => r.review_required && !r.settled_at).length;
  return (
    <div className="space-y-3">
      {inReview > 0 && (
        <div style={{
          padding: '10px 14px', borderRadius: 10, marginBottom: 4,
          background: 'rgba(255,193,7,0.08)', border: '1px solid var(--warn)',
          fontSize: 12.5, color: 'var(--tx-1)',
        }}>
          <b>{inReview} hold{inReview === 1 ? '' : 's'} parked for review.</b>{' '}
          The proof-of-completion gate stopped these — nothing moves to the provider or back to the
          client until an operator releases or refunds each one. Each row&apos;s RESOLVE REVIEW opens the
          decision brief (what was checked, what each outcome moves).
        </div>
      )}
      <EscrowRulebook />
      <div className="flex flex-wrap items-center gap-2">
        {ESCROW_STATUSES.map(s => <button key={s} onClick={() => setStatus(s)} className={chip(status === s)}>{s}</button>)}
        <div className="flex-1" />
        <ExportCsvButton
          disabled={(data?.length ?? 0) === 0}
          onClick={() => data && downloadCsv(
            `escrows_${stamp()}.csv`,
            ['held_at', 'booking_id', 'booking_status', 'region', 'client', 'provider', 'gross_credits', 'to_provider', 'to_client', 'platform_fee', 'status', 'basis', 'review_required', 'review_reasons', 'completed_at', 'release_eligible_at', 'settled_at'],
            data.map(r => [r.held_at, r.booking_id, r.booking_status, r.region_code, r.client_name, r.provider_name, r.gross_credits, r.to_provider_credits, r.to_client_credits, r.platform_fee_credits, r.status, r.basis, r.review_required, (r.review_reasons ?? []).join(' '), r.completed_at, r.release_eligible_at, r.settled_at]),
          )}
        />
      </div>
      <Panel loading={isLoading} error={error} empty={(data?.length ?? 0) === 0}>
        <div className={tableWrap}>
          <table className="w-full text-sm">
            <thead className={thead}>
              <tr>
                <th className={th}>Held</th><th className={th}>Booking</th><th className={th}>Region</th>
                <th className={th}>Client</th><th className={th}>Provider</th>
                <th className={`${th} text-right`}>Gross</th><th className={`${th} text-right`}>Split P/C/Fee</th>
                <th className={th}>Status</th><th className={th}>Timeline</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody className="divide-y divide-bd2">
              {(data ?? []).map(r => {
                const parked = r.review_required && !r.settled_at;
                const timeline = holdTimeline(r);
                const rule = escrowStateRule(r.status);
                const reasons = (r.review_reasons ?? []).map(gateReasonRule);
                return (
                  <tr key={r.id} className={`text-t2 ${parked ? 'bg-warn/5' : ''}`}>
                    <td className={`${th} whitespace-nowrap text-t3`}>{fmt(r.held_at)}</td>
                    <td className={th}>
                      <Link href={bookingHref({id: r.booking_id, service: r.service})} className="font-mono text-xs text-acc hover:underline">{r.booking_id.slice(0, 8)}</Link>
                      <div className="text-[10px] text-t3">{r.booking_status}</div>
                    </td>
                    <td className={th}>{r.region_code}</td>
                    <td className={`${th} text-t3`}>{r.client_name ?? '—'}</td>
                    <td className={`${th} text-t3`}>{r.provider_name ?? '—'}</td>
                    <td className={`${th} text-right font-mono font-semibold`}>{r.gross_credits.toLocaleString()} BC</td>
                    <td className={`${th} text-right font-mono text-xs text-t3`} title={r.basis ? ESCROW_BASIS_LABELS[r.basis] ?? r.basis : undefined}>
                      {r.settled_at ? `${r.to_provider_credits ?? 0}/${r.to_client_credits ?? 0}/${r.platform_fee_credits ?? 0}` : '—'}
                      {r.settled_at && r.basis && <div className="text-[10px] normal-case">{r.basis.replace(/_/g, ' ')}</div>}
                    </td>
                    <td className={th}>
                      <span
                        title={rule ? `${rule.money} ${rule.next}` : undefined}
                        className={r.status === 'HELD' || r.status === 'PENDING_RELEASE' ? 'text-warn' : r.status === 'REFUNDED' || r.status === 'DISPUTED' ? 'text-err' : 'text-ok'}>
                        {r.status}
                      </span>
                      {parked && <span className="ml-2 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-bold text-warn">REVIEW</span>}
                      {parked && reasons.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {reasons.map(x => (
                            <span key={x.id} title={x.check} className="rounded border border-warn/40 px-1.5 py-0.5 text-[10px] text-warn">{x.title}</span>
                          ))}
                        </div>
                      )}
                      {r.no_show_at && <div className="text-[10px] text-t3">client no-show {fmt(r.no_show_at)}</div>}
                    </td>
                    <td className={`${th} whitespace-nowrap text-xs text-t3`}>
                      {r.settled_at ? `settled ${fmt(r.settled_at)}` : timeline.phrase}
                      {!r.settled_at && r.release_eligible_at && r.status === 'PENDING_RELEASE' && (
                        <div className="text-[10px]">at {fmt(r.release_eligible_at)}{timeline.windowHours != null ? ` · ${timeline.windowHours} h window` : ''}</div>
                      )}
                    </td>
                    <td className={`${th} text-right`}>
                      {parked && (
                        <ReviewHoldAction
                          hold={r}
                          canResolve={canResolve}
                          onDone={() => { void mutate(); }}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

/**
 * B-807 — the escrow rulebook, on the page that shows the holds. Collapsed by
 * default (an operator who knows it should not scroll past it every time);
 * the content is the same `lib/escrowRules.ts` data the dialogs reason from,
 * so the page and the decision brief can never disagree.
 */
function EscrowRulebook() {
  return (
    <details className="rounded-xl border border-bd2 bg-s2 px-4 py-3 text-sm">
      <summary className="cursor-pointer select-none font-semibold text-t1">
        How escrow works — who moves the money, when, and the rules an operator must follow
      </summary>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-t3">The hold, end to end</div>
          <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-t2">
            <li><b className="text-t1">Charged ≠ paid.</b> When a provider accepts an offer the client wallet is debited and the credits are parked in the platform escrow account, in one transaction with the accept. If the client cannot pay, the accept is undone. The provider wallet is untouched.</li>
            <li><b className="text-t1">Finish runs a gate, not a payout.</b> The lead&apos;s Finish triggers a server-side proof-of-completion check on evidence already collected (PICKUP→LIVE order, a fix inside the arrival radius, telemetry coverage, minimum on-task time, hourly check-ins on a location-anchored detail, optional identity handshake / movement checks). PASS → PENDING RELEASE with a dispute window. FAIL → the hold stays HELD, flagged REVIEW, and never auto-releases.</li>
            <li><b className="text-t1">The window, then the sweep.</b> A release sweep runs every minute and pays a PENDING RELEASE hold whose window has elapsed, is not flagged for review, and has no open dispute. Payout = gross − platform fee (the region&apos;s <code>platform_fee_pct</code> on the pricing board). The client can confirm early (releases now) or open a dispute (freezes it) — a dispute racing the sweep always wins.</li>
            <li><b className="text-t1">Refunds and splits from HELD.</b> Cancel before crew is committed → full refund. Cancel after crew / inside the late-cancel window, or a lead-declared client no-show → <code>cancel_fee_pct</code> to the provider, the rest refunded (PARTIAL). Provider no-show, no provider found, missed start, expired uncrewed → full refund. An ops abort mid-mission → pro-rata by minutes on task.</li>
            <li><b className="text-t1">Terminal is terminal.</b> RELEASED / REFUNDED / PARTIAL never re-open. The only thing that touches paid-out money is an upheld dispute, executed as a clawback from the provider wallet.</li>
          </ol>
        </div>
        <div>
          <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-t3">Operator rules</div>
          <ul className="list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-t2">
            <li><b className="text-t1">Two doors, two roles.</b> A REVIEW hold is resolved here (release or refund — whole hold, no split). A DISPUTED, RELEASED or client-no-show PARTIAL hold is resolved under Finance › Disputes with a split. Both need SUPERVISOR or ADMIN, are region-scoped to your assignment, require an idempotency key (a double-click cannot double-pay), and roll the money back if the audit row cannot be written.</li>
            <li><b className="text-t1">Every move is a paired ledger entry.</b> Escrow → provider, escrow → client, escrow → platform fee. The daily reconciliation asserts gross = provider + client + platform on every terminal hold, that escrow nets to zero per booking, that no payout exists on a non-terminal hold, and that the platform accounts never go negative. Drift pages Sentry; it never auto-moves money.</li>
            <li><b className="text-t1">Decide on evidence, write it down.</b> The decision note is mandatory, audited against your call sign, and is what the next reviewer (or the client&apos;s complaint) is judged against. Check the mission timeline and live map against each failed check before releasing.</li>
            <li><b className="text-t1">What you cannot do.</b> Release a hold that is not parked (the sweep or the client owns it). Split a review hold (only a dispute splits). Increase a provider&apos;s share on a settled hold, or take back what a client or the platform already received. Store a 0% fee on the board (clear the row instead).</li>
          </ul>
          <div className="mt-3 text-[10px] uppercase tracking-widest text-t3">States</div>
          <div className="mt-1 grid gap-1 text-[11px] text-t3">
            {ESCROW_STATE_RULES.map(s => (
              <div key={s.status}><span className="font-mono font-bold text-t2">{s.status}</span> — {s.money}</div>
            ))}
          </div>
        </div>
      </div>
    </details>
  );
}

export function PayoutsTab() {
  const {data, isLoading, error} = useFinancePayouts();
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <ExportCsvButton
          disabled={(data?.length ?? 0) === 0}
          onClick={() => data && downloadCsv(
            `payouts_${stamp()}.csv`,
            ['decided_at', 'payee', 'call_sign', 'mission', 'region', 'proposed_credits', 'paid_credits', 'deduction_credits', 'deduction_reason'],
            data.map(r => [r.decided_at, r.payee_name, r.call_sign, r.mission_short_code, r.region_code, r.proposed_credits, r.paid_credits, r.deduction_credits, r.deduction_reason]),
          )}
        />
      </div>
      <Panel loading={isLoading} error={error} empty={(data?.length ?? 0) === 0}>
      <div className={tableWrap}>
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Decided</th><th className={th}>Payee</th><th className={th}>Mission</th>
              <th className={th}>Region</th><th className={`${th} text-right`}>Proposed</th>
              <th className={`${th} text-right`}>Paid</th><th className={th}>Deduction</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-bd2">
            {(data ?? []).map(r => (
              <tr key={r.id} className="text-t2">
                <td className={`${th} whitespace-nowrap text-t3`}>{r.decided_at ? fmt(r.decided_at) : '—'}</td>
                <td className={th}>
                  <div>{r.payee_name ?? r.call_sign ?? '—'}</div>
                  <div className="font-mono text-[10px] text-t3">{r.call_sign ?? ''}</div>
                </td>
                <td className={th}>
                  {r.mission_short_code && r.mission_id
                    ? <Link href={routes.lite.mission(r.mission_id)} className="font-mono text-xs text-acc hover:underline">{r.mission_short_code}</Link>
                    : <span className="text-t3">—</span>}
                </td>
                <td className={th}>{r.region_code ?? '—'}</td>
                <td className={`${th} text-right font-mono text-t3`}>{r.proposed_credits?.toLocaleString() ?? '—'}</td>
                <td className={`${th} text-right font-mono font-semibold text-ok`}>{r.paid_credits?.toLocaleString() ?? '—'} BC</td>
                <td className={`${th} text-xs text-t3`}>
                  {r.deduction_credits ? `−${r.deduction_credits} · ${r.deduction_reason ?? ''}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </Panel>
    </div>
  );
}

interface DisputeDraft {
  row: DisputeRow;
  preset: DisputePreset['key'];
  toClient: string;
  toProvider: string;
  resolution: string;
}

/** The hold fields `lib/escrowRules.ts` reasons from, lifted off a dispute row. */
function holdOf(r: DisputeRow): DisputeHold {
  return {
    escrow_status: r.escrow_status, gross_credits: r.gross_credits, hold_basis: r.hold_basis,
    hold_to_provider_credits: r.hold_to_provider_credits, hold_to_client_credits: r.hold_to_client_credits,
    hold_platform_fee_credits: r.hold_platform_fee_credits, hold_no_show_at: r.hold_no_show_at,
  };
}

export function DisputesTab({canResolve}: {canResolve: boolean}) {
  const {data, isLoading, error, mutate} = useDisputes();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // CA-13/IS-05 — structured resolution modal replaces the three window.prompts.
  // B-807 — the modal is a decision brief: it names which of the server's
  // three resolution mechanics applies to THIS hold, offers the decisions an
  // operator actually makes as presets, and previews the exact split (and any
  // refusal) the server will produce, using the same arithmetic.
  const [draft, setDraft] = useState<DisputeDraft | null>(null);

  const hold = draft ? holdOf(draft.row) : null;
  const mode = hold ? disputeMode(hold) : 'unresolvable';
  const tc = Number(draft?.toClient ?? '');
  const tp = Number(draft?.toProvider ?? '');
  const splitsOk = Number.isInteger(tc) && Number.isInteger(tp) && tc >= 0 && tp >= 0;
  const preview = hold && splitsOk ? disputePreview(hold, {toClient: tc, toProvider: tp}) : null;
  const noteOk = (draft?.resolution.trim().length ?? 0) >= 8;
  const draftValid = !!preview && preview.outcome !== 'REFUSED' && noteOk;
  const presets = hold ? disputePresets(hold) : [];

  // Opens UN-ARMED: no preset, empty legs. Pre-selecting "full refund" put a
  // "CLAW BACK 800 BC" button in front of an operator who had chosen nothing.
  const openDraft = (row: DisputeRow) => {
    setDraft({row, preset: 'custom', toClient: '', toProvider: '', resolution: ''});
  };

  const applyPreset = (p: DisputePreset) => {
    setDraft(d => d && {
      ...d, preset: p.key,
      toClient: p.split ? String(p.split.toClient) : d.toClient,
      toProvider: p.split ? String(p.split.toProvider) : d.toProvider,
    });
  };

  const submitResolve = async () => {
    if (!draft || !preview || !draftValid) return;
    setBusy(draft.row.id); setMsg(null);
    try {
      // Send the CLAMPED legs the preview showed, so what lands is what was read.
      await opsDataApi.resolveDispute(draft.row.id, {to_client: preview.toClient, to_provider: preview.toProvider, resolution: draft.resolution.trim()});
      setMsg(`Dispute resolved — ${preview.outcome === 'NO_CHANGE' ? 'rejected, executed split affirmed' : preview.outcome}.`);
      setDraft(null);
      await mutate();
    } catch (e) { setMsg(`Failed: ${errText(e)}`); }
    finally { setBusy(null); }
  };

  const modalInput = 'w-full rounded-lg border border-bd1 bg-s2 px-3 py-2 font-mono text-sm text-t1 placeholder:text-t3';
  const modalLabel = 'mb-1.5 text-[10px] font-bold uppercase tracking-widest text-t3';
  const modeRule = DISPUTE_MODE_RULES[mode];
  const modeTone = mode === 'settle' ? 'border-ok/50' : mode === 'unresolvable' ? 'border-err/50' : 'border-warn/50';

  return (
    <div className="space-y-3">
      {msg && <p role="alert" className={`text-sm ${msg.startsWith('Failed:') ? 'text-err' : 'text-t2'}`}>{msg}</p>}
      <DisputeRulebook />
      <div className="flex justify-end">
        <ExportCsvButton
          disabled={(data?.length ?? 0) === 0}
          onClick={() => data && downloadCsv(
            `disputes_${stamp()}.csv`,
            ['created_at', 'booking_id', 'region', 'raised_by', 'category', 'reason', 'escrow_status', 'gross_credits', 'hold_to_provider', 'hold_to_client', 'hold_platform_fee', 'hold_basis', 'hold_no_show_at', 'status', 'to_client', 'to_provider', 'decided_at'],
            data.map(r => [r.created_at, r.booking_id, r.region_code, r.raised_by_name, r.category, r.reason, r.escrow_status, r.gross_credits, r.hold_to_provider_credits, r.hold_to_client_credits, r.hold_platform_fee_credits, r.hold_basis, r.hold_no_show_at, r.status, r.to_client_credits, r.to_provider_credits, r.decided_at]),
          )}
        />
      </div>
      <Panel loading={isLoading} error={error} empty={(data?.length ?? 0) === 0}>
        <div className={tableWrap}>
          <table className="w-full text-sm">
            <thead className={thead}>
              <tr>
                <th className={th}>Raised</th><th className={th}>Booking</th><th className={th}>Region</th>
                <th className={th}>By</th><th className={th}>Category</th><th className={th}>Reason</th>
                <th className={th}>Escrow</th><th className={th}>Status</th><th className={`${th} text-right`}>Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-bd2">
              {(data ?? []).map(r => {
                const m = disputeMode(holdOf(r));
                return (
                  <tr key={r.id} className={`text-t2 ${r.status === 'OPEN' ? 'bg-err/5' : ''}`}>
                    <td className={`${th} whitespace-nowrap text-t3`}>{fmt(r.created_at)}</td>
                    <td className={th}>
                      <Link href={bookingHref({id: r.booking_id, service: r.service})} className="font-mono text-xs text-acc hover:underline">{r.booking_id.slice(0, 8)}</Link>
                    </td>
                    <td className={th}>{r.region_code}</td>
                    <td className={`${th} text-t3`}>{r.raised_by_name ?? '—'}</td>
                    <td className={`${th} capitalize`}>{r.category?.replace(/_/g, ' ') ?? '—'}</td>
                    <td className={`${th} max-w-[220px] truncate text-t3`} title={r.reason ?? ''}>{r.reason ?? '—'}</td>
                    <td className={`${th} font-mono text-xs text-t3`} title={DISPUTE_MODE_RULES[m].title}>
                      {r.escrow_status ?? '—'}{r.gross_credits != null ? ` · ${r.gross_credits} BC` : ''}
                      {r.hold_settled_at && (
                        <div className="text-[10px]">
                          paid P {r.hold_to_provider_credits ?? 0} / C {r.hold_to_client_credits ?? 0} / fee {r.hold_platform_fee_credits ?? 0}
                          {r.hold_no_show_at ? ' · client no-show' : ''}
                        </div>
                      )}
                      <div className={`text-[10px] ${m === 'settle' ? 'text-ok' : m === 'unresolvable' ? 'text-err' : 'text-warn'}`}>
                        {m === 'settle' ? 'in escrow — settle' : m === 'clawback' ? 'paid out — clawback' : m === 'no_show_fee' ? 'no-show fee — reversible' : 'not resolvable here'}
                      </div>
                    </td>
                    <td className={th}>
                      <span className={r.status === 'OPEN' ? 'font-semibold text-err' : 'text-ok'}>{r.status}</span>
                      {r.decided_at && <div className="text-[10px] text-t3">{fmt(r.decided_at)}</div>}
                      {r.status !== 'OPEN' && (r.to_client_credits != null || r.to_provider_credits != null) && (
                        <div className="text-[10px] text-t3">decided C {r.to_client_credits ?? 0} / P {r.to_provider_credits ?? 0}</div>
                      )}
                    </td>
                    <td className={`${th} text-right`}>
                      {r.status === 'OPEN' && canResolve ? (
                        <button disabled={busy === r.id}
                          onClick={() => openDraft(r)}
                          className="rounded-md bg-ok px-3 py-1.5 text-xs font-semibold text-canvas hover:bg-ok/80 disabled:opacity-50">
                          Resolve
                        </button>
                      ) : r.status === 'OPEN' ? (
                        <span className="font-mono text-[10px] text-t3">SUPERVISOR+</span>
                      ) : <span className="text-xs text-t3">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {draft && hold && (
        <div
          onClick={() => !busy && setDraft(null)}
          className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div
            onClick={e => e.stopPropagation()}
            role="dialog" aria-modal="true" aria-label="Resolve dispute"
            className="max-h-[90dvh] w-full max-w-2xl overflow-auto rounded-xl border border-ok/40 bg-canvas shadow-2xl">
            <div className="border-b border-bd2 px-5 py-4">
              <div className="text-xs font-bold uppercase tracking-widest text-t3">Bravo Ops · Resolve Dispute · booking {draft.row.booking_id.slice(0, 8)}</div>
              <div className="mt-1 text-lg font-bold text-t1">Decide the final split</div>
              <div className="mt-2 text-sm text-t3">
                Raised by <b className="text-t1">{draft.row.raised_by_name ?? '—'}</b>
                {draft.row.category ? <> · <span className="capitalize">{draft.row.category.replace(/_/g, ' ')}</span></> : null}
                {' '}· escrow gross <b className="text-t1">{hold.gross_credits != null ? `${hold.gross_credits.toLocaleString()} BC` : 'unknown'}</b>
                {' '}· hold <span className="font-mono text-xs">{hold.escrow_status ?? '—'}</span>
              </div>
              {draft.row.reason && (
                <blockquote className="mt-2 rounded-lg border border-bd2 bg-s2 px-3 py-2 text-xs italic text-t2">
                  “{draft.row.reason}”
                </blockquote>
              )}
            </div>

            <div className="space-y-4 px-5 py-4">
              {/* ── Which mechanic applies ─────────────────────────────── */}
              <div className={`rounded-lg border bg-s2 px-3 py-2.5 ${modeTone}`}>
                <div className="text-sm font-bold text-t1">{modeRule.title}</div>
                <div className="mt-1 text-xs leading-relaxed text-t2">{modeRule.body}</div>
                {(mode === 'clawback' || mode === 'no_show_fee') && (
                  <div className="mt-2 font-mono text-[11px] text-t3">
                    Executed split — provider {hold.hold_to_provider_credits ?? 0} · client {hold.hold_to_client_credits ?? 0} · platform {hold.hold_platform_fee_credits ?? 0}
                    {hold.hold_basis ? ` · ${hold.hold_basis.replace(/_/g, ' ')}` : ''}
                  </div>
                )}
              </div>

              {/* ── The decision ───────────────────────────────────────── */}
              {mode !== 'unresolvable' && (
                <div>
                  <div className={modalLabel}>Decision</div>
                  <div aria-label="Decision" className="grid gap-2 sm:grid-cols-3">
                    {presets.map(p => {
                      const on = draft.preset === p.key;
                      return (
                        <button key={p.key} type="button" aria-pressed={on} onClick={() => applyPreset(p)}
                          className={`rounded-lg border px-3 py-2 text-left text-xs ${on ? 'border-acc bg-acc/10 text-t1' : 'border-bd2 text-t2 hover:bg-s1'}`}>
                          <div className="font-semibold">{p.label}</div>
                          <div className="mt-0.5 text-[11px] text-t3">{p.hint}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className={modalLabel}>To client (BC)</div>
                  <input className={modalInput} inputMode="numeric" value={draft.toClient} aria-label="To client"
                    disabled={mode === 'unresolvable'}
                    onChange={e => setDraft(d => d && {...d, preset: 'custom', toClient: e.target.value.replace(/[^\d]/g, '')})} />
                </div>
                <div>
                  <div className={modalLabel}>To provider (BC)</div>
                  <input className={modalInput} inputMode="numeric" value={draft.toProvider} aria-label="To provider"
                    disabled={mode === 'unresolvable'}
                    onChange={e => setDraft(d => d && {...d, preset: 'custom', toProvider: e.target.value.replace(/[^\d]/g, '')})} />
                </div>
              </div>

              {/* ── What the server will do ───────────────────────────── */}
              <div className="rounded-lg border border-bd2 bg-s2 px-3 py-2.5 text-sm" aria-live="polite">
                {!splitsOk ? (
                  <span className="text-err">Splits must be non-negative whole credits.</span>
                ) : !preview ? null : preview.outcome === 'REFUSED' ? (
                  <div>
                    <div className="font-semibold text-err">The server will refuse this split.</div>
                    <ul className="mt-1 list-disc pl-5 text-xs text-t2">
                      {preview.refusals.map(r => <li key={r.code}>{r.message} <span className="font-mono text-[10px] text-t3">{r.code}</span></li>)}
                    </ul>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <div className="text-t2">
                      Client ← <b className="text-ok">{preview.toClient.toLocaleString()}</b> ·
                      Provider ← <b className="text-ok">{preview.toProvider.toLocaleString()}</b> ·
                      Platform keeps <b className="text-t1">{preview.platformFee.toLocaleString()}</b> BC
                    </div>
                    <div className="text-xs text-t3">
                      {preview.outcome === 'NO_CHANGE' && 'Dispute REJECTED: the executed split is affirmed and recorded. No money moves.'}
                      {preview.outcome === 'CLAWBACK' && <>Dispute UPHELD (in part or whole): <b className="text-warn">{preview.pullFromProvider.toLocaleString()} BC</b> is reclaimed from the provider wallet now. If the provider cannot cover it the platform fronts the shortfall and reconciliation flags it.</>}
                      {(preview.outcome === 'REFUNDED' || preview.outcome === 'RELEASED' || preview.outcome === 'PARTIAL') && <>Settled from escrow now; the hold becomes <b className="text-t1">{preview.outcome}</b>. Both parties are notified of the outcome.</>}
                    </div>
                    {preview.clamped && (
                      <div className="text-xs text-warn">The legs you typed exceed the gross; the server clamps provider first, then client. The numbers above are what will land.</div>
                    )}
                  </div>
                )}
              </div>

              <div>
                <div className={modalLabel}>Resolution note (required, min 8 chars — audited, visible to both parties&apos; support history)</div>
                <textarea className={`${modalInput} min-h-[64px] resize-y font-sans`} value={draft.resolution}
                  onChange={e => setDraft(d => d && {...d, resolution: e.target.value})}
                  placeholder="What evidence you reviewed, what was decided, and why…" />
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-bd2 px-5 py-3.5">
              <span className="text-[11px] text-t3">Final. Idempotent. Audited against your call sign.</span>
              <div className="flex gap-2">
                <button disabled={busy === draft.row.id} onClick={() => setDraft(null)}
                  className="rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-s1 disabled:opacity-50">
                  CANCEL
                </button>
                <button disabled={busy === draft.row.id || !draftValid} onClick={() => void submitResolve()}
                  className="rounded-md bg-ok px-3 py-1.5 text-xs font-semibold text-canvas hover:bg-ok/80 disabled:opacity-50">
                  {busy === draft.row.id ? 'RESOLVING…' : preview?.outcome === 'NO_CHANGE' ? 'REJECT DISPUTE' : preview?.outcome === 'CLAWBACK' ? `CLAW BACK ${preview.pullFromProvider.toLocaleString()} BC` : 'CONFIRM RESOLUTION'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** B-807 — the dispute rulebook, collapsed, same source as the dialog. */
function DisputeRulebook() {
  return (
    <details className="rounded-xl border border-bd2 bg-s2 px-4 py-3 text-sm">
      <summary className="cursor-pointer select-none font-semibold text-t1">
        How disputes are resolved — the three mechanics and the rules the server enforces
      </summary>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-t3">Who can open one, and when</div>
          <ul className="list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-t2">
            <li>Only the <b className="text-t1">client</b> opens a dispute, from the app, while the hold is PENDING RELEASE (inside the dispute window) — or within the same window after a lead-declared client no-show. Opening it flips the hold to DISPUTED and beats the release sweep.</li>
            <li>One open dispute per booking. Resolving it is the only thing that closes it — there is no expiry, so an unresolved dispute holds the money indefinitely.</li>
            <li>Resolving needs SUPERVISOR or ADMIN, is region-scoped, idempotency-keyed, and rolls back entirely if the audit row cannot be written.</li>
          </ul>
        </div>
        <div>
          <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-t3">The three mechanics</div>
          <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-t2">
            {(['settle', 'clawback', 'no_show_fee'] as const).map(k => (
              <li key={k}><b className="text-t1">{DISPUTE_MODE_RULES[k].title}.</b> {DISPUTE_MODE_RULES[k].body}</li>
            ))}
          </ol>
          <div className="mt-2 text-xs leading-relaxed text-t2">
            <b className="text-t1">The split you enter is the FINAL position</b> (client / provider; the platform keeps the remainder). The server clamps provider to the gross, then client to what is left. On a settled hold, affirming the executed split exactly records a rejection and moves nothing; any other split must reclaim something from the provider, may never increase the provider&apos;s share, and may never take back what the client or the platform already hold. A hold reclaimed once is never reclaimed again.
          </div>
        </div>
      </div>
    </details>
  );
}

export function InvoicesTab() {
  const {data, isLoading, error} = useFinanceInvoices();
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <ExportCsvButton
          disabled={(data?.length ?? 0) === 0}
          onClick={() => data && downloadCsv(
            `invoices_${stamp()}.csv`,
            ['invoice_number', 'issued_at', 'kind', 'region', 'booking_id', 'subtotal_credits', 'tax_credits', 'total_credits', 'currency'],
            data.map(r => [r.invoice_number, r.issued_at, r.kind, r.region_code, r.booking_id, r.subtotal_credits, r.tax_credits, r.total_credits, r.currency]),
          )}
        />
      </div>
      <Panel loading={isLoading} error={error} empty={(data?.length ?? 0) === 0}>
      <div className={tableWrap}>
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Number</th><th className={th}>Issued</th><th className={th}>Kind</th>
              <th className={th}>Region</th><th className={th}>Booking</th>
              <th className={`${th} text-right`}>Subtotal</th><th className={`${th} text-right`}>Tax</th>
              <th className={`${th} text-right`}>Total</th><th className={th}>PDF</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-bd2">
            {(data ?? []).map(r => (
              <tr key={r.id} className="text-t2">
                <td className={`${th} font-mono text-xs text-acc`}>{r.invoice_number}</td>
                <td className={`${th} whitespace-nowrap text-t3`}>{fmt(r.issued_at)}</td>
                <td className={`${th} text-xs uppercase`}>{r.kind}</td>
                <td className={th}>{r.region_code ?? '—'}</td>
                <td className={th}>
                  {r.booking_id
                    ? <Link href={bookingHref({id: r.booking_id, service: r.service})} className="font-mono text-xs text-acc hover:underline">{r.booking_id.slice(0, 8)}</Link>
                    : '—'}
                </td>
                <td className={`${th} text-right font-mono`}>{r.subtotal_credits.toLocaleString()}</td>
                <td className={`${th} text-right font-mono text-t3`}>{r.tax_credits.toLocaleString()}</td>
                <td className={`${th} text-right font-mono font-semibold`}>{r.total_credits.toLocaleString()} {r.currency}</td>
                <td className={th}>
                  {r.pdf_url ? <a href={r.pdf_url} target="_blank" rel="noreferrer" className="text-xs text-acc hover:underline">open</a> : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </Panel>
    </div>
  );
}

export function PromosTab() {
  const {data, isLoading, error} = useFinancePromos();
  return (
    <Panel loading={isLoading} error={error} empty={(data?.length ?? 0) === 0}>
      <div className={tableWrap}>
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Code</th><th className={`${th} text-right`}>Credits</th>
              <th className={`${th} text-right`}>Redemptions</th><th className={th}>Expires</th>
              <th className={th}>Active</th><th className={th}>Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-bd2">
            {(data ?? []).map(r => (
              <tr key={r.id} className="text-t2">
                <td className={`${th} font-mono font-semibold text-acc`}>{r.code}</td>
                <td className={`${th} text-right font-mono`}>{r.credits.toLocaleString()} BC</td>
                <td className={`${th} text-right font-mono text-t3`}>{r.redeemed_count}{r.max_redemptions ? ` / ${r.max_redemptions}` : ''}</td>
                <td className={`${th} text-t3`}>{r.expires_at ? fmt(r.expires_at) : '—'}</td>
                <td className={th}>{r.active ? <span className="text-ok">yes</span> : <span className="text-t3">no</span>}</td>
                <td className={`${th} whitespace-nowrap text-t3`}>{fmt(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function AdjustTab({canAdjust}: {canAdjust: boolean}) {
  const [userId, setUserId] = useState('');
  const [credits, setCredits] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{balance: number; txId: string} | null>(null);
  const {push} = useToast();
  const {mutate: mutateKey} = useSWRConfig();

  const validUuid = UUID_RE.test(userId.trim());
  // Why: the DC-01 fix — the adjust form gets ledger context, so credits are
  // never moved against a wallet the operator hasn't just looked at.
  const {data: overviewRaw, error: overviewErr} = useWalletOverview(validUuid ? userId.trim() : null);
  // Review round 2 — keepPreviousData is global, so a freshly pasted id would
  // otherwise show (and CONFIRM against) the previous user's name and balance
  // until B's fetch lands. Money path: only ever render B's own overview.
  const overview = overviewRaw && overviewRaw.user.id === userId.trim() ? overviewRaw : undefined;

  const creditsNum = Number(credits);
  const creditsOk = credits.trim() !== '' && Number.isInteger(creditsNum) &&
    creditsNum !== 0 && Math.abs(creditsNum) <= CREDITS_MAX;
  const valid = validUuid && creditsOk && reason.trim().length >= 3;

  async function submit() {
    if (busy || !valid) return;
    const verb = creditsNum > 0 ? 'CREDIT' : 'DEDUCT';
    const prep = creditsNum > 0 ? 'to' : 'from';
    const who = overview ? `${overview.user.display_name ?? 'user'} (${overview.balance.bravo_credits.toLocaleString()} BC now)` : userId.trim();
    if (!window.confirm(
      `${verb} ${Math.abs(creditsNum).toLocaleString()} BC ${prep} wallet of\n${who}\n\nReason: ${reason.trim()}\n\nThis writes to the wallet ledger immediately and cannot be undone from here.`,
    )) return;
    setBusy(true); setErr(null); setDone(null);
    const uid = userId.trim();
    try {
      const r = await opsApi.adjustWallet(uid, {credits: creditsNum, reason: reason.trim()});
      setDone({balance: r.balance.bravo_credits, txId: r.transaction_id});
      setCredits(''); setReason('');
      push({kind: 'ok', text: `${verb} ${Math.abs(creditsNum).toLocaleString()} BC applied — balance ${r.balance.bravo_credits.toLocaleString()} BC`});
      // OP-08 — the wallet card beside the form is its own SWR key; refresh it
      // so the balance and recent ledger reflect the adjustment immediately.
      void mutateKey(['wallet-overview', uid]);
    } catch (e) {
      setErr(errText(e));
      push({kind: 'err', text: `Adjustment failed: ${errText(e)}`});
    } finally { setBusy(false); }
  }

  if (!canAdjust) {
    return <p className="text-sm text-t3">Credit adjustments require SUPERVISOR or ADMIN.</p>;
  }

  const input = 'w-full rounded-lg border border-bd1 bg-s2 px-3 py-2 font-mono text-xs text-t1 placeholder:text-t3';
  const label = 'mb-1.5 text-[10px] font-bold uppercase tracking-widest text-t3';

  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="w-[420px] space-y-3 rounded-xl border border-bd2 p-4">
        <div>
          <div className={label}>User ID (UUID)</div>
          <input className={input} value={userId} onChange={e => setUserId(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000" spellCheck={false} />
        </div>
        <div>
          <div className={label}>Credits (± integer, max {CREDITS_MAX.toLocaleString()})</div>
          <input className={input} value={credits} onChange={e => setCredits(e.target.value)}
            placeholder="e.g. 500 or -250" inputMode="numeric" />
        </div>
        <div>
          <div className={label}>Reason (required)</div>
          <textarea className={`${input} min-h-[64px] resize-none font-sans`} value={reason}
            onChange={e => setReason(e.target.value)} placeholder="Why this adjustment is being made…" />
        </div>
        <button disabled={busy || !valid} onClick={() => void submit()}
          className="w-full rounded-md bg-ok px-3 py-2 text-xs font-bold text-canvas hover:bg-ok/80 disabled:opacity-50">
          {busy ? 'ADJUSTING…' : 'APPLY ADJUSTMENT'}
        </button>
        {err && <p className="text-xs text-err">✗ {err}</p>}
        {done && (
          <div className="rounded-lg border border-ok/40 bg-s2 px-3 py-2 text-xs text-t2">
            ✓ Applied. New balance <b className="text-t1">{done.balance.toLocaleString()} BC</b>
            <div className="font-mono text-[10px] text-t3">{done.txId}</div>
          </div>
        )}
        <p className="text-[10px] leading-relaxed text-t3">
          Every adjustment is written to the wallet ledger with the acting admin and reason — there are no silent balance changes.
        </p>
      </div>

      <div className="min-w-[380px] flex-1 rounded-xl border border-bd2 p-4">
        {!validUuid ? <p className="text-sm text-t3">Enter a user UUID to see their wallet before adjusting.</p>
          : overviewErr ? <p className="text-sm text-err">{errText(overviewErr)}</p>
          : !overview ? <p className="text-sm text-t3">Loading wallet…</p>
          : (
            <div className="space-y-3">
              <div className="flex items-baseline justify-between">
                <div>
                  <div className="text-sm font-semibold text-t1">{overview.user.display_name ?? '—'}</div>
                  <div className="text-xs text-t3">{roleLabel(overview.user.role)} · KYC {overview.user.kyc_status} · {overview.user.subscription_tier}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-lg font-bold text-ok">{overview.balance.bravo_credits.toLocaleString()} BC</div>
                  <div className="text-[10px] text-t3">{overview.balance.updated_at ? fmt(overview.balance.updated_at) : ''}</div>
                </div>
              </div>
              <div>
                <div className={label}>Recent ledger</div>
                <div className="divide-y divide-bd2 rounded-lg border border-bd2">
                  {overview.transactions.length === 0 && <p className="px-3 py-2 text-xs text-t3">No transactions.</p>}
                  {overview.transactions.slice(0, 10).map(t => (
                    <div key={t.id} className="flex items-center justify-between px-3 py-1.5 text-xs">
                      <span className="text-t3">{fmt(t.created_at)}</span>
                      <span className="font-mono text-t3">{t.type}</span>
                      <span className={`font-mono font-semibold ${creditsClass(t.type, t.amount_credits)}`}>{t.amount_credits.toLocaleString()} BC</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
      </div>
    </div>
  );
}

/**
 * IA-12 — the Finance chrome. The seven tabs used to be `useState` on one page,
 * so an operator could not link a colleague to "the escrow tab", Back left the
 * page instead of the tab, and a refresh always landed on the ledger. Each tab
 * is a route now; this renders the header and the tab bar they share.
 */
export function FinanceChrome({title, subtitle}: {title: string; subtitle: string}) {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} />
      <RouteTabs
        ariaLabel="Finance sections"
        tabs={[
          {href: routes.finance.root, label: 'Overview'},
          {href: routes.finance.ledger, label: 'Ledger'},
          {href: routes.finance.escrow, label: 'Escrow & Holds'},
          {href: routes.finance.payouts, label: 'Payouts'},
          {href: routes.finance.disputes, label: 'Disputes'},
          {href: routes.finance.invoices, label: 'Invoices'},
          {href: routes.finance.promos, label: 'Promos & Referrals', prefix: true},
          {href: routes.finance.adjust, label: 'Wallet Adjustments'},
        ]}
      />
    </>
  );
}
