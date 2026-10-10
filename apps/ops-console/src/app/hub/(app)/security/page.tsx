'use client';

/**
 * Security (home site): set up the optional authenticator app. Once it is on,
 * every sign-in asks for its code instead of a texted one, and apps that
 * require it (Control Console) open.
 */
import Link from 'next/link';
import {useSearchParams} from 'next/navigation';
import {Suspense, useEffect, useState} from 'react';
import QRCode from 'qrcode';
import {useHub} from '@/components/hub/HubShell';
import {hubApi, ApiError, type TotpSetup} from '@/lib/hub/api';
import {hubRoutes} from '@/lib/hub/routes';

export default function SecurityPage() {
  return <Suspense fallback={null}><Security/></Suspense>;
}

function Security() {
  const {data, reload} = useHub();
  const params = useSearchParams();
  const forApp = params.get('for');
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!setup) { setQr(null); return; }
    let live = true;
    QRCode.toDataURL(setup.uri, {margin: 1, width: 328, color: {dark: '#06142B', light: '#FFFFFF'}})
      .then(u => { if (live) setQr(u); }).catch(() => { if (live) setQr(null); });
    return () => { live = false; };
  }, [setup]);

  async function start() {
    setBusy(true); setErr(null);
    try { setSetup(await hubApi.totpStart()); setSaved(false); setCode(''); }
    catch (e) { setErr(e instanceof ApiError && e.status === 409 ? 'Your authenticator is already on.' : 'Could not start the set-up. Try again.'); }
    finally { setBusy(false); }
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await hubApi.totpConfirm(code.replace(/[\s-]/g, ''));
      setDone(true); setSetup(null);
      void reload();
    } catch {
      setErr('That code did not work. Type the code your app shows now for Bravo Secure.');
    } finally { setBusy(false); }
  }

  const on = data.totp === 'verified' || done;

  return (
    <div className="hub-panel">
      <Link href={hubRoutes.home} className="hub-back">← All apps</Link>
      <h1 className="hub-panel-title">Security</h1>
      <div className="hub-facts">
        <div><span>Phone</span><b className={data.user.phone_verified ? 'ok' : ''}>{data.user.phone_verified ? 'Verified' : 'Not verified yet'}</b></div>
        <div><span>Email</span><b className={data.user.email_verified ? 'ok' : ''}>{data.user.email_verified ? 'Verified' : 'Not verified yet'}</b></div>
        <div><span>Authenticator app</span><b className={on ? 'ok' : ''}>{on ? 'On' : 'Off (optional)'}</b></div>
      </div>

      {forApp && !on && (
        <p className="hub-note">{forApp} requires an authenticator app. Set it up below, then open {forApp} again.</p>
      )}

      {on ? (
        <p className="hub-note">
          Your authenticator is on. Each sign-in now asks for its 6-digit code. Keep your backup codes somewhere safe:
          each one signs you in once if you lose your phone.
        </p>
      ) : !setup ? (
        <>
          <p className="hub-note">
            An authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) gives you a new code every
            30 seconds. With it on, a stolen password alone can never open your account.
          </p>
          {err && <div className="hub-err" role="alert">{err}</div>}
          <button className="btn btn-pri btn-lg" disabled={busy} onClick={() => void start()}>{busy ? 'Starting…' : 'Set up authenticator'}</button>
        </>
      ) : (
        <form onSubmit={confirm} className="hub-setup">
          <ol className="auth-steps">
            <li className="auth-step"><div>
              <div className="auth-step-title">Scan the QR code</div>
              <p className="auth-step-text">In your authenticator app, add a new account and scan this code.</p>
              {qr
                // eslint-disable-next-line @next/next/no-img-element -- generated data-URL
                ? <span className="auth-qr"><img src={qr} alt="Authenticator set-up QR code" width={164} height={164}/></span>
                : <div className="auth-qr-missing">QR code unavailable</div>}
              <div className="auth-hint" style={{marginTop: 12}}>Can&apos;t scan? Enter this key instead:</div>
              <div className="auth-secret"><code>{setup.secret}</code></div>
            </div></li>
            <li className="auth-step"><div>
              <div className="auth-step-title">Save your backup codes</div>
              <p className="auth-step-text">Each signs you in once if you lose your phone. They are shown only now.</p>
              <div className="auth-codes">{setup.backupCodes.map(c => <span key={c}>{c}</span>)}</div>
              <label className="auth-check" style={{marginTop: 10}}>
                <input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)}/>
                I have saved the backup codes somewhere safe.
              </label>
            </div></li>
            <li className="auth-step"><div>
              <div className="auth-step-title">Enter the 6-digit code</div>
              <input className="auth-input auth-code" value={code} onChange={e => setCode(e.target.value)} inputMode="numeric"
                placeholder="123 456" autoComplete="one-time-code" aria-label="Authenticator code"/>
            </div></li>
          </ol>
          {err && <div className="hub-err" role="alert">{err}</div>}
          <div className="auth-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setSetup(null)}>Cancel</button>
            <button className="btn btn-pri" disabled={busy || !saved || code.replace(/[\s-]/g, '').length < 6}>{busy ? 'Checking…' : 'Turn on'}</button>
          </div>
        </form>
      )}
    </div>
  );
}
