/**
 * B-848 / A5 + F7 — WHERE the picker card is mounted, and what it suppresses.
 *
 * The render behaviour of two of the three surfaces is pinned by mounting them
 * (`departmentDirectoryRender`, `vaultShelfSeparation`). `DepartmentalHomeScreen`
 * has no render suite in this project — every existing pin on it is a source
 * scan — so this file is the third, plus the cross-surface statement that all
 * three ask the SAME predicate rather than three drifting copies of it.
 *
 * F7 is the part a "does the card appear?" test would miss: the dashboard's
 * counters are read with NO `X-Org-Context` at all, so leaving them rendering
 * under a card that says "choose a workspace" puts the primary org's numbers
 * one row below the sentence admitting no organisation has been chosen.
 *
 * Line-based and comment-skipping: the prose here names the very tokens the
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

const HOME = code('src', 'screens', 'deptchat', 'DepartmentalHomeScreen.tsx');
const DIRECTORY = code('src', 'screens', 'messenger', 'DepartmentChannelsScreen.tsx');
const VAULT = code('src', 'screens', 'messenger', 'VaultScreen.tsx');

describe('all three gated surfaces ask the ONE shared predicate', () => {
  it.each([
    ['DepartmentalHomeScreen', HOME],
    ['DepartmentChannelsScreen', DIRECTORY],
    ['VaultScreen', VAULT],
  ])('%s mounts the card and reads useNeedsWorkspaceChoice', (_name, src) => {
    expect(src).toMatch(/<WorkspaceChoiceGate \/>/);
    expect(src).toMatch(/useNeedsWorkspaceChoice\(\)/);
    // Never a hand-rolled re-derivation beside it — that is the duplicate-copy
    // class, and this condition decides which company's data a screen shows.
    expect(src).not.toMatch(/workspaces\?\.length >= 2/);
  });
});

describe('F7 — the workspace Home neither RENDERS nor FETCHES its counters under the card', () => {
  it('load() returns before its first request', () => {
    const start = HOME.indexOf('const load = useCallback');
    expect(start).toBeGreaterThan(-1);
    const body = HOME.slice(start, HOME.indexOf('}, [isManager', start));
    // Non-vacuous: the slice must hold the requests it is being asked about.
    expect(body).toMatch(/attendanceApi\.myShifts\(\)/);
    expect(body).toMatch(/orgApi\.workspaceSettings\(\)/);
    // …and the guard comes BEFORE all of them.
    const guard = body.indexOf('if (needsChoice) {setRefreshing(false); return;}');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf('orgApi.workspaceSettings()'));
    expect(guard).toBeLessThan(body.indexOf('attendanceApi.myShifts()'));
  });

  it('…and re-arms when the user leaves the picker state', () => {
    // Without the dep the dashboard stays empty after they choose, until the
    // next focus — which on a tab root can be a long time.
    expect(HOME).toMatch(/\}, \[isManager, needsChoice\]\);/);
  });

  it('BOTH counter blocks are hidden, the member one and the manager one', () => {
    // Hiding only one leaves exactly the confusion the card exists to end, for
    // exactly one of the two roles.
    expect(HOME).toMatch(/\{!needsChoice && !isManager && showAttendance && \(/);
    expect(HOME).toMatch(/\{!needsChoice && isManager && \(showAttendance \|\| showIncidents\) && \(/);
  });
});

describe('A5 — the directory card sits ABOVE the search row and replaces the list', () => {
  it('is mounted before the stat/search block', () => {
    const gate = DIRECTORY.indexOf('<WorkspaceChoiceGate />');
    const search = DIRECTORY.indexOf('accessibilityLabel="Search channels"');
    expect(gate).toBeGreaterThan(-1);
    expect(search).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(search);
  });

  it('replaces the whole loading/empty/list fork rather than stacking on it', () => {
    // Rendered alongside, the empty branch says "No channels yet" underneath —
    // a lie: the channels exist, we are refusing to mix them.
    expect(DIRECTORY).toMatch(/\{needsChoice \? null : loading \? \(/);
  });
});
