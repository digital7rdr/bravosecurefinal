import type { NextConfig } from 'next';
import { REDIRECTS } from './src/lib/routes';

/** Host names served as the provider console or the Bravo Web App
 *  (see src/lib/provider/host.ts): neither uses the ops legacy redirects. */
const PROVIDER_HOST_PATTERN = '(?:provider|web)\\..*';

// Audit fix 0.6 — security headers (CSP w/ per-request nonce, HSTS,
// X-Frame-Options, Referrer-Policy, Permissions-Policy) now live in
// src/middleware.ts so the CSP nonce can vary per response. Keep
// next.config focused on build/runtime config only.

const nextConfig: NextConfig = {
  /**
   * 2026-09-03 IA restructure — every pre-restructure URL keeps working.
   *
   * The console's routes were re-grouped by business (Lite / Executive /
   * Secure Pro / Enterprise / People / App Configuration / Finance / Safety /
   * Internal). Operators have these paths bookmarked, notification emails and
   * audit rows point at them, and the mobile app's deep links use them — so
   * every old path is a PERMANENT redirect rather than a 404.
   *
   * The list lives in src/lib/routes.ts so the pin suite can assert every
   * destination is a real route; this function only shapes it for Next.
   */
  //
  // The legacy paths belong to the ops console only. On the service provider
  // host (provider.*) "/jobs" is the provider's own Jobs page, and a redirect
  // runs before the middleware could route it, so it is skipped there. The
  // same holds for the Bravo Web App host (web.*, "/bookings").
  async redirects() {
    return REDIRECTS.map(r => ({
      ...r,
      permanent: true,
      missing: [{type: 'host' as const, value: PROVIDER_HOST_PATTERN}],
    }));
  },
  reactStrictMode: true,
  output: 'standalone',
  // Audit CFG-04 — don't advertise the framework on a sensitive admin panel.
  poweredByHeader: false,
  transpilePackages: ['@bravo/messenger-core'],
  // P0-W2: previously `eslint.ignoreDuringBuilds: true` and
  // `typescript.ignoreBuildErrors: true` shipped every compile/lint
  // failure to prod. The fix in this commit (target bump ES2017→ES2020
  // in tsconfig.json) cleared the live errors; flipping these to false
  // makes a broken build fail fast rather than ship.
  eslint: { ignoreDuringBuilds: false },
  typescript: { ignoreBuildErrors: false },
  // Dead-code elimination: strip console.* from production bundles —
  // debug logging in an ops console can leak mission/PII payloads to the
  // browser console of any shared screen. error/warn stay for triage.
  // (Tree shaking itself — usedExports + terser — is on by default in
  // production webpack builds; `"sideEffects": ["**/*.css"]` in
  // package.json is what lets it prune unused re-exports from app code.)
  compiler: {
    removeConsole: { exclude: ['error', 'warn'] },
  },
  webpack(config) {
    // libsignal-protocol-typescript bundles curve25519-typescript which
    // touches node's `fs` for its WASM loader. In the browser there is
    // no `fs`, so we tell webpack to substitute an empty module — the
    // lib has a browser fallback path that uses fetch() instead.
    config.resolve = config.resolve ?? {};
    config.resolve.fallback = {
      ...(config.resolve.fallback ?? {}),
      fs: false,
      path: false,
      crypto: false,
    };
    return config;
  },
};

export default nextConfig;
