/**
 * B-843/A5/A6/A7 — the payer choice is WIRED at every screen that spends.
 *
 * These are RN screens the node `booking` project cannot mount, so the rules
 * are pinned by reading the source (same pattern as creditErrorCallSites).
 * What they guard:
 *
 *  · A5 — the selector exists on all three wizard screens that call
 *    `confirmBooking()` with credits, and the Continue button is gated on it.
 *  · A7 — a ROOT-short `insufficient_credits` must NOT route to CreditPaywall.
 *    The payer check therefore runs BEFORE the paywall branch: reversed, the
 *    paywall wins every time and the member tops up a wallet that is not
 *    paying (B-384's loop). Order is the whole rule, so order is asserted.
 *  · A6 — the ops-room auto-debit STOPS on a payer refusal. Its countdown and
 *    its auto-retry are both keyed on states the payer refusal does not enter,
 *    and the only way back to a charge is an explicit press that names a payer.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();

/** CRLF-normalised and comment-stripped — these files are CRLF, and prose
 *  naming a symbol must neither satisfy nor break a CODE assertion. */
function code(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const WIZARD = [
  ['CustomizeAddOnsScreen', 'src/screens/booking/CustomizeAddOnsScreen.tsx'],
  ['AddOnsScreen', 'src/screens/booking/AddOnsScreen.tsx'],
  ['ExecReviewScreen', 'src/screens/executive/ExecReviewScreen.tsx'],
] as const;

describe('A5 — the three credit-committing wizard screens mount the selector', () => {
  it.each(WIZARD)('%s imports the ONE selector and the ONE hook', (_label, rel) => {
    const src = code(rel);
    expect(src).toMatch(/import \{PayerSelector\} from '(\.\/|@screens\/booking\/)PayerSelector';/);
    expect(src).toMatch(/import \{usePayerChoice\} from '(\.\/|@screens\/booking\/)usePayerChoice';/);
  });

  it.each(WIZARD)('%s renders it, gated on having something to ask', (_label, rel) => {
    const src = code(rel);
    const gate = src.indexOf('payer.visible &&');
    expect(gate).toBeGreaterThan(-1);
    // The selector is INSIDE that gate — a wrapper (ExecReview measures it for
    // its scroll-to-blocker) may sit between them, so the window is generous
    // but still bounded to the gated block.
    expect(src.slice(gate, gate + 400)).toContain('<PayerSelector');
    // …and there is exactly one mount, so an ungated second copy cannot hide.
    expect(src.match(/<PayerSelector/g)).toHaveLength(1);
  });

  it.each(WIZARD)('%s disables its submit while the payer is unchosen', (_label, rel) => {
    const src = code(rel);
    // The gate rides the SAME expression the button already reads, so a new
    // blocker cannot be added without passing through it.
    expect(src).toMatch(/payer\.blocked/);
  });

  it.each(WIZARD)('%s asks the payer question BEFORE the top-up paywall (A7)', (_label, rel) => {
    const src = code(rel);
    const note = src.indexOf('payer.noteRefusal(e)');
    const paywall = src.indexOf('isInsufficientCreditsError(e)');
    expect(note).toBeGreaterThan(-1);
    expect(paywall).toBeGreaterThan(-1);
    // Reversed, a root-short refusal reaches CreditPaywall and the member tops
    // up a wallet that is not paying for this booking.
    expect(note).toBeLessThan(paywall);
  });

  it('ExecReview\'s blocked CTA still SCROLLS to the reason (no dead button)', () => {
    // Founder rule 2026-09-02: a blocked Continue jumps to the first unmet
    // gate and flashes it. A new blocker that is not in the chain turns the
    // button dead — which is the defect that rule exists to prevent.
    const src = code('src/screens/executive/ExecReviewScreen.tsx');
    expect(src).toMatch(/payer\.blocked \? 'payer'/);
    expect(src).toMatch(/captureY\('payer'\)/);
    expect(src).toMatch(/'schedule' \| 'pickup' \| 'transport' \| 'consent' \| 'payer'/);
  });

  it.each(WIZARD)('%s guards its money button with a SYNCHRONOUS ref (N4)', (_label, rel) => {
    // RE-POINTED (P3-13): the old alternative `if (submitting) {return;}` blessed
    // a state guard, which needs a committed re-render — exactly what a tap
    // burst outruns on a lagging JS thread, and every queued repeat here is
    // another booking. All three sites use the ref idiom now.
    const src = code(rel);
    expect(src).toMatch(/submitGuard = useRef\(false\)/);
    expect(src).toMatch(/if \(submitGuard\.current/);
    expect(src).toMatch(/submitGuard\.current = true/);
  });

  it.each(WIZARD)('%s releases that guard in `finally`, never on the success path', (_label, rel) => {
    // A throw outside `finally` latches the ref and kills the button until the
    // screen remounts (the save-contact defect, NAV runbook §8).
    const src = code(rel);
    const at = src.lastIndexOf('submitGuard.current = false');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, at - 300), at)).toContain('finally');
  });
});

