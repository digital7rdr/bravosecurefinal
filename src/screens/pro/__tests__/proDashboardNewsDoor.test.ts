/**
 * B-801 (founder 2026-09-05) — "can we add a button here in bravo secure pro
 * that goes straight to news".
 *
 * The news HUB (News Filter + My Feed + Bravo Feed) is not a screen of its own
 * on the client shell: it is the messenger home's News TAB (`NewsHubBody
 * embedded`), and `MessengerHome` is registered on MessengerNavigator, not on
 * this shell's stack. So the tile takes the Documents shape (B-726): nested
 * through `MessengerTab` with `initial: false`, carrying the tab as
 * MessengerHome's route param — and, per the critic on this very change, the
 * payload is a FACTORY: React Navigation applies a nested payload only when its
 * identity changes (`useNavigationBuilder`: `route.params !== previousParams`;
 * TabRouter returns the route unchanged for identity-equal params), so a
 * module-level constant is honoured exactly once per warm tab mount.
 *
 * Source scans — ProDashboardScreen mounts an RN screen the node project cannot
 * import. Comments are stripped first (a scan matching its own prose is this
 * repo's most common false pass); files are CRLF, so nothing is `\n`-anchored.
 */
import {readFileSync} from 'fs';
import {join} from 'path';

const ROOT = join(__dirname, '..', '..', '..', '..');

function code(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** One `export type X = {…};` block — bounded, so a sibling list cannot satisfy it. */
function typeBlock(src: string, name: string): string {
  const start = src.indexOf(`export type ${name} = {`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\n};', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

const DASH = code('src/screens/pro/ProDashboardScreen.tsx');
const TYPES = code('src/navigation/types.ts');
const MSG_NAV = code('src/navigation/MessengerNavigator.tsx');
const MSG_HOME = code('src/screens/messenger/MessengerHomeScreen.tsx');
const REGISTRY = code('src/theme/imagery.ts');

/** The MODULES array body, comment-stripped. */
function modulesBlock(): string {
  const start = DASH.indexOf('const MODULES: ModuleDef[] = [');
  expect(start).toBeGreaterThan(-1);
  const end = DASH.indexOf('\n];', start);
  expect(end).toBeGreaterThan(start);
  return DASH.slice(start, end);
}

describe('B-801 — the Pro dashboard has a Bravo Feed tile that goes straight to news', () => {
  const rows = modulesBlock().split('\n').filter(l => /^\s*\{key: '/.test(l));
  const row = rows.find(l => l.includes("key: 'news'")) ?? '';

  it('the tile exists, is live, and is titled like the agent door', () => {
    expect(row).not.toBe('');
    expect(row).toMatch(/title:\s*'Bravo Feed'/);
    expect(row).toMatch(/icon:\s*'newspaper-variant-outline'/);
    expect(row).not.toMatch(/comingSoon:\s*true/);
  });

  it('targets the messenger News TAB through MessengerTab, cold-mount safe (initial: false)', () => {
    // `navigate('MessengerHome')` from this shell resolves to nothing — the
    // route lives on MessengerNavigator. `initial: false` is load-bearing on the
    // FIRST mount: without it the nested screen is honoured only while the tab
    // is UNMOUNTED.
    expect(row).toMatch(/target:\s*'MessengerTab'/);
    expect(row).toMatch(
      /targetParams:\s*\(\)\s*=>\s*\(\{screen:\s*'MessengerHome',\s*params:\s*\{tab:\s*'News'\},\s*initial:\s*false\}\)/,
    );
  });

  it('warm-tab safe: the payload is a FACTORY and openModule CALLS it (a fresh object per tap)', () => {
    // A constant object here is a one-shot: TabRouter keeps the MessengerTab
    // route object when `params` is identity-equal, so the nested stack never
    // sees a change and the tap just focuses the tab where it was. Pinned for
    // EVERY nested row, not just this one — the Documents tile had the same
    // latent defect.
    const nested = rows.filter(l => l.includes('targetParams:'));
    expect(nested.length).toBeGreaterThanOrEqual(2);
    for (const l of nested) {
      expect(l).toMatch(/targetParams:\s*\(\)\s*=>\s*\(\{/);
    }
    expect(DASH).toMatch(/\.navigate\(m\.target,\s*m\.targetParams\(\)\)/);
    expect(DASH).not.toMatch(/\.navigate\(m\.target,\s*m\.targetParams\)/);
    // And the type says so, or a future row can quietly hand a constant back in.
    expect(DASH).toMatch(/targetParams\?:\s*\(\)\s*=>\s*Record<string, unknown>;/);
  });

  it('sits directly beside Messenger — the comms pair, in the agent dashboard\'s order', () => {
    const i = rows.findIndex(l => l.includes("key: 'messenger'"));
    expect(i).toBeGreaterThan(-1);
    expect(rows[i + 1]).toContain("key: 'news'");
  });

  it('carries the founder\'s newsroom art, resolved through the registry', () => {
    expect(row).toMatch(/img:\s*Imagery\.proNewsFeed\b/);
    expect(REGISTRY).toMatch(/get proNewsFeed\(\)[^{]*\{\s*return require\('\.\.\/assets\/imagery\/proNewsFeed\.jpg'\)/);
    // A full-bleed photo takes the default `card` scrim — the `art` variant is
    // for purpose-made black-field art and would strip the copy floor here.
    expect(row).not.toMatch(/imgVariant/);
  });

  it('the nested payload is one the destination actually understands', () => {
    // MessengerHome accepts {tab?: MessengerHomeTab} and 'News' is a member —
    // asserted INSIDE the messenger list's block, not anywhere after it.
    expect(TYPES).toMatch(/export type MessengerHomeTab = 'Chats' \| 'Calls' \| 'News';/);
    expect(typeBlock(TYPES, 'MessengerStackParamList')).toMatch(/^\s*MessengerHome: \{tab\?: MessengerHomeTab\} \| undefined;/m);
    // ...and the route is registered where the payload will be resolved.
    expect(MSG_NAV).toMatch(/name="MessengerHome"/);
    // ...and that tab renders the hub body (this is the "these page" of the ask).
    expect(MSG_HOME).toMatch(/activeTab === 'News' && <NewsHubBody embedded/);
  });
});
