import type {ActiveWorkspace} from './activeWorkspace';

/**
 * B-848 — WHICH organisation the Departmental surface is entered as, decided
 * ONCE from the affiliation list the server already ships.
 *
 * ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────────
 *
 * A null workspace context used to mean "every organisation": both scoping
 * belts (`activeWorkspaceOrgParam`, `scopeChannelsToActiveWorkspace`) are
 * fail-open, and `GET /department/channels` with no `orgId` answers every org
 * the caller holds a membership row in. Only a Workspace Hub tile ever set a
 * context, so a cold boot, a drawer tap, a CPO tab or a notification landed on
 * the Channels directory with several companies' channels in one list — the
 * client's "not all organization must show when I open 1 organization".
 *
 * These four predicates are the whole client-side answer, and they are PURE so
 * they can be pinned by the persona table (plan §10 A6) rather than by mounting
 * a screen. Nothing here reads a store: callers pass the user and the current
 * context in, so the same rule serves `authStore.applyMe`, the picker gate, the
 * wake lanes and the hub.
 *
 * ── WHY A SEPARATE FILE ──────────────────────────────────────────────────
 *
 * `activeWorkspace.ts` is imported by `services/api`, so anything it imports is
 * on the request path; and the auth-store shape is what this reasons about.
 * Keeping it pure and store-free is also what lets the node-side callers
 * (`adoptOrgContext`) use the SAME membership predicate instead of a second
 * hand-rolled copy — the duplicate-copy class this repo keeps paying for.
 */

type WorkspaceRole = ActiveWorkspace['role'];

/**
 * The slice of the auth-store user these rules read.
 *
 * Structural on purpose (not `Pick<User, …>`): every caller has a real `User`,
 * while the tests build the eleven personas of A6 by hand, and a nominal type
 * would force a full user fixture per row for no added safety.
 */
export interface AffiliationUser {
  id?: string;
  account_kind?: string | null;
  is_org_manager?: boolean;
  org?: {id: string; name: string} | null;
  /** Whether `org` is an Enterprise WORKSPACE (an `org_workspaces` row) rather
   *  than a security agency. Load-bearing here — see `isEnterablePrimaryOrg`. */
  org_is_workspace?: boolean;
  managed_org?: {id: string; name: string} | null;
  workspaces?: Array<{org_id: string; name: string; role: WorkspaceRole}>;
}

/**
 * F1 — is `user.org` an organisation this person can actually ENTER?
 *
 * ONE rule, because there are two very different reasons an org can sit in
 * `user.org` and NOT in `user.workspaces`, and only one of them is enterable:
 *
 *   - AN AGENCY. `WORKSPACE_AFFILIATIONS_SQL` inner-joins `org_workspaces`, so
 *     an agency has no row to join and is absent BY CONSTRUCTION. Entering it
 *     is the whole point of the hub's own-organisation card (MAJOR-3a).
 *   - A LAPSED WORKSPACE. `workspaces` is gated on the org owner's live
 *     Enterprise entitlement, so a workspace whose subscription expired drops
 *     OUT of the array while `org` still names it. That org is not enterable
 *     (founder default Q1: a lapsed workspace says "renew", it does not open),
 *     and treating it as one would hand the employee a card into a company
 *     whose every scoped read comes back empty.
 *
 * `org_is_workspace` is the discriminator the server already ships for exactly
 * this question, and `!== true` (not `=== false`) keeps an older server that
 * omits it on today's agency behaviour.
 */
export function isEnterablePrimaryOrg(user: AffiliationUser | null | undefined): boolean {
  return !!user?.org?.id && user.org_is_workspace !== true;
}

/**
 * Does this server SAY anything about affiliations?
 *
 * `undefined` (an older server, or `/auth/me` not landed yet) is NOT `[]`. It
 * means "cannot vouch", and every rule below degrades to the legacy
 * single-organisation behaviour on it — never to a picker, never to an
 * adoption. `[]` is a real answer: zero enterable workspaces.
 */
export function hasAffiliationList(user: AffiliationUser | null | undefined): boolean {
  return user?.workspaces !== undefined;
}

/**
 * The role a context gets for an org that is NOT a `workspaces` row (an agency
 * org, or a managed CPO's org — both structurally absent from that array).
 *
 * `is_org_manager` OUTRANKS `account_kind` (critic round 1a, P0): a promoted
 * CPO keeps `account_kind === 'cpo'`, so testing the kind first strips manager
 * chrome from exactly the persona `is_org_manager` exists to describe. `owner`
 * is only ever the caller's OWN org row — `org_workspaces` keys an org on its
 * owner, so a company account's `org.id` equals its `user.id`.
 */
export function contextRoleFor(
  user: AffiliationUser | null | undefined,
  orgId: string,
): WorkspaceRole {
  if (user?.id && orgId === user.id) {return 'owner';}
  if (user?.is_org_manager === true) {return 'manager';}
  if (user?.account_kind === 'cpo') {return 'cpo';}
  return 'employee';
}

/**
 * Every organisation this person can ENTER, deduped by org id.
 *
 * `workspaces` FIRST and it wins the dedupe, because its `role` is the
 * server's own membership answer while `contextRoleFor` is only a client-side
 * reconstruction. `org` / `managed_org` are appended only when absent from it:
 * for a single-membership user the primary-org resolution puts the SAME org in
 * both fields (arms 2/4 of `account-kind.ts`), and a naive union would count
 * that person as two and gate them (edge round 1b, P0).
 *
 * An agency org is not a workspace and never appears in `workspaces`
 * (WORKSPACE_AFFILIATIONS_SQL inner-joins `org_workspaces`), which is why the
 * two extra fields are read at all.
 */
