/**
 * Client-side pricing preview for Lite bookings.
 *
 * Mirrors the server authority (apps/auth-service/src/booking/pricing.service.ts):
 * base rate EUR 86/hr (1 CPO · 1 Vehicle · 1 Driver), +25% of base per extra
 * CPO/vehicle, 0.65× for driver-only, add-ons summed per hour. BC is 1:1 with
 * EUR in Phase 1, so the rate is shown directly in Bravo Credits.
 *
 * This is a PREVIEW only — the authoritative total is computed server-side at
 * estimate/confirm time. Kept free of RN / zustand imports so it can be unit
 * tested without mounting a screen (mirrors creditMath.ts).
 */

// Authoritative base rate, in BC (== EUR in Phase 1). Matches BASE_RATE_EUR
// on the server. NOTE: 350 is the AED display figure, not the BC base.
export const BASE_RATE_BC = 86;

// Live ops-editable overlays (founder 2026-08-26) — compiled constants above
// stay the fail-open fallbacks; every computation reads at CALL time.
import {priceValue} from './servicePricingOverrides';
export const liveBaseRateBc = () => priceValue('transfer_base_rate_bc', BASE_RATE_BC);
export const liveAedPerBc = () =>
  priceValue('base_rate_aed', 350) / priceValue('transfer_base_rate_bc', BASE_RATE_BC);

/**
 * Canonical AED ⇄ BC ratio — mirrors the server's EUR_TO_AED = 350/86
 * (pricing.service.ts). Used to render legacy AED-denominated figures
 * (e.g. agents.rate_aed_per_hour) in BC without inventing an FX rate.
 */
export const AED_PER_BC = 350 / 86;
export const bcFromAed = (aed: number): number => Math.round(aed / liveAedPerBc());

/** Extra CPO / vehicle surcharge: 25% of base per unit beyond the baseline 1. */
export const EXTRA_UNIT_FACTOR = 0.25;

/** Driver-only (client provides vehicle) multiplier. */
export const DRIVER_ONLY_FACTOR = 0.65;

/** A standard 5-seat vehicle seats CPO + driver + 3 passengers. */
export const PASSENGERS_PER_VEHICLE = 3;

/**
 * B-876 (founder 2026-09-14: "The limit is still here") — a SANITY bound against
 * garbage input, NOT a product limit. The founder's rule is "no boundary on
 * booking" (B-864, restated here); anything beyond the baseline 1 CPO + 1
 * Vehicle is reviewed by the Bravo Control System, which is the real gate.
 *
 * Mirrors the server, which must carry the SAME number: `create-booking.dto.ts`
 * `@Max` on `cpo_count`/`vehicle_count` (both DTOs), `booking.service.ts`
 * `MAX_CPOS`, and `org.dto.ts` `AssignCrewDto @ArrayMaxSize` — a team the agency
 * could never be assigned to is a dead booking. Pinned by teamCeilingParity.
 */
export const MAX_CPOS = 50;

/** The same sanity bound for vehicles — see MAX_CPOS. */
export const MAX_VEHICLES = 50;

/**
 * B-864 — founder, 2026-09-12: "cpo now increase as per vehicle, no it should
 * not boundry on booking", answered "No vehicle but pricing should update".
 *
 * There used to be a `maxCposForClientVehicle(passengers)` here: in driver-only
 * mode the client's own 5-seater capped CPOs at `4 - passengers`, so a party of
 * four could book exactly ONE CPO and the + button died there. The server
 * mirrored it and silently repriced a bigger Lite team down to what fit. Both
 * are gone. MAX_CPOS is the only ceiling, in both modes; Bravo still assigns no
 * vehicle in driver-only mode, and what moves instead is the RATE, which
 * already charges EXTRA_UNIT_FACTOR of base per CPO past the first.
 */

/**
 * Minimum vehicles required to carry `passengers` (1 vehicle per 3 pax).
 * Always at least 1 — the baseline package includes one vehicle.
 */
export function vehiclesForPassengers(passengers: number): number {
  return Math.max(1, Math.ceil(Math.max(0, passengers) / PASSENGERS_PER_VEHICLE));
}

/**
 * B-787 — the vehicle count that should be showing, given the party size and
 * whatever the user has explicitly chosen.
 *
 * The defect this replaces: the screen raised `vehicle_count` to the
 * passenger-derived floor but never lowered it again, so the count was a
 * ONE-WAY RATCHET. Take a party from 2 passengers to 4 and the team grows to 2
 * vehicles (correct); take it back to 2 and it STAYS at 2 — the client keeps
 * paying for a vehicle the party no longer needs, while the screen's own banner
 * says "1 vehicle covers this party". Founder, 2026-09-03: _"this + sign work
 * dynamically like vehicle calculator but when do - after plus doesn't change
 * the State"_.
 *
 * The rule: an AUTO-derived count follows the party in BOTH directions. Once
 * the user has picked a number themselves it is respected — but only ever as a
 * minimum they chose, never as a floor that keeps climbing. Passing the user's
 * choice separately (rather than reading it back out of the current count) is
 * what keeps a later party change from ratcheting their number up too.
 *
 * @param chosen the count the user set on the stepper, or `null` while it is
 *               still auto-derived.
 */
