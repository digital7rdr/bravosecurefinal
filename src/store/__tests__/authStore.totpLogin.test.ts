/**
 * 2026-10-08 — mobile sign-in against AUTH_SECOND_FACTOR=totp (production).
 * /auth/login opens a challenge; /auth/verify MUST echo its id (the server
 * 400s `challenge_required` otherwise). SMS-mode call sites never passed one,
 * so the store keeps the id from login and falls back to it.
 */
jest.mock('@services/api', () => ({
  authApi: {login: jest.fn(), verify: jest.fn(), me: jest.fn(), registerVerify: jest.fn()},
  agentApi: {},
  getDeviceId: jest.fn(() => Promise.resolve('dev-1')),
  getDeviceIdentity: jest.fn(() => ({deviceModel: 'Pixel', deviceBrand: 'google', osVersion: '15', appVersion: '1.0.316'})),
  tokenStore: {get: jest.fn(), getRefresh: jest.fn(), set: jest.fn(), clear: jest.fn()},
  subscriptionApi: {},
}));
jest.mock('@modules/observability', () => ({setUser: jest.fn()}));
jest.mock('expo-local-authentication', () => ({}));
jest.mock('@store/activitySync', () => ({
  syncWorkspaceContextFromMe: jest.fn(),
  resetActivitySyncWatermark: jest.fn(() => Promise.resolve()),
  stopActivitySync: jest.fn(),
}));

jest.mock('@store/pendingProvider', () => ({pendingProvider: {get: jest.fn(() => Promise.resolve(false))}}));

import {useAuthStore} from '@store/authStore';
import {authApi} from '@services/api';

const login  = authApi.login  as jest.Mock;
const verify = authApi.verify as jest.Mock;
const registerVerify = authApi.registerVerify as jest.Mock;
const me = authApi.me as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  useAuthStore.setState({pendingUserId: null, pendingPhone: null, pendingChallengeId: null, pendingJustRegistered: false, justRegistered: false, isAuthenticated: false, isLoading: false, error: null});
});

describe('verifyRegister (sign-up step 2, TOTP-mode server — phone proven by SMS, authenticator next)', () => {
  const p = {email: 'a@b.io', password: 'pass1234', fullName: 'A', phoneE164: '+971500000000', code: '123456'};
  const ME = {user: {id: 'u1', email: 'a@b.io', display_name: 'A', role: 'individual', subscription_tier: 'lite'}};

  it('returns the enrolment step, keeps the challenge, and does NOT authenticate yet', async () => {
    const enrol = {uri: 'otpauth://totp/x', secret: 'SEED', backupCodes: ['A1B2C3D4']};
    registerVerify.mockResolvedValue({userId: 'u1', otpSentTo: null, challengeId: 'ch-1', secondFactor: 'totp_enrol', enrol});
    const next = await useAuthStore.getState().verifyRegister(p);
    expect(next).toEqual({userId: 'u1', challengeId: 'ch-1', secondFactor: 'totp_enrol', enrol});
    const st = useAuthStore.getState();
    expect(st.isAuthenticated).toBe(false);
    expect(st.pendingChallengeId).toBe('ch-1');
    expect(st.pendingUserId).toBe('u1');
    expect(st.pendingJustRegistered).toBe(true);
  });

  it('authenticator verify + completeAuth then finishes the sign-up with justRegistered raised', async () => {
    registerVerify.mockResolvedValue({userId: 'u1', otpSentTo: null, challengeId: 'ch-1', secondFactor: 'totp_enrol', enrol: null});
    verify.mockResolvedValue({user: ME.user, accessToken: 'a', refreshToken: 'r', expiresIn: 900});
    me.mockResolvedValue(ME);
    await useAuthStore.getState().verifyRegister(p);
    await useAuthStore.getState().verifyOtp('u1', '654321');
    expect(verify.mock.calls[0][0].challengeId).toBe('ch-1');
    await useAuthStore.getState().completeAuth();
    const st = useAuthStore.getState();
    expect(st.isAuthenticated).toBe(true);
    expect(st.justRegistered).toBe(true);
    expect(st.pendingJustRegistered).toBe(false);
  });

  it('a plain login + completeAuth never raises justRegistered', async () => {
    me.mockResolvedValue(ME);
    await useAuthStore.getState().completeAuth();
    expect(useAuthStore.getState().justRegistered).toBe(false);
  });

  it('SMS-mode server (tokens returned) → null, authenticated immediately as before', async () => {
    registerVerify.mockResolvedValue({user: ME.user, accessToken: 'a', refreshToken: 'r', expiresIn: 900});
    const next = await useAuthStore.getState().verifyRegister(p);
    expect(next).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().justRegistered).toBe(true);
  });
});

