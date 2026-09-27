'use client';

import {useState, type ReactNode} from 'react';
import Link from 'next/link';
import {useParams, useRouter} from 'next/navigation';
import {Redacted} from '@/components/Redacted';
import {ConfirmReasonModal} from '@/components/ConfirmReasonModal';
import {CopyId} from '@/components/CopyId';
import {ApiError, opsDataApi, resolveUserLocation, useOpsMe, useOpsUserDetail, useUserFamily, type OpsUserDetail} from '@/lib/api';
import {formatDateTimeUtc} from '@/lib/datetime';
import {deviceLabel, roleLabel, since} from '@/lib/format';
import {canForceFundMembersOff, canManageFamily, canManageModules, canMintProviderInvite, hasRole, roleDomains, type AdminRole} from '@/lib/rbac';
import {UserAccessCard} from './UserAccessCard';
import {ProviderInvitesCard} from './ProviderInvitesCard';
import {IdentityDocumentCard} from './IdentityDocumentCard';
import {LinkedMembersCard} from './LinkedMembersCard';
import {routes} from '@/lib/routes';

function holdActive(heldUntil: string | null): boolean {
  return !!heldUntil && new Date(heldUntil).getTime() > Date.now();
}

type DeviceRow = OpsUserDetail['devices'][number];

function deviceStatus(d: DeviceRow): 'ACTIVE' | 'REVOKED' | 'EXPIRED' {
  if (d.revoked_at) return 'REVOKED';
  if (d.expires_at && new Date(d.expires_at).getTime() < Date.now()) return 'EXPIRED';
  return 'ACTIVE';
}

const DEVICE_STATE_CLASS: Record<string, string> = {
  ACTIVE: 'text-ok',
  REVOKED: 'text-err',
  EXPIRED: 'text-t3',
};

const LOCATION_SOURCE_LABEL: Record<'family' | 'agent' | 'vbg', string> = {
  family: 'Member location sharing',
  agent: 'On-duty CPO position',
  vbg: 'VBG monitoring telemetry',
};

/**
 * Why the location is blank, in the user's own terms. A bare dash was the whole
 * problem: it reads as "we failed to load it" when it usually means the user
 * chose not to share, which is a fact ops needs to see rather than retry.
 */
const LOCATION_BLOCKED_COPY: Record<'opted_out' | 'no_source', string> = {
  opted_out: 'This user set Location to “Never” in Settings. Their position is not collected, and ops does not override that.',
  no_source: 'Nothing on record. Position is only stored while a user shares with family, is an on-duty CPO, or is under active VBG monitoring.',
};

function Card({title, right, flush, children}: {title: string; right?: ReactNode; flush?: boolean; children: ReactNode}) {
  return (
    <div className="overflow-hidden rounded-xl border border-bd2">
      <div className="flex items-center justify-between bg-s2 px-4 py-2.5">
        <div className="text-xs font-semibold uppercase tracking-wider text-t3">{title}</div>
        {right}
      </div>
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </div>
  );
}

function Row({label, children}: {label: string; children: ReactNode}) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-2 py-1 text-sm">
      <div className="pt-0.5 text-xs uppercase tracking-wider text-t3">{label}</div>
      <div className="break-all text-t2">{children}</div>
    </div>
  );
}

/**
 * M1A/S9 — inline subscription-tier editor (comp grants / support fixes).
 * Days blank = permanent grant (RS-17); 'lite' also cancels every renewal
 * path server-side so a live card sub can't silently re-upgrade the user.
 */
