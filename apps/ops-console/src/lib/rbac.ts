/**
 * Audit fix 4.2 — role-based UI gating.
 *
 * Backend already enforces @RequireRoles on every mutation, so this
 * module is UX hygiene rather than security: hide the destructive
 * buttons (approve / reject / dispatch / complete / terminate / payout)
 * from OPS-tier admins so they can't try-and-fail. The 403 from the
 * backend would still block them, but flashing red errors makes the
 * console feel broken.
 *
 * Hierarchy: ADMIN > SUPERVISOR > OPS.
 *   - approve / reject / dispatch / complete / terminate / payout → SUPERVISOR or ADMIN
 *   - shortlist (lightest mutation) → OPS, SUPERVISOR, ADMIN
 *   - read-only → any role
 */

/**
 * B-818 (founder, 2026-09-07) — four console admin LEVELS. Mirrors the server's
 * `admin.guard.ts` exactly (rank × domains); `opsGates.test.ts` pins the parity.
 *
 *   SUPER_ADMIN          rank 3 · every domain · accounts + roles
 *   OPERATION_ADMIN      rank 2 · operations   (Lite, Executive, Secure Pro,
 *                                               people, finance, config)
 *   COMMUNICATION_ADMIN  rank 2 · communication (messenger, Enterprise)
 *   RISK_ADMIN           rank 2 · risk          (Safety: VBG, SOS)
 *
 * Legacy ADMIN ≡ SUPER_ADMIN; SUPERVISOR / OPS keep their rank, every domain.
 */
export type AdminRole =
  | 'OPS' | 'SUPERVISOR' | 'ADMIN'
  | 'SUPER_ADMIN' | 'OPERATION_ADMIN' | 'COMMUNICATION_ADMIN' | 'RISK_ADMIN';

export type AdminDomain = 'operations' | 'communication' | 'risk';
export const ALL_DOMAINS: readonly AdminDomain[] = ['operations', 'communication', 'risk'];

export const ADMIN_LEVELS: readonly AdminRole[] = ['SUPER_ADMIN', 'OPERATION_ADMIN', 'COMMUNICATION_ADMIN', 'RISK_ADMIN'];
export const LEGACY_ROLES: readonly AdminRole[] = ['OPS', 'SUPERVISOR', 'ADMIN'];

export const ROLE_LABEL: Record<AdminRole, string> = {
  SUPER_ADMIN: 'Super Admin',
  OPERATION_ADMIN: 'Operation Admin',
  COMMUNICATION_ADMIN: 'Communication Admin',
  RISK_ADMIN: 'Risk Admin',
  ADMIN: 'Admin (legacy super)',
  SUPERVISOR: 'Supervisor (legacy)',
  OPS: 'Ops (legacy)',
};

export const ROLE_SCOPE: Record<AdminRole, string> = {
  SUPER_ADMIN: 'Controls everything — the only level that creates accounts and changes roles.',
  OPERATION_ADMIN: 'Bravo Secure services: Secure Transfer, Executive Protection, Secure Pro, plus people, finance and configuration.',
  COMMUNICATION_ADMIN: 'Messenger and Enterprise workspaces.',
  RISK_ADMIN: 'Safety: VBG monitoring and SOS.',
  ADMIN: 'Legacy — same as Super Admin.',
  SUPERVISOR: 'Legacy — every section at supervisor level, region-scoped.',
  OPS: 'Legacy — read-mostly, region-scoped.',
};

const ROLE_RANK: Record<AdminRole, number> = {
  OPS: 1, SUPERVISOR: 2, ADMIN: 3,
  SUPER_ADMIN: 3, OPERATION_ADMIN: 2, COMMUNICATION_ADMIN: 2, RISK_ADMIN: 2,
};

export function roleRank(role: AdminRole): number {
  return ROLE_RANK[role] ?? 1;
}

export function isSuperAdmin(role: AdminRole | undefined | null): boolean {
  return role === 'ADMIN' || role === 'SUPER_ADMIN';
}

export function roleDomains(role: AdminRole | undefined | null): readonly AdminDomain[] {
  switch (role) {
    case 'OPERATION_ADMIN':     return ['operations'];
    case 'COMMUNICATION_ADMIN': return ['communication'];
    case 'RISK_ADMIN':          return ['risk'];
    default:                    return ALL_DOMAINS;
  }
}

