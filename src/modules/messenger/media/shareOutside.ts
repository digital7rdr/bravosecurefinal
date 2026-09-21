/**
 * B-825 — share a chat attachment to ANY app on the phone (WhatsApp, Mail,
 * Drive…), the way WhatsApp does. Voice notes are the founder's one exception
 * and never leave Bravo.
 *
 * ONE predicate (`canShareOutside`) and ONE effect (`shareMessageOutside`),
 * used by every surface that offers the door — the long-press action sheet,
 * the forward sheet's header row and the full-screen viewer. Scope v2 Phase 4
 * is the cautionary tale: four surfaces each deciding a rule for themselves
 * left three of them wrong.
 *
 * Exporting decrypted plaintext is a deliberate user action, same as the
 * viewer's existing Share (media-parity M15): expo-sharing hands the OS a
 * content:// uri through its own FileProvider, so the FILE travels, not a name.
 */

import * as Sharing from 'expo-sharing';
import {resolveAttachmentFileUri, type AttachmentMessageLike} from './useAttachmentUri';

export type ShareableMessageLike = AttachmentMessageLike & {
  type: string;
  deleted_for_all?: boolean;
  content?: string | null;
  media_meta?: {name?: string; sizeBytes?: number};
};

export type ShareOutcome = 'shared' | 'unavailable' | 'failed';

const SHAREABLE_TYPES = new Set(['image', 'video', 'file']);

function hasDownloadTriple(msg: ShareableMessageLike): boolean {
  return !!(msg.media_object_key && msg.media_key && msg.media_iv);
}

/**
 * The one rule. `'audio'` is a voice note; text and system rows have no file.
 * A retracted row's bytes are gone, and a row with neither a local pick nor
 * the full download triple can never produce one.
 */
export function canShareOutside(msg: ShareableMessageLike): boolean {
  if (!SHAREABLE_TYPES.has(msg.type)) {return false;}
  if (msg.deleted_for_all) {return false;}
  return !!msg.media_url || hasDownloadTriple(msg);
}

function dialogNameFor(msg: ShareableMessageLike): string {
  const fallback = msg.type === 'image' ? 'Photo' : msg.type === 'video' ? 'Video' : 'File';
  return msg.media_meta?.name || msg.content || fallback;
}

/**
 * Why: prefer the download triple over `media_url`. The sender's own pick is a
 * picker grant that dies on reboot (and is often `content://`, which Android's
 * expo-sharing refuses outright with "Only local file URLs are supported") —
 * the resolver instead returns the decrypted temp file, statting a warm one
 * before spending a download.
 */
async function resolveShareUri(msg: ShareableMessageLike): Promise<string | null> {
  if (hasDownloadTriple(msg)) {return resolveAttachmentFileUri(msg);}
  if (msg.media_url?.startsWith('file://')) {return msg.media_url;}
  return null;
}

export async function shareMessageOutside(msg: ShareableMessageLike): Promise<ShareOutcome> {
  if (!canShareOutside(msg)) {return 'failed';}
  try {
    const uri = await resolveShareUri(msg);
    if (!uri) {return 'failed';}
    if (!(await Sharing.isAvailableAsync())) {return 'unavailable';}
    await Sharing.shareAsync(uri, {
      mimeType:    msg.media_mime ?? 'application/octet-stream',
      dialogTitle: dialogNameFor(msg),
    });
    return 'shared';
  } catch (e) {
    // The old viewer swallowed this, so a real failure looked like "nothing
    // happened". expo-sharing RESOLVES when the user dismisses the sheet, so a
    // throw is always genuine. Ids and an error class only — never the uri, the
    // filename or any key material.
    console.warn('[share-outside] failed', {
      type:   msg.type,
      reason: e instanceof Error ? e.name : 'unknown',
    });
    return 'failed';
  }
}
