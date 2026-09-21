/**
 * OP-01 / OP-04 / OP-07 / OP-08 / OP-09 / OP-10 — the CLIENT half of the ops
 * propagation fixes (audit docs/audits/OPS_PROPAGATION_AND_FETCHING_AUDIT_2026-09-02.md).
 *
 *   OP-01  the pricing board is fetched for the zone being quoted (`?region=`)
 *   OP-08  pricing/catalog mirrors reload on FOCUS, never once per mount
 *   OP-04  the zone picker admits launched regions the compiled seed does not know
 *   OP-07  a `wallet-adjusted` wake refreshes the wallet and routes to Credits
 *   OP-09  a `compliance-decided` wake has copy + a tap route
 *   OP-10  Dept Chat v2 is read from /auth/me with the baked flag as fallback
 *
 * Screens mount RN views, so these are comment-stripped source scans (line-based
 * stripper — the greedy form misreads '*​/*' MIME strings; CRLF normalised).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

// The hook module reaches authStore → api → constants (an ESM env shim the
// node project cannot load — the B-153 rule: mock @utils/constants); the pure
// resolver is all this suite needs from it.
jest.mock('@utils/constants', () => ({DEPT_CHAT_V2: false}));
jest.mock('@store/authStore', () => ({useAuthStore: Object.assign(() => undefined, {getState: () => ({user: undefined})})}));

import {resolveDeptChatV2} from '@hooks/useDeptChatV2';
import {composeZoneCountries} from '@screens/booking/zoneCountries';

function code(rel: string[]): string {
  return readFileSync(join(process.cwd(), ...rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^[ \t]*\{?\/\*[\s\S]*?\*\/\}?[ \t]*$/gm, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

describe('OP-01 — the display board names its zone', () => {
  it('bookingApi.servicePricing forwards ?region= and the store loads per region on focus', () => {
    const api = code(['src', 'services', 'api.ts']);
    expect(api).toMatch(/servicePricing: \(region\?: string, point\?: \{lat: number; lng: number\}\) =>/);
    expect(api).toMatch(/point \? \{params: \{lat: point\.lat, lng: point\.lng\}\} : region \? \{params: \{region\}\} : undefined/);
    const store = code(['src', 'store', 'servicePricingStore.ts']);
    expect(store).toMatch(/export function useServicePricing\(zone\?: PricingZone \| null\)/);
    expect(store).toMatch(/useFocusEffect\(/);
    expect(store).toMatch(/bookingApi\.servicePricing\(region, point\)/);
    // Review round 2 — a zone switch resets to the compiled board before the
    // fetch, and a reply for anything but the latest zone is dropped.
    expect(store).toMatch(/if \(get\(\)\.zone !== key\) \{\s*setServicePricingOverrides\(\{\}\);/);
    expect(store).toMatch(/if \(latestRequested !== key\) \{return;\}/);
  });

  it('every pricing screen subscribes through the focus hook with the draft region', () => {
    for (const rel of [
      ['src', 'screens', 'booking', 'AddOnsScreen.tsx'],
      ['src', 'screens', 'booking', 'BaselinePackageScreen.tsx'],
      ['src', 'screens', 'booking', 'CustomizeAddOnsScreen.tsx'],
      ['src', 'screens', 'executive', 'ExecReviewScreen.tsx'],
      ['src', 'screens', 'executive', 'ExecTeamScreen.tsx'],
    ]) {
      const src = code(rel);
      // Keyed the way the CHARGE is: pickup point first, zone code before a pin.
      expect(src).toMatch(/useServicePricing\(\{\s*region: useBookingStore\(\w+ => \w+\.draft\.region\),\s*lat: useBookingStore\(\w+ => \w+\.draft\.pickup\?\.latitude \?\? null\),\s*lng: useBookingStore\(\w+ => \w+\.draft\.pickup\?\.longitude \?\? null\),\s*\}\)/);
      // The mount-only shape must not come back.
      expect(src).not.toMatch(/useEffect\(\(\) => \{ void loadServicePricing\(\); \}/);
    }
  });
});

describe('OP-08 — catalog copy reloads on focus', () => {
  it.each([
    ['src', 'screens', 'pro', 'TierPaywall.tsx'],
    ['src', 'screens', 'settings', 'PricingScreen.tsx'],
  ])('%s %s %s %s', (...rel) => {
    const src = code(rel);
    expect(src).toMatch(/useFocusEffect\(useCallback\(\(\) => \{ void loadPlanCatalog\(\); \}, \[loadPlanCatalog\]\)\)/);
    expect(src).not.toMatch(/useEffect\(\(\) => \{ void loadPlanCatalog\(\); \}/);
  });
});

describe('OP-04 — launched regions the seed does not know are selectable', () => {
  it('the picker appends live launched regions and derives the country groups from them', () => {
    const src = code(['src', 'screens', 'booking', 'ZoneMapScreen.tsx']);
    // Review round 2 — `launched` alone would admit BD (seeded launched, zero
    // CPOs); a live region needs a CPO pool to become selectable.
    expect(src).toMatch(/\.filter\(r => r\.available && r\.cpos_available > 0 && !REGION_SEED\.some\(s => s\.code === r\.code\)\)/);
    expect(src).toMatch(/setRegions\(\[\.\.\.seeded, \.\.\.extras\]\)/);
    expect(src).toMatch(/composeZoneCountries\(myCountry, activeCodes\)/);
  });

  it('composeZoneCountries honours a live active set and keeps the compiled floor as default', () => {
    const live = composeZoneCountries(null, ['AE', 'ZA', 'QA']);
    expect(live.active.map(c => c.code)).toEqual(expect.arrayContaining(['AE', 'ZA', 'QA']));
    expect(live.soon.some(c => c.code === 'QA')).toBe(false);
    const floor = composeZoneCountries(null);
    expect(floor.active.map(c => c.code).sort()).toEqual(['AE', 'ZA']);
  });
});

describe('OP-07 / OP-09 — the two new wakes have copy, a class, a route, and a side effect', () => {
  it('meta + activity class', () => {
    const src = code(['src', 'modules', 'messenger', 'push', 'serverWakeNotifications.ts']);
    expect(src).toMatch(/'wallet-adjusted':\s*\{title: 'Wallet updated'/);
    expect(src).toMatch(/'compliance-decided':\s*\{title: 'Credential reviewed'/);
    expect(src).toMatch(/kind === 'payout-settled' \|\| kind === 'wallet-adjusted'\) \{return 'payout';\}/);
    expect(src).toMatch(/kind === 'compliance-decided'\) \{return 'agent';\}/);
    /**
     * The wallet refresh fires at the DRAW site, not merely somewhere in the
     * file.
     *
     * B-859 RE-ANCHORED: this used to slice from the first
     * `if (opts?.recordActivity) {recordActivityForWake(kind` in the file, and
     * the attendance-ping branch added an EARLIER one — so the window landed
     * hundreds of lines above the draw and the pin failed for a reason that had
     * nothing to do with the wallet. Anchor on the call that can only be the
     * meta draw: it is the one that passes `meta.title, meta.body`.
     */
    const at = src.indexOf('recordActivityForWake(kind, meta.title, meta.body, data)');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 400)).toContain("if (kind === 'wallet-adjusted') {refreshWalletForWake();}");
    expect(src).toMatch(/useWalletStore\.getState\(\)\.loadBalance\(\)/);
  });

  it('tap routes', () => {
    const src = code(['src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts']);
    // Review round 2 — a client's Credits screen lives in the LAZY Booking
    // stack, so the shell-nested (BB-3) candidate leads; the CPO shell owns
    // neither compliance surface, so CpoMe is its landing.
    expect(src).toMatch(/kind === 'wallet-adjusted'\) \{[\s\S]{0,400}?\{name: 'SecureTab', params: \{screen: 'Credits', initial: false\}\},\s*\{name: 'Credits'\},\s*\{name: 'CpoMe'\}/);
    expect(src).toMatch(/kind === 'compliance-decided'\) \{[\s\S]{0,400}?candidates = \[\{name: 'OrgCompliance'\}, \{name: 'CpoMe'\}, \{name: 'AgentDashboard'\}\]/);
  });
});

