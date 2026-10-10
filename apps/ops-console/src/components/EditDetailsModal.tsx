'use client';

/**
 * Edit a person's details from the ops console (2026-10-10): People → Users
 * and Internal → Admins. Email and phone start EMPTY on purpose: the console
 * only shows them masked (revealing is a separate, audited action), so the
 * form never pre-loads them. Leave a field empty to keep the current value.
 */
import {useEffect, useState} from 'react';

export interface DetailsField {
  key: string;
  label: string;
  /** Pre-filled value (name, call sign, region). Email/phone pass ''. */
  initial: string;
  placeholder?: string;
  hint?: string;
  type?: 'text' | 'email' | 'tel';
  /** Upper-case as typed (region). */
  upper?: boolean;
}

const ERRORS: Record<string, string> = {
  email_taken: 'Another account already uses this email.',
  phone_taken: 'Another account already uses this phone number.',
  call_sign_taken: 'Another admin already uses this call sign.',
  user_not_found: 'This account no longer exists (erased).',
  admin_not_found: 'This admin account no longer exists.',
};

export function editErrorText(e: unknown): string {
  const msg = (e as Error)?.message ?? '';
  for (const [code, text] of Object.entries(ERRORS)) if (msg.includes(code)) return text;
  if (/E\.164|phone must/.test(msg)) return 'Enter the phone with the country code, for example +971 50 123 4567.';
  if (/email must be an email/.test(msg)) return 'Enter a valid email address.';
  if (/region/.test(msg)) return 'Region: 2–8 capital letters, for example AE.';
  if (/call sign/.test(msg)) return 'Call sign: 2–24 letters, digits, - or _.';
  return msg || 'Could not save. Try again.';
}

export function EditDetailsModal({open, title, subtitle, fields, onSave, onClose}: {
  open: boolean;
  title: string;
  subtitle?: string;
  fields: DetailsField[];
  /** Receives only the fields that changed (empty strings dropped). */
  onSave: (patch: Record<string, string>) => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setValues(Object.fromEntries(fields.map(f => [f.key, f.initial])));
    setErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when (re)opened
  }, [open]);

  if (!open) return null;

  const patch: Record<string, string> = {};
  for (const f of fields) {
    let v = (values[f.key] ?? '').trim();
    if (f.type === 'tel') v = v.replace(/[\s\-().]/g, '');
    if (v && v !== f.initial.trim()) patch[f.key] = v;
  }
  const dirty = Object.keys(patch).length > 0;

  async function save() {
    setBusy(true); setErr(null);
    try { await onSave(patch); onClose(); }
    catch (e) { setErr(editErrorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <div onClick={() => !busy && onClose()}
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <form onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); if (dirty && !busy) void save(); }}
        className="w-full max-w-md rounded-xl border border-bd1 bg-s2 shadow-2xl" role="dialog" aria-modal="true" aria-label={title}>
        <div className="border-b border-bd2 px-5 py-4">
          <div className="text-xs font-bold uppercase tracking-widest text-t3">Bravo Ops · Edit</div>
          <div className="mt-1 text-lg font-bold text-t1">{title}</div>
          {subtitle && <div className="mt-2 text-sm leading-relaxed text-t3">{subtitle}</div>}
        </div>
        <div className="space-y-3 px-5 py-4">
          {fields.map(f => (
            <label key={f.key} className="block">
              <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-t3">{f.label}</div>
              <input
                type={f.type === 'email' ? 'email' : 'text'}
                inputMode={f.type === 'tel' ? 'tel' : undefined}
                value={values[f.key] ?? ''}
                placeholder={f.placeholder}
                autoComplete="off"
                onChange={e => setValues(v => ({...v, [f.key]: f.upper ? e.target.value.toUpperCase() : e.target.value}))}
                className="w-full rounded-lg border border-bd1 bg-s3 px-3 py-2 text-sm text-t1 placeholder:text-t3"/>
              {f.hint && <div className="mt-1 text-[11px] text-t3">{f.hint}</div>}
            </label>
          ))}
          {err && <div className="text-sm text-err" role="alert">{err}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-bd2 px-5 py-3">
          <button type="button" disabled={busy} onClick={onClose}
            className="rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-s1 disabled:opacity-50">CANCEL</button>
          <button type="submit" disabled={busy || !dirty}
            className="rounded-md bg-t1 px-4 py-1.5 text-xs font-semibold text-canvas disabled:opacity-40">
            {busy ? 'SAVING…' : 'SAVE'}
          </button>
        </div>
      </form>
    </div>
  );
}
