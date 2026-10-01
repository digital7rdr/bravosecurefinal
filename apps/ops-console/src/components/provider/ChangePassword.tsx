'use client';

import {useState} from 'react';
import {PvDialog} from './ui';
import {pvAuth, expirePvCsrf, PV_EXPIRES_KEY, PV_PW_CHANGED_KEY} from '@/lib/provider/api';
import {pvRoutes} from '@/lib/provider/routes';
import {errorText} from '@/lib/provider/labels';

/**
 * Change password (provider console). The server signs out every session of
 * the account afterwards, so on success we go straight to the sign-in page
 * with a notice instead of leaving a page whose calls would all 401.
 */
export function ChangePasswordDialog({open, onClose, temporary}: {open: boolean; onClose: () => void; temporary?: boolean}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const tooShort = next.length > 0 && next.length < 12;
  const mismatch = again.length > 0 && again !== next;
  const valid = current.length > 0 && next.length >= 12 && next === again && next !== current;

  async function submit() {
    setBusy(true); setErr(null);
    try {
      await pvAuth.changePassword(current, next);
      expirePvCsrf();
      try {
        window.sessionStorage.removeItem(PV_EXPIRES_KEY);
        window.sessionStorage.setItem(PV_PW_CHANGED_KEY, '1');
      } catch { /* ignore */ }
      window.location.replace(pvRoutes.login);
    } catch (e) {
      const code = (e as {body?: {message?: string}})?.body?.message;
      setErr(code === 'current_password_invalid' ? 'The current password is not correct.'
        : code === 'new_password_must_differ' ? 'Choose a password different from the current one.'
        : errorText(e));
      setBusy(false);
    }
  }

  const field = (label: string, value: string, set: (v: string) => void, auto: string, hint?: string) => (
    <label className="pv-field">
      <span className="pv-label">{label}</span>
      <input className="pv-input" type="password" value={value} autoComplete={auto} onChange={e => set(e.target.value)}/>
      {hint && <span className="pv-cell-sub">{hint}</span>}
    </label>
  );

  return (
    <PvDialog open={open} title="Change password" busy={busy} onClose={onClose}
      description={temporary
        ? 'Your current password was created by Bravo Secure. Replace it with one only you know. You will be signed out everywhere and sign in again.'
        : 'You will be signed out on every device and sign in again with the new password.'}
      footer={<>
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn btn-pri" disabled={busy || !valid} onClick={submit}>{busy ? 'Saving…' : 'Change password'}</button>
      </>}>
      <form className="pv-form" onSubmit={e => { e.preventDefault(); if (valid && !busy) void submit(); }}>
        {field(temporary ? 'Current (temporary) password' : 'Current password', current, setCurrent, 'current-password')}
        {field('New password', next, setNext, 'new-password', tooShort ? 'At least 12 characters.' : 'At least 12 characters. A short sentence works well.')}
        {field('New password again', again, setAgain, 'new-password', mismatch ? 'The two new passwords do not match.' : undefined)}
        {err && <div className="pv-err" role="alert">{err}</div>}
        <button type="submit" hidden aria-hidden="true"/>
      </form>
    </PvDialog>
  );
}
