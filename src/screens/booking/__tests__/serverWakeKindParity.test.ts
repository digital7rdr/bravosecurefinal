/**
 * B-377 escape-hatch closer — server-emitted push kinds must have CLIENT handling.
 *
 * `serverWakeTapRouting` only diffs the two CLIENT maps against each other, so a
 * kind the SERVER emits with no client meta (mission-accepted/declined sat dark
 * for weeks — R-1) was invisible to every suite. This scan reads the producer
 * (booking-push-bridge) and asserts every kind it publishes is covered by:
 *   1. the wake banner map (AGENT_WAKE_META, or the hardcoded booking-approved branch),
 *   2. the bell backfill map (activitySync KIND_META),
 *   3. the tap router (fcmBootstrap).
 *
 * Static source scan (the node project can't import RN modules). Per the repo
 * scan rules: comments are STRIPPED first and reads are CRLF-safe.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Strip /* *\/ blocks and // line tails so prose can never satisfy (or fail) a scan. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(line => {
      const i = line.indexOf('//');
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join('\n');
}

/**
 * Kinds the bridge publishes. Anchored on `kind:` itself rather than "any
 * hyphenated token on a kind line", so a kind can neither be missed (making the
 * scan pass vacuously — the failure mode this suite exists to prevent) nor
 * confused with the coarse eventClass literal ('booking', 'mission', …) that
 * sits on the same line.
 *
 * Handles both shapes:
 *   {kind: 'x-y', …}
 *   {kind: cond ? 'a-b' : 'c-d', …}
 */
