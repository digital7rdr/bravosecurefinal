/**
 * IA-11 — a static scan banning hardcoded internal links.
 *
 * The restructure was only safe because every path lives in lib/routes.ts. The
 * moment a page writes `href="/bookings"` again, the next move silently breaks
 * it — a dead link is not a type error and not a lint error.
 *
 * Scanner discipline, straight from CLAUDE.md:
 *  - strip comments FIRST (prose mentioning an old path is the single most
 *    common false positive, and this repo's comments are full of them);
 *  - these files are CRLF, so anchor on \r?\n, never a bare \n.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..');
const ALLOWED_FILES = ['lib/routes.ts', 'lib/nav.tsx', '__tests__'];

/** Paths the console never owned — external or framework-level. */
const EXEMPT_PREFIXES = ['/api/', '/_next', '/favicon', '/assets', '/fonts'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { out.push(...walk(p)); continue; }
    if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** Remove // line comments, block comments and JSX {/* … *\/} comments. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(line => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
}

describe('internal links go through lib/routes.ts', () => {
  const files = walk(SRC).filter(f => {
    const rel = path.relative(SRC, f).replace(/\\/g, '/');
    return !ALLOWED_FILES.some(a => rel.startsWith(a));
  });

  it('scans a non-trivial number of files (the scan itself is not vacuous)', () => {
    // A scan that matches nothing because it walked nothing passes silently.
    // This is the guard against exactly that.
    expect(files.length).toBeGreaterThan(30);
  });

  it('no page hardcodes an internal href or router path', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      const rel = path.relative(SRC, f).replace(/\\/g, '/');
      const patterns = [
        /href=\{?["'`](\/[a-z][a-z0-9/[\]-]*)/g,
        /router\.(?:push|replace)\(["'`](\/[a-z][a-z0-9/[\]-]*)/g,
        /window\.location\.(?:assign|replace)\(["'`](\/[a-z][a-z0-9/[\]-]*)/g,
      ];
      for (const re of patterns) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
          const p = m[1];
          if (EXEMPT_PREFIXES.some(x => p.startsWith(x))) continue;
          offenders.push(`${rel}: ${p}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no source still references a pre-restructure section path', () => {
    // Not just links: a fetch key, a comparison against usePathname, or a
    // string in a config object would break just as quietly.
    const dead = [
      '/pro-management', '/dispatch-inspector', '/dept-attendance',
      '/referral-codes', '/live/wall',
    ];
    const offenders: string[] = [];
    for (const f of files) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      const rel = path.relative(SRC, f).replace(/\\/g, '/');
      for (const d of dead) {
        if (src.includes(`'${d}`) || src.includes(`"${d}`) || src.includes('`' + d)) {
          offenders.push(`${rel}: ${d}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
