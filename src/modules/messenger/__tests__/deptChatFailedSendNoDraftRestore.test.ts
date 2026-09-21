/**
 * PG-M8 — a failed department post is ONE thing on screen, not two.
 *
 * Every `failGroupSend` exit in the runtime already leaves a durable `failed`
 * bubble carrying the post + a "Tap to retry" chip. `DepartmentChatScreen`'s
 * catch ALSO restored the draft into the composer, so the user saw the text
 * twice and a re-send minted a second `clientMsgId` the relay could not dedupe.
 * ChatScreen's send path shows a banner only; this pins the parity.
 *
 * Source scan (the screen mounts RN + modals; the node project cannot import
 * it). Line-based + CRLF-safe, comments stripped before any absence assertion.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const DEPT = join(process.cwd(), 'src', 'screens', 'messenger', 'DepartmentChatScreen.tsx');

function code(path: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(raw);
  }
  return out;
}

describe('PG-M8 — DepartmentChatScreen failed send', () => {
  const lines = code(DEPT);

  it('the send catch shows the failure banner and does NOT restore the draft', () => {
    const alertAt = lines.findIndex(l => l.includes("Alert.alert('Could not post'"));
    expect(alertAt).toBeGreaterThan(0);
    // Walk back to the enclosing `catch` and assert nothing in between re-seeds the composer.
    let catchAt = alertAt;
    while (catchAt > 0 && !/catch\s*\(/.test(lines[catchAt])) {catchAt -= 1;}
    expect(catchAt).toBeGreaterThan(0);
    const window = lines.slice(catchAt, alertAt + 1).join('\n');
    expect(window).not.toMatch(/setDraft\(/);
    expect(window).not.toMatch(/setPendingMentions\(/);
    expect(window).not.toMatch(/setReplyTo\(replySnapshot\)/);
  });

  it('PG-M8r — the composer clears only AFTER the runtime is acquired (a cold-boot throw keeps the draft)', () => {
    const sendAt = lines.findIndex(l => l.includes('const send = useCallback'));
    expect(sendAt).toBeGreaterThan(0);
    const win = lines.slice(sendAt, sendAt + 120).join('\n');
    // Scope past the EDIT-mode branch (it legitimately clears early and
    // returns); the send path proper starts at the body construction.
    const bodyAt = win.indexOf('const body = isAnnounce');
    expect(bodyAt).toBeGreaterThan(-1);
    const rtAt = win.indexOf("await getMessengerRuntime('production')", bodyAt);
    const clearAt = win.indexOf("setDraft('')", bodyAt);
    expect(rtAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(rtAt);
  });

  it('PG-M8r — a failed own post has a Retry action wired to the SAME bubble id', () => {
    const src = lines.join('\n');
    expect(src).toMatch(/existingMsgId: m\.id/);
    expect(src).toMatch(/Retry send/);
    expect(src).toMatch(/actionMsg\.status === 'failed' \|\| actionMsg\.status === 'undelivered'/);
  });
});
