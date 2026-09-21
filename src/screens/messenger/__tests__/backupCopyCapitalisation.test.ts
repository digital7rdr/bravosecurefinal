/**
 * B-827 — founder screenshot 2026-09-08: the Restore screen opened a sentence
 * with a lowercase "argon2id". Only the first word is capitalised (the KDF is
 * still spelled argon2id everywhere it names the algorithm in code), and the
 * Setup screen carries the same sentence, so both must match.
 *
 * Source scan — these two screens mount RN trees, and the assertion is about
 * the literal shipped to the user. Comments are stripped first (this file's own
 * prose names both spellings) and the files are CRLF, so they are normalised.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const FILES = [
  join(ROOT, 'src', 'screens', 'messenger', 'BackupRestoreScreen.tsx'),
  join(ROOT, 'src', 'screens', 'messenger', 'BackupSetupScreen.tsx'),
];

/** Code only — comments stripped line-wise, CRLF-normalised. */
function code(p: string): string {
  const src = readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) {inBlock = false;}
      continue;
    }
    if (t.startsWith('/*') || t.startsWith('{/*')) {
      if (!t.includes('*/')) {inBlock = true;}
      continue;
    }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

describe('B-827 — the backup bullet opens with a capitalised Argon2id', () => {
  it('the scan reads real code', () => {
    for (const p of FILES) {
      const src = code(p);
      expect(src.length).toBeGreaterThan(2_000);
      expect(src).not.toContain('\r');
      expect(src).toContain('bulletTxt');
    }
  });

  it('both screens say "Argon2id key derivation", neither ships the lowercase word', () => {
    for (const p of FILES) {
      const src = code(p);
      expect(src).toContain('Argon2id key derivation');
      expect(src).not.toContain('>argon2id');
    }
  });
});
