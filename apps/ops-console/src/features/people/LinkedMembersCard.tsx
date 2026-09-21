'use client';

/**
 * B-836 — a holder's linked members, managed from the support desk.
 *
 * The console could only ever READ this list, and only when it was non-empty —
 * so ops could not add the FIRST member, which is exactly the request that
 * started this ("companies will have members in the thousands; make it easier").
 * The card adds one, adds a pasted list, sets a per-member credit allocation,
 * holds and removes, over a searchable, paged read.
 *
 * Renders nothing unless the SERVER says this holder is manageable (an
 * individual account that is not an admin) — the same posture as
 * ProviderInvitesCard, and the reason an empty roster still shows the Add form.
 */

import {Fragment, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {
  ApiError, opsDataApi, useUserFamily,
  type FamilyBatchResult, type FamilyMemberSpend, type OpsFamilyRow, type OpsUserFamily,
} from '@/lib/api';
import {formatDateTimeUtc, formatDateUtc} from '@/lib/datetime';
import {E164_RE, splitPhones} from '@/lib/format';
import {
  chainedInFlightCount, fundingErrorCopy, fundingState, holdsBadgeLabel,
  singleFlight, spendRowLabel, subMemberSpendLabel, withoutRow,
} from '@/lib/familyFunding';

const PAGE = 50;
/** The server's own per-call ceiling (plan A14) — a bigger paste is sent in runs. */
const BATCH = 50;

/**
 * Every refusal the two add routes can return, in the operator's words. A raw
 * code in a support console is a ticket back to engineering; each of these is
 * something ops can act on without one.
 */
const CODE_COPY: Record<string, string> = {
  holder_not_eligible: 'This account cannot hold members — only an individual client account can, and never an admin account.',
  // Both readings of this one code: the admin's own account, and the far more
  // common batch case — a company pastes its staff list with the owner in it.
  cannot_invite_self: 'That number is the account holder’s own (or yours) — it cannot be added as a member.',
  invalid_phone: 'Not a usable number. Use the full international form, e.g. +971501234567.',
  not_a_bravo_user: 'Nobody is registered on Bravo with that number yet — they must install and sign up first.',
  not_an_individual_account: 'That number belongs to a provider or agent account. Only individual client accounts can be members.',
  invite_already_pending: 'They already have an invitation waiting on this account.',
  duplicate_in_batch: 'The same number appears more than once in this list.',
  error: 'The server could not add this one. Try it on its own to see why.',
};

function codeCopy(code: string | undefined, fallback: string): string {
  return (code && CODE_COPY[code]) || fallback;
}

/** Five buckets an operator can act on, rather than eight raw codes. */
const GROUPS: Array<{key: string; title: string; codes: readonly string[] | null}> = [
  {key: 'added', title: 'Added', codes: null},
  // Why: B-843 — "linked" is no longer a global fact, so this bucket is only THIS account's own pending invite.
  {key: 'linked', title: 'Already on this account', codes: ['invite_already_pending']},
  {key: 'unregistered', title: 'Not on Bravo yet', codes: ['not_a_bravo_user']},
  {key: 'invalid', title: 'Invalid', codes: ['invalid_phone', 'duplicate_in_batch']},
  {key: 'other', title: 'Other', codes: []},
];

function groupOf(r: FamilyBatchResult): string {
  if (r.ok) return 'added';
  const hit = GROUPS.find(g => g.codes && g.codes.length > 0 && g.codes.includes(r.code ?? ''));
  return hit?.key ?? 'other';
}

function held(row: {held_until: string | null}): boolean {
  return !!row.held_until && new Date(row.held_until).getTime() > Date.now();
}

/** `null` limit is "no individual ceiling" — the member spends the shared balance. */
function remainingOf(row: OpsFamilyRow): number | null {
  return row.spend_limit_credits == null ? null : row.spend_limit_credits - row.spent_credits;
}

const input = 'rounded-md border border-bd2 bg-s2 px-2 py-1 text-xs text-t1';
const btn = 'rounded-md border border-bd1 px-2 py-1 text-[10px] font-semibold text-t2 hover:bg-s1 disabled:opacity-50';

/** Whatever we can call this member in a sentence. */
function nameOf(row: OpsFamilyRow): string {
  return row.member_name ?? row.member_email ?? row.member_phone ?? 'this member';
}

export function LinkedMembersCard({
  userId, canManage, canForce = false, Card,
}: {
  userId: string;
  canManage: boolean;
  /**
   * B-854 (A10) — may this operator FORCE the funding switch off over live
   * bookings? Stricter than `canManage` on purpose: forcing cancels those
   * bookings at accept, hours later. Defaults to false so a caller that has not
   * been taught the question cannot hand out the override by omission.
   */
  canForce?: boolean;
  /** The page's own card primitive, so this stays visually identical to its siblings. */
  Card: (p: {title: string; right?: ReactNode; children: ReactNode}) => ReactNode;
}) {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'pending' | 'held'>('all');
  const [page, setPage] = useState(0);

  // 300 ms so a roster search is one request per pause, not one per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  // A new filter is a new result set; page 3 of the old one means nothing.
  useEffect(() => { setPage(0); }, [q, status]);

  // The whole card, list route included, is SUPERVISOR+ — an OPS viewer must
  // not fire a 403 on every user page they open, so the FETCH is gated too.
  const {data, isValidating, mutate} = useUserFamily(canManage ? userId : null, {
    q: q || undefined, status, limit: PAGE, offset: page * PAGE,
  });

  // Why: the filter is part of the SWR key, so every search and page turn makes
  // `data` undefined for a tick. Without a held snapshot the card unmounts
  // mid-search and takes the operator's search box with it.
  const lastGood = useRef<{id: string; payload: OpsUserFamily} | null>(null);
  if (data) lastGood.current = {id: userId, payload: data};
  const view = data ?? (lastGood.current?.id === userId ? lastGood.current.payload : null);

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<{rowId: string; kind: 'limit' | 'hold'} | null>(null);
  const [limitDraft, setLimitDraft] = useState('');
  const [reasonDraft, setReasonDraft] = useState('');
  const [holdDraft, setHoldDraft] = useState('');

  // B-854 — the funding switch's refusal offer (A10) and the spending
  // disclosure, keyed by row id so one open member never leaks into another.
  //
  // N4: `busy` is React state and lags a render, so it cannot guard a money
  // button — two taps in one tick both read the old value. The ref is the guard.
  const fundBusy = useRef(false);
  const [forceRow, setForceRow] = useState<string | null>(null);
  const [spendOpen, setSpendOpen] = useState<string | null>(null);
  const [spendData, setSpendData] = useState<Record<string, FamilyMemberSpend>>({});
  const [spendErr, setSpendErr] = useState<string | null>(null);

  const [addPhone, setAddPhone] = useState('');
  const [addLimit, setAddLimit] = useState('');
  const [paste, setPaste] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [results, setResults] = useState<FamilyBatchResult[] | null>(null);

  const parsedPaste = useMemo(() => splitPhones(paste), [paste]);

  // Removing the last row of the last page would otherwise strand the operator
  // on an empty page with only a PREV button.
  useEffect(() => {
    if (data && data.owner_of.length === 0 && page > 0) setPage(p => Math.max(0, p - 1));
  }, [data, page]);

  // `counts` is the tell that this server speaks the paged contract. Without
  // it (console deployed ahead of auth-service) every read below would throw
  // and take the whole user page with it — render nothing instead.
  if (!canManage || !view || view.manageable === false || !view.counts) return null;

  const rows = view.owner_of;
  const counts = view.counts;
  const total = view.total;
  const from = page * PAGE;
  const hasPrev = page > 0;
  const hasNext = from + rows.length < total;

  function parseLimit(raw: string): {ok: true; value: number | null} | {ok: false} {
    const t = raw.trim();
    if (t === '') return {ok: true, value: null};
    const n = Number(t);
    if (!Number.isInteger(n) || n < 0) return {ok: false};
    return {ok: true, value: n};
  }

  async function run(key: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(key); setErr(null); setNote(null);
    try {
      await fn();
      await mutate();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as {code?: string; message?: string; minimumCredits?: number} | null) : null;
      if (body?.code === 'QUOTA_BELOW_SPENT' && typeof body.minimumCredits === 'number') {
        setErr(`Cannot go below ${body.minimumCredits.toLocaleString()} BC (already spent).`);
      } else {
        setErr(codeCopy(body?.code, e instanceof ApiError ? e.message : 'That did not go through.'));
      }
    } finally {
      setBusy(null);
    }
  }

  function addOne() {
    const phone = splitPhones(addPhone)[0] ?? '';
    if (!E164_RE.test(phone)) { setErr(CODE_COPY.invalid_phone); return; }
    const limit = parseLimit(addLimit);
    if (!limit.ok) { setErr('The allocation must be a whole number of credits, or blank for no ceiling.'); return; }
    void run('add', async () => {
      await opsDataApi.inviteFamilyMember(userId, {phoneE164: phone, spendLimitCredits: limit.value});
      setAddPhone(''); setAddLimit('');
      setNote(`Invited ${phone}. They join once they accept in the app.`);
    });
  }

  function addMany() {
    if (busy) return;
    const limit = parseLimit(addLimit);
    if (!limit.ok) { setErr('The allocation must be a whole number of credits, or blank for no ceiling.'); return; }
    const bad = parsedPaste.filter(p => !E164_RE.test(p));
    const good = parsedPaste.filter(p => E164_RE.test(p));
    if (good.length === 0 && bad.length === 0) { setErr('Nothing to add — paste one number per line.'); return; }

    void (async () => {
      setBusy('batch'); setErr(null); setNote(null);
      // Client-side refusals ride in the SAME result table as the server's, so
      // the operator reads one list, not two — with their raw line echoed back.
      const collected: FamilyBatchResult[] = bad.map(phone => ({phone, ok: false, code: 'invalid_phone'}));
      setResults(null);
      try {
        for (let i = 0; i < good.length; i += BATCH) {
          const chunk = good.slice(i, i + BATCH);
          setProgress(`Sent ${Math.min(i + chunk.length, good.length)} of ${good.length}…`);
          const r = await opsDataApi.inviteFamilyMembersBatch(userId, {
            phones: chunk, spendLimitCredits: limit.value,
          });
          collected.push(...r.results);
        }
        setResults(collected);
        setPaste('');
        await mutate();
      } catch (e) {
        // Keep whatever landed: the earlier runs really did add those members.
        setResults(collected.length > 0 ? collected : null);
        setErr(e instanceof ApiError ? e.message : 'The list did not finish sending.');
      } finally {
        setProgress(null);
        setBusy(null);
      }
    })();
  }

  function openLimit(row: OpsFamilyRow) {
    setEditing({rowId: row.id, kind: 'limit'});
    setLimitDraft(row.spend_limit_credits == null ? '' : String(row.spend_limit_credits));
    setReasonDraft('');
    setErr(null);
  }

  function saveLimit(row: OpsFamilyRow) {
    const limit = parseLimit(limitDraft);
    if (!limit.ok) { setErr('The allocation must be a whole number of credits, or blank for no ceiling.'); return; }
    void run(`limit:${row.id}`, async () => {
      await opsDataApi.setFamilyMemberLimit(userId, row.id, {
        spendLimitCredits: limit.value, reason: reasonDraft.trim() || undefined,
      });
      setEditing(null);
      setNote(limit.value == null ? 'Allocation removed — no individual ceiling.' : `Allocation set to ${limit.value.toLocaleString()} BC.`);
    });
  }

  function openHold(row: OpsFamilyRow) {
    setEditing({rowId: row.id, kind: 'hold'});
    setHoldDraft(row.held_until ? row.held_until.slice(0, 10) : '');
    setErr(null);
  }

  function saveHold(row: OpsFamilyRow) {
    const day = holdDraft.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { setErr('Pick the last day of the hold.'); return; }
    // End of that day, so "hold until the 5th" includes the 5th.
    const iso = new Date(`${day}T23:59:59.999Z`);
    if (Number.isNaN(iso.getTime())) { setErr('Pick the last day of the hold.'); return; }
    if (iso.getTime() <= Date.now()) { setErr('The hold has to end in the future.'); return; }
    void run(`hold:${row.id}`, async () => {
      await opsDataApi.setFamilyMemberHold(userId, row.id, {heldUntilIso: iso.toISOString()});
      setEditing(null);
      setNote(`Held until ${formatDateUtc(iso.toISOString())} — no plan access, no owner credits.`);
    });
  }

  function liftHold(row: OpsFamilyRow) {
    void run(`hold:${row.id}`, async () => {
      await opsDataApi.setFamilyMemberHold(userId, row.id, {heldUntilIso: null});
      setEditing(null);
      setNote('Hold lifted.');
    });
  }

  /**
   * B-854 (A11) — the three chained-credit acts, in ONE dispatcher so the route
   * a button reaches is decided in a single readable place. Approve and decline
   * are one word apart and swapping them GRANTS what an operator just refused,
   * which no render test can see — `familyFunding.test.ts` order-pins this body.
   *
   * Not routed through `run()`: the A10 conflict carries a count this has to
   * read off the body, and the FORCE offer it raises belongs to one row.
   */
  function fundAction(row: OpsFamilyRow, kind: 'approve' | 'decline' | 'off', force = false) {
    singleFlight(fundBusy, async () => {
      setBusy(`fund:${row.id}`); setErr(null); setNote(null); setForceRow(null);
      try {
        if (kind === 'approve') {
          await opsDataApi.approveFundMembers(userId, row.id);
          setNote(`On — ${nameOf(row)}’s own members can now book on this account’s credits, inside this member’s allocation.`);
        } else if (kind === 'decline') {
          await opsDataApi.declineFundMembers(userId, row.id);
          setNote('Request declined. They can ask again.');
        } else {
          await opsDataApi.setFundMembers(userId, row.id, false, force);
          setNote(force
            ? 'Switched off. Their members’ bookings still in progress will be cancelled when a provider accepts.'
            : 'Off — their members are back on their own credits.');
        }
        await mutate();
        // The flip changes what this member's allocation may be charged for, so
        // the cached disclosure below it is now a claim about the old rule.
        dropSpend(row);
      } catch (e) {
        const body = e instanceof ApiError ? (e.body as {code?: string; count?: number} | null) : null;
        setErr(fundingErrorCopy(body, e instanceof ApiError ? e.message : 'That did not go through.'));
        // Only a genuine in-flight refusal may put the override on screen.
        if (chainedInFlightCount(body) != null) setForceRow(row.id);
      } finally {
        setBusy(null);
      }
    });
  }

  /** One read of the per-member spend route, cached by row. */
  function loadSpend(row: OpsFamilyRow) {
    void (async () => {
      try {
        const s = await opsDataApi.familyMemberSpend(userId, row.id);
        setSpendData(prev => ({...prev, [row.id]: s}));
      } catch (e) {
        setSpendErr(e instanceof ApiError ? e.message : 'Could not load this member’s spending.');
      }
    })();
  }

  /**
   * Forget this row's cached sheet. An OPEN panel is re-read rather than left
   * on "Loading…" forever; a closed one simply loads fresh next time.
   */
  function dropSpend(row: OpsFamilyRow) {
    setSpendData(prev => withoutRow(prev, row.id));
    if (spendOpen === row.id) { setSpendErr(null); loadSpend(row); }
  }

  /**
   * A6 — the first UI caller of the per-member spend route. Fetched on open and
   * kept, because the operator opens a row to read it, not to re-poll it.
   */
  function toggleSpend(row: OpsFamilyRow) {
    if (spendOpen === row.id) { setSpendOpen(null); return; }
    setSpendOpen(row.id);
    setSpendErr(null);
    if (spendData[row.id]) return;
    loadSpend(row);
  }

  function remove(row: OpsFamilyRow) {
    const who = nameOf(row);
    const msg = row.status === 'pending'
      ? `Cancel the invitation to ${who}? They can be invited again later.`
      : `Remove ${who} from this account? They lose plan access and the credit allocation immediately. Spend history is kept.`;
    // eslint-disable-next-line no-alert
    if (!window.confirm(msg)) return;
    void run(`remove:${row.id}`, async () => {
      await opsDataApi.revokeFamilyMember(userId, row.id);
      setNote(row.status === 'pending' ? 'Invitation cancelled.' : 'Member removed.');
    });
  }

  const chip = (label: string, n: number, cls: string) => (
    <span className={`ml-2 ${cls}`}>{n.toLocaleString()} {label}</span>
  );

  return (
    <Card
      title="Linked members"
      right={
        <span className="text-xs text-t3">
          {chip('ACTIVE', counts.active, 'text-ok')}
          {chip('PENDING', counts.pending, 'text-warn')}
          {counts.held > 0 ? chip('ON HOLD', counts.held, 'text-warn') : null}
        </span>
      }>
      <p className="mb-3 text-xs text-t3">
        People who spend from this account&apos;s Bravo Credits. Each one can carry its own allocation;
        blank means no individual ceiling (they draw on the shared balance). A person can be a member
        of several accounts; each account keeps its own allocation. An added member still
        accepts in the app before anything is charged. Every action here is audited against your call sign.
      </p>
      <p className="mb-3 text-xs text-t3">
        A member who holds members of their own can ask for those people to book on THIS account&apos;s
        credits, still inside that member&apos;s allocation — the &quot;Funds their members&quot; column. It is off
        until someone here allows it, one funding account per member, and SPENDING shows every charge
        with the person who actually made it.
      </p>

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search name or number" aria-label="Search members"
          className={`${input} w-56`} />
        <select
          value={status} onChange={e => setStatus(e.target.value as typeof status)}
          aria-label="Filter by status" className={input}>
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="pending">Pending</option>
          <option value="held">On hold</option>
        </select>
        {isValidating && <span className="text-[10px] uppercase tracking-widest text-t3">loading…</span>}
      </div>

      <div className="mb-3 flex flex-wrap items-end gap-2 border-t border-bd2 pt-3">
        <label className="text-[10px] uppercase tracking-widest text-t3">Add by number
          <input
            value={addPhone} onChange={e => setAddPhone(e.target.value)}
            placeholder="+971501234567" aria-label="Member phone number"
            className={`${input} ml-2 w-44 font-mono`} />
        </label>
        <label className="text-[10px] uppercase tracking-widest text-t3">Allocation (BC)
          <input
            value={addLimit} onChange={e => setAddLimit(e.target.value.replace(/[^\d]/g, ''))}
            inputMode="numeric" placeholder="blank = none" aria-label="Spend allocation in credits"
            className={`${input} ml-2 w-28 font-mono`} />
        </label>
        <button type="button" onClick={addOne} disabled={busy === 'add'}
          className="rounded-md bg-ok px-3 py-1.5 text-xs font-semibold text-canvas hover:bg-ok/80 disabled:opacity-50">
          {busy === 'add' ? 'ADDING…' : 'ADD MEMBER'}
        </button>
        <button type="button" onClick={() => { setPasteOpen(o => !o); setResults(null); }} className={btn}>
          {pasteOpen ? 'CLOSE LIST' : 'ADD MANY'}
        </button>
      </div>

      {pasteOpen && (
        <div className="mb-3 rounded-lg border border-bd2 p-3">
          <textarea
            value={paste} onChange={e => setPaste(e.target.value)} rows={5}
            aria-label="Paste phone numbers"
            placeholder={'+971501234567\n+971502345678\n… one per line, or comma separated'}
            className={`${input} w-full font-mono`} />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-t3">
              {parsedPaste.length.toLocaleString()} number{parsedPaste.length === 1 ? '' : 's'}
              {parsedPaste.length > BATCH ? ` · sent in runs of ${BATCH}` : ''}
              {' · '}the allocation above applies to every one of them
            </span>
            <button type="button" onClick={addMany} disabled={busy === 'batch' || parsedPaste.length === 0}
              className="ml-auto rounded-md bg-ok px-3 py-1.5 text-xs font-semibold text-canvas hover:bg-ok/80 disabled:opacity-50">
              {busy === 'batch' ? 'SENDING…' : `ADD ${parsedPaste.length.toLocaleString()}`}
            </button>
          </div>
          {progress && <p className="mt-2 text-xs text-t3">{progress}</p>}
          {results && (
            <div className="mt-3 space-y-3">
              {GROUPS.map(g => {
                const rowsIn = results.filter(r => groupOf(r) === g.key);
                if (rowsIn.length === 0) return null;
                return (
                  <div key={g.key}>
                    <div className={`text-[10px] font-semibold uppercase tracking-widest ${g.key === 'added' ? 'text-ok' : 'text-t3'}`}>
                      {g.title} · {rowsIn.length.toLocaleString()}
                    </div>
                    <table className="w-full text-xs">
                      <tbody className="divide-y divide-bd2">
                        {rowsIn.map(r => (
                          <tr key={`${g.key}:${r.phone}`} className="text-t2">
                            <td className="w-44 py-1 pr-3 font-mono">{r.phone}</td>
                            <td className="py-1 text-t3">
                              {r.ok ? 'Invited — waiting for them to accept.' : codeCopy(r.code, 'Refused.')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {err && <p role="alert" className="mb-2 text-xs text-err">{err}</p>}
      {note && <p className="mb-2 text-xs text-ok">{note}</p>}

      {rows.length === 0 ? (
        <p className="text-xs text-t3">
          {q || status !== 'all' ? 'No member matches that filter.' : 'No linked members yet.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left uppercase text-t3">
              <tr>
                <th className="py-1 pr-3">Member</th><th className="py-1 pr-3">Status</th>
                <th className="py-1 pr-3">Allocation</th><th className="py-1 pr-3">Spent</th>
                <th className="py-1 pr-3">Remaining</th>
                <th className="py-1 pr-3">Funds their members</th><th className="py-1" />
              </tr>
            </thead>
            <tbody className="divide-y divide-bd2">
              {rows.map(m => {
                const onHold = held(m);
                const rem = remainingOf(m);
                const open = editing?.rowId === m.id ? editing.kind : null;
                const fund = fundingState(m);
                const holds = holdsBadgeLabel(m.holds_members_count);
                const viaSpend = subMemberSpendLabel(m.spent_by_members);
                const sheet = spendData[m.id];
                return (
                  <Fragment key={m.id}>
                  <tr className="align-top text-t2">
                    <td className="py-1.5 pr-3">
                      <div className="font-semibold text-t1">
                        {m.member_name ?? 'Invited member'}
                        {/* A14 — a plain count of who THEY hold. Never a plan badge:
                            the Pro root and the paying root can be two accounts. */}
                        {holds && (
                          <span className="ml-2 rounded border border-bd2 px-1 py-0.5 text-[10px] font-normal uppercase tracking-wide text-t3">
                            {holds}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-t3">
                        {[m.member_email, m.member_phone].filter(Boolean).join(' · ') || '—'}
                      </div>
                      {open === 'limit' && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          <input
                            value={limitDraft} onChange={e => setLimitDraft(e.target.value.replace(/[^\d]/g, ''))}
                            inputMode="numeric" placeholder="blank = no limit" aria-label="New allocation"
                            className={`${input} w-32 font-mono`} />
                          <input
                            value={reasonDraft} onChange={e => setReasonDraft(e.target.value)} maxLength={200}
                            placeholder="reason (optional)" aria-label="Reason"
                            className={`${input} w-56`} />
                          <button type="button" onClick={() => saveLimit(m)} disabled={busy === `limit:${m.id}`} className={btn}>
                            {busy === `limit:${m.id}` ? '…' : 'SAVE'}
                          </button>
                          <button type="button" onClick={() => setEditing(null)} className={btn}>CANCEL</button>
                        </div>
                      )}
                      {open === 'hold' && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          <input
                            type="date" value={holdDraft} onChange={e => setHoldDraft(e.target.value)}
                            aria-label="Hold until" className={`${input} w-40 font-mono`} />
                          <button type="button" onClick={() => saveHold(m)} disabled={busy === `hold:${m.id}`} className={btn}>
                            {busy === `hold:${m.id}` ? '…' : 'HOLD'}
                          </button>
                          <button type="button" onClick={() => setEditing(null)} className={btn}>CANCEL</button>
                        </div>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {m.status === 'pending' ? (
                        <span className="font-semibold uppercase text-warn">pending</span>
                      ) : onHold ? (
                        <>
                          <span className="font-semibold uppercase text-warn">on hold</span>
                          <div className="text-[10px] text-t3">until {formatDateTimeUtc(m.held_until!)}</div>
                        </>
                      ) : (
                        <span className="font-semibold uppercase text-ok">active</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 font-mono">
                      {m.spend_limit_credits == null ? <span className="text-t3">No limit</span> : `${m.spend_limit_credits.toLocaleString()} BC`}
                    </td>
                    <td className="py-1.5 pr-3 font-mono">
                      {m.spent_credits.toLocaleString()} BC
                      {viaSpend && <div className="text-[10px] font-sans text-t3">incl. {viaSpend}</div>}
                    </td>
                    <td className={`py-1.5 pr-3 font-mono ${rem != null && rem <= 0 ? 'text-err' : ''}`}>
                      {rem == null ? <span className="text-t3">—</span> : `${rem.toLocaleString()} BC`}
                    </td>
                    {/* B-854 — off / a pending ask / on. The flag is the authority;
                        the request row is the history that makes a decline legible. */}
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {fund === 'on' ? (
                        <>
                          <span className="font-semibold uppercase text-ok">on</span>
                          <div className="mt-1">
                            <button type="button" onClick={() => fundAction(m, 'off')} disabled={busy === `fund:${m.id}`} className={btn}>SWITCH OFF</button>
                          </div>
                        </>
                      ) : fund === 'pending' ? (
                        <>
                          <span className="font-semibold uppercase text-warn">pending</span>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <button type="button" onClick={() => fundAction(m, 'approve')} disabled={busy === `fund:${m.id}`} className={btn}>ALLOW</button>
                            <button type="button" onClick={() => fundAction(m, 'decline')} disabled={busy === `fund:${m.id}`} className={btn}>DECLINE</button>
                          </div>
                        </>
                      ) : (
                        <span className="text-t3">Off</span>
                      )}
                      {forceRow === m.id && canForce && (
                        <div className="mt-1">
                          <button
                            type="button" onClick={() => fundAction(m, 'off', true)}
                            disabled={busy === `fund:${m.id}`}
                            className="rounded-md border border-err/40 px-2 py-1 text-[10px] font-semibold text-err hover:bg-err/10 disabled:opacity-50">
                            FORCE OFF
                          </button>
                          <div className="text-[10px] text-t3">Cancels those bookings when a provider accepts.</div>
                        </div>
                      )}
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      <button type="button" onClick={() => toggleSpend(m)} className={`${btn} mr-1`}>
                        {spendOpen === m.id ? 'HIDE SPENDING' : 'SPENDING'}
                      </button>
                      <button type="button" onClick={() => openLimit(m)} className={btn}>SET LIMIT</button>
                      {onHold ? (
                        <button type="button" onClick={() => liftHold(m)} disabled={busy === `hold:${m.id}`} className={`${btn} ml-1`}>
                          {busy === `hold:${m.id}` ? '…' : 'LIFT HOLD'}
                        </button>
                      ) : (
                        <button type="button" onClick={() => openHold(m)} className={`${btn} ml-1`}>HOLD UNTIL</button>
                      )}
                      <button type="button" onClick={() => remove(m)} disabled={busy === `remove:${m.id}`}
                        className="ml-1 rounded-md border border-err/40 px-2 py-1 text-[10px] font-semibold text-err hover:bg-err/10 disabled:opacity-50">
                        {busy === `remove:${m.id}` ? '…' : m.status === 'pending' ? 'CANCEL INVITE' : 'REMOVE'}
                      </button>
                    </td>
                  </tr>
                  {/* A6 — what this allocation actually bought, line by line. A
                      charge made by one of THEIR members reads "C via B", so a
                      sub-member's spend is never credited to the member. */}
                  {spendOpen === m.id && (
                    <tr className="text-t2">
                      <td colSpan={7} className="pb-3 pl-3 pr-3">
                        <div className="rounded-lg border border-bd2 p-3">
                          {spendErr && <p role="alert" className="text-xs text-err">{spendErr}</p>}
                          {!sheet && !spendErr && <p className="text-xs text-t3">Loading…</p>}
                          {sheet && (
                            <>
                              <div className="mb-2 flex flex-wrap gap-3 text-[11px] text-t3">
                                {sheet.byFeature.length === 0
                                  ? <span>Nothing charged to this allocation yet.</span>
                                  : sheet.byFeature.map(f => (
                                      <span key={f.feature}>
                                        <span className="uppercase tracking-wide">{f.feature}</span>{' '}
                                        <span className="font-mono text-t2">{f.spent.toLocaleString()} BC</span>
                                        {f.refunded > 0 && <span className="font-mono text-ok"> −{f.refunded.toLocaleString()} refunded</span>}
                                        {' · '}{f.count.toLocaleString()}
                                      </span>
                                    ))}
                              </div>
                              <ul className="space-y-0.5 text-[11px] text-t3">
                                {sheet.transactions.map(t => (
                                  <li key={t.id} className={t.type === 'refund' ? 'text-ok' : undefined}>
                                    {spendRowLabel(t, nameOf(m))}
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(hasPrev || hasNext) && (
        <div className="mt-3 flex items-center gap-2">
          <button type="button" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={!hasPrev} className={btn}>
            ← PREV
          </button>
          <span className="text-xs text-t3">
            {(from + 1).toLocaleString()}–{(from + rows.length).toLocaleString()} of {total.toLocaleString()}
          </span>
          <button type="button" onClick={() => setPage(p => p + 1)} disabled={!hasNext} className={btn}>
            NEXT →
          </button>
        </div>
      )}
    </Card>
  );
}
