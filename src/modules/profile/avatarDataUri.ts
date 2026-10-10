/**
 * 2026-10-11 — profile photos are stored as a small JPEG data URI in
 * `users.avatar_url`, saved through PATCH /auth/me (UpdateProfileDto caps the
 * field at 200 000 chars and expects a client-downscaled ~256 px image — the
 * same path the web consoles use).
 *
 * Why not Storage: the app used to ask a Supabase Edge Function
 * (`avatar-upload-url`) for a signed upload URL. That function only ever
 * existed on the old hosted project — never in this repo — so on the fresh
 * install every photo save failed with `avatar_upload_url_failed`
 * (deploy/production/README.md §7). The data URI needs no extra service, no
 * bucket and no signed URL, and /auth/me carries it to every device.
 */
import * as ImageManipulator from 'expo-image-manipulator';

/** Server cap (UpdateProfileDto @MaxLength) minus headroom. */
export const AVATAR_MAX_CHARS = 190_000;

/** Largest edge first, then progressively smaller/softer until it fits. */
const ATTEMPTS: ReadonlyArray<{edge: number; compress: number}> = [
  {edge: 256, compress: 0.7},
  {edge: 256, compress: 0.5},
  {edge: 192, compress: 0.5},
  {edge: 128, compress: 0.5},
];

/**
 * Downscale a picked (already square-cropped) photo to a JPEG data URI that
 * fits the server cap. Throws `avatar_too_large` only if even 128 px does not
 * fit, which a JPEG never should.
 */
export async function toAvatarDataUri(uri: string): Promise<string> {
  for (const {edge, compress} of ATTEMPTS) {
    const out = await ImageManipulator.manipulateAsync(
      uri,
      [{resize: {width: edge}}],
      {compress, format: ImageManipulator.SaveFormat.JPEG, base64: true},
    );
    if (!out.base64) {continue;}
    const dataUri = `data:image/jpeg;base64,${out.base64}`;
    if (dataUri.length <= AVATAR_MAX_CHARS) {return dataUri;}
  }
  throw new Error('avatar_too_large');
}
