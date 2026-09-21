import {
  DEFAULT_SERVICE_PRICING, EXEC_DURATION_GRID, resolveDurationHours, resolveDurationRule,
  isTransferBlockService, resolveTransferBlockHours,
  type ServicePricingConfig,
} from './pricing.service';
import {OpsServicePricingController} from '../ops/ops-service-pricing.controller';

/** 2026-09-04 — the pure duration rule every quote and create is validated against. */
const cfg = (over: Partial<ServicePricingConfig> = {}): ServicePricingConfig => ({...DEFAULT_SERVICE_PRICING, ...over});

describe('resolveDurationRule', () => {
  // RE-POINTED 2026-09-14 (B-877), not weakened: Secure Transfer is no longer an
  // hourly service — it is billed as a per-region block, and its own collapse is
  // pinned in the B-877 block below. The hourly rule itself is unchanged, so the
  // same assertions now ride on a service that still HAS an hourly stepper.
  it('ships byte-identical to the historic behaviour: default 4, range 1..24', () => {
    expect(resolveDurationRule('close_protection', cfg())).toEqual({default: 4, min: 1, max: 24});
  });

  it('reads the ops board for every hourly service', () => {
    const board = cfg({hourly_default_hours: 6, hourly_min_hours: 4, hourly_max_hours: 12});
    for (const service of ['recon_team', 'close_protection', 'residential_security']) {
      expect(resolveDurationRule(service, board)).toEqual({default: 6, min: 4, max: 12});
    }
  });

  it('Executive Protection is the fixed 3..24 grid in 3-hour blocks and ignores the hourly keys', () => {
    const r = resolveDurationRule('executive_protection', cfg({hourly_default_hours: 6, hourly_min_hours: 1, hourly_max_hours: 5}));
    expect(r).toEqual({default: 3, min: 3, max: 24, fixedGrid: EXEC_DURATION_GRID});
  });

  it('a malformed board falls back to the compiled numbers (min > max, zero, fraction, huge)', () => {
    expect(resolveDurationRule('close_protection', cfg({hourly_min_hours: 10, hourly_max_hours: 2}))).toEqual({default: 4, min: 1, max: 24});
    expect(resolveDurationRule('close_protection', cfg({hourly_default_hours: 0}))).toEqual({default: 4, min: 1, max: 24});
    expect(resolveDurationRule('close_protection', cfg({hourly_default_hours: 2.5}))).toEqual({default: 4, min: 1, max: 24});
    expect(resolveDurationRule('close_protection', cfg({hourly_max_hours: 999}))).toEqual({default: 4, min: 1, max: 24});
  });

  it('a default outside the range is clamped into it', () => {
    expect(resolveDurationRule('close_protection', cfg({hourly_min_hours: 6, hourly_max_hours: 12, hourly_default_hours: 2}))).toEqual({default: 6, min: 6, max: 12});
    expect(resolveDurationRule('close_protection', cfg({hourly_min_hours: 1, hourly_max_hours: 3, hourly_default_hours: 20}))).toEqual({default: 3, min: 1, max: 3});
  });
});

describe('resolveDurationHours', () => {
  const hourly = {default: 4, min: 2, max: 8};

  it('absent → the default; a legal integer → itself', () => {
    expect(resolveDurationHours(undefined, hourly)).toEqual({ok: true, hours: 4});
    expect(resolveDurationHours(null, hourly)).toEqual({ok: true, hours: 4});
    expect(resolveDurationHours(6, hourly)).toEqual({ok: true, hours: 6});
    expect(resolveDurationHours(2, hourly)).toEqual({ok: true, hours: 2});
    expect(resolveDurationHours(8, hourly)).toEqual({ok: true, hours: 8});
  });

  it('rejects out-of-range and fractional values instead of clamping', () => {
    expect(resolveDurationHours(1, hourly)).toEqual({ok: false, reason: 'out_of_range'});
    expect(resolveDurationHours(9, hourly)).toEqual({ok: false, reason: 'out_of_range'});
    expect(resolveDurationHours(4.5, hourly)).toEqual({ok: false, reason: 'not_integer'});
  });

  it('a fixed grid accepts only its members', () => {
    const grid = {default: 3, min: 3, max: 24, fixedGrid: EXEC_DURATION_GRID};
    expect(resolveDurationHours(6, grid)).toEqual({ok: true, hours: 6});
    expect(resolveDurationHours(4, grid)).toEqual({ok: false, reason: 'off_grid'});
    expect(resolveDurationHours(undefined, grid)).toEqual({ok: true, hours: 3});
  });
});

/**
 * B-877 (2026-09-14) — a Secure Transfer is billed as a fixed BLOCK of hours
 * that ops set PER REGION; the client has no duration control for it.
 *
 * Founder, on the SERVICE DURATION card of a ten-minute transfer: "What is this
 * for? ... This card is not relative." Decision relayed 13:16: "Confirm we can
 * set the 4 hours per region" - "Yes".
 */
