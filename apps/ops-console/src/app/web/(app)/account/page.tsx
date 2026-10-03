'use client';

/**
 * Account (Bravo Web App): who is signed in, the credits balance (top-ups stay
 * in the app: card payments are off on the web), the one-time ID document a
 * client needs before booking, the password, and the messenger vault.
 */
import {useState} from 'react';
import useSWR, {useSWRConfig} from 'swr';
import {useWeb} from '@/components/web/WebShell';
import {Empty, PvCard, PvPage, Stat} from '@/components/provider/ui';
import {useMessenger} from '@/components/messenger/MessengerProvider';
import {useToast} from '@/components/Toast';
import {expireWebCsrf, useBalance, webApi, webAuth, WEB_EXPIRES_KEY, WEB_PW_CHANGED_KEY} from '@/lib/web/api';
import {webErrorText} from '@/lib/web/labels';
import {credits} from '@/lib/provider/labels';
import {webRoutes} from '@/lib/web/routes';

const MAX_BYTES = 4 * 1024 * 1024;

export default function WebAccount() {
  const {me, client, signOut} = useWeb();
  const {data: balance} = useBalance(client);
  const messenger = useMessenger();
  return (
    <PvPage title="Account">
      <div className="kpi-row" style={{gridTemplateColumns: 'repeat(3, minmax(0, 1fr))'}}>
        <Stat label="Name" value={me.user.display_name ?? '—'}/>
        <Stat label="Phone" value={me.user.phone_e164 ?? '—'}/>
        {client
          ? <Stat label="Bravo credits" value={balance ? credits(balance.bravo_credits) : '—'} sub="Top up in the Bravo Secure app (Wallet)" tone="ok"/>
          : <Stat label="Account" value={me.account_kind === 'cpo' ? 'Officer' : 'Service provider'}/>}
      </div>
      <div className="pv-grid">
        {client && <IdentityCard/>}
        <PasswordCard/>
        <PvCard title="Messenger on this browser">
          <p className="pv-hint" style={{marginTop: 0}}>
            Your chats are end-to-end encrypted and kept in this browser, locked with your messenger passphrase.
            Signing out deletes them from this browser; your phone keeps its own copy.
          </p>
          <div className="pv-actions">
            {messenger.state === 'unlocked' && <button className="btn btn-sec" onClick={messenger.lock}>Lock messenger</button>}
            <button className="btn btn-ghost" onClick={signOut}>Sign out</button>
          </div>
        </PvCard>
      </div>
    </PvPage>
  );
}

function IdentityCard() {
  const {data, error} = useSWR(['web', 'identity'], webApi.identity);
  const {mutate} = useSWRConfig();
  const {push} = useToast();
  const [docType, setDocType] = useState<'national_id' | 'passport'>('passport');
  const [front, setFront] = useState<File | null>(null);
  const [back, setBack] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pickFile = (f: File | undefined, set: (f: File | null) => void) => {
    setErr(null);
    if (!f) { set(null); return; }
    if (!/^image\/(jpeg|png)$/.test(f.type)) { setErr('Use a JPEG or PNG photo.'); return; }
    if (f.size > MAX_BYTES) { setErr('Each photo must be 4 MB or smaller.'); return; }
    set(f);
  };

  async function submit() {
    if (!front) return;
    setBusy(true); setErr(null);
    try {
      await webApi.submitIdentity(docType, front, docType === 'national_id' ? back : null);
      push({kind: 'ok', text: 'ID received. You can book now.'});
      void mutate(['web', 'identity']); void mutate(['web', 'me']);
      setFront(null); setBack(null);
    } catch (e) { setErr(webErrorText(e)); }
    setBusy(false);
  }

  return (
    <PvCard title="ID document">
      {error ? <Empty>Could not load your ID status.</Empty> : !data ? <Empty>Loading…</Empty>
        : data.status === 'submitted' ? (
          <p style={{margin: 0}}>
            Your {data.doc_type === 'passport' ? 'passport' : 'national ID'} is on file
            {data.submitted_at ? ` since ${new Date(data.submitted_at).toLocaleDateString('en-GB')}` : ''}. Only Bravo Secure staff can view it.
          </p>
        ) : (
          <div className="pv-form">
            <p className="pv-hint" style={{margin: 0}}>
              {data.required ? 'Needed once before your first booking.' : 'Optional for now.'} Photos go straight to Bravo Secure and are only seen by its staff.
            </p>
            <div className="pv-seg">
              <button type="button" className={docType === 'passport' ? 'on' : ''} onClick={() => setDocType('passport')}>Passport</button>
              <button type="button" className={docType === 'national_id' ? 'on' : ''} onClick={() => setDocType('national_id')}>National ID</button>
            </div>
            <label className="pv-field"><span className="pv-label">{docType === 'passport' ? 'Photo page' : 'Front'}</span>
              <input type="file" accept="image/jpeg,image/png" onChange={e => pickFile(e.target.files?.[0], setFront)}/>
            </label>
            {docType === 'national_id' && (
              <label className="pv-field"><span className="pv-label">Back</span>
                <input type="file" accept="image/jpeg,image/png" onChange={e => pickFile(e.target.files?.[0], setBack)}/>
              </label>
            )}
            {err && <div className="pv-err" role="alert">{err}</div>}
            <button className="btn btn-pri" disabled={!front || busy || (docType === 'national_id' && !back)} onClick={() => void submit()}>
              {busy ? 'Uploading…' : 'Send ID'}
            </button>
          </div>
        )}
    </PvCard>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valid = current.length > 0 && next.length >= 12 && next === again && next !== current;

  async function submit() {
    setBusy(true); setErr(null);
    try {
      await webAuth.changePassword(current, next);
      // The server signs out every session of the account: go to sign-in.
      expireWebCsrf();
      try { window.sessionStorage.removeItem(WEB_EXPIRES_KEY); window.sessionStorage.setItem(WEB_PW_CHANGED_KEY, '1'); } catch { /* ignore */ }
      window.location.replace(webRoutes.login);
    } catch (e) {
      const code = (e as {body?: {message?: string}})?.body?.message;
      setErr(code === 'current_password_invalid' ? 'The current password is not correct.'
        : code === 'new_password_must_differ' ? 'Choose a password different from the current one.'
        : webErrorText(e));
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
    <PvCard title="Password">
      <form className="pv-form" onSubmit={e => { e.preventDefault(); if (valid && !busy) void submit(); }}>
        <p className="pv-hint" style={{margin: 0}}>The same password as the app. Changing it signs you out everywhere, phone included.</p>
        {field('Current password', current, setCurrent, 'current-password')}
        {field('New password', next, setNext, 'new-password', next && next.length < 12 ? 'At least 12 characters.' : 'At least 12 characters.')}
        {field('New password again', again, setAgain, 'new-password', again && again !== next ? 'The two new passwords do not match.' : undefined)}
        {err && <div className="pv-err" role="alert">{err}</div>}
        <button className="btn btn-pri" disabled={!valid || busy}>{busy ? 'Saving…' : 'Change password'}</button>
      </form>
    </PvCard>
  );
}
