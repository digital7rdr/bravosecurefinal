'use client';

/**
 * Phone + password + authenticator sign-in, shared by the ops console
 * (/login) and the service provider console (provider host /login).
 *
 * Extracted unchanged from app/login/page.tsx on 2026-10-01; the only new
 * inputs are which API, cookie and storage keys to use, the wording, and an
 * optional post-sign-in check.
 */

import {useState, useEffect} from 'react';
import {useRouter} from 'next/navigation';
import {ApiError, type LoginStartResult} from '@/lib/api';
import QRCode from 'qrcode';
import {AuthLayout, Field, Note, Err, authCol, type AuthBrand} from '@/components/auth-primitives';

export interface SignInFlowProps {
  api: {
    loginStart: (phoneE164: string, password: string) => Promise<LoginStartResult>;
    loginVerify: (userId: string, code: string, challengeId?: string | null) => Promise<{expiresIn: number}>;
  };
  /** JS-readable csrf cookie whose presence means "already signed in". */
  csrfCookie: string;
  /** sessionStorage key for the access-token expiry the shell refreshes ahead of. */
  expiresKey: string;
  /** sessionStorage flag the shell sets on an idle sign-out. */
  idleKey: string;
  homeHref: string;
  /** "operator" / "service provider" — used in the first step's hint. */
  accountNoun: string;
  brand?: AuthBrand;
  /** Runs after a successful verify; a returned string is shown as the error. */
  afterSignIn?: () => Promise<string | null>;
}

/** "+971 50-123 4567" → "+971501234567": the API takes E.164 without separators. */
const normalisePhone = (v: string) => v.trim().replace(/[\s\-().]/g, '');
/** "123 456" → "123456": codes are letters and digits only. */
const normaliseCode = (v: string) => v.replace(/[\s-]/g, '');

/** Server error codes → sentences an operator can act on. */
export function friendlyError(e: unknown): string {
  if (e instanceof ApiError) {
    const body = (e.body ?? {}) as {error?: string; message?: string | string[]; attemptsLeft?: number};
    const code = body.error ?? (Array.isArray(body.message) ? body.message[0] : body.message) ?? e.message;
    if (code === 'otp_invalid') {
      const n = body.attemptsLeft;
      return typeof n === 'number'
        ? `That code didn't work. ${n} ${n === 1 ? 'attempt' : 'attempts'} left.`
        : "That code didn't work. Check the code in your app and try again.";
    }
    if (code === 'otp_max_attempts') return 'Too many wrong codes. Go back and sign in again.';
    if (code === 'otp_expired' || code === 'no_pending_otp' || code === 'challenge_required') {
      return 'This sign-in has expired. Go back and sign in again.';
    }
    if (code === 'otp_already_used') return 'That code was already used. Wait for the next code in your app.';
    if (e.status === 429) return 'Too many attempts. Wait a few minutes, then try again.';
    if (e.status >= 500) return 'The server had a problem. Try again in a moment.';
    return typeof code === 'string' && code ? code : 'Something went wrong. Try again.';
  }
  if (e instanceof TypeError) return 'Cannot reach the server. Check your connection and try again.';
  return (e as Error)?.message || 'Something went wrong. Try again.';
}

function CopyButton({text, label}: {text: string; label: string}) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1800);
    } catch { /* clipboard blocked — the text is selectable as a fallback */ }
  }
  return (
    <button type="button" className="btn btn-ghost btn-sm auth-copy" onClick={copy} aria-live="polite">
      {done ? 'Copied' : label}
    </button>
  );
}

