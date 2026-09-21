'use client';

/**
 * One organisation — everything HQ can see about it without reading message
 * content: profile and workspace settings, the department roll-up, the channel
 * tree, the people in it, incidents, join requests and invites, a 30-day
 * attendance fold, the org audit feed and, at the end, the organisation graph.
 * Read-only: decisions belong to the organisation's own managers in the app.
 */

import {use, useMemo, useState, type ReactNode} from 'react';
import Link from 'next/link';
import {
  useEnterpriseOrg,
  type EnterpriseOrgActivity, type EnterpriseOrgChannel, type EnterpriseOrgDetail, type EnterpriseOrgMember,
} from '@/lib/api';
import {PageHeader} from '@/components/PageHeader';
import {KpiRow, KpiTile} from '@/components/SectionLanding';
import {CopyId} from '@/components/CopyId';
import {routes} from '@/lib/routes';
import {pillClass, type Tone} from '@/lib/status';
import {formatDateTimeShortUtc, formatDateTimeUtc, formatDateUtc} from '@/lib/datetime';
import {
  buildOrgGraph, edgePath, fitLabel, nameForTier, type GraphNode, type OrgGraph,
} from '@/lib/orgGraph';

/* ── vocab ─────────────────────────────────────────────────────────── */

const TYPE_BADGE: Record<string, {label: string; tone: Tone}> = {
  board: {label: 'BOARD', tone: 'warn'},
  department: {label: 'DEPT', tone: 'info'},
  incident: {label: 'INCIDENT', tone: 'err'},
};
const ACCESS_BADGE: Record<string, {label: string; tone: Tone}> = {
  read_only: {label: 'READ-ONLY', tone: 'warn'},
  restricted: {label: 'RESTRICTED', tone: 'err'},
};
const POST_MODE_LABEL: Record<string, string> = {
  open: 'open posting', read_only: 'admins post', announcement: 'announcements', admin_only: 'admins only',
};
const ROLE_LABEL: Record<string, string> = {manager: 'Managers', cpo: 'Officers (CPOs)', employee: 'Employees'};
const MEMBER_TONE: Record<string, Tone> = {active: 'ok', invited: 'info', suspended: 'warn', removed: 'muted'};
const SEVERITY_TONE: Record<string, Tone> = {critical: 'err', high: 'warn', medium: 'info', low: 'muted'};
const INCIDENT_STATUS_TONE: Record<string, Tone> = {
  submitted: 'warn', received: 'info', under_review: 'info', action_assigned: 'act', resolved: 'ok', closed: 'muted',
};
const JOIN_TONE: Record<string, Tone> = {pending: 'warn', approved: 'ok', declined: 'muted'};

const ATTENDANCE_ORDER: Array<{key: string; label: string; color: string}> = [
  {key: 'present', label: 'Present', color: 'var(--ok)'},
  {key: 'late', label: 'Late', color: 'var(--warn)'},
  {key: 'absent', label: 'Absent', color: 'var(--err)'},
  {key: 'early_checkout', label: 'Early out', color: 'var(--warn)'},
  {key: 'mission', label: 'On mission', color: 'var(--act)'},
  {key: 'leave', label: 'Leave', color: 'var(--info)'},
  {key: 'sick_leave', label: 'Sick', color: 'var(--info)'},
  {key: 'emergency_leave', label: 'Emergency', color: 'var(--err)'},
  {key: 'off_duty', label: 'Off duty', color: 'var(--tx-3)'},
  {key: 'pending_review', label: 'Pending', color: 'var(--warn)'},
  {key: 'unspecified', label: 'Unmarked', color: 'var(--tx-3)'},
];

