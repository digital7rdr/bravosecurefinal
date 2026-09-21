/**
 * PG-P1 — the department thread must stay VIRTUALISED and PAGED.
 *
 * `DepartmentChatScreen` rendered the whole thread (up to the 200-row
 * hydration window) in a plain `ScrollView` via `messages.map`, and called
 * `scrollToEnd` on EVERY content-size change (each keyboard open, each
 * arrival) — the exact "UI thread MOUNTING views" cost CLAUDE.md measured, and
 * untouched by the B-738 transition gate (which never keys content). It also
 * had no paging, so rows older than the window were unreachable.
 *
 * Same pin shape as `callsLogVirtualized.test.ts` (B-655). Source scan: the
 * screen mounts RN + modals. Line-based, CRLF-safe, comments stripped before
 * every absence assertion — this file's own prose names the banned tokens.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'messenger', 'DepartmentChatScreen.tsx');

function code(): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of readFileSync(SCREEN, 'utf8').split(/\r?\n/)) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(raw);
  }
  return out.join('\n');
}

describe('PG-P1 — DepartmentChatScreen thread', () => {
  const src = code();

  it('is an inverted, windowed FlatList keyed by message id', () => {
    expect(src).toMatch(/<FlatList\s*\n\s*ref=\{scrollRef\}/);
    expect(src).toMatch(/\n\s*inverted\n/);
    expect(src).toMatch(/initialNumToRender=\{10\}/);
    expect(src).toMatch(/maxToRenderPerBatch=\{8\}/);
    expect(src).toMatch(/windowSize=\{5\}/);
    expect(src).toMatch(/keyExtractor=\{keyOf\}/);
    expect(src).toMatch(/maintainVisibleContentPosition=\{\{minIndexForVisible: 0/);
  });

  it('no longer mounts the whole thread in a ScrollView or scrolls-to-end on every content change', () => {
    expect(src).not.toMatch(/messages\.map\(\(m, i\) =>/);
    expect(src).not.toMatch(/<ScrollView/);
    expect(src).not.toMatch(/onContentSizeChange=/);
    expect(src).not.toMatch(/scrollToEnd\(/);
  });

  it('pages older history through the runtime (ChatScreen parity)', () => {
    expect(src).toMatch(/onEndReached=\{onEndReached\}/);
    expect(src).toMatch(/rt\.loadOlderMessages/);
    expect(src).toMatch(/exhaustedOlderRef\.current = true/);
  });

  it('the row renderer keeps the chronological index for day dividers and sender headers', () => {
    expect(src).toMatch(/renderItem=\{\(\{item, index\}\) => renderMessage\(item, messages\.length - 1 - index\)\}/);
    expect(src).toMatch(/const prev = i > 0 \? messages\[i - 1\] : null;/);
  });

  it('reply-quote jump uses scrollToIndex, not measured offsets', () => {
    expect(src).toMatch(/scrollRef\.current\?\.scrollToIndex\(\{index: at/);
    expect(src).not.toMatch(/msgOffsets/);
  });
});
