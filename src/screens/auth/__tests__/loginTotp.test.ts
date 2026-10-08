/**
 * 2026-10-08 — pure helpers behind the TOTP sign-in screens.
 * The screens themselves need the full RN host; these cover the logic that
 * decides what goes to /auth/login and what the person reads on failure.
 */
jest.mock('@store/authStore', () => ({useAuthStore: jest.fn()}));
jest.mock('@services/api', () => ({tokenStore: {getRefresh: jest.fn()}}));
jest.mock('expo-local-authentication', () => ({}));
jest.mock('expo-clipboard', () => ({}));
jest.mock('expo-linear-gradient', () => ({LinearGradient: 'LinearGradient'}));
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 0, bottom: 0})}));
jest.mock('@navigation/tapGuard', () => ({goBackOnce: jest.fn()}));
jest.mock('@utils/scaling', () => ({scaleTextStyles: (x: unknown) => x}));
jest.mock('@store/pendingTier', () => ({pendingTier: {clear: jest.fn()}}));

import {AxiosError, AxiosHeaders} from 'axios';
import {parseLoginIdentifier} from '@screens/auth/LoginScreen';
import {describeVerifyError} from '@screens/auth/OtpVerifyScreen';

describe('parseLoginIdentifier', () => {
  it.each([
    ['+971 50 123 4567', {phoneE164: '+971501234567'}],
    ['+44 (0)7700-900123', {phoneE164: '+4407700900123'}],
    ['  Ops@Bravo-Secure.COM ', {email: 'ops@bravo-secure.com'}],
  ])('%s → %j', (input, expected) => {
    expect(parseLoginIdentifier(input)).toEqual(expected);
  });

  it('rejects a phone without a country code (server matches phone_e164 exactly)', () => {
    expect(parseLoginIdentifier('0501234567')).toBeNull();
  });

  it('rejects junk and empty input', () => {
    expect(parseLoginIdentifier('')).toBeNull();
    expect(parseLoginIdentifier('bob')).toBeNull();
    expect(parseLoginIdentifier('+12')).toBeNull();
    expect(parseLoginIdentifier('a@b')).toBeNull();
  });
});

function axios400(data: unknown, status = 400): AxiosError {
  const err = new AxiosError('Request failed with status code ' + status, 'ERR_BAD_REQUEST');
  err.response = {data, status, statusText: '', headers: {}, config: {headers: new AxiosHeaders()}};
  return err;
}

describe('describeVerifyError', () => {
  it('reads Nest string-code bodies', () => {
    expect(describeVerifyError(axios400({statusCode: 400, message: 'otp_expired', error: 'Bad Request'}), true)).toMatch(/expired/);
    expect(describeVerifyError(axios400({statusCode: 400, message: 'challenge_required'}), true)).toMatch(/no longer valid/);
    expect(describeVerifyError(axios400({statusCode: 400, message: 'totp_not_setup'}), true)).toMatch(/Authenticator not set up/);
  });

  it('reads the object body with attemptsLeft', () => {
    expect(describeVerifyError(axios400({error: 'otp_invalid', attemptsLeft: 2}), true)).toBe("That code didn't work. Check your authenticator app and try again. 2 attempts left.");
    expect(describeVerifyError(axios400({error: 'otp_invalid', attemptsLeft: 1}), false)).toBe('Invalid code. Please try again. 1 attempt left.');
  });

  it('never shows the raw axios message', () => {
    expect(describeVerifyError(axios400({message: 'something_new'}), true)).not.toMatch(/status code/);
    expect(describeVerifyError(axios400({}, 429), true)).toMatch(/Too many attempts/);
    expect(describeVerifyError(axios400({}, 502), true)).toMatch(/unavailable/);
  });

  it('explains a network failure', () => {
    const err = new AxiosError('Network Error', 'ERR_NETWORK');
    expect(describeVerifyError(err, true)).toMatch(/No connection/);
  });
});
