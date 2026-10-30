'use client';

import {useState} from 'react';
import {useSWRConfig} from 'swr';
import {NotGranted, useProvider} from '@/components/provider/ProviderShell';
import {Empty, PvCard, PvDialog, PvPage} from '@/components/provider/ui';
import {
  chartCounts, dutyLabel, initials, positionLabel, usePvHierarchy, usePvMemberProfile,
  type OrgHierarchyNode,
} from '@/lib/provider/api-intel';
import {errorText} from '@/lib/provider/labels';

/**
 * Org Chart — the app's OrgHierarchyScreen on the web. Read-only, like the app.
 *
 * The server has no "reports to" link, so this is grouped by role (owner →
 * managers → officers), not a reporting chain, and the page does not draw one.
 * The dot is the person's on-duty switch. Pictures are not loaded (the console
 * only loads images from its own host); initials stand in.
 */

function ringColour(n: OrgHierarchyNode): string {
  if (n.status === 'suspended') return 'var(--warn)';
  if (n.position === 'Owner') return 'var(--act)';
  if (n.position === 'Manager') return 'var(--glow)';
  return 'var(--bd-1)';
}

function Person({n, size, onOpen}: {n: OrgHierarchyNode; size: number; onOpen: (n: OrgHierarchyNode) => void}) {
  const duty = dutyLabel(n);
  const dim = n.status !== 'active';
  return (
    <button type="button" onClick={() => onOpen(n)}
      aria-label={`${n.display_name ?? 'Member'}, ${positionLabel(n.position)}, ${duty}`}
      style={{
        width: 128, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
        padding: '10px 6px', borderRadius: 12, border: '1px solid transparent', background: 'none',
        color: 'inherit', cursor: 'pointer', opacity: dim ? 0.6 : 1,
      }}>
      <span style={{position: 'relative', display: 'inline-flex'}}>
        <span className="pv-av" style={{width: size, height: size, fontSize: Math.round(size * 0.32), boxShadow: `0 0 0 2px ${ringColour(n)}`}}>
          {initials(n.display_name)}
        </span>
        <span aria-hidden title={duty} style={{
          position: 'absolute', right: -1, bottom: -1, width: 12, height: 12, borderRadius: '50%',
          background: n.on_duty && n.status === 'active' ? 'var(--ok)' : 'var(--tx-3)',
          border: '2px solid var(--surf-1)',
        }}/>
      </span>
      <span style={{fontSize: 13, fontWeight: 600, color: 'var(--tx-1)', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
        {n.display_name ?? 'Unnamed'}
      </span>
      <span className="pv-cell-sub" style={{textAlign: 'center'}}>
        {positionLabel(n.position)}{n.call_sign ? <> · <span className="pv-mono">{n.call_sign}</span></> : null}
      </span>
      {n.status !== 'active' && (
        <span className={n.status === 'suspended' ? 'pill pill-warn' : 'pill'}>{n.status === 'suspended' ? 'Suspended' : 'Invited'}</span>
      )}
    </button>
  );
}

function Tier({label, people, size, onOpen}: {label: string; people: OrgHierarchyNode[]; size: number; onOpen: (n: OrgHierarchyNode) => void}) {
  if (people.length === 0) return null;
  return (
    <>
      <div aria-hidden style={{width: 2, height: 24, background: 'var(--bd-1)', margin: '4px auto'}}/>
      <div className="pv-hint" style={{textAlign: 'center', textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 6}}>
        {label} · {people.length}
      </div>
      <div style={{display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8}}>
        {people.map(n => <Person key={n.user_id} n={n} size={size} onOpen={onOpen}/>)}
      </div>
    </>
  );
}

function ProfileDetails({orgId, userId}: {orgId: string; userId: string}) {
  const {data, error} = usePvMemberProfile(orgId, userId);
  if (error) return <div className="pv-err" role="alert">{errorText(error)}</div>;
  if (!data) return <p className="pv-hint">Loading profile…</p>;
  const s = data.stats;
  return (
    <dl className="pv-facts" style={{marginTop: 12}}>
      <div><dt>Phone</dt><dd>{data.phone_e164 ?? 'Not on file'}</dd></div>
      {data.rating != null && <div><dt>Rating</dt><dd>{data.rating.toFixed(1)}</dd></div>}
      {s && <div><dt>Missions completed</dt><dd>{s.missions_completed}{s.missions_led ? ` · led ${s.missions_led}` : ''}</dd></div>}
      {data.armed_authorized !== undefined && (
        <div><dt>Armed</dt><dd>{data.armed_authorized
          ? `Authorised${data.armed_expires_at ? ` until ${new Date(data.armed_expires_at).toLocaleDateString()}` : ''}`
          : 'Not authorised'}</dd></div>
      )}
      {data.on_mission && <div><dt>Now</dt><dd>On a mission</dd></div>}
      {data.status === 'suspended' && (
        <div><dt>Suspended</dt><dd>{data.suspended_until ? `Until ${new Date(data.suspended_until).toLocaleDateString()}` : 'Until lifted'}{data.suspend_reason ? ` · ${data.suspend_reason}` : ''}</dd></div>
      )}
      {data.created_at && <div><dt>Joined</dt><dd>{new Date(data.created_at).toLocaleDateString()}</dd></div>}
    </dl>
  );
}

export default function ProviderOrgChart() {
  const {orgId, can, org} = useProvider();
  const allowed = can('orgChart');
  const {data, error, isLoading} = usePvHierarchy(orgId, allowed);
  const {mutate} = useSWRConfig();
  const [open, setOpen] = useState<OrgHierarchyNode | null>(null);
  const [showProfile, setShowProfile] = useState(false);

  if (!allowed) return <PvPage title="Org chart"><NotGranted what="Org chart"/></PvPage>;

  const counts = data ? chartCounts(data) : null;
  const openNode = (n: OrgHierarchyNode) => { setOpen(n); setShowProfile(false); };

  return (
    <PvPage title="Org chart"
      subtitle={`Everyone at ${org.name}, grouped by role. The dot shows who is on duty right now.`}
      right={<button className="btn btn-ghost btn-sm" onClick={() => mutate(['pv', orgId, 'org-hierarchy'])}>Refresh</button>}>
      <PvCard pad={false}>
        {error ? <Empty>{errorText(error)}</Empty>
          : !data ? <Empty>{isLoading ? 'Loading the org chart…' : 'Nothing to show.'}</Empty>
          : (
            <div style={{padding: '20px 16px 24px'}}>
              {counts && (
                <p className="pv-hint" style={{textAlign: 'center', margin: '0 0 12px'}}>
                  {counts.people} {counts.people === 1 ? 'person' : 'people'} · {counts.onDuty} on duty
                  {counts.suspended ? ` · ${counts.suspended} suspended` : ''} · select anyone for details
                </p>
              )}
              <div style={{display: 'flex', justifyContent: 'center'}}>
                <Person n={data.owner} size={64} onOpen={openNode}/>
              </div>
              <Tier label="Managers" people={data.managers} size={52} onOpen={openNode}/>
              <Tier label="Officers" people={data.members} size={46} onOpen={openNode}/>
              {data.managers.length === 0 && data.members.length === 0 && (
                <Empty>No one on the roster yet.</Empty>
              )}
            </div>
          )}
        <div className="pv-legend">
          <span><i style={{background: 'var(--ok)'}}/>On duty</span>
          <span><i style={{background: 'var(--tx-3)'}}/>Off duty</span>
          <span><i style={{background: 'var(--warn)'}}/>Suspended</span>
        </div>
      </PvCard>

      <PvDialog open={!!open} title={open?.display_name ?? 'Member'} onClose={() => setOpen(null)}
        description={open ? `${positionLabel(open.position)} · ${dutyLabel(open)}` : undefined}
        footer={<>
          {open && !showProfile && (
            <button className="btn btn-sec" onClick={() => setShowProfile(true)}>Show full profile</button>
          )}
          <button className="btn btn-ghost" onClick={() => setOpen(null)}>Close</button>
        </>}>
        {open && (
          <>
            <dl className="pv-facts">
              <div><dt>Email</dt><dd>{open.email ?? 'No email on file'}</dd></div>
              <div><dt>Position</dt><dd>{positionLabel(open.position)}</dd></div>
              {open.call_sign && <div><dt>Call sign</dt><dd className="pv-mono">{open.call_sign}</dd></div>}
              {open.status !== 'active' && <div><dt>Status</dt><dd>{open.status === 'suspended' ? 'Suspended' : 'Invited'}</dd></div>}
            </dl>
            {showProfile && <ProfileDetails orgId={orgId} userId={open.user_id}/>}
          </>
        )}
      </PvDialog>
    </PvPage>
  );
}
