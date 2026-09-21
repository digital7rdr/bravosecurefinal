/**
 * 2026-09-04 — the hourly-service DURATION rule, client mirror.
 *
 * The server's `resolveDurationRule` (pricing.service.ts) is the authority: every
 * quote and create is validated there, and an off-rule value is REJECTED, never
 * repriced. This module exists so the picker can bound its stepper and pre-fill
 * the default from the SAME ops board (`hourly_default_hours` / `hourly_min_hours`
 * / `hourly_max_hours`, hydrated by servicePricingStore) instead of compiling a 4
 * the server no longer owns.
 *
 * FAIL-OPEN to the compiled numbers, exactly like the price mirrors: no hydration
 * (offline, old server, cold boot) means the picker uses 4 / 1..24, which is the
 * shipped server default, so client and server still agree. Read at CALL time —
 * never captured in a module const — because the board can hydrate after first
 * render. Pure (no RN, no zustand) so the booking Jest project can pin it.
 */
import {priceValue} from './servicePricingOverrides';

export const HOURLY_DEFAULT_HOURS = 4;
export const HOURLY_MIN_HOURS = 1;
export const HOURLY_MAX_HOURS = 24;
/** Mirrors the server's HOURLY_DURATION_HOURS_MAX / the ops BOUNDS ceiling. */
const HOURS_CEILING = 24;

export interface DurationRule {
  default: number;
  min: number;
  max: number;
}

function intInRange(v: number, lo: number, hi: number): number | null {
  return Number.isInteger(v) && v >= lo && v <= hi ? v : null;
}

/** The rule for every per-hour service. Executive Protection has its own grid. */
export function hourlyDurationRule(): DurationRule {
  let min = intInRange(priceValue('hourly_min_hours', HOURLY_MIN_HOURS), 1, HOURS_CEILING) ?? HOURLY_MIN_HOURS;
  let max = intInRange(priceValue('hourly_max_hours', HOURLY_MAX_HOURS), 1, HOURS_CEILING) ?? HOURLY_MAX_HOURS;
  if (min > max) {min = HOURLY_MIN_HOURS; max = HOURLY_MAX_HOURS;}
  let def = intInRange(priceValue('hourly_default_hours', HOURLY_DEFAULT_HOURS), 1, HOURS_CEILING) ?? HOURLY_DEFAULT_HOURS;
  if (def < min || def > max) {def = Math.min(Math.max(HOURLY_DEFAULT_HOURS, min), max);}
  return {default: def, min, max};
}

export const TRANSFER_BLOCK_HOURS = 4;

/**
 * B-877 — the hours a Secure Transfer is billed as, set by ops PER REGION
 * (`transfer_block_hours`). The client has no duration control for transfers:
 * the server resolves the block and the estimate reply carries it back, so this
 * is only the pre-hydration mirror. Read at CALL time; fail-open to the
 * compiled 4; integer 1..24, exactly like `hourlyDurationRule`.
 */
export function transferBlockHours(): number {
  return intInRange(priceValue('transfer_block_hours', TRANSFER_BLOCK_HOURS), 1, HOURS_CEILING)
    ?? TRANSFER_BLOCK_HOURS;
}

/** Clamp a stepper value into the live rule (the server still re-checks). */
export function clampDurationHours(hours: number, rule: DurationRule = hourlyDurationRule()): number {
  if (!Number.isFinite(hours)) {return rule.default;}
  return Math.max(rule.min, Math.min(rule.max, Math.round(hours)));
}
