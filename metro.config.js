/**
 * Metro bundler config — customizes the Expo default.
 *
 * Why this exists: packages with separate Node/browser builds via
 * conditional exports (historically `jose`, which senderCert used before
 * it moved to AsyncCurve25519 in messenger-core — AUDIT-2026-08-13 #7
 * note: src/modules/messenger/crypto/senderCert.ts is now a tombstone
 * re-export and NO RN-bundled source imports `jose` today) would resolve
 * to the Node build, which imports `node:buffer` and crashes the RN
 * bundler. Do NOT remove the resolver override on the strength of the
 * jose example being stale — other transitive packages rely on the
 * browser-condition resolution now.
 *
 * Flipping on `unstable_enablePackageExports` + setting the condition
 * priority to `['react-native', 'browser', ...]` forces jose (and any
 * other package with similar exports) to resolve to the browser-safe
 * path that uses standard `Uint8Array` + WebCrypto.
 */

const {getDefaultConfig} = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver = {
  ...config.resolver,
  unstable_enablePackageExports: true,
  unstable_conditionNames: ['react-native', 'browser', 'require'],
};

// Opt-in worker bound (2026-09-05). Metro defaults `maxWorkers` to the CPU
// count; on a 16-core, 16 GB build machine a COLD release bundle
// (`:app:createBundleReleaseJsAndAssets`) therefore spawns 16 transform
// workers next to the 4 GB Gradle daemon, and the OS killed the release build
// twice at exactly that step. Same idea as `org.gradle.workers.max=3` in
// android/gradle.properties. Unset → Metro's default, so dev-server behaviour
// is unchanged for everyone else.
//   METRO_MAX_WORKERS=4 npm run release
const maxWorkers = Number(process.env.METRO_MAX_WORKERS);
if (Number.isInteger(maxWorkers) && maxWorkers > 0) {
  config.maxWorkers = maxWorkers;
}

module.exports = config;
