/**
 * B-849 — the Workspace Hub's own-organisation card, and the lapsed owner it
 * used to hide.
 *
 * TWO defects in one card (founder screenshots, 2026-09-11):
 *
 *  1. It entered with a NULL workspace context. Null does not mean "no
 *     organisation" — both scoping belts are fail-open, so it meant EVERY
 *     organisation, and this card was the one deliberate producer of that
 *     state. (Critic MAJOR-3a wanted an agency person able to point the
 *     surface back at their agency; a NAMED context is what actually does it.)
 *  2. It called whatever org it found "Your organisation". `owns_workspace` is
 *     lapse-gated, so for a lapsed owner the primary-org resolution falls
 *     through to the first MEMBERSHIP — and the card then labelled an employer
 *     as the user's own company.
 *
 * And the second half of the same report: the "subscription lapsed" card
 * required `wsList.length === 0`, so an owner who also belonged anywhere else
 * had no row for their own company on the page at all.
 *
 * Same harness as `workspaceIdentity.test.tsx` (it mounts the real screen with
 * the API layer mocked); the context store is a spy here rather than a stub,
 * because the whole point is WHAT gets written.
 */
import React from 'react';
import {render, fireEvent, waitFor} from '@testing-library/react-native';

let mockUser: Record<string, unknown> | null;
let mockWorkspace: {name: string} | null;
const mockSetActiveWorkspace = jest.fn();

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn()}),
  useFocusEffect: (cb: () => void) => {
    (require('react') as typeof import('react')).useEffect(cb, []);
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));
jest.mock('@/modules/messenger/ui/AmbientBg', () => ({AmbientBg: 'AmbientBg'}));
jest.mock('@/modules/messenger/store/messengerStore', () => ({
  useMessengerStore: {getState: () => ({conversations: {}})},
}));
jest.mock('@store/activeWorkspace', () => ({
  useActiveWorkspace: {getState: () => ({setActiveWorkspace: mockSetActiveWorkspace})},
  clearActiveWorkspace: jest.fn(),
}));
jest.mock('@navigation/departmentalEntry', () => ({openDepartmentChannels: jest.fn()}));
jest.mock('../inviteAccept', () => ({acceptInviteFlow: jest.fn()}));
jest.mock('@store/authStore', () => ({
  useAuthStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({user: mockUser}),
    {getState: () => ({recheckMembership: () => Promise.resolve()})},
  ),
}));
jest.mock('@services/api', () => ({
  enterpriseApi: {
    myWorkspace: () => Promise.resolve({data: {workspace: mockWorkspace}}),
    myInvites: () => Promise.resolve({data: {invites: []}}),
  },
  departmentApi: {listChannels: () => Promise.resolve({data: {channels: []}})},
}));

import WorkspaceHubScreen from '../WorkspaceHubScreen';

const ME = 'u1';
const AGENCY = 'org-agency';
const ACME = 'org-acme';
const BOREALIS = 'org-borealis';

beforeEach(() => {
  jest.clearAllMocks();
  mockWorkspace = null;
  mockUser = null;
});

describe('the own-organisation card enters a NAMED organisation', () => {
  it('writes a real context, never null', async () => {
    // THE DEFECT. A null write is what made the Channels directory list every
    // company the person belongs to.
    mockUser = {
      id: ME, full_name: 'Dana Okonkwo', account_kind: 'agency', is_org_manager: true,
      org: {id: AGENCY, name: 'Meridian Protective'},
      workspaces: [{org_id: ACME, name: 'Acme', role: 'employee'}],
    };
    const u = render(<WorkspaceHubScreen />);
    fireEvent.press(await u.findByText('Meridian Protective'));
    expect(mockSetActiveWorkspace).toHaveBeenCalledWith({
      org_id: AGENCY, name: 'Meridian Protective', role: 'manager',
    });
    expect(mockSetActiveWorkspace).not.toHaveBeenCalledWith(null);
  });

  it('says "Your organisation" ONLY when the org really is theirs', async () => {
    // org_workspaces keys an org on its owner, so a company account's own org
    // row has `org.id === user.id`.
    mockUser = {
      id: ME, full_name: 'Dana Okonkwo', account_kind: 'agency',
      org: {id: ME, name: 'Acme Security'},
      workspaces: [{org_id: ACME, name: 'Acme', role: 'employee'}],
    };
    const u = render(<WorkspaceHubScreen />);
    expect(await u.findByText('Your organisation · Enter')).toBeTruthy();
  });

  it('calls a non-owner org what it is, never "Your organisation"', async () => {
    // The screenshot: the card labelled whatever `org` resolved to as the
    // user's own company. Here `org` is an AGENCY (no org_workspaces row), so
    // the card renders — with an honest role line.
    mockUser = {
      id: ME, full_name: 'Dana Okonkwo', account_kind: 'individual',
      org: {id: AGENCY, name: 'Meridian Protective'}, org_is_workspace: false,
      // MANAGER on the tile, so the member line below can only have come from
      // the own-organisation card (the tile's own label would collide).
      workspaces: [{org_id: ACME, name: 'Acme', role: 'manager'}],
    };
    const u = render(<WorkspaceHubScreen />);
    expect(await u.findByText('Member · Enter workspace')).toBeTruthy();
    expect(u.queryByText('Your organisation · Enter')).toBeNull();
  });

  /**
   * ⚠️ F1 RE-POINTED THIS PAIR. The version above used to be the ONLY case for
   * "org is not the user's own company", and it pinned the wrong behaviour for
   * the persona it was named after: a LAPSED workspace owner's `org` falls
   * through to an EMPLOYER WORKSPACE, and a workspace absent from the
   * lapse-gated array is by construction lapsed — not enterable at all
   * (founder Q1). Renaming the subtitle was only half the defect; the card
   * itself must not be there.
   */
  it('an EMPLOYER WORKSPACE that lapsed gets NO card — it is not enterable', async () => {
    mockUser = {
      id: ME, full_name: 'Dana Okonkwo', account_kind: 'individual',
      org: {id: ACME, name: 'Acme'}, org_is_workspace: true,
      workspaces: [{org_id: BOREALIS, name: 'Borealis', role: 'manager'}],
    };
    const u = render(<WorkspaceHubScreen />);
    // The live tile is still there…
    expect(await u.findByText('Borealis')).toBeTruthy();
    // …and the dead employer is not offered as a door.
    expect(u.queryByText('Acme')).toBeNull();
    expect(u.queryByText('Member · Enter workspace')).toBeNull();
    expect(u.queryByText('Your organisation · Enter')).toBeNull();
  });

  it('an agency CPO DOES get the card, as an Officer', async () => {
    mockUser = {
      id: ME, full_name: 'Dana Okonkwo', account_kind: 'cpo',
      org: {id: AGENCY, name: 'Meridian Protective'}, org_is_workspace: false,
      workspaces: [{org_id: ACME, name: 'Acme', role: 'manager'}],
    };
    const u = render(<WorkspaceHubScreen />);
    expect(await u.findByText('Meridian Protective')).toBeTruthy();
    expect(u.getByText('Officer · Enter workspace')).toBeTruthy();
  });

  it('a promoted CPO keeps the MANAGER line (is_org_manager outranks account_kind)', async () => {
    mockUser = {
      id: ME, full_name: 'Dana Okonkwo', account_kind: 'cpo', is_org_manager: true,
      org: {id: AGENCY, name: 'Meridian Protective'},
      workspaces: [{org_id: ACME, name: 'Acme', role: 'employee'}],
    };
    const u = render(<WorkspaceHubScreen />);
    expect(await u.findByText('Manager · Enter workspace')).toBeTruthy();
  });

  it('an unpromoted CPO gets the officer line', async () => {
    mockUser = {
      id: ME, full_name: 'Dana Okonkwo', account_kind: 'cpo',
      org: {id: AGENCY, name: 'Meridian Protective'},
      workspaces: [{org_id: ACME, name: 'Acme', role: 'employee'}],
    };
    const u = render(<WorkspaceHubScreen />);
    expect(await u.findByText('Officer · Enter workspace')).toBeTruthy();
  });
});

