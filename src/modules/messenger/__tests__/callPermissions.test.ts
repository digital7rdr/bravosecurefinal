/**
 * PG-C4 — one runtime-permission prompt at a time.
 *
 * Android answers a second `requestPermissions` raised while a dialog is up
 * with an EMPTY result, which RN reports as DENIED. The call screens and
 * `getLocalMedia` both prompt on a first-ever call; this helper single-flights
 * them. A source scan proves all three sites go through it.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const mockCheck = jest.fn(async (_p: string) => false);
let activePrompts = 0;
let maxConcurrentPrompts = 0;
const promptGate: Array<(deny?: boolean) => void> = [];
const mockRequestMultiple = jest.fn((perms: string[]) => new Promise<Record<string, string>>(resolve => {
  activePrompts += 1;
  maxConcurrentPrompts = Math.max(maxConcurrentPrompts, activePrompts);
  promptGate.push((deny?: boolean) => {
    activePrompts -= 1;
    resolve(Object.fromEntries(perms.map(p => [p, deny ? 'denied' : 'granted'])));
  });
}));

jest.mock('react-native', () => ({
  Platform: {OS: 'android'},
  PermissionsAndroid: {
    RESULTS: {GRANTED: 'granted'},
    check: (p: string) => mockCheck(p),
    requestMultiple: (perms: string[]) => mockRequestMultiple(perms),
  },
}));

import {requestCallPermissions, __resetCallPermissionsForTests} from '../webrtc/callPermissions';

const MIC = 'android.permission.RECORD_AUDIO';
const CAM = 'android.permission.CAMERA';
const BT  = 'android.permission.BLUETOOTH_CONNECT';

async function flush(): Promise<void> { for (let i = 0; i < 10; i++) {await Promise.resolve();} }

beforeEach(() => {
  __resetCallPermissionsForTests();
  mockCheck.mockReset();
  mockCheck.mockImplementation(async () => false);
  mockRequestMultiple.mockClear();
  activePrompts = 0;
  maxConcurrentPrompts = 0;
  promptGate.length = 0;
});

describe('PG-C4 — requestCallPermissions', () => {
  it('two concurrent callers never overlap prompts; the second re-checks and prompts only for the remainder', async () => {
    const a = requestCallPermissions([MIC, BT]);       // the screen
    await flush();
    const b = requestCallPermissions([MIC, CAM]);      // getLocalMedia, racing
    await flush();
    expect(mockRequestMultiple).toHaveBeenCalledTimes(1);
    expect(mockRequestMultiple.mock.calls[0][0]).toEqual([MIC, BT]);
    // The first dialog is answered → the mic is now granted for the re-check.
    mockCheck.mockImplementation(async (p: string) => p === MIC || p === BT);
    promptGate.shift()!();
    const ra = await a;
    await flush();
    // B woke, re-checked, and prompted ONLY for the camera.
    expect(mockRequestMultiple).toHaveBeenCalledTimes(2);
    expect(mockRequestMultiple.mock.calls[1][0]).toEqual([CAM]);
    promptGate.shift()!();
    const rb = await b;
    expect(maxConcurrentPrompts).toBe(1);
    expect(ra).toEqual({[MIC]: 'granted', [BT]: 'granted'});
    expect(rb).toEqual({[MIC]: 'granted', [CAM]: 'granted'});
  });

  it('PG-C4r — a permission the first dialog DENIED is answered for the waiter, never re-prompted', async () => {
    const a = requestCallPermissions([MIC]);
    await flush();
    const b = requestCallPermissions([MIC, CAM]);
    await flush();
    promptGate.shift()!(true);                 // the user DENIES the mic
    const ra = await a;
    await flush();
    // B took the denial as answered and prompted ONLY for the camera —
    // re-prompting a just-denied permission burns Android's ask-twice budget.
    expect(mockRequestMultiple).toHaveBeenCalledTimes(2);
    expect(mockRequestMultiple.mock.calls[1][0]).toEqual([CAM]);
    promptGate.shift()!();
    const rb = await b;
    expect(ra).toEqual({[MIC]: 'denied'});
    expect(rb).toEqual({[MIC]: 'denied', [CAM]: 'granted'});
  });

  it('already-granted permissions never prompt (Audit Step 2.3 kept)', async () => {
    mockCheck.mockImplementation(async () => true);
    const r = await requestCallPermissions([MIC, CAM]);
    expect(mockRequestMultiple).not.toHaveBeenCalled();
    expect(r).toEqual({[MIC]: 'granted', [CAM]: 'granted'});
  });

  it('a failing check() falls back to prompting for everything (fail safe, B-340)', async () => {
    mockCheck.mockImplementation(async () => { throw new Error('unsupported'); });
    const p = requestCallPermissions([MIC]);
    await flush();
    expect(mockRequestMultiple).toHaveBeenCalledWith([MIC]);
    promptGate.shift()!();
    await p;
  });

  it('every call-permission site goes through the helper (no bare requestMultiple outside it)', () => {
    const root = process.cwd();
    const sites = [
      join(root, 'src', 'screens', 'messenger', 'CallScreen.tsx'),
      join(root, 'src', 'screens', 'messenger', 'GroupCallScreen.tsx'),
      join(root, 'src', 'modules', 'messenger', 'webrtc', 'peerConnectionFactory.ts'),
    ];
    for (const f of sites) {
      const src = readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
      expect(src).toMatch(/requestCallPermissions\(/);
      expect(src).not.toMatch(/PermissionsAndroid\.requestMultiple\(/);
    }
  });
});
