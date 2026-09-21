/**
 * In-app camera rules (2026-09-06) — tap = photo, hold = video, 30 s cap
 * ("same as WhatsApp"). The component owns the camera; these pin the pure
 * decisions in `cameraCaptureRules.ts` and the asset shapes it hands the tray.
 */
import {
  HOLD_TO_RECORD_MS, MAX_VIDEO_MS, MAX_VIDEO_SECONDS, VIDEO_BITRATE, VIDEO_QUALITY, MIN_CLIP_MS, SINGLE_PUT_SAFE_BYTES,
  RECORD_START_DELAY_MS, RECORD_START_MAX_ATTEMPTS, RECORD_START_RETRY_MS, ZOOM_DRAG_PX,
  shutterIntent, videoMimeForUri, buildPhotoAsset, buildVideoAsset, formatRecClock, recProgress,
  clipIsUsable, isEarlyRecordReject, zoomFromDrag, zoomChanged,
} from '../ui/cameraCaptureRules';
import {MAX_INLINE_MEDIA_BYTES} from '../media/mediaLimits';

const AT = new Date(2026, 8, 6, 14, 5, 9); // local time — the stamp is local

describe('the two numbers the founder named', () => {
  it('a clip is capped at exactly 30 s', () => {
    expect(MAX_VIDEO_MS).toBe(30_000);
    expect(MAX_VIDEO_SECONDS).toBe(30);
  });
  it('a hold past the threshold is a video, a shorter press is a photo', () => {
    expect(shutterIntent(0)).toBe('photo');
    expect(shutterIntent(HOLD_TO_RECORD_MS - 1)).toBe('photo');
    expect(shutterIntent(HOLD_TO_RECORD_MS)).toBe('video');
    expect(shutterIntent(5_000)).toBe('video');
  });
  it('a full-length clip at the chosen quality stays under BOTH ceilings: the inline cap and the single-PUT line (B-810)', () => {
    // video + ~128 kbps audio, 30 s, plus 25% encoder overshoot.
    const worstBytes = ((VIDEO_BITRATE + 128_000) * MAX_VIDEO_SECONDS / 8) * 1.25;
    expect(worstBytes).toBeLessThan(MAX_INLINE_MEDIA_BYTES);
    // B-810 — the founder's first group clip (3 Mbps ≈ 11 MB) came back HTTP 524
    // from the Cloudflare-fronted storage PUT. A captured clip must stay under
    // Supabase's ~6 MB reliable single-upload size until multipart lands.
    expect(worstBytes).toBeLessThan(SINGLE_PUT_SAFE_BYTES);
    expect(VIDEO_BITRATE).toBeLessThanOrEqual(1_500_000);
    expect(VIDEO_QUALITY).toBe('720p');
  });
});

describe('asset shapes handed to the review tray', () => {
  it('a photo is an image asset the sender may delete after encrypting (app-owned cache file)', () => {
    const a = buildPhotoAsset({uri: 'file:///cache/Camera/x.jpg', width: 1920, height: 1080, now: AT});
    expect(a).toEqual({
      uri: 'file:///cache/Camera/x.jpg', mime: 'image/jpeg', kind: 'image',
      meta: {name: 'IMG_20260906_140509.jpg', width: 1920, height: 1080},
      ephemeralSource: true,
    });
  });
  it('a clip is a video asset with its measured duration, CLAMPED to the cap', () => {
    const a = buildVideoAsset({uri: 'file:///cache/Camera/x.mp4', durationMs: 7_450, now: AT});
    expect(a).toMatchObject({mime: 'video/mp4', kind: 'video', ephemeralSource: true, meta: {name: 'VID_20260906_140509.mp4', durationMs: 7_450}});
    // The recorder stops itself at maxDuration but the promise resolves later;
    // the badge must never read past the cap.
    expect(buildVideoAsset({uri: 'a.mp4', durationMs: 30_640}).meta.durationMs).toBe(30_000);
    expect(buildVideoAsset({uri: 'a.mp4', durationMs: -5}).meta.durationMs).toBe(0);
  });
  it('mime follows the recorder\'s container: .mov on iOS, .mp4 on Android, query strings ignored', () => {
    expect(videoMimeForUri('file:///x/clip.MOV')).toBe('video/quicktime');
    expect(videoMimeForUri('file:///x/clip.mp4?ts=1')).toBe('video/mp4');
    expect(videoMimeForUri('file:///x/clip')).toBe('video/mp4');
    expect(buildVideoAsset({uri: 'file:///x/c.mov', durationMs: 1000, now: AT}).meta.name).toBe('VID_20260906_140509.mov');
  });
});

describe('recorder start, clip acceptance, zoom (critic round)', () => {
  it('a clip shorter than MIN_CLIP_MS is discarded — the Android pre-bind stub and the instant release', () => {
    expect(MIN_CLIP_MS).toBe(500);
    expect(clipIsUsable(499)).toBe(false);
    expect(clipIsUsable(500)).toBe(true);
  });
  it('an immediate rejection is "not bound yet" and retried; a late one is a failed clip', () => {
    expect(isEarlyRecordReject(1_000, 1_300)).toBe(true);
    expect(isEarlyRecordReject(1_000, 1_400)).toBe(false);
    // Bounded: worst case under ~1.3 s before giving up (delay + retries).
    const worst = RECORD_START_DELAY_MS.android + (RECORD_START_MAX_ATTEMPTS - 1) * RECORD_START_RETRY_MS;
    expect(worst).toBeLessThanOrEqual(1_300);
    expect(RECORD_START_DELAY_MS.ios).toBeLessThan(RECORD_START_DELAY_MS.android);
  });
  it('slide up = zoom in, linear to the max at ZOOM_DRAG_PX, clamped, on 1 % steps', () => {
    expect(zoomFromDrag(0)).toBe(0);
    expect(zoomFromDrag(-50)).toBe(0);                 // sliding DOWN below the start never goes negative
    expect(zoomFromDrag(ZOOM_DRAG_PX / 2)).toBeCloseTo(0.5, 10);
    expect(zoomFromDrag(ZOOM_DRAG_PX * 3)).toBe(1);
    expect(zoomFromDrag(Number.NaN)).toBe(0);
    expect(zoomFromDrag(1)).toBe(0);                   // sub-step: no change → no re-render
    expect(zoomChanged(0.5, 0.505)).toBe(false);
    expect(zoomChanged(0.5, 0.51)).toBe(true);
  });
});

describe('the REC clock and ring', () => {
  it('counts whole seconds and never shows past the cap', () => {
    expect(formatRecClock(0)).toBe('0:00');
    expect(formatRecClock(7_999)).toBe('0:07');
    expect(formatRecClock(30_900)).toBe('0:30');
  });
  it('ring progress is 0..1 of the cap', () => {
    expect(recProgress(0)).toBe(0);
    expect(recProgress(15_000)).toBe(0.5);
    expect(recProgress(40_000)).toBe(1);
  });
});
