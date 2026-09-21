/**
 * B-870 (founder, 2026-09-12) — "when he goes to Channels he sees invitation
 * and upgrade plan. When he is on the plan page and tries to go back, he goes
 * back to the Secure Services page. The navigation thing is broken."
 *
 * THE ROUTE PATH. The Channels gate's "View Enterprise plans" button calls
 * `openEnterprisePricing` → `openPricing`, which is a ROOT dispatch:
 * `Main → SecureTab → {screen: 'Pricing', initial: false}`. That moves the user
 * off the MessengerTab they were on and pushes Pricing onto BookingNavigator's
 * stack, whose root is `BookingHome` — the screen titled "SECURE SERVICES".
 * `PricingScreen`'s back was a plain `goBackOnce(navigation)` pop, so it could
 * only ever land there. Nothing was stamped and nothing was honoured: B-816's
 * `returnTab` is stamped by `openJoinFlowScreen`'s DEPARTMENTAL tab hop alone,
 * and this door never went through it.
 *
 * The fix is the same shape one level up: the hop that changes which ROOT TAB
 * the user is on stamps the tab they came FROM, and this hook returns there.
 *
 * RED-first: before the fix `usePricingBack` did not exist and the screen wired
 * `onPress={() => goBackOnce(navigation)}` with no hardware handler at all.
 */
import React from 'react';
import {Text, BackHandler} from 'react-native';
import {render, fireEvent} from '@testing-library/react-native';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const mockGoBack = jest.fn();
const mockTabNavigate = jest.fn();
let mockParams: {only?: string; returnTab?: string} | undefined;
let mockTabs: unknown;
let mockNav: unknown;

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNav,
  useRoute: () => ({params: mockParams}),
  useFocusEffect: (cb: () => void | (() => void)) => {
    const R = require('react');
    R.useEffect(() => cb(), [cb]);
  },
  CommonActions: {navigate: jest.fn()},
}));
jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));
// departmentalEntry pulls navigationRef in, which would build a real container
// ref against the mocked navigation module.
jest.mock('@navigation/navigationRef', () => ({
  navigationRef: {isReady: () => false, dispatch: jest.fn()},
  mountedTreeHasRoute: () => false,
}));

import {usePricingBack} from '../pricingBack';

function Screen() {
  const onBack = usePricingBack();
  return <Text onPress={onBack}>back</Text>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = undefined;
  /** The ROOT tab navigator — the one that registers MessengerTab. */
  mockTabs = {
    navigate: mockTabNavigate,
    getParent: () => undefined,
    getState: () => ({routeNames: ['MessengerTab', 'SecureTab', 'ProfileTab']}),
  };
  /** BookingNavigator's stack, where Pricing actually lives. */
  mockNav = {
    goBack: mockGoBack,
    navigate: jest.fn(),
    getParent: () => mockTabs,
    getState: () => ({routeNames: ['BookingHome', 'Pricing', 'TierPaywall']}),
  };
});

