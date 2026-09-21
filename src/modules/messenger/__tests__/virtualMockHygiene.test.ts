/**
 * B-719 — `{virtual: true}` may only name a module that does NOT exist.
 *
 * THE MECHANISM (verified in node_modules, not inferred):
 * `jest-resolve`'s `getModuleID` builds its cache key as
 * `from + delimiter + moduleName + stringifiedOptions` and **omits the
 * `virtualMocks` map entirely** (`jest-resolve/build/resolver.js`). The Resolver
 * outlives the test file — one instance per project per worker
 * (`jest-runner/build/testWorker.js`) — so the FIRST suite in a worker to
 * resolve a given `(from, moduleName)` pair *without* a virtual mock registered
 * permanently memoises the real path. Every later suite that registers
 * `{virtual: true}` for that pair is then silently ignored and gets the REAL
 * module.
 *
 * That is order-dependent, cross-file, and invisible in isolation — which is
 * exactly the "moving flake" shape sqa.md has carried since B-126: a random
 * suite fails ~half of full runs and passes on its own. B-161 killed four
 * instances; this pin stops the class coming back.
 *
 * A virtual mock of a module that EXISTS is never necessary: a NON-virtual mock
 * is keyed by the RESOLVED PATH, so it applies no matter which specifier the
 * consumer used to reach the same file (`../runtime/callRegistry` from a test
 * and `./callRegistry` from its sibling land on one id). The flag is only for
 * modules with no file behind them.
 *
 * IF THIS TEST FAILS: do not add the path to the allowlist to make it green.
 * Delete the `{virtual: true}` instead, and — if the mock was written against a
 * consumer-relative specifier — re-point it at the path that resolves from the
 * TEST file. Both mocks then share one module id, which is the whole point.
 */
import {readFileSync, statSync} from 'node:fs';
import {execSync} from 'node:child_process';
import {join, resolve, dirname} from 'node:path';

const ROOT = process.cwd();

/** Path aliases, mirroring the jest `moduleNameMapper` / babel module-resolver. */
const ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['@bravo/messenger-core', 'packages/messenger-core/src'],
  ['@services',    'src/services'],
  ['@utils',       'src/utils'],
  ['@theme',       'src/theme'],
  ['@components',  'src/components'],
  ['@screens',     'src/screens'],
  ['@navigation',  'src/navigation'],
  ['@store',       'src/store'],
  ['@hooks',       'src/hooks'],
  ['@modules',     'src/modules'],
  ['@assets',      'src/assets'],
  ['@',            'src'],
];
const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.json', '/index.ts', '/index.tsx', '/index.js'];
const isFile = (b: string): boolean =>
  EXTS.some(e => { try { return statSync(b + e).isFile(); } catch { return false; } });

/**
 * Sites that legitimately name a module with no file behind it.
 * Every entry needs a reason. This list should shrink, never grow.
 */
const ALLOWED = new Set<string>([
  // B-153 — `babel-preset-expo` rewrites EXPO_PUBLIC_* into an import of this
  // synthetic specifier. There is no such file; the project maps it to a stub.
  'expo/virtual/env',
  // Asset requires. `bravoTones`/`messageToneGuards` mock these as the CONSUMER
  // spells them, and a .wav has no resolvable JS module behind it either way.
  '../../../../assets/ringback.wav',
  '../../../../assets/ringtone.wav',
  '../../../../assets/message.wav',
]);

function resolves(spec: string, fromFile: string): boolean {
  if (spec.startsWith('.')) { return isFile(resolve(dirname(fromFile), spec)); }
  for (const [alias, real] of ALIASES) {
    if (spec === alias || spec.startsWith(alias + '/')) {
      const rest = spec === alias ? '' : spec.slice(alias.length);
      if (isFile(join(ROOT, real + rest))) { return true; }
    }
  }
  const pkg = join(ROOT, 'node_modules', spec);
  try { if (statSync(pkg).isDirectory()) { return true; } } catch { /* not a dir */ }
  return isFile(pkg);
}

describe('B-719 — no `{virtual: true}` mock of a module that exists', () => {
  it('every virtual mock names a genuinely absent module', () => {
    const files = execSync('git ls-files "src/**/*.test.ts" "src/**/*.test.tsx"', {encoding: 'utf8'})
      .trim().split('\n').filter(Boolean);

    const offenders: string[] = [];
    for (const rel of files) {
      const abs = join(ROOT, rel);
      const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!line.includes('virtual: true')) { return; }
        // Prose naming the flag is not a call site — this repo documents it a
        // lot, and matching comments is the classic false result for a scan.
        const t = line.trimStart();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) { return; }
        // The specifier may sit on this line or on an earlier `jest.mock(` line.
        let spec: string | null = null;
        for (let k = i; k >= Math.max(0, i - 25); k--) {
          const m = lines[k].match(/jest\.(?:doMock|mock)\(\s*['"]([^'"]+)['"]/);
          if (m) { spec = m[1]; break; }
        }
        if (!spec || ALLOWED.has(spec)) { return; }
        if (resolves(spec, abs)) { offenders.push(`${rel}:${i + 1}  ${spec}`); }
      });
    }

    expect(offenders).toEqual([]);
  });
});
