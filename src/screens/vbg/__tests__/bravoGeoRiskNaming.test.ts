/**
 * B-802 (founder 2026-09-05) — "rename Virtual Bodyguard to Bravo GeoRisk,
 * wherever the Virtual Bodyguard text appears" … "the whole code base should
 * know, otherwise some api or other might not work".
 *
 * The product's CODE family stays `vbg` (routes, store keys, imagery keys, the
 * auth-service module, the DB) — only what a user READS changes. The name lived
 * as a literal in eight places (product-label map, two product pickers, the
 * onboarding carousel, the signup summary, both dashboards' module cards, the
 * tier matrix), so this pin is repo-wide over the shipped app AND the services
 * the founder worried about: no STRING LITERAL may spell the old name.
 *
 * The comment stripper is deliberately CONSERVATIVE for an absence scan: it
 * removes only whole-line `//` comments, docblocks/blocks that START a line, and
 * JSX `{/* … *\/}` comments. A greedy stripper (any `/*` anywhere, any `//`
 * mid-line) can swallow real code between a string's `/*` and the next `*\/`
 * (the 2026-08-05 "stripper eats real code" class), which makes an ABSENCE scan
 * silently weaker. A trailing `// …` after code on the same line is therefore
 * NOT stripped — keep old-name history in whole-line comments.
 *
 * Known residue (second critic pass): a line-start comment INSIDE a template
 * literal (the WebView HTML/JS templates) is still stripped, because a regex
 * cannot tell a string from code. One accepted site rides on that — a verbatim
 * client quote in a JS comment inside `vbgKeyPointsMapHtml.ts`'s WebView
 * script. It is listed EXPLICITLY below (and asserted to still exist, so the
 * entry cannot rot) instead of passing by accident.
 */
import {readdirSync, readFileSync, statSync} from 'fs';
import {join, relative} from 'path';

const ROOT = join(__dirname, '..', '..', '..', '..');
const SRC = join(ROOT, 'src');
/** The sweep the sqa entry claims: app source + every service that could emit copy. */
const TREES = [
  SRC,
  join(ROOT, 'apps', 'auth-service', 'src'),
  join(ROOT, 'apps', 'messenger-service', 'src'),
  join(ROOT, 'apps', 'ops-console', 'src'),
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules' || name === '.next') {continue;}
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {walk(p, out);}
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) {out.push(p);}
  }
  return out;
}

function stripComments(src: string): string {
  return src
    .replace(/\r\n/g, '\n')
    // JSX comments: `{/* … */}` (may span lines)
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    // block comments / docblocks that START a line
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
    // whole-line `//` comments
    .replace(/^\s*\/\/.*$/gm, '');
}

const OLD_NAME = /virtual[\s-]?body[\s-]?guard/i;
const NEW_NAME = 'Bravo GeoRisk';

/**
 * Old-name sites that are ACCEPTED inside a string literal, with the reason.
 * Each must still exist (else the entry is stale and must go). Nothing here is
 * user-visible copy: a JS comment inside a WebView `<script>` renders nothing.
 */
const ACCEPTED_IN_STRINGS: Array<{file: string; reason: string}> = [
  {
    file: 'src/screens/vbg/vbgKeyPointsMapHtml.ts',
    reason: 'verbatim client quote (2026-09-01) in a // comment inside the WebView script template',
  },
];

describe('B-802 — the product reads "Bravo GeoRisk" everywhere the user sees it', () => {
  it('the scan reads real code (guards a vacuous pass)', () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(300);
    // The stripper keeps code: a known literal survives it.
    const store = stripComments(readFileSync(join(SRC, 'store', 'productStore.ts'), 'utf8'));
    expect(store).toContain(NEW_NAME);
  });

  it('the product-label map (drives "Switch to …" and the switch confirm) carries the new name', () => {
    const store = stripComments(readFileSync(join(SRC, 'store', 'productStore.ts'), 'utf8'));
    expect(store).toMatch(/vbg:\s*'Bravo GeoRisk'/);
  });

  it.each([
    ['screens/auth/HomeSelectionScreen.tsx', /label:\s*'Bravo GeoRisk'/],
    ['screens/auth/HomeSelectionScreen.tsx', /ctaLabel:\s*'Open Bravo GeoRisk'/],
    ['screens/auth/OnboardingScreen.tsx', /title:\s*'Bravo GeoRisk'/],
    ['screens/auth/ProductGateScreen.tsx', /title:\s*'Bravo GeoRisk'/],
    ['screens/auth/SignupSuccessScreen.tsx', /'Bravo GeoRisk personal safety'/],
    ['screens/dashboard/DashboardScreen.tsx', /title="Bravo GeoRisk"/],
    ['screens/pro/ProDashboardScreen.tsx', /key:\s*'vbg',\s*title:\s*'Bravo GeoRisk'/],
    ['screens/pro/tierMatrix.ts', /title:\s*'Bravo GeoRisk',\s*eyebrow:\s*'Personal · Free'/],
  ])('%s renders the new name at its decision site', (rel, re) => {
    expect(stripComments(readFileSync(join(SRC, rel), 'utf8'))).toMatch(re);
  });

  it('no shipped source in the app OR the services spells the old name outside a comment', () => {
    const accepted = new Set(ACCEPTED_IN_STRINGS.map(a => a.file));
    const offenders = TREES
      .flatMap(t => walk(t))
      .filter(f => OLD_NAME.test(stripComments(readFileSync(f, 'utf8'))))
      .map(f => relative(ROOT, f).replace(/\\/g, '/'))
      .filter(f => !accepted.has(f));
    expect(offenders).toEqual([]);
  });

  it('every ACCEPTED in-string site still exists (an allow-list entry may not rot)', () => {
    for (const {file} of ACCEPTED_IN_STRINGS) {
      const raw = readFileSync(join(ROOT, file), 'utf8');
      // Raw, not stripped: the whole point is that this one lives inside a
      // template literal the stripper cannot see through.
      expect(OLD_NAME.test(raw)).toBe(true);
    }
  });

  it('the code family is untouched — routes and keys still say vbg', () => {
    // A rename that leaked into identifiers would be a silent no-op door
    // (B-257/B-258 class) or a broken API, so the pin also asserts the
    // identifiers did NOT move.
    const types = readFileSync(join(SRC, 'navigation', 'types.ts'), 'utf8');
    expect(types).toMatch(/\bVBGHome: undefined;/);
    const store = readFileSync(join(SRC, 'store', 'productStore.ts'), 'utf8');
    expect(store).toMatch(/export type BravoProduct = 'messenger' \| 'secure' \| 'vbg';/);
    const controller = readFileSync(join(ROOT, 'apps', 'auth-service', 'src', 'vbg', 'vbg.controller.ts'), 'utf8');
    expect(controller).toMatch(/@Controller\('vbg'\)/);
  });
});
