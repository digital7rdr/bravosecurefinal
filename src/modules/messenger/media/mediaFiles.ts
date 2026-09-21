/**
 * Local-file <-> bytes bridge for the encrypted-attachment pipeline.
 *
 *   readUriBytes(uri)        — read a picked file (file:// or content://)
 *                              into a Uint8Array, ready for encrypt+upload.
 *   writeTempBytes(bytes,..) — write decrypted plaintext to a cache file
 *                              and return a file:// uri the native <Image>
 *                              / FileViewer can render. Caller owns cleanup.
 *
 * Plaintext bytes are only ever held in memory or in the app-private
 * cache dir (SQLCipher/keychain-protected device; cache is wiped on
 * uninstall). The decrypted temp file is the unavoidable cost of letting
 * the OS image/video/audio decoders read a uri — there is no API to feed
 * raw bytes to <Image>. We keep it in the private cache, not shared
 * storage, so other apps can't read it.
 */

import RNFS from 'react-native-fs';
import {Buffer} from '@craftzdog/react-native-buffer';

/**
 * B-728 — the OOM ceilings live in `mediaLimits.ts` (no RNFS import, so the
 * attachment-error classifier can `instanceof` the error without pulling a
 * native module into every suite). Read that file for the arithmetic and for
 * why the read and write directions carry DIFFERENT numbers.
 *
 * This is a REFUSAL, not a repair. Chunking via `RNFS.read(path,len,pos)` looks
 * like the obvious rescue and is a trap: that method does
 * `inputStream.skip(position)` and DISCARDS the return value, and
 * `InputStream.skip` is permitted to skip short — so a chunked reader would
 * silently assemble corrupted bytes. Sending a corrupted attachment is worse
 * than refusing a large one. Raising these properly needs a streaming native
 * read/write (or an XHR arraybuffer lane), not a constant edit.
 */
import {
  MAX_INLINE_MEDIA_BYTES, MAX_DECRYPT_WRITE_BYTES, MediaTooLargeError,
} from './mediaLimits';
// Re-exported so the long-standing `@/modules/messenger/media` entry point stays
// the one import site callers need.
export {
  MAX_INLINE_MEDIA_BYTES, MAX_INLINE_MEDIA_MB,
  MAX_DECRYPT_WRITE_BYTES, MAX_DECRYPT_WRITE_MB,
  MediaTooLargeError,
} from './mediaLimits';

/**
 * The source's size in bytes, or null when the platform cannot answer.
 *
 * FAILS OPEN on purpose. `RNFS.stat` resolves a `content://` uri through
 * `MediaStore.Images.Media.DATA`, which is deprecated and commonly null on
 * Android 10+, so a stat failure is a routine "don't know", not a red flag.
 * Refusing on "don't know" would break every SAF pick outright — a far bigger
 * outage than the crash being fixed. In practice this is a narrow gap: both
 * pickers here hand back cache-copied `file://` paths (`copyToCacheDirectory:
 * true`, and react-native-image-picker copies too), which stat answers.
 */
