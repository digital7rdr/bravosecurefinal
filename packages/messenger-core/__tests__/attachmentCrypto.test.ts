/**
 * 2026-10-27 — the web attachment cipher is byte-compatible with the app's
 * (src/modules/messenger/media/aesCbc.ts): a blob either side writes, the
 * other side opens.
 */
import {encryptAttachmentBlob, encryptAttachmentWith, decryptAttachmentBlob} from '../src/crypto/attachmentCrypto';
import {encryptAttachment, decryptAttachment} from '../../../src/modules/messenger/media/aesCbc';

const bytes = (n: number) => Uint8Array.from({length: n}, (_, i) => (i * 7 + 3) & 0xff);

describe('web attachment crypto', () => {
  it('round-trips, with the v2 layout (0x02 ‖ ct ‖ 32-byte tag)', async () => {
    const pt = bytes(1000);
    const e = await encryptAttachmentBlob(pt);
    expect(e.ciphertext[0]).toBe(0x02);
    expect((e.ciphertext.byteLength - 1 - 32) % 16).toBe(0);
    await expect(decryptAttachmentBlob(e)).resolves.toEqual(pt);
  });

  it('the APP opens a blob the WEB wrote', async () => {
    const pt = bytes(4097);
    const e = await encryptAttachmentBlob(pt);
    const out = await decryptAttachment({keyB64: e.keyB64, ivB64: e.ivB64, ciphertext: e.ciphertext});
    expect(Array.from(out)).toEqual(Array.from(pt));
  });

  it('the WEB opens a blob the APP wrote', async () => {
    const pt = bytes(333);
    const e = await encryptAttachment(pt);
    const out = await decryptAttachmentBlob({keyB64: e.key, ivB64: e.iv, ciphertext: e.ciphertext});
    expect(Array.from(out)).toEqual(Array.from(pt));
  });

  it('refuses a tampered blob and a downgraded version byte', async () => {
    const e = await encryptAttachmentWith(bytes(64), bytes(32), bytes(16));
    const flipped = e.ciphertext.slice(); flipped[5] ^= 1;
    await expect(decryptAttachmentBlob({...e, ciphertext: flipped})).rejects.toThrow(/hmac mismatch/);
    const v1 = e.ciphertext.slice(); v1[0] = 0x01;
    await expect(decryptAttachmentBlob({...e, ciphertext: v1})).rejects.toThrow(/downgrade/);
  });
});
