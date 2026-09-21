/**
 * On-device face confirmation for attendance (PDF p.6 "Look at the camera").
 *
 * 🛑 Biometric stop-conditions (architecture-signed 2026-07-02, AMENDED by the
 * founder on 2026-09-05 — "the admin responsible must be able to see the face;
 * when approved and the shift is done the image is deleted"):
 *  - Detection still runs locally (MLKit); only a boolean + scalar audit
 *    metadata ride the clock-in request (the server's sanitizeFaceMeta drops
 *    anything non-scalar as defence-in-depth).
 *  - The frame MAY now leave the device ONCE, as a separate upload right after
 *    the member's own clock-in, to the sealed, manager-only, audited,
 *    retention-bounded photo lane (server: attendance-photo.service.ts). The
 *    caller passes `keep: true` for exactly that, then deletes the file itself
 *    (`deleteCapture`) whether or not the upload succeeded. Default remains
 *    delete-immediately.
 *  - No face geometry or descriptor is ever logged or persisted anywhere.
 *  - This is face PRESENCE detection (a live face is in frame), NOT 1:1 identity
 *    matching — an identity matcher remains out of scope without separate
 *    architecture/legal sign-off.
 *
 * Degrades gracefully: if the MLKit native module isn't in this build, the
 * capture step still ran (camera preview + photo), so we fall back to
 * capture-presence mode rather than blocking check-in.
 */

export interface FaceCheckResult {
  face_ok: boolean;
  face_unavailable?: boolean;
  // Scalars only — mirrors the server's sanitizeFaceMeta contract.
  face_meta: Record<string, string | number | boolean>;
}

interface MlkitFace {
  frame?: unknown;
}
interface MlkitDetector {
  detect(imagePath: string, options?: Record<string, unknown>): Promise<MlkitFace[]>;
}

function loadDetector(): MlkitDetector | null {
  try {
    // Optional native dep — absent in builds that haven't rebuilt the APK yet.
    const mod = require('@react-native-ml-kit/face-detection');
    return (mod?.default ?? mod) as MlkitDetector;
  } catch {
    return null;
  }
}

export async function deleteCapture(uri: string): Promise<void> {
  try {
    const fs = require('expo-file-system/legacy');
    await fs.deleteAsync(uri, {idempotent: true});
  } catch {
    // Best effort — the file lives in the app cache, which the OS purges.
  }
}

export async function runFaceCheck(
  photoUri: string,
  opts: {keep?: boolean} = {},
): Promise<FaceCheckResult> {
  const detector = loadDetector();
  try {
    if (!detector) {
      // Capture-presence mode: the user did face the camera and a frame was
      // taken, but this build can't run detection — still a step above the v1
      // permission-only check; the bucket makes the difference auditable.
      return {
        face_ok: true,
        face_meta: {model: 'presence-capture', version: 'v2', confidenceBucket: 'capture_only'},
      };
    }
    const faces = await detector.detect(photoUri, {
      performanceMode: 'accurate',
      landmarkMode: 'none',
      contourMode: 'none',
      classificationMode: 'none',
    });
    const count = Array.isArray(faces) ? faces.length : 0;
    const bucket = count === 1 ? 'face_detected' : count === 0 ? 'no_face' : 'multiple_faces';
    return {
      face_ok: count === 1,
      face_meta: {model: 'mlkit-face', version: 'v1', confidenceBucket: bucket, faceCount: count},
    };
  } catch {
    // Detector present but failed to run → distinct camera_unavailable reason
    // server-side (never a silent pass, never a fake mismatch).
    return {
      face_ok: false,
      face_unavailable: true,
      face_meta: {model: 'mlkit-face', version: 'v1', confidenceBucket: 'detector_error'},
    };
  } finally {
    // `keep` = the caller uploads the frame to the sealed photo lane next and
    // deletes it itself; every other path still wipes the file here.
    if (!opts.keep) {void deleteCapture(photoUri);}
  }
}