/** Can this role act in the domain? `'any'` is the shared surface; `'platform'` is super-only. */
export function canActInDomain(role: AdminRole | undefined | null, domain: AdminDomain | 'any' | 'platform'): boolean {
  if (!role) return false;
  if (domain === 'any') return true;
  if (domain === 'platform') return isSuperAdmin(role);
  return roleDomains(role).includes(domain);
}

export function hasRole(actual: AdminRole | undefined | null, atLeast: AdminRole): boolean {
  if (!actual) return false;
  return roleRank(actual) >= roleRank(atLeast);
}

export function canApproveBooking(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
export function canRejectBooking(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
export function canDispatchBooking(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
export function canCompleteBooking(role: AdminRole | undefined): boolean {
  // Includes the payout override path.
  return hasRole(role, 'SUPERVISOR');
}
export function canAdjustWallet(role: AdminRole | undefined): boolean {
  // Manual BC grant/deduction — mirrors the backend @RequireRoles on
  // POST /ops/wallets/:userId/adjust.
  return hasRole(role, 'SUPERVISOR');
}
export function canResolveDispute(role: AdminRole | undefined): boolean {
  // Audit RS-15 — resolve a disputed escrow hold. Mirrors the backend
  // @RequireRoles('SUPERVISOR','ADMIN') on POST /ops/disputes/:id/resolve.
  // Previously the Resolve button borrowed canAdjustWallet; its own
  // capability lets the two diverge without a silent gating regression.
  return hasRole(role, 'SUPERVISOR');
}
export function canTerminateAgent(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
export function canDecideAgent(role: AdminRole | undefined): boolean {
  // Approve/reject an agent application.
  return hasRole(role, 'SUPERVISOR');
}
export function canShortlistAgent(role: AdminRole | undefined): boolean {
  // Lightest mutation — kept open to OPS.
  return hasRole(role, 'OPS');
}
export function canRejectApplication(role: AdminRole | undefined): boolean {
  // CA-06 — mirrors the backend @RequireRoles('SUPERVISOR','ADMIN') on
  // POST /ops/applications/:id/reject (the console gated this at OPS).
  return hasRole(role, 'SUPERVISOR');
}
export function canReviewCompliance(role: AdminRole | undefined): boolean {
  // Audit PAGE-18 — verify/reject provider docs. Backend @RequireRoles on
  // POST /ops/compliance/:id/{verify,reject} is SUPERVISOR/ADMIN.
  return hasRole(role, 'SUPERVISOR');
}

// Audit H4 — mission-control gating. Mirrors the backend @RequireRoles on
// the ops mission/SOS endpoints so the live page hides destructive controls
// an OPS-tier admin can't actually use (avoids try-and-fail 403 flashes).
// Backend: abort / route-select and the WHOLE SOS lane (ack / escalate /
// resolve) require SUPERVISOR — see the E2E-18 note on canAckSos below.
export function canAbortMission(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
export function canCompleteMission(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
export function canReroute(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
export function canEscalateSos(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
export function canResolveSos(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
/**
 * E2E-18 — SUPERVISOR+, matching the endpoint.
 *
 * This used to return `hasRole(role, 'OPS')` on the reasoning that speed beats
 * tier for "I see it, responding". The server disagreed: AUTHZ-5 closed
 * `POST /ops/sos/:id/ack` to `@RequireRoles('SUPERVISOR','ADMIN')`
 * (ops.controller.ts:504-508) so the whole SOS lane has one authority level,
 * and this helper was never brought back into step. The drift was not
 * harmless — /live/[id] asked this helper and so SHOWED an OPS operator an ACK
 * button that 403s every time, on the one surface where a failed click costs
 * seconds in an emergency.
 *
 * Fixing the console is the only correct direction here: loosening the server
 * to match the console would widen an emergency-response gate on a UX
 * argument. If OPS-tier ack is wanted, it is a server decision first.
 */
export function canAckSos(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}

// Step 26 — dispatch monitor overrides. Backend @RequireRoles: cancel + force-assign
// require SUPERVISOR; the runtime kill switch requires ADMIN.
export function canCancelDispatch(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
export function canForceAssign(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
export function canFlipKillswitch(role: AdminRole | undefined): boolean {
  return hasRole(role, 'ADMIN');
}

// RS-09 — admin lifecycle (invites + role changes). Backend: the whole
// /ops/admins surface is @RequireRoles('ADMIN') class-wide.
export function canManageAdmins(role: AdminRole | undefined): boolean {
  return hasRole(role, 'ADMIN');
}
/** B-818 — minting an account (id + password) is the super admin's alone. */
export function canCreateAdminAccount(role: AdminRole | undefined): boolean {
  return isSuperAdmin(role);
}

// Issue 28 — mint / deactivate partner referral codes. Mirrors the backend
// @RequireRoles('SUPERVISOR','ADMIN') on POST/PATCH /ops/referral-codes;
// the list stays readable by any admin.
export function canManageReferralCodes(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}

// Bravo Secure Pro applications — create proposal / reject mirror the backend
// @RequireRoles('SUPERVISOR','ADMIN') on POST /ops/pro-applications/:id/*.
// Notes + thread replies stay open to OPS (read/annotate, no decision).
export function canDecideProApplication(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}

/**
 * E2E-44 — edit a Pro application's INTERNAL NOTES. Mirrors the backend
 * `@RequireRoles('SUPERVISOR','ADMIN')` on PUT
 * /ops/pro-applications/:id/internal-notes (OC-13 gated it there because these
 * notes steer how every other operator treats the plan).
 *
 * The console's comment above still says "notes + thread replies stay open to
 * OPS", which is what the UI implemented: an ungated textarea and SAVE NOTES
 * button. An OPS operator therefore typed a note and lost the whole thing to a
 * 403 on save. Its own capability rather than borrowing
 * canDecideProApplication — the two happen to agree today, and the RS-15
 * lesson is that a borrowed gate is how they silently stop agreeing.
 */
export function canEditProInternalNotes(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}

/**
 * IA-06 — resolve a HELD + review_required escrow (MON-2). Mirrors the backend
 * `@RequireRoles('SUPERVISOR','ADMIN')` on POST /ops/bookings/:id/resolve-review.
 * Its own capability rather than borrowing canResolveDispute: the two can
 * diverge without a silent gating regression (the RS-15 lesson).
 */
export function canResolveReviewHold(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}

/**
 * B-812 — mint / revoke a provider's roster invitation code from the console.
 * Mirrors `@RequireRoles('SUPERVISOR','ADMIN')` on POST /ops/users/:id/provider-invites
 * and …/provider-invites/:code/revoke (ops-data.controller.ts).
 */
export function canMintProviderInvite(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}

/**
 * B-836 — see and manage a holder's linked members from the console (add one,
 * add many, set a spend limit, hold, remove). Mirrors
 * `@RequireRoles('SUPERVISOR','ADMIN')` on every `/ops/users/:id/family/*`
 * route (ops-data.controller.ts) — the paged GET included, which is why
 * LinkedMembersCard gates its FETCH on this and not merely its buttons.
 *
 * Its own capability rather than borrowing canMintProviderInvite: the two
 * happen to agree today, and the RS-15 lesson is that a borrowed gate is how
 * they silently stop agreeing.
 */
export function canManageFamily(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}

/**
 * B-854 (A10) — FORCE the "funds their members" switch off while that member's
 * own members still have bookings in flight.
 *
 * Deliberately STRICTER than the route, which is `@RequireRoles('SUPERVISOR',
 * 'ADMIN')` and takes `force` as a body flag it does not gate. Forcing is not
 * another way to do the same thing: it makes every one of those chained
 * bookings fail closed at accept and cancel, hours later, on a client who has
 * already been quoted. The ordinary OFF is refused with a count precisely so a
 * supervisor stops and reads it.
 */
export function canForceFundMembersOff(role: AdminRole | undefined): boolean {
  return hasRole(role, 'ADMIN');
}

/**
 * Enterprise join requests are READ-ONLY in the console today — deciding one
 * grants workspace membership and seeds E2EE scope as that workspace's own
 * manager. Kept as a named capability so the page can ask the question in one
 * place when the product decision lands (audit §11 Q5).
 */
export function canDecideJoinRequest(_role: AdminRole | undefined): boolean {
  return false;
}

/**
 * End or transfer a live protection session. Mirrors the backend
 * `@RequireRoles('SUPERVISOR','ADMIN')` on POST /ops/protection/sessions/:id/{end,transfer}.
 * OC-12 — the protection page hand-rolled this check inline; a second RBAC
 * dialect is how a gate drifts out of step with its endpoint.
 */
export function canEndProtectionSession(role: AdminRole | undefined): boolean {
  return hasRole(role, 'SUPERVISOR');
}
