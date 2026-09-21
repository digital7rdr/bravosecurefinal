/**
 * PG-C1 — the Speaker button must work after a headset leaves.
 *
 * The auto-snap pinned `preferredRouteRef` to 'WIRED_HEADSET' / 'BLUETOOTH'
 * and nothing cleared it when the device left, so the route effect's
 * `desired = preferred ?? toggle` re-applied the dead route on every Speaker
 * press for the rest of the call. The preference itself must SURVIVE (the
 * B-391c BT-drop-reconnect re-assert depends on it); only the DESIRED route
 * falls back while the device is absent.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {resolveDesiredRoute} from '../runtime/callAudioRoute';

describe('PG-C1 — resolveDesiredRoute', () => {
  it('honours a present headset preference', () => {
    expect(resolveDesiredRoute('WIRED_HEADSET', ['EARPIECE', 'SPEAKER_PHONE', 'WIRED_HEADSET'], true)).toBe('WIRED_HEADSET');
    expect(resolveDesiredRoute('BLUETOOTH', ['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH'], false)).toBe('BLUETOOTH');
  });

  it('falls back to the speaker toggle once that headset is gone', () => {
    expect(resolveDesiredRoute('WIRED_HEADSET', ['EARPIECE', 'SPEAKER_PHONE'], true)).toBe('SPEAKER_PHONE');
    expect(resolveDesiredRoute('WIRED_HEADSET', ['EARPIECE', 'SPEAKER_PHONE'], false)).toBe('EARPIECE');
    expect(resolveDesiredRoute('BLUETOOTH', ['EARPIECE', 'SPEAKER_PHONE'], true)).toBe('SPEAKER_PHONE');
  });

  it('an explicit speaker / earpiece pick always wins; no preference is the toggle', () => {
    expect(resolveDesiredRoute('EARPIECE', ['EARPIECE', 'SPEAKER_PHONE'], true)).toBe('EARPIECE');
    expect(resolveDesiredRoute('SPEAKER_PHONE', ['EARPIECE'], false)).toBe('SPEAKER_PHONE');
    expect(resolveDesiredRoute(null, ['EARPIECE', 'SPEAKER_PHONE'], true)).toBe('SPEAKER_PHONE');
    expect(resolveDesiredRoute(null, [], false)).toBe('EARPIECE');
  });

  it('before the first device enumeration (empty list) the preference is honoured, as before', () => {
    expect(resolveDesiredRoute('BLUETOOTH', [], false)).toBe('BLUETOOTH');
  });

  it('CallScreen derives the route effect\'s desired route through the rule with the live device list', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'screens', 'messenger', 'CallScreen.tsx'), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(src).toMatch(/const desired: AudioRoute = resolveDesiredRoute\(preferredRouteRef\.current, audioRoutesRef\.current, isSpeaker\)/);
    expect(src).toMatch(/audioRoutesRef\.current = list;/);
    expect(src).not.toMatch(/const desired: AudioRoute = preferredRouteRef\.current \?\?/);
  });

  it('PG-C1r — the screen-on reapply closure recomputes from LIVE refs, and the re-assert syncs desiredRouteRef', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'screens', 'messenger', 'CallScreen.tsx'), 'utf8')
      .replace(/\r\n/g, '\n');
    // A baked `desired` went stale against the device-list re-assert: wired
    // unplug → Speaker press → re-plug → screen off/on jumped the audio back
    // to loudspeaker with headphones plugged in.
    expect(src).toMatch(/reapplyRouteRef\.current = \(\) => \{[\s\S]{0,600}?const d = resolveDesiredRoute\(preferredRouteRef\.current, audioRoutesRef\.current, isSpeaker\);/);
    expect(src).toMatch(/desiredRouteRef\.current = want;/);
  });
});
