/**
 * B-848 / A10 — accepting an invite enters the workspace you JUST JOINED.
 *
 * `pointContextAtJoinedWorkspace` used to take the first entry of
 * `user.workspaces` whose role was not 'owner', on the stated assumption that
 * "at most one membership exists". That stopped being true the moment a person
 * could belong to several workspaces: the array is server-ordered, so the first
 * non-owner row is the OLDEST membership. Accepting an invite to a third
 * company dropped the user into the first company they ever joined — and the
 * workspace they had just been invited to was the one place they did not land.
 *
 * The joined org is identified POSITIONALLY: the entry that was not in the list
 * before the accept. `acceptInvite` answers no org id, and the invite row is
 * consumed by the accept, so a snapshot comparison is the only thing left that
 * can tell them apart.
 */
const mockAcceptInvite = jest.fn();
const mockRecheck = jest.fn();
const mockSetActiveWorkspace = jest.fn();
const mockAlert = jest.fn();

type Row = {org_id: string; name: string; role: 'owner' | 'manager' | 'employee' | 'cpo'};
let mockUser: {id: string; org?: unknown; owns_workspace?: boolean; workspaces?: Row[]} | null;

jest.mock('@utils/alert', () => ({Alert: {alert: (...a: unknown[]) => mockAlert(...a)}}));
jest.mock('@services/api', () => ({
  enterpriseApi: {acceptInvite: (...a: unknown[]) => mockAcceptInvite(...a)},
}));
jest.mock('@store/authStore', () => ({
  useAuthStore: {getState: () => ({user: mockUser, recheckMembership: mockRecheck})},
}));
jest.mock('@store/activeWorkspace', () => ({
  useActiveWorkspace: {getState: () => ({setActiveWorkspace: mockSetActiveWorkspace})},
}));

import {acceptInviteFlow} from '../inviteAccept';

const ACME = 'aaaa1111-bbbb-4ccc-8ddd-eeeeffff0001';
const BOREALIS = 'aaaa2222-bbbb-4ccc-8ddd-eeeeffff0002';
const CERES = 'aaaa3333-bbbb-4ccc-8ddd-eeeeffff0003';
const OWN = 'aaaa0000-bbbb-4ccc-8ddd-eeeeffff0000';

const row = (org_id: string, name: string, role: Row['role'] = 'employee'): Row =>
  ({org_id, name, role});

beforeEach(() => {
  jest.clearAllMocks();
  mockAcceptInvite.mockResolvedValue({});
  mockUser = {id: OWN, org: {id: ACME, name: 'Acme'}, workspaces: []};
});

/** The recheck is what installs the post-accept list. */
function recheckInstalls(list: Row[]) {
  mockRecheck.mockImplementation(async () => {
    if (mockUser) {mockUser.workspaces = list;}
  });
}

describe('the context lands on the workspace that was just joined', () => {
  it('takes the NEW entry, not the oldest membership', async () => {
    // THE DEFECT, exactly: Acme is first and non-owner, Ceres is the invite.
    mockUser = {
      id: OWN, org: {id: ACME, name: 'Acme'},
      workspaces: [row(ACME, 'Acme'), row(BOREALIS, 'Borealis', 'manager')],
    };
    recheckInstalls([row(ACME, 'Acme'), row(BOREALIS, 'Borealis', 'manager'), row(CERES, 'Ceres')]);

    expect(await acceptInviteFlow('code1')).toBe(true);
    expect(mockSetActiveWorkspace).toHaveBeenCalledWith({
      org_id: CERES, name: 'Ceres', role: 'employee',
    });
    expect(mockSetActiveWorkspace).not.toHaveBeenCalledWith(
      expect.objectContaining({org_id: ACME}),
    );
  });

  it('works when the new row is not last in the server\'s ordering', async () => {
    // Nothing promises the new membership sorts last, so the rule has to be
    // "absent from the snapshot", never "the tail of the array".
    mockUser = {id: OWN, org: {id: BOREALIS, name: 'Borealis'}, workspaces: [row(BOREALIS, 'Borealis')]};
    recheckInstalls([row(ACME, 'Acme'), row(BOREALIS, 'Borealis')]);

    expect(await acceptInviteFlow('code1')).toBe(true);
    expect(mockSetActiveWorkspace).toHaveBeenCalledWith({
      org_id: ACME, name: 'Acme', role: 'employee',
    });
  });

  it('an OWNER joining their first workspace lands in it, not in their own', async () => {
    // The edge-review #3 case the original fix was written for: an owner's
    // primary org stays their OWN workspace, so navigating without a context
    // put them on their own Home and the join read as a failure.
    mockUser = {
      id: OWN, owns_workspace: true, org: {id: OWN, name: 'Bravo Advisory'},
      workspaces: [row(OWN, 'Bravo Advisory', 'owner')],
    };
    recheckInstalls([row(OWN, 'Bravo Advisory', 'owner'), row(CERES, 'Ceres')]);

    expect(await acceptInviteFlow('code1')).toBe(true);
    expect(mockSetActiveWorkspace).toHaveBeenCalledWith({
      org_id: CERES, name: 'Ceres', role: 'employee',
    });
  });
});

describe('nothing new means nothing written — never a null context', () => {
  it('leaves the context alone when the list did not grow', async () => {
    // Clearing here would be the null-context bug this change exists to remove:
    // null does not mean "no organisation", it used to mean EVERY organisation.
    mockUser = {id: OWN, org: {id: ACME, name: 'Acme'}, workspaces: [row(ACME, 'Acme')]};
    recheckInstalls([row(ACME, 'Acme')]);

    expect(await acceptInviteFlow('code1')).toBe(true);
    expect(mockSetActiveWorkspace).not.toHaveBeenCalled();
  });

  it('an OLD server (no workspaces array) writes nothing', async () => {
    mockUser = {id: OWN, org: {id: ACME, name: 'Acme'}};
    mockRecheck.mockResolvedValue(undefined);

    expect(await acceptInviteFlow('code1')).toBe(true);
    expect(mockSetActiveWorkspace).not.toHaveBeenCalled();
  });

  it('already_a_member refreshes and still writes nothing new', async () => {
    mockUser = {id: OWN, org: {id: ACME, name: 'Acme'}, workspaces: [row(ACME, 'Acme')]};
    mockAcceptInvite.mockRejectedValue({response: {data: {message: 'already_a_member'}}});
    recheckInstalls([row(ACME, 'Acme')]);

    expect(await acceptInviteFlow('code1')).toBe(true);
    expect(mockSetActiveWorkspace).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledWith('Already a member', expect.any(String));
  });

  it('a REFUSED accept writes no context at all', async () => {
    mockAcceptInvite.mockRejectedValue({response: {data: {message: 'invite_invalid_or_expired'}}});
    expect(await acceptInviteFlow('code1')).toBe(false);
    expect(mockSetActiveWorkspace).not.toHaveBeenCalled();
  });
});
