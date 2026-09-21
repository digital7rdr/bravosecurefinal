/**
 * B-718 — the loudspeaker must survive a minimize in a GROUP call too.
 *
 * The 1:1 half of this was B-717. The group screen had the SAME hole from a
 * different direction: `preferredRouteRef` was seeded ONLY from B-302's
 * `initialAudioRoute` route param, which exists to carry the route across the
 * 1:1 → group escalation. That covers the screen SWAP and nothing else — the
 * group restore navigate passes no route — so a minimize→restore started at
 * `null`, the first device event took the "no preference yet" branch, and the
 * user's loudspeaker was overridden.
 *
 * Route rather than a speaker boolean (unlike B-717): this screen's Speaker
 * button ALWAYS opens the picker (`onPress={() => setRoutePickerOpen(true)}`),
 * so `pickAudioRoute` is the only way the route changes here and an explicit
 * pick is the whole of the user's intent. The 1:1 screen is the opposite — its
 * button bypasses the picker — which is exactly the asymmetry that made B-717's
 * first cut wrong. Do not "unify" these two without re-reading both.
 */
import * as greg from '../runtime/groupCallRegistry';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const seed = (roomId: string) => ({roomId, conversationId: `grp:${roomId}`});

describe('B-718 — the group registry carries an explicit route across minimize', () => {
  afterEach(() => { greg.setActiveGroupCall(null); });

  it('survives minimize → restore', () => {
    greg.setActiveGroupCall(seed('room-1') as never);
    greg.patchActiveGroupCall('room-1', {audioRoute: 'SPEAKER_PHONE'});

    greg.setGroupCallMinimized('room-1', true);
    expect(greg.getActiveGroupCall()?.audioRoute).toBe('SPEAKER_PHONE');

    greg.setGroupCallMinimized('room-1', false);
    expect(greg.getActiveGroupCall()?.audioRoute).toBe('SPEAKER_PHONE');
  });

  it('a DIFFERENT room cannot be stamped by a stale screen', () => {
    greg.setActiveGroupCall(seed('room-old') as never);
    greg.setActiveGroupCall(seed('room-new') as never);
    greg.patchActiveGroupCall('room-old', {audioRoute: 'SPEAKER_PHONE'});
    expect(greg.getActiveGroupCall()?.roomId).toBe('room-new');
    expect(greg.getActiveGroupCall()?.audioRoute).toBeUndefined();
  });

  it('a fresh room inherits nothing — the media default still decides', () => {
    greg.setActiveGroupCall(seed('room-a') as never);
    greg.patchActiveGroupCall('room-a', {audioRoute: 'SPEAKER_PHONE'});
    greg.setActiveGroupCall(seed('room-b') as never);
    expect(greg.getActiveGroupCall()?.audioRoute).toBeUndefined();
  });
});

describe('B-718 — GroupCallScreen persists and restores the route', () => {
  const SRC = readFileSync(
    join(__dirname, '..', '..', '..', 'screens', 'messenger', 'GroupCallScreen.tsx'),
    'utf8',
  );
  /** Strip comments — the prose here names every token asserted below. */
  const code = SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');

  it('writes the explicit pick onto the live room, keyed and guarded', () => {
    expect(code).toMatch(
      /if\s*\(\s*live\s*&&\s*live\.roomId\s*===\s*call\.roomId\s*\)\s*\{\s*greg\.patchActiveGroupCall\(\s*live\.roomId\s*,\s*\{\s*audioRoute:\s*next\s*\}\s*\)/,
    );
  });

  it('seeds BOTH the visible route and the preference ref from the room', () => {
    // Two separate reads: the icon and the routing decision. Seeding only one
    // leaves the button showing a route the audio is not on (or the reverse).
    const seeds = code.match(/getActiveGroupCall\(\)\?\.audioRoute/g) ?? [];
    expect(seeds.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the B-302 escalation param as the FALLBACK, not the winner', () => {
    // A route chosen inside this call is newer than the handover, so the
    // registry term must come first; `initialAudioRoute` still covers the fresh
    // 1:1 -> group swap, where the room has no stored route yet.
    expect(code).toMatch(/getActiveGroupCall\(\)\?\.audioRoute[\s\S]{0,80}\?\?\s*initialAudioRoute/);
  });
});