export function nextVehicleCount(opts: {
  passengers: number;
  chosen: number | null;
  driverOnly: boolean;
}): number {
  // Driver-only means the client supplies the car, so Bravo assigns none.
  if (opts.driverOnly) {return 0;}
  const floor = vehiclesForPassengers(opts.passengers);
  if (opts.chosen === null) {return floor;}
  // A party can always outgrow the user's choice; it can never shrink below
  // what the passengers physically need.
  return Math.max(opts.chosen, floor);
}

/**
 * E2E-33 — the peak-hour window, mirrored from the server.
 *
 * `pricing.service.ts` applies `peak_multiplier` when the pickup falls in
 * 17:00–20:00 of the REGION's local wall clock, computed as
 * `(pickupTime.getUTCHours() + regionUtcOffsetHours(region)) % 24`. The offline
 * fallback here omitted it entirely, so a quote taken with the estimate call
 * failing under-stated an evening booking by the whole multiplier (~20 %) — the
 * client saw one number and escrow held another.
 *
 * Offsets mirror `apps/auth-service/src/common/regions.ts` DEFAULT_REGIONS. An
 * unknown region falls back to 0 (UTC), exactly as the server does; ops-added
 * regions are the server's to price, and the local number is only ever a
 * clearly-labelled offline preview.
 */
export const REGION_UTC_OFFSET_HOURS: Readonly<Record<string, number>> = {
  AE: 4, SA: 3, BD: 6, GB: 0, ZA: 2,
};

export function isPeakPickup(pickupTime: Date, regionCode?: string | null): boolean {
  if (!(pickupTime instanceof Date) || Number.isNaN(pickupTime.getTime())) {return false;}
  const offset = REGION_UTC_OFFSET_HOURS[(regionCode ?? '').trim().toUpperCase()] ?? 0;
  const hour = (pickupTime.getUTCHours() + offset + 24) % 24;
  return hour >= 17 && hour < 20;
}

/**
 * E2E-29 — the Bravo Credits figure from a `/bookings/estimate` reply.
 *
 * The server's `total` is EUR; `total_bc` is the integer BC escrow actually
 * holds (`round(total_eur / eur_per_bc)`). Everything downstream is BC — the
 * "BC" total row, `estimated_price`, the affordability check against
 * `bravo_credits`, the CreditPaywall shortfall — so the conversion happens once,
 * here, and every consumer reads through it. Falls back to `total` for an older
 * server, where the two coincide because `eur_per_bc` ships at 1.0.
 *
 * Lives in this pure module (not the store) so the node `booking` project can
 * verify it without dragging `api.ts` → `@utils/constants` → `expo/virtual/env`
 * into a node-environment suite.
 */
export function estimateBc(data: {total?: number; total_bc?: number} | null | undefined): number {
  const bc = data?.total_bc;
  if (typeof bc === 'number' && Number.isFinite(bc)) {return bc;}
  return typeof data?.total === 'number' && Number.isFinite(data.total) ? data.total : 0;
}

export interface LocalTotalInput {
  rateBc: number;
  durationHours: number;
  pickupTime: Date | null;
  regionCode?: string | null;
}

/**
 * The OFFLINE total in Bravo Credits — what to show when `/bookings/estimate`
 * could not be reached. Mirrors the server end to end: peak multiplier on the
 * hourly rate, × duration, then EUR → BC through `eur_per_bc` (which defaults
 * to 1.0, so today's numbers are byte-identical to the old `rate × hours`).
 */
export function localTotalBc({rateBc, durationHours, pickupTime, regionCode}: LocalTotalInput): number {
  const hours = Math.max(1, durationHours);
  const peak = pickupTime && isPeakPickup(pickupTime, regionCode)
    ? priceValue('peak_multiplier', 1.2)
    : 1;
  return Math.round((rateBc * peak * hours) / priceValue('eur_per_bc', 1));
}

export interface RateInput {
  cpoCount: number;
  vehicleCount: number;
  driverOnly: boolean;
  /** Sum of selected add-on per-hour prices, in BC. */
  addOnsBcPerHour: number;
}

/**
 * Hourly rate in BC for the given team composition. Rounded to a whole credit
 * to match how the rate bar is displayed. The peak surcharge is NOT folded in
 * here — it is a per-booking multiplier on the total, applied by `localTotalBc`
 * so the rate bar keeps showing the un-surcharged hourly rate the team costs.
 */
export function rateBcPerHour({cpoCount, vehicleCount, driverOnly, addOnsBcPerHour}: RateInput): number {
  // Driver-only (client vehicle): no Bravo vehicle, so no extra-vehicle
  // surcharge — matches the server normalizing vehicle_count to 0.
  const effectiveVehicles = driverOnly ? 0 : vehicleCount;
  const base = liveBaseRateBc();
  const extraFactor = priceValue('transfer_extra_unit_factor', EXTRA_UNIT_FACTOR);
  let rate = base;
  rate += Math.max(0, cpoCount - 1) * base * extraFactor;
  rate += Math.max(0, effectiveVehicles - 1) * base * extraFactor;
  if (driverOnly) {rate *= priceValue('transfer_driver_only_factor', DRIVER_ONLY_FACTOR);}
  rate += addOnsBcPerHour;
  return Math.round(rate);
}
