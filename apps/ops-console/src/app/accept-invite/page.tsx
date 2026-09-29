'use client';

import {Suspense, useState} from 'react';
import {useSearchParams} from 'next/navigation';
import Link from 'next/link';
import {authApi} from '@/lib/api';
import {AuthLayout, Field, Note, Err, authCol} from '@/components/auth-primitives';
import {routes} from '@/lib/routes';

/**
 * RS-09 — admin invite redemption (public page; middleware allowlists it).
 * The invite token arrives in the URL; role / call sign / email are baked
 * into the invite server-side. The invitee sets only their own phone +
 * password, then signs in through the normal login flow.
 */
function AcceptInviteForm() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';

  const [phone,    setPhone]    = useState('');
  const [password, setPassword] = useState('');
  const [confirm,  setConfirm]  = useState('');
  const [name,     setName]     = useState('');
  const [busy,     setBusy]     = useState(false);
  const [err,      setErr]      = useState<string | null>(null);
  const [done,     setDone]     = useState<{call_sign: string; role: string; existing_account: boolean} | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (password !== confirm) { setErr('Passwords do not match.'); return; }
    setBusy(true); setErr(null);
    try {
      const res = await authApi.acceptAdminInvite({
        token,
        phone_e164: phone.trim().replace(/[\s\-().]/g, ''),
        password,
        ...(name.trim() ? {display_name: name.trim()} : {}),
      });
      setDone({call_sign: res.call_sign, role: res.role, existing_account: res.existing_account});
    } catch (e) {
      const msg = (e as Error).message;
      setErr(
        /invite_invalid_or_expired/.test(msg) ? 'This invite is invalid, expired, or already used.'
        : /already_an_admin/.test(msg) ? 'That phone already has an ops console account. Ask an admin to change its level instead of redeeming a second invite.'
        : /user_already_exists/.test(msg) ? 'That email is already registered to another account. Ask for an invite to a different email.'
        : msg,
      );
    } finally { setBusy(false); }
  }

  if (!token) {
    return (
      <AuthLayout subtitle="Admin invite">
        <Err msg="Missing invite token — use the full link you were given."/>
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout subtitle="Invite accepted">
        <div style={authCol(18)}>
          <Note>
            {done.existing_account ? (
              <>
                Console access added to your existing Bravo account — call sign{' '}
                <b style={{color:'var(--tx-1)'}}>{done.call_sign}</b>, role{' '}
                <b style={{color:'var(--tx-1)'}}>{done.role}</b>. Sign in with your phone,
                your EXISTING Bravo password and the verification code (SMS, or your
                authenticator app — the first sign-in sets it up). The password you just
                typed was not applied — your app password is unchanged.
              </>
            ) : (
              <>
                Account created — call sign <b style={{color:'var(--tx-1)'}}>{done.call_sign}</b>,
                role <b style={{color:'var(--tx-1)'}}>{done.role}</b>. Sign in with your phone and
                password, then the verification code — an SMS, or your authenticator app (the
                first sign-in sets it up).
              </>
            )}
          </Note>
          <Link href={routes.login} className="btn btn-pri auth-submit">
            Go to sign in
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout subtitle="Accept your admin invite"
      description="Your role and call sign were set by the admin who invited you. Choose the details you will sign in with.">
      <form onSubmit={onSubmit} style={authCol(18)}>
        <Field label="Phone number" hint="Include the country code, for example +971 50 123 4567."
          placeholder="+971 50 123 4567" autoComplete="username"
          value={phone} onChange={setPhone} autoFocus inputMode="tel"/>
        <Field label="Display name (optional)" placeholder="As shown on the console"
          value={name} onChange={setName}/>
        <Field label="Password" hint="At least 8 characters." type="password" autoComplete="new-password"
          value={password} onChange={setPassword}/>
        <Field label="Confirm password" type="password" autoComplete="new-password"
          value={confirm} onChange={setConfirm}/>
        {err && <Err msg={err}/>}
        <button className="btn btn-pri auth-submit" type="submit"
          disabled={busy || !phone || password.length < 8 || !confirm}>
          {busy ? <><span className="spinner" aria-hidden="true"/>Creating account…</> : 'Create admin account'}
        </button>
      </form>
    </AuthLayout>
  );
}

export default function AcceptInvitePage() {
  // useSearchParams needs a Suspense boundary for prerendering.
  return (
    <Suspense fallback={null}>
      <AcceptInviteForm/>
    </Suspense>
  );
}
