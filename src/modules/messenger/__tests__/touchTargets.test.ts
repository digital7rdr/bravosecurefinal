/**
 * B-732..B-738 — touch reliability (audit
 * docs/audits/TOUCH_RELIABILITY_AUDIT_2026-09-02.md).
 *
 * The client's "buttons need 2-3 taps / only a precise spot works" decomposed
 * into five mechanisms; this suite pins the source shapes for four of them
 * (B-733 lives in composerSendRace.test.ts, B-736 in
 * incidentClientContract.test.ts):
 *
 *   B-732 — keyboardShouldPersistTaps: the RN default 'never' spends the
 *           FIRST tap dismissing the IME, so every tap with the keyboard up
 *           needed two. Pinned per decision site, never file-wide.
 *   B-734 — sub-44dp icon controls carry hitSlop sized to at most half the
 *           gap to their nearest neighbour (no overlapping targets).
 *   B-735 — the dept send button's box+slop sit ON the TouchableOpacity;
 *           a slop on the LinearGradient child is inert (non-responder).
 *   B-737 — an undownloaded image bubble tap downloads AND opens (G8),
 *           never a silent no-op.
 *   B-738 — DepartmentChatScreen keys its relay pull + markRead on the
 *           B-691 open-transition gate, like ChatScreen.
 *
 * RN screens cannot be imported by this project — comment-stripped source
 * scans, windowed on anchors INSIDE the decision site (repo scan rules:
 * comments stripped first, nothing \n-anchored, CRLF normalised).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function strip(rel: string[]): string {
  // Line-based strip (incidentClientContract shape). The greedy-regex form
  // believes the `/*` inside DocumentPicker's '*/*' MIME string and eats the
  // real code after it (source-scan-stripper-eats-code trap) — this one only
  // drops whole comment LINES, so strings are never misread as comments.
  return readFileSync(join(process.cwd(), ...rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^[ \t]*\{?\/\*[\s\S]*?\*\/\}?[ \t]*$/gm, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

const chat = strip(['src', 'screens', 'messenger', 'ChatScreen.tsx']);
const home = strip(['src', 'screens', 'messenger', 'MessengerHomeScreen.tsx']);
const dept = strip(['src', 'screens', 'messenger', 'DepartmentChatScreen.tsx']);
const recorder = strip(['src', 'modules', 'messenger', 'ui', 'VoiceNoteRecorder.tsx']);

/** Window around the FIRST occurrence of `anchor` — fails loud when absent. */
function around(src: string, anchor: string, fwd = 400, back = 0): string {
  const at = src.indexOf(anchor);
  expect(at).toBeGreaterThan(-1);
  return src.slice(Math.max(0, at - back), at + anchor.length + fwd);
}

describe('B-732 — keyboardShouldPersistTaps="handled" at every input-adjacent list', () => {
  it('ChatScreen message list (plus on-drag dismiss, the WhatsApp model)', () => {
    const w = around(chat, 'data={listItems}', 600);
    expect(w).toContain('keyboardShouldPersistTaps="handled"');
    expect(w).toContain('keyboardDismissMode="on-drag"');
  });

  it('MessengerHome conversation list', () => {
    const w = around(home, 'data={filtered}', 600);
    expect(w).toContain('keyboardShouldPersistTaps="handled"');
    expect(w).toContain('keyboardDismissMode="on-drag"');
  });

  it('DepartmentChat feed', () => {
    const w = around(dept, 'style={styles.feedScroll}', 400);
    expect(w).toContain('keyboardShouldPersistTaps="handled"');
    expect(w).toContain('keyboardDismissMode="on-drag"');
  });

  it('NewChat contact picker', () => {
    const src = strip(['src', 'screens', 'messenger', 'NewChatScreen.tsx']);
    const w = around(src, 'paddingBottom: insets.bottom + 24, flexGrow: 1', 100, 300);
    expect(w).toContain('keyboardShouldPersistTaps="handled"');
  });

  it('DepartmentChannels tree (search lives INSIDE the scroll)', () => {
    const src = strip(['src', 'screens', 'messenger', 'DepartmentChannelsScreen.tsx']);
    // Anchor the PROP, then require the tree scroll's refreshControl right
    // after it — pins the prop to this ScrollView, not any sibling.
    const w = around(src, 'keyboardShouldPersistTaps="handled"', 300);
    expect(w).toContain('refreshControl={');
  });

  it('Files list', () => {
    const src = strip(['src', 'screens', 'messenger', 'FilesScreen.tsx']);
    const w = around(src, '(!scopeToCompany && !selectionMode ? 0 : insets.bottom) + 24', 300);
    expect(w).toContain('keyboardShouldPersistTaps="handled"');
  });

  it('ChatInfo scroll', () => {
    const src = strip(['src', 'screens', 'messenger', 'ChatInfoScreen.tsx']);
    const w = around(src, 'paddingBottom: insets.bottom + 40', 300);
    expect(w).toContain('keyboardShouldPersistTaps="handled"');
  });

  it('SecurePro members scroll', () => {
    const src = strip(['src', 'screens', 'securepro', 'SecureProMembersScreen.tsx']);
    const w = around(src, 'paddingBottom: contentBottom(110)', 300);
    expect(w).toContain('keyboardShouldPersistTaps="handled"');
  });
});

describe('B-734 — sub-floor icon controls carry hitSlop', () => {
  it('the composer emoji toggle (18dp glyph) reaches 44dp, like its dept twin', () => {
    const w = around(chat, "'Show keyboard' : 'Show emoji'}", 300);
    expect(w).toContain('hitSlop={{top: 13, bottom: 13, left: 13, right: 13}}');
  });

  it('send, attach, header back and the header icon trio are slopped', () => {
    expect(around(chat, 'style={styles.backBtn}', 200, 60)).toContain('hitSlop');
    expect(around(chat, 'onPress={onAttach}', 60, 260)).toContain('hitSlop');
    const send = around(chat, 'style={[styles.sendBtn,', 400);
    expect(send).toContain('hitSlop');
    const iconBtns = chat.match(/style=\{styles\.iconBtn\}[\s\S]{0,220}?hitSlop/g) ?? [];
    expect(iconBtns.length).toBeGreaterThanOrEqual(3);
  });

  it('voice-note mic, cancel and send are slopped (3+ in the recorder)', () => {
    const hits = recorder.match(/hitSlop/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });

  it('the dept reply/edit close buttons (padding:4 → ~22dp) are slopped', () => {
    const sites = dept.match(/styles\.replyBarClose\}[\s\S]{0,200}?hitSlop/g) ?? [];
    expect(sites.length).toBe(2);
  });

  it('MessengerHome search-clear X is slopped', () => {
    expect(around(home, 'close-circle', 40, 300)).toContain('hitSlop');
  });

  it('bare <Text onPress> action links are gone from the two attendance screens', () => {
    const att = strip(['src', 'screens', 'agent', 'AttendanceScreen.tsx']);
    const ver = strip(['src', 'screens', 'deptchat', 'VerifyAttendanceScreen.tsx']);
    expect(att).not.toMatch(/style=\{s\.viewAll\}\s+onPress=/);
    expect(ver).not.toMatch(/style=\{s\.link\}\s+onPress=/);
  });

  it('group-call tile menus, in-call chat close and dialpad actions are slopped', () => {
    const gc = strip(['src', 'screens', 'messenger', 'GroupCallScreen.tsx']);
    const more = gc.match(/s\.heroMoreBtn\}[\s\S]{0,120}?hitSlop/g) ?? [];
    expect(more.length).toBe(2);
    // Not around(): the Modal's onRequestClose is an EARLIER setChatOpen(false).
    expect(gc).toMatch(/setChatOpen\(false\)\}\s+hitSlop/);
    const call = strip(['src', 'screens', 'messenger', 'CallScreen.tsx']);
    expect(around(call, "setDialedDigits('')", 60, 40)).toContain('hitSlop');
    // Same earlier-occurrence hazard: the Modal/backdrop close on this screen.
    expect(call).toMatch(/setDialpadOpen\(false\)\}\s+activeOpacity=\{0\.7\}\s+hitSlop/);
  });
});

