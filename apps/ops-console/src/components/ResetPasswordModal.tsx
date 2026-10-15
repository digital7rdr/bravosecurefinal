'use client';

/**
 * Reset a person's password from the ops console (2026-10-11): People →
 * Users → user, and Internal → Admins. Two steps: confirm, then the
 * temporary password is shown ONCE (the server made it; it is not stored in
 * clear anywhere). Closing the dialog forgets it.
 */
import {useEffect, useState} from 'react';

const ERRORS: Record<string, string> = {
  use_change_password: 'You cannot reset your own password here. Use Change password on bravosecure.cloud → Sign-in & authenticator.',
  super_admin_required: 'Only a Super Admin can reset passwords.',
  user_suspended: 'This account is suspended. Restore it first.',
  user_not_found: 'This account no longer exists (erased).',
};

export function resetErrorText(e: unknown): string {
  const msg = (e as Error)?.message ?? '';
  for (const [code, text] of Object.entries(ERRORS)) if (msg.includes(code)) return text;
  return msg || 'Could not reset the password. Try again.';
}

export function ResetPasswordModal({open, name, onReset, onClose}: {
  open: boolean;
  /** Who, as shown to the admin (name or call sign). */
  name: string;
  onReset: () => Promise<{password: string; sessions_revoked: number}>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{password: string; sessions_revoked: number} | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) { setResult(null); setErr(null); setCopied(false); }
  }, [open]);

  if (!open) return null;

  async function reset() {
    setBusy(true); setErr(null);
    try { setResult(await onReset()); }
    catch (e) { setErr(resetErrorText(e)); }
    finally { setBusy(false); }
  }

  async function copy() {
    if (!result) return;
    try { await navigator.clipboard.writeText(result.password); setCopied(true); } catch { /* select it by hand */ }
  }

  const close = () => { if (!busy) onClose(); };

  return (
    <div onClick={close} className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Reset password for ${name}`}
        className="w-full max-w-md rounded-xl border border-bd1 bg-s2 shadow-2xl">
        <div className="border-b border-bd2 px-5 py-4">
          <div className="text-xs font-bold uppercase tracking-widest text-t3">Bravo Ops · Account access</div>
          <div className="mt-1 text-lg font-bold text-t1">Reset password for {name}</div>
        </div>
        {result ? (
          <div className="space-y-3 px-5 py-4">
            <div className="text-sm leading-relaxed text-t2">
              New temporary password. <b className="text-t1">It is shown only now</b> — give it to {name} in person or by phone, not by email or chat.
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-bd1 bg-s3 px-3 py-2">
              <code className="flex-1 select-all font-mono text-base tracking-wider text-t1" data-testid="temp-password">{result.password}</code>
              <button type="button" onClick={() => void copy()}
                className="rounded border border-bd1 px-2 py-1 text-[11px] font-semibold text-t2 hover:bg-s1">{copied ? 'COPIED' : 'COPY'}</button>
            </div>
            <ul className="list-disc space-y-1 pl-5 text-[12.5px] leading-relaxed text-t3">
              <li>{result.sessions_revoked > 0 ? `Signed out of ${result.sessions_revoked} device${result.sessions_revoked === 1 ? '' : 's'}.` : 'No device was signed in.'}</li>
              <li>They sign in with it, then choose their own at bravosecure.cloud → Sign-in & authenticator → Change password (officers are asked to in the app).</li>
              <li>Their authenticator app, if they have one, is unchanged.</li>
            </ul>
          </div>
        ) : (
          <div className="space-y-3 px-5 py-4 text-sm leading-relaxed text-t2">
            <p>This replaces {name}&apos;s password with a temporary one made by the server, and signs them out on every device.</p>
            <p className="text-t3">Use it when they cannot reset it themselves with “Forgot your password?” on bravosecure.cloud. Recorded in the audit log.</p>
            {err && <div className="text-sm text-err" role="alert">{err}</div>}
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-bd2 px-5 py-3">
          {result ? (
            <button type="button" onClick={onClose} className="rounded-md bg-t1 px-4 py-1.5 text-xs font-semibold text-canvas">DONE</button>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={close}
                className="rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-s1 disabled:opacity-50">CANCEL</button>
              <button type="button" disabled={busy} onClick={() => void reset()}
                className="rounded-md border border-err/40 bg-err/10 px-4 py-1.5 text-xs font-semibold text-err hover:bg-err/20 disabled:opacity-50">
                {busy ? 'RESETTING…' : 'RESET PASSWORD'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