const ACTION_LABELS: Record<string, string> = {
  'channel.create': 'Channel created',
  'channel.configure': 'Channel configured',
  'channel.archive': 'Channel archived',
  'channel.unarchive': 'Channel restored',
  'channel.delete': 'Channel deleted',
  'channel.reset_group': 'Channel encryption reset',
  'channel.promote_root': 'Channel promoted to organisation',
  'member.add': 'Member added',
  'member.role': 'Member role changed',
  'member.status': 'Member status changed',
  'member.channel_add': 'Member added to channel',
  'member.channel_remove': 'Member removed from channel',
  'member.channel_role': 'Member channel role changed',
  'member.channels_bulk_add': 'Member added to channels',
  'member.crypto_claims_stranded': 'Member key claims stranded',
  'roster.archived': 'Roster archived',
  'roster.published': 'Roster published',
  'roster.profile.view': 'Roster profile viewed',
  'incident.submit': 'Incident submitted',
  'incident.status': 'Incident status changed',
  'incident.note': 'Incident note added',
  'incident.assign': 'Incident assigned',
  'enterprise.invite.create': 'Invite created',
  'enterprise.invite.revoke': 'Invite revoked',
  'enterprise.invite.accept': 'Invite accepted',
  'enterprise.referral_link.create': 'Referral link created',
  'enterprise.referral_link.revoke': 'Referral link revoked',
  'attendance.shift.create': 'Shift created',
  'attendance.shift.update': 'Shift updated',
  'attendance.shift.edit': 'Shift edited',
  'attendance.shift.archive': 'Shift archived',
  'attendance.shift.assign': 'Shift assigned',
  'attendance.shift.unassign': 'Shift unassigned',
  'attendance.export': 'Attendance exported',
  'attendance.dispute': 'Attendance disputed',
  'attendance.day_status': 'Day status set',
  'attendance.corrected': 'Attendance corrected',
  'workspace.settings.update': 'Workspace settings updated',
  'org.workspace.create': 'Workspace created',
};

