/**
 * PG-G3 — a group call's history bubble records the direction the hook booted
 * with. It was hard-coded `'outgoing'`, so every member who ANSWERED a group
 * call saw a green outgoing arrow in the Calls tab.
 *
 * Source scan: `useGroupCall.ts` mounts mediasoup + RN and cannot be imported
 * by the node project. Line-based, CRLF-safe, comments stripped.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const HOOK = join(process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts');

function code(): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of readFileSync(HOOK, 'utf8').split(/\r?\n/)) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(raw);
  }
  return out;
}

describe('PG-G3 — group call history direction', () => {
  const lines = code();

  it('the leave path passes the boot direction into the history bubble', () => {
    const callAt = lines.findIndex(l => l.includes('appendGroupCallHistoryBubble({'));
    expect(callAt).toBeGreaterThan(0);
    const window = lines.slice(callAt, callAt + 10).join('\n');
    expect(window).toMatch(/direction:\s*opts\.direction/);
  });

  it('the bubble builder writes call_meta.direction from its argument, never a literal', () => {
    const fnAt = lines.findIndex(l => l.startsWith('function appendGroupCallHistoryBubble('));
    expect(fnAt).toBeGreaterThan(0);
    const body = lines.slice(fnAt, fnAt + 60).join('\n');
    expect(body).toMatch(/direction:\s*args\.direction/);
    // The literal ASSIGNMENT (trailing comma) — the args TYPE legitimately
    // names both directions on one line.
    expect(body).not.toMatch(/direction:\s*'outgoing',/);
  });
});
