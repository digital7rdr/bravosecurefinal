'use client';

import {useEffect, useState} from 'react';
import {opsDataApi, type DeletionPreview} from '@/lib/api';

/**
 * Owner, 2026-10-23: "if a user is deleted, all the linked account
 * responsibilities should be deleted. Before deletion it should notify the
 * user that all the user responsibilities will be deleted and cannot be
 * restored."
 *
 * The confirm for "Delete account": loads what the server WILL remove (the
 * same table the erase runs — account-responsibilities.ts), lists every role
 * and responsibility, what is kept anonymised and anything that blocks the
 * delete, says plainly it cannot be restored, and needs a reason plus the
 * word DELETE typed. Replaces the reason box + window.confirm double gate.
 */
export function DeleteAccountModal({userId, name, open, busy, onConfirm, onCancel}: {
  userId: string | null;
  name: string;
  open: boolean;
  busy?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (!open || !userId) return;
    setPreview(null); setLoadErr(null); setReason(''); setTyped('');
    let live = true;
    opsDataApi.deletionPreview(userId)
      .then(p => { if (live) setPreview(p); })
      .catch(e => { if (live) setLoadErr((e as Error).message || 'Could not load what this account holds.'); });
    return () => { live = false; };
  }, [open, userId]);

  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const blocked = (preview?.blockers.length ?? 0) > 0;
  const valid = !!preview && !blocked && reason.trim().length >= 3 && typed.trim() === 'DELETE';
  const roles = preview?.roles ?? [];
  const resp = preview?.responsibilities ?? [];
  const data = preview?.data ?? [];

  return (
    <div onClick={() => !busy && onCancel()}
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm sm:p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="del-acct-title" onClick={e => e.stopPropagation()}
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-xl border border-err/40 bg-s2 shadow-2xl">
        <div className="border-b border-bd2 px-5 py-4">
          <div className="text-xs font-bold uppercase tracking-widest text-err">Bravo Ops · Delete account</div>
          <div id="del-acct-title" className="mt-1 text-lg font-bold text-t1">Delete {name} permanently</div>
          <div className="mt-2 rounded-lg border border-err/30 bg-err/10 px-3 py-2 text-sm font-semibold text-err">
            Every role and responsibility below will be deleted with the account. This cannot be restored.
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-sm">
          {loadErr && <p role="alert" className="text-err">{loadErr}</p>}
          {!preview && !loadErr && <p className="text-t3">Checking everything this account holds…</p>}

          {preview && (
            <>
              {blocked && (
                <Section title="Cannot delete yet" tone="err">
                  {preview.blockers.map(b => <Line key={b.key} tone="err">{b.label}</Line>)}
                </Section>
              )}
              <Section title="Roles that will be deleted">
                {roles.length === 0
                  ? <Line muted>App account only — no admin, CPO or provider role.</Line>
                  : roles.map(r => <Line key={r.key}>{r.label}</Line>)}
                <Line>Signed out of {preview.devices} {preview.devices === 1 ? 'device' : 'devices'}; can never sign in again</Line>
                {preview.wallet_credits > 0 && <Line tone="err">{preview.wallet_credits} Bravo Credits forfeited</Line>}
              </Section>
              {resp.length > 0 && (
                <Section title="Responsibilities that will be removed">
                  {resp.map(r => <Line key={r.key}>{r.label}</Line>)}
                </Section>
              )}
              <Section title="Personal data that will be deleted">
                <Line>Name, email, phone number and photo (the number can be used for a new account)</Line>
                {data.map(d => <Line key={d.key}>{d.label}</Line>)}
              </Section>
              <Section title="Kept, without the name (business records)">
                {preview.kept.length === 0
                  ? <Line muted>Nothing — no bookings, payments or missions.</Line>
                  : preview.kept.map(k => <Line key={k.key} muted>{k.label}</Line>)}
                <Line muted>Audit history</Line>
              </Section>

              <label className="block">
                <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-t3">Reason (kept in the audit log)</span>
                <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} maxLength={1024}
                  disabled={blocked}
                  placeholder="e.g. Customer asked to close the account, ticket #…"
                  className="w-full resize-y rounded-lg border border-bd1 bg-s3 px-3 py-2 text-sm text-t1 placeholder:text-t3" />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-t3">Type DELETE to confirm</span>
                <input value={typed} onChange={e => setTyped(e.target.value)} disabled={blocked}
                  autoComplete="off" spellCheck={false} aria-label="Type DELETE to confirm"
                  className="w-full rounded-lg border border-bd1 bg-s3 px-3 py-2 font-mono text-sm text-t1" />
              </label>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-bd2 px-5 py-3.5">
          <button type="button" disabled={busy} onClick={onCancel}
            className="rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-s1 disabled:opacity-50">
            CANCEL
          </button>
          <button type="button" disabled={busy || !valid} onClick={() => onConfirm(reason.trim())}
            className="rounded-md bg-err-solid px-3 py-1.5 text-xs font-semibold text-white hover:bg-err-solid/80 disabled:opacity-50">
            {busy ? 'DELETING…' : 'DELETE ACCOUNT AND ALL ROLES'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({title, tone, children}: {title: string; tone?: 'err'; children: React.ReactNode}) {
  return (
    <div>
      <div className={`mb-1.5 text-[10px] font-bold uppercase tracking-widest ${tone === 'err' ? 'text-err' : 'text-t3'}`}>{title}</div>
      <ul className="space-y-1">{children}</ul>
    </div>
  );
}

function Line({children, tone, muted}: {children: React.ReactNode; tone?: 'err'; muted?: boolean}) {
  return (
    <li className={`flex gap-2 ${tone === 'err' ? 'text-err' : muted ? 'text-t3' : 'text-t1'}`}>
      <span aria-hidden="true">{tone === 'err' ? '!' : muted ? '·' : '×'}</span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}
