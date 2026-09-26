/**
 * settings-crypto — AES-256-GCM envelope for platform_settings secrets.
 *
 * A secret is stored as  v1:<iv_b64>:<tag_b64>:<ciphertext_b64>  where the key
 * is SETTINGS_ENCRYPTION_KEY from the environment (the one bootstrap secret that
 * stays out of the database). The DB never holds a secret in clear, and a leaked
 * DB dump is useless without the env key.
 *
 * The key is accepted as base64 (44 chars), hex (64 chars) or 32 raw bytes, so
 * `openssl rand -base64 32` or `openssl rand -hex 32` both work. Anything that
 * does not resolve to 32 bytes is rejected loudly at first use — a wrong-length
 * key must never silently fall back to a weaker cipher.
 */
import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';

const ENVELOPE = /^v1:([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/;
const IV_BYTES = 12; // GCM standard nonce length

function decodeKey(raw: string): Buffer {
  const s = raw.trim();
  // hex (exactly 64 lowercase/uppercase hex chars)
  if (/^[0-9a-fA-F]{64}$/.test(s)) {return Buffer.from(s, 'hex');}
  // base64 / base64url that decodes to 32 bytes
  if (/^[A-Za-z0-9+/=_-]{43,45}$/.test(s)) {
    const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length === 32) {return b;}
  }
  // raw 32-byte passphrase
  const utf = Buffer.from(s, 'utf8');
  if (utf.length === 32) {return utf;}
  throw new Error(
    'SETTINGS_ENCRYPTION_KEY must resolve to 32 bytes (base64 of 32 bytes, 64 hex chars, or a 32-char string). ' +
    'Generate one with: openssl rand -base64 32',
  );
}

export class SettingsCrypto {
  private readonly key: Buffer | null;
  private readonly keyError: string | null;

  constructor(rawKey: string | undefined) {
    if (!rawKey) {
      this.key = null;
      this.keyError = 'SETTINGS_ENCRYPTION_KEY is not set';
    } else {
      try {
        this.key = decodeKey(rawKey);
        this.keyError = null;
      } catch (e) {
        this.key = null;
        this.keyError = (e as Error).message;
      }
    }
  }

  /** True when a usable 32-byte key is configured. */
  get available(): boolean {
    return this.key !== null;
  }

  /** Human-readable reason encryption is unavailable, for API error surfaces. */
  get unavailableReason(): string | null {
    return this.keyError;
  }

  encrypt(plaintext: string): string {
    if (!this.key) {throw new Error(this.keyError ?? 'settings encryption key unavailable');}
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
  }

  decrypt(envelope: string): string {
    if (!this.key) {throw new Error(this.keyError ?? 'settings encryption key unavailable');}
    const m = ENVELOPE.exec(envelope);
    if (!m) {throw new Error('malformed settings envelope');}
    const iv = Buffer.from(m[1], 'base64');
    const tag = Buffer.from(m[2], 'base64');
    const ct = Buffer.from(m[3], 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}

/** True if a string looks like our envelope (used to guard accidental double-encrypt). */
export function isEnvelope(v: string): boolean {
  return ENVELOPE.test(v);
}
