/**
 * Account responsibilities (owner, 2026-10-23): "if a user is deleted, all the
 * linked account responsibilities should be deleted. Before deletion it should
 * notify the user that all the user responsibilities will be deleted and
 * cannot be restored."
 *
 * One phone number = one account, and one account can hold several roles at
 * once: console admin, CPO, service provider (its company IS the account),
 * enterprise workspace owner, family plan holder or member. Deleting the
 * account removes every one of them. Owner decisions:
 *   - payments, bookings, missions and audit history are KEPT, anonymised —
 *     they are business records, not responsibilities;
 *   - a deleted provider's CPOs keep their own accounts and are unlinked
 *     (removed from the roster, no managing provider; ops can reassign them).
 *
 * ONE table drives both the warning the console shows (counts, `preview`) and
 * the removal (`release`), so the dialog can never promise less — or more —
 * than the delete does. Every statement takes the account id as $1 only.
 */

export type ResponsibilityGroup = 'role' | 'responsibility' | 'data';

export interface ResponsibilityStep {
  key: string;
  group: ResponsibilityGroup;
  /** Plain-language line for the confirm dialog, given the count. */
  label: (n: number) => string;
  /** SELECT returning one row `{n}` — how much of this the account holds. */
  count: string;
  /** Statements that remove it (run in order, inside the erase transaction). */
  release: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Missions still running — the crew and the provider must finish or hand over first. */
export const ACTIVE_MISSION_STATUSES = `('CREWED','DISPATCHED','PICKUP','LIVE','SOS')`;

export const RESPONSIBILITY_STEPS: readonly ResponsibilityStep[] = [
  // ── Roles ──────────────────────────────────────────────────────────────
  {
    key: 'admin', group: 'role',
    label: () => 'Ops console admin access',
    count: `SELECT COUNT(*)::int AS n FROM public.admin_users WHERE user_id = $1 AND active`,
    // The row stays inactive for the audit trail (ops_audit names the call
    // sign); its console phone copy is freed so the number can be reused.
    release: [`UPDATE public.admin_users SET active = FALSE, phone_e164 = NULL WHERE user_id = $1`],
  },
  {
    key: 'cpo', group: 'role',
    label: () => 'CPO / officer profile (off duty, removed from dispatch)',
    count: `SELECT COUNT(*)::int AS n FROM public.agents WHERE user_id = $1 AND type IN ('cpo','transport') AND status <> 'REJECTED'`,
    release: [],   // shared agents-row release under 'provider' below
  },
  {
    key: 'provider', group: 'role',
    label: () => 'Service provider company',
    count: `SELECT COUNT(*)::int AS n FROM public.agents WHERE user_id = $1 AND type = 'company' AND status <> 'REJECTED'`,
    // The agents row stays (missions and offers reference it) but is closed:
    // REJECTED is the terminal status ops "terminate" already uses.
    release: [
      `UPDATE public.agents
          SET status = 'REJECTED', on_duty = FALSE, managed_by_org_id = NULL, cooldown_until = NULL,
              last_lat = NULL, last_lng = NULL, last_location = NULL, last_location_at = NULL
        WHERE user_id = $1`,
    ],
  },
  {
    key: 'workspace', group: 'role',
    label: () => 'Enterprise workspace (owner)',
    count: `SELECT COUNT(*)::int AS n FROM public.org_workspaces WHERE owner_user_id = $1`,
    release: [
      `DELETE FROM public.org_workspace_settings WHERE org_user_id = $1`,
      `DELETE FROM public.org_workspaces WHERE owner_user_id = $1`,
    ],
  },
  // ── Responsibilities towards other people ──────────────────────────────
  {
    key: 'roster', group: 'responsibility',
    label: n => `${plural(n, 'person', 'people')} on its roster or team unlinked (their own accounts stay)`,
    count: `SELECT COUNT(*)::int AS n FROM public.org_members WHERE org_user_id = $1 AND member_user_id <> $1`,
    release: [
      `DELETE FROM public.org_members WHERE org_user_id = $1`,
      `UPDATE public.agents SET managed_by_org_id = NULL WHERE managed_by_org_id = $1 AND user_id <> $1`,
    ],
  },
  {
    key: 'memberships', group: 'responsibility',
    label: n => `Membership of ${plural(n, 'organisation')} (CPO, manager or employee)`,
    count: `SELECT COUNT(*)::int AS n FROM public.org_members WHERE member_user_id = $1 AND org_user_id <> $1`,
    release: [`DELETE FROM public.org_members WHERE member_user_id = $1`],
  },
  {
    key: 'channels_owned', group: 'responsibility',
    label: n => `${plural(n, 'department channel')} it runs archived`,
    count: `SELECT COUNT(*)::int AS n FROM public.department_channels WHERE org_id = $1 AND archived_at IS NULL`,
    release: [`UPDATE public.department_channels SET archived_at = NOW() WHERE org_id = $1 AND archived_at IS NULL`],
  },
  {
    key: 'channels', group: 'responsibility',
    label: n => `Removed from ${plural(n, 'channel or group chat', 'channels and group chats')}`,
    count: `SELECT ((SELECT COUNT(*) FROM public.department_channel_members WHERE user_id = $1)
                  + (SELECT COUNT(*) FROM public.conversation_members WHERE user_id = $1))::int AS n`,
    release: [
      `DELETE FROM public.department_channel_members WHERE user_id = $1`,
      `DELETE FROM public.channel_membership_intents WHERE member_user_id = $1`,
      `DELETE FROM public.conversation_membership_intents WHERE member_user_id = $1`,
      `DELETE FROM public.dispatch_room_intents WHERE member_user_id = $1 OR org_user_id = $1`,
      `DELETE FROM public.conversation_members WHERE user_id = $1`,
    ],
  },
  {
    key: 'invites', group: 'responsibility',
    label: n => `${plural(n, 'open invitation or referral code')} revoked`,
    count: `SELECT ((SELECT COUNT(*) FROM public.provider_invite_codes
                      WHERE org_user_id = $1 AND redeemed_at IS NULL AND revoked_at IS NULL)
                  + (SELECT COUNT(*) FROM public.enterprise_referral_links
                      WHERE org_user_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL)
                  + (SELECT COUNT(*) FROM public.provider_referral_codes WHERE owner_user_id = $1 AND active)
                  + (SELECT COUNT(*) FROM public.enterprise_join_requests
                      WHERE (org_user_id = $1 OR applicant_user_id = $1) AND status = 'pending'))::int AS n`,
    release: [
      `UPDATE public.provider_invite_codes SET revoked_at = NOW()
        WHERE org_user_id = $1 AND redeemed_at IS NULL AND revoked_at IS NULL`,
      `UPDATE public.enterprise_referral_links SET revoked_at = NOW()
        WHERE org_user_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
      `UPDATE public.provider_referral_codes SET active = FALSE WHERE owner_user_id = $1 AND active`,
      `UPDATE public.enterprise_join_requests SET status = 'declined', decided_at = NOW()
        WHERE (org_user_id = $1 OR applicant_user_id = $1) AND status = 'pending'`,
    ],
  },
  {
    key: 'vehicles', group: 'responsibility',
    label: n => `${plural(n, 'fleet vehicle')} taken out of service`,
    count: `SELECT COUNT(*)::int AS n FROM public.org_vehicles WHERE org_user_id = $1 AND active`,
    // Deactivated, not deleted: mission_org_vehicles (history) cascades from it.
    release: [`UPDATE public.org_vehicles SET active = FALSE, updated_at = NOW() WHERE org_user_id = $1 AND active`],
  },
  {
    key: 'areas', group: 'responsibility',
    label: n => `${plural(n, 'dispatch area')} it covers`,
    count: `SELECT COUNT(*)::int AS n FROM public.area_provider_assignments WHERE provider_user_id = $1`,
    release: [`DELETE FROM public.area_provider_assignments WHERE provider_user_id = $1`],
  },
  {
    key: 'shifts', group: 'responsibility',
    label: n => `${plural(n, 'upcoming shift')} cancelled or left`,
    count: `SELECT ((SELECT COUNT(*) FROM public.cpo_shifts
                      WHERE org_user_id = $1 AND archived_at IS NULL AND start_at > NOW())
                  + (SELECT COUNT(*) FROM public.cpo_shift_assignments a JOIN public.cpo_shifts s ON s.id = a.shift_id
                      WHERE a.cpo_user_id = $1 AND s.start_at > NOW()))::int AS n`,
    release: [
      `UPDATE public.cpo_shifts SET archived_at = NOW() WHERE org_user_id = $1 AND archived_at IS NULL AND start_at > NOW()`,
      `DELETE FROM public.cpo_shift_assignments a USING public.cpo_shifts s
        WHERE s.id = a.shift_id AND a.cpo_user_id = $1 AND s.start_at > NOW()`,
    ],
  },
  {
    key: 'offers', group: 'responsibility',
    label: n => `${plural(n, 'open dispatch offer')} withdrawn`,
    count: `SELECT COUNT(*)::int AS n FROM public.dispatch_offers WHERE provider_user_id = $1 AND status = 'OFFERED'`,
    release: [
      `UPDATE public.dispatch_offers SET status = 'CANCELLED', responded_at = NOW(), reject_reason = 'provider_account_deleted'
        WHERE provider_user_id = $1 AND status = 'OFFERED'`,
    ],
  },
  {
    key: 'incidents', group: 'responsibility',
    label: n => `${plural(n, 'open incident')} assigned to it left unassigned`,
    count: `SELECT COUNT(*)::int AS n FROM public.incident_reports WHERE assigned_to = $1 AND status NOT IN ('resolved','closed')`,
    release: [`UPDATE public.incident_reports SET assigned_to = NULL, updated_at = NOW() WHERE assigned_to = $1 AND status NOT IN ('resolved','closed')`],
  },
  {
    key: 'family', group: 'responsibility',
    label: n => `${plural(n, 'family plan link')} ended`,
    count: `SELECT COUNT(*)::int AS n FROM public.family_members WHERE (holder_id = $1 OR member_id = $1) AND status <> 'revoked'`,
    // Revoked, not deleted: the funding requests and quota audit cascade from it.
    release: [`UPDATE public.family_members SET status = 'revoked' WHERE (holder_id = $1 OR member_id = $1) AND status <> 'revoked'`],
  },
  {
    key: 'subscription', group: 'responsibility',
    label: () => 'Pro / credits auto-renewal stopped',
    count: `SELECT COUNT(*)::int AS n FROM public.users
             WHERE id = $1 AND (bc_auto_renew OR (pro_renew_status IS NOT NULL AND pro_renew_status <> 'canceled'))`,
    release: [`UPDATE public.users SET bc_auto_renew = FALSE, pro_renew_status = CASE WHEN pro_renew_status IS NULL THEN NULL ELSE 'canceled' END WHERE id = $1`],
  },
  // ── Personal data that goes with the account ───────────────────────────
  {
    key: 'documents', group: 'data',
    label: n => `${plural(n, 'uploaded document')} and ID scans deleted`,
    count: `SELECT ((SELECT COUNT(*) FROM public.agent_documents WHERE user_id = $1 AND file_url IS NOT NULL)
                  + (SELECT COUNT(*) FROM public.agent_kyc_checks WHERE user_id = $1 AND file_url IS NOT NULL)
                  + (SELECT COUNT(*) FROM public.identity_documents WHERE user_id = $1))::int AS n`,
    release: [
      `DELETE FROM public.agent_documents WHERE user_id = $1`,
      `UPDATE public.agent_kyc_checks SET file_url = NULL, file_hash_sha256 = NULL, subject = NULL, metadata = '{}'::jsonb WHERE user_id = $1`,
      `DELETE FROM public.identity_documents WHERE user_id = $1`,
      `DELETE FROM public.identity_document_versions WHERE user_id = $1`,
    ],
  },
  {
    key: 'messenger', group: 'data',
    label: () => 'Messenger keys, encrypted backups and file vault deleted',
    count: `SELECT ((SELECT COUNT(*) FROM public.signal_identities WHERE user_id = $1)
                  + (SELECT COUNT(*) FROM public.identity_backups WHERE user_id = $1)
                  + (SELECT COUNT(*) FROM public.conversation_backups WHERE owner_user_id = $1)
                  + (SELECT COUNT(*) FROM public.vault_index_blobs WHERE user_id = $1))::int AS n`,
    release: [
      `DELETE FROM public.signal_one_time_prekeys WHERE user_id = $1`,
      `DELETE FROM public.signal_identities WHERE user_id = $1`,
      `DELETE FROM public.sealed_envelope_archive WHERE recipient_user_id = $1`,
      `DELETE FROM public.messages_backup WHERE owner_user_id = $1`,
      `DELETE FROM public.conversation_backups WHERE owner_user_id = $1`,
      `DELETE FROM public.backup_session_snapshots WHERE user_id = $1`,
      `DELETE FROM public.backup_merkle_commits WHERE user_id = $1`,
      `DELETE FROM public.identity_backups WHERE user_id = $1`,
      `DELETE FROM public.vault_index_blobs WHERE user_id = $1`,
      `DELETE FROM public.vault_pins WHERE user_id = $1`,
    ],
  },
  {
    key: 'safety', group: 'data',
    label: () => 'Safety monitoring, geofences and saved places deleted',
    count: `SELECT ((SELECT COUNT(*) FROM public.vbg_monitoring WHERE user_id = $1)
                  + (SELECT COUNT(*) FROM public.vbg_geofences WHERE user_id = $1)
                  + (SELECT COUNT(*) FROM public.vbg_favorites WHERE user_id = $1))::int AS n`,
    release: [
      `DELETE FROM public.vbg_monitoring WHERE user_id = $1`,
      `DELETE FROM public.vbg_geofences WHERE user_id = $1`,
      `DELETE FROM public.vbg_favorites WHERE user_id = $1`,
      `DELETE FROM public.vbg_device_keys WHERE user_id = $1`,
      `DELETE FROM public.vbg_telemetry_last WHERE user_id = $1`,
      `DELETE FROM public.vbg_sra_snapshots WHERE user_id = $1`,
      `DELETE FROM public.family_member_locations WHERE user_id = $1`,
    ],
  },
  {
    key: 'signin', group: 'data',
    label: () => 'Sign-in secrets, blocks and per-user settings deleted',
    count: `SELECT 1 AS n`,
    release: [
      `DELETE FROM public.auth_totp_secrets WHERE user_id = $1`,
      `DELETE FROM public.auth_totp_backup_codes WHERE user_id = $1`,
      `DELETE FROM public.auth_otps WHERE user_id = $1`,
      `DELETE FROM public.blocked_users WHERE blocker_user_id = $1 OR blocked_user_id = $1`,
      `DELETE FROM public.user_module_overrides WHERE user_id = $1`,
      `UPDATE public.users SET role = 'individual' WHERE id = $1`,
    ],
  },
];

/** Records that STAY (anonymised) — shown so nobody expects them gone. */
export const KEPT_RECORDS: ReadonlyArray<{key: string; label: (n: number) => string; count: string}> = [
  {key: 'bookings', label: n => plural(n, 'booking'),
    count: `SELECT COUNT(*)::int AS n FROM public.lite_bookings WHERE client_id = $1 OR payer_user_id = $1 OR payer_via_user_id = $1`},
  {key: 'payments', label: n => plural(n, 'payment record'),
    count: `SELECT COUNT(*)::int AS n FROM public.wallet_transactions WHERE user_id = $1`},
  {key: 'missions', label: n => plural(n, 'mission'),
    count: `SELECT COUNT(*)::int AS n FROM public.mission_crew WHERE agent_id = $1`},
  {key: 'payouts', label: n => plural(n, 'payout'),
    count: `SELECT COUNT(*)::int AS n FROM public.mission_payouts WHERE payee_user_id = $1`},
];

/** Live work that must be finished or handed over before the account can go. */
export const BLOCKERS: ReadonlyArray<{key: string; label: (n: number) => string; count: string}> = [
  {key: 'crew_on_active_mission', label: n => `On the crew of ${plural(n, 'mission')} in progress — finish it or replace them first`,
    count: `SELECT COUNT(*)::int AS n FROM public.mission_crew c JOIN public.missions m ON m.id = c.mission_id
             WHERE c.agent_id = $1 AND m.status IN ${ACTIVE_MISSION_STATUSES}`},
  {key: 'provider_active_mission', label: n => `Service provider of ${plural(n, 'mission')} in progress — finish or reassign first`,
    count: `SELECT COUNT(DISTINCT m.id)::int AS n
              FROM public.dispatch_offers o JOIN public.missions m ON m.booking_id = o.booking_id
             WHERE o.provider_user_id = $1 AND o.status = 'ACCEPTED' AND m.status IN ${ACTIVE_MISSION_STATUSES}`},
];

export interface DeletionPreviewItem {key: string; group: ResponsibilityGroup; label: string; count: number}
export interface DeletionPreview {
  user: {id: string; display_name: string; deleted: boolean};
  roles: DeletionPreviewItem[];
  responsibilities: DeletionPreviewItem[];
  data: DeletionPreviewItem[];
  kept: Array<{key: string; label: string; count: number}>;
  blockers: Array<{key: string; label: string; count: number}>;
  wallet_credits: number;
  devices: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Q = (sql: string, params: unknown[]) => Promise<any[]>;

async function countOf(q: Q, sql: string, userId: string): Promise<number> {
  const rows = await q(sql, [userId]) as Array<{n: number | string}>;
  return Number(rows[0]?.n ?? 0);
}

/** What deleting this account would remove, keep and be blocked by. */
export async function previewResponsibilities(q: Q, userId: string, user: {display_name: string; deleted: boolean}): Promise<DeletionPreview> {
  const steps = await Promise.all(RESPONSIBILITY_STEPS.filter(s => s.key !== 'signin').map(async s => ({
    key: s.key, group: s.group, n: await countOf(q, s.count, userId), s,
  })));
  const items = steps.filter(x => x.n > 0).map(x => ({key: x.key, group: x.group, label: x.s.label(x.n), count: x.n}));
  const [kept, blockers, wallet, devices] = await Promise.all([
    Promise.all(KEPT_RECORDS.map(async k => ({key: k.key, n: await countOf(q, k.count, userId), k}))),
    Promise.all(BLOCKERS.map(async b => ({key: b.key, n: await countOf(q, b.count, userId), b}))),
    q(`SELECT bravo_credits AS c FROM public.wallet_balances WHERE user_id = $1`, [userId]) as Promise<Array<{c: number | null}>>,
    countOf(q, `SELECT COUNT(*)::int AS n FROM public.auth_devices WHERE user_id = $1 AND revoked_at IS NULL`, userId),
  ]);
  return {
    user: {id: userId, ...user},
    roles: items.filter(i => i.group === 'role'),
    responsibilities: items.filter(i => i.group === 'responsibility'),
    data: items.filter(i => i.group === 'data'),
    kept: kept.filter(k => k.n > 0).map(k => ({key: k.key, label: k.k.label(k.n), count: k.n})),
    blockers: blockers.filter(b => b.n > 0).map(b => ({key: b.key, label: b.b.label(b.n), count: b.n})),
    wallet_credits: Number(wallet[0]?.c ?? 0),
    devices,
  };
}

/** Run every release statement (inside the caller's transaction). */
export async function releaseResponsibilities(q: Q, userId: string): Promise<void> {
  for (const s of RESPONSIBILITY_STEPS) {
    for (const sql of s.release) {await q(sql, [userId]);}
  }
}