export function SignInFlow({
  api, csrfCookie, expiresKey, idleKey, homeHref, accountNoun, brand, afterSignIn,
}: SignInFlowProps) {
  const router = useRouter();
  const [phone,    setPhone]    = useState('');
  const [password, setPassword] = useState('');
  const [otp,      setOtp]      = useState('');
  const [step,     setStep]     = useState<LoginStartResult | null>(null);   // non-null once the password step passed
  const [qr,       setQr]       = useState<string | null>(null);              // data-URL of the enrolment QR
  const [saved,    setSaved]    = useState(false);                            // "I saved my backup codes"
  const userId = step?.userId ?? null;
  const [busy,     setBusy]     = useState(false);
  const [err,      setErr]      = useState<string | null>(null);
  const [idleNote, setIdleNote] = useState(false);

  // OC-17 — the Shell has stamped this flag on idle logout since audit 4.1,
  // but nothing ever read it: operators were silently dumped at /login with
  // no explanation. Read-and-clear so the notice shows exactly once.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.sessionStorage.getItem(idleKey) === '1') {
      window.sessionStorage.removeItem(idleKey);
      setIdleNote(true);
    }
  }, [idleKey]);

  // Audit fix 0.4 — token is in an httpOnly cookie now; we can't probe
  // it directly. The CSRF cookie (set in pair with the token cookie)
  // is JS-readable, so we use its presence as the "already logged in"
  // signal and bounce to dashboard.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (new RegExp(`(?:^|;\\s*)${csrfCookie}=`).test(document.cookie)) {
      router.replace(homeHref);
    }
  }, [router, csrfCookie, homeHref]);

  useEffect(() => {
    if (!step?.enrol) { setQr(null); return; }
    let live = true;
    QRCode.toDataURL(step.enrol.uri, {margin: 1, width: 328, color: {dark: '#06142B', light: '#FFFFFF'}})   // dark-on-white: inverted codes trip some phone scanners
      .then(url => { if (live) setQr(url); })
      .catch(() => { if (live) setQr(null); });   // manual key is always shown as the fallback
    return () => { live = false; };
  }, [step]);

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await api.loginStart(normalisePhone(phone), password);
      if (!res.userId) {
        setErr('Wrong phone number or password.');
        return;
      }
      setSaved(false);
      setStep(res);
    } catch (e) {
      setErr(friendlyError(e));
    } finally { setBusy(false); }
  }

  async function onVerify(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !userId) return;
    setBusy(true); setErr(null);
    try {
      const res = await api.loginVerify(userId, normaliseCode(otp), step?.challengeId);
      // Audit fix 0.4 — no client-side session persistence: the auth-service
      // set the httpOnly cookies on /auth/verify; the tokens in `res` are
      // never stored by JS.
      // Audit fix 4.1 — stash the access TTL (NOT the token) so the Shell
      // can schedule its silent refresh ahead of expiry. sessionStorage
      // so it dies with the tab; not security-sensitive (the value is
      // just a duration in seconds).
      if (typeof window !== 'undefined') {
        window.sessionStorage.setItem(expiresKey, String(Date.now() + res.expiresIn * 1000));
      }
      // The provider console checks here that the account runs an agency,
      // and signs it straight back out with a reason when it does not.
      const refusal = afterSignIn ? await afterSignIn() : null;
      if (refusal) {
        setStep(null); setOtp(''); setPassword('');
        setErr(refusal);
        return;
      }
      router.replace(homeHref);
    } catch (e) {
      setErr(friendlyError(e));
    } finally { setBusy(false); }
  }

  const enrolling = step?.secondFactor === 'totp_enrol' && !!step.enrol;
  const title = !step ? 'Sign in'
    : enrolling ? 'Set up two-step verification'
    : 'Two-step verification';
  const description = !step ? `Use the phone number and password of your ${accountNoun} account.`
    : enrolling ? 'Your account needs an authenticator app before it can sign in. This takes about a minute.'
    : step.secondFactor === 'totp' ? 'Enter the 6-digit code from your authenticator app, or one of your backup codes.'
    : <>We sent a code to <b style={{color:'var(--tx-1)'}}>{step.otpSentTo ?? normalisePhone(phone)}</b>.</>;

  return (
    <AuthLayout subtitle={title} description={description} wide={enrolling} brand={brand}>
      {idleNote && !step && (
        <div style={{marginBottom:16}}>
          <Note>You were signed out after 15 minutes of inactivity. Sign in to continue.</Note>
        </div>
      )}

      {!step && (
        <form onSubmit={onLogin} style={authCol(18)}>
          <Field label="Phone number" hint="Include the country code, for example +971 50 123 4567."
            placeholder="+971 50 123 4567" autoComplete="username"
            value={phone} onChange={setPhone} autoFocus inputMode="tel"/>
          <Field label="Password" type="password" autoComplete="current-password"
            value={password} onChange={setPassword}/>
          {err && <Err msg={err}/>}
          <button className="btn btn-pri auth-submit" disabled={busy || !phone || !password} type="submit">
            {busy ? <><span className="spinner" aria-hidden="true"/>Checking…</> : 'Continue'}
          </button>
          {/* Audit fix 0.1 — public admin self-registration removed. New
              admins are added by an existing ADMIN via an invite flow
              (see auth.controller.ts admin-register/verify). */}
        </form>
      )}

      {step && (
        <form onSubmit={onVerify} style={authCol(18)}>
          {enrolling && step.enrol && (
            <ol className="auth-steps">
              <li className="auth-step">
                <div>
                  <div className="auth-step-title">Scan the QR code</div>
                  <p className="auth-step-text">
                    Open Google Authenticator, Microsoft Authenticator, 1Password or any
                    authenticator app and add a new account.
                  </p>
                  {qr
                    ? <span className="auth-qr">
                        {/* eslint-disable-next-line @next/next/no-img-element -- generated data-URL; nothing for next/image to fetch or optimise */}
                        <img src={qr} alt="Authenticator set-up QR code" width={164} height={164}/>
                      </span>
                    : <div className="auth-qr-missing">QR code unavailable</div>}
                  <div className="auth-hint" style={{marginTop:14}}>Can&apos;t scan? Enter this key in the app instead:</div>
                  <div className="auth-secret">
                    <code>{step.enrol.secret}</code>
                    <CopyButton text={step.enrol.secret} label="Copy key"/>
                  </div>
                </div>
              </li>
              <li className="auth-step">
                <div>
                  <div className="auth-step-title">Save your backup codes</div>
                  <p className="auth-step-text">
                    Each code signs you in once if you lose your phone. They are shown only now.
                  </p>
                  <div className="auth-codes">
                    {step.enrol.backupCodes.map(c => <span key={c}>{c}</span>)}
                  </div>
                  <div style={{display:'flex',justifyContent:'flex-end',marginTop:8}}>
                    <CopyButton text={step.enrol.backupCodes.join('\n')} label="Copy codes"/>
                  </div>
                  <label className="auth-check" style={{marginTop:10}}>
                    <input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)}/>
                    I have saved the backup codes somewhere safe.
                  </label>
                </div>
              </li>
              <li className="auth-step">
                <div>
                  <div className="auth-step-title">Enter the 6-digit code</div>
                  <p className="auth-step-text">Type the code your app now shows for Bravo Secure.</p>
                  <Field label="Authenticator code" placeholder="123 456" autoComplete="one-time-code"
                    className="auth-code" value={otp} onChange={setOtp} inputMode="numeric"/>
                </div>
              </li>
            </ol>
          )}
          {!enrolling && (
            <Field label={step.secondFactor === 'totp' ? 'Authenticator or backup code' : 'One-time code'}
              placeholder="123 456" autoComplete="one-time-code" className="auth-code"
              value={otp} onChange={setOtp} autoFocus inputMode={step.secondFactor === 'totp' ? 'text' : 'numeric'}/>
          )}
          {err && <Err msg={err}/>}
          <div className="auth-actions">
            <button type="button" className="btn btn-ghost"
              onClick={() => { setStep(null); setOtp(''); setErr(null); }}>
              Back
            </button>
            <button className="btn btn-pri"
              disabled={busy || normaliseCode(otp).length < 4 || (enrolling && !saved)}
              type="submit">
              {busy ? <><span className="spinner" aria-hidden="true"/>Verifying…</>
                : enrolling ? 'Turn on and sign in' : 'Sign in'}
            </button>
          </div>
        </form>
      )}
    </AuthLayout>
  );
}