describe('login (TOTP mode)', () => {
  it('surfaces challengeId / secondFactor / enrol and remembers the challenge', async () => {
    const enrol = {uri: 'otpauth://totp/Bravo:x', secret: 'ABCDEFGH', backupCodes: ['A1B2C3D4']};
    login.mockResolvedValue({userId: 'u1', otpSentTo: null, devOtpCode: null, challengeId: 'ch-1', secondFactor: 'totp_enrol', enrol});

    const res = await useAuthStore.getState().login({phoneE164: '+971500000000', password: 'pw'});

    expect(login).toHaveBeenCalledWith(expect.objectContaining({phoneE164: '+971500000000', password: 'pw', deviceId: 'dev-1', platform: expect.any(String), deviceModel: 'Pixel'}));
    expect(res).toEqual({userId: 'u1', phone: null, devOtpCode: undefined, challengeId: 'ch-1', secondFactor: 'totp_enrol', enrol});
    expect(useAuthStore.getState().pendingChallengeId).toBe('ch-1');
    expect(useAuthStore.getState().pendingUserId).toBe('u1');
  });

  it('treats a legacy SMS response (no secondFactor) as sms', async () => {
    login.mockResolvedValue({userId: 'u1', otpSentTo: '+971500000000'});
    const res = await useAuthStore.getState().login({email: 'a@b.io', password: 'pw'});
    expect(res.secondFactor).toBe('sms');
    expect(res.challengeId).toBeNull();
    expect(useAuthStore.getState().pendingChallengeId).toBeNull();
  });

  it('keeps the no-enumeration shape: bad credentials → userId null, no secondFactor', async () => {
    login.mockResolvedValue({userId: null, otpSentTo: null, devOtpCode: null, challengeId: null, secondFactor: null, enrol: null});
    const res = await useAuthStore.getState().login({email: 'a@b.io', password: 'nope'});
    expect(res.userId).toBeNull();
    expect(res.secondFactor).toBeNull();
  });
});

describe('verifyOtp', () => {
  it('sends the challengeId it is given', async () => {
    verify.mockResolvedValue({user: {}, accessToken: 'a', refreshToken: 'r', expiresIn: 900});
    await useAuthStore.getState().verifyOtp('u1', '123456', 'ch-explicit');
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({userId: 'u1', code: '123456', challengeId: 'ch-explicit', deviceId: 'dev-1', platform: expect.any(String)}));
  });

  it('falls back to the challenge stored by login when the caller omits it', async () => {
    login.mockResolvedValue({userId: 'u1', otpSentTo: null, challengeId: 'ch-from-login', secondFactor: 'totp', enrol: null});
    verify.mockResolvedValue({user: {}, accessToken: 'a', refreshToken: 'r', expiresIn: 900});
    await useAuthStore.getState().login({phoneE164: '+971500000000', password: 'pw'});
    await useAuthStore.getState().verifyOtp('u1', 'A1B2C3D4');
    expect(verify.mock.calls[0][0].challengeId).toBe('ch-from-login');
    expect(useAuthStore.getState().pendingChallengeId).toBeNull(); // consumed
  });

  it('omits challengeId entirely in SMS mode (older auth-service DTOs reject unknown keys)', async () => {
    verify.mockResolvedValue({user: {}, accessToken: 'a', refreshToken: 'r', expiresIn: 900});
    await useAuthStore.getState().verifyOtp('u1', '123456');
    expect('challengeId' in verify.mock.calls[0][0]).toBe(false);
  });

  it('keeps the challenge for a retry when the code is wrong', async () => {
    useAuthStore.setState({pendingChallengeId: 'ch-1'});
    verify.mockRejectedValue(new Error('otp_invalid'));
    await expect(useAuthStore.getState().verifyOtp('u1', '000000')).rejects.toThrow('otp_invalid');
    expect(useAuthStore.getState().pendingChallengeId).toBe('ch-1');
  });

describe('login (MOBILE_SECOND_FACTOR=none server — session from the password step)', () => {
  const ME = {user: {id: 'u1', email: 'a@b.io', display_name: 'A', role: 'individual', subscription_tier: 'lite'}};
  it("returns secondFactor 'none' and completeAuth signs in without any code", async () => {
    login.mockResolvedValue({userId: 'u1', otpSentTo: null, devOtpCode: null, challengeId: null, secondFactor: 'none', enrol: null, user: ME.user, accessToken: 'a', refreshToken: 'r', expiresIn: 900});
    me.mockResolvedValue(ME);
    const res = await useAuthStore.getState().login({phoneE164: '+971500000000', password: 'pw'});
    expect(res.secondFactor).toBe('none');
    expect(res.challengeId).toBeNull();
    expect(verify).not.toHaveBeenCalled();
    await useAuthStore.getState().completeAuth();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().justRegistered).toBe(false);
  });
});
});
