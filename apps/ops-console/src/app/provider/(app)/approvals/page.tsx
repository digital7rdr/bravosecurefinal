'use client';

/**
 * Join requests (provider console, 2026-10-31) — the app's ApprovalsScreen:
 * people who asked to join through a shared link (approve or decline), and the
 * personal invites still waiting to be accepted (revoke).
 *
 * Approve and decline are two separate server routes, so there is no third
 * outcome. If two managers decide the same request, the first wins and the
 * second is told so (409 join_request_already_decided), then the list reloads.
 * Sending new invites (phone or email, with a team) stays in the app.
 */

import {useState} from 'react';
import {useSWRConfig} from 'swr';
import {NotGranted, useProvider} from '@/components/provider/ProviderShell';
import {ConfirmDialog, Empty, PvCard, PvPage} from '@/components/provider/ui';
import {useToast} from '@/components/Toast';
import {
  deptError, deptErrorText, isDeptKey, pvJoinApi, usePvJoinRequests, usePvMemberInvites,
  type JoinRequest, type MemberInvite,
} from '@/lib/provider/api-dept';
import {when} from '@/lib/provider/labels';

/** Same words the app uses when a request names no team. */
const WHOLE_WORKSPACE = 'Whole workspace (all organisations)';

type Decision = {req: JoinRequest; approve: boolean};

export default function ProviderApprovals() {
  const {orgId, can} = useProvider();
  const allowed = can('dept');
  const {data, error} = usePvJoinRequests(orgId, allowed);
  const {data: inv, error: invError} = usePvMemberInvites(orgId, allowed);
  const {mutate} = useSWRConfig();
  const {push} = useToast();
  const [decide, setDecide] = useState<Decision | null>(null);
  const [revoke, setRevoke] = useState<MemberInvite | null>(null);

  if (!allowed) return <PvPage title="Join requests"><NotGranted what="Departmental"/></PvPage>;

  const refresh = () => mutate(isDeptKey);
  const requests = data?.requests ?? [];
  const invites = (inv?.invites ?? []).filter(i => i.status === 'pending');
  const who = (r: JoinRequest) => r.applicant_name ?? r.applicant_email ?? r.applicant_phone ?? 'Applicant';

  return (
    <PvPage title="Join requests"
      subtitle="People who asked to join your team through a shared link, and the personal invites that have not been accepted yet.">
      <PvCard title={<>Waiting for a decision {data ? <span className="pv-tab-n">{requests.length}</span> : null}</>} pad={false}>
        {error ? <Empty>{deptErrorText(error)}</Empty>
          : !data ? <Empty>Loading…</Empty>
          : requests.length === 0 ? <Empty>No one is waiting to join. Invite people from the app by phone or email; they join straight away with their personal code.</Empty>
          : (
            <div className="pv-table-wrap">
              <table className="pv-table">
                <thead><tr><th>Applicant</th><th>Contact</th><th>Team</th><th>Asked</th><th aria-label="Actions"/></tr></thead>
                <tbody>
                  {requests.map(r => (
                    <tr key={r.id}>
                      <td>
                        <div className="pv-strong">{who(r)}</div>
                        {r.message ? <div className="pv-cell-sub" style={{maxWidth: 320, fontStyle: 'italic'}}>&ldquo;{r.message}&rdquo;</div> : null}
                      </td>
                      <td>
                        {r.applicant_phone ? <div className="pv-mono">{r.applicant_phone}</div> : null}
                        {r.applicant_email ? <div className="pv-cell-sub">{r.applicant_email}</div> : null}
                        {!r.applicant_phone && !r.applicant_email ? '—' : null}
                      </td>
                      <td>
                        {r.team_name ?? <span className="pv-cell-sub">{WHOLE_WORKSPACE}</span>}
                        {r.referrer_name ? <div className="pv-cell-sub">Referred by {r.referrer_name}</div> : null}
                      </td>
                      <td>{when(r.created_at)}</td>
                      <td className="pv-row-actions">
                        <button className="btn btn-sm btn-ghost" onClick={() => setDecide({req: r, approve: false})}>Decline</button>
                        <button className="btn btn-sm btn-pri" onClick={() => setDecide({req: r, approve: true})}>Approve</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </PvCard>

      <PvCard title={<>Open invites {inv ? <span className="pv-tab-n">{invites.length}</span> : null}</>} pad={false}>
        {invError ? <Empty>{deptErrorText(invError)}</Empty>
          : !inv ? <Empty>Loading…</Empty>
          : invites.length === 0 ? <Empty>No open invites.</Empty>
          : (
            <div className="pv-table-wrap">
              <table className="pv-table">
                <thead><tr><th>Invited</th><th>Role</th><th>Team</th><th>Expires</th><th aria-label="Actions"/></tr></thead>
                <tbody>
                  {invites.map(i => (
                    <tr key={i.code}>
                      <td>
                        <div>{i.invited_name ?? i.contact}</div>
                        {i.invited_name ? <div className="pv-cell-sub">{i.contact}</div> : null}
                      </td>
                      <td>{i.invited_role === 'manager' ? 'Manager' : 'Member'}</td>
                      <td>{i.team_name ?? <span className="pv-cell-sub">{WHOLE_WORKSPACE}</span>}</td>
                      <td>{i.expires_at ? when(i.expires_at) : 'No expiry'}</td>
                      <td className="pv-row-actions">
                        <button className="btn btn-sm btn-danger" onClick={() => setRevoke(i)}>Revoke</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        <p className="pv-note" style={{padding: '0 16px 16px'}}>New invites are sent from the Bravo Secure app, where you choose the team and role.</p>
      </PvCard>

      <ConfirmDialog open={decide !== null}
        title={decide?.approve ? 'Approve join request' : 'Decline join request'}
        description={decide ? (decide.approve
          ? <>Let <b>{who(decide.req)}</b> join{decide.req.team_name ? <> the <b>{decide.req.team_name}</b> team</> : null}? They get access straight away.</>
          : <>Decline the request from <b>{who(decide.req)}</b>? The request is closed as declined.</>) : ''}
        confirmLabel={decide?.approve ? 'Approve' : 'Decline'}
        danger={decide ? !decide.approve : false}
        onClose={() => setDecide(null)}
        onConfirm={async () => {
          if (!decide) return;
          const {req, approve} = decide;
          try {
            if (approve) await pvJoinApi.approve(req.id);
            else await pvJoinApi.decline(req.id);
          } catch (e) {
            if ((e as {status?: number})?.status === 409 || (e as {status?: number})?.status === 404) void refresh();
            throw deptError(e);
          }
          setDecide(null);
          push({kind: 'ok', text: approve ? `${who(req)} can now join.` : `Request from ${who(req)} declined.`});
          await refresh();
        }}/>

      <ConfirmDialog open={revoke !== null} title="Revoke invite" danger confirmLabel="Revoke"
        description={revoke ? <>Revoke the invite for <b>{revoke.invited_name ?? revoke.contact}</b>? Their code stops working.</> : ''}
        onClose={() => setRevoke(null)}
        onConfirm={async () => {
          if (!revoke) return;
          const i = revoke;
          try {
            await pvJoinApi.revokeInvite(i.code);
          } catch (e) {
            if ((e as {status?: number})?.status === 409) void refresh();
            throw deptError(e);
          }
          setRevoke(null);
          push({kind: 'ok', text: `Invite for ${i.invited_name ?? i.contact} revoked.`});
          await refresh();
        }}/>
    </PvPage>
  );
}
