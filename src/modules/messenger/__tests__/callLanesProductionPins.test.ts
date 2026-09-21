/**
 * PG-C2 / PG-C3 / PG-G1 / PG-G4 / PG-G5 / PG-U1 — call-lane hardening pins.
 *
 * All source scans: these files mount RN / mediasoup / WebRTC and cannot be
 * imported by the node project. Line-based, CRLF-safe, comments stripped, and
 * every ordering assertion is anchored INSIDE the executing closure (the
 * B-596 lesson).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const f = (...p: string[]): string => join(ROOT, ...p);

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

function closure(lines: string[], startRe: RegExp, endRe: RegExp): string[] {
  const starts = lines.map((l, i) => (startRe.test(l) ? i : -1)).filter(i => i >= 0);
  expect(starts).toHaveLength(1);
  let end = -1;
  for (let i = starts[0] + 1; i < lines.length; i++) { if (endRe.test(lines[i])) { end = i; break; } }
  expect(end).toBeGreaterThan(starts[0]);
  return lines.slice(starts[0], end);
}

describe('PG-C2 — the call-waiting banner retires when the second caller gives up', () => {
  it("callDispatcher's no-controller call.hangup branch clears the pending 1:1 banner for that callId", () => {
    const lines = code(f('src', 'modules', 'messenger', 'webrtc', 'callDispatcher.ts'));
    const body = closure(lines, /^ {4}case 'call\.hangup': \{$/, /^ {4}case '[a-z.-]+': \{$/).join('\n');
    const zombieAt = body.indexOf("endZombieSession(cid, 'call.hangup')");
    const bannerAt = body.indexOf('clearPendingOneToOne()');
    expect(zombieAt).toBeGreaterThan(-1);
    expect(bannerAt).toBeGreaterThan(zombieAt);
    expect(body).toMatch(/getPendingOneToOne\(\)\?\.callId === cid/);
  });
});

describe('PG-C3 — the CALL-17 launch latch releases on an aborted launch', () => {
  it('CallScreen releases the latch in an unmount cleanup when no live call remains for it', () => {
    const src = code(f('src', 'screens', 'messenger', 'CallScreen.tsx')).join('\n');
    expect(src).toMatch(/releaseOneToOneLaunchLatch\(\)/);
    expect(src).toMatch(/if \(!live \|\| live\.callId === callId\) \{\s*\n\s*const lc = require\('@\/modules\/messenger\/webrtc\/launchCall'\)/);
  });
});

describe('PG-G1 — group rejoin and ICE-restart ride the LIVE socket', () => {
  const lines = code(f('src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts'));

  it('a liveWs accessor resolves through transportRef (re-pointed on rebuild)', () => {
    const src = lines.join('\n');
    expect(src).toMatch(/const liveWs = \(\): TransportClient => transportRef\.current \?\? bootWs;/);
  });

  it("rejoinRoom's transport connect/produce handlers use liveWs(), never the boot socket", () => {
    const body = closure(lines, /^ {8}const rejoinRoom = async \(rejoined: SfuJoinedResp, attemptGen: number\)/, /^ {8}rejoinRoomRef\.current = rejoinRoom;/).join('\n');
    expect(body).not.toMatch(/wsRequest<[^>]*>\(ws,/);
    expect((body.match(/wsRequest<[^>]*>\(liveWs\(\),/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('the ICE-restart lane guards and sends on the same live socket', () => {
    const src = lines.join('\n');
    expect(src).toMatch(/const wsIsOpen = \(\): boolean =>\s*\n\s*\(liveWs\(\) as unknown as \{state\?: string\}\)\.state === 'connected';/);
    expect(src).toMatch(/wsRequest<\{iceParameters: unknown\}>\(\s*\n\s*liveWs\(\),/);
  });
});

describe('PG-G4 — an unanswered group call ends itself', () => {
  const lines = code(f('src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts'));
  const src = lines.join('\n');

  it('every ring (boot + Re-ring) arms the no-answer timer', () => {
    const arms = src.match(/setRingStartedAt\(Date\.now\(\)\);\s*\n\s*armNoAnswerTimer\(\);/g) ?? [];
    expect(arms.length).toBe(2);
  });

  it('the timer fires at ring-timeout + grace, gated on the registry, remote MEDIA and the rung set', () => {
    const body = closure(lines, /^ {2}function armNoAnswerTimer\(\): void \{$/, /^ {2}\}$/).join('\n');
    expect(body).toMatch(/RING_TIMEOUT_MS \+ NO_ANSWER_GRACE_MS/);
    expect(body).toMatch(/joinedUserIdsRef\.current\.has\(/);
    // PG-G4r (critic round) — presence-gated, not identity-gated: a joined
    // peer whose identity envelope never resolved (B-365) must not read as
    // silence; and only the call the registry still holds may be ended.
    expect(body).toMatch(/remoteTilesRef\.current\.length > 0/);
    expect(body).toMatch(/getActiveGroupCall\(\)/);
    expect(body).toMatch(/noAnswerRef\.current = true;/);
    expect(body).toMatch(/void leaveInternal\(\);/);
  });

  it('PG-G4r — the boot cleanup clears the timer BEFORE the keepAlive (minimize) early-return', () => {
    // A minimized instance freezes its refs (React drops its setState), so a
    // surviving timer read a stale joined-set and could end a LIVE call.
    expect(src).toMatch(/return \(\) => \{\s*\n\s*if \(noAnswerTimerRef\.current\) \{clearTimeout\(noAnswerTimerRef\.current\); noAnswerTimerRef\.current = null;\}\s*\n\s*const live = getActiveGroupCall\(\);/);
  });

  it('a recipient joining disarms it, and the history bubble records the attempt as unanswered', () => {
    expect(src).toMatch(/joinedUserIdsRef\.current = joined;\s*\n[\s\S]{0,400}clearTimeout\(noAnswerTimerRef\.current\)/);
    expect(src).toMatch(/noAnswerRef\.current \? 'declined' : 'answered'/);
    const screen = code(f('src', 'screens', 'messenger', 'GroupCallScreen.tsx')).join('\n');
    expect(screen).toMatch(/call\.noAnswer \? 'No answer'/);
  });
});

describe('PG-G5 — group launch is latched and its probes are bounded', () => {
  it('launchCall latches the group tap and bounds both probes, releasing in finally', () => {
    const src = code(f('src', 'modules', 'messenger', 'webrtc', 'launchCall.ts')).join('\n');
    expect(src).toMatch(/if \(groupLaunchInFlight\) \{/);
    const latchAt = src.indexOf('groupLaunchInFlight = true;');
    const probeAt = src.indexOf('findLiveRoom(opts.conversationId)');
    expect(latchAt).toBeGreaterThan(-1);
    expect(latchAt).toBeLessThan(probeAt);
    expect(src).toMatch(/withProbeTimeout\(findLiveRoom\(opts\.conversationId\), GROUP_LAUNCH_PROBE_MS\)/);
    expect(src).toMatch(/withProbeTimeout\(ringRecipients\(opts\.conversationId, fromStore, opts\.participants\), GROUP_LAUNCH_PROBE_MS\)/);
    expect(src).toMatch(/\.finally\(\(\) => \{ groupLaunchInFlight = false; \}\)/);
  });

  it('PG-G5r — the navigate re-checks BOTH registries after the probe, and the 1:1 guard sees the group latch', () => {
    const src = code(f('src', 'modules', 'messenger', 'webrtc', 'launchCall.ts')).join('\n');
    expect(src).toMatch(/now1to1 && now1to1\.state !== 'ended' && now1to1\.state !== 'failed'/);
    expect(src).toMatch(/nowGroup && !nowGroup\.ending && nowGroup\.conversationId !== opts\.conversationId/);
    expect(src).toMatch(/return oneToOneLaunchInFlight \|\| groupLaunchInFlight \|\| getActiveCall\(\) !== null;/);
  });
});

describe('PG-U1 — chat controls carry accessibility labels', () => {
  it('attach, timer, send, scroll FAB and the two call buttons are labelled', () => {
    const src = readFileSync(f('src', 'screens', 'messenger', 'ChatScreen.tsx'), 'utf8');
    for (const label of ['Attach a photo or file', 'Disappearing message timer', 'Send message', 'Scroll to latest message', 'Voice call', 'Video call']) {
      expect(src).toContain(label);
    }
  });
});
