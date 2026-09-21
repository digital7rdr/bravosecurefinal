/**
 * The "Client Picked Up" checkpoint (founder deck, August 2026, pages 3 and 21).
 *
 * The deck's contract, verbatim: the control requires a deliberate tap AND
 * confirmation; it is shown when the team is at or near the pickup point, with an
 * operational override; it records who/where/when; it notifies the Bravo Control
 * System and updates the client-facing status; and it switches navigation from
 * the pickup to the drop-off.
 *
 * What this pins is the part that is easy to get wrong and invisible when it is:
 *   - the tracker must not grow a SECOND copy of the FSM call (the CPO Mission tab
 *     owns the error translation, the session-loss branch and the never-optimistic
 *     re-read; a divergent copy loses all three);
 *   - the confirm branch must advance the action it is CONFIRMING — it used to
 *     hard-code 'finish' because Finish was the only confirmed action, so making
 *     Client Picked Up confirm would otherwise have completed the mission and
 *     released payment;
 *   - the pill must be anchored OFF the measured dock, never appended to it: the
 *     dock's height drives the style column, the slide handle and the WebView's
 *     FOLLOW pill, and growing it silently unmounts chrome on a short screen.
 *
 * Source scans: this screen cannot be imported by the node projects (WebView +
 * Mapbox). Comments are stripped and the file is CRLF-normalised — both are
 * CLAUDE.md scan traps.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function code(rel: string[]): string {
  const src = readFileSync(join(process.cwd(), ...rel), 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) {inBlock = false;}
      continue;
    }
    if (t.startsWith('/*') || t.startsWith('{/*')) {
      if (!t.includes('*/')) {inBlock = true;}
      continue;
    }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

const TRACKER = code(['src', 'screens', 'agent', 'AgentLiveTrackerScreen.tsx']);
const CPO = code(['src', 'screens', 'cpo', 'AssignedMissionDetailScreen.tsx']);
const ACTION = code(['src', 'screens', 'cpo', 'missionAction.ts']);
const HOOK = code(['src', 'screens', 'cpo', 'useMissionAdvance.ts']);

describe('exactly ONE caller of the mission FSM endpoints', () => {
  it('the transition lives in the shared hook', () => {
    expect(HOOK).toContain('agentApi.missionPickup');
    expect(HOOK).toContain('agentApi.missionGoLive');
    expect(HOOK).toContain('agentApi.missionComplete');
  });

  it('neither screen calls the endpoints directly', () => {
    for (const [name, src] of [['tracker', TRACKER], ['cpo', CPO]] as const) {
      expect(`${name}:${/agentApi\.missionGoLive/.test(src)}`).toBe(`${name}:false`);
      expect(`${name}:${/agentApi\.missionPickup/.test(src)}`).toBe(`${name}:false`);
      expect(`${name}:${/agentApi\.missionComplete/.test(src)}`).toBe(`${name}:false`);
    }
  });

  it('both screens drive the same selector and the same hook', () => {
    for (const src of [TRACKER, CPO]) {
      expect(src).toContain('missionActionView(');
      expect(src).toContain('useMissionAdvance(');
      expect(src).toContain('missionActionConfirm(');
    }
  });
});

describe('the confirm advances the action being confirmed', () => {
  it('no screen hard-codes the advanced action inside the confirm branch', () => {
    // The original bug shape: Alert -> onPress -> runAction('finish').
    for (const src of [TRACKER, CPO]) {
      expect(src).not.toMatch(/runAction\('finish'\)/);
      expect(src).not.toMatch(/runAction\('go-live'\)/);
    }
  });

  it('Client received demands a confirmation, and names what is being attested', () => {
    /**
     * E2E-45 re-anchor + B-795. The label is shape-aware: a transport detail
     * confirms "Client received" — the founder's word for the moment that starts
     * the protection service AND the billable time (live_at = client_received_at);
     * an on-site Executive block confirms "Start Protection". Both bodies name the
     * specific act being attested and the billable start. Both shapes' behaviour
     * (labels, confirm flags, transitions) is pinned in
     * src/screens/booking/__tests__/cpoMissionDoors.test.ts.
     */
    expect(ACTION).toMatch(/case 'go-live': return \{action, label: onSite \? 'Start Protection' : 'Client received', confirm: true\}/);
    expect(ACTION).toMatch(/shape: MissionShape = 'transport'/);
    expect(ACTION).toContain('Confirm the client is in the vehicle');
    expect(ACTION).toContain('Confirm you are on site with the principal');
    expect(ACTION).toContain('billable time');
  });
});

