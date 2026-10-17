import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isApiHostedFile, kindOf} from '../components/DocumentViewerModal';

/**
 * Owner, 2026-10-17: "open the documents in the popup modal". Reviewers see a
 * provider / officer document in a modal over the review page instead of a
 * new browser tab.
 */
const SRC = join(process.cwd(), 'apps', 'ops-console', 'src');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');

describe('document viewer modal', () => {
  it('fetches only from the API host (where /uploads is served)', () => {
    const api = 'https://auth.bravosecure.cloud';
    expect(isApiHostedFile('https://auth.bravosecure.cloud/uploads/u-1/a.pdf', api)).toBe(true);
    expect(isApiHostedFile('http://localhost:3001/uploads/u-1/a.pdf', api)).toBe(false);
    expect(isApiHostedFile('https://evil.example/uploads/u-1/a.pdf', api)).toBe(false);
    expect(isApiHostedFile('javascript:alert(1)', api)).toBe(false);
    expect(isApiHostedFile('not a url', api)).toBe(false);
  });

  it('picks image / pdf / other from the content type, then the extension', () => {
    expect(kindOf('image/jpeg', 'x')).toBe('image');
    expect(kindOf('application/pdf', 'x')).toBe('pdf');
    expect(kindOf('application/octet-stream', 'https://a/b/20261016T0930_TradeLicence_v1.PDF')).toBe('pdf');
    expect(kindOf('', 'https://a/b/scan.heic')).toBe('image');
    expect(kindOf('application/zip', 'https://a/b/c.zip')).toBe('other');
  });

  it('every reviewer VIEW uses the modal, not a new tab', () => {
    const pages = [
      ['app', '(console)', 'people', 'agents', '[id]', 'page.tsx'],
      ['app', '(console)', 'people', 'agencies', '[id]', 'page.tsx'],
      ['app', '(console)', 'people', 'compliance', 'page.tsx'],
    ];
    for (const p of pages) {
      const src = read(...p);
      expect(src).toMatch(/useDocumentViewer\(\)/);
      expect(src).toMatch(/\{viewer\.modal\}/);
      expect(src).not.toMatch(/window\.open\(/);
    }
    expect(read('lib', 'providerDocs.ts')).not.toMatch(/window\.open\(/);
  });

  it('the console CSP admits blob: frames for PDFs and nothing third-party', () => {
    const mw = read('middleware.ts');
    expect(mw).toMatch(/`frame-src 'self' blob:`/);
    expect(mw).toMatch(/`object-src blob:`/);
    expect(mw).toMatch(/`frame-ancestors 'none'`/);
    expect(mw).toMatch(/`img-src 'self' data: blob:/);
  });
});
