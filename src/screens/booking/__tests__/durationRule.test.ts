import {
  hourlyDurationRule, clampDurationHours, HOURLY_DEFAULT_HOURS,
  transferBlockHours, TRANSFER_BLOCK_HOURS,
} from '../durationRule';
import {setServicePricingOverrides} from '../servicePricingOverrides';

/**
 * 2026-09-04 — the hourly-service duration picker reads its default and range
 * from the ops board (hourly_default_hours / hourly_min_hours / hourly_max_hours),
 * fail-open to the compiled 4 / 1..24 the server ships with. Mirrors the server's
 * resolveDurationRule sanitisation so client and server agree in every state.
 */
describe('hourlyDurationRule — ops-configurable, never a hardcoded 4', () => {
  afterEach(() => setServicePricingOverrides({}));

  it('falls back to the compiled default when nothing has hydrated', () => {
    setServicePricingOverrides({});
    expect(hourlyDurationRule()).toEqual({default: 4, min: 1, max: 24});
    expect(HOURLY_DEFAULT_HOURS).toBe(4);
  });

  it('reads the live board at CALL time', () => {
    setServicePricingOverrides({hourly_default_hours: 6, hourly_min_hours: 4, hourly_max_hours: 12});
    expect(hourlyDurationRule()).toEqual({default: 6, min: 4, max: 12});
    setServicePricingOverrides({hourly_default_hours: 8});
    expect(hourlyDurationRule()).toEqual({default: 8, min: 1, max: 24});
  });

  it('a contradictory or malformed board collapses to the compiled numbers (same rule as the server)', () => {
    setServicePricingOverrides({hourly_min_hours: 10, hourly_max_hours: 2});
    expect(hourlyDurationRule()).toEqual({default: 4, min: 1, max: 24});
    setServicePricingOverrides({hourly_default_hours: 2.5});
    expect(hourlyDurationRule()).toEqual({default: 4, min: 1, max: 24});
    setServicePricingOverrides({hourly_max_hours: 999});
    expect(hourlyDurationRule()).toEqual({default: 4, min: 1, max: 24});
  });

  it('a default outside the range is clamped into it', () => {
    setServicePricingOverrides({hourly_min_hours: 6, hourly_max_hours: 12, hourly_default_hours: 2});
    expect(hourlyDurationRule()).toEqual({default: 6, min: 6, max: 12});
  });
});

describe('clampDurationHours — the stepper can never leave the rule', () => {
  afterEach(() => setServicePricingOverrides({}));

  it('clamps into [min, max] and rounds', () => {
    setServicePricingOverrides({hourly_min_hours: 4, hourly_max_hours: 8});
    expect(clampDurationHours(2)).toBe(4);
    expect(clampDurationHours(9)).toBe(8);
    expect(clampDurationHours(6)).toBe(6);
    expect(clampDurationHours(5.6)).toBe(6);
  });

  it('a non-number becomes the default', () => {
    expect(clampDurationHours(Number.NaN)).toBe(4);
  });
});

/**
 * B-877 (founder 2026-09-14, "Confirm we can set the 4 hours per region" —
 * "Yes") — a Secure Transfer is billed as a fixed BLOCK of hours ops set PER
 * REGION, not an hourly duration the client picks. The client has no control
 * over it; this mirror only supplies the pre-hydration value so the wizard can
 * disclose the hours before the first estimate reply lands.
 */
describe('transferBlockHours — the per-region block, never a client choice', () => {
  afterEach(() => setServicePricingOverrides({}));

  it('falls back to the compiled 4 when nothing has hydrated', () => {
    setServicePricingOverrides({});
    expect(transferBlockHours()).toBe(4);
    expect(TRANSFER_BLOCK_HOURS).toBe(4);
  });

  it('reads the live board at CALL time (a region can set its own block)', () => {
    setServicePricingOverrides({transfer_block_hours: 6});
    expect(transferBlockHours()).toBe(6);
    setServicePricingOverrides({transfer_block_hours: 2});
    expect(transferBlockHours()).toBe(2);
  });

  it('a malformed or out-of-range board collapses to the compiled 4', () => {
    setServicePricingOverrides({transfer_block_hours: 3.5});
    expect(transferBlockHours()).toBe(4);
    setServicePricingOverrides({transfer_block_hours: 999});
    expect(transferBlockHours()).toBe(4);
    // priceValue itself refuses <= 0 / non-finite, so the fallback is returned.
    setServicePricingOverrides({transfer_block_hours: 0});
    expect(transferBlockHours()).toBe(4);
    setServicePricingOverrides({transfer_block_hours: Number.NaN});
    expect(transferBlockHours()).toBe(4);
  });

  it('is independent of the HOURLY keys (a transfer is not an hourly service)', () => {
    setServicePricingOverrides({hourly_default_hours: 8, hourly_min_hours: 6, hourly_max_hours: 12});
    expect(transferBlockHours()).toBe(4);
  });
});
