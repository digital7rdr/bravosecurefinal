/**
 * Owner 2026-10-31 — "In the agent app these two buttons for privacy and help
 * are not working": the agent drawer's Sign-in & Privacy and Help & Support
 * had no case in handleMenuPress and fell through to `default: break`.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const strip = (src: string): string => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

describe('agent drawer — every item does something', () => {
  const dash = strip(read('src/screens/agent/AgentDashboardScreen.tsx'));
  const handler = dash.slice(dash.indexOf('const handleMenuPress'), dash.indexOf('const load = useCallback'));

  it('each AGENT_MENU label has a case', () => {
    const menu = dash.slice(dash.indexOf('const AGENT_MENU'), dash.indexOf('];', dash.indexOf('const AGENT_MENU')));
    const labels = [...menu.matchAll(/label: '([^']+)'/g)].map(m => m[1]);
    expect(labels).toEqual(expect.arrayContaining(['Sign-in & Privacy', 'Help & Support']));
    for (const l of labels) {expect([l, handler.includes(`case '${l}':`)]).toEqual([l, true]);}
  });

  it('Sign-in & Privacy opens its screen; Help & Support opens the support form', () => {
    expect(handler).toMatch(/case 'Sign-in & Privacy': navigateOnce\(navigation, 'AgentSignInPrivacy'\); break;/);
    expect(handler).toMatch(/case 'Help & Support': {4}openSupport\(\); break;/);
    expect(read('src/navigation/AgentNavigator.tsx')).toMatch(/name="AgentSignInPrivacy"\s+component=\{AgentSignInPrivacyScreen\}/);
  });

  it('the screen offers biometric lock, password change (then sign-out) and linked devices', () => {
    const scr = strip(read('src/screens/agent/AgentSignInPrivacyScreen.tsx'));
    expect(scr).toMatch(/const bio = useBiometricLock\(\);/);
    expect(scr).toMatch(/await authApi\.changePassword\(\{currentPassword: current, newPassword: next\}\);/);
    expect(scr).toMatch(/void signOut\(\);/);
    expect(scr).toMatch(/navigation\.navigate\('LinkedDevices'\)/);
    expect(scr).toMatch(/export const SUPPORT_URL = 'https:\/\/bravo-secure\.com\/request-support';/);
  });

  it('the biometric hook uses the same keys the app lock reads', () => {
    const hook = read('src/hooks/useBiometricLock.ts');
    expect(hook).toMatch(/BIOMETRIC_LOCK_KEY = 'settings:biometricLock'/);
    expect(hook).toMatch(/BIOMETRIC_LOCK_MIRROR_KEY = 'settings:biometricLock:lastKnown'/);
  });
});
