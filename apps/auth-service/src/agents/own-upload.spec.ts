import {isOwnUploadUrl} from './own-upload';

describe('isOwnUploadUrl', () => {
  const base = 'https://auth.bravosecure.cloud';
  it('accepts a file under the caller own /uploads folder on the public host', () => {
    expect(isOwnUploadUrl(`${base}/uploads/u-1/20261015T0930_PassportScanFront_v1.jpg`, 'u-1', base)).toBe(true);
    expect(isOwnUploadUrl(`${base}/uploads/u-1/sia-1760000000000`, 'u-1', base)).toBe(true);
  });
  it('refuses another user, another host, traversal, queries and junk', () => {
    expect(isOwnUploadUrl(`${base}/uploads/u-2/a.pdf`, 'u-1', base)).toBe(false);
    expect(isOwnUploadUrl('https://evil.example/uploads/u-1/a.pdf', 'u-1', base)).toBe(false);
    expect(isOwnUploadUrl(`${base}/uploads/u-1/../u-2/a.pdf`, 'u-1', base)).toBe(false);
    expect(isOwnUploadUrl(`${base}/uploads/u-1/a.pdf?x=1`, 'u-1', base)).toBe(false);
    expect(isOwnUploadUrl(`${base}/uploads/u-1/.env`, 'u-1', base)).toBe(false);
    expect(isOwnUploadUrl('javascript:alert(1)', 'u-1', base)).toBe(false);
    expect(isOwnUploadUrl('not a url', 'u-1', base)).toBe(false);
  });
  it('without PUBLIC_BASE_URL still requires the caller own path', () => {
    expect(isOwnUploadUrl('http://localhost:3001/uploads/u-1/a.pdf', 'u-1', '')).toBe(true);
    expect(isOwnUploadUrl('http://localhost:3001/uploads/u-2/a.pdf', 'u-1', '')).toBe(false);
  });
});
