/**
 * PG-M1 / PG-M2 / PG-M3 / PG-M10 — the offline ordering of reactions, edits and
 * delete-for-everyone, pinned as SOURCE SCANS (no test imports
 * productionRuntime.ts — CLAUDE.md, MESSAGE_LOOP).
 *
 * What went wrong: all three opened on `await certCache.getIssued()` and applied
 * their local echo / tombstone AFTER the fan-out. On a cold offline boot the
 * cert fetch threw first, so a reaction did nothing at all (no catch in
 * ChatScreen either), an edit lost its correction, and a delete-for-everyone —
 * whose caller had already discarded the original's outbox row — left the
 * message on screen under "Delete failed".
 *
 * The contract now:
 *   1. the local echo / tombstone is applied BEFORE the cert fetch;
 *   2. a durable INTENT row per recipient is written BEFORE the cert fetch and
 *      before any per-peer crypto (`ensureOutgoingSession`);
 *   3. ChatScreen's reaction handler surfaces a total failure instead of
 *      swallowing it;
 *   4. the drain never flips status for a no-bubble row (messageId ==
 *      clientMsgId) — that only spent the MR-12 store-miss warn budget.
 *
 * Anchors are taken INSIDE each executing closure (the B-596 lesson: a scan
 * over the whole file matched a sibling and passed vacuously). Line-based,
 * CRLF-safe, comments stripped first — this file's own prose names every
 * token under test.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');
const CHAT    = join(process.cwd(), 'src', 'screens', 'messenger', 'ChatScreen.tsx');

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

/** Lines of the closure that starts at the unique `startRe` line and ends at `endRe`. */
function closure(lines: string[], startRe: RegExp, endRe: RegExp): {text: string; at: (re: RegExp) => number} {
  const starts = lines.map((l, i) => (startRe.test(l) ? i : -1)).filter(i => i >= 0);
  expect(starts).toHaveLength(1);
  let end = -1;
  for (let i = starts[0] + 1; i < lines.length; i++) { if (endRe.test(lines[i])) { end = i; break; } }
  expect(end).toBeGreaterThan(starts[0]);
  const body = lines.slice(starts[0], end);
  const text = body.join('\n');
  return {text, at: (re: RegExp) => body.findIndex(l => re.test(l))};
}

