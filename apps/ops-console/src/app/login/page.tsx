'use client';

import {authApi, deviceId} from '@/lib/api';
import {SignInFlow} from '@/components/SignInFlow';

const api = {
  loginStart: authApi.loginStart,
  loginVerify: (userId: string, code: string, challengeId?: string | null) =>
    authApi.loginVerify(userId, code, deviceId(), challengeId),
};

export default function LoginPage() {
  return (
    <SignInFlow
      api={api}
      csrfCookie="bravo_ops_csrf"
      expiresKey="bravo_ops_access_expires_at"
      idleKey="bravo_ops_idle_logout"
      homeHref="/"
      accountNoun="operator"
    />
  );
}
