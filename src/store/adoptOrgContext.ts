import {getActiveWorkspace, useActiveWorkspace} from './activeWorkspace';

/**
 * Channels vs2 edge A1/A2 — a server wake names an organisation; point the
 * workspace surface at it BEFORE the tap navigates.
 *
 * ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────────
 *
 * Item 4 made a person able to belong to several organisations, and every
 * org-scoped read is stamped with the ACTIVE workspace (`X-Org-Context`). But
 * nothing on a notification tap ever set that context, so a manager of two orgs
 * who got "Acme: incident reported" read the incident with BOREALIS stamped on
 * the request — `detail()` filters `WHERE id = $1 AND org_user_id = $2`, found
 * nothing, and `IncidentDetailScreen` swallowed the 404 into an empty screen.
 * From a killed app it failed on EVERY tap for a non-default org, because the
 * context is session-only and null at boot. Same mechanism, second door: a
 * two-org admin tapping org-B's "join request waiting" read org-A's inbox.
 *
 * ── WHY THIS IS SAFE ─────────────────────────────────────────────────────
 *
 * Adopting a context client-side can never widen access. The header is a
 * REQUEST, never a grant (`org-context.ts`): the server intersects it with the
 * caller's real memberships and ignores an org they do not hold. We narrow
 * further here anyway — an id that is not one of the user's own ENTERABLE
 * AFFILIATIONS (`workspaceEntry.enterableAffiliations`: the workspace rows plus
 * the primary/managed org, which are structurally absent from that array) is
 * refused outright, so a forged blob cannot even change what the UI asks for.
 * B-848 — a refusal now also DROPS a context naming a different organisation,
 * rather than leaving the surface claiming org A while the user acts on org B.
 *
 * ── WHAT ELSE READS THIS STATE (know before you widen the callers) ───────
 *
 * "Cannot widen access" is an ACCESS argument, and `activeWorkspace` also
 * decides a DESTINATION. `X-Org-Context` is stamped on `attendance/*` and
 * `incidents/*` (`services/api.ts` ORG_SCOPED_PREFIXES), and two of those are
 * writes whose target org the server reads from the header: clock-in
 * (`attendance.service.resolveOrg`) and incident submit
 * (`incident.service.resolveOrg`). So adopting does not merely change what is
 * displayed — a later clock-in files against the adopted org.
 *
 * That is accepted, because every door here NAVIGATES INTO that workspace's
 * own Departmental surface: the user ends up on Borealis's tabs, under
 * Borealis's header, and clocking in there is the honest answer. It is the
 * same contract as entering by a hub tile, which has always been sticky. The
 * hazard to respect is the SEQUENCE — glance at a wake, leave, come back via
 * the drawer — so do NOT extend adoption to any door that does not put the
 * user inside that org's surface. A wake that only shows a banner must not
 * call this.
 *
 * ── WHAT IT DOES NOT COVER ───────────────────────────────────────────────
 *
 * A membership created while the app was KILLED is not in the persisted auth
 * snapshot that a cold tap reads, so the very first wake from a brand-new org
 * degrades to the sticky context until `/auth/me` lands. Self-healing on the
 * next tap; the `[orgctx] wake org not a membership` warn below is how it is
 * recognised on a device rather than guessed at.
 *
 * ── WHY IT IS ONE FUNCTION ───────────────────────────────────────────────
 *
 * THREE doors deliver the same event: the foreground/cold-boot push tap
 * (`fcmBootstrap.routeServerWakeTap`, incident + enterprise lanes) and the
 * durable bell row (`ActivityCenterScreen`) — the lane that carries every
 * delivery which missed the 5-minute blob. One behaviour with N copies is this
 * repo's most-shipped bug, so all three call THIS, and nothing else writes a
 * context from a wake.
 *
 * Lives in its own file rather than in `activeWorkspace.ts` because it needs the
 * auth store, and `activeWorkspace` is imported by `services/api` — the import
 * would close the cycle api → activeWorkspace → authStore → api.
 */

/**
 * The shape the server's own header validator accepts (`readOrgContextHeader`).
 *
 * Lowercase-only, and the id is lowercased before it is tested — NOT an `/i`
 * flag. A case-insensitive validator in front of case-SENSITIVE `===` compares
 * (both the active-context check and the membership lookup, against ids
 * Postgres always emits lowercase) is worse than either: a mixed-case id passes
 * validation and then silently reports `skipped`, which is indistinguishable
 * from "not a member" in the logs.
 */
