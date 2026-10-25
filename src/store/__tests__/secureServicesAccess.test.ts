/**
 * 2026-10-25 (owner) — Secure Services is for paid plans. The app shows it
 * locked for a free-plan client (server truth: /auth/me plan_locked_modules)
 * and every product switch into it asks to upgrade instead.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const mockAlert = jest.fn();
jest.mock('@utils/alert', () => ({Alert: {alert: (...a: unknown[]) => mockAlert(...a)}}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true, default: {getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined},
}));
let mockUser: Record<string, unknown> | null = null;
jest.mock('@store/authStore', () => ({useAuthStore: {getState: () => ({user: mockUser})}}));

import {secureServicesLocked} from '../secureServicesAccess';
import {switchProduct, useProductStore} from '../productStore';

const read = (...p: string[]) => readFileSync(join(process.cwd(), 'src', ...p), 'utf8');

describe('secureServicesLocked', () => {
  it('follows the server list; an older server (no list) never locks', () => {
    expect(secureServicesLocked({plan_locked_modules: ['secure_lite', 'secure_pro']} as never)).toBe(true);
    expect(secureServicesLocked({plan_locked_modules: []} as never)).toBe(false);
    expect(secureServicesLocked({} as never)).toBe(false);
    expect(secureServicesLocked(null)).toBe(false);
  });
});

describe('switching into Secure Services', () => {
  beforeEach(() => { mockAlert.mockClear(); useProductStore.getState().setActiveProduct('messenger'); });

  it('free plan: refused with an upgrade prompt; "View plans" opens the plans', () => {
    mockUser = {plan_locked_modules: ['secure_lite']};
    expect(switchProduct('secure')).toBe(false);
    expect(useProductStore.getState().activeProduct).toBe('messenger');
    const [title, , buttons] = mockAlert.mock.calls[0] as [string, string, Array<{text: string; onPress?: () => void}>];
    expect(title).toMatch(/paid plan/);
    buttons.find(b => b.text === 'View plans')!.onPress!();
    expect(useProductStore.getState().landing).toBe('plans');
    useProductStore.getState().clearLanding();
  });

  it('paid plan: switches', () => {
    mockUser = {plan_locked_modules: []};
    expect(switchProduct('secure')).toBe(true);
    expect(useProductStore.getState().activeProduct).toBe('secure');
  });
});

describe('where the app shows it', () => {
  it('welcome page: locked card with UPGRADE, tap explains', () => {
    const src = read('screens', 'auth', 'ProductGateScreen.tsx');
    expect(src).toMatch(/if \(card === 'secure' && secureLocked\) \{\s*promptSecureServicesUpgrade\(/);
    expect(src).toMatch(/UPGRADE/);
  });
  it('a saved Secure Services product is moved to Messenger on the free plan', () => {
    const src = read('navigation', 'MainNavigator.tsx');
    expect(src).toMatch(/if \(!secureLocked \|\| activeProduct !== 'secure'\) \{return;\}\s*useProductStore\.getState\(\)\.setActiveProduct\('messenger'\);/);
  });
  it('/auth/me plan_locked_modules reaches the user on every refresh', () => {
    const src = read('store', 'authStore.ts');
    expect((src.match(/identity_document_required, plan_locked_modules\} = await authApi\.me\(\);/g) ?? []).length).toBe(4);
    expect(src).toMatch(/plan_locked_modules: kind\?\.plan_locked_modules,/);
    expect(src).toMatch(/plan_locked_modules: u\.plan_locked_modules,/);
  });
});
