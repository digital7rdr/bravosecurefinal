/**
 * Owner 2026-10-31 — the pre-auth welcome page has four doors (Messenger,
 * Secure Services, Workspace, Bravo GeoRisk) and each opens its own options;
 * the "Enter with Code" options carry the code through signup and redeem it
 * on the first signed-in mount. Also: the Sign In footer no longer covers the
 * last card.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {normalizeJoinCode} from '@store/pendingJoin';

const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const strip = (src: string): string => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

describe('welcome page doors', () => {
  const src = strip(read('src/screens/auth/OnboardingScreen.tsx'));
  it('Messenger, Secure Services, Workspace, Bravo GeoRisk — in that order', () => {
    const titles = [...src.matchAll(/\{key: '[a-z]+', tint: '[a-z]+', Icon: \w+, title: '([^']+)'/g)].map(m => m[1]);
    expect(titles).toEqual(['Messenger', 'Secure Services', 'Workspace', 'Bravo GeoRisk']);
    expect(src).toMatch(/workspace: 'workspace',/);
    expect(src).toMatch(/useProductStore\.getState\(\)\.setOnboardingPath\(SERVICE_PRODUCT\[key\]\)/);
  });
  it('the floating Sign In footer leaves room under the last card', () => {
    expect(src).toMatch(/paddingBottom: insets\.bottom \+ FOOTER_SPACE/);
  });
});

describe('Enter with Code', () => {
  it('codes are upper-cased letters, digits and dashes', () => {
    expect(normalizeJoinCode(' bravo-7q2k3m! ')).toBe('BRAVO-7Q2K3M');
    expect(normalizeJoinCode('')).toBe('');
  });

  it('the plan screen carries the code through signup and signs up a personal account', () => {
    const src = strip(read('src/screens/auth/RoleSelectionScreen.tsx'));
    const confirm = src.slice(src.indexOf('const handleConfirm = () =>'), src.indexOf('const continueDisabled'));
    expect(confirm).toMatch(/void pendingJoin\.set\(\{kind: selectedCard\.code, code: c\}\);/);
    expect(confirm).toMatch(/navigation\.navigate\('Register', \{role: 'individual', tier: 'lite'\}\);/);
    expect(src).toMatch(/const continueDisabled = !!selectedCard\?\.soon \|\| \(needsCode && !normalizeJoinCode\(code\)\);/);
    // Enterprise (Company Register) lands on the Workspace setup after signup.
    expect(confirm).toMatch(/setPendingLanding\(selected === 'enterprise' \? 'workspace' : null\)/);
  });

  it('the first signed-in mount redeems it: agent → roster code, member → Join Workspace', () => {
    const host = strip(read('src/components/PendingJoinHost.tsx'));
    expect(host).toMatch(/await orgInviteApi\.redeem\(join\.code\);/);
    expect(host).toMatch(/completeAuth\(\)/);
    expect(host).toMatch(/screen: 'MessengerTab', params: \{screen: 'JoinWorkspace', initial: false, params: \{code\}\}/);
    expect(strip(read('src/navigation/index.tsx'))).toMatch(/<PendingJoinHost \/>/);
    // Signing out drops an unused code.
    expect(read('src/store/authStore.ts')).toMatch(/await pendingJoin\.clear\(\);/);
  });
});

describe('product store', () => {
  it('Workspace door → Messenger product; Company Register lands on the Workspace', () => {
    const {useProductStore} = require('@store/productStore') as typeof import('@store/productStore');
    useProductStore.getState().reset();
    useProductStore.getState().setOnboardingPath('workspace');
    let st = useProductStore.getState();
    expect(st.pendingProduct).toBe('messenger');
    expect(st.onboardingPath).toBe('workspace');
    st.setPendingLanding('workspace');
    st.adoptPendingProduct();
    st = useProductStore.getState();
    expect(st.activeProduct).toBe('messenger');
    expect(st.landing).toBe('workspace');
    expect(st.pendingLanding).toBeNull();
  });
});