describe('PG-M2 — sendReaction', () => {
  const rt = code(RUNTIME);
  const fn = closure(rt, /^ {4}sendReaction: async \(/, /^ {4}sendMessageEdit: async \(/);

  it('applies the local echo BEFORE the cert fetch', () => {
    const echo = fn.at(/updateMessageReactions\(/);
    const cert = fn.at(/certCache\.getIssued\(\)/);
    expect(echo).toBeGreaterThan(-1);
    expect(cert).toBeGreaterThan(-1);
    expect(echo).toBeLessThan(cert);
  });

  it('writes a durable intent row per recipient BEFORE the cert fetch and before any per-peer crypto', () => {
    const intent  = fn.at(/buildDeferredReactionOutboxPayload\(/);
    const cert    = fn.at(/certCache\.getIssued\(\)/);
    const session = fn.at(/ensureOutgoingSession\(/);
    expect(intent).toBeGreaterThan(-1);
    expect(intent).toBeLessThan(cert);
    expect(intent).toBeLessThan(session);
    // The post-crypto sealed row is gone — the intent IS the durable copy.
    expect(fn.text).not.toMatch(/buildReactionSealedOutboxPayload\(/);
  });

  it('a cert failure with intents on disk returns (deferred); with none it reverts the echo and throws', () => {
    expect(fn.text).toMatch(/deferred \(no cert\)/);
    expect(fn.text).toMatch(/revertEcho\(\);\s*\n\s*throw e;/);
  });
});

describe('PG-M1/M3 — sendMutationDirective, sendMessageEdit, sendDeleteForEveryone', () => {
  const rt = code(RUNTIME);

  it('sendMutationDirective writes the intent rows BEFORE the cert fetch and before any per-peer crypto', () => {
    const fn = closure(rt, /^ {2}const sendMutationDirective = async \(/, /^ {2}const runtimeApi: MessengerRuntime = \{/);
    const intent  = fn.at(/buildDeferredMutationOutboxPayload\(/);
    const cert    = fn.at(/certCache\.getIssued\(\)/);
    const session = fn.at(/ensureOutgoingSession\(/);
    expect(intent).toBeGreaterThan(-1);
    expect(intent).toBeLessThan(cert);
    expect(intent).toBeLessThan(session);
    expect(fn.text).not.toMatch(/buildMutationSealedOutboxPayload\(/);
  });

  it('sendDeleteForEveryone applies the tombstone BEFORE shipping the directive', () => {
    const fn = closure(rt, /^ {4}sendDeleteForEveryone: async \(/, /^ {4}discardOutboxForMessage: async \(/);
    const tomb = fn.at(/applyDeleteForEveryone\(/);
    const ship = fn.at(/await sendMutationDirective\(/);
    expect(tomb).toBeGreaterThan(-1);
    expect(ship).toBeGreaterThan(-1);
    expect(tomb).toBeLessThan(ship);
  });

  it('sendMessageEdit applies the local edit BEFORE shipping the directive', () => {
    const fn = closure(rt, /^ {4}sendMessageEdit: async \(/, /^ {4}sendDeleteForEveryone: async \(/);
    const echo = fn.at(/applyMessageEdit\(/);
    const ship = fn.at(/await sendMutationDirective\(/);
    expect(echo).toBeGreaterThan(-1);
    expect(ship).toBeGreaterThan(-1);
    expect(echo).toBeLessThan(ship);
  });
});

describe('PG-M2 — ChatScreen surfaces a total reaction failure', () => {
  it('reactToMessage catches and reports instead of swallowing', () => {
    const lines = code(CHAT);
    const fn = closure(lines, /const reactToMessage = useCallback\(async/, /^ {2}\}, \[runtime, conversationPeer, conversationId\]\);/);
    expect(fn.text).toMatch(/await runtime\.sendReaction\(/);
    expect(fn.text).toMatch(/catch \(e\) \{[\s\S]*setError\(sendErrorText\(e, 'Reaction failed'\)\)/);
  });
});

describe('PG-M10r — no-bubble rows are identified by PAYLOAD KIND, never by id equality', () => {
  const rt = code(RUNTIME);
  const src = rt.join('\n');

  it('the drain derives noBubble from the plan, and the id-equality guard is GONE', () => {
    // The critic-caught P0: sendText sets clientMsgId = msgId (BS-REACT-
    // AUTHOR), so EVERY first-send bubble has messageId === clientMsgId — the
    // id-equality guard suppressed the sent flip for every drain-shipped
    // message (offline text never got its tick, and L17 later red a message
    // peers already had, re-opening the B-683 duplicate class).
    expect(src).toMatch(/let noBubble = false;/);
    expect(src).toMatch(/noBubble {5}= plan\.payload\.resealKind === 'reaction' \|\| plan\.payload\.resealKind === 'mutation';/);
    expect(src).toMatch(/noBubble {5}= plan\.noBubble === true;/);
    expect(src).not.toMatch(/row\.messageId !== row\.clientMsgId/);
  });

  it('the drain success block guards ALL THREE store writes on !noBubble', () => {
    expect(src).toMatch(/if \(!noBubble\) \{\s*\n\s*useMessengerStore\.getState\(\)\.updateMessageStatus\(\s*\n\s*row\.conversationId, row\.messageId, 'sent',/);
    expect(src).toMatch(/if \(r\.retractToken && !noBubble\)/);
    expect(src).toMatch(/if \(r\.envelopeId && !noBubble\)/);
  });

  it('handleAccepted skips the flips for a noBubble pending entry', () => {
    const at = src.indexOf('function handleAccepted(');
    expect(at).toBeGreaterThan(-1);
    const win = src.slice(at, at + 2600);
    expect(win).toMatch(/if \(!entry\.noBubble\) \{/);
    expect(win).toMatch(/frame\.data\.retractToken && !entry\.noBubble/);
  });

  it('reaction + mutation sends mark their pending entries noBubble and grace their intent rows', () => {
    expect((src.match(/noBubble: true\}\);/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((src.match(/notBeforeMs:\s*Date\.now\(\) \+ INTENT_DRAIN_GRACE_MS/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
