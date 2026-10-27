/**
 * 2026-10-25 — owner requests:
 *  1. web inactivity sign-out off (switchable back on by env)
 *  2. "Departments" → "Workspace" on the feature labels
 *  3. Workspace on the welcome page next to Messenger / Secure Services / GeoRisk
 *  4. "Provider" labels → "Service Provider"
 *  5. no mission code on the guard's mission screens
 *  6. guard bar: Mission · Messenger · Workspace · Bravo Feed
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const strip = (src: string): string => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

describe('1 — web inactivity sign-out is off by default', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {idleSignOutMs} = require('../../../apps/ops-console/src/lib/idleSignOut') as {idleSignOutMs: (raw?: string) => number};

  it('unset / invalid / zero = off; minutes switch it back on (capped at a day)', () => {
    expect(idleSignOutMs(undefined)).toBe(0);
    expect(idleSignOutMs('')).toBe(0);
    expect(idleSignOutMs('abc')).toBe(0);
    expect(idleSignOutMs('0')).toBe(0);
    expect(idleSignOutMs('15')).toBe(15 * 60_000);
    expect(idleSignOutMs('99999')).toBe(24 * 60 * 60_000);
  });

  it.each([
    'apps/ops-console/src/components/Shell.tsx',
    'apps/ops-console/src/components/web/WebShell.tsx',
    'apps/ops-console/src/components/provider/ProviderShell.tsx',
    'apps/ops-console/src/components/hub/HubShell.tsx',
  ])('%s uses the switch and skips the timer when it is off', f => {
    const src = strip(read(f));
    expect(src).toMatch(/const IDLE_TIMEOUT_MS = IDLE_SIGN_OUT_MS;/);
    expect(src).toMatch(/if \(!IDLE_TIMEOUT_MS\) return;/);
    expect(src).not.toMatch(/IDLE_TIMEOUT_MS = \d+ \* 60 \* 1000/);
  });
});

describe('2 — Workspace, not Departments, on the feature labels', () => {
  it('guard tab, home card and nav entries say Workspace', () => {
    expect(read('src/navigation/CpoNavigator.tsx')).toMatch(/label: 'Workspace'/);
    expect(read('src/screens/cpo/OnDutyHomeScreen.tsx')).toMatch(/<Text style=\{s\.deptTitle\}>Workspace<\/Text>/);
    expect(read('apps/ops-console/src/lib/provider/nav.ts')).toMatch(/label: 'Workspace', icon: 'tree'/);
    expect(read('apps/ops-console/src/lib/nav.tsx')).toMatch(/\{label: 'Workspaces', href: routes\.enterprise\.departments/);
    expect(strip(read('src/store/entitlements.ts'))).not.toMatch(/Department Channels/);
  });
});

describe('3 — Workspace on the welcome page', () => {
  it('a Workspace card that opens Messenger on the Workspace hub', () => {
    const gate = read('src/screens/auth/ProductGateScreen.tsx');
    expect(gate).toMatch(/key: 'workspace', icon: 'office-building-outline', title: 'Workspace'/);
    expect(gate).toMatch(/if \(card === 'workspace'\) \{useProductStore\.getState\(\)\.openWorkspaceFromGate\(\);\}/);
    const main = read('src/navigation/MainNavigator.tsx');
    expect(main).toMatch(/\.openWorkspaceHubFromRoot\(\)/);
    expect(main).toMatch(/mountedProduct !== activeProduct/);
    expect(main).toMatch(/if \(\(landing === 'workspace' \|\| landing === 'messenger'\) && activeProduct !== 'messenger'\) \{return;\}/);
    expect(read('src/navigation/departmentalEntry.ts')).toMatch(/params: \{screen: 'WorkspaceHub', initial: false\}/);
  });

  it('openWorkspaceFromGate mounts Messenger and records the landing', () => {
    jest.isolateModules(() => {
      jest.doMock('@react-native-async-storage/async-storage', () => ({
        __esModule: true, default: {getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined},
      }));
      const {useProductStore} = require('@store/productStore') as typeof import('@store/productStore');
      useProductStore.getState().requestGate();
      useProductStore.getState().openWorkspaceFromGate();
      const st = useProductStore.getState();
      expect(st.activeProduct).toBe('messenger');
      expect(st.gateVisible).toBe(false);
      expect(st.landing).toBe('workspace');
      st.clearLanding();
      expect(useProductStore.getState().landing).toBeNull();
    });
  });
});

describe('4 — Service Provider wording', () => {
  it('consoles and app say Service Provider(s)', () => {
    expect(read('apps/ops-console/src/lib/nav.tsx')).toMatch(/label: 'Service Providers'/);
    expect(read('apps/ops-console/src/app/provider/layout.tsx')).toMatch(/Bravo Service Provider Console/);
    expect(read('apps/ops-console/src/lib/status.ts')).toMatch(/'No Service Provider'/);
    expect(read('src/screens/booking/customerStage.ts')).toMatch(/'Service provider accepted your mission'/);
  });
});

describe('5 — no mission code on the guard mission screens', () => {
  it('home card and mission header do not render short_code; Pro code entry hidden', () => {
    const home = strip(read('src/screens/cpo/OnDutyHomeScreen.tsx'));
    expect(home).not.toMatch(/\{mission\.short_code\}/);
    const det = strip(read('src/screens/cpo/AssignedMissionDetailScreen.tsx'));
    expect(det).not.toMatch(/short_code/);
    expect(det).toMatch(/const SHOW_PRO_MISSION_CODE = false;/);
  });
});

describe('6 — guard bar: Mission · Messenger · Workspace · Bravo Feed', () => {
  const nav = read('src/navigation/CpoNavigator.tsx');
  it('detail and profile stay registered but hidden; Bravo Feed is a tab', () => {
    expect(nav).toMatch(/<Tab\.Screen name="CpoMission" component=\{AssignedMissionDetailScreen\} options=\{HIDDEN_TAB\} \/>/);
    expect(nav).toMatch(/<Tab\.Screen name="CpoMe" component=\{AgentProfileScreen\} options=\{HIDDEN_TAB\} \/>/);
    expect(nav).toMatch(/<Tab\.Screen name="CpoFeed" component=\{NewsNavigator\} \/>/);
    expect(nav).toMatch(/CpoDuty: +\{[^}]*label: 'Mission'\}/);
    expect(nav).toMatch(/CpoComms: +\{[^}]*label: 'Messenger'\}/);
    expect(nav).toMatch(/standInTab="CpoDuty"/);
  });
  it('the profile opens from the Mission home header', () => {
    expect(read('src/screens/cpo/OnDutyHomeScreen.tsx')).toMatch(/navigation\.navigate\('CpoMe'\)/);
  });
});
