/**
 * One font stack, declared once.
 *
 * Every family reference in the console must resolve through
 * --font-sans / --font-mono in globals.css. A bare `font-family: 'Manrope'`
 * has NO fallback at all, and `'Manrope', sans-serif` only names a generic —
 * so on a machine where the Google Fonts fetch is slow, proxy-blocked, or
 * offline, the engine picks its own default, which can be a SERIF face. That
 * failure never shows on a dev machine with Manrope cached, which is exactly
 * why it needs a pin rather than a code review.
 *
 * Two deliberate exceptions, both asserted below:
 *   - SVG presentation attributes carry the literal stack (var() in a
 *     presentation attribute is not reliable across engines).
 *   - The attendance PDF report opens its own window, so no :root var
 *     reaches it; it carries the literal stack too.
 *
 * Scanner discipline per CLAUDE.md: strip comments before any absence
 * assertion (this repo's comments discuss font names), anchor on \r?\n.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..');
const GLOBALS = path.join(SRC, 'app', 'globals.css');
const TAILWIND = path.join(SRC, '..', 'tailwind.config.ts');
const REPORT_PAGE = path.join(SRC, 'app', '(console)', 'enterprise', 'attendance', 'page.tsx');

const EXPECTED_SANS = '"Manrope", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { out.push(...walk(p)); continue; }
    if (/\.(ts|tsx|css)$/.test(e.name) && !p.includes('__tests__')) out.push(p);
  }
  return out;
}

describe('console font stack', () => {
  const globals = fs.readFileSync(GLOBALS, 'utf8');

  it('declares --font-sans exactly as specified', () => {
    expect(globals).toContain(`--font-sans:   ${EXPECTED_SANS};`);
  });

  it('declares --font-mono with real fallbacks, not a bare generic', () => {
    const m = globals.match(/--font-mono:\s*([^;]+);/);
    expect(m).not.toBeNull();
    const stack = m![1].split(',').map(s => s.trim());
    expect(stack[0]).toBe('"JetBrains Mono"');
    expect(stack.length).toBeGreaterThan(2);
    expect(stack[stack.length - 1]).toBe('monospace');
  });

  it('tailwind mirrors globals.css (the two must stay in sync)', () => {
    const tw = stripComments(fs.readFileSync(TAILWIND, 'utf8'));
    for (const token of ['-apple-system', 'BlinkMacSystemFont', 'Roboto', 'Segoe UI']) {
      expect(tw).toContain(token);
    }
  });

  it('no source declares a bare or fallback-less family', () => {
    const offenders: string[] = [];

    // A stack is acceptable if it resolves through the shared vars, or names
    // at least one fallback after the first family (a comma inside the value).
    const ok = (value: string) =>
      value.includes('var(--font-') || value.includes(',') || value.trim() === 'inherit';

    for (const f of walk(SRC)) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      const rel = path.relative(SRC, f).replace(/\\/g, '/');

      // JS/JSX object literals: the WHOLE stack lives inside the quotes, so
      // "fallback-less" means the quoted value itself carries no comma.
      // Do NOT test what follows the closing quote — in an object literal a
      // comma always follows, which silently neutered an earlier version of
      // this pin and let a real regression through a green run.
      const js = /fontFamily:\s*(['"`])([^'"`]*)\1/g;
      let m: RegExpExecArray | null;
      while ((m = js.exec(src)) !== null) {
        if (!ok(m[2])) offenders.push(`${rel}: fontFamily:'${m[2]}'`);
      }

      // CSS declarations: the stack runs to the semicolon, outside any quotes.
      const css = /font-family:\s*([^;}]+)[;}]/g;
      while ((m = css.exec(src)) !== null) {
        if (!ok(m[1])) offenders.push(`${rel}: font-family: ${m[1].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the scan is not vacuous — it walks real files', () => {
    expect(walk(SRC).length).toBeGreaterThan(30);
  });

  it('the printed report carries the LITERAL stack (own window, no :root)', () => {
    const rep = fs.readFileSync(REPORT_PAGE, 'utf8');
    expect(rep).toContain(`font-family: ${EXPECTED_SANS};`);
    // A var() here would silently fall back to the browser default.
    expect(rep).not.toMatch(/win\.document[\s\S]{0,4000}font-family:\s*var\(/);
  });
});
