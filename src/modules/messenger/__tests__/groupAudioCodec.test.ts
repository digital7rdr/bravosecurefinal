import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {GROUP_AUDIO_CODEC_OPTIONS} from '../webrtc/groupAudioCodec';

/**
 * 2026-10-17 — "the quality of the sound was bad" in the first working group
 * call. App half of the fix: 20 ms Opus packets, no DTX, FEC kept, and the
 * two produce sites (first join + re-produce after reconnect) share one
 * object instead of two hand-copied literals.
 */
describe('group call microphone Opus settings', () => {
  it('20 ms packets, no DTX, in-band FEC, mono, 32 kbps', () => {
    expect(GROUP_AUDIO_CODEC_OPTIONS).toEqual({
      opusStereo: false, opusFec: true, opusDtx: false, opusMaxAverageBitrate: 32_000, opusPtime: 20,
    });
    expect(Object.isFrozen(GROUP_AUDIO_CODEC_OPTIONS)).toBe(true);
  });

  it('every audio produce in useGroupCall uses the shared options', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts'), 'utf8');
    expect(src).not.toMatch(/opusPtime:\s*10/);
    expect(src).not.toMatch(/opusDtx:\s*true/);
    expect(src.match(/codecOptions: \{\.\.\.GROUP_AUDIO_CODEC_OPTIONS\}/g)).toHaveLength(2);
  });
});