function serverKinds(): string[] {
  const src = stripComments(read('apps/auth-service/src/ops/booking-push-bridge.service.ts'));
  const kinds = new Set<string>();
  // Direct literal. `.` included: the enterprise join-loop kinds are dotted
  // ('enterprise.join.requested') — a hyphen-only class made them invisible to
  // this whole suite, which is exactly the vacuous pass it exists to prevent.
  for (const m of src.matchAll(/\bkind:\s*'([a-z0-9.-]+)'/g)) {kinds.add(m[1]);}
  // Ternary — capture BOTH arms.
  for (const m of src.matchAll(/\bkind:\s*[^'\n?]*\?\s*'([a-z0-9.-]+)'\s*:\s*'([a-z0-9.-]+)'/g)) {
    kinds.add(m[1]);
    kinds.add(m[2]);
  }
  return [...kinds].sort();
}

/** Keys of a `{'kebab-kind': {...}}` map between `const NAME` and its closing `};`. */
function mapKeys(rel: string, mapName: string): Set<string> {
  const src = stripComments(read(rel));
  const start = src.indexOf(`const ${mapName}`);
  if (start < 0) {throw new Error(`${mapName} not found in ${rel}`);}
  const end = src.indexOf('\n};', start);
  const block = src.slice(start, end >= 0 ? end : undefined);
  const keys = new Set<string>();
  for (const m of block.matchAll(/'([a-z0-9]+(?:[-.][a-z0-9]+)+)':\s*\{/g)) {
    keys.add(m[1]);
  }
  return keys;
}

const SERVER_KINDS = serverKinds();

describe('server push kinds ⊆ client handling (producer↔consumer parity)', () => {
  it('found a plausible number of server kinds (guard against a vacuous scan)', () => {
    expect(SERVER_KINDS.length).toBeGreaterThanOrEqual(25);
    expect(SERVER_KINDS).toContain('mission-accepted');
    expect(SERVER_KINDS).toContain('mission-declined');
    expect(SERVER_KINDS).toContain('mission-cancelled');
    expect(SERVER_KINDS).toContain('family-invite');
    expect(SERVER_KINDS).toContain('family-charge-blocked');
    // The extractor must key off `kind:`, never the coarse eventClass literal
    // that shares the line — those are NOT push kinds and would fail every map.
    expect(SERVER_KINDS).not.toContain('booking');
    expect(SERVER_KINDS).not.toContain('mission');
  });

  it('every publish() call site is covered by the extractor (no silent misses)', () => {
    // One kind per publish is the contract; if a future call site hides its kind
    // behind a variable this count diverges and the scan stops being vacuous.
    const src = stripComments(read('apps/auth-service/src/ops/booking-push-bridge.service.ts'));
    const publishCalls = [...src.matchAll(/this\.publish\(/g)].length;
    // -1: the private publish() definition itself is not a call site.
    expect(SERVER_KINDS.length).toBeGreaterThanOrEqual(publishCalls - 1);
  });

  it('every server kind has a wake-banner meta (AGENT_WAKE_META or the booking-approved branch)', () => {
    const meta = mapKeys('src/modules/messenger/push/serverWakeNotifications.ts', 'AGENT_WAKE_META');
    const missing = SERVER_KINDS.filter(k => k !== 'booking-approved' && !meta.has(k));
    expect(missing).toEqual([]);
  });

  it('every server kind has a bell-backfill meta (activitySync KIND_META) — raw-string rows are banned', () => {
    const meta = mapKeys('src/store/activitySync.ts', 'KIND_META');
    const missing = SERVER_KINDS.filter(k => !meta.has(k));
    expect(missing).toEqual([]);
  });

  it('every server kind is tap-routable (appears in fcmBootstrap routing)', () => {
    const src = stripComments(read('src/modules/messenger/push/fcmBootstrap.ts'));
    const missing = SERVER_KINDS.filter(k => !src.includes(`'${k}'`));
    expect(missing).toEqual([]);
  });
});

/**
 * B-854 — RE-POINTED for the three chained-funding kinds.
 *
 * The parity scan above is driven by the SERVER file, which lands in a separate
 * commit: until it does, the client could ship all three maps empty and every
 * assertion above would pass vacuously. These four assert the CLIENT half
 * directly, so the wake copy, the bell row and the tap route are pinned on this
 * side of the seam regardless of deploy order — which is the order the plan
 * mandates anyway (migration → server → APK).
 *
 * The four client obligations per kind (A11): a wake-banner meta, the BOOKING
 * activity-class allowlist entry, a bell meta, and a tap route.
 */
const FUNDING_KINDS = [
  'family-funding-requested',
  'family-funding-decided',
  'family-funding-changed',
] as const;

/**
 * The body of ONE `else if` branch of the tap router, bounded at the next one.
 *
 * A fixed-size `slice` does not work here and is not a theoretical worry: a
 * 1100-char window over the `family-funding-requested` branch ran on into the
 * `family-funding-decided` branch below it, so an assertion that the holder
 * route mentions `'IndividualProfile'` was satisfied by the NEXT branch's
 * route and passed vacuously — it survived a mutation that sent every holder
 * to the plan-gated screen. Anchor inside the branch that executes.
 */
function branchBody(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  expect(at).toBeGreaterThan(-1);
  const rest = src.slice(at + anchor.length);
  const end = rest.search(/\}\s*else\s+if\s*\(/);
  return rest.slice(0, end >= 0 ? end : undefined);
}

describe('B-854 — the chained-funding kinds are fully client-handled', () => {
  it('each has a wake-banner meta', () => {
    const meta = mapKeys('src/modules/messenger/push/serverWakeNotifications.ts', 'AGENT_WAKE_META');
    // Self-check: the map really parsed.
    expect(meta.has('family-quota-threshold')).toBe(true);
    expect(FUNDING_KINDS.filter(k => !meta.has(k))).toEqual([]);
  });

  it('each rides the BOOKING activity class — `family-*` has no prefix rule', () => {
    const src = stripComments(read('src/modules/messenger/push/serverWakeNotifications.ts'));
    const at = src.indexOf('const BOOKING = new Set([');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf(']);', at));
    // Self-check: a kind already in the set.
    expect(block).toContain("'family-quota-threshold'");
    expect(FUNDING_KINDS.filter(k => !block.includes(`'${k}'`))).toEqual([]);
  });

  it('each has a bell-backfill meta', () => {
    const meta = mapKeys('src/store/activitySync.ts', 'KIND_META');
    expect(meta.has('family-quota-threshold')).toBe(true);
    expect(FUNDING_KINDS.filter(k => !meta.has(k))).toEqual([]);
  });

  it('each is tap-routed, and the two sides go to DIFFERENT screens', () => {
    const src = stripComments(read('src/modules/messenger/push/fcmBootstrap.ts'));
    expect(FUNDING_KINDS.filter(k => !src.includes(`'${k}'`))).toEqual([]);
    /**
     * The HOLDER is being asked to pay. `SecureProMembers` is behind
     * `useProPlanGate`, which fails CLOSED — so a holder with no ACTIVE Secure
     * Pro plan (who can still have members: B-724 put management on the ungated
     * profile) would be bounced to the Pro sales screen, notified and unable to
     * act. The route therefore asks the SAME predicate the gate asks, and falls
     * back to the ungated surface.
     */
    const holderBlock = branchBody(src, "kind === 'family-funding-requested'");
    expect(holderBlock).toContain("'SecureProMembers'");
    expect(holderBlock).toContain("'IndividualProfile'");
    // ONE predicate, shared with the gate — not a re-derived copy of
    // `application?.status === 'ACTIVE'` that can drift away from it.
    expect(holderBlock).toContain('securePlanActive');
    expect(holderBlock).not.toMatch(/status\s*===\s*'ACTIVE'/);
    // …and the predicate must be what actually CHOOSES. A block that merely
    // mentions `securePlanActive` while routing everyone to the gated screen
    // passes every assertion above and still re-opens B-724.
    expect(holderBlock.replace(/\s+/g, ' ')).toMatch(/params: proPlan \?/);
    /**
     * The HOLDER's id addresses a ROSTER row, not a quota card. `focusRowId`
     * flows into `FamilyQuotaCard`, which lists rows where the READER is the
     * member — an `(A,B)` row whose `holder_id` is the reader can never appear
     * there, so the highlight would silently never land. The holder lanes carry
     * their own param.
     */
    expect(holderBlock).toContain('focusMemberRowId');
    expect(holderBlock).not.toContain('focusRowId:');
    // The member's own card is addressed by ROW id: a member may be under
    // several roots, so a bare landing shows a stack of look-alikes.
    const memberBlock = branchBody(src, "kind === 'family-funding-decided'");
    expect(memberBlock).toContain("screen: 'IndividualProfile'");
    expect(memberBlock).toContain('focusRowId');
    expect(memberBlock).toContain('familyRowId');
    /**
     * `family-funding-changed` reaches BOTH sides with the SAME `familyRowId`,
     * and the payload cannot say which side is reading. Both params ride: the
     * quota list only holds rows where the reader is the member and the roster
     * only holds rows where they are the holder, so one id can match in exactly
     * one of them — never both, never the wrong one.
     */
    expect(memberBlock).toContain('focusMemberRowId');
  });

  /**
   * The gate and the router must read ONE rule. `useProPlanGate` is what
   * actually bounces; if the router re-derives the same expression they can
   * drift, and the drift shows up as a tap that lands on a sales screen.
   */
  it('the Secure-Pro predicate has exactly one definition, and the gate uses it', () => {
    const store = stripComments(read('src/store/secureProStore.ts'));
    expect(store).toMatch(/export function securePlanActive\s*\(/);
    expect(store).toMatch(/export function isSecurePlanActive\s*\(/);
    const gate = stripComments(read('src/hooks/useProPlanGate.ts'));
    expect(gate).toContain('isSecurePlanActive');
    // The gate must no longer spell the rule out for itself.
    expect(gate).not.toMatch(/application\?\.status\s*===\s*'ACTIVE'/);
  });
});

