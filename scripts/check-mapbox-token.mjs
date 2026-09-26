#!/usr/bin/env node
/**
 * check-mapbox-token.mjs — release-build preflight (2026-09-27).
 *
 * WHY: EXPO_PUBLIC_MAPBOX_TOKEN used to be written inline in package.json,
 * eas.json, .env.production and build-user-apk.ps1. GitHub push protection
 * rejects Mapbox tokens, so it was purged from git history and now lives ONLY
 * in the gitignored .env.production.local (loaded by @expo/env during
 * `expo export:embed` with higher precedence than .env.production) or in the
 * process env / an EAS environment variable.
 *
 * A build that never receives the token does not fail — mapToken.ts logs one
 * line at bundle time and every map surface renders the "misconfigured build"
 * state (B-89 MG-04). That is exactly the silent failure a preflight exists to
 * prevent, so the apk:* scripts and build-user-apk.ps1 run this first.
 *
 * Never prints the token. Exit 0 = present and pk.-prefixed, 1 = missing.
 */
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const ROOT = process.cwd();
// Same precedence @expo/env applies for NODE_ENV=production; .env.production
// itself is intentionally NOT consulted — the token must never be there.
const FILES = ['.env.production.local', '.env.local'];

function fromFile(name) {
  const p = resolve(ROOT, name);
  if (!existsSync(p)) {return undefined;}
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?EXPO_PUBLIC_MAPBOX_TOKEN\s*=\s*(.*?)\s*$/);
    if (m) {return m[1].replace(/^(['"])(.*)\1$/, '$2');}
  }
  return undefined;
}

let source = 'process.env';
let token = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
if (!token) {
  for (const f of FILES) {
    token = fromFile(f);
    if (token) {source = f; break;}
  }
}

if (!token || !token.startsWith('pk.')) {
  console.error(
    '[check-mapbox-token] EXPO_PUBLIC_MAPBOX_TOKEN is missing or not a pk. token.\n' +
    '  Put the Mapbox PUBLIC token in .env.production.local at the repo root:\n' +
    '      EXPO_PUBLIC_MAPBOX_TOKEN=pk.…\n' +
    '  (gitignored — never add it to .env.production, eas.json or package.json).\n' +
    '  See docs/runbooks/MOBILE_BUILD_ENV.md.',
  );
  process.exit(1);
}
console.log(`[check-mapbox-token] EXPO_PUBLIC_MAPBOX_TOKEN present (from ${source}, …${token.slice(-4)})`);