describe('OP-10 — Dept Chat v2 is server-driven with the baked flag as fallback', () => {
  it('resolveDeptChatV2 prefers the server value and falls back only on undefined', () => {
    expect(resolveDeptChatV2(true)).toBe(true);
    expect(resolveDeptChatV2(false)).toBe(false);
    // undefined → the baked EXPO_PUBLIC_DEPT_CHAT_V2 (false in the test env).
    expect(typeof resolveDeptChatV2(undefined)).toBe('boolean');
  });

  it('no gated surface reads the baked constant directly any more', () => {
    for (const rel of [
      ['src', 'navigation', 'CpoNavigator.tsx'],
      ['src', 'screens', 'cpo', 'OnDutyHomeScreen.tsx'],
      ['src', 'screens', 'messenger', 'GroupsScreen.tsx'],
      ['src', 'screens', 'messenger', 'MessengerHomeScreen.tsx'],
      ['src', 'screens', 'agent', 'AgentDashboardScreen.tsx'],
    ]) {
      const src = code(rel);
      expect(src).not.toMatch(/\bDEPT_CHAT_V2\b/);
      expect(src).toMatch(/const deptChatV2 = useDeptChatV2\(\);/);
    }
    const auth = code(['src', 'store', 'authStore.ts']);
    expect(auth).toMatch(/dept_chat_v2_enabled: kind\?\.dept_chat_v2_enabled,/);
    expect(auth).toMatch(/dept_chat_v2_enabled: u\.dept_chat_v2_enabled,/);
    // Review round 2 — the field was mapped in toUser but never DESTRUCTURED
    // from /auth/me at the four call sites, so the hook always fell back to
    // the baked flag. Each site destructures AND forwards it (8 mentions).
    const carried = auth.match(/auto_dispatch_enabled, dept_chat_v2_enabled, owns_workspace/g) ?? [];
    expect(carried.length).toBe(8);
  });
});
