/**
 * B-776 — the receive-side foreground hold (receiveForegroundHold.ts).
 *
 * Pins:
 *  - a backgrounded process asks native to start on EVERY hold (native owns
 *    the truth: a refused start must not block a later one inside the push
 *    window — critic F1) and stops on the LAST release (refcount);
 *  - the UI on screen ('active') never starts it — the process is top-app;
 *  - a missing native module (iOS / unbuilt / web) is a no-op, never a throw;
 *  - a native start that throws leaves the receive unheld and still lets the
 *    matching release run without a second throw;
 *  - releasing twice is idempotent;
 *  - a hold older than RECEIVE_HOLD_MAX_MS is evicted so a wedged receive
 *    cannot pin the count for the process lifetime (critic F2).
 */
const mockStart = jest.fn();
const mockStop = jest.fn();
const mockEnv = {appState: 'background', nativeModules: {} as Record<string, unknown>};

jest.mock('react-native', () => ({
  Platform: {OS: 'android'},
  AppState: {get currentState() { return mockEnv.appState; }},
  get NativeModules() { return mockEnv.nativeModules; },
}));

import {
  holdReceiveForeground,
  activeReceiveHolds,
  isReceiveHoldActive,
  RECEIVE_HOLD_MAX_MS,
  _resetReceiveHoldForTests,
} from '../push/receiveForegroundHold';

describe('receiveForegroundHold (B-776)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetReceiveHoldForTests();
    mockEnv.appState = 'background';
    mockEnv.nativeModules = {BravoMessageSync: {start: mockStart, stop: mockStop}};
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => { (console.warn as jest.Mock).mockRestore(); jest.useRealTimers(); });

  it('backgrounded: every hold asks native to start (watchdog re-arm), the last release stops it', () => {
    const r1 = holdReceiveForeground('ws');
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockStart.mock.calls[0][0]).toEqual({body: 'Checking for new messages…', maxMs: RECEIVE_HOLD_MAX_MS});
    expect(isReceiveHoldActive()).toBe(true);
    const r2 = holdReceiveForeground('warm-wake');
    expect(mockStart).toHaveBeenCalledTimes(2); // native decides: a running service is only re-armed
    expect(activeReceiveHolds()).toBe(2);
    r1();
    expect(mockStop).not.toHaveBeenCalled(); // one hold still live
    r2();
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(isReceiveHoldActive()).toBe(false);
    expect(activeReceiveHolds()).toBe(0);
  });

  it('a refused first start (thrown) does not block the later start inside the push window', () => {
    mockStart.mockImplementationOnce(() => { throw new Error('ForegroundServiceStartNotAllowedException'); });
    const r1 = holdReceiveForeground('ws');       // socket lane, before the wake — refused
    expect(isReceiveHoldActive()).toBe(false);
    const r2 = holdReceiveForeground('warm-wake'); // the wake — must ask again
    expect(mockStart).toHaveBeenCalledTimes(2);
    expect(isReceiveHoldActive()).toBe(true);
    r1();
    expect(mockStop).not.toHaveBeenCalled();
    r2();
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it('UI on screen: never starts the service and the release is a no-op', () => {
    mockEnv.appState = 'active';
    const release = holdReceiveForeground('ws');
    expect(mockStart).not.toHaveBeenCalled();
    release();
    expect(mockStop).not.toHaveBeenCalled();
    expect(activeReceiveHolds()).toBe(0);
  });

  it("'unknown' app state (headless VM) counts as backgrounded and holds", () => {
    mockEnv.appState = 'unknown';
    const release = holdReceiveForeground('headless-wake');
    expect(mockStart).toHaveBeenCalledTimes(1);
    release();
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it('native module absent: no-op, no throw', () => {
    mockEnv.nativeModules = {};
    const release = holdReceiveForeground('ws');
    expect(mockStart).not.toHaveBeenCalled();
    expect(() => release()).not.toThrow();
    expect(activeReceiveHolds()).toBe(0);
  });

  it('double release is idempotent and cannot drive the count negative', () => {
    const r1 = holdReceiveForeground('ws');
    const r2 = holdReceiveForeground('ws');
    r1(); r1(); r1();
    expect(activeReceiveHolds()).toBe(1);
    expect(mockStop).not.toHaveBeenCalled();
    r2();
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(activeReceiveHolds()).toBe(0);
  });

  it('native stop throwing is swallowed and the state still clears', () => {
    mockStop.mockImplementationOnce(() => { throw new Error('dead binder'); });
    const release = holdReceiveForeground('ws');
    expect(() => release()).not.toThrow();
    expect(isReceiveHoldActive()).toBe(false);
  });

  it('a hold that never releases is evicted after RECEIVE_HOLD_MAX_MS and cannot pin the count', () => {
    jest.useFakeTimers().setSystemTime(1_000_000);
    holdReceiveForeground('ws'); // wedged — never released
    expect(activeReceiveHolds()).toBe(1);
    jest.setSystemTime(1_000_000 + RECEIVE_HOLD_MAX_MS + 1);
    const r2 = holdReceiveForeground('drain');
    expect(activeReceiveHolds()).toBe(1); // the stale one was evicted, only r2 counts
    expect(isReceiveHoldActive()).toBe(true);
    r2();
    expect(mockStop).toHaveBeenCalledTimes(1); // the count reached 0 → the service is stopped
    expect(activeReceiveHolds()).toBe(0);
  });
});
