'use client';

import Link from 'next/link';
import {SignInFlow} from '@/components/SignInFlow';
import {HUB_BRAND} from '@/lib/hub/brand';
import {hubAuth, HUB_CSRF_COOKIE, HUB_EXPIRES_KEY, HUB_IDLE_KEY} from '@/lib/hub/api';
import {hubRoutes} from '@/lib/hub/routes';


const api = {loginStart: hubAuth.loginStart, loginVerify: hubAuth.loginVerify};

export default function HubLoginPage() {
  return (
    <SignInFlow
      api={api}
      csrfCookie={HUB_CSRF_COOKIE}
      expiresKey={HUB_EXPIRES_KEY}
      idleKey={HUB_IDLE_KEY}
      homeHref={hubRoutes.home}
      accountNoun="Bravo Secure"
      brand={HUB_BRAND}
      footer={
        <p className="auth-hint" style={{textAlign: 'center', margin: '4px 0 0'}}>
          New to Bravo Secure? <Link href={hubRoutes.register} style={{color: 'var(--glow)', fontWeight: 600}}>Create an account</Link>
        </p>
      }
    />
  );
}