function TierEditor({user, onChanged}: {user: OpsUserDetail['user']; onChanged: () => void}) {
  // OC-12 — the endpoint is SUPERVISOR/ADMIN; don't render a control that 403s.
  const {data: me} = useOpsMe();
  const canEditTier = hasRole(me?.admin.role as AdminRole | undefined, 'SUPERVISOR');
  const [tier, setTier] = useState<'lite' | 'pro' | 'enterprise'>(
    (['lite', 'pro', 'enterprise'].includes(user.subscription_tier) ? user.subscription_tier : 'lite') as 'lite' | 'pro' | 'enterprise',
  );
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = tier !== user.subscription_tier || days !== '';

  async function apply() {
    setBusy(true); setErr(null);
    try {
      const parsed = days.trim() === '' ? null : Number(days);
      if (parsed !== null && (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650)) {
        setErr('Days must be 1–3650, or blank for a permanent grant.');
        return;
      }
      // OC-03 — a tier change is a comp grant / paid-feature removal; confirm
      // the from→to before it lands (a lite downgrade also kills auto-renew).
      const span = tier === 'lite' ? '' : parsed === null ? ' (permanent grant)' : ` for ${parsed} days`;
      // eslint-disable-next-line no-alert
      if (!window.confirm(`Change ${user.display_name ?? user.id.slice(0, 8)}'s tier: ${user.subscription_tier} → ${tier}${span}?${tier === 'lite' ? ' This also cancels any live auto-renew.' : ''}`)) {
        return;
      }
      await opsDataApi.setUserTier(user.id, {tier, days: parsed});
      setDays('');
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Tier change failed');
    } finally {
      setBusy(false);
    }
  }

  if (!canEditTier) {
    return (
      <span className="text-xs capitalize text-t2">
        {user.subscription_tier}
        <span className="ml-2 text-t3">(SUPERVISOR/ADMIN can change)</span>
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={tier}
        onChange={e => setTier(e.target.value as 'lite' | 'pro' | 'enterprise')}
        disabled={busy}
        className="rounded-md border border-bd1 bg-s2 px-2 py-1 text-xs capitalize text-t2">
        <option value="lite">lite</option>
        <option value="pro">pro</option>
        <option value="enterprise">enterprise</option>
      </select>
      {tier !== 'lite' && (
        <input
          value={days}
          onChange={e => setDays(e.target.value)}
          disabled={busy}
          placeholder="days (blank = permanent)"
          className="w-44 rounded-md border border-bd1 bg-s2 px-2 py-1 text-xs text-t2 placeholder:text-t3"
        />
      )}
      <button
        onClick={() => { void apply(); }}
        disabled={busy || !dirty}
        className="rounded-md border border-act/40 px-3 py-1 text-xs font-semibold text-acc hover:bg-act/10 disabled:opacity-40">
        {busy ? 'APPLYING…' : 'APPLY'}
      </button>
      {user.pro_active_until && (
        <span className="text-xs text-t3">until {formatDateTimeUtc(user.pro_active_until)}</span>
      )}
      {err && <span className="text-xs text-err">{err}</span>}
    </div>
  );
}

/** IA-02 — one person record, reached from Clients or from All Users. */
export function UserDetail() {
  const {id} = useParams<{id: string}>();
  const router = useRouter();
  const {data, isLoading, error, mutate} = useOpsUserDetail(id);
  const {data: me} = useOpsMe();
  // OC-12 — route through the shared rbac module (was a hand-rolled dialect
  // that would drift from any capability change made there).
  const role = me?.admin.role as AdminRole | undefined;
  const canRevoke = hasRole(role, 'SUPERVISOR');
  const canErase = hasRole(role, 'ADMIN');
  // Why: only `member_of` is read here — LinkedMembersCard owns the owner_of
  // side and does its own paged fetch, so this one asks for the smallest page
  // the route allows. The whole route is SUPERVISOR+, so an OPS viewer must not
  // fire it at all (it 403s on every user page otherwise).
  const {data: family} = useUserFamily(canManageFamily(role) ? id : null, {limit: 1});
  const [busyDevice, setBusyDevice] = useState<string | null>(null);
  const [deviceErr, setDeviceErr] = useState<string | null>(null);
  const [acctBusy, setAcctBusy] = useState(false);
  const [acctErr, setAcctErr] = useState<string | null>(null);
  // IS-15 — validated confirm modals replace the window.prompt flows.
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [eraseOpen, setEraseOpen] = useState(false);

  async function revoke(rowId: string) {
    if (busyDevice) return;
    if (!window.confirm('Revoke this session? The device will be signed out and must authenticate again.')) return;
    setBusyDevice(rowId);
    setDeviceErr(null);
    try {
      await opsDataApi.revokeUserDevice(id, rowId);
      await mutate();
    } catch (e) {
      setDeviceErr((e as Error).message);
    } finally {
      setBusyDevice(null);
    }
  }

  async function runAccountAction(fn: () => Promise<unknown>) {
    if (acctBusy) return;
    setAcctBusy(true);
    setAcctErr(null);
    try {
      await fn();
      await mutate();
    } catch (e) {
      setAcctErr((e as Error).message);
    } finally {
      setAcctBusy(false);
    }
  }

  function confirmSuspend(reason: string) {
    setSuspendOpen(false);
    void runAccountAction(() => opsDataApi.suspendUser(id, reason));
  }

  function restore() {
    if (!window.confirm('Lift the suspension and allow this user to sign in again?')) return;
    void runAccountAction(() => opsDataApi.restoreUser(id));
  }

  function confirmErase(reason: string) {
    // Erase keeps its double-confirm: validated reason first, then a final
    // irreversible-action gate.
    if (!window.confirm('This cannot be undone. Erase this user now?')) return;
    setEraseOpen(false);
    void runAccountAction(() => opsDataApi.eraseUser(id, reason));
  }

  if (isLoading) {
    return <><p className="p-6 text-sm text-t3">Loading…</p></>;
  }
  if (error || !data) {
    const msg = error instanceof ApiError && error.status === 403
      ? 'Requires SUPERVISOR or ADMIN role.'
      : ((error as Error | undefined)?.message ?? 'User not found.');
    return <><p className="p-6 text-sm text-err">{msg}</p></>;
  }

  const {user, devices, balance, bookings, agent} = data;
  // Never `data.location` directly — see resolveUserLocation: the field is
  // absent against an auth-service that predates B-794.
  const location = resolveUserLocation(data.location);

  // B-794 — "which device is he using". The list is already ordered by
  // last_used_at DESC, so the first LIVE row is the current one; if none is
  // live the freshest row is the last one they used. Both are real answers and
  // the card says which of the two it is showing.
  const liveDevice = devices.find(d => d.is_live && !d.revoked_at);
  const currentDevice = liveDevice ?? devices.find(d => !d.revoked_at) ?? devices[0] ?? null;
  const lastActiveAt = devices.reduce<string | null>((best, d) => {
    if (!d.last_used_at) return best;
    return !best || new Date(d.last_used_at) > new Date(best) ? d.last_used_at : best;
  }, null);
  const firstSeenAt = devices.reduce<string | null>((best, d) => (
    !best || new Date(d.created_at) < new Date(best) ? d.created_at : best
  ), null);

  return (
    <>
      <div className="space-y-6 p-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-bold text-t1">
              {user.display_name ?? user.id.slice(0, 8)}
              {user.deleted_at && (
                <span className="ml-2 rounded bg-err/10 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase text-err">
                  deleted {formatDateTimeUtc(user.deleted_at)}
                </span>
              )}
              {!user.deleted_at && user.suspended_at && (
                <span className="ml-2 rounded bg-warn/10 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase text-warn">
                  suspended {formatDateTimeUtc(user.suspended_at)}
                </span>
              )}
            </h1>
            <p className="text-sm text-t3">User record, wallet, sessions and recent bookings.</p>
          </div>
          <div className="flex items-center gap-2">
            {canRevoke && !user.deleted_at && (
              user.suspended_at ? (
                <button onClick={restore} disabled={acctBusy}
                  className="rounded-md border border-ok/40 px-3 py-1.5 text-xs font-semibold text-ok hover:bg-ok/10 disabled:opacity-50">
                  RESTORE
                </button>
              ) : (
                <button onClick={() => setSuspendOpen(true)} disabled={acctBusy}
                  className="rounded-md border border-warn/40 px-3 py-1.5 text-xs font-semibold text-warn hover:bg-warn/10 disabled:opacity-50">
                  SUSPEND
                </button>
              )
            )}
            {canErase && !user.deleted_at && (
              <button onClick={() => setEraseOpen(true)} disabled={acctBusy}
                className="rounded-md border border-err/40 px-3 py-1.5 text-xs font-semibold text-err hover:bg-err/10 disabled:opacity-50">
                ERASE
              </button>
            )}
            <Link href={routes.people.users} className="rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-s1">
              ← BACK
            </Link>
          </div>
        </div>
        {acctErr && <p className="text-sm text-err">{acctErr}</p>}
        {user.suspended_at && user.suspended_reason && (
          <div className="rounded-lg border border-warn/30 bg-warn/5 px-4 py-2 text-sm text-warn">
            Suspended: {user.suspended_reason}
          </div>
        )}

        <Card title="Profile">
          <Row label="Display Name">{user.display_name ?? '—'}</Row>
          <Row label="Role"><span className="capitalize">{roleLabel(user.role)}</span></Row>
          <Row label="Messenger tier"><TierEditor user={user} onChanged={() => { void mutate(); }} /></Row>
          <Row label="KYC"><span className="capitalize">{user.kyc_status}</span></Row>
          <Row label="Region">{user.home_region ?? user.country_code ?? '—'}</Row>
          <Row label="Lang / Currency">{user.language ?? '—'} / {user.currency ?? '—'}</Row>
          <Row label="Phone"><Redacted value={user.phone_e164} kind="phone" subject={user.id} /></Row>
          <Row label="Email"><Redacted value={user.email} kind="email" subject={user.id} /></Row>
          <Row label="Created">{formatDateTimeUtc(user.created_at)}</Row>
          <Row label="ID"><span className="font-mono text-xs text-t3">{user.id}<CopyId value={user.id} title="Copy user id" /></span></Row>
        </Card>

        {/* B-867 — the ID / passport an individual submitted; images behind an audited click. */}
        <IdentityDocumentCard
          userId={user.id}
          role={user.role}
          rawFacts={data.identity_document}
          canReveal={hasRole(role, 'SUPERVISOR') && roleDomains(role).includes('operations')}
          Card={Card}
        />

        {/* 2026-09-27 — invite state + per-user module overrides (rank 3). */}
        {!user.deleted_at && <UserAccessCard userId={user.id} enabled={canManageModules(role)} Card={Card} />}

        {/* B-812 — renders only for a service-provider (company) account. */}
        <ProviderInvitesCard userId={user.id} canMint={canMintProviderInvite(role)} Card={Card} />

        <Card title="Wallet">
          <Row label="Balance">
            {balance ? `${balance.bravo_credits.toLocaleString()} BC` : '—'}
          </Row>
          <Row label="Updated">{balance ? formatDateTimeUtc(balance.updated_at) : '—'}</Row>
          <p className="mt-2 text-xs text-t3">
            Balance changes go through <Link href={routes.finance.root} className="text-acc hover:underline">adjust via Finance</Link>.
          </p>
        </Card>

        <Card
          title="Device, location & activity"
          right={<span className="text-xs text-t3">{liveDevice ? 'SIGNED IN' : 'NO LIVE SESSION'}</span>}>
          <Row label="Current device">
            {currentDevice ? (
              <>
                <span className="text-t1">{deviceLabel(currentDevice)}</span>
                {!liveDevice && <span className="ml-2 text-xs text-t3">(last used — no live session right now)</span>}
                <div className="mt-0.5 text-xs text-t3">
                  {[
                    currentDevice.platform === 'ios' ? 'iOS' : currentDevice.platform === 'android' ? 'Android' : 'Web',
                    currentDevice.os_version ? `OS ${currentDevice.os_version}` : null,
                    currentDevice.app_version ? `app v${currentDevice.app_version}` : null,
                  ].filter(Boolean).join(' · ')}
                </div>
                {!currentDevice.device_model && currentDevice.platform !== 'web' && (
                  <div className="mt-0.5 text-xs text-t3">
                    Model not reported — the session predates device capture, or it is an iOS build.
                  </div>
                )}
              </>
            ) : (
              <span className="text-t3">Never signed in on any device.</span>
            )}
          </Row>

          <Row label="Last known location">
            {'blocked' in location ? (
              <span className="text-t3">{LOCATION_BLOCKED_COPY[location.blocked]}</span>
            ) : (
              <>
                <span className="text-t1">
                  <Redacted
                    value={location.label ?? `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`}
                    kind="address"
                    subject={user.id}
                  />
                </span>
                <div className="mt-0.5 text-xs text-t3">
                  {[
                    LOCATION_SOURCE_LABEL[location.source],
                    `${since(location.recorded_at)} · ${formatDateTimeUtc(location.recorded_at)}`,
                    location.accuracy_m != null ? `±${Math.round(location.accuracy_m)} m` : null,
                  ].filter(Boolean).join(' · ')}
                </div>
                {location.label && (
                  <div className="mt-0.5 font-mono text-xs text-t3">
                    <Redacted
                      value={`${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`}
                      kind="address"
                      subject={user.id}
                    />
                  </div>
                )}
              </>
            )}
          </Row>

          <Row label="Activity">
            <span className="text-t1">
              {lastActiveAt ? `Last active ${since(lastActiveAt)}` : 'No session activity on record'}
            </span>
            <div className="mt-0.5 text-xs text-t3">
              {[
                firstSeenAt ? `first signed in ${formatDateTimeUtc(firstSeenAt)}` : null,
                `${devices.filter(d => !d.revoked_at).length} of ${devices.length} session${devices.length === 1 ? '' : 's'} still valid`,
              ].filter(Boolean).join(' · ')}
            </div>
            {/* Say what this number is NOT. "Last active" is the last time a
                token was issued or refreshed, which tracks app opens — it is
                not time spent in the app, and nothing measures that today. */}
            <div className="mt-0.5 text-xs text-t3">
              Derived from session refreshes (app opens). Time spent in the app is not measured.
            </div>
          </Row>
        </Card>

        <Card title="Devices / Sessions" right={<span className="text-xs text-t3">{devices.length}</span>} flush>
          {deviceErr && <p className="px-4 pt-3 text-sm text-err">{deviceErr}</p>}
          {devices.length === 0 ? (
            <p className="p-4 text-sm text-t3">No sessions on record.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-s2 text-left text-xs uppercase text-t3">
                <tr>
                  <th className="px-3 py-2">Device</th><th className="px-3 py-2">OS / App</th>
                  <th className="px-3 py-2">Signal</th><th className="px-3 py-2">Last Used</th>
                  <th className="px-3 py-2">Expires</th><th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-bd2">
                {devices.map(d => {
                  const state = deviceStatus(d);
                  return (
                    <tr key={d.id} className="text-t2">
                      <td className="px-3 py-2" title={`install id ${d.device_id}`}>
                        {deviceLabel(d)}
                        {d.id === currentDevice?.id && (
                          <span className="ml-2 rounded bg-act/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-acc">
                            {liveDevice ? 'current' : 'most recent'}
                          </span>
                        )}
                        <div className="font-mono text-[10px] text-t3">
                          {d.device_id.length > 12 ? `${d.device_id.slice(0, 12)}…` : d.device_id}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs text-t3">
                        {[d.os_version, d.app_version ? `v${d.app_version}` : null].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-t3">{d.signal_device_id ?? '—'}</td>
                      {/* Relative reads faster, but this is an audit surface —
                          the absolute UTC stamp stays on the row, not in a
                          tooltip. */}
                      <td className="px-3 py-2 text-t3">
                        {since(d.last_used_at)}
                        <div className="text-[10px]">{formatDateTimeUtc(d.last_used_at)}</div>
                      </td>
                      <td className="px-3 py-2 text-t3">{formatDateTimeUtc(d.expires_at)}</td>
                      <td className={`px-3 py-2 font-semibold ${DEVICE_STATE_CLASS[state]}`}>{state}</td>
                      <td className="px-3 py-2 text-right">
                        {canRevoke && state === 'ACTIVE' && (
                          <button
                            onClick={() => revoke(d.id)}
                            disabled={busyDevice === d.id}
                            className="rounded-md border border-err/40 px-2 py-1 text-[10px] font-semibold text-err hover:bg-err/10 disabled:opacity-50">
                            {busyDevice === d.id ? 'REVOKING…' : 'REVOKE'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Recent Bookings" right={<span className="text-xs text-t3">{bookings.length}</span>} flush>
          {bookings.length === 0 ? (
            <p className="p-4 text-sm text-t3">No bookings on record.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-s2 text-left text-xs uppercase text-t3">
                <tr>
                  <th className="px-3 py-2">Status</th><th className="px-3 py-2">Service</th>
                  <th className="px-3 py-2">Region</th><th className="px-3 py-2">Pickup</th>
                  <th className="px-3 py-2">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-bd2">
                {bookings.map(b => (
                  <tr
                    key={b.id}
                    onClick={() => router.push(routes.lite.booking(b.id))}
                    className="cursor-pointer text-t2 hover:bg-s1">
                    <td className="px-3 py-2 uppercase text-t3">{b.status.replace(/_/g, ' ')}</td>
                    <td className="px-3 py-2 capitalize">{b.service.replace(/_/g, ' ')}</td>
                    <td className="px-3 py-2 text-t3">{b.region_code}</td>
                    <td className="px-3 py-2 text-t3">{formatDateTimeUtc(b.pickup_time)}</td>
                    <td className="px-3 py-2 font-mono text-xs">{parseFloat(b.total_eur).toLocaleString()} BC</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {/* B-836 — the roster this user OWNS: searchable, paged, and mutable.
            Rendered whatever the row count, because "add the first member" was
            the one thing the old non-empty gate made impossible. */}
        <LinkedMembersCard
          userId={user.id}
          canManage={canManageFamily(role)}
          canForce={canForceFundMembersOff(role)}
          Card={Card} />

        {/* SK-07/IS-03 — the other direction: whose plan this user rides. */}
        {family && family.member_of.length > 0 && (
          <Card
            title={family.member_of.length > 1 ? `Member of · ${family.member_of.length}` : 'Member of'}
            right={<span className="text-xs text-t3">{family.member_of.length}</span>}>
            {family.member_of.map(m => (
              <div key={m.id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
                <span className="text-xs text-t3">Member of</span>
                <Link href={routes.people.user(m.holder_id)} className="font-semibold text-t1 hover:underline">
                  {m.holder_name ?? m.holder_email ?? m.holder_id.slice(0, 8)}
                </Link>
                <span className={`text-xs uppercase ${m.status === 'active' ? 'text-ok' : 'text-warn'}`}>{m.status}</span>
                {holdActive(m.held_until) && (
                  <span className="rounded bg-warn/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-warn">
                    on hold until {formatDateTimeUtc(m.held_until!)}
                  </span>
                )}
                <span className="ml-auto font-mono text-xs text-t3">
                  {m.spent_credits.toLocaleString()}{m.spend_limit_credits != null ? ` / ${m.spend_limit_credits.toLocaleString()}` : ''} BC spent
                </span>
              </div>
            ))}
          </Card>
        )}

        {agent && (
          <Card
            title="Agent Record"
            right={
              <Link href={routes.people.agent(agent.user_id)} className="text-xs font-semibold text-acc hover:underline">
                VIEW AGENT →
              </Link>
            }>
            <Row label="Call Sign">{agent.call_sign ?? '—'}</Row>
            <Row label="Type"><span className="uppercase">{agent.type}</span></Row>
            <Row label="Status"><span className="uppercase">{agent.status.replace(/_/g, ' ')}</span></Row>
            <Row label="On Duty">{agent.on_duty ? <span className="text-ok">YES</span> : 'NO'}</Row>
          </Card>
        )}
      </div>

      <ConfirmReasonModal
        open={suspendOpen}
        title="Suspend this account?"
        description="Locks login and signs out every device immediately. Reversible via RESTORE."
        reasonLabel="Suspend reason"
        reasonPlaceholder="e.g. Chargeback investigation; abusive conduct report…"
        confirmLabel="SUSPEND ACCOUNT"
        danger
        busy={acctBusy}
        onConfirm={confirmSuspend}
        onCancel={() => setSuspendOpen(false)}
      />
      <ConfirmReasonModal
        open={eraseOpen}
        title="Irreversible erasure"
        description="Scrubs name / email / phone / avatar and permanently blocks login. Booking and wallet history is retained for audit. This cannot be undone."
        reasonLabel="Erasure reason"
        reasonPlaceholder="e.g. GDPR erasure request ref #…"
        confirmLabel="ERASE USER"
        danger
        busy={acctBusy}
        onConfirm={confirmErase}
        onCancel={() => setEraseOpen(false)}
      />
    </>
  );
}
