/**
 * 2026-10-25 — owner: "I don't have an option to go back. I need a back sign
 * everywhere whenever required." Every screen that used to trap the user (no
 * arrow, Android back closed the app) now has a working back. On a gate with
 * nothing behind it, back offers to sign out (→ sign-in screen) or takes the
 * gate's own "not now" exit.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const mockAlert = jest.fn();
const mockSignOut = jest.fn(async () => undefined);
jest.mock('@utils/alert', () => ({Alert: {alert: (...a: unknown[]) => mockAlert(...a)}}));
jest.mock('@store/authStore', () => ({useAuthStore: {getState: () => ({signOut: mockSignOut})}}));

import {confirmLeaveToSignIn, DEFAULT_LEAVE_COPY} from '../gateExit';

const read = (...p: string[]): string => readFileSync(join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const strip = (src: string): string => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

describe('confirmLeaveToSignIn', () => {
  beforeEach(() => { mockAlert.mockClear(); mockSignOut.mockClear(); });

  it('asks first and signs out only on "Sign out"', () => {
    confirmLeaveToSignIn();
    expect(mockAlert).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = mockAlert.mock.calls[0] as [string, string, Array<{text: string; onPress?: () => void}>];
    expect(title).toBe(DEFAULT_LEAVE_COPY.title);
    expect(message).toBe(DEFAULT_LEAVE_COPY.message);
    expect(buttons.map(b => b.text)).toEqual(['Stay', 'Sign out']);
    expect(mockSignOut).not.toHaveBeenCalled();
    buttons[1].onPress?.();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('takes per-screen wording', () => {
    confirmLeaveToSignIn({title: 'Leave activation?', message: 'x'});
    expect(mockAlert.mock.calls[0].slice(0, 2)).toEqual(['Leave activation?', 'x']);
  });
});

describe('product chooser: back returns to the current product', () => {
  it('closeGate hides a re-opened gate and keeps the product', () => {
    jest.isolateModules(() => {
      jest.doMock('@react-native-async-storage/async-storage', () => ({
        __esModule: true, default: {getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined},
      }));
      const {useProductStore} = require('@store/productStore') as typeof import('@store/productStore');
      useProductStore.getState().setActiveProduct('messenger');
      useProductStore.getState().requestGate();
      expect(useProductStore.getState().gateVisible).toBe(true);
      useProductStore.getState().closeGate();
      expect(useProductStore.getState().gateVisible).toBe(false);
      expect(useProductStore.getState().activeProduct).toBe('messenger');
    });
  });

  it('the chooser shows an arrow: product → closeGate, first choice → sign out', () => {
    const src = strip(read('screens', 'auth', 'ProductGateScreen.tsx'));
    expect(src).toMatch(/if \(activeProduct\) \{useProductStore\.getState\(\)\.closeGate\(\); return;\}\s*confirmLeaveToSignIn\(\)/);
    expect(src).toMatch(/<TouchableOpacity style=\{styles\.backBtn\} onPress=\{onBack\}/);
  });
});

describe('every former trap has a back', () => {
  it('provider registration wizard: step 1 with nothing behind offers to sign out', () => {
    const src = strip(read('screens', 'agent', 'AgentRegistrationWizardScreen.tsx'));
    expect(src).toMatch(/canPop \? \(\) => navigation\.goBack\(\) : \(\) => confirmLeaveToSignIn\(/);
    expect(src).not.toMatch(/canPop \? \(\) => navigation\.goBack\(\) : undefined/);
  });

  it('admin approval wait: arrow and Android back both offer sign out, never a pop', () => {
    const src = strip(read('screens', 'agent', 'AgentAdminApprovalScreen.tsx'));
    expect(src).toMatch(/onBack=\{confirmSignOut\}/);
    expect(src).toMatch(/addEventListener\('hardwareBackPress', \(\) => \{ confirmSignOutRef\.current\(\); return true; \}\)/);
  });

  it('managed-CPO "Checking your status…" offers Try again and Back to sign in', () => {
    const src = strip(read('navigation', 'CpoOnboardingNavigator.tsx'));
    expect(src).toMatch(/Try again/);
    expect(src).toMatch(/Back to sign in/);
    expect(src).toMatch(/useScreenHardwareBack\(\(\) => \{ confirmLeaveToSignIn\(\); return true; \}\)/);
  });

  it('booking search: back leaves without cancelling (popToTop), arrow + Android key', () => {
    const src = strip(read('screens', 'booking', 'FindingDetailScreen.tsx'));
    expect(src).toMatch(/<TouchableOpacity style=\{\[s\.backBtn/);
    expect(src).toMatch(/onPress=\{leave\}/);
    const at = src.indexOf("addEventListener('hardwareBackPress'");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 200)).toMatch(/popToTop\(\)/);
    const leave = src.slice(src.indexOf('const leave = useCallback'), src.indexOf('const leave = useCallback') + 200);
    expect(leave).not.toMatch(/doCancel|onCancel/);
  });

  it('sign-in screen draws a back arrow when it was pushed', () => {
    const src = strip(read('screens', 'auth', 'LoginScreen.tsx'));
    expect(src).toMatch(/navigation\.canGoBack\(\) \? \(\s*<TouchableOpacity style=\{\[styles\.backBtn/);
  });

  it('plan offer after sign-up: arrow and Android back = "Start free today"', () => {
    const src = strip(read('screens', 'pro', 'TierPaywall.tsx'));
    expect(src).toMatch(/onPress=\{standalone \? \(\) => onDone\(false\) : onBack\}/);
    expect(src).toMatch(/useGateHardwareBack\(\(\) => \{ if \(!busy\) \{onDone\(false\);\} return true; \}, standalone\)/);
  });

  it('identity step after sign-up: arrow and Android back = "Do this later"', () => {
    const src = strip(read('screens', 'settings', 'IdentityDocumentScreen.tsx'));
    expect(src).toMatch(/\{gateMode \? \(\s*<TouchableOpacity\s+style=\{s\.back\}\s+onPress=\{onDone\}/);
    expect(src).toMatch(/useGateHardwareBack\(\(\) => \{ onDone\?\.\(\); return true; \}, gateMode\)/);
  });

  it('credits intro: arrow and Android back skip it', () => {
    const src = strip(read('screens', 'wallet', 'CreditsIntroScreen.tsx'));
    expect(src).toMatch(/<TouchableOpacity style=\{styles\.backBtn\} onPress=\{onDone\}/);
    expect(src).toMatch(/useGateHardwareBack\(\(\) => \{ onDone\(\); return true; \}\)/);
  });
});
