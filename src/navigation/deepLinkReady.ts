/**
 * Wait until a notification tap can actually LAND (owner 2026-10-31: "If a
 * notification appears in the phone's notification panel and you tap it, the
 * phone does not open to the notification's location").
 *
 * The tap handlers used to wait only for `navigationRef.isReady()`. That flips
 * true the moment the NavigationContainer mounts ANY navigator — and on a cold
 * start (app closed, then the notification tapped) the root stack first shows
 * a placeholder Auth tree while the session is verified, the permissions /
 * credits flags are read, and the product is chosen. A `navigate('Main', …)`
 * issued in that window names a route that does not exist yet, React
 * Navigation drops it silently, and the app opens on whatever it shows by
 * default. The incident lane had already learned this (it waited for 'Main');
 * every other lane — chats, groups, workspace channels, missed calls, Secure
 * Services — had not.
 *
 * `waitForShellReady` waits for the DESTINATION SHELL: the signed-in user is
 * known, the shell it routes to is mounted, and (client accounts) a product
 * tree is on screen rather than the product chooser.
 */
import {navigationRef, mountedTreeHasRoute} from './navigationRef';
import {resolveAuthedRoute, type AuthedRoute} from './resolveRoute';

/** Route that proves a shell is mounted and can take a deep link, or null when it cannot. */
export function shellEntryRoute(shell: AuthedRoute): string | null {
  switch (shell) {
    case 'client': return 'MessengerTab'; // Main's tab tree (any product registers every tab)
    case 'agency': return 'MessengerHome'; // AgentNavigator registers it on its root stack
    case 'cpo':    return 'CpoTabs';
    default:       return null; // activation / onboarding / access ended: nothing to open
  }
}

/** Which product a client tap belongs to, when the product chooser is up. */
export type DeepLinkLane = 'messenger' | 'secure';

interface UserLike {
  role?: string;
  account_kind?: string;
  must_set_password?: boolean;
  membership_status?: string | null;
  cpo_needs_onboarding?: boolean;
  is_org_manager?: boolean;
  is_agency_manager?: boolean;
  owns_workspace?: boolean;
  workspaces?: unknown[];
}

/** The shell a signed-in user lands in — same signals MainNavigator uses. */
export function shellForUser(u: UserLike): AuthedRoute {
  return resolveAuthedRoute({
    accountKind:             u.account_kind as never,
    mustSetPassword:         u.must_set_password,
    membershipStatus:        u.membership_status,
    cpoNeedsOnboarding:      u.cpo_needs_onboarding,
    legacyRole:              u.role as never,
    isOrgManager:            u.is_org_manager,
    isAgencyManager:         u.is_agency_manager,
    hasWorkspaceAffiliation: u.owns_workspace === true || (u.workspaces?.length ?? 0) > 0,
  });
}

/**
 * Resolves true once a deep link into the signed-in shell will land; false on
 * timeout or when the account has no shell a notification can open.
 *
 * A client account sitting on the product chooser (or with no product yet) is
 * moved into the tap's product first — the chooser has no routes to land on.
 */
export async function waitForShellReady(opts: {lane: DeepLinkLane; timeoutMs?: number}): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? 25_000);
  let productAsked = false;
  while (Date.now() < deadline) {
    if (navigationRef.isReady()) {
      let user: UserLike | null = null;
      let authed = false;
      try {
        const {useAuthStore} = require('@store/authStore') as typeof import('@store/authStore');
        const s = useAuthStore.getState();
        authed = s.isAuthenticated === true;
        user = (s.user ?? null) as UserLike | null;
      } catch { /* store not loaded yet */ }
      if (authed && user?.role) {
        const shell = shellForUser(user);
        const entry = shellEntryRoute(shell);
        if (entry === null) {return false;}
        if (shell === 'client' && !productAsked) {
          try {
            const {useProductStore} = require('@store/productStore') as typeof import('@store/productStore');
            const p = useProductStore.getState();
            if (!p.activeProduct || p.gateVisible) {
              productAsked = true;
              if (opts.lane === 'messenger') {p.enterMessenger(null);}
              else if (p.activeProduct) {p.closeGate();}
              else {p.setActiveProduct('secure');}
            }
          } catch { /* product store unavailable — wait for the tree as is */ }
        }
        if (mountedTreeHasRoute(entry)) {return true;}
      }
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}
