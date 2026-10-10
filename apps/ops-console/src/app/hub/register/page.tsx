'use client';

/**
 * Create a Bravo Secure account (home site, 2026-10-10).
 *
 *   1. Details: name, phone, email, password, terms.
 *   2. Two codes: one texted to the phone, one emailed. Each is accepted as
 *      soon as it is right, so a typo in one never costs the other.
 *   3. Done and signed in; the authenticator app is offered, optional.
 */
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useEffect, useState} from 'react';
import {AuthLayout, Err, Field, Note, authCol} from '@/components/auth-primitives';
import {ApiError, hubSignup, HUB_EXPIRES_KEY} from '@/lib/hub/api';
import {HUB_BRAND} from '@/lib/hub/brand';
import {hubRoutes} from '@/lib/hub/routes';

const normalisePhone = (v: string) => v.trim().replace(/[\s\-().]/g, '').replace(/^00/, '+');

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const b = (e.body ?? {}) as {error?: string; message?: string | string[]};
    const msg = Array.isArray(b.message) ? b.message[0] : b.message;
    if (b.error === 'already_exists') return 'An account already uses this phone number or email. Sign in instead.';
    if (b.error === 'signup_expired' || msg === 'signup_expired') return 'This registration has expired. Start again.';
    if (e.status === 429) return msg && !/ThrottlerException/.test(msg) ? msg : 'Too many attempts. Wait a few minutes, then try again.';
    if (msg && !/^[a-z_]+$/.test(msg)) return msg;
    if (e.status >= 500) return 'The server had a problem. Try again in a moment.';
    return 'Something went wrong. Check the details and try again.';
  }
  if (e instanceof TypeError) return 'Cannot reach Bravo Secure. Check your connection and try again.';
  return 'Something went wrong. Try again.';
}

function useCooldown(): [number, () => void] {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  return [Math.max(0, Math.ceil((until - now) / 1000)), () => setUntil(Date.now() + 60_000)];
}