const ORG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Which adoption is the LIVE one.
 *
 * Every door runs `adopt → await → navigate`, and the await is real (below), so
 * two taps inside that window interleave: the first chain wakes up holding the
 * SECOND tap's context and deep-links its own id against the wrong org — the
 * exact empty screen this module exists to remove, reintroduced by the fix.
 * A tap also lands on a bell row with no tap guard, so this is a double-tap
 * away, not a stress test.
 *
 * Newest tap wins (the message-wake lane reaches the same conclusion with its
 * `stillOnTapTarget` guard: a tap from seconds ago must never hijack navigation
 * the user has since done themselves).
 */
let adoptionGeneration = 0;

/**
 * B-95 — a context switch does not take effect on the next line.
 *
 * `DepartmentalNavigator` answers an org change by rendering ONE navigator-free
 * frame (~30ms) so React Navigation's deferred cleanup can drop the previous
 * org's stored child state; mounting the replacement in the same commit makes
 * the cleanup skip itself and the new tree rehydrates the OLD org's screens.
 * A deep-link dispatched into that gap targets an unmounted navigator. Waiting
 * out the frame costs an already-async tap nothing and is the difference
 * between landing on the incident and landing on the tab root.
 */
const SWITCH_SETTLE_MS = 120;

export type OrgContextAdoption =
  /** The blob named no org, or a malformed one. Today's behaviour, unchanged. */
  | 'skipped'
  /**
   * B-848 — a WELL-FORMED org id this client cannot vouch for: not in the
   * user's own affiliations, or an `/auth/me` that has not landed yet.
   *
   * Split out of `skipped` because the two want opposite treatment. "No org
   * named" is every old server and every single-org user, and must leave a
   * sticky context alone. "An org named that we refuse" means the wake is
   * about a DIFFERENT company from the one the surface is pointed at — and the
   * header decides where a clock-in and an incident submit LAND. Rather than
   * act on B under A's name, the context is dropped here (see below) and the
   * caller navigates with no organisation claimed.
   */
  | 'refused'
  /** Already looking at that org — nothing written, nothing to wait for. */
  | 'unchanged'
  /** Context switched; the caller may navigate now. */
  | 'adopted'
  /** A LATER tap started while this one was settling. Do NOT navigate. */
  | 'superseded';

/**
 * B-848 / A9(a) — a wake is about to open the DIRECTORY and we do not know
 * which organisation it belongs to.
 *
 * `deptOrgByConversation` is empty after a 403 or an offline cold boot, so the
 * directory would be scoped to whatever the surface happens to be pointed at —
 * a company the tapped message is not from, whose channel list does not
 * contain the channel that was tapped. Releasing the context makes the
 * directory show the workspace picker for a multi-affiliation person and their
 * only organisation for everybody else; either is honest, and neither claims
 * the wrong company.
 *
 * ⚠️ F5 — ONLY WHEN THERE IS GENUINELY A CHOICE TO RE-MAKE (>= 2 enterable).
 *
 * With a single affiliation the context is not a guess, it is the only answer
 * there is — resolved from the server's own list on every `/auth/me`. Releasing
 * it there trades a correct scope for an unscoped directory purely because a
 * local registry was cold, which is the ordinary state after an offline boot or
 * a 403. The picker cannot help that person either (it needs two options), so
 * the release would be a pure downgrade. Release is for the multi-organisation
 * case, where claiming the wrong company is the real hazard.
 *
 * Lives here, beside the only other wake-path writer, so the "one context
 * writer from a wake" rule stays literally true (`activityCenterWiring`).
 *
 * Returns whether anything was actually released.
 */
export function releaseOrgContextForUnknownWake(): boolean {
  if (!getActiveWorkspace()) {return false;}
  const {useAuthStore} = require('@/store/authStore') as typeof import('@/store/authStore');
  const {enterableAffiliations} = require('./workspaceEntry') as typeof import('./workspaceEntry');
  if (enterableAffiliations(useAuthStore.getState().user).length < 2) {return false;}
  console.warn('[orgctx] wake names no org — releasing the context before the directory');
  useActiveWorkspace.getState().setActiveWorkspace(null);
  return true;
}

