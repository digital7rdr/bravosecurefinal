'use client';

/**
 * B-812 — a provider's roster invitation codes, from the support desk.
 *
 * The officer's "Join your provider" screen redeems a single-use code that
 * only the provider can mint — but until 2026-09-06 nothing in the product
 * minted one. The agency app now does (roster → Invite Code); this card is the
 * console mirror so support can issue or revoke a code on the provider's
 * behalf. Renders nothing for a non-provider account (the endpoint says so).
 */

import {useState, type ReactNode} from 'react';
import {ApiError, opsDataApi, useProviderInvites, type ProviderInviteRow} from '@/lib/api';
import {formatDateTimeUtc} from '@/lib/datetime';

const STATUS_CLASS: Record<ProviderInviteRow['status'], string> = {
  open: 'text-ok', redeemed: 'text-t2', revoked: 'text-err', expired: 'text-t3',
};

export function ProviderInvitesCard({
  userId, canMint, Card,
}: {
  userId: string;
  canMint: boolean;
  /** The page's own card primitive, so this stays visually identical to its siblings. */
  Card: (p: {title: string; right?: ReactNode; children: ReactNode}) => ReactNode;
}) {
  // The list route is SUPERVISOR+ too; an OPS viewer must not fire a 403 on
  // every user page, so the fetch itself is gated on the capability.
  const {data, mutate} = useProviderInvites(canMint ? userId : null);
  const [role, setRole] = useState<'cpo' | 'manager'>('cpo');
  const [callSign, setCallSign] = useState('');
  const [days, setDays] = useState('7');
  const [busy, setBusy] = useState<string | null>(null);
  const [minted, setMinted] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!data?.provider) {return null;}
  const invites = data.invites;
  const open = invites.filter(i => i.status === 'open');

  async function mint() {
    if (busy) {return;}
    const d = Number(days);
    if (!Number.isInteger(d) || d < 1 || d > 30) { setErr('Expiry must be a whole number of days from 1 to 30.'); return; }
    setBusy('mint'); setErr(null);
    try {
      const r = await opsDataApi.mintProviderInvite(userId, {member_role: role, call_sign: callSign.trim() || undefined, expires_in_days: d});
      setMinted(r.code);
      setCallSign('');
      await mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not create the invitation.');
    } finally {
      setBusy(null);
    }
  }

  async function revoke(code: string) {
    if (busy) {return;}
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Revoke ${code}? It stops working immediately and cannot be re-opened.`)) {return;}
    setBusy(code); setErr(null);
    try {
      await opsDataApi.revokeProviderInvite(userId, code);
      if (minted === code) {setMinted(null);}
      await mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not revoke the invitation.');
    } finally {
      setBusy(null);
    }
  }

  const input = 'rounded-md border border-bd2 bg-s2 px-2 py-1 text-xs text-t1';

  return (
    <Card title="Roster invitations" right={<span className="text-xs text-t3">{open.length} OPEN · SINGLE USE</span>}>
      <p className="mb-3 text-xs text-t3">
        An officer joins this provider&apos;s roster by entering a code in the app (I&apos;m an Agent → Join your provider).
        The provider mints codes from its roster screen; issue one here only on the provider&apos;s request. Every mint and revoke is audited against your call sign.
      </p>

      {canMint && (
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <label className="text-[10px] uppercase tracking-widest text-t3">Joins as
            <select value={role} onChange={e => setRole(e.target.value as 'cpo' | 'manager')} className={`${input} ml-2`} aria-label="Member role">
              <option value="cpo">CPO</option>
              <option value="manager">Manager</option>
            </select>
          </label>
          <label className="text-[10px] uppercase tracking-widest text-t3">Call sign
            <input value={callSign} onChange={e => setCallSign(e.target.value.toUpperCase())} maxLength={24} placeholder="optional" className={`${input} ml-2 w-28 font-mono`} aria-label="Call sign" />
          </label>
          <label className="text-[10px] uppercase tracking-widest text-t3">Expires (days)
            <input value={days} onChange={e => setDays(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" className={`${input} ml-2 w-14 font-mono`} aria-label="Expiry in days" />
          </label>
          <button type="button" onClick={() => { void mint(); }} disabled={busy === 'mint'}
            className="rounded-md bg-ok px-3 py-1.5 text-xs font-semibold text-canvas hover:bg-ok/80 disabled:opacity-50">
            {busy === 'mint' ? 'CREATING…' : 'CREATE CODE'}
          </button>
        </div>
      )}
      {err && <p role="alert" className="mb-2 text-xs text-err">{err}</p>}
      {minted && (
        <div className="mb-3 rounded-lg border border-acc/50 bg-acc/10 px-3 py-2 text-sm">
          New code: <span className="font-mono text-base font-bold tracking-widest text-t1">{minted}</span>
          <span className="ml-2 text-xs text-t3">— give it to the officer; it is shown once here and stays in the list below.</span>
        </div>
      )}

      {invites.length === 0 ? (
        <p className="text-xs text-t3">No invitation codes yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left uppercase text-t3">
              <tr><th className="py-1 pr-3">Code</th><th className="py-1 pr-3">Joins as</th><th className="py-1 pr-3">Call sign</th><th className="py-1 pr-3">Status</th><th className="py-1 pr-3">Expires</th><th className="py-1 pr-3">Created</th><th className="py-1" /></tr>
            </thead>
            <tbody className="divide-y divide-bd2">
              {invites.map(i => (
                <tr key={i.code} className="text-t2">
                  <td className="py-1.5 pr-3 font-mono font-semibold tracking-wider text-t1">{i.code}</td>
                  <td className="py-1.5 pr-3 capitalize">{i.member_role}</td>
                  <td className="py-1.5 pr-3 font-mono">{i.call_sign ?? '—'}</td>
                  <td className={`py-1.5 pr-3 font-semibold uppercase ${STATUS_CLASS[i.status] ?? 'text-t3'}`}>
                    {i.status}{i.status === 'redeemed' && i.redeemed_by_name ? <span className="ml-1 font-normal normal-case text-t3">· {i.redeemed_by_name}</span> : null}
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap text-t3">{i.expires_at ? formatDateTimeUtc(i.expires_at) : '—'}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap text-t3">{formatDateTimeUtc(i.created_at)}{i.created_by_name ? ` · ${i.created_by_name}` : ''}</td>
                  <td className="py-1.5 text-right">
                    {i.status === 'open' && canMint && (
                      <button type="button" onClick={() => { void revoke(i.code); }} disabled={busy === i.code}
                        className="rounded-md border border-err/40 px-2 py-1 text-[10px] font-semibold text-err hover:bg-err/10 disabled:opacity-50">
                        {busy === i.code ? '…' : 'REVOKE'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