function actionLabel(action: string): string {
  const known = ACTION_LABELS[action];
  if (known) return known;
  const words = action.replace(/[._]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function actionTone(action: string): Tone {
  if (action.startsWith('incident')) return 'err';
  if (action.startsWith('channel')) return 'info';
  if (action.startsWith('attendance')) return 'ok';
  if (action.startsWith('enterprise') || action.startsWith('org')) return 'act';
  if (action.startsWith('member') || action.startsWith('roster')) return 'warn';
  return 'muted';
}

/** Primitive metadata only, a few entries, short — the feed is a summary. */
function metaSummary(meta: Record<string, unknown> | null | undefined): string {
  if (!meta) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
    const s = String(v);
    parts.push(`${k.replace(/_/g, ' ')}: ${s.length > 40 ? s.slice(0, 39) + '…' : s}`);
    if (parts.length === 4) break;
  }
  return parts.join(' · ');
}

function tierColor(n: GraphNode): string {
  if (n.kind === 'org') return 'var(--tx-2)';
  if (n.kind === 'lateral') return 'var(--tx-3)';
  return ['var(--act)', 'var(--ok)', 'var(--warn)', 'var(--info)'][(n.tier ?? 1) - 1];
}

/* ── page ──────────────────────────────────────────────────────────── */

export default function OrganisationDetailPage({params}: {params: Promise<{id: string}>}) {
  const {id} = use(params);
  const {data, isLoading, error} = useEnterpriseOrg(id);

  const org = data?.org;
  const graph = useMemo<OrgGraph | null>(() => data
    ? buildOrgGraph(data.channels, {orgName: org?.workspace_name ?? org?.display_name ?? 'Organisation', levelNames: org?.level_names})
    : null, [data, org?.workspace_name, org?.display_name, org?.level_names]);

  if (error) {
    return (
      <>
        <PageHeader title="Organisation" back={{href: routes.enterprise.departments, label: 'Departments'}} />
        <div className="card" style={{padding: 24, color: 'var(--err)'}}>
          Could not load this organisation. It may not exist, or it may be outside your region scope.
        </div>
      </>
    );
  }

  const title = org?.display_name ?? (isLoading ? 'Loading…' : 'Organisation');

  return (
    <>
      <PageHeader
        crumbs={['Enterprise', 'Departments', org?.display_name ?? '…']}
        back={{href: routes.enterprise.departments, label: 'Departments'}}
        title={title}
        badges={org && (
          <>
            {org.is_workspace && <span className="pill pill-act">WORKSPACE</span>}
            {org.is_agency && <span className="pill pill-info">AGENCY{org.agency_status ? ` · ${org.agency_status}` : ''}</span>}
            <span className={pillClass(org.subscription_tier === 'enterprise' ? 'ok' : 'muted')}>
              {org.subscription_tier.toUpperCase()} TIER
            </span>
            {org.suspended_at && <span className="pill pill-err">SUSPENDED</span>}
          </>
        )}
        actions={org && (
          <Link href={routes.people.user(org.id)} className="btn btn-sm btn-ghost">ACCOUNT RECORD →</Link>
        )}
      />

      <KpiRow columns={6}>
        <KpiTile label="Channels" value={org?.channels ?? '—'} href="#channels"
          sub={org ? `${org.channels_provisioned} E2E active · ${org.channels_archived} archived` : undefined} />
        <KpiTile label="Departments" value={org?.departments ?? '—'} href="#departments" />
        <KpiTile label="People" value={org?.members ?? '—'} href="#people"
          sub={data ? `${data.members.filter(m => m.member_role === 'manager' && m.status === 'active').length} managers` : undefined} />
        <KpiTile label="Incidents open" value={org?.incidents_open ?? '—'} href="#incidents"
          tone="err" urgent={(org?.incidents_open ?? 0) > 0} />
        <KpiTile label="Join requests" value={org?.join_pending ?? '—'} href="#joins"
          tone="warn" urgent={(org?.join_pending ?? 0) > 0} />
        <KpiTile label="Attendance · 30d" value={data?.attendance_30d.total ?? '—'} href="#attendance"
          tone="ok" sub={data ? `${data.attendance_30d.pending_review} pending review` : undefined} />
      </KpiRow>

      <div className="org-grid">
        <div>
          <Card title="Profile">
            {isLoading && !org && <div className="skel-row" />}
            {org && (
              <>
                <Row k="Organisation" v={<span>{org.display_name} <CopyId value={org.id} title="Copy organisation id" /></span>} />
                {org.workspace_name && <Row k="Workspace" v={org.workspace_name} />}
                <Row k="Contact" v={[org.email, org.phone_e164].filter(Boolean).join(' · ') || '—'} />
                <Row k="Region" v={org.home_region ?? org.country_code ?? '—'} />
                <Row k="Account" v={`${org.role.replace(/_/g, ' ')} · ${org.subscription_tier} tier`} />
                <Row k="Level names" v={levelNamesSummary(org.level_names)} />
                <Row k="Hidden modules" v={(org.hidden_modules ?? []).length ? org.hidden_modules!.join(', ') : 'none'} />
                <Row k="Invites" v={`${data!.invites.active} active · ${data!.invites.accepted} accepted · ${data!.invites.revoked} revoked`} />
                <Row k="On platform since" v={formatDateUtc(org.created_at)} />
                <Row k="Last activity" v={org.last_activity_at ? formatDateTimeUtc(org.last_activity_at) : 'no audit events yet'} />
                {org.settings_updated_at && <Row k="Settings changed" v={formatDateTimeUtc(org.settings_updated_at)} />}
                {org.suspended_at && (
                  <Row k="Suspended" v={`${formatDateTimeUtc(org.suspended_at)} · ${org.suspended_reason ?? 'no reason recorded'}`} />
                )}
              </>
            )}
          </Card>

          <div id="departments" />
          <DepartmentsCard data={data} loading={isLoading} />

          <div id="channels" />
          <ChannelsCard graph={graph} data={data} loading={isLoading} />
        </div>

        <div>
          <div id="people" />
          <PeopleCard members={data?.members ?? []} loading={isLoading} />

          <div id="incidents" />
          <Card title={`Incidents · ${data?.incidents.length ?? 0} recent`}>
            {isLoading && !data && <div className="skel-row" />}
            {data && data.incidents.length === 0 && <div className="q-empty">No incident reports from this organisation.</div>}
            {(data?.incidents ?? []).map(i => (
              <Link key={i.id} href={routes.enterprise.incidents} className="q-row">
                <div style={{minWidth: 0}}>
                  <div className="q-primary">{i.ref ?? i.id.slice(0, 8)} · {i.category.replace(/_/g, ' ')}</div>
                  <div className="q-secondary">
                    {i.department ?? 'no department'} · by {i.submitter_name ?? 'unknown'}
                    {i.assigned_to_name ? ` · assigned ${i.assigned_to_name}` : ''} · {formatDateTimeShortUtc(i.updated_at)}
                  </div>
                </div>
                <div className="q-right">
                  <span className={pillClass(SEVERITY_TONE[i.severity] ?? 'muted')}>{i.severity.toUpperCase()}</span>
                  <span className={pillClass(INCIDENT_STATUS_TONE[i.status] ?? 'muted')}>{i.status.replace(/_/g, ' ').toUpperCase()}</span>
                </div>
              </Link>
            ))}
            {data && data.incidents.length > 0 && (
              <div className="q-footer"><Link href={routes.enterprise.incidents}>Open all incident reports →</Link></div>
            )}
          </Card>

          <div id="joins" />
          <Card title={`Join requests · ${data?.join_requests.length ?? 0} recent`}>
            {isLoading && !data && <div className="skel-row" />}
            {data && data.join_requests.length === 0 && <div className="q-empty">Nobody has asked to join this organisation.</div>}
            {(data?.join_requests ?? []).map(r => (
              <div key={r.id} className="q-row" style={{cursor: 'default'}}>
                <div style={{minWidth: 0}}>
                  <div className="q-primary">{r.applicant_name ?? r.applicant_email ?? r.applicant_phone ?? 'Applicant'}</div>
                  <div className="q-secondary">
                    {r.team_name ? `team ${r.team_name} · ` : ''}
                    {r.referrer_name ? `via ${r.referrer_name} · ` : ''}
                    asked {formatDateTimeShortUtc(r.created_at)}
                    {r.decided_at ? ` · decided ${formatDateTimeShortUtc(r.decided_at)}${r.decided_by_name ? ` by ${r.decided_by_name}` : ''}` : ''}
                  </div>
                </div>
                <div className="q-right">
                  <span className={pillClass(JOIN_TONE[r.status] ?? 'muted')}>{r.status.toUpperCase()}</span>
                </div>
              </div>
            ))}
            <div className="q-footer">
              Decisions are made by the organisation&apos;s managers in the app. <Link href={routes.enterprise.joinRequests}>Cross-workspace queue →</Link>
            </div>
          </Card>

          <div id="attendance" />
          <AttendanceCard data={data} loading={isLoading} />

          <ActivityCard rows={data?.activity ?? []} loading={isLoading} />
        </div>
      </div>

      <div id="graph" />
      <GraphCard graph={graph} data={data} loading={isLoading} />
    </>
  );
}

/* ── cards ─────────────────────────────────────────────────────────── */

function levelNamesSummary(names: string[] | null | undefined): string {
  const chosen = (names ?? []).some(n => n && n.trim().length > 0);
  const list = [1, 2, 3, 4].map(t => `L${t} ${nameForTier(t, names)}`).join(' · ');
  return chosen ? list : `${list} (defaults)`;
}

function DepartmentsCard({data, loading}: {data: EnterpriseOrgDetail | null | undefined; loading: boolean}) {
  const rows = useMemo(() => {
    if (!data) return [];
    const map = new Map<string, {channels: number; members: number; managers: string[]; incidents: number}>();
    const at = (k: string) => {
      const key = k.trim() || 'Unassigned';
      const v = map.get(key) ?? {channels: 0, members: 0, managers: [], incidents: 0};
      map.set(key, v);
      return v;
    };
    for (const c of data.channels) if (c.department) at(c.department).channels += 1;
    for (const m of data.members) {
      if (m.status !== 'active') continue;
      const d = at(m.department ?? '');
      d.members += 1;
      if (m.member_role === 'manager') d.managers.push(m.display_name ?? m.user_id.slice(0, 8));
    }
    for (const i of data.incidents) {
      if (i.department && i.status !== 'resolved' && i.status !== 'closed') at(i.department).incidents += 1;
    }
    return [...map.entries()]
      .map(([name, v]) => ({name, ...v}))
      .sort((a, b) => (a.name === 'Unassigned' ? 1 : 0) - (b.name === 'Unassigned' ? 1 : 0) || b.members - a.members || a.name.localeCompare(b.name));
  }, [data]);

  return (
    <Card title={`Departments · ${rows.filter(r => r.name !== 'Unassigned').length}`}>
      {loading && !data && <div className="skel-row" />}
      {data && rows.length === 0 && (
        <div className="q-empty">No departments named yet. A department appears once a channel or a member is tagged with one.</div>
      )}
      {rows.map(r => (
        <div key={r.name} className="q-row" style={{cursor: 'default'}}>
          <div style={{minWidth: 0}}>
            <div className="q-primary">{r.name}</div>
            <div className="q-secondary">
              {r.managers.length > 0 ? `managed by ${r.managers.slice(0, 3).join(', ')}${r.managers.length > 3 ? ` +${r.managers.length - 3}` : ''}` : 'no manager assigned'}
            </div>
          </div>
          <div className="q-right">
            <span className="pill pill-info">{r.channels} CH</span>
            <span className="pill">{r.members} PEOPLE</span>
            {r.incidents > 0 && <span className="pill pill-err">{r.incidents} OPEN</span>}
          </div>
        </div>
      ))}
    </Card>
  );
}

function ChannelsCard({graph, data, loading}: {graph: OrgGraph | null; data: EnterpriseOrgDetail | null | undefined; loading: boolean}) {
  const nodes = (graph?.nodes ?? []).filter(n => n.kind !== 'org');
  return (
    <Card title={`Channels · ${nodes.length}`} action={
      <a href="#graph" className="card-header-act">VIEW GRAPH ↓</a>
    }>
      {loading && !data && <><div className="skel-row" /><div className="skel-row" /></>}
      {data && nodes.length === 0 && (
        <div className="q-empty">No department channels yet. Channels are created by the organisation&apos;s admins in the app.</div>
      )}
      {nodes.map(n => <ChannelRow key={n.id} node={n} />)}
      {data && data.org.channels_archived > 0 && (
        <div className="q-footer" style={{color: 'var(--tx-3)'}}>
          {data.org.channels_archived} archived channel{data.org.channels_archived === 1 ? '' : 's'} not shown.
        </div>
      )}
    </Card>
  );
}

function ChannelRow({node}: {node: GraphNode}) {
  const c = node.channel as EnterpriseOrgChannel;
  const type = TYPE_BADGE[c.channel_type];
  const access = ACCESS_BADGE[c.access];
  return (
    <div className="org-tree-row" style={{paddingLeft: 14 + (node.depth - 1) * 18}}>
      <div style={{minWidth: 0, display: 'flex', gap: 8, alignItems: 'flex-start'}}>
        <span className="org-tier-dot" style={{background: tierColor(node), borderStyle: node.kind === 'lateral' ? 'dashed' : 'solid'}} aria-hidden="true" />
        <div style={{minWidth: 0}}>
          <div className="q-primary" style={{display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap'}}>
            <span style={{overflow: 'hidden', textOverflow: 'ellipsis'}}>{c.name}</span>
            <span className="org-tier-tag" style={{color: tierColor(node)}}>{node.tierLabel.toUpperCase()}</span>
          </div>
          <div className="q-secondary" style={{whiteSpace: 'normal'}}>
            {c.department ? `${c.department} · ` : ''}
            {c.member_count} member{c.member_count === 1 ? '' : 's'} · {c.admin_count} admin{c.admin_count === 1 ? '' : 's'}
            {' · '}{POST_MODE_LABEL[c.post_mode] ?? c.post_mode}
            {' · '}created {formatDateUtc(c.created_at)}{c.created_by_name ? ` by ${c.created_by_name}` : ''}
            {c.description ? ` · ${c.description}` : ''}
          </div>
        </div>
      </div>
      <div className="q-right" style={{flexWrap: 'wrap', justifyContent: 'flex-end'}}>
        {type && <span className={pillClass(type.tone)}>{type.label}</span>}
        {access && <span className={pillClass(access.tone)}>{access.label}</span>}
        <span className={pillClass(c.provisioned ? 'ok' : 'muted')}>{c.provisioned ? '● E2E ACTIVE' : '○ NOT ACTIVE'}</span>
      </div>
    </div>
  );
}

function PeopleCard({members, loading}: {members: EnterpriseOrgMember[]; loading: boolean}) {
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const groups = (['manager', 'cpo', 'employee'] as const)
    .map(role => ({role, rows: members.filter(m => m.member_role === role)}))
    .filter(g => g.rows.length > 0);
  const CAP = 8;
  return (
    <Card title={`People · ${members.filter(m => m.status === 'active').length} active`}>
      {loading && members.length === 0 && <div className="skel-row" />}
      {!loading && members.length === 0 && <div className="q-empty">Nobody is a member of this organisation yet.</div>}
      {groups.map(g => {
        const open = showAll[g.role] ?? false;
        const rows = open ? g.rows : g.rows.slice(0, CAP);
        return (
          <div key={g.role}>
            <div className="org-group-head">{ROLE_LABEL[g.role]} · {g.rows.length}</div>
            {rows.map(m => (
              <Link key={m.user_id} href={m.member_role === 'cpo' ? routes.people.agent(m.user_id) : routes.people.user(m.user_id)} className="q-row">
                <div style={{minWidth: 0}}>
                  <div className="q-primary">{m.display_name ?? m.user_id.slice(0, 8)}{m.call_sign ? ` · ${m.call_sign}` : ''}</div>
                  <div className="q-secondary">
                    {m.department ?? 'no department'} · since {formatDateUtc(m.created_at)}
                    {m.on_duty ? ' · ON DUTY' : ''}
                    {m.status === 'suspended' && m.suspended_until ? ` · until ${formatDateUtc(m.suspended_until)}` : ''}
                  </div>
                </div>
                <div className="q-right">
                  {m.status !== 'active' && <span className={pillClass(MEMBER_TONE[m.status] ?? 'muted')}>{m.status.toUpperCase()}</span>}
                  {m.status === 'active' && <span className="pill pill-ok">ACTIVE</span>}
                </div>
              </Link>
            ))}
            {g.rows.length > CAP && (
              <div className="q-footer">
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowAll(s => ({...s, [g.role]: !open}))}>
                  {open ? 'SHOW FEWER' : `SHOW ALL ${g.rows.length}`}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </Card>
  );
}

function AttendanceCard({data, loading}: {data: EnterpriseOrgDetail | null | undefined; loading: boolean}) {
  const a = data?.attendance_30d;
  const buckets = a ? ATTENDANCE_ORDER.filter(s => (a.counts[s.key] ?? 0) > 0) : [];
  const known = new Set(ATTENDANCE_ORDER.map(s => s.key));
  const extra = a ? Object.entries(a.counts).filter(([k, n]) => !known.has(k) && n > 0) : [];
  return (
    <Card title="Attendance · last 30 days" action={
      <Link href={routes.enterprise.attendance} className="card-header-act">EXPORT →</Link>
    }>
      {loading && !a && <div className="skel-row" />}
      {a && a.total === 0 && (
        <div className="q-empty">No shift sessions in the last 30 days.{a.shifts_upcoming > 0 ? ` ${a.shifts_upcoming} shift(s) scheduled ahead.` : ''}</div>
      )}
      {a && a.total > 0 && (
        <>
          <div className="org-att-grid">
            {buckets.map(s => (
              <div key={s.key} className="org-att-tile">
                <div className="org-att-num" style={{color: s.color}}>{a.counts[s.key]}</div>
                <div className="org-att-cap">{s.label}</div>
              </div>
            ))}
            {extra.map(([k, n]) => (
              <div key={k} className="org-att-tile">
                <div className="org-att-num">{n}</div>
                <div className="org-att-cap">{k.replace(/_/g, ' ')}</div>
              </div>
            ))}
          </div>
          <div className="q-footer" style={{display: 'flex', gap: 14, flexWrap: 'wrap', color: 'var(--tx-3)'}}>
            <span>{a.total} session{a.total === 1 ? '' : 's'}</span>
            <span style={{color: a.pending_review > 0 ? 'var(--warn)' : undefined}}>{a.pending_review} pending review</span>
            <span>{a.sessions_open} clocked in now</span>
            <span>{a.shifts_upcoming} shift{a.shifts_upcoming === 1 ? '' : 's'} ahead</span>
          </div>
        </>
      )}
    </Card>
  );
}

function ActivityCard({rows, loading}: {rows: EnterpriseOrgActivity[]; loading: boolean}) {
  const [limit, setLimit] = useState(20);
  return (
    <Card title={`Activity · ${rows.length} recent`}>
      {loading && rows.length === 0 && <><div className="skel-row" /><div className="skel-row" /></>}
      {!loading && rows.length === 0 && <div className="q-empty">No audited activity yet.</div>}
      {rows.slice(0, limit).map(e => {
        const meta = metaSummary(e.metadata);
        return (
          <div key={e.id} className="q-row" style={{cursor: 'default'}}>
            <div style={{minWidth: 0}}>
              <div className="q-primary" style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap'}}>
                <span className={pillClass(actionTone(e.action))}>{e.action.split('.')[0].toUpperCase()}</span>
                <span>{actionLabel(e.action)}</span>
              </div>
              <div className="q-secondary" style={{whiteSpace: 'normal'}}>
                {e.actor_name ?? 'system'}
                {e.target_kind ? ` · ${e.target_kind.replace(/_/g, ' ')}${e.target_id ? ` ${e.target_id.slice(0, 8)}` : ''}` : ''}
                {meta ? ` · ${meta}` : ''}
              </div>
            </div>
            <div className="q-right">
              <span className="dt-when" style={{whiteSpace: 'nowrap'}}>{formatDateTimeShortUtc(e.created_at)}</span>
            </div>
          </div>
        );
      })}
      {rows.length > limit && (
        <div className="q-footer">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setLimit(l => l + 40)}>
            SHOW MORE ({rows.length - limit} older)
          </button>
        </div>
      )}
    </Card>
  );
}

function GraphCard({graph, data, loading}: {graph: OrgGraph | null; data: EnterpriseOrgDetail | null | undefined; loading: boolean}) {
  const [fit, setFit] = useState(false);
  const levelNames = data?.org.level_names;
  const byId = useMemo(() => new Map((graph?.nodes ?? []).map(n => [n.id, n])), [graph]);
  return (
    <div className="card" style={{marginTop: 4}}>
      <div className="card-header">
        <div className="card-header-title"><span className="bar" />Organisation graph</div>
        {graph && (
          <button type="button" className="card-header-act" onClick={() => setFit(f => !f)}
            aria-pressed={fit} style={{background: 'none', border: 'none'}}>
            {fit ? 'ACTUAL SIZE' : 'FIT TO WIDTH'}
          </button>
        )}
      </div>
      <div className="org-legend" aria-label="Legend">
        {[1, 2, 3, 4].map(t => (
          <span key={t}>
            <i style={{background: ['var(--act)', 'var(--ok)', 'var(--warn)', 'var(--info)'][t - 1]}} />L{t} {nameForTier(t, levelNames)}
          </span>
        ))}
        <span><i style={{background: 'transparent', border: '1px dashed var(--tx-3)'}} />Lateral / announcement</span>
        <span><i style={{background: 'var(--tx-2)'}} />Organisation</span>
      </div>
      {loading && !graph && <div className="skel-row" />}
      {graph && graph.nodes.length === 1 && (
        <div className="q-empty">Nothing to draw yet — this organisation has no department channels.</div>
      )}
      {graph && graph.nodes.length > 1 && (
        <div className="org-graph-wrap">
          <svg
            role="img"
            aria-label={`Organisation graph: ${graph.nodes.length - 1} channels`}
            viewBox={`0 0 ${graph.width} ${graph.height}`}
            width={fit ? '100%' : graph.width}
            height={fit ? undefined : graph.height}
            style={fit ? {maxWidth: '100%'} : undefined}
          >
            <g fill="none" stroke="var(--bd-1)" strokeWidth={1.5}>
              {graph.edges.map(e => {
                const from = byId.get(e.from), to = byId.get(e.to);
                if (!from || !to) return null;
                return <path key={`${e.from}-${e.to}`} d={edgePath(from, to)} strokeDasharray={e.lateral ? '4 4' : undefined} />;
              })}
            </g>
            {graph.nodes.map(n => <GraphNodeView key={n.id} n={n} />)}
          </svg>
        </div>
      )}
    </div>
  );
}

function GraphNodeView({n}: {n: GraphNode}) {
  const c = n.channel;
  const color = tierColor(n);
  const line2 = n.kind === 'org'
    ? `${n.childCount} top-level`
    : `${n.tierLabel} · ${c?.member_count ?? 0} member${c?.member_count === 1 ? '' : 's'}`;
  const flags: string[] = [];
  if (c?.access && c.access !== 'standard') flags.push(c.access.replace(/_/g, ' '));
  if (c?.post_mode && c.post_mode !== 'open') flags.push(POST_MODE_LABEL[c.post_mode] ?? c.post_mode);
  if (c && !c.provisioned) flags.push('not E2E active');
  const line3 = flags.join(' · ');
  const label = fitLabel(n.name, 22);
  return (
    <g transform={`translate(${n.x} ${n.y})`}>
      <title>{n.name}{c ? ` — ${n.tierLabel}, ${c.member_count} members${line3 ? `, ${line3}` : ''}` : ''}</title>
      <rect width={n.w} height={n.h} rx={10} fill="var(--surf-3)" stroke={color}
        strokeWidth={n.kind === 'org' ? 2 : 1.5} strokeDasharray={n.kind === 'lateral' ? '4 3' : undefined} />
      <rect x={0} y={0} width={4} height={n.h} rx={2} fill={color} />
      <text x={14} y={20} fill="var(--tx-1)" fontFamily="'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" fontSize={12} fontWeight={700}>{label}</text>
      <text x={14} y={35} fill="var(--tx-3)" fontFamily="'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" fontSize={9} letterSpacing={0.4}>
        {fitLabel(line2, 30).toUpperCase()}
      </text>
      {line3 && (
        <text x={14} y={49} fill={c && !c.provisioned ? 'var(--warn)' : 'var(--tx-3)'} fontFamily="'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" fontSize={8.5}>
          {fitLabel(line3, 32)}
        </text>
      )}
    </g>
  );
}

/* ── primitives ────────────────────────────────────────────────────── */

function Card({title, action, children}: {title: string; action?: ReactNode; children: ReactNode}) {
  return (
    <div className="card" style={{marginBottom: 12}}>
      <div className="card-header">
        <div className="card-header-title"><span className="bar" />{title}</div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Row({k, v}: {k: string; v: ReactNode}) {
  return (
    <div className="org-row">
      <div className="exec-cap">{k}</div>
      <div style={{fontSize: 12.5, color: 'var(--tx-1)', minWidth: 0, overflowWrap: 'anywhere'}}>{v}</div>
    </div>
  );
}