describe('D6 — a lapsed owner sees their own workspace, however many others they belong to', () => {
  it('renders the lapsed card ALONGSIDE the tiles', async () => {
    // The gate used to be `wsList.length === 0`, so this person — an owner with
    // one membership — had no row for their own company anywhere on the page.
    mockWorkspace = {name: 'Bravo Advisory Group'};
    mockUser = {
      id: ME, full_name: 'Dana Okonkwo',
      workspaces: [{org_id: ACME, name: 'Acme', role: 'employee'}],
    };
    const u = render(<WorkspaceHubScreen />);
    expect(await u.findByText('Subscription lapsed — renew Enterprise to enter')).toBeTruthy();
    expect(u.getByText('Bravo Advisory Group')).toBeTruthy();
    // …and the membership tile is still there beside it.
    expect(u.getByText('Acme')).toBeTruthy();
  });

  it('is informational, NOT enterable (founder default Q1)', async () => {
    mockWorkspace = {name: 'Bravo Advisory Group'};
    mockUser = {
      id: ME, full_name: 'Dana Okonkwo',
      workspaces: [{org_id: ACME, name: 'Acme', role: 'employee'}],
    };
    const u = render(<WorkspaceHubScreen />);
    fireEvent.press(await u.findByText('Bravo Advisory Group'));
    await waitFor(() => expect(mockSetActiveWorkspace).not.toHaveBeenCalled());
  });

  it('an ACTIVE owner gets no lapsed card — their own row IS in the list', async () => {
    mockWorkspace = {name: 'Bravo Advisory Group'};
    mockUser = {
      id: ME, full_name: 'Dana Okonkwo',
      workspaces: [
        {org_id: ME, name: 'Bravo Advisory Group', role: 'owner'},
        {org_id: ACME, name: 'Acme', role: 'employee'},
      ],
    };
    const u = render(<WorkspaceHubScreen />);
    await u.findByText('Acme');
    expect(u.queryByText('Subscription lapsed — renew Enterprise to enter')).toBeNull();
  });
});

describe('the null-context producer is GONE', () => {
  /**
   * Comment-stripped and line-anchored: the prose above names the very token
   * this forbids, and the house `/*` stripper has eaten real code in this repo
   * before. The two remaining `clearActiveWorkspace` cards are the OLD-SERVER
   * lane (`workspaces` undefined), which cannot be scoped by `?orgId` at all
   * and on which no context can ever have been set.
   */
  it('WorkspaceHubScreen never calls enterWorkspace(null)', () => {
    const {readFileSync} = require('node:fs') as typeof import('node:fs');
    const {join} = require('node:path') as typeof import('node:path');
    const src = readFileSync(join(process.cwd(), 'src', 'screens', 'deptchat', 'WorkspaceHubScreen.tsx'), 'utf8')
      .split(/\r?\n/)
      .filter(l => {
        const t = l.trim();
        return t.length > 0 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
    // Non-vacuous: the function it names must still exist in the stripped text.
    expect(src).toMatch(/const enterWorkspace = useCallback/);
    expect(src).not.toMatch(/enterWorkspace\(null\)/);
  });
});
