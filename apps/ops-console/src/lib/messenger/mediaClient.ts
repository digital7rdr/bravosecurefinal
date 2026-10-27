/**
 * 2026-10-27 (owner: "The Web Messenger needs to have the function of adding
 * and sharing files in the chat") — encrypted file transfer for the browser.
 *
 * The same flow and bytes as the app's MediaClient:
 *   upload   — encrypt locally (fresh per-file key, attachmentCrypto v2),
 *              POST /media/upload-url, PUT the ciphertext to the presigned URL;
 *   download — POST /media/download-url/<key>, GET, verify HMAC, decrypt.
 * The per-file key and IV never leave this module except inside the sealed
 * message (own-device mode) or the end-to-end encrypted phone link.
 *
 * Authenticated with the short-lived messenger ticket plus this browser's
 * device id (its own Signal device, or the linked browser's reserved id).
 */
import {encryptAttachmentBlob, decryptAttachmentBlob} from '@bravo/messenger-core';
import {getMessengerTicket} from '@/lib/api';
import {messengerBase} from './linkClient';

/** Server cap is 50 MB of ciphertext; the browser stays well under it. */
export const WEB_FILE_MAX_BYTES = 25 * 1024 * 1024;

export interface WebAttachment {
  objectKey: string;
  keyB64:    string;
  ivB64:     string;
  mimeType:  string;
  size:      number;
  name?:     string | null;
  kind?:     'image' | 'audio' | 'video' | 'file';
}

export class WebMediaError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** The renderer kind the app uses for this MIME type. */
export function kindForMime(mime: string): WebAttachment['kind'] {
  if (/^image\//.test(mime)) return 'image';
  if (/^video\//.test(mime)) return 'video';
  if (/^audio\//.test(mime)) return 'audio';
  return 'file';
}

/** A MIME type the server's validator accepts (it signs this exact value). */
export function safeMime(type: string): string {
  return type && type.length <= 100 && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(type)
    ? type : 'application/octet-stream';
}

async function authJson<T>(path: string, deviceId: number, body?: unknown): Promise<T> {
  const go = async (ticket: string) => fetch(`${messengerBase()}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ticket}`,
      'X-Signal-Device-Id': String(deviceId),
      ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
    },
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    cache: 'no-store',
  });
  let res = await go(await getMessengerTicket());
  if (res.status === 401) res = await go(await getMessengerTicket(true));
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) {
    const msg = parsed && typeof parsed === 'object' && 'message' in parsed
      ? String((parsed as {message: unknown}).message) : `http_${res.status}`;
    throw new WebMediaError(res.status, msg);
  }
  return (parsed ?? {}) as T;
}

/** Encrypt and upload one file. Returns what the message must carry. */
export async function uploadFile(file: File, deviceId: number): Promise<WebAttachment> {
  if (file.size > WEB_FILE_MAX_BYTES) throw new WebMediaError(413, 'file_too_large');
  if (file.size === 0) throw new WebMediaError(400, 'empty_file');
  const mimeType = safeMime(file.type);
  const plain = new Uint8Array(await file.arrayBuffer());
  const enc = await encryptAttachmentBlob(plain);
  const {uploadUrl, objectKey} = await authJson<{uploadUrl: string; objectKey: string}>(
    '/media/upload-url', deviceId, {contentLength: enc.ciphertext.byteLength, contentType: mimeType});
  const body = new Blob([enc.ciphertext.buffer.slice(
    enc.ciphertext.byteOffset, enc.ciphertext.byteOffset + enc.ciphertext.byteLength) as ArrayBuffer]);
  const put = await fetch(uploadUrl, {method: 'PUT', headers: {'Content-Type': mimeType}, body});
  if (!put.ok) throw new WebMediaError(put.status, 'upload_failed');
  return {
    objectKey, keyB64: enc.keyB64, ivB64: enc.ivB64, mimeType, size: file.size,
    name: file.name ? file.name.slice(0, 255) : null, kind: kindForMime(mimeType),
  };
}

/** Let the recipients download it (strict-grant mode). Best-effort, retried. */
export async function grantFile(objectKey: string, recipientUserIds: string[], deviceId: number): Promise<void> {
  const ids = [...new Set(recipientUserIds.filter(Boolean))].slice(0, 1024);
  if (!ids.length) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await authJson('/media/grants', deviceId, {objectKey, recipientUserIds: ids}); return; }
    catch (e) {
      const s = e instanceof WebMediaError ? e.status : 0;
      if (!(s === 0 || s === 429 || s >= 500) || attempt === 2) throw e;
      await new Promise(r => setTimeout(r, attempt === 0 ? 1000 : 4000));
    }
  }
}

/** Download, verify and decrypt a file. Returns a Blob of the original type. */
export async function downloadFile(att: WebAttachment, deviceId: number): Promise<Blob> {
  const {downloadUrl} = await authJson<{downloadUrl: string}>(
    `/media/download-url/${att.objectKey}`, deviceId);
  const res = await fetch(downloadUrl, {cache: 'no-store'});
  if (!res.ok) throw new WebMediaError(res.status, 'download_failed');
  const ct = new Uint8Array(await res.arrayBuffer());
  const plain = await decryptAttachmentBlob({keyB64: att.keyB64, ivB64: att.ivB64, ciphertext: ct});
  return new Blob([plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength) as ArrayBuffer],
    {type: safeMime(att.mimeType)});
}

/** Save a decrypted file to the user's computer. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'file';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Human size, e.g. "2.4 MB". */
export function sizeLabel(n: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
