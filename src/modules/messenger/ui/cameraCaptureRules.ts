/**
 * In-app camera capture rules (2026-09-06, founder: "on the photo capture
 * button hold it will do video 30s only same as whatsapp").
 *
 * Pure — no React / react-native imports — so the node project can pin the
 * numbers and the asset shapes (pickedAssets.ts convention). The component
 * (`CameraCapture.tsx`) owns the camera; this module owns the decisions.
 */
import type {PickedAsset} from './pickedAssets';

/** A press shorter than this is a photo; holding past it starts a video. */
export const HOLD_TO_RECORD_MS = 220;
/** WhatsApp's in-app clip cap. The camera enforces it too (`maxDuration`). */
export const MAX_VIDEO_MS = 30_000;
export const MAX_VIDEO_SECONDS = MAX_VIDEO_MS / 1000;
/**
 * 720p at ~1.2 Mbps (WhatsApp-comparable): a full 30 s clip lands around
 * 5 MB with the audio track. Two ceilings bound this number:
 *  - `MAX_INLINE_MEDIA_BYTES` (25 MB), the read-path cap — far above.
 *  - B-810: the encrypted blob is PUT straight to Supabase Storage, which sits
 *    behind Cloudflare; a single upload that keeps the origin busy past 100 s
 *    comes back as HTTP 524 and the send fails AFTER the user recorded it.
 *    Supabase documents ~6 MB as the reliable single-PUT size. The first cut
 *    used 3 Mbps (~11 MB / 30 s) and the founder's first group clip 524'd.
 *    Larger library videos share this exposure until the multipart upload
 *    lands (B-810); a captured clip must simply stay under the line.
 */
export const VIDEO_QUALITY = '720p' as const;
export const VIDEO_BITRATE = 1_200_000;
/** Supabase's documented reliable single-PUT size (B-810). */
export const SINGLE_PUT_SAFE_BYTES = 6 * 1024 * 1024;
/**
 * A clip shorter than this is discarded, not sent (WhatsApp does the same):
 * it is either a hold released the instant recording began, or — on Android —
 * a recorder that resolved before the video use-case was live and wrote a
 * near-empty file. Neither is something the user meant to send.
 */
export const MIN_CLIP_MS = 500;
/**
 * How the recorder is started after the hold is confirmed. expo-camera binds
 * one output at a time (`mode`); after the flip to 'video' the session re-binds
 * asynchronously and iOS does NOT re-emit onCameraReady (it fires once, at
 * session start), so the start is attempted on a short delay and retried on an
 * immediate rejection. Bounded: worst case ~1.2 s before giving up.
 */
export const RECORD_START_DELAY_MS = {android: 350, ios: 120} as const;
export const RECORD_START_RETRY_MS = 150;
export const RECORD_START_MAX_ATTEMPTS = 5;
/** A rejection this soon after `recordAsync` is "not bound yet", not a failed clip. */
export const RECORD_EARLY_REJECT_MS = 400;

/**
 * Zoom while holding (founder, 2026-09-06): slide the held finger UP to zoom
 * in, back down to zoom out — WhatsApp's gesture. `zoom` is expo-camera's
 * 0..1 fraction of the device's max zoom. A full drag of ZOOM_DRAG_PX reaches
 * max; the mapping is linear so the finger and the lens move together.
 */
export const ZOOM_DRAG_PX = 240;
/** Ignore sub-step changes so a resting finger does not re-render the camera. */
export const ZOOM_STEP = 0.01;

export function zoomFromDrag(dragUpPx: number): number {
  const z = dragUpPx / ZOOM_DRAG_PX;
  if (!Number.isFinite(z)) {return 0;}
  return Math.min(1, Math.max(0, Math.round(z / ZOOM_STEP) * ZOOM_STEP));
}

export function zoomChanged(prev: number, next: number): boolean {
  return Math.abs(next - prev) >= ZOOM_STEP - 1e-9;
}

export function isEarlyRecordReject(attemptedAt: number, rejectedAt: number): boolean {
  return rejectedAt - attemptedAt < RECORD_EARLY_REJECT_MS;
}

/** Whether a resolved clip is worth handing to the tray. */
export function clipIsUsable(durationMs: number): boolean {
  return durationMs >= MIN_CLIP_MS;
}
/** Camera stills are resized to this long edge (G10 parity with the old picker path). */
export const PHOTO_MAX_EDGE = 1920;
export const PHOTO_QUALITY = 0.8;

export type ShutterIntent = 'photo' | 'video';

/** What a shutter release means, from how long it was held. */
export function shutterIntent(heldMs: number): ShutterIntent {
  return heldMs >= HOLD_TO_RECORD_MS ? 'video' : 'photo';
}

/** Mime from the recorder's file extension: Android writes .mp4, iOS .mov. */
export function videoMimeForUri(uri: string): string {
  const ext = (uri.split('?')[0].split('#')[0].match(/\.([A-Za-z0-9]+)$/)?.[1] ?? '').toLowerCase();
  if (ext === 'mov') {return 'video/quicktime';}
  if (ext === 'webm') {return 'video/webm';}
  if (ext === '3gp') {return 'video/3gpp';}
  return 'video/mp4';
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * A captured still as the tray/queue asset. `ephemeralSource` is TRUE: the
 * app created the file in its own cache (not the camera roll), so the sender
 * deletes the plaintext once it is encrypted (B-149) — unlike a library pick,
 * where unlinking would delete the user's own photo.
 */
export function buildPhotoAsset(p: {uri: string; width?: number; height?: number; now?: Date}): PickedAsset {
  return {
    uri: p.uri,
    mime: 'image/jpeg',
    kind: 'image',
    meta: {name: `IMG_${stamp(p.now ?? new Date())}.jpg`, width: p.width, height: p.height},
    ephemeralSource: true,
  };
}

/**
 * A recorded clip as the tray/queue asset. Duration is measured by the
 * component (record start → resolve) and CLAMPED to the cap: the recorder
 * stops itself at `maxDuration`, but the promise can resolve a few hundred ms
 * later, and the badge must never read "0:31" on a 30 s clip.
 */
export function buildVideoAsset(p: {uri: string; durationMs: number; now?: Date}): PickedAsset {
  const mime = videoMimeForUri(p.uri);
  const ext = mime === 'video/quicktime' ? 'mov' : 'mp4';
  const durationMs = Math.max(0, Math.min(MAX_VIDEO_MS, Math.round(p.durationMs)));
  return {
    uri: p.uri,
    mime,
    kind: 'video',
    meta: {name: `VID_${stamp(p.now ?? new Date())}.${ext}`, durationMs},
    ephemeralSource: true,
  };
}

/** "0:07" style REC counter; never exceeds the cap. */
export function formatRecClock(elapsedMs: number): string {
  const s = Math.min(MAX_VIDEO_SECONDS, Math.max(0, Math.floor(elapsedMs / 1000)));
  return `0:${String(s).padStart(2, '0')}`;
}

/** 0..1 ring progress toward the cap. */
export function recProgress(elapsedMs: number): number {
  return Math.min(1, Math.max(0, elapsedMs / MAX_VIDEO_MS));
}
