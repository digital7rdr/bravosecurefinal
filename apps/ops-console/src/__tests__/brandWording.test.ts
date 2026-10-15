import {readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import * as ts from 'typescript';

/**
 * Brand wording (founder, 2026-10-15): "The word 'security' must be removed as
 * descriptive word in all screens on mob app and console. Bravo must position
 * itself as an enterprise secure solution — comms, movement, management and
 * processes."
 *
 * A source scan over every STRING the mobile app and the consoles can render
 * (string literals, template text, JSX text), so a new screen cannot bring the
 * word back unnoticed. Comments and identifiers are not text anyone sees and
 * are ignored. "Secure" / "Bravo Secure" are the brand and are fine.
 *
 * The allow-list is for strings no person reads as copy — wire keys, API
 * paths, HTTP headers, database pragmas, news-search query terms — plus two
 * proper names: the UK regulator ("Security Industry Authority") and the
 * QHSSE department from the owner's own ISO 9001 deck.
 */
const ROOT = process.cwd();
const TREES = ['src', join('apps', 'ops-console', 'src')];

const ALLOWED: RegExp[] = [
  /^PRAGMA cipher_memory_security=ON$/,
  /^security$/i,                        // the news category / profile-menu wire id
  /^(event_security|security_concern)$/, // service and incident wire keys
  /^cybersecurity$/,                    // news-search query term
  /^security OR intelligence OR terror OR cyber$/, // news-search query
  /^UK Security Industry Authority$/,   // the regulator's proper name
  /^Quality, Health, Safety, Security, Environment$/, // QHSSE, from the owner's ISO deck
  /^(Content-Security-Policy|Strict-Transport-Security)$/,
  /^\/hub\/security\/totp\/(start|confirm)$/,
  /^\/security$/,                       // the home site's route path
  /^\.\.\/assets\/imagery\/vbgSecurityRisk\.jpg$/,
];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, {withFileTypes: true})) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!/^(node_modules|__tests__|\.next)$/.test(e.name)) {out.push(...files(p));}
    } else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

function offences(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  if (!/security/i.test(src)) {return [];}
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    let text: string | null = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
        || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      text = n.text;
    } else if (ts.isJsxText(n)) {
      text = n.text;
    }
    if (text && /security/i.test(text)) {
      const t = text.replace(/\s+/g, ' ').trim();
      const parent = n.parent;
      const isImport = !!parent && (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent));
      if (!isImport && !ALLOWED.some(a => a.test(t))) {
        const {line} = sf.getLineAndCharacterOfPosition(n.getStart());
        found.push(`${relative(ROOT, file)}:${line + 1} "${t.slice(0, 90)}"`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe('brand wording — "security" is not a descriptor on any screen', () => {
  it('no rendered string in the app or the consoles uses the word', () => {
    const all = TREES.flatMap(t => files(join(ROOT, t))).flatMap(offences);
    expect(all).toEqual([]);
  });

  it('the scan is live: it would catch the old tagline', () => {
    expect(files(join(ROOT, 'src')).length).toBeGreaterThan(100);
    expect(ALLOWED.some(a => a.test('ENTERPRISE SECURITY PLATFORM'))).toBe(false);
  });
});
