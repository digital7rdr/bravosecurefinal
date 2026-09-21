/**
 * "No audio heard in audio/video calls."
 *
 * ONE InCallManager audio session, TWO call stacks reaching for it (1:1 via
 * callRegistry/CallScreen, group/SFU via groupCallRegistry/GroupCallScreen),
 * and neither knew the other existed. That broke the session both ways:
 *
 *   1. endActiveCall stopped it UNCONDITIONALLY. A stale 1:1 teardown — a
 *      missed call cleaning up, a late call.hangup frame — killed the session
 *      under a live group call. Ops Room joined, tiles rendering, silence.
 *
 *   2. endActiveGroupCall never stopped it AT ALL. CALL-N5 fixed exactly this
 *      in endActiveCall on 2026-07-02 and was never carried across, so ending
 *      a MINIMIZED group call (screen unmounted → its cleanup can't run) left
 *      the device pinned in MODE_IN_COMMUNICATION: earpiece routing, inert
 *      media volume, next call stacked on a session never torn down.
 *
 * The behavioural half is a real unit test — callAudioSession.ts is pure TS
 * with lazy requires. The wiring half has to be a source scan: the registries
 * and both screens pull in native modules the node project can't load.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime');
const SCREENS = join(process.cwd(), 'src', 'screens', 'messenger');

/** CODE only — prose naming a banned token is the classic false result here. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(l => {
      const t = l.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('{/*');
    })
    .join('\n');
}

describe('stopSharedAudioSession only stops when nobody else owns a call', () => {
  const MOD = '../runtime/callAudioSession';

  beforeEach(() => { jest.resetModules(); });

  /** Install fake registries + a spyable InCallManager, then load the module. */
  function harness(opts: {directLive: boolean; groupLive: boolean}) {
    const stop = jest.fn();
    jest.doMock('react-native-incall-manager', () => ({default: {stop}}));
    jest.doMock('../runtime/callRegistry', () => ({
      getActiveCall: () => (opts.directLive ? {callId: 'c1'} : null),
    }));
    jest.doMock('../runtime/groupCallRegistry', () => ({
      getActiveGroupCall: () => (opts.groupLive ? {roomId: 'r1'} : null),
    }));
    // B-719 — the `./callRegistry` / `./groupCallRegistry` duplicates that used
    // to live here are GONE, along with the `{virtual: true}` they needed.
    //
    // A NON-virtual mock is keyed by the RESOLVED PATH, so the two mocks above
    // already cover the consumer: `callAudioSession.ts` requires its siblings as
    // `./callRegistry`, which resolves to the same file as `../runtime/callRegistry`
    // does from here, so it lands on the same module id and gets the same factory.
    // The duplicates only existed because `virtual: true` keys by the LITERAL
    // specifier instead — and that flag is what made this suite a coin flip:
    // `jest-resolve`'s `getModuleID` cache key is `from + moduleName + options`
    // and omits `virtualMocks` entirely (resolver.js), so whichever suite in the
    // worker resolved a pair FIRST without a virtual mock registered permanently
    // memoised the real path, and every later `{virtual: true}` for that pair was
    // silently ignored. See sqa.md B-719.
    const {stopSharedAudioSession} = require(MOD) as typeof import('../runtime/callAudioSession');
    return {stopSharedAudioSession, stop};
  }

  it('a 1:1 call ending while a GROUP call is live does NOT stop the session', () => {
    // Bug 1. This is the one that produced "Ops Room joined, nobody audible".
    const {stopSharedAudioSession, stop} = harness({directLive: false, groupLive: true});
    expect(stopSharedAudioSession('direct')).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });

  it('a GROUP call ending while a 1:1 call is live does NOT stop the session', () => {
    const {stopSharedAudioSession, stop} = harness({directLive: true, groupLive: false});
    expect(stopSharedAudioSession('group')).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });

  it('a 1:1 call ending with nothing else live DOES stop the session', () => {
    const {stopSharedAudioSession, stop} = harness({directLive: false, groupLive: false});
    expect(stopSharedAudioSession('direct')).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('a GROUP call ending with nothing else live DOES stop the session', () => {
    // Bug 2 — this path used to not exist at all.
    const {stopSharedAudioSession, stop} = harness({directLive: false, groupLive: false});
    expect(stopSharedAudioSession('group')).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('the caller\'s OWN registry slot is not consulted', () => {
    // Callers invoke this mid-teardown, when their own slot may not be
    // cleared yet. Consulting it would make the stop never fire — which is
    // bug 2 all over again, just with extra steps.
    const {stopSharedAudioSession, stop} = harness({directLive: true, groupLive: false});
    expect(stopSharedAudioSession('direct')).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('a missing native module is not treated as a failure to stop', () => {
    jest.resetModules();
    jest.doMock('react-native-incall-manager', () => { throw new Error('native module missing'); });
    // B-719 — resolved-path specifiers, not the consumer's `./` form; see the
    // note in `harness` above.
    jest.doMock('../runtime/callRegistry', () => ({getActiveCall: () => null}));
    jest.doMock('../runtime/groupCallRegistry', () => ({getActiveGroupCall: () => null}));
    const {stopSharedAudioSession} = require(MOD) as typeof import('../runtime/callAudioSession');
    expect(() => stopSharedAudioSession('direct')).not.toThrow();
    expect(stopSharedAudioSession('direct')).toBe(false);
  });
});

describe('every stop site is routed through the arbiter (static source scan)', () => {
  const SITES = [
    join(RUNTIME, 'callRegistry.ts'),
    join(RUNTIME, 'groupCallRegistry.ts'),
    join(SCREENS, 'CallScreen.tsx'),
    join(SCREENS, 'GroupCallScreen.tsx'),
  ];

  it.each(SITES)('%s never calls InCallManager.stop() directly', path => {
    // A direct call bypasses the arbitration entirely, which is precisely how
    // both halves of this bug worked. bravoTones/route helpers are unaffected
    // — this is about stop() only.
    expect(code(path)).not.toMatch(/InCallManager\.stop\(\)/);
  });

  it('endActiveGroupCall stops the session — the CALL-N5 mirror', () => {
    // The whole of bug 2: this call did not exist. Without it, ending a
    // minimized group call leaves the device in MODE_IN_COMMUNICATION.
    const src = code(join(RUNTIME, 'groupCallRegistry.ts'));
    const at = src.indexOf('export async function endActiveGroupCall');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at)).toMatch(/stopSharedAudioSession\('group'\)/);
  });

  it('endActiveCall still stops the session, now arbitrated', () => {
    const src = code(join(RUNTIME, 'callRegistry.ts'));
    const at = src.indexOf('export function endActiveCall');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at)).toMatch(/stopSharedAudioSession\('direct'\)/);
  });

  it('each screen passes the owner matching its own stack', () => {
    // Swapping these would invert the arbitration and reintroduce both bugs
    // while every other assertion here still passed.
    expect(code(join(SCREENS, 'CallScreen.tsx'))).toMatch(/stopSharedAudioSession\('direct'\)/);
    expect(code(join(SCREENS, 'GroupCallScreen.tsx'))).toMatch(/stopSharedAudioSession\('group'\)/);
    expect(code(join(SCREENS, 'CallScreen.tsx'))).not.toMatch(/stopSharedAudioSession\('group'\)/);
    expect(code(join(SCREENS, 'GroupCallScreen.tsx'))).not.toMatch(/stopSharedAudioSession\('direct'\)/);
  });

  it('the arbiter does not import either registry at module scope', () => {
    // Both registries require IT, so a top-level import is a cycle.
    const src = code(join(RUNTIME, 'callAudioSession.ts'));
    expect(src).not.toMatch(/^import .*(callRegistry|groupCallRegistry)/m);
  });
});
