'use client';

/**
 * Authenticator app: see whether a person has one and remove it (2026-10-11).
 * People → Users → user, and Internal → Admins. For a lost phone, or a set-up
 * that was started (QR code shown) but never finished — the case where
 * sign-in keeps asking for an authenticator code the person never had.
 */
import {useEffect, useState} from 'react';
import {opsApi, type AuthenticatorStatus} from '@/lib/api';

const LABEL: Record<AuthenticatorStatus['status'], string> = {
  none: 'Not set up',
  pending: 'Set-up started, never finished',
  verified: 'On',
};

const ERRORS: Record<string, string> = {
  use_own_security_page: 'You cannot reset your own authenticator here.',
  super_admin_required: 'Only a Super Admin can reset an authenticator.',
  user_not_found: 'This account no longer exists (erased).',
};

function errText(e: unknown): string {
  const msg = (e as Error)?.message ?? '';
  for (const [code, text] of Object.entries(ERRORS)) if (msg.includes(code)) return text;
  return msg || 'Could not reset. Try again.';
}

export function ResetAuthenticatorModal({open, userId, name, onClose}: {
  open: boolean;
  userId: string | null;
  name: string;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<AuthenticatorStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{sessions_revoked: number} | null>(null);

  useEffect(() => {
    if (!open || !userId) { setInfo(null); setErr(null); setDone(null); return; }
    let live = true;
    opsApi.getUserAuthenticator(userId).then(i => { if (live) setInfo(i); }).catch(e => { if (live) setErr(errText(e)); });
    return () => { live = false; };
  }, [open, userId]);

  if (!open || !userId) return null;

  async function reset() {
    setBusy(true); setErr(null);
    try { const out = await opsApi.resetUserAuthenticator(userId!); setDone({sessions_revoked: out.sessions_revoked}); }
    catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  }

  const close = () => { if (!busy) onClose(); };
  const nothing = info?.status === 'none';

  return (
    <div onClick={close} className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Authenticator for ${name}`}
        className="w-full max-w-md rounded-xl border border-bd1 bg-s2 shadow-2xl">
        <div className="border-b border-bd2 px-5 py-4">
          <div className="text-xs font-bold uppercase tracking-widest text-t3">Bravo Ops · Security</div>
          <div className="mt-1 text-lg font-bold text-t1">Authenticator for {name}</div>
        </div>
        <div className="space-y-3 px-5 py-4 text-sm leading-relaxed text-t2">
          <div className="flex items-center justify-between rounded-lg border border-bd1 bg-s3 px-3 py-2">
            <span className="text-t3">Status</span>
            <b className={done ? 'text-t1' : info?.status === 'verified' ? 'text-ok' : info?.status === 'pending' ? 'text-warn' : 'text-t1'} data-testid="totp-status">
              {done ? 'Not set up (reset)' : info ? LABEL[info.status] : 'Loading…'}
            </b>
          </div>
          {done ? (
            <ul className="list-disc space-y-1 pl-5 text-[12.5px] text-t3">
              <li>The authenticator and its backup codes were removed.</li>
              <li>{done.sessions_revoked > 0 ? `Signed out of ${done.sessions_revoked} device${done.sessions_revoked === 1 ? '' : 's'}.` : 'No device was signed in.'}</li>
              <li>{info?.staff
                ? 'At their next sign-in they are shown a new QR code to set one up (required for HQ staff).'
                : 'At their next sign-in they either set up a new one with a QR code (while sign-in is authenticator-only) or get a code by text or email.'}</li>
            </ul>
          ) : nothing ? (
            <p className="text-t3">Nothing to reset. If sign-in still asks this person for an authenticator code, sign-in is in
              authenticator-only mode: they are shown a QR code to set one up the first time.</p>
          ) : info ? (
            <p>
              {info.status === 'pending'
                ? 'A set-up was started but never finished, so sign-in keeps asking for a code. '
                : 'Use this if they lost the phone with their authenticator and have no backup codes. '}
              Reset removes it and its backup codes and signs them out on every device. Recorded in the audit log.
            </p>
          ) : null}
          {err && <div className="text-sm text-err" role="alert">{err}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-bd2 px-5 py-3">
          {done || nothing ? (
            <button type="button" onClick={onClose} className="rounded-md bg-t1 px-4 py-1.5 text-xs font-semibold text-canvas">DONE</button>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={close}
                className="rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-s1 disabled:opacity-50">CANCEL</button>
              <button type="button" disabled={busy || !info} onClick={() => void reset()}
                className="rounded-md border border-err/40 bg-err/10 px-4 py-1.5 text-xs font-semibold text-err hover:bg-err/20 disabled:opacity-50">
                {busy ? 'RESETTING…' : 'RESET AUTHENTICATOR'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
