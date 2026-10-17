/**
 * Opus settings for the microphone in a GROUP call (SFU path).
 *
 * 2026-10-17 — owner after the first working 3-phone group call: "the quality
 * of the sound was bad". The group path alone had been tuned to
 *   - ptime 10 ms: 100 packets/s per speaker instead of 50. Each packet also
 *     carries RTP/SRTP/UDP/IP headers and the per-frame E2EE trailer, so at
 *     32 kbps the overhead outweighed the voice, and on 4G more packets means
 *     more loss and jitter;
 *   - DTX on: with speakerphone noise suppression it clips the start of words
 *     and swaps in comfort noise — heard as choppy speech.
 * The 1:1 path sets neither and was not reported. Group now matches it:
 * 20 ms packets, no DTX, in-band FEC kept (recovers a lost packet without a
 * retransmit round-trip), mono, 32 kbps (voice saturates there).
 *
 * One object so the first produce and the re-produce after a reconnect cannot
 * drift apart (they had been two hand-copied literals).
 */
export const GROUP_AUDIO_CODEC_OPTIONS = Object.freeze({
  opusStereo:            false,
  opusFec:               true,
  opusDtx:               false,
  opusMaxAverageBitrate: 32_000,
  opusPtime:             20,
});
