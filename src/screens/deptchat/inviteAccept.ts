import {Alert} from '@utils/alert';
import {enterpriseApi} from '@services/api';
import {useAuthStore} from '@store/authStore';
import {useActiveWorkspace} from '@store/activeWorkspace';

/**
 * Phase B — after a successful accept, point the Departmental surface at the
 * workspace JUST JOINED. Owned by the flow (not the callers) for the same
 * reason as the recheck: an OWNER's primary org stays their OWN workspace
 * under the four-arm precedence, so every caller that navigates without a
 * context would land them at their own Home — reading as a failed join
 * (edge review #3, all three accept surfaces).
 *
 * ⚠️ B-848 (edge round 1b, P0) — IT USED TO TAKE THE FIRST NON-OWNER ENTRY.
 *
 * That read "at most one membership exists", which stopped being true the
 * moment a person could belong to several workspaces: `workspaces` is ordered
 * by the server, so the first non-owner row is the OLDEST membership. Accepting
 * an invite to a third company therefore dropped the user into the first one
 * they ever joined, and the workspace they had just been invited to was the one
 * place they did not land.
 *
 * The joined org is identified POSITIONALLY instead — the entry that was not
 * in the list before the accept. A snapshot comparison rather than an id from
 * the response, because `acceptInvite` answers no org id and an invite row is
 * consumed by the accept, so there is nothing left to read it from.
 *
 * Nothing new, or nothing to compare against (old server / failed recheck) →
 * leave the context ALONE. Clearing it would be the null-context bug this whole
 * change exists to remove; and the entry resolver in `authStore` has already
 * run on the recheck's `/auth/me`, so a single-affiliation joiner is pointed at
 * their one workspace either way.
 */
function pointContextAtJoinedWorkspace(before: ReadonlySet<string>): void {
  const list = useAuthStore.getState().user?.workspaces;
  if (!list) {return;}
  const joined = list.find(w => !before.has(w.org_id));
  if (!joined) {return;}
  useActiveWorkspace.getState().setActiveWorkspace({
    org_id: joined.org_id, name: joined.name, role: joined.role,
  });
}

/** The affiliations held BEFORE the accept — the only thing that can tell the
 *  new entry from the ones that were already there. */
function affiliationSnapshot(): ReadonlySet<string> {
  return new Set((useAuthStore.getState().user?.workspaces ?? []).map(w => w.org_id));
}

/**
 * Item E — the ONE invite-acceptance flow, shared by ApprovalStatusScreen
 * (matched-invite card) and JoinWorkspaceScreen (typed/pasted code). Two copies
 * of this error mapping is exactly the drifted-duplicate shape this repo keeps
 * paying for, so both screens call this.
 *
 * Returns true when the caller should treat membership as granted and refetch
 * their own state; alerts are handled here.
 */
export async function acceptInviteFlow(code: string): Promise<boolean> {
  // BEFORE the network call: the recheck below rewrites the array in place, so
  // taken afterwards this would already include the workspace we are looking for.
  const before = affiliationSnapshot();
  try {
    await enterpriseApi.acceptInvite(code.trim().toUpperCase());
    // Q11 — membership just changed server-side, and every workspace gate
    // (isOrgAffiliated, hasDeptChannels, the org name, is_org_manager) reads
    // the auth store. The flow owns this refresh so no caller can forget it —
    // without it the user had to force-close the app to see the workspace
    // they just joined. recheckMembership never throws, but it CAN silently
    // not refresh (its catch swallows transient failures) — so a store that
    // still shows no org gets one retry FIRED, NOT AWAITED: awaiting both on
    // a stalled network held the Join button frozen for up to 2×15s (round-2
    // edge #4). The membership is real either way; the shell's gates heal the
    // moment the retry (or the next foreground recheck) lands.
    await useAuthStore.getState().recheckMembership();
    // Phase B — the old `!user?.org` retry guard is vacuous for OWNERS (their
    // org is non-null before the accept); the real "did the recheck land"
    // signal is the membership entry in the workspaces array.
    const u = useAuthStore.getState().user;
    if (!u?.org || (u.owns_workspace && !u.workspaces?.some(w => w.role !== 'owner'))) {
      void useAuthStore.getState().recheckMembership()
        .then(() => pointContextAtJoinedWorkspace(before));
    }
    pointContextAtJoinedWorkspace(before);
    return true;
  } catch (e: unknown) {
    const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
    if (msg === 'already_a_member') {
      // Membership already exists — from the user's point of view this IS the
      // joined state, so let the caller proceed to it. Refresh anyway: the
      // local store may still predate that membership.
      await useAuthStore.getState().recheckMembership();
      // `already_a_member` means the row predates this attempt, so the snapshot
      // holds it and nothing is "new" — the context is left alone, which is
      // correct: the entry resolver has already pointed at it if it can.
      pointContextAtJoinedWorkspace(before);
      Alert.alert('Already a member',
        'You already belong to this workspace. Open Department Channels to get started.');
      return true;
    }
    if (msg === 'already_active_in_another_org') {
      Alert.alert('Could not join',
        'Your account is already an active member of another organisation, and an account can only belong to one.');
      return false;
    }
    if (msg === 'workspace_owner_cannot_join') {
      Alert.alert('Could not join',
        'This account owns its own workspace, so it cannot join another one. If you no longer use that workspace, contact support to remove it.');
      return false;
    }
    if (msg === 'member_exists_use_roster_status' || msg === 'member_suspended_use_roster_status') {
      // Race-only backstop (the server pre-checks this behind its safe
      // message): honest copy beats an endless "check your connection" retry.
      Alert.alert('Could not join',
        'Your account already has a roster history with this workspace. Ask your admin to reinstate you from the roster instead.');
      return false;
    }
    if (msg === 'team_channel_unavailable_reinvite') {
      // vs2 item 2 (P2-d) — the team this invite named is archived, deleted or
      // now managers-only, and nothing above it is joinable either. The server
      // refuses rather than admitting a member who would see zero channels, and
      // the invite is deliberately NOT consumed, so a fresh one is not needed —
      // only a working team. Saying so stops the joiner retrying the same code
      // forever against a generic connection error.
      Alert.alert('Could not join',
        'The team on this invite is no longer available. Ask your workspace admin to '
        + 'send a new invite once they have restored or replaced that channel.');
      return false;
    }
    // The server's single safe message for every other failure class — mirror
    // its shape and do not speculate about which failure it was.
    Alert.alert('Could not join',
      msg === 'invite_invalid_or_expired'
        ? 'This invite is no longer valid. Ask your workspace admin for a new one.'
        : 'Please check your connection and try again.');
    return false;
  }
}