export function enterableAffiliations(
  user: AffiliationUser | null | undefined,
): ActiveWorkspace[] {
  const rows = user?.workspaces;
  if (rows === undefined) {return [];}
  const out: ActiveWorkspace[] = [];
  const seen = new Set<string>();
  for (const w of rows) {
    if (!w?.org_id || seen.has(w.org_id)) {continue;}
    seen.add(w.org_id);
    out.push({org_id: w.org_id, name: w.name ?? '', role: w.role});
  }
  // F1 — `org` ONLY when it is enterable. A lapsed workspace is still named by
  // `org` after it has dropped out of the array above, and counting it here
  // would both offer a dead company on the hub and push a single-workspace
  // person to 2, interrupting them with a picker whose second option is a
  // renewal notice.
  for (const o of [isEnterablePrimaryOrg(user) ? user?.org : null, user?.managed_org]) {
    if (!o?.id || seen.has(o.id)) {continue;}
    seen.add(o.id);
    out.push({org_id: o.id, name: o.name ?? '', role: contextRoleFor(user, o.id)});
  }
  return out;
}

/**
 * Is this org the caller's PRIMARY organisation rather than a workspace
 * membership — i.e. an agency, or the org a managed CPO is managed by?
 *
 * Those are structurally absent from `user.workspaces`, so the
 * DepartmentalNavigator's two-strike reconcile would otherwise eject a context
 * naming one of them after two refreshes (A8). CONDITIONAL by construction:
 * an agency the user has since LOST is no longer named by `org`/`managed_org`,
 * so it answers false and is ejected exactly like a removed workspace.
 *
 * F1 — and it asks `isEnterablePrimaryOrg`, not merely "is this `org`". A
 * LAPSED workspace is still named by `org` after dropping out of the array, so
 * the un-gated version exempted a dead employer from the reconcile FOREVER:
 * the one context nothing could ever clear, on the one org whose every scoped
 * read is empty.
 */
export function isPrimaryOrgContext(
  user: AffiliationUser | null | undefined,
  orgId: string | null | undefined,
): boolean {
  if (!orgId) {return false;}
  if (orgId === user?.managed_org?.id) {return true;}
  return isEnterablePrimaryOrg(user) && orgId === user?.org?.id;
}

/**
 * The context the surface should be entered with, given what is already set.
 *
 * Run from `authStore` on every `/auth/me` that ships `workspaces`, which is
 * before any navigator mounts — so there is no blank frame and no unscoped
 * first fetch (critic round 1a, P1: a navigator effect runs AFTER its child's
 * first focus fetch, and three scoped readers never mount that navigator).
 *
 * ⚠️ A STALE CONTEXT — one naming an org this person can no longer enter — is
 * handled by how many organisations are LEFT, not by blanket-keeping it (F2).
 * The un-branched version parked a single-workspace person on a dead org
 * indefinitely: they have exactly one company to be in, and every scoped read
 * was coming back empty for the other one.
 *
 *   1 left  → adopt it. There is no choice to offer and nothing to explain.
 *   ≥ 2     → KEEP it. The DepartmentalNavigator's two-strike reconcile owns
 *             removal, and its ejection card can only render while the context
 *             is still set; nulling it here would teleport the user instead of
 *             telling them their access ended. `needsWorkspaceChoice` covers
 *             the surfaces that navigator never mounts.
 *   0 left  → null. Nothing to adopt, nothing to eject to, and the legacy
 *             single-org behaviour is the honest remainder.
 */
export function resolveWorkspaceEntry(
  user: AffiliationUser | null | undefined,
  current: ActiveWorkspace | null | undefined,
): ActiveWorkspace | null {
  if (!hasAffiliationList(user)) {return current ?? null;}
  const list = enterableAffiliations(user);
  if (current) {
    // Still enterable → keep it, refreshed: the context is a snapshot taken at
    // tile-tap and the list is live, so a rename or a demotion lands here.
    const match = list.find(w => w.org_id === current.org_id);
    if (match) {return match;}
    if (list.length === 1) {return list[0];}
    if (list.length === 0) {return null;}
    return current;
  }
  return list.length === 1 ? list[0] : null;
}

/**
 * Does this person have to PICK before the Departmental surface can be honest?
 *
 * The one copy of the gate condition (D3/A5), consumed by the Channels
 * directory, the workspace Home and the Vault's company shelf.
 *
 * NOTHING CHOSEN → `>= 2` only: with one affiliation the resolver has already
 * adopted it, and with none the legacy single-org behaviour is correct by
 * construction.
 *
 * F2 — A STALE CONTEXT IS ALSO A "CHOOSE" STATE. The resolver deliberately
 * keeps a context whose org has vanished when two or more remain, so the
 * navigator's ejection card can explain what happened. But three scoped
 * readers never mount that navigator — the standalone `DepartmentChannels`
 * route, the Vault company shelf and the tab badge — and on those the user
 * would simply sit on a dead organisation reading "No channels yet", which is
 * a lie about a company they are still in. The picker is the honest state
 * there, and it is one tap from the hub.
 *
 * `isPrimaryOrgContext` is consulted alongside the list so an agency or a
 * managed CPO's org — reachable, and in the list by construction — can never
 * be mistaken for stale if that derivation ever narrows.
 */
export function needsWorkspaceChoice(
  user: AffiliationUser | null | undefined,
  current: ActiveWorkspace | null | undefined,
): boolean {
  if (!hasAffiliationList(user)) {return false;}
  const list = enterableAffiliations(user);
  if (!current) {return list.length >= 2;}
  return !list.some(w => w.org_id === current.org_id)
    && !isPrimaryOrgContext(user, current.org_id);
}
