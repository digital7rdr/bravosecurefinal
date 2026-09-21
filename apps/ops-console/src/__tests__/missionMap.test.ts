/**
 * B-811 — the mission map's bottom dock + full-screen toggle.
 *
 * The status pill is a pure rule (`lib/missionMap.ts`) so its branch table is
 * pinned here; the layout facts that caused the overlap are pinned by a
 * comment-stripped source scan (the `mainAreaScroll.test.ts` pattern), because
 * the screen itself cannot be mounted in the node project.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {telemetryStatus, telemetryStatusLabel} from '../lib/missionMap';

const FILE = join('apps', 'ops-console', 'src', 'features', 'missions', 'MissionDetail.tsx');

function codeOnly(): string {
  const lines = readFileSync(join(process.cwd(), FILE), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('//') || t.startsWith('*')) {continue;}
    out.push(raw);
  }
  return out.join('\n');
}

describe('telemetry status pill — the three former pills, one rule', () => {
  it('reproduces the branch table exactly', () => {
    expect(telemetryStatus(false, false)).toBe('cpo+principal');
    expect(telemetryStatus(false, true)).toBe('cpo');
    expect(telemetryStatus(true, false)).toBe('principal');
    expect(telemetryStatus(true, true)).toBeNull();
    expect(telemetryStatusLabel(false, false)).toBe('⏳ AWAITING TELEMETRY · CPO + PRINCIPAL');
    expect(telemetryStatusLabel(false, true)).toBe('⏳ AWAITING CPO TELEMETRY');
    expect(telemetryStatusLabel(true, false)).toBe('⏳ AWAITING PRINCIPAL TELEMETRY');
    expect(telemetryStatusLabel(true, true)).toBeNull();
  });
});

describe('mission map layout (static scan)', () => {
  const src = codeOnly();

  it('the scan reads real code', () => {
    expect(src.length).toBeGreaterThan(10_000);
    expect(src).not.toContain('\r');
    expect(src).not.toMatch(/painted over since OC-11/); // prose stripped
  });

  it('no per-button right offsets remain; the controls are one non-wrapping row', () => {
    expect(src).not.toMatch(/right:118/);
    const row = src.slice(src.indexOf("flexWrap:'nowrap'") - 200, src.indexOf("flexWrap:'nowrap'") + 40);
    expect(row).toMatch(/position:'absolute', top:14, right:14, zIndex:5/);
  });

  it('the legend and the status pill share ONE bottom dock that reserves the Mapbox logo corner', () => {
    const dock = src.indexOf("left:104, right:12, bottom:12");
    expect(dock).toBeGreaterThan(-1);
    const block = src.slice(dock, dock + 2_500);
    expect(block).toMatch(/flexWrap:'wrap'/);
    expect(block).toMatch(/LegendDot color="#00C853" label="PICKUP"/);
    expect(block).toMatch(/telemetryStatusLabel\(hasCpoFix, hasPrincipalFix\)/);
    // No stray absolutely-positioned status pill outside the dock.
    expect((src.match(/AWAITING CPO TELEMETRY/g) ?? []).length).toBe(0); // text lives in lib/missionMap.ts now
  });

  it('full screen lifts the SAME card, re-measures Mapbox, leaves on Esc, and auto-exits on SOS', () => {
    expect(src).toMatch(/position:'fixed', inset:0, zIndex:1000/);
    expect(src).toMatch(/window\.dispatchEvent\(new Event\('resize'\)\)/);
    expect(src).toMatch(/e\.key === 'Escape'\) \{setMapFull\(false\);\}/);
    expect(src).toMatch(/if \(isSos\) \{setMapFull\(false\);\}/);
  });
});
