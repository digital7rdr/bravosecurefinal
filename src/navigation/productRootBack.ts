/**
 * B-858 — "am I standing at this product's ROOT?", as a pure function.
 *
 * Founder, 2026-09-11: _"In the Pro dashboard when I try to go back it takes me
 * to the Bravo feed; I should be able to go to the profile menu where all the
 * options are — messenger, geo, etc."_ — i.e. back at a product root opens the
 * product chooser. That REVERSES vs2 item 18, which removed the gate re-open
 * from the back handler, and it does so on the founder's explicit instruction.
 *
 * ── WHY A STRUCTURAL CHECK AND NOT `canGoBack()` ─────────────────────────────
 *
 * The first cut of this fix would have been dead code. The root tab navigator
 * ran `backBehavior="history"`, which makes the TAB navigator itself "able to go
 * back" whenever another tab has been visited — so at the Pro dashboard, for any
 * user who had opened Messenger once, `navigationRef.canGoBack()` was TRUE and
 * the handler bailed before it could reach any gate branch. That is precisely
 * the founder's repro: back went to the Bravo feed (the previously focused tab),
 * not to the chooser. `backBehavior` is now `"initialRoute"` — but "the user is
 * at the product root" is a fact about the navigation TREE, not about whether
 * some navigator in the chain happens to have somewhere to go, so it is asked
 * directly here and asked FIRST.
 *
 * The shape it looks for, using Secure as the example:
 *
 *   RootStack        index 0   → 'Main'          (a pushed modal → NOT at root)
 *     RootTabs       focused   → 'SecureTab'     (the product's own root tab)
 *       BookingStack index 0   → 'SecureShell'   (nothing pushed above the shell)
 *         ShellTabs  index 0   → 'Home'          (the shell's first tab)
 *
 * Every ANCESTOR of the product's root tab must be at its first route (anything
 * pushed over the tab tree — a call screen, a vault lock — owns the back press).
 * At the tab level the FOCUSED route must be the product's root tab, whatever
 * its position in the declaration order. Everything BELOW must be at index 0.
 */

/** The subset of a React Navigation state this needs. Deliberately structural. */
export interface NavStateLike {
  index?: number;
  routes?: ReadonlyArray<{name: string; state?: NavStateLike | undefined}>;
}

/** The root tab each product opens on — must match `Tab.Navigator`'s `initialRouteName`. */
export function productRootTabFor(activeProduct: string | null | undefined): string {
  return activeProduct === 'messenger' ? 'MessengerTab' : 'SecureTab';
}

export function isAtProductRoot(
  state: NavStateLike | null | undefined,
  productRootTab: string,
): boolean {
  let node: NavStateLike | undefined = state ?? undefined;
  // Guard against a cyclic/pathological state rather than looping forever.
  for (let depth = 0; node && depth < 20; depth += 1) {
    const index = node.index ?? 0;
    const route = node.routes?.[index];
    if (!route) {return false;}
    if (route.name === productRootTab) {
      return isFirstRouteAllTheWayDown(route.state);
    }
    // An ancestor of the tab tree is not on its first route — something is
    // pushed over the product, and that screen's own back handling wins.
    if (index !== 0) {return false;}
    node = route.state;
  }
  return false;
}

function isFirstRouteAllTheWayDown(state: NavStateLike | undefined): boolean {
  let node = state;
  for (let depth = 0; node && depth < 20; depth += 1) {
    const index = node.index ?? 0;
    if (index !== 0) {return false;}
    node = node.routes?.[index]?.state;
  }
  return true;
}
