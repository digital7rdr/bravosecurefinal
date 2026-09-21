/**
 * B-825 — the DOORS to "Share outside Bravo", pinned at the decision site.
 *
 * A source scan rather than a render test: `ChatScreen.tsx` pulls the whole
 * messenger runtime and `FileViewer.tsx` pulls expo-video / expo-audio, and
 * neither can be mounted cheaply here (the same reason the news share-sheet
 * pins in `src/modules/news/__tests__` are scans). CLAUDE.md's scan rules
 * apply: comments stripped first (prose containing the banned word is the
 * classic false result), CRLF normalised, and every assertion anchored INSIDE
 * the block it means to describe — asserting a token exists "somewhere in the
 * file" is how a deleted param kept passing.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function code(rel: string): string {
  const src = readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

const CHAT = code('src/screens/messenger/ChatScreen.tsx');
const VIEWER = code('src/modules/messenger/ui/FileViewer.tsx');

/** The long-press action sheet, from its Modal to its own Cancel row. */
const sheetStart = CHAT.indexOf('<Modal visible={!!actionMsg}');
const ACTION_SHEET = CHAT.slice(sheetStart, CHAT.indexOf('styles.sheetCancel', sheetStart));

describe('T3 — the long-press action sheet offers Share outside Bravo, guarded by the ONE predicate', () => {
  it('CONTROL: the action-sheet block was located and holds the neighbouring rows', () => {
    expect(sheetStart).toBeGreaterThan(-1);
    expect(ACTION_SHEET).toContain('Forward');
    expect(ACTION_SHEET).toContain('Delete for me');
  });

  it('the row is INSIDE a canShareOutside(actionMsg) guard — not rendered for text or a voice note', () => {
    const guarded = ACTION_SHEET.match(
      /\{canShareOutside\(actionMsg\) && \([\s\S]{0,700}?<\/TouchableOpacity>\s*\)\}/,
    )?.[0] ?? '';
    expect(guarded).toMatch(/testID="chat-share-outside"/);
    expect(guarded).toMatch(/accessibilityLabel="Share outside Bravo"/);
    expect(guarded).toMatch(/<Text style=\{styles\.sheetRowText\}>Share outside Bravo<\/Text>/);
    expect(guarded).toMatch(/share-variant-outline/);
  });

  it('sits directly after Forward — before Message info, not buried under Delete', () => {
    const forward = ACTION_SHEET.indexOf('>Forward<');
    const share   = ACTION_SHEET.indexOf('>Share outside Bravo<');
    const info    = ACTION_SHEET.indexOf('>Message info<');
    expect(forward).toBeGreaterThan(-1);
    expect(info).toBeGreaterThan(-1);
    expect(share).toBeGreaterThan(forward);
    expect(share).toBeLessThan(info);
  });

  it('the handler is single-flight (a synchronous ref reset in finally — NAV loop N4)', () => {
    expect(CHAT).toMatch(/const sharingRef = useRef\(false\);/);
    expect(CHAT).toMatch(/if \(sharingRef\.current\) \{return;\}\n\s*sharingRef\.current = true;/);
    expect(CHAT).toMatch(/finally \{\n\s*sharingRef\.current = false;/);
  });

  it('both outcomes are reported — a failed share may never look like "nothing happened"', () => {
    expect(CHAT).toMatch(/Alert\.alert\('Sharing unavailable', 'This device has no app to share to\.'\)/);
    expect(CHAT).toMatch(/Alert\.alert\('Could not share', 'The file could not be prepared\. Open it first, then try again\.'\)/);
  });
});

describe('T3b — the forward sheet carries the same door, under the same predicate', () => {
  // The picker's JSX usage sits immediately before the long-press sheet.
  const forwardUse = CHAT.slice(CHAT.indexOf('<ForwardSheet'), sheetStart);

  it('CONTROL: the ForwardSheet usage was located', () => {
    expect(forwardUse).toContain('currentConvId={conversationId}');
    expect(forwardUse.length).toBeLessThan(1200);
  });

  it('a shareable source gets the header row; a text message gets none', () => {
    expect(forwardUse).toMatch(/header=\{canShareOutside\(forwardSource\) \?/);
    expect(forwardUse).toMatch(/: null\}/);
  });

  it('the header row keeps the news share-sheet look and label', () => {
    const row = CHAT.slice(CHAT.indexOf('function ShareOutsideRow('));
    expect(row).toMatch(/accessibilityLabel="Share outside Bravo"/);
    expect(row).toMatch(/<Text style=\{styles\.outsideTitle\}>Share outside Bravo<\/Text>/);
    expect(row).toMatch(/WhatsApp, Messages, email/);
    expect(row).toMatch(/name="share-variant"/);
  });
});

describe('T4 — the viewer never offers Share for a voice note', () => {
  const bar = VIEWER.slice(VIEWER.indexOf('styles.actionBar'), VIEWER.indexOf('<MoveToAlbumSheet'));

  it('CONTROL: the action bar was located and still holds the vault actions', () => {
    expect(bar).toContain('Move to Vault');
    expect(bar).toContain('label="Delete"');
  });

  it('the Share button is wrapped by a shareable !== false check', () => {
    const guarded = bar.match(/\{file\.shareable !== false && \([\s\S]{0,400}?\)\}/)?.[0] ?? '';
    expect(guarded).toMatch(/label="Share"/);
    // Exactly one Share button exists, and it is the guarded one.
    expect(bar.match(/label="Share"/g)).toHaveLength(1);
  });

  it('the flag is opt-OUT, so the Files and Vault callers keep today\'s behaviour', () => {
    expect(VIEWER).toMatch(/shareable\??:\s*boolean;/);
  });
});

describe('T5 — the chat viewer derives shareable from the same predicate', () => {
  const viewer = CHAT.slice(
    CHAT.indexOf('function ChatAttachmentViewer('),
    CHAT.indexOf('const MessageBubble'),
  );

  it('CONTROL: the chat attachment viewer was located', () => {
    expect(viewer).toContain('const file: ViewableFile = {');
  });

  it('passes shareable: canShareOutside(shownMsg) — not a hand-rolled type test', () => {
    expect(viewer).toMatch(/shareable:\s*canShareOutside\(shownMsg\)/);
  });
});

describe('T6 — a failed share is reported, never swallowed', () => {
  const shareFn = VIEWER.slice(
    VIEWER.indexOf('const shareFile = ()'),
    VIEWER.indexOf('const openExternal = ()'),
  );

  it('CONTROL: shareFile was located', () => {
    expect(shareFn).toContain('Sharing.shareAsync');
  });

  it('the catch is no longer empty — expo-sharing resolves on dismissal, so a throw is real', () => {
    expect(shareFn).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*(\/\*[\s\S]*?\*\/)?\s*\}/);
    expect(shareFn).toMatch(/Alert\.alert\('Could not share',/);
  });
});
