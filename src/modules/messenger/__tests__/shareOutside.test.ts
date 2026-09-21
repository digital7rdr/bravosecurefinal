/**
 * B-825 (founder 2026-09-08) — "A user should be able to share photo, video,
 * pdf, all forms of media to any other platform except the voice note, just
 * like WhatsApp."
 *
 * `canShareOutside` is the ONE predicate every surface uses (the chat action
 * sheet, the forward sheet's header row, the full-screen viewer's Share
 * button). Pinning it here rather than per-surface is the whole point: the
 * repo's own history is four surfaces disagreeing about one rule (Scope v2
 * Phase 4's company-file suppression).
 *
 * `shareMessageOutside` is pinned on the two things the old viewer-only path
 * got wrong: it shared VOICE NOTES, and it swallowed real failures in an empty
 * `catch` (expo-sharing RESOLVES on dismissal — a throw is always a genuine
 * error, most often Android's "Only local file URLs are supported").
 */

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync:       jest.fn(async () => undefined),
}));
jest.mock('../media/useAttachmentUri', () => ({
  resolveAttachmentFileUri: jest.fn(async () => 'file:///cache/bravo-media-m1.jpg'),
}));

import * as Sharing from 'expo-sharing';
import {resolveAttachmentFileUri} from '../media/useAttachmentUri';
import {canShareOutside, shareMessageOutside, type ShareableMessageLike} from '../media/shareOutside';

const mockIsAvailable = Sharing.isAvailableAsync as unknown as jest.Mock;
const mockShareAsync  = Sharing.shareAsync as unknown as jest.Mock;
const mockResolve     = resolveAttachmentFileUri as unknown as jest.Mock;

const TRIPLE = {media_object_key: 'obj-1', media_key: 'k', media_iv: 'i'};

const msg = (over: Partial<ShareableMessageLike> = {}): ShareableMessageLike => ({
  id: 'm1', type: 'image', media_mime: 'image/jpeg', ...TRIPLE, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockIsAvailable.mockResolvedValue(true);
  mockShareAsync.mockResolvedValue(undefined);
  mockResolve.mockResolvedValue('file:///cache/bravo-media-m1.jpg');
});

describe('T1 — canShareOutside: the one rule', () => {
  it('a photo, a video and a document with the download triple are shareable', () => {
    expect(canShareOutside(msg({type: 'image'}))).toBe(true);
    expect(canShareOutside(msg({type: 'video'}))).toBe(true);
    expect(canShareOutside(msg({type: 'file'}))).toBe(true);
  });

  it('the sender\'s own local pick (media_url, no triple yet) is shareable', () => {
    expect(canShareOutside({id: 'm1', type: 'image', media_url: 'file:///pick/a.jpg'})).toBe(true);
  });

  it('a VOICE NOTE is never shareable — that is the founder\'s exception', () => {
    expect(canShareOutside(msg({type: 'audio'}))).toBe(false);
    expect(canShareOutside({id: 'm1', type: 'audio', media_url: 'file:///pick/a.m4a'})).toBe(false);
  });

  it('text and system rows are not shareable', () => {
    expect(canShareOutside({id: 'm1', type: 'text', content: 'hello'})).toBe(false);
    expect(canShareOutside({id: 'm1', type: 'system'})).toBe(false);
  });

  it('a retracted attachment is not shareable — its bytes are gone', () => {
    expect(canShareOutside(msg({deleted_for_all: true}))).toBe(false);
  });

  it('an attachment with NEITHER a local uri nor the full triple is not shareable', () => {
    expect(canShareOutside({id: 'm1', type: 'image'})).toBe(false);
    // A partial triple cannot decrypt, so it is the same as no triple.
    expect(canShareOutside({id: 'm1', type: 'image', media_object_key: 'obj-1', media_key: 'k'})).toBe(false);
  });
});

describe('T2 — shareMessageOutside', () => {
  it('refuses a voice note WITHOUT touching the OS share sheet', async () => {
    await expect(shareMessageOutside(msg({type: 'audio'}))).resolves.toBe('failed');
    expect(mockIsAvailable).not.toHaveBeenCalled();
    expect(mockShareAsync).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('resolves the decrypted local file, then hands the OS that uri and the real mime', async () => {
    await expect(shareMessageOutside(msg({media_meta: {name: 'holiday.jpg'}}))).resolves.toBe('shared');
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockShareAsync).toHaveBeenCalledWith(
      'file:///cache/bravo-media-m1.jpg',
      expect.objectContaining({mimeType: 'image/jpeg', dialogTitle: 'holiday.jpg'}),
    );
  });

  it('falls back to the local pick only when there is no triple to re-download from', async () => {
    await expect(shareMessageOutside({id: 'm2', type: 'video', media_url: 'file:///pick/a.mp4'}))
      .resolves.toBe('shared');
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockShareAsync).toHaveBeenCalledWith('file:///pick/a.mp4', expect.anything());
  });

  it('a non-file:// local pick with no triple is a failure, not a silent no-op', async () => {
    // Android's expo-sharing throws "Only local file URLs are supported" for a
    // content:// grant, which is exactly the "nothing happened" report.
    await expect(shareMessageOutside({id: 'm3', type: 'image', media_url: 'content://media/1'}))
      .resolves.toBe('failed');
    expect(mockShareAsync).not.toHaveBeenCalled();
  });

  it('reports unavailable when the device has no app to share to', async () => {
    mockIsAvailable.mockResolvedValue(false);
    await expect(shareMessageOutside(msg())).resolves.toBe('unavailable');
    expect(mockShareAsync).not.toHaveBeenCalled();
  });

  it('a THROW is a real failure (expo-sharing resolves on dismissal) and never logs the uri or the name', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockShareAsync.mockRejectedValue(new Error('Only local file URLs are supported'));
    await expect(shareMessageOutside(msg({media_meta: {name: 'holiday.jpg'}}))).resolves.toBe('failed');
    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.map(c => JSON.stringify(c)).join(' ');
    expect(logged).not.toContain('file:///cache');
    expect(logged).not.toContain('holiday.jpg');
    expect(logged).toContain('image');
    warn.mockRestore();
  });

  it('a resolve failure (evicted temp file / offline) is a failure, not a crash', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockResolve.mockRejectedValue(new Error('gone'));
    await expect(shareMessageOutside(msg())).resolves.toBe('failed');
    expect(mockShareAsync).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('names the sheet by type when the envelope carries no filename or caption', async () => {
    await shareMessageOutside(msg({type: 'video', media_mime: 'video/mp4'}));
    expect(mockShareAsync).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({dialogTitle: 'Video'}));
    mockShareAsync.mockClear();
    await shareMessageOutside(msg({type: 'file', media_mime: undefined}));
    expect(mockShareAsync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({dialogTitle: 'File', mimeType: 'application/octet-stream'}),
    );
  });
});