async function sourceSizeBytes(uri: string): Promise<number | null> {
  try {
    const st = await RNFS.stat(uri);
    const n = typeof st.size === 'number' ? st.size : Number(st.size);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Read a picked file uri into bytes. Handles both `file://` paths and
 * Android `content://` SAF uris (react-native-fs reads both on Android;
 * on iOS the picker hands back file:// already).
 *
 * Throws `MediaTooLargeError` before reading anything oversized — see the
 * B-728 note above. Callers must treat that as a normal failure.
 */
export async function readUriBytes(uri: string): Promise<Uint8Array> {
  // B-728 — the gate runs BEFORE the native call. Every existing size check in
  // this codebase (ChatScreen, DepartmentChatScreen, incidentEvidence, and
  // productionRuntime's MAX_ATTACHMENT_BYTES) tests `bytes.byteLength`, i.e.
  // AFTER the allocation that kills the process — so none of them could ever
  // have prevented this. incidentEvidence.ts says so in its own comment:
  // "the RAM spike from readUriBytes has already happened by here (that needs
  // a pre-read stat to avoid — stated, not solved)". This is that stat.
  const size = await sourceSizeBytes(uri);
  if (size !== null && size > MAX_INLINE_MEDIA_BYTES) {
    throw new MediaTooLargeError(size, MAX_INLINE_MEDIA_BYTES);
  }
  // RNFS.readFile with 'base64' is the portable path — it works for
  // content:// uris that a plain fs path read would reject. We decode the
  // base64 to bytes with the same Buffer polyfill the rest of the crypto
  // layer uses.
  //
  // [LAGDIAG] TEMPORARY (B-285) — split the native file read from the JS base64
  // decode. The read is async and off-thread; `Buffer.from(b64,'base64')` is
  // SYNCHRONOUS on the JS thread over a multi-MB string, which is the prime
  // suspect for the 4-6s freezes MIUI's PerfMonitor reported on
  // MessageQueueThreadHandler. Measure before assuming.
  const t0 = Date.now();
  const b64 = await RNFS.readFile(uri, 'base64');
  const t1 = Date.now();
  const out = new Uint8Array(Buffer.from(b64, 'base64'));
  const t2 = Date.now();
  if (t2 - t0 > 200) {
    console.warn(`[LAGDIAG] readUriBytes ${(out.length / 1048576).toFixed(2)}MB read=${t1 - t0}ms b64decode=${t2 - t1}ms`);
  }
  return out;
}

/**
 * B-457 — the temp-cache filename must be INJECTIVE over idHint.
 *
 * The old rule was `idHint.replace(/[^a-zA-Z0-9_-]/g,'').slice(0, 40)`, and
 * `writeTempBytes` skips the write when the path already exists. So any two
 * idHints sharing a 40-char sanitised prefix resolved to ONE file and the
 * second caller was handed the FIRST caller's decrypted plaintext. The vault
 * hit it on every file: keys are `vault/<ownerUuid>/<fileUuid>` and the hint is
 * `vault-<objectKey>`, so the budget ran out inside the owner id and the
 * per-file uuid — the only distinguishing part — was truncated away.
 *
 * Fix: keep a readable (and still filesystem-safe) prefix for debuggability,
 * then append a short hash of the FULL ORIGINAL hint, so characters past the
 * truncation point still change the name. Length budget is unchanged at 48.
 *
 * Every path helper below derives its name from HERE — the reader
 * (`statTempBytes`) and the plaintext cleaner (`deleteTempBytes`) have to agree
 * with the writer or a fix to one of them just moves the bug.
 */
function tempStem(idHint: string): string {
  const raw  = idHint ?? '';
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 31) || 'att';
  return `${safe}-${stemHash(raw)}`;
}

/**
 * Two-lane FNV-1a, 64 bits of output. NOT a security primitive and it does not
 * need to be — nothing trusts this value, it only has to keep two distinct
 * cache keys apart. Kept dependency-free and synchronous because it runs on
 * the JS thread for every attachment mount (see the [LAGDIAG] notes above).
 */
function stemHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * Write decrypted plaintext bytes to a uniquely-named file in the app's
 * private cache directory and return its file:// uri. The extension is
 * derived from the mime so the OS decoder picks the right handler.
 *
 * `idHint` (the message id) keys the filename so re-decrypting the same
 * attachment reuses the same path instead of piling up temp files.
 */
export async function writeTempBytes(
  bytes: Uint8Array,
  mimeType: string,
  idHint: string,
): Promise<string> {
  const ext  = extForMime(mimeType);
  const path = `${RNFS.CachesDirectoryPath}/bravo-media-${tempStem(idHint)}${ext}`;
  const exists = await RNFS.exists(path);
  if (!exists) {
    // B-728 — the same uncatchable-OOM hazard on the way OUT. `RNFS.writeFile`
    // carries the identical `catch (Exception ex)`, and this path allocates a
    // 2.67N UTF-16 base64 String here plus an N byte[] on the Java side.
    //
    // Gated on the WRITE ceiling, NOT the upload one. These bytes are not ours
    // to refuse: the server accepts 50 MB, so an older build, iOS, the
    // ops-console, or a row stored before the upload ceiling landed can all
    // legitimately hand us more than we would accept from a picker. Using the
    // stricter read number here stranded that content — an infinite
    // re-download loop on the chat bubble and a vault row that charged an MFA
    // proof before refusing (adversarial review, 2026-09-02).
    //
    // The size is free here: the array is already in JS, so no stat is needed
    // and there is no fail-open gap on this side.
    if (bytes.byteLength > MAX_DECRYPT_WRITE_BYTES) {
      throw new MediaTooLargeError(bytes.byteLength, MAX_DECRYPT_WRITE_BYTES);
    }
    const b64 = Buffer.from(bytes).toString('base64');
    await RNFS.writeFile(path, b64, 'base64');
  }
  return `file://${path}`;
}

/**
 * Media-parity G4 (2026-07-03) — fast path: return the decrypted temp
 * file's uri when it already exists, WITHOUT touching bytes. The file
 * is the product of a prior authenticated (HMAC-verified) decrypt of
 * this exact message, so re-running the download+verify+decrypt+encode
 * pipeline just to arrive at the same path was pure waste — it ran on
 * every bubble mount and again when the viewer opened. Callers try
 * this first and only fall into the full pipeline on a miss.
 */
export async function statTempBytes(
  mimeType: string,
  idHint: string,
): Promise<string | null> {
  const ext  = extForMime(mimeType);
  const path = `${RNFS.CachesDirectoryPath}/bravo-media-${tempStem(idHint)}${ext}`;
  try {
    return (await RNFS.exists(path)) ? `file://${path}` : null;
  } catch {
    return null;
  }
}

/**
 * Audit MEDIA-A2 (2026-07-02): delete the decrypted-plaintext cache file(s)
 * for a message id. writeTempBytes leaves plaintext in the private cache dir
 * ("caller owns cleanup"), but nothing deleted it — so a disappearing message
 * that burned (bubble + ciphertext-cache + R2 all purged) still left its
 * DECRYPTED plaintext on disk until the OS trimmed the cache. Called from the
 * store-removal subscriber and the expiry sweeper. Best-effort, never throws.
 */
export async function deleteTempBytes(idHint: string): Promise<void> {
  const prefix = `bravo-media-${tempStem(idHint)}`;
  // B-457 transition — files written by a build that used the old
  // `slice(0, 40)` stem carry a different name, so the current rule would walk
  // straight past them and leave decrypted plaintext on disk forever. Sweep the
  // legacy name too. It can only ever match a legacy file: a current name has
  // `-<16 hex>` where the legacy prefix would need a `.` or end-of-name.
  const legacy = `bravo-media-${(idHint ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'att'}`;
  const hit = (name: string, p: string) => name === p || name.startsWith(`${p}.`);
  try {
    const entries = await RNFS.readDir(RNFS.CachesDirectoryPath);
    await Promise.all(
      entries
        .filter(e => e.isFile() && (hit(e.name, prefix) || hit(e.name, legacy)))
        .map(e => RNFS.unlink(e.path).catch(() => undefined)),
    );
  } catch { /* cache dir unreadable — best effort */ }
}

/**
 * B-149 — delete a plaintext SOURCE file the app itself produced (today:
 * the expo-av voice-note recording) once its bytes have been read and
 * encrypted.
 *
 * `deleteTempBytes` above only knows the `bravo-media-<id>` decrypted-VIEW
 * files; it has no idea where the recorder put its capture, so the user's
 * own unencrypted audio sat in the app cache until the OS trimmed it —
 * squarely against this module's "plaintext only in the private cache,
 * caller owns cleanup" contract.
 *
 * DELIBERATELY NARROW. It refuses anything that is not a `file://` path
 * inside the app's own Caches/Documents/Temporary directories, because the
 * obvious generalisation — "delete the asset after upload" — would unlink
 * LIBRARY picks, i.e. delete the user's photo out of their gallery. Only
 * pass a URI the app created. Best-effort, never throws.
 */
export async function deleteEphemeralSource(uri: string): Promise<void> {
  if (!uri?.startsWith('file://')) {return;}
  let path: string;
  try {
    path = decodeURI(uri.replace('file://', ''));
  } catch {
    return;
  }
  const ownedRoots = [
    RNFS.CachesDirectoryPath,
    RNFS.DocumentDirectoryPath,
    RNFS.TemporaryDirectoryPath,
  ].filter((r): r is string => typeof r === 'string' && r !== '');
  if (!ownedRoots.some(root => path.startsWith(root))) {return;}
  try {
    await RNFS.unlink(path);
  } catch { /* already gone / not a file — best effort */ }
}

function extForMime(mime: string): string {
  const m = (mime || '').toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') {return '.jpg';}
  if (m === 'image/png')  {return '.png';}
  if (m === 'image/gif')  {return '.gif';}
  if (m === 'image/webp') {return '.webp';}
  if (m === 'video/mp4')  {return '.mp4';}
  if (m === 'video/quicktime') {return '.mov';}
  if (m === 'video/webm') {return '.webm';}
  if (m === 'video/3gpp') {return '.3gp';}
  if (m === 'audio/mp4' || m === 'audio/m4a' || m === 'audio/x-m4a') {return '.m4a';}
  if (m === 'audio/mpeg') {return '.mp3';}
  if (m === 'audio/ogg')  {return '.ogg';}
  if (m === 'audio/wav' || m === 'audio/x-wav') {return '.wav';}
  if (m === 'audio/aac')  {return '.aac';}
  if (m === 'application/pdf') {return '.pdf';}
  if (m === 'text/plain') {return '.txt';}
  if (m === 'application/zip') {return '.zip';}
  if (m === 'application/msword') {return '.doc';}
  if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {return '.docx';}
  if (m === 'application/vnd.ms-excel') {return '.xls';}
  if (m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {return '.xlsx';}
  if (m === 'application/vnd.ms-powerpoint') {return '.ppt';}
  if (m === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {return '.pptx';}
  // Media-parity M14 — unknown mimes used to produce an EXTENSIONLESS
  // temp file, which external viewers (FileViewer/ACTION_VIEW resolvers
  // pick handlers by extension) could rarely open. '.bin' at least lets
  // the "open with…" chooser appear.
  return '.bin';
}
