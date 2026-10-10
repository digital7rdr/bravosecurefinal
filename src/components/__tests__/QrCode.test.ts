import {create} from 'qrcode';
import {qrPath} from '../QrCode';

// The authenticator QR (2026-10-11): one 1×1 square per dark module, offset
// by a 2-module quiet zone, so the drawn code is exactly the encoded one.
describe('qrPath', () => {
  const uri = 'otpauth://totp/Bravo%20Secure:ops%40bravosecure.cloud?secret=JBSWY3DPEHPK3PXP&issuer=Bravo%20Secure';

  it('draws every dark module and nothing else, inside a quiet zone', () => {
    const qr = create(uri, {errorCorrectionLevel: 'M'});
    const n = qr.modules.size;
    const {size, d} = qrPath(uri);
    expect(size).toBe(n + 4);
    const squares = [...d.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map(m => [Number(m[1]) - 2, Number(m[2]) - 2]);
    const dark = Array.from(qr.modules.data).filter(Boolean).length;
    expect(squares).toHaveLength(dark);
    for (const [x, y] of squares) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(n);
      expect(qr.modules.data[y * n + x]).toBeTruthy();
    }
  });

  it('starts with the top-left finder pattern', () => {
    expect(qrPath(uri).d.startsWith('M2 2h1v1h-1z')).toBe(true);
  });
});