/**
 * Point the workspace surface at the organisation a wake names, if it is
 * genuinely one of the user's own. Await it before navigating.
 *
 * Absent / unknown / malformed org id = today's behaviour, unchanged: the tap
 * keeps the sticky context. That is the whole compatibility story — an old
 * server sends no `orgId`, and single-org users never had a second org to be
 * wrong about.
 */
export async function adoptOrgContextFromWake(rawOrgId: unknown): Promise<OrgContextAdoption> {
  // Claimed FIRST, for every outcome: a tap that resolves instantly still has
  // to invalidate an older tap that is mid-settle, or the stale chain navigates
  // on top of it.
  const generation = ++adoptionGeneration;
  if (typeof rawOrgId !== 'string') {return 'skipped';}
  const orgId = rawOrgId.trim().toLowerCase();
  if (!ORG_ID_RE.test(orgId)) {return 'skipped';}
  if (getActiveWorkspace()?.org_id === orgId) {return 'unchanged';}

  // Required at CALL time, not at module top: `authStore` pulls in `services/api`
  // (axios, AsyncStorage, supabase), and `fcmBootstrap` is loaded by the
  // headless background handler on a cold process.
  const {useAuthStore} = require('@/store/authStore') as typeof import('@/store/authStore');
  const {enterableAffiliations} = require('./workspaceEntry') as typeof import('./workspaceEntry');
  const user = useAuthStore.getState().user;
  /**
   * B-848 — ONE membership predicate, shared with the entry resolver and the
   * picker gate.
   *
   * It used to read `user.workspaces` directly, which refused an AGENCY org
   * outright — and an agency org is structurally absent from that array, so a
   * wake naming the caller's own agency was rejected as "not a membership".
   * `enterableAffiliations` is the same list the hub can enter, so the two
   * cannot disagree about what this person belongs to.
   *
   * Undefined `workspaces` (older server, or /auth/me not landed yet) still
   * yields an EMPTY list ON PURPOSE — never adopt an org we cannot vouch for.
   */
  const match = enterableAffiliations(user).find(w => w.org_id === orgId);
  if (!match) {
    // Release-visible: this is the ONE outcome that looks identical to "the
    // feature is not working" (a stale cold-boot snapshot vs a genuine
    // non-membership).
    console.warn(`[orgctx] wake org not a membership org=${orgId.slice(0, 8)}`);
    /**
     * A9(c) — and if a context is currently naming a DIFFERENT organisation,
     * DROP IT before the caller navigates.
     *
     * The wake is about org B; the surface is pointed at org A; we cannot
     * vouch for B. Keeping A means the user reads B's notification with A
     * stamped on every request (`X-Org-Context` covers attendance and
     * incidents, and two of those are WRITES whose target org the server takes
     * from the header). No organisation claimed is the honest state — the next
     * `/auth/me` re-resolves one.
     *
     * Done HERE rather than in each of the four calling lanes so there stays
     * exactly one context writer on the wake path (`activityCenterWiring`
     * pins that).
     */
    if (getActiveWorkspace()) {
      console.warn(`[orgctx] wake refused — dropping a context for another org=${orgId.slice(0, 8)}`);
      useActiveWorkspace.getState().setActiveWorkspace(null);
    }
    return 'refused';
  }

  useActiveWorkspace.getState().setActiveWorkspace({
    org_id: match.org_id, name: match.name, role: match.role,
  });
  // WARN, not log: `transform-remove-console` strips `log` in release, and this
  // lane's failures are exactly the ones that are invisible on a device.
  console.warn(`[orgctx] wake adopted org=${orgId.slice(0, 8)} role=${match.role}`);

  /**
   * Yield ONCE before starting the clock.
   *
   * The held frame's own 30ms timer does not exist yet at this line — it is
   * scheduled by an effect that runs only after React commits the re-render
   * this write just triggered. Starting a 120ms timer in the same tick means
   * both are racing from different origins, and under this repo's documented
   * JS-thread stalls (350-500ms per send, 4-6s `PerfMonitor longMsg`) the
   * commit can land AFTER our timer has already fired — navigating into the
   * gap we are waiting for. One macrotask boundary lets the commit and its
   * effect happen first, so the two timers are ordered by their constants
   * rather than by thread luck.
   */
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, SWITCH_SETTLE_MS));
  if (generation !== adoptionGeneration) {
    console.warn(`[orgctx] adoption superseded org=${orgId.slice(0, 8)}`);
    return 'superseded';
  }
  return 'adopted';
}
