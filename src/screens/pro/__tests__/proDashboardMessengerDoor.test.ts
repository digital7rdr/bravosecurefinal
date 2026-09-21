/**
 * B-858 (founder 2026-09-11) — _"messenger module click lets me go to Bravo news
 * feed; it should take me to Messenger"_.
 *
 * The Messenger tile carried NO params, so `openModule` took the
 * `m.target === 'MessengerTab'` branch and dispatched a bare
 * `navigate('MessengerTab')`, which only FOCUSES the tab. `MessengerHomeScreen`
 * keeps the News/Chats choice in local state, so after one tap on the Bravo Feed
 * tile the Messenger tile landed on News for the rest of that tab's life.
 *
 * The fix is the News tile's own shape with `tab: 'Chats'`, and it must be a
 * FACTORY: React Navigation applies a nested payload only when its identity
 * changes (`nestedNavigatePayloadIdentity.test.ts` pins the library half), so a
 * module-level constant is honoured exactly once per warm tab mount.
 *
 * Source scans — ProDashboardScreen mounts an RN screen the node project cannot
 * import. Comments are stripped first: this file's own subject matter is quoted
 * in the screen's prose, which is exactly how a scan passes vacuously.
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

const DASH = code('src/screens/pro/ProDashboardScreen.tsx');

function modulesBlock(): string {
  const start = DASH.indexOf('const MODULES: ModuleDef[] = [');
  expect(start).toBeGreaterThan(-1);
  const end = DASH.indexOf('\n];', start);
  expect(end).toBeGreaterThan(start);
  return DASH.slice(start, end);
}

const rows = modulesBlock().split('\n').filter(l => /^\s*\{key: '/.test(l));
const messengerRow = rows.find(l => l.includes("key: 'messenger'")) ?? '';

describe('B-858 — the Pro dashboard Messenger tile opens CHATS', () => {
  it('the tile exists and is live', () => {
    expect(messengerRow).not.toBe('');
    expect(messengerRow).toMatch(/title:\s*'Messenger'/);
    expect(messengerRow).not.toMatch(/comingSoon:\s*true/);
  });

  it("carries {screen: 'MessengerHome', params: {tab: 'Chats'}, initial: false}", () => {
    expect(messengerRow).toMatch(/target:\s*'MessengerTab'/);
    expect(messengerRow).toMatch(/screen:\s*'MessengerHome'/);
    expect(messengerRow).toMatch(/params:\s*\{tab:\s*'Chats'\}/);
    // Load-bearing on the COLD first mount: without it the nested screen is
    // honoured only while the tab is unmounted.
    expect(messengerRow).toMatch(/initial:\s*false/);
    // …and it must be News, not Chats, on the OTHER tile — a copy/paste that
    // swapped them would satisfy every assertion above.
    const newsRow = rows.find(l => l.includes("key: 'news'")) ?? '';
    expect(newsRow).toMatch(/params:\s*\{tab:\s*'News'\}/);
  });

  it('the payload is a FACTORY, not a module-level constant (B-726/B-801)', () => {
    expect(messengerRow).toMatch(/targetParams:\s*\(\)\s*=>\s*\(\{/);
    // The dispatcher CALLS it — passing the function itself would navigate with
    // a function-valued params object and silently do nothing useful.
    expect(DASH).toMatch(/\.navigate\(m\.target,\s*m\.targetParams\(\)\)/);
  });
});

describe('B-857 — a locked Pro tile explains itself instead of dying silently', () => {
  it('a locked press opens the handler-less alert, an unlocked one opens the module', () => {
    expect(DASH).toMatch(
      /onPress=\{\(\)\s*=>\s*\{\s*if\s*\(g\.locked\)\s*\{explainLocked\(m,\s*g\);\}\s*else\s*\{openModule\(m\);\}\s*\}\}/,
    );
  });

  it('the copy names the mission-day rule and carries no handlers (N10 dedupe)', () => {
    const start = DASH.indexOf('const explainLocked');
    expect(start).toBeGreaterThan(-1);
    const body = DASH.slice(start, DASH.indexOf('const openModule', start));
    expect(body).toContain('Available on a mission day.');
    // Handler-less: `@utils/alert` coalesces duplicates ONLY when the request
    // has no onPress/onDismiss, which is what makes a tap burst show one dialog.
    expect(body).not.toContain('onPress');
    expect(body).not.toContain('onDismiss');
    expect(DASH).toMatch(/import \{Alert\} from '@utils\/alert'/);
  });

  it('the locked tile has press feedback now that the press does something', () => {
    expect(DASH).toMatch(/activeOpacity=\{0\.82\}/);
    expect(DASH).not.toMatch(/activeOpacity=\{g\.locked \? 1 : 0\.82\}/);
  });
});
