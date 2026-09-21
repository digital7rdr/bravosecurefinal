import {createCipheriv, createDecipheriv, hkdfSync, randomBytes} from 'node:crypto';

/**
 * Sealing for the check-in face photo (founder decision 2026-09-05 — see the
 * migration note in 20260905140000_attendance_checkin_place_photo.sql).
 *
 * AES-256-GCM, one random 12-byte IV per photo, the SESSION id bound as AAD so
 * a sealed blob copied onto another session row fails to open. The key is
 * DERIVED (HKDF-SHA256) from the server's existing at-rest secret with a
 * purpose label, so this lane has its own key without a new deployment
 * secret and without sharing raw key bytes with the TOTP lane.
 *
 * Pure functions — unit-pinned in attendance-photo.service.spec.ts.
 */

const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const PURPOSE = 'bravo-secure/attendance-checkin-photo/v1';

/** 32 bytes for this purpose, from a 64-hex root secret. Throws on a bad root. */
export function derivePhotoKey(rootHex: string): Buffer {
  const root = Buffer.from((rootHex ?? '').trim(), 'hex');
  if (root.length !== KEY_LEN) throw new Error('attendance photo root key must be 64 hex chars');
  return Buffer.from(hkdfSync('sha256', root, 'attendance-photo', PURPOSE, KEY_LEN));
}

/** iv || ciphertext || tag */
export function sealPhoto(plain: Buffer, key: Buffer, sessionId: string): Buffer {
  if (key.length !== KEY_LEN) throw new Error('photo key must be 32 bytes');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(sessionId, 'utf8'));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]);
}

export function openPhoto(sealed: Buffer, key: Buffer, sessionId: string): Buffer {
  if (key.length !== KEY_LEN) throw new Error('photo key must be 32 bytes');
  if (sealed.length < IV_LEN + TAG_LEN + 1) throw new Error('sealed photo too short');
  const iv = sealed.subarray(0, IV_LEN);
  const tag = sealed.subarray(sealed.length - TAG_LEN);
  const ct = sealed.subarray(IV_LEN, sealed.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(sessionId, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** JPEG / PNG only, by magic bytes — the client's declared mime is not trusted. */
export function sniffImageMime(bytes: Buffer): 'image/jpeg' | 'image/png' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}
