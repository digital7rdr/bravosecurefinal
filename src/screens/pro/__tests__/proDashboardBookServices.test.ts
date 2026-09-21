/**
 * B-828 — founder screenshot 2026-09-08: the Pro dashboard banner that opens
 * ServiceType is a booking door, so it reads "Book Services", not "Additional
 * Services". The subtitle ("Request extra support or add-ons") is unchanged.
 *
 * Source scan — the screen mounts an RN tree. Comments are stripped first: the
 * 2026-08-26 note above the banner still uses the old name, so an unstripped
 * absence assertion would fail for the wrong reason.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const SCREEN = join(ROOT, 'src', 'screens', 'pro', 'ProDashboardScreen.tsx');

/** Code only — comments stripped line-wise, CRLF-normalised. */
function code(): string {
  const src = readFileSync(SCREEN, 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) {inBlock = false;}
      continue;
    }
    if (t.startsWith('/*') || t.startsWith('{/*')) {
      if (!t.includes('*/')) {inBlock = true;}
      continue;
    }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

describe('B-828 — the dashboard banner reads "Book Services"', () => {
  it('the scan reads real code', () => {
    const src = code();
    expect(src.length).toBeGreaterThan(5_000);
    expect(src).not.toContain('\r');
    expect(src).toContain('s.addonsBanner');
  });

  it('the title and the accessibility label carry the new name', () => {
    const src = code();
    expect(src).toContain('text="Book Services"');
    expect(src).toContain('accessibilityLabel="Book Services — request extra support or add-ons"');
  });

  it('the old name is gone from the shipped copy, and the subtitle is untouched', () => {
    const src = code();
    expect(src).not.toContain('Additional Services');
    expect(src).toContain('Request extra support or add-ons');
  });

  it('the banner still opens the service picker', () => {
    expect(code()).toMatch(/navigation\.navigate\('ServiceType'\)/);
  });
});
