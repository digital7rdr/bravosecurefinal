'use client';

/**
 * Account access (2026-09-27) — on a user's page, for rank-3 admins:
 *  • the SMS-invite state of an ops-created account, with Resend;
 *  • per-user module overrides on top of the account group's Module Access.
 * Both endpoints are SUPER_ADMIN on the server; nobody else fires them.
 */

import {useState, type ReactNode} from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import {ApiError, opsApi, type UserModuleView} from '@/lib/api';
import {formatDateTimeUtc} from '@/lib/datetime';
import {routes} from '@/lib/routes';
import {IssuePassword} from './IssuePassword';

const GROUP_LABEL: Record<string, string> = {
  individual: 'Individual client', enterprise: 'Enterprise', agency: 'Service-provider agency', cpo: 'CPO agent',
};

type Choice = 'group' | 'on' | 'off';

export function UserAccessCard({userId, enabled, Card}: {
  userId: string;
  enabled: boolean;
  Card: (p: {title: string; right?: ReactNode; children: ReactNode}) => ReactNode;
}) {
  const invite = useSWR(enabled ? ['user-invite', userId] : null, () => opsApi.userInvite(userId));
  const mods = useSWR(enabled ? ['user-modules', userId] : null, () => opsApi.userModules(userId));
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ok: boolean; text: string} | null>(null);

  if (!enabled) {return null;}

  async function resend() {
    setBusy('invite'); setMsg(null);
    try {
      const out = await opsApi.resendInvite(userId);
      setMsg(out.sms_sent
        ? {ok: true, text: 'Invitation SMS sent again; valid for another 14 days.'}
        : {ok: false, text: 'Invitation extended 14 days, but the SMS was not sent (check Integrations → Twilio).'});
      await invite.mutate();
    } catch (e) {
      setMsg({ok: false, text: e instanceof ApiError ? e.message : 'Could not resend'});
    } finally {setBusy(null);}
  }

  async function choose(key: string, label: string, c: Choice) {
    const value = c === 'group' ? null : c === 'on';
    if (value === false) {
      // eslint-disable-next-line no-alert
      if (!window.confirm(`Switch “${label}” OFF for this user only? They get “not available on your account” immediately. SOS and sessions already in progress are never affected.`)) {return;}
    }
    setBusy(key); setMsg(null);
    try {
      const out = await opsApi.setUserModule(userId, key, value);
      await mods.mutate(out.view, {revalidate: false});
    } catch (e) {
      setMsg({ok: false, text: e instanceof ApiError ? e.message : 'Could not change the module'});
    } finally {setBusy(null);}
  }

  const inv = invite.data;
  const view: UserModuleView | undefined = mods.data;
  const applicable = view?.modules.filter(m => m.applicable) ?? [];

  return (
    <Card title="Access" right={
      <Link href={routes.config.modules} className="text-[11px] font-semibold uppercase tracking-widest text-act hover:underline">
        Group settings →
      </Link>
    }>
      {inv?.pending && (
        <div className={`mb-4 rounded-lg border px-4 py-3 text-sm ${inv.expired ? 'border-err/30 bg-err/5' : 'border-warn/30 bg-warn/5'}`}>
          <div className={`font-semibold ${inv.expired ? 'text-err' : 'text-warn'}`}>
            {inv.expired ? 'Invitation expired' : 'Invitation pending'}
          </div>
          <div className="mt-1 text-t2">
            Created by an admin{inv.invited_at ? ` on ${formatDateTimeUtc(inv.invited_at)}` : ''}. It activates when the
            person signs up in the app with this account’s phone number
            {inv.expires_at && !inv.expired ? ` — before ${formatDateTimeUtc(inv.expires_at)}` : ''}. It cannot log in until then.
          </div>
          <button type="button" onClick={() => { void resend(); }} disabled={busy === 'invite'}
            className="mt-2 rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t1 hover:bg-s1 disabled:opacity-50">
            {busy === 'invite' ? 'SENDING…' : inv.expired ? 'RENEW & RESEND SMS' : 'RESEND SMS'}
          </button>
          <IssuePassword userId={userId}
            accountType={view?.group === 'agency' ? 'agency' : view?.group === 'cpo' ? 'cpo' : view ? 'individual' : null}
            onIssued={() => { void invite.mutate(); }}/>
        </div>
      )}
      {inv?.claimed && (
        <p className="mb-3 text-xs text-t3">Created from an admin invitation; the account has a password.</p>
      )}

      {mods.error && <p className="text-sm text-err">Could not load module access.</p>}
      {view && (
        <>
          <div className="mb-2 text-xs text-t3">
            Group: <span className="font-semibold text-t1">{GROUP_LABEL[view.group] ?? view.group}</span>. “Group” follows
            Module Access; ON / OFF overrides it for this user only.
          </div>
          <div className="divide-y divide-bd2 rounded-lg border border-bd2">
            {applicable.map(m => {
              const choice: Choice = m.override === null ? 'group' : m.override ? 'on' : 'off';
              return (
                <div key={m.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <div className="text-sm text-t1">
                    {m.label}
                    <span className={`ml-2 text-[10px] font-bold uppercase tracking-widest ${m.enabled ? 'text-ok' : 'text-err'}`}>
                      {m.enabled ? 'on' : 'off'}
                    </span>
                  </div>
                  <div className="flex overflow-hidden rounded-md border border-bd1" role="radiogroup" aria-label={`${m.label} access`}>
                    {(['group', 'on', 'off'] as Choice[]).map(c => (
                      <button key={c} type="button" role="radio" aria-checked={choice === c}
                        disabled={busy === m.key}
                        onClick={() => { if (choice !== c) {void choose(m.key, m.label, c);} }}
                        className={`px-2.5 py-1 text-[11px] font-semibold uppercase ${choice === c
                          ? (c === 'off' ? 'bg-err/15 text-err' : c === 'on' ? 'bg-ok/15 text-ok' : 'bg-act/15 text-t1')
                          : 'text-t3 hover:bg-s1'}`}>
                        {c === 'group' ? `Group (${m.groupEnabled ? 'on' : 'off'})` : c}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            {applicable.length === 0 && <div className="px-3 py-2 text-sm text-t3">No switchable modules for this account group.</div>}
          </div>
        </>
      )}
      {msg && <p className={`mt-3 text-sm ${msg.ok ? 'text-ok' : 'text-warn'}`}>{msg.text}</p>}
    </Card>
  );
}