/**
 * A3 — the location reporter asks the SERVER, not one membership row.
 *
 * The old pre-check read a single membership. A person on two plans whose
 * OLDEST root had them on hold was answered "held", and the client went dark
 * for six hours — while a second root was entitled to their location. The
 * server checks every root; `{reported:false}` is the only negative answer.
 */
/**
 * P0-2 — CreditPaywall is the TOP-UP screen: the wallet it just filled is the
 * member's OWN. Both of its re-fires have to say so.
 *
 * The ops-room re-fire used to send no payer at all, so the server fell back to
 * the booking's stamped root — the very account that refused. The create-path
 * re-fire re-reads `draft.payerUserId`, which after a refusal may still name
 * that root; topping up self cannot help there, so it goes back to the wizard
 * (where the selector lives) instead of re-firing.
 */
describe('P0-2 — the paywall re-fires against the member\'s OWN wallet', () => {
  const REL = 'src/screens/booking/CreditPaywallScreen.tsx';

  it('the ops-room re-fire names self, never the stamped root', () => {
    const src = code(REL);
    const args = [...src.matchAll(/bookingApi\.payWithCredits\(([^)]*)\)/g)].map(m => m[1]);
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(/,\s*selfUserId/);
  });

  it('the create-path re-fire refuses to run while a ROOT is the draft payer', () => {
    const src = code(REL);
    const start = src.indexOf('if (fromBookingFlow) {');
    expect(start).toBeGreaterThan(-1);
    const branch = src.slice(start, src.indexOf('confirmBooking()', start));
    // The guard sits BEFORE confirmBooking, or the booking re-fires at the
    // account that just refused.
    expect(branch).toMatch(/draftPayer && draftPayer !== selfUserId/);
    expect(branch).toContain('navigation.goBack()');
  });

  it('reads the member\'s own id rather than inferring "self" from an empty draft', () => {
    expect(code(REL)).toMatch(/useAuthStore\(\s*\w+\s*=>\s*\w+\.user\?\.id/);
  });
});

describe('P2-6 — the highlight is a one-shot, not a session-long sticker', () => {
  const REL = 'src/screens/settings/IndividualProfileScreen.tsx';

  it('clears focusHolderId after the first paint', () => {
    // React Navigation RETAINS params, so a card deep-linked once stays
    // highlighted for the rest of the session — and every later visit opens on
    // a highlight that no longer means anything.
    const src = code(REL);
    // Anchored on the VALUE, not on an exact call spelling: the call carries an
    // `as never` cast (untyped `useNavigation()`), and a `)`-anchored regex
    // matched nothing while the code was correct.
    expect(src).toMatch(/setParams\(\{focusHolderId: undefined\}/);
    // It must be an EFFECT, not a render-phase call.
    const at = src.indexOf('setParams({focusHolderId: undefined}');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, at - 400), at)).toMatch(/useEffect\(/);
  });

  it('still reads the param it was given', () => {
    const src = code(REL);
    expect(src).toMatch(/route\.params\?\.focusHolderId/);
    expect(src).toMatch(/<FamilyQuotaCard focusHolderId=/);
  });
});

describe('P2-9 — the new same-root accept refusal has copy', () => {
  it.each([
    ['IndividualProfileScreen', 'src/screens/settings/IndividualProfileScreen.tsx'],
    ['SecureProMembersScreen', 'src/screens/securepro/SecureProMembersScreen.tsx'],
  ])('%s maps already_in_this_family', (_label, rel) => {
    // A2 replaced the cross-root guard with a SAME-root one; without copy the
    // snake_case code reaches the invite sheet verbatim (the B-380 class).
    const src = code(rel);
    expect(src).toContain('already_in_this_family');
    expect(src).toMatch(/already a member on this account/i);
  });
});

describe('B-843 — the one-root copy is gone (the server no longer emits it)', () => {
  it.each([
    ['IndividualProfileScreen', 'src/screens/settings/IndividualProfileScreen.tsx'],
    ['SecureProMembersScreen', 'src/screens/securepro/SecureProMembersScreen.tsx'],
  ])('%s no longer maps member_in_another_family', (_label, rel) => {
    // Comment-stripped, so the note explaining WHY it went does not satisfy
    // the scan (this repo has shipped that false green before).
    expect(code(rel)).not.toContain('member_in_another_family');
  });

  it.each([
    ['IndividualProfileScreen', 'src/screens/settings/IndividualProfileScreen.tsx'],
    ['SecureProMembersScreen', 'src/screens/securepro/SecureProMembersScreen.tsx'],
  ])('%s keeps the refusals that CAN still happen', (_label, rel) => {
    // Guard against deleting the neighbours: `invite_already_pending` is the
    // same-root duplicate, which the new partial unique index still enforces.
    expect(code(rel)).toContain('invite_already_pending');
    expect(code(rel)).toContain('cannot_invite_self');
  });
});

