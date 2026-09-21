/**
 * B-799 (founder 2026-09-05) — "when click on Bravo feed it should redirect to
 * these page [the News hub]; the existing redirection is wrong."
 *
 * Both agent-dashboard Bravo Feed doors (the module row and the drawer item)
 * pushed `IntelFeed` — the LIVE "Bravo Feed · Global News" screen, one level
 * INSIDE the hub. The founder's target is the hub itself: News Filter + My Feed
 * + Bravo Feed, which on every shell is the messenger home's News tab. So the
 * door is `MessengerHome` with `{tab: 'News'}`, the same destination the
 * drawer's Messenger item reaches minus the tab.
 *
 * Source scans (the screen mounts RN). Comments stripped first; CRLF normalised.
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

const DASH = code('src/screens/agent/AgentDashboardScreen.tsx');
const AGENT_NAV = code('src/navigation/AgentNavigator.tsx');
const TYPES = code('src/navigation/types.ts');
const MSG_HOME = code('src/screens/messenger/MessengerHomeScreen.tsx');

const DOOR = /navigateOnce\(navigation, 'MessengerHome', \{tab: 'News'\}\)/;

describe('B-799 — the agent Bravo Feed doors land on the News HUB, not the live intel feed', () => {
  it('the module row navigates to the messenger News tab', () => {
    const row = DASH.split('\n').find(l => l.includes("key: 'intel'")) ?? '';
    expect(row).toMatch(/title:\s*'Bravo Feed'/);
    expect(row).toMatch(DOOR);
  });

  it('the drawer item navigates to the same place', () => {
    const line = DASH.split('\n').find(l => l.includes("case 'Bravo Feed':")) ?? '';
    expect(line).toMatch(DOOR);
  });

  it('no dashboard door pushes IntelFeed any more (the wrong redirect)', () => {
    // The hub's own "OPEN BRAVO FEED" button is the ONLY door to IntelFeed now,
    // so the dashboard must not name it as a destination at all.
    expect(DASH).not.toMatch(/navigateOnce\(navigation, 'IntelFeed'/);
    expect(DASH).not.toMatch(/navigate\('IntelFeed'/);
  });

  it('the destination exists in the agency shell and accepts the tab param', () => {
    // MessengerHome is a ROOT-stack route in AgentNavigator (the agency shell
    // does not nest MessengerNavigator — the B-257/B-258 silent-no-op class).
    expect(AGENT_NAV).toMatch(/name="MessengerHome"/);
    // Bounded to the agent list's OWN block — an unbounded slice runs to EOF and
    // a later list with the same line would satisfy it vacuously.
    const start = TYPES.indexOf('export type AgentStackParamList = {');
    expect(start).toBeGreaterThan(-1);
    const end = TYPES.indexOf('\n};', start);
    expect(end).toBeGreaterThan(start);
    const agentStack = TYPES.slice(start, end);
    expect(agentStack).toMatch(/^\s*MessengerHome: \{tab\?: MessengerHomeTab\} \| undefined;/m);
    expect(TYPES).toMatch(/export type MessengerHomeTab = 'Chats' \| 'Calls' \| 'News';/);
  });

  it('the News tab IS the hub body — filter + My Feed + Bravo Feed ("these page")', () => {
    expect(MSG_HOME).toMatch(/activeTab === 'News' && <NewsHubBody embedded/);
    // IntelFeed stays reachable one level in, from the hub's Bravo Feed card.
    expect(code('src/screens/news/NewsHubScreen.tsx')).toMatch(/navigation\.navigate\('IntelFeed'\)/);
    expect(AGENT_NAV).toMatch(/name="IntelFeed"/);
  });
});
