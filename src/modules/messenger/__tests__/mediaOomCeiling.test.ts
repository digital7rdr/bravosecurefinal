/**
 * B-728 — a large attachment killed the PROCESS, not the send.
 *
 * `RNFS.readFile(uri,'base64')` lands in `RNFSManager.readFile`, whose body is
 * wrapped in `catch (Exception ex)`. `OutOfMemoryError` extends `Error`, not
 * `Exception`, so an OOM in there is never caught, never becomes a rejected
 * promise, and escapes the `@ReactMethod` on the NativeModules thread — which
 * in a release build Android turns into process death. `writeFile` carries the
 * identical clause.
 *
 * WHY EVERY EXISTING CAP MISSED IT. There were four size checks in the tree
 * (ChatScreen, DepartmentChatScreen, incidentEvidence, and productionRuntime's
 * MAX_ATTACHMENT_BYTES) and all four test `bytes.byteLength` — that is, they run
 * AFTER the allocation that kills the process. A check downstream of the crash
 * can never prevent it.
 *
 * So the assertion that matters here is not "it throws" — it is that the NATIVE
 * CALL IS NEVER MADE. A gate that throws after `readFile` would pass a naive
 * test and still crash the phone.
 *
 * AND the second lesson, from the adversarial review that followed the first
 * cut: collapsing both directions into ONE constant is itself a regression. The
 * server accepts 50 MB, so bytes larger than our UPLOAD ceiling legitimately
 * arrive from other clients — gating the write side at the read number stranded
 * them (an infinite re-download loop on the bubble, a vault row that charged an
 * MFA proof before refusing). The two ceilings are pinned apart below.
 */
const mockStat = jest.fn();
const mockReadFile = jest.fn();
const mockWriteFile = jest.fn();
const mockExists = jest.fn();

jest.mock('react-native-fs', () => ({
  __esModule: true,
  default: {
    CachesDirectoryPath: '/caches',
    stat:      (...a: unknown[]) => mockStat(...a),
    readFile:  (...a: unknown[]) => mockReadFile(...a),
    writeFile: (...a: unknown[]) => mockWriteFile(...a),
    exists:    (...a: unknown[]) => mockExists(...a),
  },
}));

import {readUriBytes, writeTempBytes} from '../media/mediaFiles';
import {
  MAX_INLINE_MEDIA_BYTES,
  MAX_INLINE_MEDIA_MB,
  MAX_DECRYPT_WRITE_BYTES,
  MediaTooLargeError,
} from '../media/mediaLimits';
import {classifyAttachmentError, isTerminalAttachmentError, attachmentErrorText} from '../media/attachmentError';

const MB = 1024 * 1024;

/** base64 of N zero bytes — what the native side would hand back. */
function b64Zeros(n: number): string {
  return Buffer.alloc(n).toString('base64');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockExists.mockResolvedValue(false);
  mockWriteFile.mockResolvedValue(undefined);
  mockReadFile.mockResolvedValue(b64Zeros(8));
});

