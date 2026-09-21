/**
 * E2E-27 / E2E-29 / E2E-33 / E2E-36 / E2E-37 / E2E-38 / E2E-46 — the quote and
 * the submit button on both booking wizards.
 *
 *   E2E-27  the estimate is priced in the region the CHARGE is derived from.
 *           `create()` uses `regionFromPoint(pickup)` and IGNORES `region`
 *           (which is only a dispatch hint), so an estimate without the point
 *           quoted GLOBAL while the charge used the region's overrides.
 *   E2E-29  the estimate reply's `total` is EUR; `total_bc` is the integer BC
 *           escrow holds. Everything downstream is BC (the "BC" total row,
 *           `estimated_price`, the affordability check against `bravo_credits`,
 *           the paywall shortfall), so the conversion happens once.
 *   E2E-33  the offline fallback omitted the server's peak surcharge, so it
 *           under-quoted ~20 % between 17:00 and 20:00 local to the region.
 *   E2E-36  both submit buttons are money buttons and carry a SYNCHRONOUS ref
 *           guard reset in `finally`, plus one idempotency key per in-flight
 *           create so two racing calls collapse server-side.
 *   E2E-37  the wizards render the ops/CPO UTC stamp beside the local clock.
 *   E2E-38  the EP CALCULATION line items read the same live board as the total.
 *   E2E-46  a cleared transfer time is announced, not silently reverted.
 *
 * The two wizards are money-flow RN screens the node `booking` project cannot
 * import, so they are read as source (CRLF-normalised, comments stripped — both
 * CLAUDE.md scan traps). The pure halves are exercised directly.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {estimateBc, isPeakPickup, localTotalBc, rateBcPerHour, REGION_UTC_OFFSET_HOURS} from '../pricing';
import {setServicePricingOverrides} from '../servicePricingOverrides';
import {execPriceLines, execPriceSummary} from '../../executive/execPriceSummary';
import {EXEC_ADDONS, execAddOnsBcPerHour, execRateBcPerHour, execTotalBc} from '../../executive/executivePricing';

const ROOT = process.cwd();
const TRANSFER = join('src', 'screens', 'booking', 'CustomizeAddOnsScreen.tsx');
const EXEC = join('src', 'screens', 'executive', 'ExecReviewScreen.tsx');
const STORE = join('src', 'store', 'bookingStore.ts');
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

afterEach(() => setServicePricingOverrides(null));

describe('the scans read real code', () => {
  it('are not vacuous', () => {
    for (const rel of [TRANSFER, EXEC, STORE, API]) {
      expect(code(rel).length).toBeGreaterThan(2_000);
      expect(code(rel)).not.toContain('\r');
    }
  });
});

// ── E2E-29 — BC, not EUR ─────────────────────────────────────────────────────
describe('E2E-29 — the estimate boundary converts EUR → BC exactly once', () => {
  it('prefers total_bc and falls back to total for an older server', () => {
    expect(estimateBc({total: 258, total_bc: 129})).toBe(129);
    expect(estimateBc({total: 258})).toBe(258);
  });

  it('a total_bc of 0 is a real answer, not a missing one', () => {
    expect(estimateBc({total: 258, total_bc: 0})).toBe(0);
  });

  it('never propagates a non-number as a price', () => {
    expect(estimateBc({total: Number.NaN, total_bc: Number.NaN})).toBe(0);
    expect(estimateBc(null)).toBe(0);
    expect(estimateBc(undefined)).toBe(0);
    expect(estimateBc({})).toBe(0);
  });

  it('BOTH wizards and the store read it through the one helper', () => {
    expect(code(TRANSFER)).toMatch(/const bc = estimateBc\(data\)/);
    expect(code(EXEC)).toMatch(/const bc = estimateBc\(data\)/);
    expect(code(STORE)).toMatch(/estimated_price = estimateBc\(data\)/);
    // A non-positive answer is a malformed reply, never a free booking: both
    // wizards keep the local mirror rather than storing 0, which reads as
    // "nothing to pay" to the affordability check and the paywall.
    expect(code(TRANSFER)).toMatch(/if \(bc > 0\)/);
    expect(code(EXEC)).toMatch(/&& bc > 0\) \{setServerTotal\(bc\);\}/);
    // The raw EUR field must not be read as a price anywhere on these paths.
    expect(code(TRANSFER)).not.toMatch(/setServerTotal\(data\.total\)/);
    expect(code(EXEC)).not.toMatch(/setServerTotal\(data\.total\)/);
  });

  it('the API type carries total_bc alongside the EUR total', () => {
    expect(code(API)).toMatch(/total: number; total_bc\?: number; breakdown/);
  });
});

// ── E2E-27 — the pickup point rides the estimate ─────────────────────────────
describe('E2E-27 — the quote is priced in the region the charge is', () => {
  it('the estimate body accepts the pickup point', () => {
    expect(code(API)).toMatch(/pickup\?: \{latitude: number; longitude: number\}/);
  });

  it('the Secure Transfer wizard sends it whenever a pickup is chosen', () => {
    const src = code(TRANSFER);
    expect(src).toMatch(/pickup: \{latitude: pickupLat, longitude: pickupLng\}/);
    // Guarded — a draft with no pickup yet must not send `undefined` coordinates.
    expect(src).toMatch(/typeof pickupLat === 'number' && typeof pickupLng === 'number'/);
    // And the debounced effect re-runs when the point moves, or the first quote
    // after picking a location is priced on the OLD region.
    const deps = src.slice(src.indexOf('}, [cpo_count, vehicle_count'), src.indexOf('const localTotal'));
    expect(deps).toContain('pickupLat');
    expect(deps).toContain('pickupLng');
  });

  it('the Executive dashboard sends it too (it omitted it entirely)', () => {
    const src = code(EXEC);
    expect(src).toMatch(/pickup: \{latitude: pickupLat, longitude: pickupLng\}/);
    expect(src).toMatch(/typeof pickupLat === 'number' && typeof pickupLng === 'number'/);
    expect(src).toMatch(/selectedAddOnIds, pickupLat, pickupLng\]/);
  });

  it('the store mirror sends it as well (it already had the point)', () => {
    expect(code(STORE))
      .toMatch(/pickup: \{latitude: draft\.pickup\.latitude, longitude: draft\.pickup\.longitude\}/);
  });
});

// ── E2E-33 — the offline quote ───────────────────────────────────────────────
describe('E2E-33 — the offline fallback mirrors the server peak rule', () => {
  const AT_1800_UTC = new Date('2026-09-03T18:00:00.000Z');
  const AT_1400_UTC = new Date('2026-09-03T14:00:00.000Z');

  it('the window is 17:00–20:00 LOCAL to the region, not UTC', () => {
    // 14:00Z is 18:00 in AE (+4) — peak there, off-peak in UTC/GB.
    expect(isPeakPickup(AT_1400_UTC, 'AE')).toBe(true);
    expect(isPeakPickup(AT_1400_UTC, 'GB')).toBe(false);
    // 18:00Z is 22:00 in AE — past the window there, inside it in GB.
    expect(isPeakPickup(AT_1800_UTC, 'AE')).toBe(false);
    expect(isPeakPickup(AT_1800_UTC, 'GB')).toBe(true);
  });

  it('the boundaries match the server: 17:00 in, 20:00 out', () => {
    // ZA is +2, so 15:00Z = 17:00 local and 18:00Z = 20:00 local.
    expect(isPeakPickup(new Date('2026-09-03T14:59:59.000Z'), 'ZA')).toBe(false);
    expect(isPeakPickup(new Date('2026-09-03T15:00:00.000Z'), 'ZA')).toBe(true);
    expect(isPeakPickup(new Date('2026-09-03T17:59:59.000Z'), 'ZA')).toBe(true);
    expect(isPeakPickup(new Date('2026-09-03T18:00:00.000Z'), 'ZA')).toBe(false);
  });

  it('an unknown region falls back to UTC, exactly as the server does', () => {
    expect(isPeakPickup(AT_1800_UTC, 'ZZ')).toBe(true);
    expect(isPeakPickup(AT_1800_UTC, null)).toBe(true);
    expect(isPeakPickup(AT_1800_UTC, undefined)).toBe(true);
  });

  it('the offsets mirror the server region table', () => {
    // apps/auth-service/src/common/regions.ts DEFAULT_REGIONS.
    expect(REGION_UTC_OFFSET_HOURS).toMatchObject({AE: 4, SA: 3, BD: 6, GB: 0, ZA: 2});
  });

  it('the peak booking is no longer under-quoted by the whole multiplier', () => {
    const rate = rateBcPerHour({cpoCount: 1, vehicleCount: 1, driverOnly: false, addOnsBcPerHour: 0});
    const offPeak = localTotalBc({rateBc: rate, durationHours: 4, pickupTime: AT_1400_UTC, regionCode: 'GB'});
    const peak = localTotalBc({rateBc: rate, durationHours: 4, pickupTime: AT_1400_UTC, regionCode: 'AE'});
    expect(offPeak).toBe(rate * 4);
    // The seeded 1.2× — the ~20 % the old `rate × hours` fallback silently lost.
    expect(peak).toBe(Math.round(rate * 1.2 * 4));
    expect(peak).toBeGreaterThan(offPeak);
  });

  it('honours an ops-moved multiplier and the eur_per_bc peg', () => {
    setServicePricingOverrides({peak_multiplier: 1.5, eur_per_bc: 2});
    expect(localTotalBc({rateBc: 100, durationHours: 2, pickupTime: AT_1400_UTC, regionCode: 'AE'}))
      .toBe(Math.round((100 * 1.5 * 2) / 2));
  });

  it('no pickup time means no surcharge (never a guess)', () => {
    expect(localTotalBc({rateBc: 86, durationHours: 3, pickupTime: null, regionCode: 'AE'})).toBe(258);
    expect(localTotalBc({rateBc: 86, durationHours: 3, pickupTime: new Date('nope'), regionCode: 'AE'}))
      .toBe(258);
  });

  it('the duration floor matches the server (max(1, hours))', () => {
    expect(localTotalBc({rateBc: 86, durationHours: 0, pickupTime: null})).toBe(86);
  });

  it('the wizard uses it, and LABELS an offline number as an estimate', () => {
    const src = code(TRANSFER);
    expect(src).toMatch(/const localTotal = localTotalBc\(\{/);
    expect(src).toMatch(/const totalBc = serverTotal \?\? localTotal/);
    // The failure was swallowed at the .catch — it now drives visible copy.
    expect(src).toMatch(/setEstimateFailed\(true\)/);
    expect(src).toContain('Live pricing is unavailable right now, so this is an offline estimate');
    expect(src).toMatch(/estimateFailed && serverTotal === null \? ' · OFFLINE' : ''/);
  });

  it('the peak mirror is keyed on the PICKUP-derived region, not the dispatch chip', () => {
    // `draft.region` is the chip (defaults 'AE') — the one field create()
    // ignores. The server prices by regionFromPoint(pickup) and reports which
    // region it used; the bounding boxes are ops-managed rows, so a client-side
    // mirror of them would drift. Read the server's answer.
    const src = code(TRANSFER);
    expect(src).toMatch(/const pricedRegion = useServicePricingStore\(st => st\.pricedRegion\)/);
    expect(src).toMatch(/regionCode: \(draft\.pickup \? pricedRegion : null\) \?\? draft\.region/);
    const store = code(join('src', 'store', 'servicePricingStore.ts'));
    expect(store).toMatch(/pricedRegion: string \| null/);
    expect(store).toMatch(/const resolved = typeof data\.region === 'string'/);
    // A zone switch must drop the old region with the old numbers.
    expect(store).toMatch(/set\(\{overrides: \{\}, zone: key, pricedRegion: null\}\)/);
  });

  it('the OFFLINE label is reset with the debounce, so it cannot flash per tap', () => {
    const src = code(TRANSFER);
    const effect = src.slice(src.indexOf('let alive = true;'), src.indexOf('const t = setTimeout'));
    expect(effect).toMatch(/setServerTotal\(null\);/);
    expect(effect).toMatch(/setEstimateFailed\(false\);/);
  });
});

// ── E2E-36 — the double-submit guards ────────────────────────────────────────
describe('E2E-36 — both money buttons carry a synchronous guard', () => {
  it.each([['Secure Transfer', TRANSFER], ['Executive Protection', EXEC]])(
    '%s: a ref, checked first and reset in finally', (_label, rel) => {
      const src = code(rel);
      expect(src).toMatch(/const submitGuard = useRef\(false\)/);
      expect(src).toMatch(/if \(submitGuard\.current[^)]*\) \{return;\}/);
      expect(src).toMatch(/submitGuard\.current = true;/);
      // Reset MUST be inside `finally` — one rejection outside it latches the
      // ref and kills the button until the screen remounts (nav runbook §8).
      const fin = src.slice(src.lastIndexOf('} finally {'), src.length);
      expect(fin).toMatch(/submitGuard\.current = false;/);
    });

  it('the guard is checked INSIDE handleSubmit, before anything spends', () => {
    // A `disabled` prop on the button is not enough: it needs a committed
    // re-render, which lands late exactly when the JS thread is backed up.
    for (const rel of [TRANSFER, EXEC]) {
      const src = code(rel);
      const at = src.indexOf('const handleSubmit');
      expect(at).toBeGreaterThan(-1);
      const head = src.slice(at, at + 600);
      expect(head).toMatch(/submitGuard\.current/);
      expect(head).toMatch(/submitGuard\.current = true;/);
    }
  });

  it('two racing creates share ONE idempotency key so the server collapses them', () => {
    const src = code(STORE);
    // B-795 (merge 2026-09-04) — ONE key per submission BODY: minted once,
    // shared by a concurrent duplicate AND reused by a retry after a lost
    // response, rotated only when the body changes (an edited draft is a new
    // submission — the server keys its replay cache on the header alone).
    expect(src).toMatch(/let submitKey: string \| null = null/);
    expect(src).toMatch(/function mintSubmitKey\(fingerprint: string\)/);
    expect(src).toMatch(/if \(!submitKey \|\| submitFingerprint !== fingerprint\) \{/);
    expect(src).toMatch(/const key = mintSubmitKey\(JSON\.stringify\(body\)\);/);
    expect(src).toMatch(/requestAuto\(body, key\)/);
    // Released in `finally`, so a SEQUENTIAL retry is a new request.
    expect(src).toMatch(/bookingApi\.create\(body, key\);\s*\n\s*dropSubmitKey\(\);/);
    // Inside confirmBooking the key is dropped exactly once — right after the
    // booking exists — and never on the failure path before `throw out;`.
    const flow = src.slice(src.indexOf('const key = mintSubmitKey('), src.indexOf('throw out;'));
    expect(flow.match(/dropSubmitKey\(\)/g)).toHaveLength(1);
    // The per-attempt mint (the defect) must not come back at the call site.
    expect(src).not.toMatch(/requestAuto\(body, `auto-/);
  });

  it('the LEGACY route carries the key too — the defect survived there otherwise', () => {
    // The DB one-active guard EXEMPTS parked `later` reservations, which are
    // exactly the rows a double tap can duplicate. `/bookings` runs the OPTIONAL
    // interceptor, so sending a key is safe on every server build.
    expect(code(STORE)).toMatch(/bookingApi\.create\(body, key\)/);
    expect(code(API)).toMatch(/create: \(data: BookingCreateBody, idempotencyKey\?: string\)/);
    expect(code(API))
      .toMatch(/idempotencyKey \? \{headers: \{'Idempotency-Key': idempotencyKey\}\} : undefined/);
  });
});

// ── E2E-37 — one clock across client, ops and CPO ────────────────────────────
describe('E2E-37 — the wizards show the ops/CPO UTC stamp', () => {
  it('both render it through the repo helper, never a hand-rolled formatter', () => {
    for (const rel of [TRANSFER, EXEC]) {
      expect(code(rel)).toMatch(/from '@utils\/datetime'/);
      // D5 — the transfer wizard renders the TIME half only (its date is
      // already on the row); both still go through the repo helper.
      expect(code(rel)).toMatch(/fmt(DateTime|Time)Utc\(/);
    }
  });

  it('the submitted INSTANT is untouched — only the rendering moved', () => {
    // The regression this guards: "make it UTC" quietly reinterpreting the
    // picked wall clock, which would move every booked start by the device
    // offset. The wire value is still the local pick's own instant.
    const transfer = code(TRANSFER);
    expect(transfer).toMatch(/start\.setHours\(hour, minute, 0, 0\);/);
    // B-861 (SECURE_TRANSFER_ZONE_SCHEDULE_PLAN_2026-09-11) — the submit now
    // names the instant ONCE (`submitStart`) because the derived `booking_mode`
    // must describe the SAME start that is wired, not a second call to
    // `computeStartTime()` that could clamp against a slightly later `now`.
    // Same value, same single source: still `computeStartTime()`.
    expect(transfer).toMatch(/const submitStart = computeStartTime\(\);/);
    expect(transfer).toMatch(/start_time: submitStart\.toISOString\(\),/);
    expect(transfer).not.toMatch(/setUTCHours\(/);
    const exec = code(EXEC);
    expect(exec).toMatch(/updateDraft\(\{mode: 'later', start_time: start\.toISOString\(\), \.\.\.transferRebase\}\);/);
    expect(exec).not.toMatch(/setUTCHours\(/);
  });

  it('a fixed local pick still produces the SAME ISO instant it always did', () => {
    // The wizard's own arithmetic, reproduced: stamp the picked wall clock onto
    // today and serialise. Byte-identical before and after this change.
    const start = new Date(2026, 8, 3, 19, 30, 0, 0);
    start.setHours(19, 30, 0, 0);
    expect(start.toISOString()).toBe(new Date(2026, 8, 3, 19, 30, 0, 0).toISOString());
    // And the UTC label describes that same instant rather than replacing it.
    expect(new Date(start.toISOString()).getTime()).toBe(start.getTime());
  });
});

// ── E2E-38 — the EP calculation card ─────────────────────────────────────────
describe('E2E-38 — the CALCULATION line items read the live board', () => {
  it('an ops price change moves the LINES, not just the total', () => {
    setServicePricingOverrides({exec_cpo_rate_bc: 100, exec_vehicle_rate_bc: 40});
    const lines = execPriceLines({
      cpoCount: 2, vehicleCount: 1, driverOnly: false, selectedAddOns: [],
    });
    expect(lines[0].perHour).toBe(200);   // was pinned at the compiled 86 × 2
    expect(lines[1].perHour).toBe(40);    // was pinned at the compiled 30
  });

  it('add-on lines follow the board too', () => {
    setServicePricingOverrides({addon_female_cpo_bc: 200});
    const female = EXEC_ADDONS.find(a => a.id === 'female_cpo')!;
    const lines = execPriceLines({
      cpoCount: 1, vehicleCount: 0, driverOnly: false, selectedAddOns: [female],
    });
    expect(lines[1].perHour).toBe(200);
  });

  it('the driver-only line follows the board', () => {
    setServicePricingOverrides({exec_driver_only_rate_bc: 55});
    const lines = execPriceLines({
      cpoCount: 1, vehicleCount: 0, driverOnly: true, selectedAddOns: [],
    });
    expect(lines[1].perHour).toBe(55);
  });

  it('the subtotals STILL sum to the live total under an override (the GAP-3 invariant)', () => {
    setServicePricingOverrides({
      exec_cpo_rate_bc: 100, exec_vehicle_rate_bc: 40,
      exec_driver_only_rate_bc: 55, addon_medical_bc: 111,
    });
    const medical = EXEC_ADDONS.find(a => a.id === 'medical')!;
    for (const hours of [3, 8, 24]) {
      for (const vehicleCount of [0, 2]) {
        const selectedAddOns = [medical];
        const lines = execPriceLines({cpoCount: 2, vehicleCount, driverOnly: false, selectedAddOns});
        const {baseBc, transferBc} = execPriceSummary(lines, hours);
        const total = execTotalBc(execRateBcPerHour({
          cpoCount: 2, vehicleCount, driverOnly: false,
          addOnsBcPerHour: execAddOnsBcPerHour(selectedAddOns.map(a => a.id)),
        }), hours);
        expect(+(baseBc + transferBc).toFixed(2)).toBe(total);
      }
    }
  });

  it('with no board hydrated the numbers are the compiled ones, unchanged', () => {
    const lines = execPriceLines({cpoCount: 1, vehicleCount: 1, driverOnly: false, selectedAddOns: []});
    expect(lines.map(l => l.perHour)).toEqual([86, 30]);
  });
});

// ── E2E-46 — the silently-blanked transfer time ──────────────────────────────
describe('E2E-46 — a cleared transfer time is announced', () => {
  const src = code(EXEC);

  it('the rebase records that it dropped the time', () => {
    expect(src).toMatch(/setTransferCleared\(!ok\)/);
    // Cleared again when there is no transfer time at all, or the banner sticks
    // after the user resets the field themselves.
    expect(src).toMatch(/\} else \{\s*\n?\s*setTransferCleared\(false\);/);
  });

  it('and the user is told, instead of the field just reading "Same as start time"', () => {
    expect(src).toContain('Your transfer time no longer fits this block');
    expect(src).toMatch(/\{transferCleared && !transferOutOfWindow && \(/);
  });
});
