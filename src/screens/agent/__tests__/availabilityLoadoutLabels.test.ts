/**
 * B-824 (founder, 2026-09-08) — "change the SIA to Security License, since SIA
 * is only UK." The Availability loadout toggle was labelled 'SIA UK / Front
 * line licence'; Bravo operates outside the UK, so the label has to be regional.
 *
 * The wire value (`key: 'sia'`) is UNTOUCHED — it is what
 * `UpdateAvailabilityDto.loadout` carries and what the server has stored for
 * every existing agent. Only the human label moves.
 *
 * A source scan, not an import: `src/screens/agent/__tests__/**` runs in the
 * node-environment `booking` Jest project, which has no JSX transform and no
 * React Native preset, so the screen module cannot be loaded here.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const SCREEN = 'src/screens/agent/AgentAvailabilityScreen.tsx';

const raw = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r?\n/g, '\n');

/** Comment-stripped, line-based, CRLF-safe — prose must never satisfy a code pin. */
function code(rel: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of raw(rel).split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

const loadoutBlock = (src: string) => {
  const start = src.indexOf('INITIAL_LOADOUT');
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf('];', start));
};

describe('B-824 — the licence toggle is regional, not UK-only', () => {
  it('the sia row reads Security License / Regional front line licence', () => {
    expect(loadoutBlock(code(SCREEN))).toMatch(
      /\{\s*key:\s*'sia',\s*name:\s*'Security License',\s*sub:\s*'Regional front line licence'/,
    );
  });

  it('the wire value is untouched — the server still receives `sia`', () => {
    const src = code(SCREEN);
    expect(loadoutBlock(src)).toMatch(/key:\s*'sia'/);
    expect(src).toMatch(/loadout\.filter\(l => l\.on\)\.map\(l => l\.key\)/);
  });

  it('no loadout label mentions SIA at all', () => {
    const names = [...loadoutBlock(code(SCREEN)).matchAll(/name:\s*'([^']*)'/g)].map(m => m[1]);
    expect(names.length).toBe(3);
    for (const n of names) {expect(n).not.toMatch(/SIA/i);}
  });

  it('the screen source carries no `SIA UK` literal — header comment included', () => {
    expect(code(SCREEN)).not.toMatch(/SIA UK/);
    expect(raw(SCREEN)).not.toMatch(/SIA UK/);
  });

  it('the constant is exported so a render test can assert the values directly', () => {
    expect(code(SCREEN)).toMatch(/export const INITIAL_LOADOUT/);
  });
});
