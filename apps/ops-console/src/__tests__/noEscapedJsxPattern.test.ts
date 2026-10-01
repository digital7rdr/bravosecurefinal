/**
 * 2026-10-01 — Internal → Admins "Create account" refused every phone number:
 * the input carried pattern="\\+[0-9]{7,15}". JSX attribute strings do not
 * process escapes, so the browser received a pattern requiring a literal
 * backslash and blocked the form before any request was sent. No account of
 * any level (Super Admin included) could be created there.
 * Pin: no JSX `pattern="…"` attribute may contain a backslash.
 */
import fs from 'fs';
import path from 'path';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__') out.push(...walk(p)); continue; }
    if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

describe('JSX pattern attributes', () => {
  it('never contain a backslash (escapes are literal in JSX strings)', () => {
    const offenders: string[] = [];
    for (const f of walk(path.join(__dirname, '..'))) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\spattern="([^"]*)"/g)) {
        if (m[1].includes('\\')) offenders.push(`${path.relative(path.join(__dirname, '..'), f)}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
  it('the admin account form validates the phone in code', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app', '(console)', 'internal', 'admins', 'page.tsx'), 'utf8');
    expect(src).toMatch(/if \(!\/\^\\\+\[0-9\]\{7,15\}\$\/\.test\(phone\)\)/);
  });
});