describe('B-735 — the dept send button owns its box and slop', () => {
  it('slop + box on the TouchableOpacity; the gradient is a pointerEvents-none fill', () => {
    const w = around(dept, 'void send()', 700);
    const touchable = w.slice(0, w.indexOf('<LinearGradient'));
    expect(touchable).toContain('hitSlop');
    expect(touchable).toContain('styles.sendBtn');
    const grad = w.slice(w.indexOf('<LinearGradient'));
    expect(grad).toContain('pointerEvents="none"');
    expect(grad).toContain('StyleSheet.absoluteFill, styles.sendBtnFill');
    // The inert shape must not come back: no hitSlop on the gradient.
    expect(grad.slice(0, grad.indexOf('/>'))).not.toContain('hitSlop');
  });
});

describe('B-737 — an undownloaded image tap downloads AND opens (G8)', () => {
  it('both media branches carry the one-tap arm', () => {
    // Image branch + video/audio/file branch: each "open if uri" is paired
    // with the download arm. Count both so neither branch can lose it.
    const opens = chat.match(/if \(attachment\.uri\) \{onOpenImage\(\);\}/g) ?? [];
    expect(opens.length).toBeGreaterThanOrEqual(2);
    const arms = chat.match(/setAutoOpen\(true\); attachment\.load\(\);/g) ?? [];
    expect(arms.length).toBeGreaterThanOrEqual(2);
    // The old silent no-op shape must not return.
    expect(chat).not.toMatch(/onPress=\{\(\) => !imageBroken && attachment\.uri && onOpenImage\(\)\}/);
  });
});

describe('B-738 — DepartmentChatScreen keys its mount burst on the B-691 gate', () => {
  function effectPrefix(src: string, anchor: string): string {
    const at = src.indexOf(anchor);
    expect(at).toBeGreaterThan(-1);
    const start = src.lastIndexOf('useEffect(() => {', at);
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, at);
  }

  it('the gate is mounted off navigation', () => {
    expect(dept).toMatch(/useOpenTransitionGate\(\s*navigation/);
  });

  it('the relay pull waits for the slide', () => {
    expect(effectPrefix(dept, 'rt.pullEnvelopes()')).toContain('!transitionDone');
  });

  it('the first markRead commit waits for the slide', () => {
    expect(effectPrefix(dept, 'rt.markRead(groupConversationId)')).toContain('!transitionDone');
  });

  it('both gated effects carry transitionDone in their deps (re-run when it opens)', () => {
    const deps = dept.match(/\}, \[[^\]]*transitionDone[^\]]*\]\);/g) ?? [];
    expect(deps.length).toBe(2);
  });

  it('content never keys on the gate (hook contract — delayed effects only)', () => {
    expect(dept).not.toMatch(/\{transitionDone\s*&&/);
  });
});
