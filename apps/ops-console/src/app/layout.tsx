import type { Metadata } from 'next';
import { headers } from 'next/headers';
// Brand typefaces, self-hosted from node_modules (OFL). They used to come from
// Google Fonts at runtime; a blocked or slow fetch dropped the console onto
// system fonts, and an ops console should not call a third party on load.
import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import '@fontsource/manrope/800.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/jetbrains-mono/800.css';
import './globals.css';
import {MessengerProvider} from '@/components/messenger/MessengerProvider';
import {SwrProvider} from '@/components/SwrProvider';
import {ToastProvider} from '@/components/Toast';

export const metadata: Metadata = {
  title: 'Bravo Ops Console',
  description: 'Bravo Secure — HQ Operations Command Center',
  // Why: the brand icons shipped in public/ were never referenced, so the
  // console rendered with the default Next.js favicon. These are the
  // original Bravo assets, matching bravo-secure.com.
  icons: {
    icon: [
      {url: '/favicon-32.png',  sizes: '32x32',   type: 'image/png'},
      {url: '/favicon-192.png', sizes: '192x192', type: 'image/png'},
      {url: '/bravo-mark.svg',  type: 'image/svg+xml'},
    ],
    apple: [{url: '/apple-touch-icon.png', sizes: '180x180'}],
  },
};

// Why: P0-W1. Reading the per-request `x-nonce` here forces this layout
// to render dynamically (no static caching of the wrong nonce) AND Next.js
// uses the header to stamp its framework <script> tags with `nonce=...`,
// which lets middleware drop `'unsafe-inline'` from `script-src`.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? '';
  return (
    <html lang="en">
      <body data-csp-nonce={nonce}>
        {/* OP-11/OP-12 — one SWRConfig for the whole console; OP-17 — one
            toast stack. MessengerProvider stays a static, SSR-able wrapper:
            the libsignal/socket.io/idb runtime behind it is now a dynamic
            import that loads on vault unlock, not on route load (OP-18). */}
        <SwrProvider>
          <ToastProvider>
            <MessengerProvider>{children}</MessengerProvider>
          </ToastProvider>
        </SwrProvider>
      </body>
    </html>
  );
}
