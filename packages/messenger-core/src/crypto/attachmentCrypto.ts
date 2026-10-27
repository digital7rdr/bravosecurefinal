/**
 * 2026-10-27 — attachment encryption for the WEB messenger, byte-compatible
 * with the app (src/modules/messenger/media/aesCbc.ts):
 *
 *   blob = 0x02 ‖ AES-256-CBC(PKCS#7)(plaintext) ‖ HMAC-SHA256(hk, 0x02 ‖ ct)
 *   hk   = HKDF-SHA256(ikm = AES key, salt = none, info = 'Bravo-Attachment-HMAC-v2', 32)
 *
 * A fresh 32-byte key and 16-byte IV per file; both travel only inside the
 * sealed envelope. v2 is the only accepted format (CRY-01: the version byte
 * is covered by the tag, so a downgrade is caught). The HMAC is verified,
 * in constant time, BEFORE the AES decrypt runs.
 *
 * The app's copy uses react-native-quick-crypto for AES; this one uses
 * WebCrypto (browsers, Node ≥ 18). Same algorithm, same bytes — pinned by
 * the cross-implementation test in __tests__/attachmentCrypto.test.ts.
 */
import {hkdf} from '@noble/hashes/hkdf.js';
import {sha256} from '@noble/hashes/sha2.js';
import {hmac} from '@noble/hashes/hmac.js';

const KEY_BYTES = 32;
const IV_BYTES = 16;
const HMAC_BYTES = 32;
const FORMAT_V2 = 0x02;
const HKDF_INFO_HMAC = new TextEncoder().encode('Bravo-Attachment-HMAC-v2');

export interface EncryptedAttachmentBlob {
  keyB64: string;
  ivB64: string;
  /** Object body to upload. */
  ciphertext: Uint8Array;
}

function subtle(): SubtleCrypto {
  const c = (globalThis as {crypto?: Crypto}).crypto;
  if (!c?.subtle) throw new Error('attachment crypto: WebCrypto is not available');
  return c.subtle;
}

/** A plain ArrayBuffer copy — assignable to every BufferSource flavour. */
function ab(u: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
}

function b64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return typeof btoa === 'function' ? btoa(s) : Buffer.from(u).toString('base64');
}

function unb64(s: string): Uint8Array {
  if (typeof atob !== 'function') return new Uint8Array(Buffer.from(s, 'base64'));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hmacKeyFor(aesKey: Uint8Array): Uint8Array {
  return hkdf(sha256, aesKey, undefined, HKDF_INFO_HMAC, HMAC_BYTES);
}

function constantTimeEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function encryptAttachmentBlob(plaintext: Uint8Array): Promise<EncryptedAttachmentBlob> {
  const key = new Uint8Array(KEY_BYTES);
  const iv = new Uint8Array(IV_BYTES);
  globalThis.crypto.getRandomValues(key);
  globalThis.crypto.getRandomValues(iv);
  return encryptAttachmentWith(plaintext, key, iv);
}

/** Deterministic core (tests pass a fixed key/iv). */
export async function encryptAttachmentWith(
  plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array,
): Promise<EncryptedAttachmentBlob> {
  if (key.byteLength !== KEY_BYTES || iv.byteLength !== IV_BYTES) throw new Error('invalid key or iv length');
  const k = await subtle().importKey('raw', ab(key), {name: 'AES-CBC'}, false, ['encrypt']);
  const aesCt = new Uint8Array(await subtle().encrypt({name: 'AES-CBC', iv: ab(iv)}, k, ab(plaintext)));
  const macInput = new Uint8Array(1 + aesCt.byteLength);
  macInput[0] = FORMAT_V2;
  macInput.set(aesCt, 1);
  const tag = hmac(sha256, hmacKeyFor(key), macInput);
  const out = new Uint8Array(1 + aesCt.byteLength + HMAC_BYTES);
  out[0] = FORMAT_V2;
  out.set(aesCt, 1);
  out.set(tag, 1 + aesCt.byteLength);
  return {keyB64: b64(key), ivB64: b64(iv), ciphertext: out};
}

export async function decryptAttachmentBlob(p: {keyB64: string; ivB64: string; ciphertext: Uint8Array}): Promise<Uint8Array> {
  const key = unb64(p.keyB64);
  const iv = unb64(p.ivB64);
  if (key.byteLength !== KEY_BYTES) throw new Error('invalid key length');
  if (iv.byteLength !== IV_BYTES) throw new Error('invalid iv length');
  const ct = p.ciphertext;
  if (ct.byteLength === 0) throw new Error('empty ciphertext');
  if (ct[0] !== FORMAT_V2) throw new Error('attachment format not supported — possible downgrade attack');
  if (ct.byteLength < 1 + HMAC_BYTES) throw new Error('attachment too short for v2');
  const tagAt = ct.byteLength - HMAC_BYTES;
  const aesCt = ct.subarray(1, tagAt);
  const macInput = new Uint8Array(1 + aesCt.byteLength);
  macInput[0] = FORMAT_V2;
  macInput.set(aesCt, 1);
  if (!constantTimeEq(hmac(sha256, hmacKeyFor(key), macInput), ct.subarray(tagAt))) {
    throw new Error('attachment hmac mismatch (tampered or wrong key)');
  }
  const k = await subtle().importKey('raw', ab(key), {name: 'AES-CBC'}, false, ['decrypt']);
  return new Uint8Array(await subtle().decrypt({name: 'AES-CBC', iv: ab(iv)}, k, ab(aesCt)));
}
