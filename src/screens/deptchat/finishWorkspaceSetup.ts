/**
 * B-871, second half (2026-09-12) — ENDING the workspace setup flow.
 *
 * The first cut re-pointed the post-create destination at the Workspace Hub
 * with `navigation.replace('WorkspaceHub')`. A replace swaps the TOP route
 * only, so `EnterpriseSetupScreen` survived underneath — a create-or-join fork
 * for a workspace the user had just created. Its owner-redirect effect is
 * `[navigation]`-scoped and had already run on its original mount, so it never
 * re-fires: back from the hub simply showed the stale fork, and pressing
 * "Create a workspace" again earned the server's `already_exists` alert. That
 * is the founder's own complaint in a different costume — finishing a flow and
 * finding a dead screen behind you.
 *
 * Once creation has SUCCEEDED there is no step behind it worth keeping, so the
 * flow ends: retire the setup routes from the stack that hosts them, then land.
 *
 * ── WHY `pop(n)` RATHER THAN THE TWO OBVIOUS ALTERNATIVES ───────────────────
 *
 *  · Popping to the top of the stack throws away real context. In the client
 *    shell this stack is
 *    `[MessengerHome, …, DepartmentChannels, EnterpriseSetup, CreateWorkspace]`,
 *    and clearing it to the root would make back from the hub land on the
 *    messenger home instead of the channel list the user came from.
 *  · Rebuilding the whole navigation state from a keyless route list drops the
 *    NESTED state of every route that is kept — a `Departmental` shell beneath
 *    would silently rewind to its initial tab. Popping leaves everything below
 *    untouched.
 *
 * ── WHERE BACK GOES AFTERWARDS, IN EVERY SHELL THAT REACHES THIS FLOW ───────
 *
 * `CreateWorkspace` is registered in exactly two navigators:
 *
 *  1. `MessengerNavigator` (client shell, flow entered outside the departmental
 *     shell). It registers `WorkspaceHub` too, so the hub is pushed on THIS
 *     stack after the fork is popped → `[MessengerHome, …, DepartmentChannels,
 *     WorkspaceHub]`. Back lands on the channel directory, which now lists the
 *     new workspace's channels.
 *  2. `DepartmentalNavigator`'s Channels stack (reached from the Agent, CPO and
 *     client shells alike). It does NOT register the hub; every ROOT stack that
 *     hosts the `Departmental` surface does — pinned by
 *     `src/navigation/__tests__/workspaceHubReachability.test.ts`. So the fork
 *     is popped off the Channels stack and the hub is pushed on the host above
 *     `Departmental` → back lands on the departmental shell, whose Channels tab
 *     is now back at `DepartmentChannels`. Same sensible answer in all three.
 *
 * The `'none'` outcome is the honest one rather than an invented destination:
 * no shell in the tree reaches it today, and if one ever did, the fork is still
 * retired and the user is standing on the screen they entered the flow from,
 * with the workspace created and the session refreshed.
 *
 * NAV loop: this is programmatic navigation off a completed mutation, so it is
 * deliberately NOT run through `navigateOnce`/`goBackOnce` (N2's scope rule —
 * guarding a programmatic move strands the screen). The button that starts it
 * carries the synchronous `busy` guard instead (N4).
 */
import {
  findNavigatorWithRoute,
  navigateVia,
  type NavigatorStateSlice,
  type RouteAwareNavigation,
} from '@navigation/departmentalEntry';

/** A navigator that can retire routes as well as resolve them. */
export interface SetupFlowNavigation extends RouteAwareNavigation {
  pop: (count?: number) => void;
}

/**
 * The screens the CREATE flow owns, and only those.
 *
 * `JoinWorkspace`, `Approvals` and `ApprovalStatus` are deliberately absent.
 * They are reachable in the same stacks and belong to journeys that are still
 * live after a workspace is created (a pending request against another
 * organisation, for one), so retiring them would delete a screen the user
 * still needs. Nothing routes them UNDER `CreateWorkspace` either, so widening
 * this set buys nothing and can only over-pop.
 */
export const SETUP_FLOW_ROUTES: ReadonlySet<string> = new Set([
  'EnterpriseSetup',
  'CreateWorkspace',
]);

/**
 * How many routes at the TOP of this stack the finished flow owns.
 *
 * Contiguous-from-top on purpose: an `EnterpriseSetup` further down belongs to
 * an earlier journey, and only the run the user is standing on is this flow.
 * The clamp is a floor, not an expected path — `openJoinFlowScreen` passes
 * `initial: false` precisely so the fork is never a stack root (R9-2), but
 * emptying a navigator is unrecoverable, so it cannot be left to that.
 */
export function setupRoutesOnTop(state: NavigatorStateSlice | undefined | null): number {
  const routes = state?.routes ?? [];
  let n = 0;
  for (let i = routes.length - 1; i >= 0 && SETUP_FLOW_ROUTES.has(routes[i]?.name); i--) {
    n += 1;
  }
  return Math.min(n, Math.max(routes.length - 1, 0));
}

/** Which landing actually happened — checked by the pins, and by any caller
 *  whose next step assumes the flow moved. */
export type SetupFlowEnd = 'hub-in-stack' | 'hub-on-ancestor' | 'shell-fallback' | 'none';

export function finishWorkspaceSetup(nav: SetupFlowNavigation): SetupFlowEnd {
  // Read the state ONCE, before anything is dispatched: `routes` has to be the
  // pre-pop stack, and `routeNames` is registration-complete either way.
  const state = nav.getState?.();
  const drop = setupRoutesOnTop(state);
  // RETIRE FIRST, then land. Landing first would push the hub on top of the
  // fork and bury it — which is the defect this closes.
  if (drop > 0) {
    nav.pop(drop);
  }
  if (state?.routeNames?.includes('WorkspaceHub') === true) {
    navigateVia(nav, 'WorkspaceHub');
    return 'hub-in-stack';
  }
  const hub = findNavigatorWithRoute(nav, 'WorkspaceHub');
  if (hub) {
    navigateVia(hub, 'WorkspaceHub');
    return 'hub-on-ancestor';
  }
  const shell = findNavigatorWithRoute(nav, 'Departmental');
  if (shell) {
    navigateVia(shell, 'Departmental');
    return 'shell-fallback';
  }
  return 'none';
}
