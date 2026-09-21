/**
 * B-848 / A4 — the Workspaces hub is reachable from EVERY shell that hosts the
 * Departmental surface.
 *
 * R1 is literal: the hub is the ONLY surface that lists organisations. So the
 * Channels directory (and the workspace Home, and the Vault company shelf) now
 * refuse to render a cross-organisation list and send a multi-affiliation
 * person to the hub instead — which makes "can this shell reach the hub?" a
 * correctness question rather than a convenience one.
 *
 * It could not. `findNavigatorWithRoute` walks UP from the caller, and
 * `WorkspaceHub` was registered on MessengerNavigator and AgentNavigator only;
 * in the CPO guard shell the picker was a dead end (critic round 1a, P0). Same
 * class as N2: an unregistered declaration is a SILENT no-op.
 *
 * Source scans — these are navigators (they mount real screens). Line-based
 * and comment-skipping, because the prose here names the very tokens the
 * assertions look for, and a greedy `/*` stripper has eaten real code in this
 * repo before.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function code(...rel: string[]): string {
  return readFileSync(join(process.cwd(), ...rel), 'utf8')
    .split(/\r?\n/)
    .filter(l => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const SHELLS: Array<[string, string]> = [
  ['CpoNavigator.tsx', 'the managed-guard shell'],
  ['AgentNavigator.tsx', 'the agency shell'],
  ['MessengerNavigator.tsx', 'the client shell'],
];

describe('every shell that hosts the Departmental surface registers WorkspaceHub', () => {
  it.each(SHELLS)('%s (%s)', file => {
    const src = code('src', 'navigation', file);
    // BOTH halves: the declaration alone navigates nowhere.
    expect(src).toMatch(/name="WorkspaceHub"/);
    expect(src).toMatch(/component=\{WorkspaceHubScreen\}/);
  });

  it('the CPO shell registers it as a SIBLING of Departmental, not inside the tabs', () => {
    // Inside the 4-tab navigator it would add a footer tab (and break the §35A
    // capability scan); as a root-stack sibling the ancestor walk from any tab
    // — or from inside the pushed Departmental shell — finds it.
    const src = code('src', 'navigation', 'CpoNavigator.tsx');
    expect(src).toMatch(/<RootStack\.Screen name="WorkspaceHub"/);
    expect(src).not.toMatch(/<Tab\.Screen name="WorkspaceHub"/);
  });

  it('the CPO param list declares it too, or the navigate is a type error', () => {
    const types = code('src', 'navigation', 'types.ts');
    const start = types.indexOf('export type CpoRootStackParamList');
    expect(start).toBeGreaterThan(-1);
    const block = types.slice(start, types.indexOf('};', start));
    expect(block).toMatch(/WorkspaceHub: undefined;/);
  });
});

describe('ONE ladder to the hub, shared by every door', () => {
  const ENTRY = code('src', 'navigation', 'departmentalEntry.ts');

  it('openWorkspaceHub tries the mounted tree FIRST, then the client sibling', () => {
    const start = ENTRY.indexOf('export function openWorkspaceHub');
    expect(start).toBeGreaterThan(-1);
    const body = ENTRY.slice(start, ENTRY.indexOf('\n}', start));
    const direct = body.indexOf("findNavigatorWithRoute(nav, 'WorkspaceHub')");
    const sibling = body.indexOf("mountedTreeHasRoute('MessengerTab')");
    expect(direct).toBeGreaterThan(-1);
    expect(sibling).toBeGreaterThan(direct);
    // The sibling dispatch is GATED on MessengerTab actually being mounted, so
    // the CPO and agency shells (which have no MessengerTab) fall through
    // instead of dispatching into a tree that is not there.
    expect(body).toMatch(/mountedTreeHasRoute\('MessengerTab'\) && navigationRef\.isReady\(\)/);
    // …and a tree with neither says so, rather than reporting success.
    expect(body).toMatch(/return \{ok: false, via: 'none'\};/);
  });

  it('the hot press goes through navigateOnce (NAV-10)', () => {
    expect(ENTRY).toMatch(/navigateOnce\([^)]*'WorkspaceHub'\)/);
  });

  /**
   * F6 — ALL THREE DOORS, not just the one the first cut happened to touch.
   *
   * There were three hand-rolled copies of this ladder. Two of them ended with
   * a dispatch into the CLIENT shell's `MessengerTab` — a route the CPO and
   * agency trees simply do not have — and then fell through to the directory,
   * so a row labelled "Workspaces" opened something else. The third (the
   * messenger footer) only walked ANCESTORS, so it missed the client shell's
   * sibling branch entirely. None of them went through `navigateOnce`.
   *
   * Enumerated by file so a FOURTH copy has to be added here to pass, rather
   * than quietly drifting from the other three.
   */
  it.each([
    ['src/components/useWorkspaceSwitchRow.ts', 'the drawer + Profile row'],
    ['src/components/ProfileDrawerModal.tsx', 'the drawer itself'],
    ['src/screens/messenger/MessengerTabBar.tsx', 'the messenger footer Channels hop'],
  ])('%s (%s) routes through the shared resolver', rel => {
    const src = code(...rel.split('/'));
    expect(src).toMatch(/openWorkspaceHub\(navigation/);
    // …and holds no private copy of the ladder any more.
    expect(src).not.toMatch(/findNavigatorWithRoute\([^)]*'WorkspaceHub'\)/);
    expect(src).not.toMatch(/screen: 'WorkspaceHub'/);
  });
});