describe('usePricingBack', () => {
  /** Today's behaviour for every door that did not stamp — unchanged. */
  it('with no returnTab it is the plain guarded pop, and registers no hardware handler', () => {
    const add = jest.spyOn(BackHandler, 'addEventListener');
    const u = render(<Screen />);
    fireEvent.press(u.getByText('back'));
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockTabNavigate).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    add.mockRestore();
  });

  it('THE BUG: with returnTab: MessengerTab the chevron pops AND returns to that tab', () => {
    mockParams = {only: 'enterprise', returnTab: 'MessengerTab'};
    const u = render(<Screen />);
    fireEvent.press(u.getByText('back'));
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockTabNavigate).toHaveBeenCalledWith('MessengerTab');
  });

  it('pops FIRST, then focuses the tab — order is the contract', () => {
    // Focusing the tab while Pricing is still on the SecureTab stack leaves it
    // there: the next entry into Secure pushes SecureLanding ON TOP of it and
    // the plan page is back in the user's way.
    const calls: string[] = [];
    mockParams = {returnTab: 'MessengerTab'};
    mockTabs = {
      navigate: (...a: unknown[]) => { calls.push(`tab:${String(a[0])}`); },
      getParent: () => undefined,
      getState: () => ({routeNames: ['MessengerTab', 'SecureTab']}),
    };
    mockNav = {
      goBack: () => { calls.push('pop'); },
      navigate: jest.fn(),
      getParent: () => mockTabs,
      getState: () => ({routeNames: ['BookingHome', 'Pricing']}),
    };
    const u = render(<Screen />);
    fireEvent.press(u.getByText('back'));
    expect(calls).toEqual(['pop', 'tab:MessengerTab']);
  });

  it('the HARDWARE key does the same, and is focus-scoped (N1 — removed on blur/unmount)', () => {
    mockParams = {returnTab: 'MessengerTab'};
    const remove = jest.fn();
    const add = jest.spyOn(BackHandler, 'addEventListener').mockReturnValue({remove} as never);
    const u = render(<Screen />);
    expect(add).toHaveBeenCalledWith('hardwareBackPress', expect.any(Function));
    const handler = add.mock.calls[0][1] as () => boolean;
    expect(handler()).toBe(true);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockTabNavigate).toHaveBeenCalledWith('MessengerTab');
    u.unmount();
    expect(remove).toHaveBeenCalled();
    add.mockRestore();
  });

  it('a stale returnTab no navigator registers still POPS — the press is never swallowed', () => {
    mockParams = {returnTab: 'NotATab'};
    const u = render(<Screen />);
    fireEvent.press(u.getByText('back'));
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockTabNavigate).not.toHaveBeenCalled();
  });

  /**
   * N2/B-261 — the repeat tap. `goBackOnce` swallows the second press inside
   * its window; the tab hop must be swallowed with it, or one accidental
   * double-tap pops once and ALSO jumps the user to another product.
   */
  it('a swallowed repeat tap does not hop the tab on its own', () => {
    mockParams = {returnTab: 'MessengerTab'};
    const u = render(<Screen />);
    fireEvent.press(u.getByText('back'));
    fireEvent.press(u.getByText('back'));
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockTabNavigate).toHaveBeenCalledTimes(1);
  });
});

/**
 * Wiring pin. The hook is worthless if the screen keeps its own pop, and the
 * hardware registration must be focus-scoped (NAV_RAPID_USE_LOOP N1): a
 * mount-scoped handler on Pricing eats the first back press of every screen
 * pushed above it (TierPaywall).
 */
describe('PricingScreen wires its back through the hook', () => {
  const strip = (s: string) => s
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const read = (rel: string) =>
    strip(readFileSync(join(process.cwd(), 'src', 'screens', 'settings', rel), 'utf8'));

  it('the chevron is the hook, not a hand-rolled pop', () => {
    const src = read('PricingScreen.tsx');
    expect(src).toMatch(/import \{usePricingBack\} from '\.\/pricingBack';/);
    expect(src).toMatch(/const onBack = usePricingBack\(\);/);
    expect(src).toMatch(/onPress=\{onBack\}/);
    // The pre-fix line, named so this pin cannot be satisfied by adding the
    // hook next to the old handler and leaving the old one wired.
    expect(src).not.toMatch(/onPress=\{\(\) => goBackOnce\(navigation\)\}/);
  });

  it('the hardware handler is registered INSIDE useFocusEffect (N1), never useEffect', () => {
    const src = read('pricingBack.ts');
    const at = src.indexOf("BackHandler.addEventListener('hardwareBackPress'");
    expect(at).toBeGreaterThan(-1);
    const before = src.slice(0, at);
    expect(before.lastIndexOf('useFocusEffect(')).toBeGreaterThan(before.lastIndexOf('useEffect('));
  });

  it('CANARY: the stripper is reading real code, not an empty string', () => {
    // A comment-stripping scan that silently reads nothing passes every
    // absence assertion above. Anchor on a line the screen keeps for its own
    // reasons.
    expect(read('PricingScreen.tsx')).toMatch(/subscriptionApi\.getPrices\(\)/);
  });
});
