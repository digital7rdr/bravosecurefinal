'use client';

/**
 * Forgot your password? (home site, 2026-10-11)
 *
 *   1. Mobile number or email → a code by text or email (the page says the
 *      same thing whether or not an account matches).
 *   2. The code and a new password — plus the authenticator code when the
 *      account has an authenticator.
 *   3. Done: every device was signed out; sign in with the new password.
 */
import Link from 'next/link';
import {useEffect, useState} from 'react';
import {AuthLayout, Err, Field, Note, authCol} from '@/components/auth-primitives';
import {ApiError, hubPasswordReset} from '@/lib/hub/api';
import {HUB_BRAND} from '@/lib/hub/brand';
import {hubRoutes} from '@/lib/hub/routes';

const normalisePhone = (v: string) => v.trim().replace(/[\s\-().]/g, '').replace(/^00/, '+');

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const b = (e.body ?? {}) as {error?: string; message?: string | string[]};
    const msg = Array.isArray(b.message) ? b.message[0] : b.message;
    if (e.status === 429) return msg && !/ThrottlerException/.test(msg) ? msg : 'Too many attempts. Wait a few minutes, then try again.';
    if (msg && !/^[a-z_]+$/.test(msg) && !/must|should/.test(msg)) return msg;
    if (e.status >= 500) return 'The server had a problem. Try again in a moment.';
    return 'Something went wrong. Check what you typed and try again.';
  }
  if (e instanceof TypeError) return 'Cannot reach Bravo Secure. Check your connection and try again.';
  return 'Something went wrong. Try again.';
}

const linkStyle = {color: 'var(--glow)', fontWeight: 600} as const;

export default function ForgotPasswordPage() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [who, setWho] = useState('');
  const [resetId, setResetId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [totp, setTotp] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    hubPasswordReset.status().then(s => setAvailable(s.available)).catch(() => setAvailable(true));
  }, []);

  const isEmail = who.includes('@');
  const whoValid = isEmail ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(who.trim()) : /^\+\d{7,15}$/.test(normalisePhone(who));
  const pwShort = pw.length > 0 && pw.length < 10;
  const pwMismatch = pw2.length > 0 && pw2 !== pw;
  const codeClean = code.replace(/\s/g, '');
  const canFinish = /^\d{4,8}$/.test(codeClean) && pw.length >= 10 && pw === pw2 && (!needTotp || totp.replace(/[\s-]/g, '').length >= 6);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (!whoValid || busy) return;
    setBusy(true); setErr(null);
    try {
      const out = await hubPasswordReset.start(isEmail ? who.trim() : normalisePhone(who));
      setResetId(out.resetId); setCode(''); setNeedTotp(false); setTotp('');
    } catch (ex) { setErr(errorText(ex)); }
    finally { setBusy(false); }
  }

  async function finish(e: React.FormEvent) {
    e.preventDefault();
    if (!resetId || !canFinish || busy) return;
    setBusy(true); setErr(null);
    try {
      const out = await hubPasswordReset.complete(resetId, {
        code: codeClean, newPassword: pw, ...(needTotp ? {totpCode: totp.replace(/[\s-]/g, '')} : {}),
      });
      if (!out.done) { setNeedTotp(true); return; }
      setDone(true);
    } catch (ex) {
      setErr(errorText(ex));
      if (ex instanceof ApiError && (ex.status === 403 || (ex.body as {error?: string} | undefined)?.error === 'reset_expired')) setResetId(null);
    } finally { setBusy(false); }
  }

  if (done) {
    return (
      <AuthLayout subtitle="Password changed" brand={HUB_BRAND}
        description="Your new password is set. For your safety, every device that was signed in has been signed out.">
        <div style={authCol(16)}>
          <Link className="btn btn-pri auth-submit" href={hubRoutes.login}>Sign in</Link>
        </div>
      </AuthLayout>
    );
  }

  if (resetId) {
    return (
      <AuthLayout subtitle="Choose a new password" brand={HUB_BRAND}
        description={<>If an account matches <b style={{color: 'var(--tx-1)'}}>{who.trim()}</b>, we have sent it a 6-digit code by {isEmail ? 'email' : 'text message (or to its email)'}. It is valid for a few minutes.</>}>
        <form onSubmit={finish} style={authCol(16)}>
          <Field label={isEmail ? 'Code from the email' : 'Code from the text message'} placeholder="123456" inputMode="numeric"
            autoComplete="one-time-code" className="auth-code" value={code} onChange={setCode} autoFocus/>
          <Field label="New password" type="password" autoComplete="new-password"
            hint={pwShort ? 'At least 10 characters.' : 'At least 10 characters. A short sentence works well.'} value={pw} onChange={setPw}/>
          <Field label="New password again" type="password" autoComplete="new-password"
            hint={pwMismatch ? 'The two passwords do not match.' : undefined} value={pw2} onChange={setPw2}/>
          {needTotp && (
            <>
              <Note>This account has an authenticator app. Enter the code it shows now (or one of your backup codes) to finish.</Note>
              <Field label="Authenticator code" placeholder="123456" inputMode="numeric" autoComplete="one-time-code"
                className="auth-code" value={totp} onChange={setTotp} autoFocus/>
            </>
          )}
          {err && <Err msg={err}/>}
          <div className="auth-actions">
            <button type="button" className="btn btn-ghost" onClick={() => { setResetId(null); setErr(null); }}>Back</button>
            <button className="btn btn-pri" type="submit" disabled={busy || !canFinish}>
              {busy ? <><span className="spinner" aria-hidden="true"/>Saving…</> : 'Set new password'}
            </button>
          </div>
          <p className="auth-hint" style={{textAlign: 'center', margin: 0}}>
            No code? Check spam, wait a minute, then <button type="button" className="auth-linkbtn" style={{...linkStyle, background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit'}}
              onClick={() => { setResetId(null); setErr(null); }}>send a new one</button>.
          </p>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout subtitle="Reset your password" brand={HUB_BRAND}
      description="Enter the mobile number or email of your Bravo Secure account. We will send you a code to choose a new password.">
      {available === false ? (
        <div style={authCol(16)}>
          <Note>Password reset is not available yet. Contact Bravo Secure support to reset your password.</Note>
          <Link className="btn btn-pri auth-submit" href={hubRoutes.login}>Back to sign in</Link>
        </div>
      ) : (
        <form onSubmit={start} style={authCol(16)}>
          <Field label="Mobile number or email" placeholder="+971 50 123 4567 or you@example.com" autoComplete="username"
            hint="A mobile number needs its country code." value={who} onChange={setWho} autoFocus/>
          {err && <Err msg={err}/>}
          <button className="btn btn-pri auth-submit" type="submit" disabled={busy || !whoValid}>
            {busy ? <><span className="spinner" aria-hidden="true"/>Sending code…</> : 'Send code'}
          </button>
          <p className="auth-hint" style={{textAlign: 'center', margin: 0}}>
            Remembered it? <Link href={hubRoutes.login} style={linkStyle}>Sign in</Link>
          </p>
        </form>
      )}
    </AuthLayout>
  );
}
