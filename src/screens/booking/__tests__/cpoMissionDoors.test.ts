/**
 * E2E-06 / E2E-14 / E2E-17 / E2E-32 / E2E-34 / E2E-45 — the operator-side doors
 * that did not exist, and the states that lied.
 *
 *   E2E-06  no client no-show path anywhere in the repo: a mission at PICKUP
 *           could only complete after go-live, so an agency that deployed a crew
 *           to an empty pickup point earned nothing and had no recourse.
 *   E2E-14  the hourly check-in writer hard-coded 'SMOOTH' while THREE UIs
 *           rendered an ISSUE branch that nothing could produce.
 *   E2E-17  a backgrounded agency silently leaves the dispatch pool in ~5 min —
 *           the ranking drops it and the expiry sweep charges decline accounting
 *           for it — while the screen kept painting a confident green "ON DUTY".
 *   E2E-32  the ops-review poll stopped after 5 minutes with no restart, so a
 *           PENDING_OPS booking (ops can take hours) froze on screen.
 *   E2E-34  a CPO decline dead-ends server-side (`agent.service.ts:1388-1394`
 *           states there is no automatic reassignment) while the copy implied
 *           it was handled.
 *   E2E-45  the advance copy is vehicle wording on a location-anchored detail.
 *
 * `missionAction.ts` and `onDutyHeartbeat`'s pure helpers are exercised
 * directly; the RN screens are read as source (CRLF-normalised, comments
 * stripped — both CLAUDE.md scan traps).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  canReportClientNoShow, missionAction, missionActionConfirm, missionActionView,
} from '../../cpo/missionAction';

const ROOT = process.cwd();
const CPO_SCREEN = join('src', 'screens', 'cpo', 'AssignedMissionDetailScreen.tsx');
const DUTY_SCREEN = join('src', 'screens', 'cpo', 'OnDutyHomeScreen.tsx');
const HEARTBEAT = join('src', 'services', 'onDutyHeartbeat.ts');
const OPS_REVIEW = join('src', 'screens', 'ops', 'OpsRoomReviewScreen.tsx');
const API = join('src', 'services', 'api.ts');

function code(rel: string): string {
  const src = readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
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

describe('the scans read real code', () => {
  it('are not vacuous', () => {
    for (const rel of [CPO_SCREEN, DUTY_SCREEN, HEARTBEAT, OPS_REVIEW, API]) {
      expect(code(rel).length).toBeGreaterThan(1_000);
      expect(code(rel)).not.toContain('\r');
    }
  });
});

// ── E2E-45 — service-aware advance copy ──────────────────────────────────────
describe('E2E-45 — an on-site detail is not asked to confirm a vehicle', () => {
  it('transport is the DEFAULT shape — every existing call site is untouched', () => {
    expect(missionActionView('DISPATCHED', true)).toMatchObject({label: 'Arrived at pickup'});
    expect(missionActionView('PICKUP', true)).toMatchObject({label: 'Client received'});
    expect(missionActionView('LIVE', true)).toMatchObject({label: 'Client Dropped Off'});
    expect(missionActionConfirm('go-live')!.cta).toBe('Client received');
    expect(missionActionConfirm('finish')!.cta).toBe('Client Dropped Off');
  });

  it('an on-site detail names what actually happens', () => {
    expect(missionActionView('DISPATCHED', true, 'on_site')).toMatchObject({label: 'Arrived on site'});
    expect(missionActionView('PICKUP', true, 'on_site')).toMatchObject({label: 'Start Protection'});
    expect(missionActionView('LIVE', true, 'on_site')).toMatchObject({label: 'End Protection'});
    expect(missionActionConfirm('go-live', 'on_site')!.body)
      .toContain('Confirm you are on site with the principal');
    expect(missionActionConfirm('go-live', 'on_site')!.body).not.toContain('vehicle');
    expect(missionActionConfirm('finish', 'on_site')!.body).not.toContain('handed over');
  });

  it('the shape changes only the WORDS — the transitions and confirms are identical', () => {
    for (const st of ['DISPATCHED', 'PICKUP', 'LIVE', 'SOS', 'COMPLETED', '']) {
      const t = missionActionView(st, true, 'transport');
      const o = missionActionView(st, true, 'on_site');
      expect(o.action).toBe(t.action);
      expect(o.confirm).toBe(t.confirm);
      expect(missionAction(st, true)).toBe(t.action);
    }
    // Finish stays the destructive one in both shapes.
    expect(missionActionConfirm('finish', 'on_site')!.destructive).toBe(true);
    expect(missionActionConfirm('go-live', 'on_site')!.destructive).toBe(false);
    expect(missionActionConfirm('start', 'on_site')).toBeNull();
    expect(missionActionConfirm('none', 'on_site')).toBeNull();
  });

  it('the CPO screen derives the shape from the booking, and confirms with it', () => {
    const src = code(CPO_SCREEN);
    // EP with NO transport leg is the on-site case; ops renders it the same way.
    expect(src).toMatch(/dep\?\.booking\?\.service === 'executive_protection' && !dep\?\.booking\?\.exec_transport/);
    expect(src).toMatch(/missionActionView\(status, isLead, missionShape\)/);
    // The confirm sheet must use the SAME shape as the button, or the officer
    // reads one sentence and taps another.
    expect(src).toMatch(/missionActionConfirm\(advance, missionShape\)/);
  });
});

// ── E2E-06 — the client no-show door ─────────────────────────────────────────
describe('E2E-06 — the lead can report a client no-show', () => {
  it('is lead-only and PICKUP-only', () => {
    expect(canReportClientNoShow('PICKUP', true)).toBe(true);
    expect(canReportClientNoShow('pickup', true)).toBe(true);
    expect(canReportClientNoShow('PICKUP', false)).toBe(false);
    for (const st of ['DISPATCHED', 'LIVE', 'SOS', 'COMPLETED', 'ABORTED', '', null, undefined]) {
      expect(canReportClientNoShow(st, true)).toBe(false);
    }
  });

  it('the endpoint exists on the agent API, idempotency-keyed', () => {
    const src = code(API);
    expect(src).toMatch(/clientNoShow: \(missionId: string, reason\?: string\)/);
    expect(src).toMatch(/\/client-no-show`/);
    expect(src).toMatch(/'Idempotency-Key': `noshow-\$\{missionId\}`/);
  });

  it('the screen guards it synchronously and resets in finally (money moves)', () => {
    const src = code(CPO_SCREEN);
    expect(src).toMatch(/const noShowGuard = useRef\(false\)/);
    expect(src).toMatch(/if \(!missionId \|\| noShowGuard\.current\) \{return;\}/);
    const submit = src.slice(src.indexOf('const submitNoShow'), src.indexOf('const reportNoShow'));
    expect(submit).toMatch(/\} finally \{[\s\S]{0,200}noShowGuard\.current = false;/);
  });

  it('confirms through @utils/alert, never react-native Alert', () => {
    const src = code(CPO_SCREEN);
    expect(src).toMatch(/import \{Alert\} from '@utils\/alert'/);
    // The react-native import here is MULTI-LINE, so a single-line regex would
    // pass vacuously (CLAUDE.md scan trap). Slice the whole import block.
    const rnImport = src.slice(src.indexOf('import {\n  View'), src.indexOf("} from 'react-native';") + 22);
    expect(rnImport).toContain("from 'react-native'");
    expect(rnImport).not.toContain('Alert');
    const confirm = src.slice(src.indexOf('const reportNoShow'), src.indexOf('const markWp'));
    expect(confirm).toContain('Client did not show?');
    expect(confirm).toMatch(/style: 'destructive'/);
  });

  it('branches on the codes the server ACTUALLY emits', () => {
    const src = code(CPO_SCREEN);
    // These three are what `agent.service.ts` throws. The first cut branched on
    // two invented codes, so every refusal fell through to a raw ISO string
    // under one wrong title — worse than having no branch at all.
    expect(src).toContain('client_no_show_too_early');
    expect(src).toContain('client_no_show_not_at_pickup');
    expect(src).toContain('client_no_show_wrong_status');
    expect(src).not.toContain('no_show_grace_not_elapsed');
    expect(src).not.toMatch(/code === 'invalid_state'/);
  });

  it('renders due_at as a human time, never a raw ISO string', () => {
    const src = code(CPO_SCREEN);
    expect(src).toMatch(/fmtTimeUtc\(raw\?\.due_at\)/);
    expect(src).toMatch(/due_at\?: string; grace_minutes\?: number; mission_status\?: string/);
    // …and says how much longer, which is the actionable part.
    expect(src).toMatch(/Math\.max\(1, Math\.ceil\(\(dueMs - Date\.now\(\)\) \/ 60_000\)\)/);
  });

  it('the not-at-pickup refusal gets its OWN title, copy and retry', () => {
    const src = code(CPO_SCREEN);
    expect(src).toContain('We can’t confirm you’re at the pickup');
    expect(src).toMatch(/location permission and a GPS signal/);
    expect(src).toMatch(/\{text: 'Try again', onPress/);
    // "Not yet" was the old single hardcoded title for every refusal.
    expect(src).not.toMatch(/Alert\.alert\(\s*'Not yet',/);
  });

  it('a fresh telemetry row is pushed BEFORE the report, and no fix rides the body', () => {
    const src = code(CPO_SCREEN);
    const submit = src.slice(src.indexOf('const submitNoShow'), src.indexOf('const submitNoShowRef'));
    // The server proves presence from mission_telemetry, and a lead waiting at a
    // pickup point is stationary — so the watcher may not have written recently.
    expect(submit).toMatch(/await pushLeadTelemetryNow\(missionId\);[\s\S]{0,200}await agentApi\.clientNoShow\(missionId\)/);
    // A body fix here would be a fee-farming primitive (post the pickup
    // coordinates the app already holds, from the depot). It must never appear.
    expect(code(API)).toMatch(/clientNoShow: \(missionId: string, reason\?: string\)/);
    const apiCall = code(API).slice(code(API).indexOf('clientNoShow:'), code(API).indexOf('respondToMission:'));
    expect(apiCall).not.toMatch(/\blat\b/);
    expect(apiCall).not.toMatch(/\blng\b/);
    expect(apiCall).toMatch(/\{reason: reason\?\.trim\(\) \|\| undefined\}/);
  });

  it('the one-shot telemetry push goes through the SAME path as the watcher', () => {
    const tele = code(join('src', 'screens', 'cpo', 'useLeadTelemetry.ts'));
    expect(tele).toMatch(/export async function pushLeadTelemetryNow\(missionId: string\): Promise<boolean>/);
    expect(tele).toMatch(/agentApi\.pushTelemetry\(missionId/);
  });

  it('the button is rendered behind the same gate the rule states', () => {
    expect(code(CPO_SCREEN)).toMatch(/\{canReportClientNoShow\(status, isLead\) && \(/);
  });
});

// ── E2E-14 — the ISSUE hourly check-in ───────────────────────────────────────
describe('E2E-14 — an hour can be reported as NOT smooth', () => {
  it('the API carries the optional status', () => {
    expect(code(API)).toMatch(/status\?: 'SMOOTH' \| 'ISSUE'/);
    expect(code(API)).toMatch(/\{hour_index: hourIndex, comment: comment\?\.trim\(\) \|\| undefined, status\}/);
  });

  it('the idempotency key includes the STATUS, or the ISSUE is swallowed', () => {
    // This route mounts the STRICT interceptor: it caches the first response for
    // 24 h and never re-invokes the handler. Keyed on (mission, hour) alone, a
    // lead who confirms "all smooth", realises it was not, and reports an issue
    // for the same hour replays the cached SMOOTH response — success on screen,
    // nothing written, nobody told. That defeats E2E-14 on its own path.
    expect(code(API))
      .toMatch(/'Idempotency-Key': `hourly-\$\{missionId\}-\$\{hourIndex\}-\$\{status \?\? 'SMOOTH'\}`/);
    expect(code(API)).not.toMatch(/`hourly-\$\{missionId\}-\$\{hourIndex\}`/);
  });

  it('the writer no longer hard-codes SMOOTH', () => {
    const src = code(CPO_SCREEN);
    expect(src).toMatch(/outcome: 'SMOOTH' \| 'ISSUE' = 'SMOOTH'/);
    expect(src).toMatch(/agentApi\.hourlyCheckin\(missionId, hourIndex, hourComment, outcome\)/);
    expect(src).toMatch(/void confirmHour\(hourIndex, 'ISSUE'\)/);
    expect(src).toMatch(/void confirmHour\(nextDueHour, 'SMOOTH'\)/);
  });

  it('an issue is confirmed and demands the note that makes it actionable', () => {
    const src = code(CPO_SCREEN);
    const report = src.slice(src.indexOf('const reportHourIssue'), src.indexOf('const noShowGuard'));
    expect(report).toMatch(/if \(!hourComment\.trim\(\)\)/);
    expect(report).toContain('Report an issue for hour');
    // It must not read as an emergency channel — SOS is the emergency channel.
    expect(report).toContain('It does not raise an SOS');
  });

  it('the two hourly writes share one synchronous guard', () => {
    const src = code(CPO_SCREEN);
    expect(src).toMatch(/const hourGuard = useRef\(false\)/);
    expect(src).toMatch(/\} finally \{ hourGuard\.current = false; setHourBusy\(false\); \}/);
  });
});

// ── E2E-34 — the decline dead-end, told honestly ─────────────────────────────
describe('E2E-34 — the decline copy stops implying reassignment is automatic', () => {
  const src = code(CPO_SCREEN);

  it('the confirm says a manager must act', () => {
    expect(src).toContain('re-assignment is NOT automatic');
    expect(src).not.toContain('Your agency will be notified to re-assign the mission.');
  });

  it('the standing banner says it too — the officer sees it after the dialog is gone', () => {
    const banner = src.slice(src.indexOf('{hasDeclined && ('), src.indexOf('{canUndoDecline && ('));
    expect(banner.length).toBeGreaterThan(100);
    // Whitespace-insensitive: the sentence must survive a JSX reflow.
    expect(banner.replace(/\s+/g, ' ')).toContain('re-assignment is not automatic');
    expect(src).not.toContain('your agency is re-assigning it');
  });
});

// ── E2E-17 — the duty link tells the truth ───────────────────────────────────
describe('E2E-17 — a backgrounded agency is no longer shown as "ON DUTY"', () => {
  const src = code(HEARTBEAT);
  const screen = code(DUTY_SCREEN);

  it('the heartbeat exposes the dispatchable state and a subscription', () => {
    expect(src).toMatch(/export function dutyLinkState\(nowMs: number = Date\.now\(\)\): DutyLinkState/);
    expect(src).toMatch(/export function subscribeDutyLink\(/);
    // Staleness is decided by the SAME rule the dispatch ranking uses.
    expect(src).toMatch(/isLocatable\(true, lastPushAt, nowMs\) \? 'live' : 'stale'/);
    expect(src).toMatch(/if \(timer === null\) \{return 'off';\}/);
    expect(src).toMatch(/if \(lastPushAt === null\) \{return 'connecting';\}/);
  });

  it('a subscriber can never break the heartbeat', () => {
    expect(src).toMatch(/try \{ cb\(\); \} catch/);
  });

  it('returning to the foreground pushes a fix immediately', () => {
    expect(src).toMatch(/export function pingOnDutyHeartbeat\(\): Promise<boolean>/);
    // Off duty is a no-op, not a stray push.
    expect(src).toMatch(/if \(timer === null\) \{return Promise\.resolve\(false\);\}/);
    expect(src).toMatch(/return pushOnce\(\);/);
    expect(screen).toMatch(/AppState\.addEventListener\('change'/);
    expect(screen).toMatch(/if \(next === 'active'\) \{ void pingOnDutyHeartbeat\(\)\.then\(syncLink\); \}/);
  });

  it('the duty card states the DISPATCHABLE truth, not the toggle position', () => {
    expect(screen).toMatch(/const dispatchable = linkState === 'live'/);
    expect(screen).toContain("'ON DUTY · NOT RECEIVING JOBS'");
    // The old unconditional green is gone.
    expect(screen).not.toMatch(/\{onDuty \? 'ON DUTY' : 'OFF DUTY'\}/);
    expect(screen).toMatch(/dispatchable \? D\.signal : D\.amber/);
  });

  it('the stale state names the cause and offers a way back', () => {
    expect(screen).toContain('Keep Bravo open on screen');
    expect(screen).toContain('Send my location now');
  });

  it('the manual re-push REPORTS failure — it is not a silent no-op', () => {
    // getFix() returns null on denied permission or a GPS timeout, which is the
    // exact state the banner is describing. Fire-and-forget made the tap look
    // identical to success while nothing left the device.
    // Comment-free assertions: the scanner strips comments, so pinning the
    // explanatory `// no fix` line would pass vacuously (CLAUDE.md trap).
    expect(src).toMatch(/async function pushOnce\(\): Promise<boolean>/);
    // The success path returns true; both the no-fix and throw paths return false.
    expect(src).toMatch(/emitLinkChange\(\);\s*\n\s*return true;/);
    expect((src.match(/return false;/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(screen).toMatch(/const pushed = await pingOnDutyHeartbeat\(\)/);
    expect(screen).toMatch(/if \(!pushed\) \{/);
    expect(screen).toContain('Couldn’t get your location');
    // Confirmed through the shared alert module, never react-native's.
    expect(screen).toMatch(/import \{Alert\} from '@utils\/alert'/);
    // …and guarded, because it is a network call behind a tappable button.
    expect(screen).toMatch(/const pingGuard = useRef\(false\)/);
    expect(screen).toMatch(/\} finally \{[\s\S]{0,120}pingGuard\.current = false;/);
  });

  it('the automatic foreground resume stays silent (no alert on every app switch)', () => {
    expect(screen).toMatch(/void pingOnDutyHeartbeat\(\)\.then\(syncLink\)/);
  });

  it('the freshness cutoff records that it mirrors the server default', () => {
    const raw = readFileSync(join(ROOT, HEARTBEAT), 'utf8');
    expect(raw).toContain('DISPATCH_LOCATION_FRESH_MINUTES');
  });

  it('the staleness tick only writes on a CHANGE (no per-tick re-render)', () => {
    expect(screen).toMatch(/return next === prev \? prev : next;/);
  });

  it('the keep-alive TODO records the decision instead of pretending to be wired', () => {
    // The reason a real foreground service was NOT reused must be readable: it
    // is the same notifee service the LEAD's mission telemetry owns.
    const raw = readFileSync(join(ROOT, HEARTBEAT), 'utf8');
    expect(raw).toContain('missionForegroundService');
    expect(raw).toMatch(/TODO\(E2E-17\)/);
  });
});

// ── E2E-32 — the ops-review poll restarts ────────────────────────────────────
describe('E2E-32 — a PENDING_OPS booking no longer freezes after 5 minutes', () => {
  const src = code(OPS_REVIEW);

  it('the poll has an explicit restart handle', () => {
    expect(src).toMatch(/const \[pollEpoch, setPollEpoch\] = useState\(0\)/);
    expect(src).toMatch(/const restartPoll = useCallback\(\(\) => setPollEpoch\(e => e \+ 1\), \[\]\)/);
    expect(src).toMatch(/\}, \[bookingId, pollEpoch\]\);/);
  });

  it('re-focusing restarts it — but ONLY after it actually gave up', () => {
    // A focus fetch has to dedupe (nav runbook N7): re-arming a healthy poll on
    // every return would tear it down and re-run it for nothing.
    expect(src).toMatch(/if \(wasBlurred\.current && gaveUpRef\.current\) \{restartPoll\(\);\}/);
    expect(src).toMatch(/return \(\) => \{ wasBlurred\.current = true; \};/);
    // And the focus effect must NOT depend on pollGaveUp: it flips false on
    // restart, which would re-run the effect, bump again, and the 5-minute cap
    // would never hold at all.
    expect(src).toMatch(/\}, \[restartPoll\]\),\s*\n?\s*\);/);
  });

  it('there is a manual affordance too, and the copy stops being a dead end', () => {
    expect(src).toMatch(/onPress=\{restartPoll\}/);
    expect(src).toContain('CHECK AGAIN');
    expect(src).toContain("we'll notify you the moment it's approved");
  });
});
