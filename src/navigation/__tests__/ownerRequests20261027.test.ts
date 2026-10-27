/**
 * 2026-10-27 — owner requests (app side):
 *  2. a workspace manager runs the workspace, not the agency dashboard
 *     (server: account-kind.ts; pinned in workspaceRoles.spec.ts)
 *  3. choose the members of a channel when creating it
 *  4. workspace roles User / Manager / Admin, and role + status changes
 *  5. Messenger / Workspace stand apart from Secure Services: back from
 *     Messenger never lands on Secure Services
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const strip = (src: string): string => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

describe('5 — Messenger is its own product', () => {
  it('enterMessenger switches the product, forgets any return product, and remembers the tab asked for', () => {
    const {useProductStore} = require('@store/productStore') as typeof import('@store/productStore');
    useProductStore.setState({activeProduct: 'secure', returnProduct: 'vbg', gateVisible: false});
    useProductStore.getState().enterMessenger('News');
    let st = useProductStore.getState();
    expect(st.activeProduct).toBe('messenger');
    expect(st.returnProduct).toBeNull();
    expect(st.landing).toBe('messenger');
    expect(st.landingTab).toBe('News');
    useProductStore.getState().clearLanding();
    useProductStore.getState().enterMessenger(null);
    st = useProductStore.getState();
    expect(st.landing).toBeNull();
    expect(st.landingTab).toBeNull();
  });

  it('opening Messenger inside Secure Services hands over to the Messenger product (client shell only)', () => {
    const src = strip(read('src/screens/messenger/MessengerHomeScreen.tsx'));
    expect(src).toMatch(/if \(!inSecureProduct\) \{return;\}/);
    expect(src).toMatch(/if \(!nav\.mountedTreeHasRoute\('SecureTab'\)\) \{return;\}/);
    expect(src).toMatch(/useProductStore\.getState\(\)\.enterMessenger\(tab !== 'Chats' \? tab : null\)/);
    // No way back into Secure Services from the Messenger header.
    expect(src).not.toMatch(/Back to Secure Services/);
    expect(src).not.toMatch(/'SecureTab' as never/);
  });

  it('MainNavigator reopens the requested Messenger tab after the switch', () => {
    const src = strip(read('src/navigation/MainNavigator.tsx'));
    expect(src).toMatch(/openMessengerTabFromRoot\(landingTab\)/);
    const entry = strip(read('src/navigation/departmentalEntry.ts'));
    expect(entry).toMatch(/export function openMessengerTabFromRoot\(tab: string\): boolean/);
  });
});

describe('4 — workspace roles: User / Manager / Admin', () => {
  const src = strip(read('src/screens/deptchat/EmployeesScreen.tsx'));

  it('only the owner and Admins change roles on a workspace', () => {
    expect(src).toMatch(/const canChangeRoles = activeCtx \? isOwner \|\| isAdmin : true;/);
    expect(src).toMatch(/m\.status === 'active' && canChangeRoles &&/);
  });

  it('offers User, Manager and Admin (Admin only on a workspace)', () => {
    expect(src).toMatch(/\{role: 'employee', text: 'User'\}/);
    expect(src).toMatch(/\{role: 'manager', text: 'Manager'\}/);
    expect(src).toMatch(/isWorkspaceRoster \? \[\{role: 'admin' as const, text: 'Admin'\}\] : \[\]/);
    expect(src).toMatch(/orgApi\.setCpoRole\(m\.member_user_id, role\)/);
  });

  it('managers can be suspended, reinstated and removed by the owner, or by an Admin unless they are an Admin', () => {
    expect(src).toMatch(/const canActOnManager = \(m: RosterMember\): boolean =>\s*isOwner \|\| \(isAdmin && !m\.workspace_admin\);/);
    const managers = src.slice(src.indexOf("MANAGERS & ADMINS"));
    expect(managers).toMatch(/setStatus\(m, 'suspended'\)/);
    expect(managers).toMatch(/setStatus\(m, 'removed'\)/);
    expect(managers).toMatch(/roleOf\(m\) === 'admin' \? 'Admin' : 'Manager'/);
  });
});

describe('3 — choose channel members at creation', () => {
  const src = strip(read('src/screens/deptchat/ChannelEditorScreen.tsx'));

  it('Everyone or Choose members, only when creating', () => {
    expect(src).toMatch(/\{!editing && \(/);
    expect(src).toMatch(/\['choose', 'Choose members'/);
    expect(src).toMatch(/orgApi\.listCpos\(\)/);
  });

  it('sends the chosen ids, and refuses an empty choice', () => {
    expect(src).toMatch(/memberMode === 'choose' \? \{\.\.\.body, member_ids: \[\.\.\.chosenIds\]\} : body/);
    expect(src).toMatch(/Choose at least one member, or pick Everyone\./);
    expect(read('src/services/api.ts')).toMatch(/member_ids\?: string\[\]\}\) =>/);
  });
});
