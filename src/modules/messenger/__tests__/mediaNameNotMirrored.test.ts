/**
 * D8 (B-837) — `media_name` is a DERIVED search column and must stay invisible
 * to the backup module.
 *
 * Why: the mirror's `versionHash` is computed from the SERIALISER, not from the
 * table (`messageMirror.ts`), so adding a column to `messages` costs the backup
 * nothing — provided the column never enters `serializeMessagePayload`. The
 * moment it does, every stored row re-hashes, the next boot re-uploads the whole
 * history with fresh IVs, and that is the I1 drift factory that produced the
 * `root_mismatch` restore dead-end five times (B-45r3/B-50/B-67/B-81/B-94).
 *
 * The restore side needs no work either: it writes through `doUpsert`, which
 * re-derives the column from the restored `media_meta`.
 *
 * Shape notes (BACKUP_LOOP/MESSAGE_LOOP trap list):
 *  - LINE-based and split on `/\r?\n/` — these files are CRLF, so a `\n`-anchored
 *    regex over the whole buffer matches nothing and the scan passes VACUOUSLY.
 *  - Comments are stripped, because prose naming the banned token is the single
 *    most common false result in this repo.
 *  - A present-token self-check runs alongside, so a stripper that ate the whole
 *    file cannot report "clean".
 */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const BACKUP_DIR = join(process.cwd(), 'src', 'modules', 'messenger', 'backup');

/** The three files that decide what reaches the server and what comes back. */
const FILES = ['backupWireV3.ts', 'messageMirror.ts', 'restoreMessages.ts'] as const;

/**
 * Remove `//` and `/* *\/` comments, line by line. Conservative: a `//` inside a
 * string literal truncates the rest of that line, which can only make the scan
 * miss a token, never invent one — and the self-checks below make a wholesale
 * miss impossible.
 */
export function stripComments(src: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const rawLine of src.split(/\r?\n/)) {
    let line = rawLine;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) {out.push(''); continue;}
      line = line.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const start = line.indexOf('/*');
      if (start === -1) {break;}
      const end = line.indexOf('*/', start + 2);
      if (end === -1) {line = line.slice(0, start); inBlock = true; break;}
      line = line.slice(0, start) + line.slice(end + 2);
    }
    const lineComment = line.indexOf('//');
    out.push(lineComment === -1 ? line : line.slice(0, lineComment));
  }
  return out;
}

function codeLines(file: string): string[] {
  return stripComments(readFileSync(join(BACKUP_DIR, file), 'utf8'));
}

describe('D8 (B-837) — media_name never reaches the backup wire', () => {
  it.each(FILES)('%s does not mention media_name anywhere in its code', file => {
    const hits = codeLines(file)
      .map((line, i) => ({line, n: i + 1}))
      .filter(({line}) => /\bmedia_name\b/.test(line))
      .map(({line, n}) => `${file}:${n}: ${line.trim()}`);
    expect(hits).toEqual([]);
  });

  it('the scan is not vacuous — media_meta IS still carried by backupWireV3.ts', () => {
    // If this ever goes red the mirror stopped shipping media metadata, which
    // would break the restore of every attachment name — a different bug, but
    // one this file would otherwise hide by reporting "clean".
    expect(codeLines('backupWireV3.ts').some(l => /\bmedia_meta\b/.test(l))).toBe(true);
    expect(codeLines('restoreMessages.ts').some(l => /\bmedia_meta\b/.test(l))).toBe(true);
  });

  it('the scan is not vacuous — every scanned file still has substantial code after stripping', () => {
    for (const file of FILES) {
      expect(codeLines(file).filter(l => l.trim().length > 0).length).toBeGreaterThan(50);
    }
  });

  it('the stripper really removes comments, and really keeps code', () => {
    const sample = [
      '// media_name in a line comment',
      '/* media_name in a block comment */',
      '/**',
      ' * media_name in a doc block',
      ' */',
      'const media_name = 1;',
      'const other = 2; // media_name trailing',
    ].join('\r\n');
    const lines = stripComments(sample);
    const hits = lines.filter(l => /\bmedia_name\b/.test(l));
    expect(hits).toEqual(['const media_name = 1;']);
    expect(lines.some(l => l.includes('const other = 2;'))).toBe(true);
  });
});
