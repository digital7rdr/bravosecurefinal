/**
 * Share sheet keyboard pin (founder reports 2026-08-26 and 2026-09-07, B-815).
 *
 * 2026-08-26: "When I want to type something to search, it covers the search
 * bar, then I cannot read what I am typing." — the sheet reacted to nothing.
 * The first fix lifted it by `marginBottom: overlap` and stopped there.
 *
 * 2026-09-07: "The keyboard is in the way of sharing for contacts." — the lift
 * alone kept the sheet's 72% cap, so with the IME up the sheet ran off the TOP
 * of the screen (the "Share outside Bravo" row cut off) while the workspace
 * block, a FIXED header above the list, still ate the visible height and the
 * INDIVIDUALS rows sat under the keyboard.
 *
 * The rule (CLAUDE.md § "Keyboard / focused input"): the bottom-most element
 * of a surface OWNS the keyboard inset and pads by `bottomPad(gap)`; with the
 * IME up the sheet is bounded by the space ABOVE it; and the header rows scroll
 * WITH the picker (a `header` inside `ForwardList`'s FlatList) so the list can
 * shrink to whatever is left. The repo-wide bans are enforced by
 * `keyboardContract.test.ts`; this pins the positive shape at the decision site.
 *
 * Source scan rather than a render test: the sheet pulls in `ForwardList` from
 * ChatScreen and the messenger runtime, which the app project cannot mount
 * cheaply. Comments stripped, CRLF normalised, anchored on the SITE.
 */
import fs from 'fs';
import path from 'path';

const SHEET = path.resolve(__dirname, '..', 'ShareNewsSheet.tsx');
const CHAT = path.resolve(__dirname, '..', '..', '..', 'screens', 'messenger', 'ChatScreen.tsx');

/** Strip comments — prose naming a banned token is the classic false result. */
function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('ShareNewsSheet — the keyboard must not cover the search field or the contacts', () => {
  const src = code(SHEET);

  it('reads the app-wide keyboard rule (overlap AND bottomPad)', () => {
    expect(src).toMatch(/useKeyboardLayout\s*\}?\s*from\s*'@hooks\/useKeyboardLayout'/);
    expect(src).toMatch(/const\s*\{\s*overlap\s*,\s*bottomPad\s*\}\s*=\s*useKeyboardLayout\(\)/);
  });

  it('the sheet PADS by bottomPad — it owns the inset; no marginBottom lift, no static bottom pad', () => {
    const sheetStyle = src.match(/style=\{\[\s*s\.sheet\b[\s\S]{0,260}?\]\}/)?.[0] ?? '';
    expect(sheetStyle).toMatch(/paddingBottom:\s*bottomPad\(\d+\)/);
    expect(sheetStyle).not.toMatch(/marginBottom/);
    // The static style must not ALSO carry a bottom pad, or the two stack.
    const sheetDecl = src.match(/\n\s*sheet:\s*\{[^}]*\}/)?.[0] ?? '';
    expect(sheetDecl).not.toMatch(/paddingBottom/);
  });

  it('with the IME up the sheet is BOUNDED by the space above the keyboard', () => {
    const sheetStyle = src.match(/style=\{\[\s*s\.sheet\b[\s\S]{0,260}?\]\}/)?.[0] ?? '';
    expect(sheetStyle).toMatch(/overlap\s*>\s*0\s*&&\s*\{\s*maxHeight:\s*winH\s*-\s*insets\.top\s*-\s*\d+\s*\}/);
    expect(src).toMatch(/const\s*\{\s*height:\s*winH\s*\}\s*=\s*useWindowDimensions\(\)/);
  });

  it('the outside-share row and the workspace list ride INSIDE the picker as its header', () => {
    // A fixed block above the list is the bug: it cannot shrink, so the
    // bounded sheet leaves no room for a single contact row.
    const picker = src.match(/<ForwardList currentConvId="" onPick=[\s\S]*?\n\s*\/>/)?.[0] ?? '';
    expect(picker).toMatch(/listMaxHeight=\{null\}/);
    expect(picker).toMatch(/header=\{/);
    expect(picker).toMatch(/accessibilityLabel="Share outside Bravo"/);
    expect(picker).toMatch(/<ShareWorkspaceList/);
  });

  it('does not hand-roll keyboard avoidance', () => {
    // Same bans as keyboardContract, asserted at this surface so a local
    // "quick fix" cannot reintroduce them here.
    expect(src).not.toMatch(/KeyboardAvoidingView/);
    expect(src).not.toMatch(/keyboardVerticalOffset/);
    expect(src).not.toMatch(/Keyboard\.addListener/);
  });
});

describe('ForwardList — the picker can shrink to the bounded sheet', () => {
  const src = code(CHAT);
  const start = src.indexOf('export function ForwardList(');
  const body = src.slice(start, src.indexOf('\nexport {previewForReply};', start));

  it('CONTROL: the picker body was located', () => {
    expect(start).toBeGreaterThan(-1);
    expect(body.length).toBeGreaterThan(500);
  });

  it('the wrapper and the FlatList carry flexShrink, and the cap is a prop the host can drop', () => {
    expect(body).toMatch(/return \(\s*<View style=\{\{flexShrink: 1, minHeight: 0\}\}>/);
    expect(body).toMatch(/style=\{\[\{flexShrink: 1\}, listMaxHeight !== null && \{maxHeight: listMaxHeight\}\]\}/);
    expect(body).not.toMatch(/style=\{\{maxHeight: 360\}\}/);
  });

  it('the header scrolls with the list and hides while a query is active', () => {
    expect(body).toMatch(/ListHeaderComponent=\{q \? null : header\}/);
  });

  it('with a header, an empty picker still renders the header (the empty copy moves into the list)', () => {
    expect(body).toMatch(/if \(nothingToPick && !header\) \{/);
    expect(body).toMatch(/\) : nothingToPick \? \(/);
  });

  it('the chat forward sheet owns its inset the same way', () => {
    const sheet = src.slice(src.indexOf('function ForwardSheet('), start);
    expect(sheet).toMatch(/const \{overlap, bottomPad\} = useKeyboardLayout\(\);/);
    expect(sheet).toMatch(/paddingBottom: bottomPad\(\d+\)/);
    expect(sheet).toMatch(/overlap > 0 \? \{maxHeight: winH - insets\.top - \d+\} : \{maxHeight: '70%'\}/);
    // B-825 added the chat sheet's own "Share outside Bravo" header row; what
    // this pin protects is the UNCAPPED list (the host bounds the sheet), so it
    // matches on that VALUE and still refuses a re-introduced static cap.
    expect(sheet).toMatch(/<ForwardList currentConvId=\{currentConvId\} onPick=\{onPick\}[^\n]*listMaxHeight=\{null\} \/>/);
    expect(sheet).not.toMatch(/listMaxHeight=\{\d+\}/);
  });
});
