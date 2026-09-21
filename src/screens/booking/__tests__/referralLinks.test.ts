/**
 * Referral deep links (2026-09-05) — the parser both link shapes go through.
 * Node project (booking): no RN imports, relative path on purpose (this
 * project has no module aliases).
 */
import {normaliseReferralCode, parseReferralUrl, REFERRAL_SCHEME} from '../../../modules/referral/referralLinks';

describe('parseReferralUrl', () => {
  it('accepts the custom scheme in its common spellings', () => {
    expect(REFERRAL_SCHEME).toBe('bravosecure');
    expect(parseReferralUrl('bravosecure://r/DXB20')).toBe('DXB20');
    expect(parseReferralUrl('bravosecure:///r/dxb20')).toBe('DXB20');
    expect(parseReferralUrl('BravoSecure://r/dxb-20?utm=x')).toBe('DXB-20');
  });

  it('accepts the public web landing on any host, path exactly /r/<code>', () => {
    expect(parseReferralUrl('https://ops.94-136-184-52.sslip.io/r/DXB20')).toBe('DXB20');
    expect(parseReferralUrl('http://localhost:3002/r/dxb20/')).toBe('DXB20');
    expect(parseReferralUrl('https://example.com/r/DXB%2D20#x')).toBe('DXB-20');
  });

  it('ignores everything that is not a referral link', () => {
    expect(parseReferralUrl(null)).toBeNull();
    expect(parseReferralUrl('')).toBeNull();
    expect(parseReferralUrl('https://ops.94-136-184-52.sslip.io/lite/bookings/abc')).toBeNull();
    expect(parseReferralUrl('https://example.com/foo/r/DXB20')).toBeNull();
    expect(parseReferralUrl('bravosecure://booking/abc')).toBeNull();
    expect(parseReferralUrl('mailto:r/DXB20')).toBeNull();
    // A one-character "code" is noise (server minimum is 2).
    expect(parseReferralUrl('bravosecure://r/X')).toBeNull();
  });

  it('normalises like the code box and the server DTO', () => {
    expect(normaliseReferralCode('  dxb 20! ')).toBe('DXB20');
    expect(normaliseReferralCode('--dxb-20')).toBe('DXB-20');
    expect(normaliseReferralCode('a'.repeat(40))).toHaveLength(32);
    expect(normaliseReferralCode(undefined)).toBe('');
  });
});