describe('resolveTransferBlockHours (B-877)', () => {
  it('defaults to the compiled 4 — the hours every shipped app already sent', () => {
    expect(resolveTransferBlockHours(cfg())).toBe(4);
    expect(DEFAULT_SERVICE_PRICING.transfer_block_hours).toBe(4);
  });

  it('reads the ops board — a region that sets 5 bills 5', () => {
    expect(resolveTransferBlockHours(cfg({transfer_block_hours: 5}))).toBe(5);
    expect(resolveTransferBlockHours(cfg({transfer_block_hours: 1}))).toBe(1);
    expect(resolveTransferBlockHours(cfg({transfer_block_hours: 24}))).toBe(24);
  });

  it('a malformed row collapses to 4 rather than making transfers unbookable or billing a length nobody agreed to', () => {
    for (const bad of [0, -3, 2.5, 25, 1e6, NaN, Infinity, null, undefined, 'four']) {
      expect(resolveTransferBlockHours(cfg({transfer_block_hours: bad as never}))).toBe(4);
    }
  });

  it('is read at CALL time, so an ops edit prices the next quote', () => {
    const board = cfg();
    expect(resolveTransferBlockHours(board)).toBe(4);
    board.transfer_block_hours = 6;
    expect(resolveTransferBlockHours(board)).toBe(6);
  });
});

describe('resolveDurationRule — Secure Transfer collapses to the block (B-877)', () => {
  it('a transfer reports default == min == max == the block, so an old stepper clamps to it', () => {
    expect(resolveDurationRule('secure_transfer', cfg())).toEqual({default: 4, min: 4, max: 4});
    expect(resolveDurationRule('secure_transfer', cfg({transfer_block_hours: 5}))).toEqual({default: 5, min: 5, max: 5});
  });

  it('the hourly keys no longer reach a transfer — only the block does', () => {
    const board = cfg({hourly_default_hours: 6, hourly_min_hours: 4, hourly_max_hours: 12, transfer_block_hours: 3});
    expect(resolveDurationRule('secure_transfer', board)).toEqual({default: 3, min: 3, max: 3});
  });

  // An ABSENT service has ALWAYS been priced by the transfer formula
  // (`PricingService.calculate` branches only on 'executive_protection'), so the
  // quoted rule, the priced hours and the stored hours must agree for it too.
  it('an absent / blank service is a transfer here, exactly as it is in calculate()', () => {
    const board = cfg({transfer_block_hours: 5, hourly_default_hours: 6, hourly_min_hours: 4, hourly_max_hours: 12});
    for (const service of [undefined, null, '', '  ']) {
      expect(isTransferBlockService(service)).toBe(true);
      expect(resolveDurationRule(service, board)).toEqual({default: 5, min: 5, max: 5});
    }
  });

  it('leaves every other service alone: hourly keeps its range, EP keeps its grid', () => {
    const board = cfg({transfer_block_hours: 5, hourly_default_hours: 6, hourly_min_hours: 4, hourly_max_hours: 12});
    for (const service of ['close_protection', 'recon_team']) {
      expect(isTransferBlockService(service)).toBe(false);
      expect(resolveDurationRule(service, board)).toEqual({default: 6, min: 4, max: 12});
    }
    expect(resolveDurationRule('executive_protection', board).fixedGrid).toEqual(EXEC_DURATION_GRID);
  });
});

/**
 * B-877 — the ops board must ADMIT the new key. `KEYS` derives from
 * `DEFAULT_SERVICE_PRICING` (so the PATCH allow-list and the board listing
 * follow automatically) but `BOUNDS` is a hand-written record: a key that is
 * listed and unbounded would be un-editable from the console, and the bound is
 * the only thing between an operator and a 500-hour transfer.
 */
describe('ops board admits transfer_block_hours (B-877)', () => {
  const regions = {ensureFresh: jest.fn().mockResolvedValue(undefined)};
  const req = {admin: {user_id: 'a1', role: 'SUPERVISOR', call_sign: 'SUP-01', region: 'AE'}} as never;

  function ctrl(db: unknown) {
    return new OpsServicePricingController(
      db as never, {recordAdmin: jest.fn().mockResolvedValue(undefined)} as never, regions as never,
    );
  }

  it('the board LISTS the key with its compiled default and its 1..24 bounds', async () => {
    const out = await ctrl({q: jest.fn().mockResolvedValue([]), qOne: jest.fn()}).list(undefined);
    const row = out.pricing.find(p => p.key === 'transfer_block_hours');
    expect(row).toMatchObject({key: 'transfer_block_hours', default_value: 4, min: 1, max: 24});
  });

  it('a PATCH inside the bounds is written; outside them it is refused, never clamped', async () => {
    const qOne = jest.fn()
      .mockResolvedValueOnce({value: '4'})
      .mockResolvedValueOnce({key: 'transfer_block_hours', value: '6'});
    const ok = await ctrl({q: jest.fn().mockResolvedValue([]), qOne}).set(
      {key: 'transfer_block_hours', value: 6}, req,
    );
    expect(ok).toMatchObject({key: 'transfer_block_hours', value: 6, region: 'GLOBAL'});
    await expect(ctrl({q: jest.fn(), qOne: jest.fn()}).set({key: 'transfer_block_hours', value: 25}, req))
      .rejects.toThrow(/value_out_of_bounds:1\.\.24/);
    await expect(ctrl({q: jest.fn(), qOne: jest.fn()}).set({key: 'transfer_block_hours', value: 0.5}, req))
      .rejects.toThrow(/value_out_of_bounds:1\.\.24/);
  });
});