describe('the checkpoint is offered near the pickup, with an override', () => {
  it('uses a client-side radius that never becomes a server gate', () => {
    expect(TRACKER).toMatch(/const PICKUP_RADIUS_M = \d+;/);
    expect(TRACKER).toContain('distToPickupM > PICKUP_RADIUS_M');
  });

  it('an out-of-radius tap is still possible but must state the distance', () => {
    expect(TRACKER).toContain('from the pickup point.');
    expect(TRACKER).toContain('formatDistance(distToPickupM as number)');
    // Demoted, not hidden — hiding it strands a driver with a bad pickup pin.
    expect(TRACKER).toContain('farFromPickup && s.checkpointFar');
  });

  // B-644 — the founder saw ARRIVED AT PICKUP 12 km out and could not tell it was
  // gated. The old far state only swapped one solid fill for a slightly darker
  // solid fill, which on a dark map still reads as the live primary action; the
  // distance existed ONLY inside the post-tap confirm. The range must be legible
  // BEFORE the tap.
  it('shows the range ON the button, so the gate is visible before tapping', () => {
    expect(TRACKER).toContain('s.checkpointRangePill');
    expect(TRACKER).toMatch(/farFromPickup && distToPickupM !== null && \(/);
    expect(TRACKER).toMatch(/checkpointRangeTxt[^]*?formatDistance\(distToPickupM\)/);
    // A distinct icon too — the check glyph is what made it read as "do it now".
    expect(TRACKER).toMatch(/farFromPickup \? 'map-marker-distance' : checkpointIcon\(av\.action\)/);
    // The a11y label must carry it as well, not just the pixels.
    expect(TRACKER).toContain('Not there yet');
  });

  it('the far state is OUTLINED, not another solid primary fill', () => {
    const far = TRACKER.slice(TRACKER.indexOf('checkpointFar: {'));
    const block = far.slice(0, far.indexOf('},') + 2);
    expect(block).toMatch(/backgroundColor: 'rgba\(/);   // translucent, not a solid hex
    expect(block).toMatch(/shadowOpacity: 0/);           // no primary lift
    expect(block).not.toMatch(/backgroundColor: '#[0-9A-Fa-f]{6}'/);
  });
});

describe('everyone assigned sees the same stage', () => {
  it('the lead flag rides on the poll that already runs', () => {
    expect(TRACKER).toContain('setIsLead(data.crew_role?.is_lead === true)');
  });

  it('a non-lead sees the same next step, read-only rather than a dead button', () => {
    // The server enforces lead_only; a tappable control would just 400.
    // E2E-45 — re-anchored: the call now carries the mission SHAPE so an
    // on-site Executive Protection detail reads "Start/End Protection" here too,
    // matching the CPO Mission tab. The pin still proves the lead's next step is
    // what a non-lead is shown.
    expect(TRACKER).toContain('const leadNext = missionActionView(missionStatus, true, missionShape)');
    expect(TRACKER).toContain('LEAD CONFIRMS');
    expect(TRACKER).toMatch(/av\.action === 'none' && !isLead && leadNext\.action !== 'none'/);
  });
});

describe('the pill cannot break the measured-dock contract', () => {
  it('is anchored OFF the dock, not appended to it', () => {
    // Appending would grow dockHeight, which drives the style column, the slide
    // handle and the WebView FOLLOW pill.
    // B-813 — the offset may carry the driver speed-cluster lift (+48 while
    // turn-by-turn is up); the base stays the MEASURED dock.
    expect(TRACKER).toMatch(/s\.checkpoint,\s*\n\s*\{bottom: \(dockHeight \|\| 0\) \+ 12( \+ overlayLift)?\}/);
    expect(TRACKER).toMatch(/const overlayLift = navShown && isDriver && \(speedKph !== null \|\| limitKph !== null\) \? 48 : 0;/);
  });

  it('clears the FOLLOW pill and the slide handle on the right', () => {
    // B-813 — the slab that stretched left:14 → right:96 became a compact,
    // self-sized pill: no `right` at all, and a width cap that keeps its far
    // edge short of the right-hand controls at every supported width
    // (62 % of 320 dp = 198 dp + 14 dp inset = 212 dp < 320 − 96 = 224 dp).
    const block = TRACKER.slice(TRACKER.indexOf('  checkpoint: {'));
    const style = block.slice(0, 500);
    expect(style).toMatch(/left: 14/);
    expect(style).toMatch(/maxWidth: '62%'/);
    expect(style).not.toMatch(/\bright: \d/);
    expect(style).toMatch(/minHeight: 44/); // touch target
  });

  it('hides while the composer is focused, like every other map overlay', () => {
    expect(TRACKER).toMatch(/\{!focused && av\.action !== 'none' &&/);
  });
});

describe('confirming immediately re-reads truth so navigation flips legs', () => {
  it('the hook reloads after the call rather than moving state optimistically', () => {
    expect(HOOK).toMatch(/await call\(missionId, fix\);\s*\n\s*await reload\(\);/);
  });

  it('the tracker passes its own poll as the reload', () => {
    // Without this the driver keeps being routed to the pickup they are standing
    // at until the next 4 s poll lands.
    expect(TRACKER).toContain('useMissionAdvance(missionId, refresh)');
  });
});

describe('B-795 — the advance is single-flight and a replay is not an error', () => {
  it('guards with a synchronous ref, not state alone (two taps in one frame both read acting === false)', () => {
    expect(HOOK).toMatch(/const inFlight = useRef\(false\);/);
    expect(HOOK).toMatch(/if \(!missionId \|\| acting \|\| inFlight\.current\) \{return;\}/);
    expect(HOOK).toMatch(/inFlight\.current = true;\s*\n\s*setActing\(true\);/);
    expect(HOOK).toMatch(/finally \{ inFlight\.current = false; setActing\(false\); \}/);
  });

  it('the idempotency replay 409 is swallowed AFTER truth is re-read — the officer never reads a raw code', () => {
    const idx = HOOK.indexOf("if (code === 'idempotency_key_in_progress') {return;}");
    expect(idx).toBeGreaterThan(0);
    expect(HOOK.lastIndexOf('await reload();', idx)).toBeGreaterThan(0);
  });

  it('a 409 sentence from the server (mission ended) is shown as written, not as its code', () => {
    expect(HOOK).toMatch(/const code = body\?\.code \?\? msg;/);
    expect(HOOK).toMatch(/typeof msg === 'string' \? msg/);
  });
});

describe('B-795 — Dispatch is not a proximity action', () => {
  it('the tracker never demotes Dispatch as "far from pickup" — a crew that has not left is far by definition', () => {
    expect(TRACKER).toMatch(/const farFromPickup = av\.action !== 'finish' && av\.action !== 'dispatch'/);
    expect(TRACKER).toMatch(/const far = av\.action !== 'finish' && av\.action !== 'dispatch'/);
  });

  it('Dispatch has its own glyph, never the finish flag', () => {
    expect(TRACKER).toMatch(/if \(action === 'dispatch'\) \{return 'send';\}/);
  });
});
