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
        phone_e164: phone.trim(),
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
      <AuthLayout subtitle="Admin invite">
        <div style={authCol(12)}>
          <Note>
            {done.existing_account ? (
              <>
                Console access added to your existing Bravo account — call sign{' '}
                <b style={{color:'var(--tx-1)'}}>{done.call_sign}</b>, role{' '}
                <b style={{color:'var(--tx-1)'}}>{done.role}</b>. Sign in with your phone,
                your EXISTING Bravo password and the SMS code. The password you just typed
                was not applied — your app password is unchanged.
              </>
            ) : (
              <>
                Account created — call sign <b style={{color:'var(--tx-1)'}}>{done.call_sign}</b>,
                role <b style={{color:'var(--tx-1)'}}>{done.role}</b>. Sign in with your phone,
                password and the SMS code.
              </>
            )}
          </Note>
          <Link href={routes.login} className="btn btn-pri"
            style={{height:42, display:'flex', alignItems:'center', justifyContent:'center', fontSize:13}}>
            GO TO SIGN IN
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout subtitle="Accept your admin invite">
      <form onSubmit={onSubmit} style={authCol(12)}>
        <Note>
          Your role and call sign were set by the admin who invited you.
          Choose the credentials you will sign in with.
        </Note>
        <Field label="Phone (E.164)" placeholder="+919876543210"
          value={phone} onChange={setPhone} autoFocus inputMode="tel"/>
        <Field label="Display name (optional)" placeholder="As shown on the console"
          value={name} onChange={setName}/>
        <Field label="Password (min 8 chars)" type="password" value={password} onChange={setPassword}/>
        <Field label="Confirm password" type="password" value={confirm} onChange={setConfirm}/>
        {err && <Err msg={err}/>}
        <button className="btn btn-pri" type="submit"
          disabled={busy || !phone || password.length < 8 || !confirm}
          style={{height:42, justifyContent:'center', fontSize:13, marginTop:6}}>
          {busy ? 'CREATING ACCOUNT…' : 'CREATE ADMIN ACCOUNT'}
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
