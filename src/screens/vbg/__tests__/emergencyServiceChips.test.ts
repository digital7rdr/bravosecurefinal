/**
 * B-822 — the emergency card showed one strong "All 112" chip for every country
 * whose directory entry carries only a universal line (founder, 2026-09-07, on a
 * screenshot with Andorra's "All 112" and Antigua and Barbuda's "All 911"
 * circled: "Is it possible to write out Police, Ambulance, Fire for the
 * emergency numbers, even if it is the same number instead of saying 'All'?").
 *
 * RED BEFORE THE FIX: the "All-only" cases below (Andorra, Antigua and Barbuda,
 * and every entry in sweep (a)) expect THREE chips — Police/Ambulance/Fire, all
 * on the universal number — and the shipped shape rendered exactly ONE, labelled
 * "All". Mutation-proved by restoring that old shape inside `serviceChipsFor`.
 *
 * The All chip is not deleted, it is demoted to what it actually is: a chip that
 * only earns its place when it is a DISTINCT number (Albania's 112 next to
 * police 129 / ambulance 127 / fire 128). And a number is never invented — a
 * service the directory does not know, on an entry with no universal line to
 * fall back to, gets no chip at all.
 *
 * The source scan is line-based and strips comments first: `VBGEmergencyScreen`
 * is CRLF (a `\n`-anchored regex matches nothing and passes vacuously) and its
 * own prose mentions the banned literals.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  EMERGENCY_NUMBERS,
  UNIVERSAL_EMERGENCY,
  serviceChipsFor,
  type EmergencyEntry,
} from '../emergencyNumbers';

const byIso = (iso: string): EmergencyEntry => {
  const e = EMERGENCY_NUMBERS.find(x => x.iso === iso);
  if (!e) {throw new Error(`directory has no ${iso}`);}
  return e;
};

const chip = (label: string, number: string) => ({label, number});
const strong = (label: string, number: string) => ({label, number, strong: true});
const NOWHERE: EmergencyEntry = {iso: 'ZZ', name: 'Nowhere'};

describe('serviceChipsFor — the worked examples', () => {
  it.each([
    [
      'Andorra — the universal line, written out',
      byIso('AD'),
      [chip('Police', '112'), chip('Ambulance', '112'), chip('Fire', '112')],
    ],
    [
      'Antigua and Barbuda — universal 911, written out',
      byIso('AG'),
      [chip('Police', '911'), chip('Ambulance', '911'), chip('Fire', '911')],
    ],
    [
      'Bahamas — a real police line, the rest fall back to 911',
      byIso('BS'),
      [chip('Police', '919'), chip('Ambulance', '911'), chip('Fire', '911')],
    ],
    [
      'Albania — All 112 is a distinct number, so it survives, first',
      byIso('AL'),
      [strong('All', '112'), chip('Police', '129'), chip('Ambulance', '127'), chip('Fire', '128')],
    ],
    [
      'Argentina — All 911 is distinct from 101/107/100',
      byIso('AR'),
      [strong('All', '911'), chip('Police', '101'), chip('Ambulance', '107'), chip('Fire', '100')],
    ],
    [
      'Australia — every service is 000, so All adds nothing',
      byIso('AU'),
      [chip('Police', '000'), chip('Ambulance', '000'), chip('Fire', '000')],
    ],
    [
      'Cyprus — police 199, ambulance and fire fall back to 112',
      byIso('CY'),
      [chip('Police', '199'), chip('Ambulance', '112'), chip('Fire', '112')],
    ],
    [
      'Benin — no universal line, so the unknown service gets NO chip',
      byIso('BJ'),
      [chip('Police', '117'), chip('Fire', '118')],
    ],
    [
      // DATA FIX: `police: '114'` was dropped — 114 is Politiets servicenummer,
      // the Danish NON-emergency line, and writing the services out promoted it
      // to the FRONT of the row. Do not re-add it from a stale source.
      'Denmark — the non-emergency 114 must not lead an emergency row',
      byIso('DK'),
      [chip('Police', '112'), chip('Ambulance', '112'), chip('Fire', '112')],
    ],
    [
      // DATA FIX: `police: '110'` was dropped — Estonia merged 110 into 112 in
      // 2015, so it is retired. Latvia's 110 is still live and stays.
      'Estonia — the retired 110 must not lead an emergency row',
      byIso('EE'),
      [chip('Police', '112'), chip('Ambulance', '112'), chip('Fire', '112')],
    ],
    [
      // The other half of that data fix: Latvia's State Police 110 IS live, so
      // it stays. Deleting it "for consistency" with Estonia is the regression.
      'Latvia — the live 110 stays, and fire falls back to 112',
      byIso('LV'),
      [chip('Police', '110'), chip('Ambulance', '113'), chip('Fire', '112')],
    ],
    [
      'an entry with no numbers at all — the universal fallback, unchanged',
      NOWHERE,
      [strong('Emergency', UNIVERSAL_EMERGENCY)],
    ],
  ])('%s', (_name, entry, expected) => {
    expect(serviceChipsFor(entry)).toEqual(expected);
  });
});

describe('serviceChipsFor — directory sweep', () => {
  it('(a) every universal-line-only entry yields Police/Ambulance/Fire on that line', () => {
    const only = EMERGENCY_NUMBERS.filter(e => e.all && !e.police && !e.ambulance && !e.fire);
    expect(only.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const e of only) {
      const chips = serviceChipsFor(e);
      const ok = chips.length === 3
        && chips.map(c => c.label).join(',') === 'Police,Ambulance,Fire'
        && chips.every(c => c.number === e.all && !c.strong);
      if (!ok) {
        bad.push(`${e.name}: ${chips.map(c => `${c.label} ${c.number}${c.strong ? '*' : ''}`).join(' | ')}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('(b) an All chip appears iff the universal line differs from every other chip', () => {
    const bad: string[] = [];
    for (const e of EMERGENCY_NUMBERS) {
      const chips = serviceChipsFor(e);
      const alls = chips.filter(c => c.label === 'All');
      const others = chips.filter(c => c.label !== 'All');
      const want = e.all !== undefined && others.every(c => c.number !== e.all);
      if (alls.length !== (want ? 1 : 0)) {
        bad.push(`${e.name}: ${alls.length} All chip(s), expected ${want ? 1 : 0}`);
        continue;
      }
      if (want && (chips[0].label !== 'All' || chips[0].number !== e.all || chips[0].strong !== true)) {
        bad.push(`${e.name}: the All chip is not the leading emphasised ${e.all}`);
      }
      for (const c of others) {
        if (c.strong) {bad.push(`${e.name}: ${c.label} is emphasised`);}
      }
    }
    expect(bad).toEqual([]);
  });

  it('(c) every emitted number is one the entry itself carries', () => {
    const bad: string[] = [];
    for (const e of EMERGENCY_NUMBERS) {
      const own = [e.all, e.police, e.ambulance, e.fire].filter(Boolean);
      for (const c of serviceChipsFor(e)) {
        if (!own.includes(c.number)) {bad.push(`${e.name}: ${c.label} ${c.number}`);}
      }
    }
    expect(bad).toEqual([]);
    expect(serviceChipsFor(NOWHERE)).toEqual([strong('Emergency', UNIVERSAL_EMERGENCY)]);
  });

  it('(d) no entry yields an empty chip list', () => {
    const empty = EMERGENCY_NUMBERS.filter(e => serviceChipsFor(e).length === 0);
    expect(empty.map(e => e.name)).toEqual([]);
  });

  it('only All and the Emergency fallback are ever emphasised', () => {
    const bad = new Set<string>();
    for (const e of [...EMERGENCY_NUMBERS, NOWHERE]) {
      for (const c of serviceChipsFor(e)) {
        if (c.strong && c.label !== 'All' && c.label !== 'Emergency') {bad.add(c.label);}
      }
    }
    expect([...bad]).toEqual([]);
  });
});

describe('VBGEmergencyScreen renders the helper, not its own chip ladder', () => {
  const code = readFileSync(join(__dirname, '..', 'VBGEmergencyScreen.tsx'), 'utf8')
    .split(/\r?\n/)
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('ServiceChips builds its chips with serviceChipsFor', () => {
    const start = code.indexOf('function ServiceChips');
    expect(start).toBeGreaterThan(-1);
    const end = code.indexOf('\n}', start);
    expect(end).toBeGreaterThan(start);
    expect(code.slice(start, end)).toContain('serviceChipsFor(');
  });

  it('no hand-rolled All or Emergency chip literal survives', () => {
    expect(code).not.toMatch(/label="All"/);
    expect(code).not.toMatch(/label="Emergency"/);
  });
});
