/**
 * B-838 — search results must LOOK like media ("user should see the docs
 * also"), so the search hit rows need the same kind mapping the Files screen
 * has always drawn with.
 *
 * The mapping moved out of `FilesScreen.tsx` into `@/modules/messenger/ui/
 * mediaKind` so there is ONE table, not two that drift. This pins the table
 * itself; `filesIconParity.test.tsx` pins that FilesScreen still renders from
 * it, and `departmentDirectoryRender.test.tsx` pins the search rows.
 *
 * The module is deliberately import-free (Tier A): a value import of
 * `@expo/vector-icons` or react-native would make it untestable from the node
 * project and unusable from a pure helper, which is why the icon names are a
 * plain string-literal union rather than the Icon component's own prop type.
 */
import {bucketFor, mediaKindIcon} from '@/modules/messenger/ui/mediaKind';

describe('bucketFor — the message type, then the mime, exactly as FilesScreen did', () => {
  it('maps the three self-describing media types', () => {
    expect(bucketFor('image', 'image/jpeg')).toBe('img');
    expect(bucketFor('video', 'video/mp4')).toBe('vid');
    // A recorded voice note is `type: 'audio'`.
    expect(bucketFor('audio', 'audio/mp4')).toBe('voice');
  });

  it('reads the mime for a `file` row — an audio/* file is a voice bucket', () => {
    // The second shape of the same thing: a document picker can hand back an
    // .m4a, and it arrives as `type: 'file'` with an audio mime.
    expect(bucketFor('file', 'audio/mpeg')).toBe('voice');
  });

  it('reads the mime for a `file` row — a video/* file is the vid bucket', () => {
    // MSG-13's other half: `HANDOVER.mov` arrives as `type: 'file'`.
    expect(bucketFor('file', 'video/quicktime')).toBe('vid');
  });

  it('falls back to docs for every other file, including a missing mime', () => {
    expect(bucketFor('file', 'application/pdf')).toBe('docs');
    expect(bucketFor('file', undefined)).toBe('docs');
    expect(bucketFor('file', null)).toBe('docs');
  });

  it('has NO bucket for a row that is not media', () => {
    // This is what keeps a plain text hit rendering as a text hit.
    expect(bucketFor('text', null)).toBeNull();
    expect(bucketFor('system', null)).toBeNull();
    expect(bucketFor('call', null)).toBeNull();
    expect(bucketFor(undefined, undefined)).toBeNull();
  });
});

describe('mediaKindIcon — one glyph per bucket, with the pdf exception', () => {
  it('gives each bucket the glyph FilesScreen has always used', () => {
    expect(mediaKindIcon('img', 'image/jpeg')).toBe('image-outline');
    expect(mediaKindIcon('vid', 'video/mp4')).toBe('video-outline');
    expect(mediaKindIcon('voice', 'audio/mp4')).toBe('microphone-outline');
    expect(mediaKindIcon('docs', 'text/plain')).toBe('file-document-outline');
  });

  it('THE SPECIAL CASE: a pdf gets its own glyph', () => {
    expect(mediaKindIcon('docs', 'application/pdf')).toBe('file-pdf-box');
    // The original test was `includes('pdf')`, not an equality — vendor mimes
    // like application/x-pdf must keep the same glyph.
    expect(mediaKindIcon('docs', 'application/x-pdf')).toBe('file-pdf-box');
  });

  it('the pdf check is scoped to the docs bucket, like the branch order it replaced', () => {
    // The tab tests came FIRST in `iconFor`, so a mime containing "pdf" on an
    // image row never reached the pdf branch.
    expect(mediaKindIcon('img', 'application/pdf')).toBe('image-outline');
  });

  it('a missing mime is a plain document, never a crash', () => {
    expect(mediaKindIcon('docs', undefined)).toBe('file-document-outline');
    expect(mediaKindIcon('docs', null)).toBe('file-document-outline');
  });

  it('has no glyph for a non-media row — the caller draws its own marker', () => {
    expect(mediaKindIcon(null, null)).toBeNull();
  });
});
