/**
 * B-795 — three client-side rules that only hold if the source keeps them
 * (screens with Mapbox / native deps cannot be imported by this project):
 *
 *   1. Confirm & Book is SINGLE-FLIGHT via a synchronous ref (NAV loop N-rule).
 *      `submitting` is React state: two taps in one frame both read false, the
 *      loser's request then races the winner under the SAME Idempotency-Key and
 *      gets 409 `idempotency_key_in_progress` — which used to render as
 *      "Booking failed" on a booking that succeeded, inviting a retry that
 *      minted a fresh key and filed a duplicate.
 *   2. The Home hero and the auto-resume pick the same "next" booking: a row
 *      with no start_time sorts LAST on both (findResumableBooking's sentinel).
 *   3. A list row merges FIELD-WISE over the held snapshot: it carries no
 *      hourly_checkins / crew detail and shares the detail row's updated_at, so
 *      a replace stripped the Executive timeline on every Home poll.
 *
 * Comments are stripped and CRLF normalised (CLAUDE.md scan traps).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function code(rel: string): string {
  const src = readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
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

const WIZARD = code('src/screens/booking/CustomizeAddOnsScreen.tsx');
const HOME = code('src/screens/booking/BookingHomeScreen.tsx');
const STORE = code('src/store/bookingStore.ts');

describe('B-795 — Confirm & Book is single-flight', () => {
  it('a synchronous ref guards the money button and is reset in finally (E2E-36 submitGuard)', () => {
    expect(WIZARD).toMatch(/const submitGuard = useRef\(false\);/);
    expect(WIZARD).toMatch(/if \(submitGuard\.current \|\| submitting\) \{return;\}/);
    expect(WIZARD).toMatch(/submitGuard\.current = true;/);
    expect(WIZARD).toMatch(/submitGuard\.current = false;\s*\n\s*setSubmitting\(false\);/);
    expect(WIZARD).not.toMatch(/submitRef/);
  });

  it('the loser of a double-tap (idempotency replay) never shows "Booking failed"', () => {
    const idx = WIZARD.indexOf("=== 'idempotency_key_in_progress') {return;}");
    expect(idx).toBeGreaterThan(0);
    // …and it sits BEFORE the generic alert in the same catch.
    expect(WIZARD.indexOf("'Booking failed'", idx)).toBeGreaterThan(idx);
  });
});

describe('B-795 — the hero and the auto-resume agree on "next"', () => {
  it('a row with no start_time sorts LAST on Home, as in findResumableBooking', () => {
    expect(HOME).toMatch(/Number\.POSITIVE_INFINITY/);
    expect(HOME).not.toMatch(/new Date\(a\.start_time \?\? 0\)/);
  });
});

describe('B-795 — a list row never strips a richer detail row', () => {
  it('loadBookings merges detail-only fields over the held snapshot (same updated_at only)', () => {
    expect(STORE).toMatch(/s\.bookingsById\[b\.id\] = mergeListRow\(prev, b\);/);
    expect(STORE).toMatch(/const DETAIL_ONLY_KEYS = \['hourly_checkins'\] as const;/);
    expect(STORE).toMatch(/if \(!prev\?\.updated_at \|\| prev\.updated_at !== next\.updated_at\) \{return next;\}/);
  });

  it('the submit key is minted per BODY — an edited draft after a lost response is a new submission', () => {
    expect(STORE).toMatch(/const key = mintSubmitKey\(JSON\.stringify\(body\)\);/);
    expect(STORE).toMatch(/if \(!submitKey \|\| submitFingerprint !== fingerprint\) \{/);
  });
});
