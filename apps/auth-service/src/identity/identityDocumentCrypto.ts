import {hkdfSync} from 'node:crypto';
import {openPhoto, sealPhoto, sniffImageMime} from '../attendance/attendancePhotoCrypto';

/**
 * Sealing for the identity document (B-867). Same AES-256-GCM construction as
 * the check-in photo lane — the seal/open/sniff primitives are shared — with a
 * key DERIVED for this purpose only, so an ID scan and a check-in face never
 * open under each other's key even though both descend from the same root.
 *
 * AAD binds the OWNER and the SIDE: a sealed front moved onto another user's
 * row, or swapped into the back slot, refuses to open.
 */

const KEY_LEN = 32;
const PURPOSE = 'bravo-secure/identity-document/v1';

export type DocSide = 'front' | 'back';

/** 32 bytes for this purpose, from the 64-hex at-rest root. Throws on a bad root. */
export function deriveIdentityKey(rootHex: string): Buffer {
  const root = Buffer.from((rootHex ?? '').trim(), 'hex');
  if (root.length !== KEY_LEN) throw new Error('identity document root key must be 64 hex chars');
  return Buffer.from(hkdfSync('sha256', root, 'identity-document', PURPOSE, KEY_LEN));
}

export function identityAad(userId: string, side: DocSide): string {
  return `${userId}:${side}`;
}

export function sealIdentityImage(plain: Buffer, key: Buffer, userId: string, side: DocSide): Buffer {
  return sealPhoto(plain, key, identityAad(userId, side));
}

export function openIdentityImage(sealed: Buffer, key: Buffer, userId: string, side: DocSide): Buffer {
  return openPhoto(sealed, key, identityAad(userId, side));
}

export {sniffImageMime};
