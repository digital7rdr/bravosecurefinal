/**
 * B-858 — back at a product root opens the chooser.
 *
 * Founder, 2026-09-11: _"In the Pro dashboard when I try to go back it takes me
 * to the Bravo feed; I should be able to go to the profile menu where all the
 * options are — messenger, geo, etc."_ This reverses vs2 item 18 on his explicit
 * instruction, and the critic's P0 on the plan was that restoring `requestGate()`
 * ALONE would be dead code: under `backBehavior="history"` the root tab
 * navigator reports `canGoBack() === true` at the Pro dashboard for anyone who
 * has opened Messenger once, so the handler bailed before any gate branch.
 *
 * Hence two halves: the pure structural decision (here), and a source scan in
 * `navigatorConfig.test.ts` proving MainNavigator asks it BEFORE `canGoBack()`
 * and that the tab navigator no longer runs `history`.
 */
import {isAtProductRoot, productRootTabFor, type NavStateLike} from '../productRootBack';

/** `[BookingHome, SecureShell]`-style stack helper. */
const stack = (names: string[], index: number, leaf?: NavStateLike): NavStateLike => ({
  index,
  routes: names.map((name, i) => ({name, state: i === index ? leaf : undefined})),
});

/** The steady-state Secure tree: Root → Main → tabs → BookingStack → shell tabs. */
function secureTree(opts: {
  tabIndex?: number;
  bookingIndex?: number;
  bookingRoutes?: string[];
  shellIndex?: number;
  rootIndex?: number;
  rootRoutes?: string[];
} = {}): NavStateLike {
  const shell = stack(['Home', 'Book', 'Summary', 'Messenger'], opts.shellIndex ?? 0);
  const booking = stack(opts.bookingRoutes ?? ['SecureShell'], opts.bookingIndex ?? 0, shell);
  const tabs = stack(['MessengerTab', 'SecureTab', 'ProfileTab'], opts.tabIndex ?? 1, booking);
  return stack(opts.rootRoutes ?? ['Main'], opts.rootIndex ?? 0, tabs);
}

describe('productRootTabFor', () => {
  it('matches the root Tab.Navigator initialRouteName for every product', () => {
    expect(productRootTabFor('messenger')).toBe('MessengerTab');
    expect(productRootTabFor('secure')).toBe('SecureTab');
    // GeoRisk is hosted on SecureTab with a VBGHome seed — same root tab.
    expect(productRootTabFor('vbg')).toBe('SecureTab');
    expect(productRootTabFor(null)).toBe('SecureTab');
  });
});

describe('isAtProductRoot — the structural product-root check', () => {
  it('TRUE at the Pro dashboard (SecureShell, Home tab, nothing pushed)', () => {
    expect(isAtProductRoot(secureTree(), 'SecureTab')).toBe(true);
  });

  it('TRUE at the Pro dashboard even though a tab HISTORY exists — the founder repro', () => {
    // The bug was never about the tree; it was about `canGoBack()` answering
    // for the tab navigator's focus history. The tree is identical here.
    expect(isAtProductRoot(secureTree({tabIndex: 1}), 'SecureTab')).toBe(true);
  });

  it('FALSE while Messenger is the focused tab (back goes to SecureTab, not the gate)', () => {
    const msg = stack(['MessengerHome'], 0);
    const tabs = stack(['MessengerTab', 'SecureTab', 'ProfileTab'], 0, msg);
    expect(isAtProductRoot(stack(['Main'], 0, tabs), 'SecureTab')).toBe(false);
    // …and TRUE for the same tree when Messenger IS the product.
    expect(isAtProductRoot(stack(['Main'], 0, tabs), 'MessengerTab')).toBe(true);
  });

  it('FALSE with anything pushed above the shell (Linked Members, the paywall…)', () => {
    expect(isAtProductRoot(
      secureTree({bookingRoutes: ['SecureShell', 'SecureProMembers'], bookingIndex: 1}),
      'SecureTab',
    )).toBe(false);
  });

  it('FALSE on a non-first tab INSIDE the shell (Book/Summary pop to Home first)', () => {
    expect(isAtProductRoot(secureTree({shellIndex: 1}), 'SecureTab')).toBe(false);
    expect(isAtProductRoot(secureTree({shellIndex: 2}), 'SecureTab')).toBe(false);
  });

  it('FALSE while a modal route sits above the whole tab tree (a call, the vault lock)', () => {
    expect(isAtProductRoot(
      secureTree({rootRoutes: ['Main', 'CallScreen'], rootIndex: 1}),
      'SecureTab',
    )).toBe(false);
  });

  it('FALSE while the LITE stack still holds BookingHome under the resolver', () => {
    // The cold seed is [BookingHome, SecureLanding]; the resolver resets it to
    // [SecureShell]. Between the two, back must still be an ordinary pop.
    expect(isAtProductRoot(
      secureTree({bookingRoutes: ['BookingHome', 'SecureLanding'], bookingIndex: 1}),
      'SecureTab',
    )).toBe(false);
  });

  it('TRUE for the GeoRisk root (VBGHome seeded as the stack\'s only route)', () => {
    const booking = stack(['VBGHome'], 0);
    const tabs = stack(['MessengerTab', 'SecureTab', 'ProfileTab'], 1, booking);
    expect(isAtProductRoot(stack(['Main'], 0, tabs), 'SecureTab')).toBe(true);
  });

  it('FALSE — never true — for an absent, empty or unrecognised state', () => {
    expect(isAtProductRoot(null, 'SecureTab')).toBe(false);
    expect(isAtProductRoot(undefined, 'SecureTab')).toBe(false);
    expect(isAtProductRoot({}, 'SecureTab')).toBe(false);
    expect(isAtProductRoot({index: 0, routes: []}, 'SecureTab')).toBe(false);
    expect(isAtProductRoot(secureTree(), 'NotATab')).toBe(false);
  });

  it('terminates on a self-referential state instead of hanging', () => {
    const cyclic: NavStateLike = {index: 0, routes: [{name: 'Main'}]};
    (cyclic.routes as Array<{name: string; state?: NavStateLike}>)[0].state = cyclic;
    expect(isAtProductRoot(cyclic, 'SecureTab')).toBe(false);
  });
});
