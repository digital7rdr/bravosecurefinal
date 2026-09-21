/**
 * Brand assets must be reachable WITHOUT a session.
 *
 * The middleware matcher exempted only `/_next/*` and the exact path
 * `/favicon.ico`, so every other file in `public/` was caught by the auth
 * gate and 307'd to /login — including the logo the login page itself
 * renders, and the whole favicon set. The assets shipped; they were never
 * servable. A 307 on an <img> is silent (a broken image, not an error), so
 * only a pin catches this coming back.
 *
 * Scanner discipline per CLAUDE.md: strip comments before any absence
 * assertion, and anchor on \r?\n — these files are CRLF.
 */

import fs from 'fs';
import path from 'path';
import {PUBLIC_ASSETS, isPublicAsset} from '../lib/publicRoutes';

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const MIDDLEWARE = path.join(__dirname, '..', 'middleware.ts');

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(line => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
}

describe('public/ brand assets bypass the auth gate', () => {
  const onDisk = fs
    .readdirSync(PUBLIC_DIR, {withFileTypes: true})
    .filter(e => e.isFile())
    .map(e => '/' + e.name);

  it('scans a non-trivial number of files (the scan is not vacuous)', () => {
    expect(onDisk.length).toBeGreaterThan(5);
  });

  it('every file shipped in public/ is on the allowlist', () => {
    const missing = onDisk.filter(p => !isPublicAsset(p));
    // A new file in public/ is either a brand asset (add it to
    // PUBLIC_ASSETS) or something that should not be served at all
    // (do not put it in public/).
    expect(missing).toEqual([]);
  });

  it('the login page logo is public — it renders pre-auth', () => {
    expect(isPublicAsset('/bravo-logo-light.svg')).toBe(true);
  });

  it('the allowlist is exact-match, never a prefix or extension rule', () => {
    expect(isPublicAsset('/bravo-logo-light.svg/../../etc/passwd')).toBe(false);
    expect(isPublicAsset('/bravo-logo-light.svgx')).toBe(false);
    expect(isPublicAsset('/secret.png')).toBe(false);
    expect(isPublicAsset('')).toBe(false);
    expect(isPublicAsset(null)).toBe(false);
  });

  it('a console route is NOT treated as a public asset', () => {
    for (const p of ['/dashboard', '/finance', '/people/users', '/api/ops/me']) {
      expect(isPublicAsset(p)).toBe(false);
    }
  });

  it('middleware consults the allowlist, not a bare favicon.ico compare', () => {
    const src = stripComments(fs.readFileSync(MIDDLEWARE, 'utf8'));
    expect(src).toContain('isPublicAsset(pathname)');
    // The old hardcoded compare is what caused the bug.
    expect(src).not.toMatch(/pathname\s*===\s*['"]\/favicon\.ico['"]/);
  });

  it('PUBLIC_ASSETS has no duplicates', () => {
    expect(new Set(PUBLIC_ASSETS).size).toBe(PUBLIC_ASSETS.length);
  });
});
