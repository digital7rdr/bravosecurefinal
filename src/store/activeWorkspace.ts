import {create} from 'zustand';

/**
 * Phase B (owner-join, founder-approved 2026-08-09) — WHICH workspace the
 * Departmental surface is currently scoped to.
 *
 * ── WHAT NULL MEANS (B-848 CHANGED THIS — read before you rely on it) ──────
 *
 * It used to mean "primary": the scoping helpers below are fail-open, so no
 * context made `GET /department/channels` answer with EVERY organisation the
 * caller holds a membership in, and the Channels directory listed them all.
 * That is the client's "not all organization must show when I open 1
 * organization", and it is gone.
 *
 * Null now means "no organisation chosen YET", and it is a state the
 * Departmental DIRECTORY surfaces refuse to render a list in:
 *
 *   - `authStore` resolves an entry workspace on every `/auth/me` that ships
 *     `workspaces` (`workspaceEntry.resolveWorkspaceEntry`), so anybody with
 *     exactly one enterable affiliation always has a context;
 *   - anybody with two or more and nothing chosen gets `WorkspaceChoiceGate`
 *     on the directory, the workspace Home and the Vault company shelf —
 *     never a merged list.
 *
 * The helpers below stay fail-OPEN anyway, and must: an older server ships no
 * `workspaces`, never reaches the gate, and has to keep behaving exactly as it
 * did. Fail-open is the compatibility story, not the scoping mechanism.
 *
 * ── STILL SESSION-ONLY, AND STILL DELIBERATELY (founder Q3) ────────────────
 *
 * Persisting it is a separate change, not an oversight. `X-Org-Context` is
 * stamped on `attendance/*` and `incidents/*`, and two of those are WRITES
 * whose target org the server reads from the header (clock-in's `org_user_id`,
 * incident submit). A context that survived a restart would therefore file a
 * CPO's clock-in against a customer workspace they once looked at, for the rest
 * of the install. Doing it safely needs a `chosen`/`restored` split — a
 * restored context scoping the channel DIRECTORY only, with the write header
 * staying session-chosen — which is its own plan.
 *
 * Sticky within a session (Discord remembers your last server): entering a
 * different tile replaces it, sign-out and `endCpoAccess` clear it.
 *
 * Role rides along so `useIsManager` can render the RIGHT chrome per
 * workspace: an owner browsing a workspace they joined as an employee must
 * get the member UI, not manager chrome pointed at their own org's data.
 */
export interface ActiveWorkspace {
  org_id: string;
  name: string;
  role: 'owner' | 'manager' | 'employee' | 'cpo';
}

interface ActiveWorkspaceState {
  workspace: ActiveWorkspace | null;
  setActiveWorkspace: (w: ActiveWorkspace | null) => void;
}

export const useActiveWorkspace = create<ActiveWorkspaceState>(set => ({
  workspace: null,
  setActiveWorkspace: w => set({workspace: w}),
}));

/** Non-hook read for handlers/effects. */
export function getActiveWorkspace(): ActiveWorkspace | null {
  return useActiveWorkspace.getState().workspace;
}

/** Sign-out / account-switch hygiene: a context must never outlive its user. */
export function clearActiveWorkspace(): void {
  useActiveWorkspace.getState().setActiveWorkspace(null);
}

/**
 * ONE scoping rule for every dept-surface channel list (channels directory,
 * home dashboard, vault shelf, unread badge) — never copy this inline
 * (duplicate-copy bug class). Fail-open by construction: no context, or rows
 * from an old server that lack org_id, pass through untouched.
 *
 * B-848 — fail-open is the OLD-SERVER story, and it is no longer what keeps a
 * multi-organisation user from seeing a merged list. That is the picker gate on
 * each surface (`workspaceEntry.needsWorkspaceChoice`), which stops the list
 * being rendered — and the fetch being made — at all. Do not "tighten" this to
 * fail-closed: an older server that omits `org_id` would then empty the shelf
 * for every user on it.
 *
 * NOT for the messenger-list dept filters (MessengerHome/Groups/
 * useDeptConversationFilter): those must see EVERY workspace's dept group
 * ids, or the other workspace's channels leak into messenger lists.
 */
export function scopeChannelsToActiveWorkspace<T extends {org_id?: string}>(channels: T[]): T[] {
  const active = getActiveWorkspace();
  if (!active) {return channels;}
  return channels.filter(c => !c.org_id || c.org_id === active.org_id);
}

/** Query param for departmentApi.listChannels on the scoped surfaces. */
export function activeWorkspaceOrgParam(): {orgId: string} | undefined {
  const active = getActiveWorkspace();
  return active ? {orgId: active.org_id} : undefined;
}

/**
 * THE one context-role predicate (critic MAJOR-1/2 — three inline copies of
 * this rule would be the repo's duplicate-copy class; every consumer calls
 * this).
 *
 * Null = no context — the caller falls back to the global flags, exactly the
 * pre-Phase-B behaviour.
 *
 * ── THE owns_workspace CLAUSE IS GONE (vs2 item 4) ──────────────────────────
 *
 * It used to read `active.role === 'manager' && !ownsWorkspace`, and that was
 * correct while it lasted: OrgManagerGuard's owner arm (Path 1b) returned the
 * owner's OWN org before it ever reached the delegated-manager arm, so manager
 * chrome inside somebody else's workspace would have read and written the
 * wrong company's data.
 *
 * Item 4 changed exactly that precedence. The owner arm no longer
 * short-circuits when a context is named, so Priya — who owns Acme and is a
 * delegated manager of Borealis — now genuinely IS Borealis's manager
 * server-side while viewing Borealis. The stale clause left her looking at the
 * EMPLOYEE surface: Attend rooted at Attendance instead of AdminAttendance,
 * Incidents at the report form instead of the queue, every manager card and
 * the module sheet hidden. The headline persona of the founder's Option A
 * decision, locked out of the thing the decision granted her.
 *
 * A mirror of a server rule has to move when the server rule moves — which is
 * why the parameter stays in the signature and is now explicitly unused rather
 * than being deleted: the next person to reach for it should read this first.
 */
export function contextManagerRole(
  active: ActiveWorkspace | null,

  _ownsWorkspace: boolean,
): boolean | null {
  if (!active) {return null;}
  return active.role === 'owner' || active.role === 'manager';
}
