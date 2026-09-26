/**
 * B-838 — the IN-CHAT search sheet must find and show media too.
 *
 * The sheet built its preview from ONE source and dropped the row when that
 * came back null:
 *
 *     const snip = buildSnippet(m.content ?? '', chatSearchQuery.trim());
 *     if (!snip) {return null;}
 *
 * A PDF's name lives in `media_meta.name`, and its caption is usually empty —
 * so every document the store now returns was discarded here, one layer above
 * the SQL that found it. The fix routes the row through the SAME `toSearchHit`
 * the Channels box and the chat list use.
 *
 * `ChatScreen.tsx` mounts native modules and cannot be imported by a test, so
 * this is a source scan — which makes the two CLAUDE.md rules load-bearing:
 * never anchor on a bare `\n` (always `\r?\n`) and strip comments first
 * (prose naming the banned token is the classic false pass). Both are guarded
 * by the self-check below.
 *
 * The line-ending rule is about the ANCHOR, not about the file: `.gitattributes`
 * declares `* text=auto` with no `eol` override, so this file checks out CRLF on
 * Windows and LF on macOS and Linux. Either is correct.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const CHAT_SCREEN = join(process.cwd(), 'src', 'screens', 'messenger', 'ChatScreen.tsx');

/**
 * Line-based comment stripper — copied from `messengerRenderPerf.test.ts`,
 * where the naive `/\/\*[\s\S]*?\*\//g` was measured eating 64KB of this same
 * file because `/*` inside a string or JSX literal pairs with the wrong
 * delimiter. A block comment is recognised only when `/*` opens the line.
 */
function stripSourceComments(src: string): string {
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
    line = line.replace(/\{\s*\/\*.*?\*\/\s*\}/g, '');
    const open = line.indexOf('/*');
    if (open !== -1 && line.slice(0, open).trim() === '') {
      const end = line.indexOf('*/', open + 2);
      if (end === -1) {inBlock = true; out.push(line.slice(0, open)); continue;}
      line = line.slice(0, open) + line.slice(end + 2);
    }
    const lc = line.indexOf('//');
    if (lc !== -1 && !/https?:$/.test(line.slice(0, lc))) {line = line.slice(0, lc);}
    out.push(line);
  }
  return out.join('\n');
}

const raw = readFileSync(CHAT_SCREEN, 'utf8');
const src = stripSourceComments(raw);

/** The gated sheet only — the span between its own guard and the next sheet's. */
function searchSheet(): string {
  const open = src.indexOf('{chatSearchOpen && (');
  expect(open).toBeGreaterThan(-1);
  const close = src.indexOf('{forwardSource && (', open);
  expect(close).toBeGreaterThan(open);
  return src.slice(open, close);
}

describe('the scan itself is not vacuous', () => {
  it('the `\\r?\\n` anchor really matches, so the scans below are not vacuous', () => {
    // This assertion used to be `raw.includes('\r\n') || !raw.includes('\n')`
    // — "the file really is CRLF". Its own comment said "if this ever flips to
    // LF the test still holds", but the expression is FALSE for an LF file that
    // has newlines, so the code contradicted the comment: the suite could only
    // pass on Windows and was red on every mac and in CI (ubuntu-latest).
    //
    // `.gitattributes` declares `* text=auto` with no `eol` override, so this
    // file is CRLF on Windows and LF elsewhere — both correct. What the check
    // is actually for is non-vacuity: the anchor the scanners use (`/\r?\n/`,
    // in stripSourceComments above) must really split this file, or an
    // assertion below could pass by matching nothing at all.
    expect(raw).toMatch(/\r?\n/);
    expect(raw.split(/\r?\n/).length).toBeGreaterThan(100);
  });

  it('stripping comments does not swallow the code it is meant to keep', () => {
    expect(src.length).toBeGreaterThan(raw.length * 0.55);
    expect(src).toContain('const ChatComposer = React.memo(');
  });

  it('PRESENT-TOKEN SELF-CHECK: the slice is the search sheet and nothing else', () => {
    // Without this, a renamed guard would make `searchSheet()` return a wrong
    // (or empty) span and every assertion below would pass on nothing.
    const sheet = searchSheet();
    expect(sheet).toContain('testID={`chat-search-hit-${');
    expect(sheet).toContain('setSearchTarget({id: m.id})');
    expect(sheet).toContain('Search this chat');
    // …and it stops before the next sheet.
    expect(sheet).not.toContain('ForwardSheet');
  });
});

describe('B-838 — the in-chat sheet runs the shared two-source rule', () => {
  it('THE REGRESSION: the single-source `buildSnippet(m.content` drop is gone', () => {
    // This exact expression is what discarded every document hit. Asserted over
    // the WHOLE stripped file, not just the sheet, so it cannot come back under
    // a different guard.
    expect(src).not.toContain('buildSnippet(m.content');
  });

  it('the sheet asks `toSearchHit` for the row instead', () => {
    expect(searchSheet()).toContain('toSearchHit(m, ');
  });

  it('and imports it from the ONE module that owns the rule', () => {
    expect(src).toMatch(/import \{[^}]*\btoSearchHit\b[^}]*\} from '@screens\/deptchat\/channelMessageSearch'/);
  });
});

describe('B-838 — a media hit LOOKS like media in the sheet', () => {
  it('draws the kind glyph from the shared mapping', () => {
    // Deleting this branch is the mutation that must turn this suite red: a
    // document hit would render as a bare text line again ("user should see
    // the docs also").
    expect(searchSheet()).toContain('mediaKindIcon(');
  });

  it('draws the sender thumbnail when the row carries one', () => {
    expect(searchSheet()).toContain('data:image/jpeg;base64,');
  });

  it('titles the row with the file name', () => {
    expect(searchSheet()).toContain('hit.fileName');
  });

  it('the tap still only sets the jump target — no new navigation was invented', () => {
    const sheet = searchSheet();
    expect(sheet).toContain('focusConsumedRef.current = null;');
    expect(sheet).toContain('closeChatSearch();');
  });
});
