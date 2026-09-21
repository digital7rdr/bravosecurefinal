/**
 * B-872 (navigation audit, 2026-09-12) — N1/N3/N4/N5/N6 source pins.
 *
 * These screens mount RN trees no Jest project here can import, so the pins
 * are comment-stripped source scans. House rules apply: the files are CRLF
 * (normalize first), comments are stripped so prose can neither satisfy nor
 * defeat an assertion, and every assertion is anchored at the DECISION SITE.
 *
 * N2 (mount-scoped hardware-back handlers) is pinned by the enumerating scan
 * in `src/screens/messenger/__tests__/navRapidUseGuards.test.ts` instead —
 * that is the loop's home for the N1 invariant and it now walks every screen.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const src = (p: string) => strip(read(p));

const FINDING = 'src/screens/booking/FindingDetailScreen.tsx';
const ACCEPTED = 'src/screens/booking/AgencyAcceptedScreen.tsx';
const CONFIRM = 'src/screens/booking/BookingConfirmationScreen.tsx';
const TRACKING = 'src/screens/liveops/LiveTrackingScreen.tsx';
const OPSREVIEW = 'src/screens/ops/OpsRoomReviewScreen.tsx';
const VAULTLOCK = 'src/screens/messenger/VaultLockScreen.tsx';
const VAULTNEWPIN = 'src/screens/messenger/VaultNewPinScreen.tsx';
const AGENTTYPE = 'src/screens/agent/AgentTypeSelectScreen.tsx';

/**
 * N1 — `navigation.replace()` is stamped with `source` only, never `target`
 * (@react-navigation/core useNavigationCache), so StackRouter resolves REPLACE
 * against `state.index` — the FOCUSED route, not the caller. Every one of these
 * five screens pushes a screen above itself (SOS, Invoice, CreditPaywall) and
 * keeps polling, so a status flip used to swap the screen the user was looking
 * at — including the emergency SOS surface.
 *
 * The count is the whole file, deliberately: "poll site" is not something a
 * scan can tell from "post-await site", and both classes have the same defect.
 */
const POLL_SCREENS: Array<[string, number]> = [
  [FINDING, 4],
  [ACCEPTED, 4],
  [CONFIRM, 4],
  [TRACKING, 6],
  [OPSREVIEW, 7],
];

