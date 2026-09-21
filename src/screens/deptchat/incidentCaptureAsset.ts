/**
 * B-831 — the in-app camera's `PickedAsset` ↔ an incident evidence row.
 *
 * Free of React so the conversion, the unit the gate compares against, and the
 * draft restore are unit-testable (the incidentDraft.ts / channelMessageSearch
 * convention). The caps themselves stay in the screen: `gateAsset` reads
 * MAX_BYTES / MAX_VIDEO_SECONDS from its own module scope, and one gate for
 * both sources is the point.
 */
import type {PickedAsset} from '@/modules/messenger/ui/pickedAssets';
import type {IncidentDraftMedia} from './incidentDraft';

/** The `react-native-image-picker` Asset subset `gateAsset` actually reads. */
export interface CaptureGateAsset {
  uri: string;
  type: string;
  fileSize?: number;
  /** SECONDS — RNIP's unit, and the unit MAX_VIDEO_SECONDS is written in. */
  duration?: number;
}

/** A draft row as the details screen holds it. */
export type RestoredMedia = IncidentDraftMedia & {fromDraft: true};

/**
 * `CameraCapture` reports no byte size, so `fileSize` is absent unless a caller
 * stats the file — which the gate already treats as advisory (the post-read
 * backstop in incidentEvidence.ts is the real ceiling). Duration is converted
 * from the component's milliseconds; handing 29400 to a gate written in
 * seconds would drop every clip as "too long".
 */
export function captureGateAsset(a: PickedAsset, sizeBytes?: number): CaptureGateAsset {
  const durationMs = a.meta?.durationMs;
  return {
    uri: a.uri,
    type: a.mime,
    ...(typeof sizeBytes === 'number' ? {fileSize: sizeBytes} : {}),
    ...(typeof durationMs === 'number' ? {duration: durationMs / 1000} : {}),
  };
}

export function captureToMedia(a: PickedAsset): IncidentDraftMedia {
  const mime = a.mime || 'image/jpeg';
  return {
    uri: a.uri,
    mime,
    kind: mime.startsWith('video/') ? 'video' : 'image',
    // Why: B-149 — the app CREATED this file in its own cache and owns its
    // lifetime. A library pick never carries the flag, because unlinking one
    // would delete the user's photo out of their gallery.
    ...(a.ephemeralSource ? {ephemeralSource: true} : {}),
  };
}

/**
 * Rehydrate the media rows of a resumed draft.
 *
 * The route param declares only `{uri, mime, kind}` (src/navigation/types.ts,
 * which this module may not widen), so the ownership flag is read structurally
 * off the value the draft store round-trips.
 */
export function restoreDraftMedia(
  rows: ReadonlyArray<{uri: string; mime: string; kind: 'image' | 'video'}>): RestoredMedia[] {
  return rows.map(m => ({
    uri: m.uri,
    mime: m.mime,
    kind: m.kind,
    fromDraft: true as const,
    ...((m as {ephemeralSource?: boolean}).ephemeralSource ? {ephemeralSource: true} : {}),
  }));
}

/**
 * Does a capture the app took still exist?
 *
 * A draft persists URIs only, and a capture lives in the app's private cache —
 * which the OS is free to purge between sessions. Fail-OPEN: only a definite
 * "not there" answers false, so a probe that cannot run never eats evidence
 * the user still has. Lazily required like `faceCheck.deleteCapture`, so the
 * pure helpers above stay importable without the native module.
 */
export async function captureFileExists(uri: string): Promise<boolean> {
  try {
    const fs = require('expo-file-system/legacy');
    const info = await fs.getInfoAsync(uri);
    return info?.exists !== false;
  } catch {
    return true;
  }
}
