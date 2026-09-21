/**
 * B-838 (founder, 2026-09-10) — "user should also be able to see the media
 * also… user should be able to search pdf name etc."
 *
 * Search results now include media rows, and a media row has to LOOK like
 * media. The mapping that decides which glyph a file gets already existed —
 * inside `FilesScreen.tsx` — and copying it into the search rows would have
 * been the duplicate-copy class: two tables, one of them silently wrong the
 * first time a mime is added. So it moved here and FilesScreen imports it.
 *
 * ── WHY THE ICON NAMES ARE A PLAIN STRING UNION ───────────────────────────
 *
 * The obvious type is `React.ComponentProps<typeof Icon>['name']`, which needs
 * a VALUE import of `@expo/vector-icons`. That import would make this module
 * unusable from a pure helper and untestable in the node project (the package
 * is absent from its `moduleNameMapper`). The union below is assignable to the
 * Icon prop at every call site, and costs nothing at runtime — this file has no
 * imports at all.
 */

/** The five things the Files screen sorts attachments into (its tabs, minus
 *  'all'). `null` means "not media" — a text, system or call row. */
export type MediaBucket = 'docs' | 'img' | 'vid' | 'voice';

/** MaterialCommunityIcons glyph names, spelled out rather than imported. */
export type MediaKindIconName =
  | 'image-outline'
  | 'video-outline'
  | 'microphone-outline'
  | 'file-pdf-box'
  | 'file-document-outline';

/**
 * The message type first, then the mime — `vid` and `voice` both arrive twice:
 * once as their own `type`, and once as a `file` the picker handed us with an
 * audio/video mime.
 */
export function bucketFor(
  type: string | null | undefined,
  mime?: string | null,
): MediaBucket | null {
  if (type === 'image') {return 'img';}
  if (type === 'audio') {return 'voice';}
  // MSG-13 — `video` was missing here for a while and every video fell through
  // to `null`, which dropped it from the Files screen entirely.
  if (type === 'video') {return 'vid';}
  if (type === 'file') {
    const m = mime ?? '';
    if (m.startsWith('video/')) {return 'vid';}
    if (m.startsWith('audio/')) {return 'voice';}
    return 'docs';
  }
  return null;
}

export function mediaKindIcon(bucket: MediaBucket, mime?: string | null): MediaKindIconName;
export function mediaKindIcon(bucket: MediaBucket | null, mime?: string | null): MediaKindIconName | null;
export function mediaKindIcon(
  bucket: MediaBucket | null,
  mime?: string | null,
): MediaKindIconName | null {
  if (bucket === 'img')   {return 'image-outline';}
  if (bucket === 'vid')   {return 'video-outline';}
  if (bucket === 'voice') {return 'microphone-outline';}
  if (bucket !== 'docs')  {return null;}
  // `includes`, not an equality: application/pdf, application/x-pdf and the
  // vendor spellings all read as the same thing to a user.
  return (mime ?? '').includes('pdf') ? 'file-pdf-box' : 'file-document-outline';
}
