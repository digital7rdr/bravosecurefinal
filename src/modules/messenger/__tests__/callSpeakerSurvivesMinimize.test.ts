/**
 * B-717 — the loudspeaker must survive a minimize.
 *
 * Founder: "in a call I turn the loudspeaker on, minimise it, and when I return
 * it is back on the phone speaker instead of the loudspeaker I chose."
 *
 * A minimize UNMOUNTS CallScreen (a `goBack`, not a background), so `isSpeaker`
 * — a plain `useState(isVideo)` — was reborn `false` on a voice call. The route
 * effect then computed `preferredRouteRef.current ?? (isSpeaker ? SPEAKER : EARPIECE)`
 * and applied EARPIECE on the restored mount, unconditionally and with no device
 * event needed. The toggle now rides the registry entry beside the CALL-N11
 * toggles (`isMuted`, `isVideoOff`, `facing`), which exist for this exact reason.
 *
 * ⚠️ WHY THE TOGGLE AND NOT THE ROUTE — a first cut of this fix persisted the
 * resolved route from `pickAudioRoute` and was GREEN while the bug reproduced
 * verbatim. `pickAudioRoute` has ONE call site: the route-picker SHEET. The
 * Speaker BUTTON on a voice call with no headset calls `setIsSpeaker(s => !s)`
 * (CallScreen: `if (hasExternalRoute) {setRoutePickerOpen(true);} else
 * {setIsSpeaker(...)}`), so `preferredRouteRef` stays null and the route write
 * never ran. Any future pin here must exercise the TOGGLE, or it pins nothing.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

jest.mock('../runtime/callAudioSession', () => ({
  startCallAudioSession: jest.fn(),
  stopCallAudioSession:  jest.fn(),
}));
jest.mock('../runtime/callForegroundService', () => ({
  startCallForegroundService: jest.fn(),
  stopCallForegroundService:  jest.fn(),
}));

import * as reg from '../runtime/callRegistry';
import type {ActiveCallSeed} from '../runtime/callRegistry';

/** Same shape as callRegistryIdentity.test.ts — `ActiveCallSeed` is
 *  `Omit<ActiveCallState,'gen'>`, so every non-optional field is required. */
function seed(callId: string): ActiveCallSeed {
  return {
    callId,
    conversationId: `direct:${callId}`,
    peer:           {userId: 'peer-1', deviceId: 1},
    peerName:       'Peer',
    kind:           'voice',
    direction:      'outgoing',
    controller:     null,
    signalling:     null,
    unregister:     null,
    localStream:    null,
    remoteStream:   null,
    audioTrack:     null,
    videoTrack:     null,
    state:          'connecting',
    isMinimized:    false,
    keepAlive:      false,
    connectedAtMs:  null,
  };
}

describe('B-717 — the speaker toggle survives minimize → restore', () => {
  afterEach(() => { reg.setActiveCall(null); });

  it('carries the toggle across a minimize', () => {
    const key = reg.setActiveCall(seed('call-spk'));
    reg.patchActiveCall(key, {isSpeaker: true});

    reg.setMinimized(key, true);
    expect(reg.getActiveCall()?.isMinimized).toBe(true);
    expect(reg.getActiveCall()?.isSpeaker).toBe(true);

    reg.setMinimized(key, false);
    expect(reg.getActiveCall()?.isSpeaker).toBe(true);
  });

  it('a fresh call inherits NOTHING — the media default still decides', () => {
    // The seed falls back to `isVideo`, so a stale `true` leaking into the next
    // call would open every voice call on the loudspeaker.
    const k1 = reg.setActiveCall(seed('call-1'));
    reg.patchActiveCall(k1, {isSpeaker: true});
    reg.setActiveCall(seed('call-2'));
    expect(reg.getActiveCall()?.isSpeaker).toBeUndefined();
  });

  it('a superseded screen cannot stamp its toggle onto a newer call', () => {
    reg.setActiveCall(seed('call-old'));
    const kNew = reg.setActiveCall(seed('call-new'));
    // The old screen's key no longer owns the slot — the registry drops it.
    reg.patchActiveCall({callId: 'call-old', gen: 0}, {isSpeaker: true});
    expect(reg.getActiveCall()?.callId).toBe('call-new');
    expect(reg.getActiveCall()?.isSpeaker).toBeUndefined();
    reg.patchActiveCall(kNew, {isSpeaker: true});
    expect(reg.getActiveCall()?.isSpeaker).toBe(true);
  });
});

describe('B-717 — CallScreen persists and restores the toggle', () => {
  const SRC = readFileSync(
    join(__dirname, '..', '..', '..', 'screens', 'messenger', 'CallScreen.tsx'),
    'utf8',
  );
  /** Strip comments — the prose here contains every token being asserted, so an
   *  unstripped scan would be decorative (CLAUDE.md's most common false pass). */
  const code = SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');

  it('seeds isSpeaker from the live call, falling back to the media default', () => {
    // The registry is reached through a lazy require here, matching this file's
    // idiom — a top-level named import shadows the local `getActiveCall` the
    // audio-session cleanup destructures, which eslint rejects.
    expect(code).toMatch(/reg\.getActiveCall\(\)\?\.isSpeaker\s*\?\?\s*isVideo/);
    // …and it must be the useState SEED, not a read somewhere else in the file.
    expect(code).toMatch(/const\s*\[isSpeaker,\s*setIsSpeaker\]\s*=\s*useState\(/);
  });

  it('persists the toggle where it is CONSUMED, so the picker path counts too', () => {
    // Anchored on the write itself, keyed. Writing it in the button handler
    // instead would miss the picker, which also moves `isSpeaker`.
    expect(code).toMatch(/patchActiveCall\(\s*\{\s*callId:\s*live\.callId,\s*gen:\s*live\.gen\s*\}\s*,\s*\{\s*isSpeaker\s*\}\s*\)/);
  });

  it('guards the write on the screen OWN callId', () => {
    // `getActiveCall()` returns whatever owns the slot now; a superseded screen
    // is still mounted during a handover and must not write through it.
    //
    // Anchored to the guard AND its write in ONE match. A bare
    // /live\.callId === callId/ passed even with the guard deleted, because the
    // minimize and teardown paths in this file use the identical shape — the
    // classic "assert the token exists somewhere in the file" false pass.
    expect(code).toMatch(
      /if\s*\(\s*live\s*&&\s*live\.callId\s*===\s*callId\s*\)\s*\{\s*patchActiveCall\(\s*\{\s*callId:\s*live\.callId,\s*gen:\s*live\.gen\s*\}\s*,\s*\{\s*isSpeaker\s*\}\s*\)/,
    );
  });

  it('the Speaker button still reaches the toggle — the path the fix depends on', () => {
    // If this ever stops being `setIsSpeaker`, the persist site moves with it.
    expect(code).toMatch(/hasExternalRoute\)\s*\{setRoutePickerOpen\(true\);\}\s*else\s*\{setIsSpeaker/);
  });
});
