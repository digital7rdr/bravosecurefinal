'use client';

/**
 * Add user (2026-09-27) — creates an app account as an SMS INVITE. The admin
 * never types a password: the person installs the app and signs up with this
 * phone number; the OTP proves the phone and they set their own password.
 * Visual language matches ConfirmReasonModal (the People-area modal).
 */

import Link from 'next/link';
import {useEffect, useState} from 'react';
import {ApiError, opsApi, useAgencies, type AppAccountType, type CreateAppUserResult} from '@/lib/api';
import {routes} from '@/lib/routes';
import {IssuePassword} from './IssuePassword';

const TYPES: {id: AppAccountType; label: string; hint: string}[] = [
  {id: 'individual', label: 'Individual client', hint: 'Books Lite / Executive protection; can take Secure Pro later.'},
  {id: 'agency', label: 'Service-provider agency', hint: 'An agency owner account, born active (no review queue).'},
  {id: 'cpo', label: 'CPO agent', hint: 'An officer on an agency roster, born deployable.'},
];

const field = 'w-full rounded-lg border border-bd1 bg-s3 px-3 py-2 text-sm text-t1 placeholder:text-t3';
const label = 'mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-t3';

export function AddUserModal({onClose, onCreated}: {onClose: () => void; onCreated: () => void}) {
  const [type, setType] = useState<AppAccountType>('individual');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [agency, setAgency] = useState('');
  const [country, setCountry] = useState('AE');
  const [callSign, setCallSign] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<CreateAppUserResult | null>(null);
  const {data: agencies} = useAgencies();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) {onClose();} };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const phoneOk = /^\+\d{6,15}$/.test(phone.trim());
  const valid = name.trim().length >= 2 && /\S+@\S+\.\S+/.test(email.trim()) && phoneOk
    && (type !== 'cpo' || !!agency) && (type !== 'agency' || /^[A-Z]{2}$/.test(country));

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const out = await opsApi.createAppUser({
        account_type: type, display_name: name.trim(), email: email.trim(), phone_e164: phone.trim(),
        ...(type === 'cpo' ? {agency_user_id: agency, ...(callSign.trim() ? {call_sign: callSign.trim()} : {})} : {}),
        ...(type === 'agency' ? {coverage_country: country} : {}),
      });
      setDone(out);
      onCreated();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Could not create the account';
      setErr(/already_exists/.test(msg) ? 'That email or phone number already belongs to an account.' : msg);
    } finally {setBusy(false);}
  }

  return (
    <div onClick={() => !busy && onClose()}
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="add-user-title"
        className="w-full max-w-lg rounded-xl border border-bd1 bg-s2 shadow-2xl">
        <div className="border-b border-bd2 px-5 py-4">
          <div className="text-xs font-bold uppercase tracking-widest text-t3">People · new account</div>
          <div id="add-user-title" className="mt-1 text-lg font-bold text-t1">{done ? 'Account created' : 'Add user'}</div>
          {!done && (
            <div className="mt-2 text-sm leading-relaxed text-t3">
              No password needed. They get an SMS and activate the account by signing up in the Bravo
              Secure app with this phone number. The invite is valid for 14 days.
            </div>
          )}
        </div>

        {done ? (
          <div className="space-y-3 px-5 py-4 text-sm">
            <p className="text-t1">
              {done.sms_sent
                ? <>Invitation SMS sent to <span className="font-mono">{phone.trim()}</span>.</>
                : <>The account is ready, but <b className="text-warn">the SMS was not sent</b> (Twilio is not configured in
                  App Configuration → Integrations, or it failed). Tell them to sign up in the app with{' '}
                  <span className="font-mono">{phone.trim()}</span>.</>}
            </p>
            <p className="text-t3">Until they sign up the account cannot log in. You can resend the invite from their page.</p>
            <p className="text-t3">No SMS? Create their first sign-in password here and give it to them yourself:</p>
            <IssuePassword userId={done.user_id} phone={phone.trim()} accountType={done.account_type}/>
          </div>
        ) : (
          <div className="space-y-4 px-5 py-4">
            <div>
              <span className={label}>Account type</span>
              <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Account type">
                {TYPES.map(t => (
                  <button key={t.id} type="button" role="radio" aria-checked={type === t.id}
                    onClick={() => setType(t.id)}
                    className={`rounded-lg border px-2 py-2 text-xs font-semibold ${type === t.id
                      ? 'border-act bg-act/15 text-t1' : 'border-bd1 text-t2 hover:bg-s1'}`}>
                    {t.label}
                  </button>
                ))}
              </div>
              <div className="mt-1.5 text-[11px] text-t3">{TYPES.find(t => t.id === type)!.hint}</div>
            </div>

            {type === 'cpo' && (
              <div>
                <label className={label} htmlFor="au-agency">Agency</label>
                <select id="au-agency" className={field} value={agency} onChange={e => setAgency(e.target.value)}>
                  <option value="">Select the agency…</option>
                  {(agencies ?? []).filter(a => !a.suspended_at).map(a => (
                    <option key={a.id} value={a.id}>{a.display_name}</option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className={label} htmlFor="au-name">{type === 'agency' ? 'Agency name' : 'Full name'}</label>
              <input id="au-name" className={field} value={name} onChange={e => setName(e.target.value)} autoFocus />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className={label} htmlFor="au-email">Email</label>
                <input id="au-email" type="email" className={field} value={email} onChange={e => setEmail(e.target.value)} />
              </div>
              <div>
                <label className={label} htmlFor="au-phone">Mobile (E.164)</label>
                <input id="au-phone" className={`${field} font-mono`} placeholder="+971501234567"
                  value={phone} onChange={e => setPhone(e.target.value.replace(/[\s()-]/g, ''))} />
                {phone && !phoneOk && <div className="mt-1 text-[11px] text-warn">Use + and the country code, digits only.</div>}
              </div>
            </div>
            {type === 'agency' && (
              <div>
                <label className={label} htmlFor="au-country">Coverage country (ISO-2)</label>
                <input id="au-country" className={`${field} font-mono uppercase`} maxLength={2}
                  value={country} onChange={e => setCountry(e.target.value.toUpperCase())} />
              </div>
            )}
            {type === 'cpo' && (
              <div>
                <label className={label} htmlFor="au-cs">Call sign (optional)</label>
                <input id="au-cs" className={`${field} font-mono`} maxLength={24}
                  value={callSign} onChange={e => setCallSign(e.target.value)} />
              </div>
            )}
            {err && <p className="text-sm text-err">{err}</p>}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-bd2 px-5 py-3.5">
          {done ? (
            <>
              <button type="button" onClick={onClose}
                className="rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-s1">CLOSE</button>
              <Link href={routes.people.user(done.user_id)}
                className="rounded-md bg-act px-3 py-1.5 text-xs font-semibold text-white hover:bg-act-hov">OPEN ACCOUNT →</Link>
            </>
          ) : (
            <>
              <button type="button" onClick={onClose} disabled={busy}
                className="rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-s1 disabled:opacity-50">CANCEL</button>
              <button type="button" onClick={() => { void submit(); }} disabled={busy || !valid}
                className="rounded-md bg-act px-3 py-1.5 text-xs font-semibold text-white hover:bg-act-hov disabled:opacity-50">
                {busy ? 'CREATING…' : 'CREATE & SEND INVITE'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
