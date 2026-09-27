/**
 * Resolve a file from the Expo-generated `android/` tree for a source-scanning
 * test, falling back to the TRACKED copy under `native/android/` when the
 * generated tree is absent.
 *
 * WHY: `android/` is gitignored and only exists after `expo prebuild`, so a
 * fresh clone (GitHub Actions) has none of it and every scanner that reads it
 * died with ENOENT. `native/android/` is the checked-in source of truth for the
 * hand-written Kotlin and a snapshot of the manifest (see its README); on
 * 2026-09-27 all 21 files were verified byte-identical to the generated copies.
 *
 * Locally the GENERATED file still wins — that is what actually gets built, so
 * a drift between the two copies shows up on the developer's machine. A path
 * with no tracked copy is returned unchanged, so the caller's read still fails
 * loudly instead of skipping.
 */
import {existsSync} from 'node:fs';
import {join} from 'node:path';

const MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const APP_PKG = 'android/app/src/main/java/com/bravosecure/app/';

export function androidSourcePath(repoRoot: string, rel: string): string {
  const generated = join(repoRoot, ...rel.split('/'));
  if (existsSync(generated)) {return generated;}
  if (rel === MANIFEST) {return join(repoRoot, 'native', 'android', 'AndroidManifest.reference.xml');}
  if (rel.startsWith(APP_PKG)) {
    return join(repoRoot, 'native', 'android', 'com', 'bravosecure', 'app', ...rel.slice(APP_PKG.length).split('/'));
  }
  return generated;
}
