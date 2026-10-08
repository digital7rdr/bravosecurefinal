#!/usr/bin/env node
/**
 * check-release-env.mjs — production release preflight (2026-10-08).
 *
 * Runs before `apk:release:*` / `aab:release:mac`. Resolves every
 * EXPO_PUBLIC_* value the way @expo/env does for NODE_ENV=production
 * (process.env › .env.production.local › .env.local › .env.production) and
 * refuses to build when:
 *   - EXPO_PUBLIC_MAPBOX_TOKEN is missing / not pk.   (maps render "misconfigured")
 *   - EXPO_PUBLIC_API_BASE_URL / _MSG_BASE_URL / _SUPABASE_URL are not the
 *     bravosecure.cloud production hosts                (APK would talk to staging)
 *   - EXPO_PUBLIC_SUPABASE_ANON_KEY is missing / not a JWT (avatar, SOS, FCM
 *     bootstrap and activity sync fail at runtime)
 *   - EXPO_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64 is missing (the bundle would pin
 *     the DEV sender-cert key — every messenger sender cert would fail to
 *     verify against the production auth-service)
 * Warns (does not fail) when BRAVO_UPLOAD_STORE_FILE is unset: the APK is then
 * debug-signed, fine for direct install / QA, NOT for Play.
 *
 * Never prints a value in full. Exit 0 = ready, 1 = fix the listed items.
 */
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const ROOT = process.cwd();
const FILES = ['.env.production.local', '.env.local', '.env.production'];

function parse(name) {
  const p = resolve(ROOT, name);
  if (!existsSync(p)) {return {};}
  const out = {};
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) {out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');}
  }
  return out;
}
const files = Object.fromEntries(FILES.map(f => [f, parse(f)]));
function get(key) {
  if (process.env[key]) {return {value: process.env[key], source: 'process.env'};}
  for (const f of FILES) {if (files[f][key]) {return {value: files[f][key], source: f};}}
  return {value: undefined, source: null};
}
const tail = v => (v ? `…${v.slice(-4)}` : '(unset)');

const EXPECT = {
  EXPO_PUBLIC_API_BASE_URL: 'https://auth.bravosecure.cloud',
  EXPO_PUBLIC_MSG_BASE_URL: 'https://relay.bravosecure.cloud',
  EXPO_PUBLIC_SUPABASE_URL: 'https://api.bravosecure.cloud',
};

const problems = [];
for (const [k, want] of Object.entries(EXPECT)) {
  const {value, source} = get(k);
  if (value !== want) {problems.push(`${k} = ${value ?? '(unset)'} (from ${source ?? 'nowhere'}) — expected ${want}`);}
  else {console.log(`[check-release-env] ${k} ok (${source})`);}
}
const mapbox = get('EXPO_PUBLIC_MAPBOX_TOKEN');
if (!mapbox.value || !mapbox.value.startsWith('pk.')) {problems.push('EXPO_PUBLIC_MAPBOX_TOKEN missing or not a pk. token → .env.production.local (docs/runbooks/MOBILE_BUILD_ENV.md)');}
else {console.log(`[check-release-env] EXPO_PUBLIC_MAPBOX_TOKEN ok (${mapbox.source}, ${tail(mapbox.value)})`);}
const anon = get('EXPO_PUBLIC_SUPABASE_ANON_KEY');
if (!anon.value || !anon.value.startsWith('eyJ')) {problems.push('EXPO_PUBLIC_SUPABASE_ANON_KEY missing or not a JWT → copy ANON_KEY from the VPS (/opt/supabase/.env, printed by deploy/production/make-env.sh) into .env.production.local');}
else {console.log(`[check-release-env] EXPO_PUBLIC_SUPABASE_ANON_KEY ok (${anon.source}, ${tail(anon.value)})`);}
const cert = get('EXPO_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64');
if (!cert.value || !/^[A-Za-z0-9+/]{43}=$/.test(cert.value)) {problems.push('EXPO_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64 missing or not a 32-byte base64 key → value printed by deploy/production/make-env.sh (NEXT_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64 is the same key) into .env.production.local');}
else {console.log(`[check-release-env] EXPO_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64 ok (${cert.source}, ${tail(cert.value)})`);}

if (!process.env.BRAVO_UPLOAD_STORE_FILE && !parse('android/gradle.properties').BRAVO_UPLOAD_STORE_FILE) {
  console.warn('[check-release-env] WARNING: BRAVO_UPLOAD_STORE_FILE not set — the APK will be DEBUG-SIGNED (direct install / QA only, not Play). See docs/runbooks/ANDROID_RELEASE.md §3.');
}

if (problems.length) {
  console.error('\n[check-release-env] NOT ready for a production build:');
  for (const p of problems) {console.error('  - ' + p);}
  console.error('\n  Fix in .env.production.local (gitignored). See docs/runbooks/ANDROID_RELEASE.md.');
  process.exit(1);
}
console.log('[check-release-env] ready for a production build.');
