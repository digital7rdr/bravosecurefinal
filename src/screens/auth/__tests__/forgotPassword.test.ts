import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {MIN_RESET_PASSWORD, newPasswordProblem, resetErrorText, resetIdentifierProblem} from '../forgotPassword';

/**
 * Bug (2026-10-16): "Forgot Password not working — Mobile App." The sign-in
 * screen's "Forgot password?" was plain text with no onPress. These pin the
 * door AND the rules of the screen behind it.
 */
const SRC = (rel: string) => readFileSync(join(process.cwd(), 'src', rel), 'utf8');

describe('the sign-in screen opens the reset flow', () => {
  it('"Forgot password?" is a button that navigates to ForgotPassword with what was typed', () => {
    const login = SRC('screens/auth/LoginScreen.tsx');
    const at = login.indexOf('>Forgot password?<');
    expect(at).toBeGreaterThan(-1);
    const before = login.slice(Math.max(0, at - 600), at);
    expect(before).toMatch(/<TouchableOpacity[\s\S]*onPress=\{\(\) => navigation\.navigate\('ForgotPassword', \{identifier: email\.trim\(\) \|\| undefined\}\)\}/);
  });

  it('the screen is registered in the auth stack and talks to the server reset endpoints', () => {
    expect(SRC('navigation/AuthNavigator.tsx')).toMatch(/<Stack\.Screen name="ForgotPassword" component=\{ForgotPasswordScreen\} \/>/);
    const api = SRC('services/api.ts');
    for (const p of ['/auth/password/reset/status', '/auth/password/reset/start', '/auth/password/reset/complete']) {
      expect(`${p}:${api.includes(`'${p}'`)}`).toBe(`${p}:true`);
    }
  });
});

describe('forgot-password rules (mirror the server DTOs)', () => {
  it('accepts an email or an international number, and says what is wrong otherwise', () => {
    expect(resetIdentifierProblem('you@company.com')).toBeNull();
    expect(resetIdentifierProblem('+971 50 123 4567')).toBeNull();
    expect(resetIdentifierProblem('00971501234567')).toBeNull();
    expect(resetIdentifierProblem('050 123 4567')).toMatch(/country code/);
    expect(resetIdentifierProblem('you@company')).toMatch(/email/);
    expect(resetIdentifierProblem('  ')).toMatch(/mobile number or email/);
  });

  it('new password: the server minimum, and both copies the same', () => {
    expect(newPasswordProblem('short', 'short')).toMatch(String(MIN_RESET_PASSWORD));
    expect(newPasswordProblem('long-enough-1', 'long-enough-2')).toMatch(/not the same/);
    expect(newPasswordProblem('long-enough-1', 'long-enough-1')).toBeNull();
  });

  it('shows the server\'s own sentence, and plain words for the network', () => {
    expect(resetErrorText({response: {status: 400, data: {error: 'code_invalid', message: 'That code is not right.'}}}))
      .toBe('That code is not right.');
    expect(resetErrorText({response: {status: 400, data: {message: ['newPassword must be longer than or equal to 10 characters']}}}))
      .toMatch(/at least 10/);
    expect(resetErrorText({response: {status: 429, data: {}}})).toMatch(/Too many/);
    expect(resetErrorText(new Error('Network Error'))).toMatch(/connection/);
  });
});