describe('A3/P2-8 — familyPresence gates on ALL roots, with no hold logic', () => {
  // RE-POINTED. The first cut of A3 deleted the gate outright, which broke this
  // service's own promise — "a non-member's fix is never read or sent" — by
  // reading and POSTing a real GPS fix every 6 h for someone who is nobody's
  // member. The defect A3 actually named was narrower: the check read ONE row
  // and applied its own hold logic, so a person on two plans whose OLDEST root
  // held them went dark for six hours. Behavioural pins live in
  // `src/services/__tests__/familyPresence.test.ts`; these guard the shape.
  const REL = 'src/services/familyPresence.ts';

  it('asks across EVERY root, with the single read only as an old-server fallback', () => {
    const src = code(REL);
    expect(src).toMatch(/familyApi\.memberships\(/);
    const at = src.indexOf('async function activeRootCount');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 700)).toMatch(/familyApi\.membership\(/);
  });

  it('applies NO client-side hold logic — that answer belongs to the server', () => {
    // The six-hour blackout came from this file reading `heldUntil` itself.
    expect(code(REL)).not.toMatch(/heldUntil/);
  });

  it('still backs off on the server\'s own negative answer, and re-asks after it', () => {
    const src = code(REL);
    expect(src).toMatch(/familyApi\.reportLocation\(/);
    const at = src.indexOf('if (!data.reported)');
    expect(at).toBeGreaterThan(-1);
    const branch = src.slice(at, at + 300);
    expect(branch).toContain('knownMember = false');
    expect(branch).toMatch(/notMemberUntil = Date\.now\(\) \+ NOT_MEMBER_BACKOFF_MS/);
  });
});

describe('A6 — the ops-room auto-debit stops for a payer question', () => {
  const REL = 'src/screens/ops/OpsRoomReviewScreen.tsx';

  it('has its own pay state, distinct from the auto-retrying "insufficient"', () => {
    const src = code(REL);
    expect(src).toMatch(/'needs_payer'/);
  });

  it('the countdown ticker cannot run in it', () => {
    const src = code(REL);
    // The ticker returns unless the state is exactly 'countdown', so entering
    // 'needs_payer' IS the stop — no interval survives it.
    expect(src).toMatch(/if \(payState !== 'countdown'\) \{return;\}/);
  });

  it('the auto-retry effect cannot run in it either — never auto-retry a payer refusal', () => {
    const src = code(REL);
    expect(src).toMatch(/if \(payState !== 'insufficient'\) \{return;\}/);
    // The refusal must not be laundered into the auto-retrying state.
    const start = src.indexOf('const runCharge');
    const end = src.indexOf('Countdown ticker', start) > -1 ? src.indexOf('useEffect', src.indexOf('const runCharge') + 10) : src.length;
    const charge = src.slice(start, end);
    expect(charge).toContain("setPayState('needs_payer')");
  });

  it('the refusal is recognised from BOTH shapes (choice required, root short)', () => {
    const src = code(REL);
    expect(src).toMatch(/payerRefusalMessage\(/);
  });

  it('has exactly ONE charge site, and it forwards whatever payer it was given', () => {
    const src = code(REL);
    const args = [...src.matchAll(/bookingApi\.payWithCredits\(([^)]*)\)/g)].map(m => m[1]);
    // One site, so a future edit cannot add a second that forgets the payer.
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(/bookingId,\s*\w+/);
  });

  it('the AUTOMATIC debit names no payer — the booking carries its stamped one', () => {
    const src = code(REL);
    expect(src).toMatch(/void runCharge\(\);/);
  });

  it('the re-fire is a PRESS that names an account, never a timer', () => {
    const src = code(REL);
    const start = src.indexOf('const payFromChosen');
    expect(start).toBeGreaterThan(-1);
    // Bounded by the useCallback's OWN closing deps line — a wider slice picks
    // up the countdown ticker's setTimeout and the absence pin passes on the
    // wrong function (the vacuous-anchor trap).
    const end = src.indexOf('}, [', start);
    expect(end).toBeGreaterThan(start);
    const fn = src.slice(start, end);
    expect(fn).toMatch(/runCharge\(chosenPayer\)/);
    // A timer here would be an auto-retry of a refusal the member has not
    // answered yet — the exact thing A6 forbids.
    expect(fn).not.toMatch(/set(Timeout|Interval)\(/);
  });

  it('the pay button cannot fire without a chosen account', () => {
    const src = code(REL);
    expect(src).toMatch(/disabled=\{!chosenPayer/);
  });
});
