/**
 * Issue 25 — every place that can be handed an "insufficient credits" failure
 * must use the ONE shared rule (creditErrors.ts), not a hand-rolled copy.
 *
 * Four copies of this check existed and three were wrong for at least one error
 * shape. That drift IS the bug: CustomizeAddOnsScreen only matched the local
 * pre-check's typed throw, so a server-side rejection fell through to a generic
 * alert that printed the raw `insufficient_credits` code.
 *
 * These are RN screens / a Zustand store the node `booking` project cannot
 * import, so the rule is pinned by reading the source — same pattern as
 * liveTrackerDockSend.test.ts.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();

const CALL_SITES = [
  ['CustomizeAddOnsScreen', join(ROOT, 'src', 'screens', 'booking', 'CustomizeAddOnsScreen.tsx')],
  ['AddOnsScreen', join(ROOT, 'src', 'screens', 'booking', 'AddOnsScreen.tsx')],
  ['OpsRoomReviewScreen', join(ROOT, 'src', 'screens', 'ops', 'OpsRoomReviewScreen.tsx')],
  ['bookingStore', join(ROOT, 'src', 'store', 'bookingStore.ts')],
  ['proPaywallFlow', join(ROOT, 'src', 'screens', 'pro', 'proPaywallFlow.ts')],
] as const;

/** CRLF-normalised and comment-stripped — these files are CRLF, and prose
 *  mentioning the code must not satisfy or break a CODE assertion. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Every `throw new BadRequestException({…})` body, brace-balanced.
 *
 * B-843 — the old `\{[\s\S]*?\}\)` regex stopped at the FIRST `})`, which after
 * A7 is a nested call argument (`{balance: have, committed})`). It therefore
 * matched a fragment and the assertions passed on it VACUOUSLY — the
 * stale-anchor class CLAUDE.md warns about. Count braces instead.
 */
function balancedThrows(src: string): string[] {
  const out: string[] = [];
  const OPEN = 'BadRequestException({';
  let i = src.indexOf(OPEN);
  while (i !== -1) {
    let depth = 0;
    let j = i + OPEN.length - 1;
    for (; j < src.length; j++) {
      if (src[j] === '{') {depth++;}
      else if (src[j] === '}') {depth--; if (depth === 0) {break;}}
    }
    out.push(src.slice(i, j + 1));
    i = src.indexOf(OPEN, j + 1);
  }
  return out;
}

describe('Issue 25 — the insufficient-credits rule has exactly one implementation', () => {
  it.each(CALL_SITES)('%s imports the shared helper', (_label, file) => {
    expect(code(file)).toMatch(/from '(\.\/|@screens\/booking\/)creditErrors';/);
  });

  it.each(CALL_SITES)('%s has no hand-rolled comparison against the raw code', (_label, file) => {
    const src = code(file);
    // Only creditErrors.ts may compare against the literal. A call site that
    // re-implements the check will drift again the moment the server changes shape.
    expect(src).not.toMatch(/[=]==\s*'insufficient_credits'/);
    expect(src).not.toMatch(/includes\('insufficient_credits'\)/);
  });

  it('CustomizeAddOnsScreen routes a short balance to CreditPaywall, not an alert', () => {
    const src = code(join(ROOT, 'src', 'screens', 'booking', 'CustomizeAddOnsScreen.tsx'));
    const start = src.indexOf('isInsufficientCreditsError(e)');
    expect(start).toBeGreaterThan(-1);
    // The branch body, up to its `return`.
    const branch = src.slice(start, src.indexOf('return;', start));
    expect(branch).toContain("navigation.navigate('CreditPaywall'");
    expect(branch).not.toContain('Alert.alert');
  });

  it('AddOnsScreen (legacy path) routes a short balance to CreditPaywall too', () => {
    const src = code(join(ROOT, 'src', 'screens', 'booking', 'AddOnsScreen.tsx'));
    const start = src.indexOf('isInsufficientCreditsError(e)');
    expect(start).toBeGreaterThan(-1);
    const branch = src.slice(start, src.indexOf('return;', start));
    expect(branch).toContain("navigation.navigate('CreditPaywall'");
  });

  it('bookingStore re-throws an error that PRESERVES the server code', () => {
    const src = code(join(ROOT, 'src', 'store', 'bookingStore.ts'));
    // The regression: `throw new Error(friendly)` dropped the structured body,
    // so every caller's `code` branch was dead.
    expect(src).not.toMatch(/throw new Error\(friendly\)/);
    expect(src).toMatch(/out\.code\s*=/);
    expect(src).toMatch(/throw out;/);
  });

  it('the server sends a structured body carrying required + the payer context', () => {
    const src = code(join(ROOT, 'apps', 'auth-service', 'src', 'booking', 'booking.service.ts'));
    const throws = balancedThrows(src).filter(t => t.includes('insufficient_credits'));
    expect(throws.length).toBe(2); // requestAuto soft-check + payWithCredits debit
    for (const t of throws) {
      expect(t).toContain('required:');
      // `message` must stay the raw code so already-shipped clients that match
      // on it keep detecting a short balance.
      expect(t).toMatch(/message:\s*'insufficient_credits'/);
      // B-843/A7 — RE-POINTED, not weakened. `balance` used to be a literal in
      // both bodies; it now comes from ONE helper, because a member must not
      // read a ROOT's balance by submitting a cheap booking (LM-B7). The
      // invariant is unchanged — the client still gets the figures it is
      // entitled to — so the pin follows the figures to their new home.
      expect(t).toContain('insufficientPayerContext(');
    }
  });

  it('the payer context gives `balance` ONLY when the payer is the caller (A7)', () => {
    const src = code(join(ROOT, 'apps', 'auth-service', 'src', 'booking', 'booking.service.ts'));
    const start = src.indexOf('private async insufficientPayerContext');
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, src.indexOf('\n  private ', start + 10));
    // Self payer: their own numbers, and the flag that keeps the client on the
    // top-up paywall.
    expect(fn).toMatch(/payer_is_self:\s*true[\s\S]{0,200}balance:/);
    // Root payer: the flag flips and NO balance is emitted — routing a member
    // to top up a wallet that is not paying is B-384's loop.
    const at = fn.indexOf('payer_is_self: false');
    // Assert the ANCHOR before slicing on it: `slice(-1)` is one character and
    // would satisfy every absence assertion below without proving anything.
    expect(at).toBeGreaterThan(-1);
    const rootBranch = fn.slice(at);
    expect(rootBranch).not.toContain('balance:');
    expect(rootBranch).not.toContain('committed:');
  });

  it('no BadRequestException still throws the bare string form', () => {
    const src = code(join(ROOT, 'apps', 'auth-service', 'src', 'booking', 'booking.service.ts'));
    expect(src).not.toMatch(/BadRequestException\('insufficient_credits'\)/);
  });
});