describe('B-728 — the read gate runs BEFORE the native call', () => {
  it('THE BUG: an oversized file never reaches RNFS.readFile', async () => {
    mockStat.mockResolvedValue({size: MAX_INLINE_MEDIA_BYTES + 1});
    await expect(readUriBytes('file:///huge.mp4')).rejects.toBeInstanceOf(MediaTooLargeError);
    // The whole point. Reaching readFile at all is the crash; a gate that only
    // rejects afterwards is decorative.
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('reports both the size and the limit, because the user sees this string', async () => {
    mockStat.mockResolvedValue({size: 60 * MB});
    // Every readUriBytes caller surfaces `e.message` verbatim — VaultScreen into
    // "Not saved to vault", FileViewer into "Not moved to vault".
    await expect(readUriBytes('file:///huge.mp4'))
      .rejects.toThrow(new RegExp(`60 MB.*${MAX_INLINE_MEDIA_MB} MB`));
  });

  it('a file at the limit still reads — the gate is >, not >=', async () => {
    mockStat.mockResolvedValue({size: MAX_INLINE_MEDIA_BYTES});
    await expect(readUriBytes('file:///exactly.bin')).resolves.toBeInstanceOf(Uint8Array);
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  it('an ordinary photo is untouched', async () => {
    mockStat.mockResolvedValue({size: 3 * MB});
    await expect(readUriBytes('file:///photo.jpg')).resolves.toBeInstanceOf(Uint8Array);
    expect(mockReadFile).toHaveBeenCalledWith('file:///photo.jpg', 'base64');
  });
});

describe('B-728 — the gate fails OPEN when the platform cannot size the source', () => {
  it('a stat rejection does not block the read', async () => {
    // `RNFS.stat` resolves content:// through MediaStore.Images.Media.DATA,
    // deprecated and commonly null on Android 10+. Refusing on "don't know"
    // would break every SAF pick — a far bigger outage than the crash.
    mockStat.mockRejectedValue(new Error('File does not exist'));
    await expect(readUriBytes('content://provider/42')).resolves.toBeInstanceOf(Uint8Array);
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  it('a non-numeric size does not block the read', async () => {
    mockStat.mockResolvedValue({size: undefined});
    await expect(readUriBytes('content://provider/43')).resolves.toBeInstanceOf(Uint8Array);
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  it('a string size still gates — RNFS has handed back both shapes', async () => {
    mockStat.mockResolvedValue({size: String(80 * MB)});
    await expect(readUriBytes('file:///huge.bin')).rejects.toBeInstanceOf(MediaTooLargeError);
    expect(mockReadFile).not.toHaveBeenCalled();
  });
});

describe('B-728 — the two ceilings must stay APART (regression pin)', () => {
  it('the write ceiling is strictly higher than the upload ceiling', () => {
    // Collapsing these was a P1: the server accepts 50 MB, so an older build,
    // iOS or the ops-console can legitimately hand us more than we would accept
    // from a picker. Gating the write side at the read number made that content
    // permanently unopenable.
    expect(MAX_DECRYPT_WRITE_BYTES).toBeGreaterThan(MAX_INLINE_MEDIA_BYTES);
  });

  it('each ceiling fits its OWN peak-allocation cost', () => {
    // read  ~5N   (BAOS doubling + toByteArray + base64 byte[] + UTF-16 String)
    // write ~3.7N (the base64 String we hand in + the decoded byte[])
    // Budget: a 256 MB heapgrowthlimit with the app already resident.
    expect(MAX_INLINE_MEDIA_BYTES * 5).toBeLessThan(192 * MB);
    expect(MAX_DECRYPT_WRITE_BYTES * 3.7).toBeLessThan(192 * MB);
  });

  it('a file between the two ceilings is refused on upload but still OPENS', async () => {
    const between = (MAX_INLINE_MEDIA_BYTES + MAX_DECRYPT_WRITE_BYTES) / 2;
    mockStat.mockResolvedValue({size: between});
    await expect(readUriBytes('file:///mid.mp4')).rejects.toBeInstanceOf(MediaTooLargeError);
    // ...but the SAME size, arriving as received bytes, must materialise.
    await expect(writeTempBytes(new Uint8Array(1024), 'video/mp4', 'mid'))
      .resolves.toContain('file://');
    expect(between).toBeLessThan(MAX_DECRYPT_WRITE_BYTES);
  });
});

describe('B-728 — the write side has the identical hazard', () => {
  it('oversized plaintext never reaches RNFS.writeFile', async () => {
    const big = new Uint8Array(MAX_DECRYPT_WRITE_BYTES + 1);
    await expect(writeTempBytes(big, 'video/mp4', 'msg-1'))
      .rejects.toBeInstanceOf(MediaTooLargeError);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('normal plaintext still writes', async () => {
    await expect(writeTempBytes(new Uint8Array(1024), 'image/jpeg', 'msg-2'))
      .resolves.toContain('file://');
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  it('an already-cached file is returned without re-checking size', async () => {
    // The warm path neither decodes nor writes, so the ceiling is irrelevant
    // there and an oversized legacy file already on disk must still open.
    mockExists.mockResolvedValue(true);
    const big = new Uint8Array(MAX_DECRYPT_WRITE_BYTES + 1);
    await expect(writeTempBytes(big, 'video/mp4', 'msg-3')).resolves.toContain('file://');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

describe('B-728 — a refusal must not become a bandwidth loop', () => {
  it('classifies as too_large, never the retryable default', () => {
    // P1: it used to fall through to 'unavailable' -> "Tap to retry" -> every
    // tap re-downloaded and re-decrypted tens of megabytes to fail identically.
    expect(classifyAttachmentError(new MediaTooLargeError(40 * MB, MAX_DECRYPT_WRITE_BYTES)))
      .toBe('too_large');
  });

  it('too_large is TERMINAL', () => {
    expect(isTerminalAttachmentError('too_large')).toBe(true);
    expect(isTerminalAttachmentError('offline')).toBe(false);
    expect(isTerminalAttachmentError('unavailable')).toBe(false);
  });

  it('its copy does not invite a retry', () => {
    expect(attachmentErrorText('too_large')).not.toMatch(/retry/i);
    expect(attachmentErrorText('too_large')).toMatch(/too large/i);
    // The retryable default still does.
    expect(attachmentErrorText('unavailable')).toMatch(/retry/i);
  });

  it('MediaTooLargeError carries the numbers a caller may branch on', () => {
    const e = new MediaTooLargeError(99 * MB, MAX_DECRYPT_WRITE_BYTES);
    expect(e.sizeBytes).toBe(99 * MB);
    expect(e.limitBytes).toBe(MAX_DECRYPT_WRITE_BYTES);
    expect(e.terminal).toBe(true);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('MediaTooLargeError');
  });
});

describe('B-728 — the refusal happens before anything expensive is spent', () => {
  // Source scans: these two decision sites live in modules the node project
  // cannot import (RN screens / the runtime seam). Comment-stripped and
  // whitespace-collapsed; the source is CRLF so nothing is \n-anchored.
  const load = (...seg: string[]) =>

    (require('node:fs') as typeof import('node:fs'))
      .readFileSync((require('node:path') as typeof import('node:path'))
        .join(process.cwd(), ...seg), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\r\n]*/g, '')
      .replace(/\s+/g, ' ');

  it('the vault refuses an oversized file at the DOOR, not on the way out', () => {
    // P1: `moveBytesToVault` was ungated, so a received 40 MB video could be
    // stored and then refused forever by writeTempBytes — after charging a
    // biometric prompt, an MFA proof, a download and a decrypt, every time.
    const src = load('src', 'modules', 'messenger', 'vault', 'vaultOps.ts');
    const at = src.indexOf('params.bytes.byteLength > MAX_DECRYPT_WRITE_BYTES');
    expect(at).toBeGreaterThan(-1);
    // ...and it must come BEFORE the ceremony, or the refusal still costs a proof.
    expect(at).toBeLessThan(src.indexOf('runLocalBiometric(\'Confirm to move'));
  });

  it('an oversized vault ROW is refused before its ceremony too', () => {
    const src = load('src', 'modules', 'messenger', 'vault', 'vaultOps.ts');
    const open = src.indexOf('export async function openVaultFileUri');
    const gate = src.indexOf('f.size > MAX_DECRYPT_WRITE_BYTES', open);
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(src.indexOf('runLocalBiometric(\'Confirm to open', open));
  });

  it('the receive path refuses before the download, using the declared size', () => {
    const src = load('src', 'modules', 'messenger', 'media', 'useAttachmentUri.ts');
    const gate = src.indexOf('declared > MAX_DECRYPT_WRITE_BYTES');
    expect(gate).toBeGreaterThan(-1);
    // Before `downloadMedia`, or the retry still costs the whole transfer.
    expect(gate).toBeLessThan(src.indexOf('rt.downloadMedia('));
  });
});
