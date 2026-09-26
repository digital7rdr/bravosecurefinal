import {SettingsCrypto, isEnvelope} from './settings-crypto';
import {randomBytes} from 'node:crypto';

describe('SettingsCrypto', () => {
  const keyB64 = randomBytes(32).toString('base64');

  it('round-trips a secret through encrypt/decrypt', () => {
    const c = new SettingsCrypto(keyB64);
    const secret = 'sk_live_' + 'x'.repeat(40);
    const env = c.encrypt(secret);
    expect(isEnvelope(env)).toBe(true);
    expect(env).not.toContain(secret); // ciphertext must not leak the plaintext
    expect(c.decrypt(env)).toBe(secret);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const c = new SettingsCrypto(keyB64);
    expect(c.encrypt('same')).not.toBe(c.encrypt('same'));
  });

  it('rejects a tampered ciphertext (GCM auth tag)', () => {
    const c = new SettingsCrypto(keyB64);
    const env = c.encrypt('value');
    const parts = env.split(':');
    const ct = Buffer.from(parts[3], 'base64');
    ct[0] ^= 0xff;
    parts[3] = ct.toString('base64');
    expect(() => c.decrypt(parts.join(':'))).toThrow();
  });

  it('cannot decrypt with a different key', () => {
    const a = new SettingsCrypto(keyB64);
    const b = new SettingsCrypto(randomBytes(32).toString('base64'));
    expect(() => b.decrypt(a.encrypt('value'))).toThrow();
  });

  it('accepts hex and raw-32-byte keys', () => {
    expect(new SettingsCrypto(randomBytes(32).toString('hex')).available).toBe(true);
    expect(new SettingsCrypto('x'.repeat(32)).available).toBe(true);
  });

  it('is unavailable (not throwing) when the key is missing or wrong length', () => {
    const none = new SettingsCrypto(undefined);
    expect(none.available).toBe(false);
    expect(none.unavailableReason).toMatch(/not set/);
    expect(() => none.encrypt('x')).toThrow();

    const bad = new SettingsCrypto('too-short');
    expect(bad.available).toBe(false);
    expect(bad.unavailableReason).toMatch(/32 bytes/);
  });
});
