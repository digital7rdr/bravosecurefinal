import {readFileSync} from 'fs';
import {join} from 'path';

/**
 * FSM defense-in-depth — every mission-status writer routes through
 * missionFsm.assert, so the MissionStateMachine is the single source of truth and a
 * future table change can't leave a raw writer silently drifted. The crew-forward
 * flips are AGENT-attributed (gated by requireLead); the SYSTEM sweeps are aborts.
 * Source scans — these live across services the node Jest project can't co-mount.
 *
 * NOTE (critic 2026-08-28): the mission-lead flips assert with actor 'AGENT', NOT
 * 'SYSTEM'. Asserting them as SYSTEM would demand adding SYSTEM crew-forward rows to
 * the FSM, which deletes the "SYSTEM cannot fabricate crew progress" invariant
 * (mission-state-machine.service.spec.ts). Keep them AGENT.
 *
 * 2026-09-04 — CREWED sits before DISPATCHED. Every SYSTEM abort that could meet
 * a crewed-but-not-dispatched mission must assert CREWED too, or the abort
 * matches 0 rows and the crew stays "busy" forever (the orphan class the
 * drift-janitor exists for). The explicit Dispatched action is a new writer and
 * is pinned here as well.
 */
const root = join(__dirname, '..');
const strip = (p: string) =>
  readFileSync(join(root, p), 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('FSM writer coverage — every mission-status writer asserts the transition', () => {
  it('mission-lead crew-forward flips assert AGENT (DISPATCHED→PICKUP, PICKUP→LIVE)', () => {
    const src = strip('agents/mission-lead.service.ts');
    expect(src).toMatch(/missionFsm\.assert\('DISPATCHED',\s*'PICKUP',\s*'AGENT'\)/);
    expect(src).toMatch(/missionFsm\.assert\('PICKUP',\s*'LIVE',\s*'AGENT'\)/);
    // Must NOT assert these as SYSTEM (that would need a forbidden FSM row).
    expect(src).not.toMatch(/missionFsm\.assert\('(DISPATCHED|PICKUP)',\s*'(PICKUP|LIVE)',\s*'SYSTEM'\)/);
    // And a telemetry/waypoint flip may never advance a CREWED mission — arriving
    // before being dispatched is exactly the lie the new state exists to prevent.
    expect(src).not.toMatch(/status = 'CREWED'/);
  });

  it('the explicit Dispatched action asserts AGENT CREWED→DISPATCHED and is guarded on CREWED only', () => {
    const src = strip('agents/agent.service.ts');
    expect(src).toMatch(/missionFsm\.assert\('CREWED',\s*'DISPATCHED',\s*'AGENT'\)/);
    // The race-safe enforcement is the conditional UPDATE — status = 'CREWED' — and
    // dispatched_at is COALESCE'd so a duplicate can never move the stamp.
    expect(src).toMatch(/SET status = 'DISPATCHED',[\s\S]{0,80}dispatched_at = COALESCE\(dispatched_at, NOW\(\)\)[\s\S]{0,120}WHERE id = \$1 AND status = 'CREWED'/);
  });

  it('arrival-noshow sweep asserts SYSTEM→ABORTED for BOTH crewed states', () => {
    const src = strip('dispatch/arrival-noshow.service.ts');
    expect(src).toMatch(/for \(const from of \['CREWED',\s*'DISPATCHED'\][\s\S]{0,120}missionFsm\.assert\(from[\s\S]{0,40}'ABORTED',\s*'SYSTEM'\)/);
    expect(src).toMatch(/UPDATE missions SET status = 'ABORTED'[\s\S]{0,80}status IN \('CREWED','DISPATCHED'\)/);
  });

  it('org-mission rollback asserts SYSTEM→ABORTED from CREWED (a fresh assign is never past it)', () => {
    const src = strip('org/org-mission.service.ts');
    expect(src).toMatch(/missionFsm\.assert\('CREWED',\s*'ABORTED',\s*'SYSTEM'\)/);
    expect(src).toMatch(/WHERE id = \$1 AND status = 'CREWED' AND pickup_at IS NULL/);
  });

  it('org-mission crew-assign creates the mission CREWED, never DISPATCHED', () => {
    const src = strip('org/org-mission.service.ts');
    expect(src).toMatch(/INSERT INTO missions \(booking_id, status, short_code\)[\s\S]{0,60}'CREWED'/);
    expect(src).not.toMatch(/INSERT INTO missions \(booking_id, status, short_code\)[\s\S]{0,60}'DISPATCHED'/);
  });

  // E2E-06 / E2E-13 — two writers landed in agent.service.ts after the original sweep.
  // Both are SYSTEM: the lead REQUESTS a no-show but the server performs the abort (the
  // FSM has no AGENT→ABORTED row and must not grow one), and the EP block-end close has
  // no user at all.
  it('client-no-show asserts SYSTEM→ABORTED, with an UNCAST literal the scan can see', () => {
    const src = strip('agents/agent.service.ts');
    // Written `'PICKUP'`, never `'PICKUP' as MissionStatus` — a cast slips straight past
    // this regex and the writer would sit here unpinned while looking pinned.
    expect(src).toMatch(/missionFsm\.assert\('PICKUP',\s*'ABORTED',\s*'SYSTEM'\)/);
    expect(src).not.toMatch(/missionFsm\.assert\('PICKUP'\s+as\s+\w+/);
    // A guard may not abort a mission by fiat.
    expect(src).not.toMatch(/missionFsm\.assert\('PICKUP',\s*'ABORTED',\s*'AGENT'\)/);
  });

  it('the EP block-end system close asserts SYSTEM→COMPLETED from LIVE only', () => {
    const src = strip('agents/agent.service.ts');
    expect(src).toMatch(/missionFsm\.assert\('LIVE',\s*'COMPLETED',\s*'SYSTEM'\)/);
    // Never SOS: a timer may not quietly close a mission in an active emergency.
    expect(src).not.toMatch(/missionFsm\.assert\('SOS',\s*'COMPLETED',\s*'SYSTEM'\)/);
  });

  it('booking client-cancel asserts SYSTEM→ABORTED for ALL THREE declared froms', () => {
    const src = strip('booking/booking.service.ts');
    // Loop over ['CREWED','DISPATCHED','PICKUP'] asserting each as SYSTEM→ABORTED.
    expect(src).toMatch(/for \(const from of \['CREWED',\s*'DISPATCHED',\s*'PICKUP'\][\s\S]{0,120}missionFsm\.assert\(from[\s\S]{0,40}'ABORTED',\s*'SYSTEM'\)/);
    expect(src).toMatch(/end_reason = 'client_cancel'[\s\S]{0,80}status IN \('CREWED','DISPATCHED','PICKUP'\)/);
  });

  it('the drift janitor heals CREWED orphans too', () => {
    const src = strip('ops/mission-drift-janitor.service.ts');
    expect((src.match(/status IN \('CREWED','DISPATCHED','PICKUP','LIVE','SOS'\)/g) ?? []).length).toBe(2);
  });
});
