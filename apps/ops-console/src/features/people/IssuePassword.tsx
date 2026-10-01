'use client';

/**
 * First sign-in password for an ops-created account (2026-10-01).
 *
 * SMS invites cannot reach anyone while SMS is off, so a Super Admin can give
 * the account its first password here instead. The server makes the password,
 * only for a never-claimed invite, and returns it once; this component keeps
 * it in memory only and drops it when closed. It is TEMPORARY: officers are
 * made to replace it in the app, and the provider console asks agencies to.
 */

import {useState} from 'react';
import {ApiError, opsApi, type AppAccountType} from '@/lib/api';

const PROVIDER_URL = process.env.NEXT_PUBLIC_PROVIDER_CONSOLE_URL ?? 'https://provider.bravosecure.cloud';

function whereToSignIn(t: AppAccountType | null): string {
  if (t === 'agency') return `the provider console at ${PROVIDER_URL}`;
  return 'the Bravo Secure app';
}

export function IssuePassword({userId, phone, accountType, onIssued}: {
  userId: string; phone?: string | null; accountType: AppAccountType | null; onIssued?: () => void;
}) {
  const [step, setStep] = useState<'idle' | 'confirm' | 'busy' | 'done'>('idle');
  const [pw, setPw] = useState<string | null>(null);
  const [type, setType] = useState<AppAccountType | null>(accountType);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function issue() {
    setStep('busy'); setErr(null);
    try {
      const out = await opsApi.issueInvitePassword(userId);
      setPw(out.password); setType(out.account_type); setStep('done');
      onIssued?.();
    } catch (e) {
      const code = e instanceof ApiError ? e.message : '';
      setErr(code === 'not_a_pending_invite' ? 'This account already has a password, so no new one was made.'
        : code === 'admin_accounts_not_allowed' ? 'Admin accounts get their password on Internal → Admins.'
        : code || 'Could not create the password.');
      setStep('idle');
    }
  }

  if (step === 'done' && pw) {
    return (
      <div className="mt-3 rounded-lg border border-ok/30 bg-ok/5 px-4 py-3 text-sm" role="status">
        <div className="font-semibold text-ok">Sign-in password created</div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <code className="rounded-md border border-bd1 bg-s3 px-3 py-1.5 font-mono text-base font-bold tracking-wider text-t1">{pw}</code>
          <button type="button"
            onClick={() => { void navigator.clipboard?.writeText(pw).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }).catch(() => undefined); }}
            className="rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t1 hover:bg-s1">
            {copied ? 'COPIED' : 'COPY'}
          </button>
        </div>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-t2">
          <li>Shown only now. It is not stored anywhere you can see it again.</li>
          <li>Give it to the person privately, by phone or in person, not by email or chat.</li>
          <li>They sign in at {whereToSignIn(type)} with {phone ? <span className="font-mono">{phone}</span> : 'their phone number'} and
            this password, then set up an authenticator app and change the password to one of their own.</li>
        </ul>
        <button type="button" onClick={() => { setPw(null); setStep('idle'); }}
          className="mt-3 rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-s1">
          I HAVE WRITTEN IT DOWN — HIDE IT
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3">
      {step === 'confirm' || step === 'busy' ? (
        <div className="rounded-lg border border-bd1 bg-s3 px-4 py-3 text-sm">
          <div className="text-t1">Create a sign-in password for this account?</div>
          <div className="mt-1 text-t3">
            Use this when the person did not get the SMS. The password is shown to you once; you give it to them.
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" disabled={step === 'busy'} onClick={() => setStep('idle')}
              className="rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-s1 disabled:opacity-50">CANCEL</button>
            <button type="button" disabled={step === 'busy'} onClick={() => { void issue(); }}
              className="rounded-md bg-act px-3 py-1.5 text-xs font-semibold text-white hover:bg-act/80 disabled:opacity-50">
              {step === 'busy' ? 'CREATING…' : 'CREATE PASSWORD'}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setStep('confirm')}
          className="rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t1 hover:bg-s1">
          CREATE SIGN-IN PASSWORD
        </button>
      )}
      {err && <p className="mt-2 text-sm text-warn">{err}</p>}
    </div>
  );
}