export default function RegisterPage() {
  const router = useRouter();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [terms, setTerms] = useState(false);
  const [pending, setPending] = useState<{signupId: string; phone: string; email: string; devPhoneCode?: string} | null>(null);
  const [phoneCode, setPhoneCode] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [ok, setOk] = useState({phone: false, email: false});
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [phoneWait, startPhoneWait] = useCooldown();
  const [emailWait, startEmailWait] = useCooldown();

  useEffect(() => {
    hubSignup.status().then(s => setAvailable(s.available)).catch(() => setAvailable(true));
  }, []);

  const phoneE164 = normalisePhone(phone);
  const phoneValid = /^\+\d{7,15}$/.test(phoneE164);
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const pwShort = pw.length > 0 && pw.length < 10;
  const pwMismatch = pw2.length > 0 && pw2 !== pw;
  const detailsValid = name.trim().length >= 2 && phoneValid && emailValid && pw.length >= 10 && pw === pw2 && terms;

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (!detailsValid || busy) return;
    setBusy(true); setErr(null);
    try {
      const out = await hubSignup.start({displayName: name.trim(), email: email.trim(), phoneE164, password: pw, acceptTerms: true});
      setPending(out); setOk({phone: false, email: false}); startPhoneWait(); startEmailWait();
      // Testing mode (REGISTER_PHONE_PROOF=stub): no text is sent; the server hands the code back.
      if (out.devPhoneCode) setPhoneCode(out.devPhoneCode);
    } catch (ex) { setErr(errorText(ex)); }
    finally { setBusy(false); }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!pending || busy) return;
    setBusy(true); setErr(null);
    try {
      const out = await hubSignup.complete(pending.signupId, {
        ...(ok.phone ? {} : {phoneCode: phoneCode.replace(/\s/g, '')}),
        ...(ok.email ? {} : {emailCode: emailCode.replace(/\s/g, '')}),
      });
      if (!out.done) {
        setOk({phone: out.phoneOk, email: out.emailOk});
        setErr(!out.phoneOk && !out.emailOk ? 'Neither code is right. Check both and try again.'
          : !out.phoneOk ? 'The email is confirmed. The text message code is not right.'
          : 'The phone is confirmed. The email code is not right.');
        return;
      }
      if (!out.signedIn) { router.replace(hubRoutes.login); return; }
      try { window.sessionStorage.setItem(HUB_EXPIRES_KEY, String(Date.now() + (out.expiresIn ?? 900) * 1000)); } catch { /* ignore */ }
      setDone(true);
    } catch (ex) {
      setErr(errorText(ex));
      if (ex instanceof ApiError && ex.status === 403) setPending(null);   // locked: start again
    } finally { setBusy(false); }
  }

  async function resend(channel: 'phone' | 'email') {
    if (!pending) return;
    setErr(null);
    try {
      const r = await hubSignup.resend(pending.signupId, channel);
      if (r.devPhoneCode) { setPhoneCode(r.devPhoneCode); setPending({...pending, devPhoneCode: r.devPhoneCode}); }
      if (channel === 'phone') startPhoneWait(); else startEmailWait();
    } catch (ex) { setErr(errorText(ex)); }
  }

  if (done) {
    return (
      <AuthLayout subtitle="Your account is ready" brand={HUB_BRAND}
        description="Your phone number and email are verified and you are signed in.">
        <div style={authCol(16)}>
          <Note>
            For extra protection, add an authenticator app (Google Authenticator, Microsoft Authenticator or 1Password).
            It is optional for most apps; Control Console requires it.
          </Note>
          <button className="btn btn-pri auth-submit" onClick={() => router.replace(hubRoutes.security)}>Set up authenticator</button>
          <button className="btn btn-ghost auth-submit" onClick={() => router.replace(hubRoutes.home)}>Skip for now</button>
        </div>
      </AuthLayout>
    );
  }

  if (pending) {
    return (
      <AuthLayout subtitle="Verify your phone and email" brand={HUB_BRAND}
        description={<>We texted a code to <b style={{color: 'var(--tx-1)'}}>{pending.phone}</b> and emailed one to <b style={{color: 'var(--tx-1)'}}>{pending.email}</b>.</>}>
        <form onSubmit={verify} style={authCol(18)}>
          {pending.devPhoneCode && !ok.phone && (
            <Note>Testing mode: text messages are not sent yet, so the phone code has been filled in for you. The phone is not really verified.</Note>
          )}
          {ok.phone ? <Note>Phone verified ✓</Note> : (
            <div>
              <Field label="Code from the text message" placeholder="123456" inputMode="numeric" autoComplete="one-time-code"
                className="auth-code" value={phoneCode} onChange={setPhoneCode} autoFocus/>
              <button type="button" className="btn btn-ghost btn-sm" disabled={phoneWait > 0} onClick={() => void resend('phone')} style={{marginTop: 6}}>
                {phoneWait > 0 ? `Send again in ${phoneWait}s` : 'Send the text again'}
              </button>
            </div>
          )}
          {ok.email ? <Note>Email verified ✓</Note> : (
            <div>
              <Field label="Code from the email" placeholder="123456" inputMode="numeric"
                className="auth-code" value={emailCode} onChange={setEmailCode}/>
              <button type="button" className="btn btn-ghost btn-sm" disabled={emailWait > 0} onClick={() => void resend('email')} style={{marginTop: 6}}>
                {emailWait > 0 ? `Send again in ${emailWait}s` : 'Send the email again (check spam too)'}
              </button>
            </div>
          )}
          {err && <Err msg={err}/>}
          <div className="auth-actions">
            <button type="button" className="btn btn-ghost" onClick={() => { setPending(null); setErr(null); }}>Back</button>
            <button className="btn btn-pri" type="submit"
              disabled={busy || (!ok.phone && phoneCode.replace(/\s/g, '').length < 4) || (!ok.email && emailCode.replace(/\s/g, '').length < 4)}>
              {busy ? <><span className="spinner" aria-hidden="true"/>Checking…</> : 'Verify and create account'}
            </button>
          </div>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout subtitle="Create your account" brand={HUB_BRAND}
      description="One account for every Bravo Secure app. We verify your phone and your email.">
      {available === false ? (
        <div style={authCol(16)}>
          <Note>Registration opens shortly. If you already use the Bravo Secure app, sign in with the same phone number and password.</Note>
          <Link className="btn btn-pri auth-submit" href={hubRoutes.login}>Go to sign in</Link>
        </div>
      ) : (
        <form onSubmit={start} style={authCol(16)}>
          <Field label="Full name" autoComplete="name" value={name} onChange={setName} autoFocus/>
          <Field label="Mobile number" hint="With the country code, for example +971 50 123 4567. We text a code to it."
            placeholder="+971 50 123 4567" inputMode="tel" autoComplete="tel" value={phone} onChange={setPhone}/>
          <Field label="Email" type="email" autoComplete="email" hint="We email a code to it." value={email} onChange={setEmail}/>
          <Field label="Password" type="password" autoComplete="new-password"
            hint={pwShort ? 'At least 10 characters.' : 'At least 10 characters. A short sentence works well.'} value={pw} onChange={setPw}/>
          <Field label="Password again" type="password" autoComplete="new-password"
            hint={pwMismatch ? 'The two passwords do not match.' : undefined} value={pw2} onChange={setPw2}/>
          <label className="auth-check">
            <input type="checkbox" checked={terms} onChange={e => setTerms(e.target.checked)}/>
            I accept the Bravo Secure terms of service and privacy policy.
          </label>
          {err && <Err msg={err}/>}
          <button className="btn btn-pri auth-submit" type="submit" disabled={busy || !detailsValid}>
            {busy ? <><span className="spinner" aria-hidden="true"/>Sending codes…</> : 'Continue'}
          </button>
          <p className="auth-hint" style={{textAlign: 'center', margin: 0}}>
            Already have an account? <Link href={hubRoutes.login} style={{color: 'var(--glow)', fontWeight: 600}}>Sign in</Link>
          </p>
        </form>
      )}
    </AuthLayout>
  );
}
