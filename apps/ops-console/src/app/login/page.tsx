'use client';

import {useState, useEffect} from 'react';
import {useRouter} from 'next/navigation';
import {authApi, deviceId} from '@/lib/api';
import {AuthLayout, Field, Note, Err, authCol} from '@/components/auth-primitives';

export default function LoginPage() {
  const router = useRouter();
  const [phone,    setPhone]    = useState('');
  const [password, setPassword] = useState('');
  const [otp,      setOtp]      = useState('');
  const [userId,   setUserId]   = useState<string | null>(null);
  const [busy,     setBusy]     = useState(false);
  const [err,      setErr]      = useState<string | null>(null);
  const [idleNote, setIdleNote] = useState(false);

  // OC-17 — the Shell has stamped this flag on idle logout since audit 4.1,
  // but nothing ever read it: operators were silently dumped at /login with
  // no explanation. Read-and-clear so the notice shows exactly once.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.sessionStorage.getItem('bravo_ops_idle_logout') === '1') {
      window.sessionStorage.removeItem('bravo_ops_idle_logout');
      setIdleNote(true);
    }
  }, []);

  // Audit fix 0.4 — token is in an httpOnly cookie now; we can't probe
  // it directly. The CSRF cookie (set in pair with the token cookie)
  // is JS-readable, so we use its presence as the "already logged in"
  // signal and bounce to dashboard.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (/(?:^|;\s*)bravo_ops_csrf=/.test(document.cookie)) {
      router.replace('/');
    }
  }, [router]);

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await authApi.loginStart(phone, password);
      if (!res.userId) {
        setErr('Wrong phone or password.');
        return;
      }
      setUserId(res.userId);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  async function onVerify(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !userId) return;
    setBusy(true); setErr(null);
    try {
      const res = await authApi.loginVerify(userId, otp, deviceId());
      // Audit fix 0.4 — no client-side session persistence: the auth-service
      // set the httpOnly cookies on /auth/verify; the tokens in `res` are
      // never stored by JS.
      // Audit fix 4.1 — stash the access TTL (NOT the token) so the Shell
      // can schedule its silent refresh ahead of expiry. sessionStorage
      // so it dies with the tab; not security-sensitive (the value is
      // just a duration in seconds).
      if (typeof window !== 'undefined') {
        window.sessionStorage.setItem('bravo_ops_access_expires_at', String(Date.now() + res.expiresIn * 1000));
      }
      router.replace('/');
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <AuthLayout subtitle="Sign in to the ops console">
      {idleNote && (
        <Note>Signed out after 15 minutes of inactivity. Sign in to continue.</Note>
      )}
      {!userId && (
        <form onSubmit={onLogin} style={authCol(12)}>
          <Field label="Phone (E.164)" placeholder="+919876543210"
            value={phone} onChange={setPhone} autoFocus inputMode="tel"/>
          <Field label="Password" type="password" value={password} onChange={setPassword}/>
          {err && <Err msg={err}/>}
          <button className="btn btn-pri" disabled={busy || !phone || !password}
            type="submit"
            style={{height:42,justifyContent:'center',fontSize:13,marginTop:6}}>
            {busy ? 'SENDING OTP…' : 'CONTINUE'}
          </button>
          {/* Audit fix 0.1 — public admin self-registration removed. New
              admins are added by an existing ADMIN via an invite flow
              (see auth.controller.ts admin-register/verify). */}
        </form>
      )}

      {userId && (
        <form onSubmit={onVerify} style={authCol(12)}>
          <Note>
            OTP sent to <b style={{color:'var(--tx-1)'}}>{phone}</b>.
          </Note>
          <Field label="One-time code" placeholder="123456"
            value={otp} onChange={setOtp} autoFocus inputMode="numeric"/>
          {err && <Err msg={err}/>}
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
            <button type="button" className="btn btn-ghost"
              onClick={() => { setUserId(null); setOtp(''); setErr(null); }}
              style={{height:42,justifyContent:'center',fontSize:13}}>
              BACK
            </button>
            <button className="btn btn-pri" disabled={busy || otp.length < 4}
              type="submit"
              style={{height:42,justifyContent:'center',fontSize:13}}>
              {busy ? 'VERIFYING…' : 'SIGN IN'}
            </button>
          </div>
        </form>
      )}
    </AuthLayout>
  );
}
