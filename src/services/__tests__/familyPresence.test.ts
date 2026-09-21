/**
 * B-843/A3 + P2-8 — the family location reporter's eligibility gate.
 *
 * A3's complaint was never "the client should not check". It was that the
 * check read ONE membership row: a person on two plans whose OLDEST root had
 * them on hold was told "held" and went dark for six hours, while a second
 * root was entitled to their location.
 *
 * Deleting the check outright traded that for a worse promise: this service's
 * whole privacy posture is "a non-member's fix is never read or sent", and a
 * gate-less reporter reads a real GPS fix and POSTs it before the server can
 * say no. So the gate is back, fetched across EVERY root, with no client-side
 * hold logic — `{reported:false}` still owns that, which is what A3 asked for.
 */
const mockMemberships = jest.fn();
const mockMembership = jest.fn();
const mockReportLocation = jest.fn();
const mockGetCurrentPosition = jest.fn();

jest.mock('@services/api', () => ({
  familyApi: {
    memberships:    (...a: unknown[]) => mockMemberships(...a),
    membership:     (...a: unknown[]) => mockMembership(...a),
    reportLocation: (...a: unknown[]) => mockReportLocation(...a),
  },
}));
jest.mock('react-native-geolocation-service', () => ({
  __esModule: true,
  default: {getCurrentPosition: (...a: unknown[]) => mockGetCurrentPosition(...a)},
}));
jest.mock('@store/authStore', () => {
  const state = {user: {id: 'user-me'}};
  return {useAuthStore: {getState: () => state}};
});
jest.mock('react-native', () => ({
  AppState: {currentState: 'active', addEventListener: () => ({remove: () => {}})},
  Platform: {OS: 'android'},
  PermissionsAndroid: {
    PERMISSIONS: {ACCESS_FINE_LOCATION: 'fine', ACCESS_COARSE_LOCATION: 'coarse'},
    check: async () => true,
  },
}));

import {ensureFamilyPresence, stopFamilyPresence} from '../familyPresence';

const fix = {coords: {latitude: 25.2, longitude: 55.27, accuracy: 8}};

beforeEach(() => {
  jest.clearAllMocks();
  // Module state (backoff, throttle, the cached answer) is per-process; the
  // stop() call resets all of it so each case starts from a cold boot.
  stopFamilyPresence();
  mockGetCurrentPosition.mockImplementation((ok: (p: unknown) => void) => ok(fix));
  mockReportLocation.mockResolvedValue({data: {ok: true, reported: true}});
});
afterEach(() => stopFamilyPresence());

/** ensureFamilyPresence fires one push immediately; let its awaits settle. */
async function tick() {
  ensureFamilyPresence();
  for (let i = 0; i < 12; i++) {await Promise.resolve();}
}

describe('P2-8 — a non-member\'s fix is never read or sent', () => {
  it('reads NO GPS and posts nothing when the person is under zero roots', async () => {
    mockMemberships.mockResolvedValue({data: {memberships: []}});
    await tick();
    expect(mockMemberships).toHaveBeenCalled();
    // The promise this file exists to keep.
    expect(mockGetCurrentPosition).not.toHaveBeenCalled();
    expect(mockReportLocation).not.toHaveBeenCalled();
  });

  it('reads nothing when BOTH reads fail — an unknown answer is not a yes', async () => {
    mockMemberships.mockRejectedValue(new Error('offline'));
    mockMembership.mockRejectedValue(new Error('offline'));
    await tick();
    expect(mockGetCurrentPosition).not.toHaveBeenCalled();
    expect(mockReportLocation).not.toHaveBeenCalled();
  });

  it('reports for a member of at least one root', async () => {
    mockMemberships.mockResolvedValue({data: {memberships: [{holderId: 'h1'}]}});
    await tick();
    expect(mockGetCurrentPosition).toHaveBeenCalled();
    expect(mockReportLocation).toHaveBeenCalledWith(
      expect.objectContaining({lat: 25.2, lng: 55.27}),
    );
  });
});

describe('A3 — the gate reads EVERY root, and never decides a hold itself', () => {
  it('a member HELD by one root still reports (the server decides, not us)', async () => {
    // This is the six-hour blackout A3 was opened for: the OLDEST row said
    // "held", so the old client stopped — even though another root was live.
    mockMemberships.mockResolvedValue({data: {memberships: [
      {holderId: 'h1', heldUntil: new Date(Date.now() + 3600_000).toISOString()},
      {holderId: 'h2', heldUntil: null},
    ]}});
    await tick();
    expect(mockReportLocation).toHaveBeenCalled();
  });

  it('even a SINGLE held row reports — the client owns no hold logic at all', async () => {
    mockMemberships.mockResolvedValue({data: {memberships: [
      {holderId: 'h1', heldUntil: new Date(Date.now() + 3600_000).toISOString()},
    ]}});
    await tick();
    expect(mockReportLocation).toHaveBeenCalled();
  });

  it('falls back to the single read on an old server', async () => {
    mockMemberships.mockRejectedValue({response: {status: 404, data: {}}});
    mockMembership.mockResolvedValue({data: {membership: {holderId: 'h1'}}});
    await tick();
    expect(mockMembership).toHaveBeenCalled();
    expect(mockReportLocation).toHaveBeenCalled();
  });

  it('the old server saying "no membership" is still a no', async () => {
    mockMemberships.mockRejectedValue({response: {status: 404, data: {}}});
    mockMembership.mockResolvedValue({data: {membership: null}});
    await tick();
    expect(mockGetCurrentPosition).not.toHaveBeenCalled();
  });
});

describe('the server keeps the last word', () => {
  it('a {reported:false} answer re-arms the gate for the next boot', async () => {
    mockMemberships.mockResolvedValue({data: {memberships: [{holderId: 'h1'}]}});
    mockReportLocation.mockResolvedValue({data: {ok: true, reported: false}});
    await tick();
    expect(mockReportLocation).toHaveBeenCalledTimes(1);
    // The cached "yes" is dropped, so eligibility is re-asked rather than
    // assumed — that is how a revoke / hold / opt-out lands mid-session.
    stopFamilyPresence();
    mockMemberships.mockResolvedValue({data: {memberships: []}});
    await tick();
    expect(mockGetCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it('the eligibility read is cached, not repeated on every tick', async () => {
    mockMemberships.mockResolvedValue({data: {memberships: [{holderId: 'h1'}]}});
    await tick();
    expect(mockMemberships).toHaveBeenCalledTimes(1);
  });
});