describe('B-872/N1 — a navigating poll acts on its OWN slot, never the focused route', () => {
  it.each(POLL_SCREENS)('%s routes every replace through replaceOwnSlot', (file, count) => {
    const code = src(file);
    expect(code).toMatch(/from '@navigation\/ownSlotNav'/);
    // The helper is only correct if the key it is handed is THIS screen's own
    // route key; a scan cannot prove an identifier, so pin where it comes from.
    expect(code).toMatch(/const routeKey = route\.key;/);
    expect(code).not.toMatch(/navigation\.replace\(/);
    const hits = code.match(/replaceOwnSlot\(navigation, routeKey,/g) ?? [];
    expect(hits).toHaveLength(count);
  });
});

describe('B-872/N1 — a poll-driven unwind waits for focus (SOS is never yanked)', () => {
  // `popToTop` cannot be targeted: StackRouter re-dispatches POP_TO_TOP as a
  // plain POP and drops source/target on the way, so the only way to keep a
  // pushed SOS screen alive is to wait for focus — and then actually re-arm,
  // or the screen parks forever (NAV_RAPID_USE_LOOP §8, the IncomingOffer
  // watcher-swallow).
  it.each([FINDING, ACCEPTED])('%s defers every popToTop except the hardware-back one', file => {
    const code = src(file);
    expect(code).toMatch(/const runWhenFocused = useFocusDeferredNav\(navigation\)/);
    const sites = [...code.matchAll(/navigation\.popToTop\(\)/g)];
    expect(sites.length).toBeGreaterThan(1);
    let skipped = 0;
    for (const m of sites) {
      const before = code.slice(Math.max(0, (m.index ?? 0) - 30), m.index);
      // The hardware-back unwind is already focus-scoped by its registration
      // (N2) — it can only fire while this screen IS the focused one.
      if (before.includes('try { ')) {
        skipped += 1;
        continue;
      }
      expect(before).toContain('runWhenFocused(() => ');
    }
    expect(skipped).toBe((code.match(/BackHandler\.addEventListener/g) ?? []).length);
  });
});

describe('B-872/N3 — the vault exit only resets a stack that is ROOTED at MessengerHome', () => {
  // In the agency shell MessengerHome is a PUSHED route over AgentDashboard
  // (AgentNavigator), so the old unconditional reset deleted the dashboard and
  // the next back press exited the app.
  it('VaultLockScreen pops to a PUSHED MessengerHome, and resets otherwise', () => {
    const code = src(VAULTLOCK);
    const at = code.indexOf('const exitToHome');
    expect(at).toBeGreaterThan(-1);
    const body = code.slice(at, at + 1600);
    // `> 0`, never `>= 0`: index 0 IS the client/CPO stack root, where the
    // reset is right, and "absent" (-1) must reset too — navigating then would
    // PUSH a fresh home on top of the lock and leave the vault underneath.
    const guard = body.indexOf("routes.findIndex(r => r.name === 'MessengerHome') > 0");
    const nav = body.indexOf("navigation.navigate('MessengerHome')");
    const reset = body.indexOf('navigation.reset(');
    expect(guard).toBeGreaterThan(-1);
    expect(nav).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(-1);
    // The guard DECIDES, so it comes first; the reset stays the fallback.
    expect(guard).toBeLessThan(nav);
    expect(nav).toBeLessThan(reset);
  });
});

describe('B-872/N4 — the agent boot resolver cannot replace a screen it does not own', () => {
  it('AgentTypeSelectScreen gates its redirect on isFocused and holds a spinner', () => {
    const code = src(AGENTTYPE);
    const at = code.indexOf('agentApi.getMe()');
    expect(at).toBeGreaterThan(-1);
    const body = code.slice(at, at + 700);
    const focus = body.indexOf('navigation.isFocused()');
    const replace = body.indexOf('navigation.replace(');
    expect(focus).toBeGreaterThan(-1);
    expect(replace).toBeGreaterThan(-1);
    expect(focus).toBeLessThan(replace);
    // …and the picker may not render against an unknown status (a tap on it
    // races the resolver's replace).
    expect(code).toMatch(/if \(resolving\)/);
  });
});

describe('B-872/N5 — VaultNewPin timers are owned, cleared and focus-deferred', () => {
  it('every setTimeout goes through the one armed, unmount-cleared helper', () => {
    const code = src(VAULTNEWPIN);
    // Exactly one raw setTimeout survives: the one INSIDE armTimer.
    const raw = code.match(/setTimeout\(/g) ?? [];
    expect(raw).toHaveLength(1);
    const armed = code.match(/armTimer\(/g) ?? [];
    // the definition + every call site
    expect(armed.length).toBeGreaterThanOrEqual(4);
    expect(code).toMatch(/clearTimeout\(t\)/);
  });

  it('the two navigating timers are focus-deferred, never fire-and-forget', () => {
    const code = src(VAULTNEWPIN);
    expect(code).toMatch(/const runWhenFocused = useFocusDeferredNav\(navigation\)/);
    // EXACTLY the two that navigate. The third armed timer (the error-shake
    // reset) sets state only and must NOT be focus-gated, or a blurred error
    // leaves the keypad stuck in its red state.
    const deferred = code.match(/armTimer\(\(\) => runWhenFocused\(/g) ?? [];
    expect(deferred).toHaveLength(2);
    // Site 1 — the expired-reset-token fallback.
    expect(code).toMatch(
      /armTimer\(\(\) => runWhenFocused\(\(\) => navigation\.replace\('VaultForgot'/,
    );
    // Site 2 — the success landing, all of whose branches must be inside it.
    const at = code.indexOf('armTimer(() => runWhenFocused(() => {');
    expect(at).toBeGreaterThan(-1);
    const body = code.slice(at, at + 420);
    expect(body).toMatch(/navigation\.replace\('Files'\)/);
    expect(body).toMatch(/navigation\.replace\('VaultScreen'\)/);
    expect(body).toMatch(/\}\), 700\);/);
  });
});

describe('B-872/N6 — every tab navigator STATES its backBehavior', () => {
  // Relying on the framework default is exactly the drift DepartmentalNavigator
  // warns about: a later "harmonise with MainNavigator" (which sets
  // "initialRoute") silently re-roots someone else's back press.
  const TAB_NAVIGATORS = [
    'src/navigation/CpoNavigator.tsx',
    'src/navigation/DepartmentalNavigator.tsx',
    'src/navigation/MainNavigator.tsx',
    'src/navigation/SecureTabNavigator.tsx',
  ];
  it.each(TAB_NAVIGATORS)('%s', file => {
    const code = src(file);
    const at = code.indexOf('<Tab.Navigator');
    expect(at).toBeGreaterThan(-1);
    // The OPENING TAG only — a `backBehavior` mentioned anywhere else in the
    // file (a helper, another navigator) must not satisfy this.
    const end = code.indexOf('<Tab.Screen', at);
    expect(end).toBeGreaterThan(at);
    expect(code.slice(at, end)).toMatch(/backBehavior="/);
  });

  it('the CPO tabs keep firstRoute (the four modules return to CpoDuty)', () => {
    const code = src('src/navigation/CpoNavigator.tsx');
    expect(code).toMatch(/backBehavior="firstRoute"/);
  });
});
