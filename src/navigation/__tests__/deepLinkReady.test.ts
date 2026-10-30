/**
 * Owner 2026-10-31 — "If a notification appears in the phone's notification
 * panel and you tap it, the phone does not open to the notification's
 * location". Cold start: `isReady()` is true while the Auth placeholder is up,
 * and a navigate issued then is dropped. Taps now wait for the real shell.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

let mockReady = true;
let mockMounted: string[] = [];
jest.mock('../navigationRef', () => ({
  navigationRef: {isReady: () => mockReady},
  mountedTreeHasRoute: (r: string) => mockMounted.includes(r),
}));

const mockAuth: {isAuthenticated: boolean; user: Record<string, unknown> | null} = {isAuthenticated: false, user: null};
jest.mock('@store/authStore', () => ({useAuthStore: {getState: () => mockAuth}}));

const mockProduct = {
  activeProduct: 'secure' as string | null,
  gateVisible: false,
  enterMessenger: jest.fn(() => { mockProduct.activeProduct = 'messenger'; mockProduct.gateVisible = false; }),
  closeGate: jest.fn(() => { mockProduct.gateVisible = false; }),
  setActiveProduct: jest.fn((p: string) => { mockProduct.activeProduct = p; }),
};
jest.mock('@store/productStore', () => ({useProductStore: {getState: () => mockProduct}}));

import {shellEntryRoute, shellForUser, waitForShellReady} from '../deepLinkReady';

const client = {role: 'individual', account_kind: 'individual'};

beforeEach(() => {
  mockReady = true; mockMounted = [];
  mockAuth.isAuthenticated = false; mockAuth.user = null;
  mockProduct.activeProduct = 'secure'; mockProduct.gateVisible = false;
  jest.clearAllMocks();
});

describe('shell entry routes', () => {
  it('each shell has the route that proves it is mounted', () => {
    expect(shellEntryRoute('client')).toBe('MessengerTab');
    expect(shellEntryRoute('agency')).toBe('MessengerHome');
    expect(shellEntryRoute('cpo')).toBe('CpoTabs');
    expect(shellEntryRoute('access-ended')).toBeNull();
    expect(shellEntryRoute('cpo-activation')).toBeNull();
  });

  it('a workspace manager is a client, an agency is an agency', () => {
    expect(shellForUser({...client, is_org_manager: true, is_agency_manager: false, workspaces: [{}]})).toBe('client');
    expect(shellForUser({role: 'service_provider', account_kind: 'agency'})).toBe('agency');
  });
});

describe('waitForShellReady', () => {
  it('does NOT resolve while only the cold-start Auth placeholder is mounted', async () => {
    mockMounted = ['Auth'];
    expect(await waitForShellReady({lane: 'messenger', timeoutMs: 400})).toBe(false);
  });

  it('resolves once the user is known and the client tab tree is mounted', async () => {
    mockMounted = ['Auth'];
    setTimeout(() => { mockAuth.isAuthenticated = true; mockAuth.user = client; mockMounted = ['Main', 'MessengerTab', 'SecureTab']; }, 200);
    expect(await waitForShellReady({lane: 'messenger', timeoutMs: 3000})).toBe(true);
  });

  it('a messenger tap on the product chooser opens Messenger first', async () => {
    mockAuth.isAuthenticated = true; mockAuth.user = client;
    mockProduct.gateVisible = true;
    setTimeout(() => { mockMounted = ['MessengerTab']; }, 200);
    expect(await waitForShellReady({lane: 'messenger', timeoutMs: 3000})).toBe(true);
    expect(mockProduct.enterMessenger).toHaveBeenCalledWith(null);
  });

  it('a Secure Services tap on the chooser just closes it (product kept)', async () => {
    mockAuth.isAuthenticated = true; mockAuth.user = client;
    mockProduct.gateVisible = true;
    setTimeout(() => { mockMounted = ['MessengerTab']; }, 100);
    expect(await waitForShellReady({lane: 'secure', timeoutMs: 3000})).toBe(true);
    expect(mockProduct.closeGate).toHaveBeenCalled();
    expect(mockProduct.enterMessenger).not.toHaveBeenCalled();
  });

  it('an account with no openable shell gives up at once', async () => {
    mockAuth.isAuthenticated = true; mockAuth.user = {role: 'cpo', account_kind: 'cpo', must_set_password: true};
    expect(await waitForShellReady({lane: 'messenger', timeoutMs: 3000})).toBe(false);
  });
});

describe('every notification-tap lane waits for the shell', () => {
  const src = readFileSync(join(process.cwd(), 'src/modules/messenger/push/fcmBootstrap.ts'), 'utf8');
  it('chats/groups/channels, missed calls, workspace join, server wakes and incidents', () => {
    const waits = src.match(/waitForShellReady\(\{lane: /g) ?? [];
    expect(waits.length).toBeGreaterThanOrEqual(5);
    expect(src).toMatch(/waitForShellReady\(\{lane: 'messenger', timeoutMs: NAV_READY_WAIT_MS\}\)\)\) \{\s*console\.warn\('\[notifee\] shell not ready after 20s — msg deep-link/);
    expect(src).toMatch(/waitForShellReady\(\{lane: SECURE_KINDS_LANE\(kind\), timeoutMs: 20_000\}\)/);
  });
});
