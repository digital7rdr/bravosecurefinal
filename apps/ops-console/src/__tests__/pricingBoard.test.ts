/**
 * B-807 — the two settlement fees on the pricing board.
 *
 * OP-10 put `platform_fee_pct` / `cancel_fee_pct` on the board with no label,
 * under copy that says an edit "prices the next quote". Neither is read by a
 * quote: they are read at escrow RELEASE and at a post-crew cancel / no-show.
 * These pins keep the two keys labelled, grouped under settlement, and
 * described by their real timing in the confirm dialog.
 */
import {
  PRICING_GROUPS, PRICING_LABELS, PRICING_HELP, pricingGroupOf, ungroupedKeys, pricingSaveConfirmText,
} from '../lib/pricingBoard';

/** ↔ DEFAULT_SERVICE_PRICING keys (apps/auth-service/src/booking/pricing.service.ts). */
const SERVER_KEYS = [
  'eur_per_bc', 'transfer_base_rate_bc', 'transfer_extra_unit_factor', 'transfer_driver_only_factor',
  'peak_multiplier', 'base_rate_aed', 'exec_cpo_rate_bc', 'exec_vehicle_rate_bc', 'exec_driver_only_rate_bc',
  'addon_female_cpo_bc', 'addon_recon_bc', 'addon_medical_bc', 'addon_comms_bc',
  'exec_min_lead_hours', 'transfer_min_lead_hours', 'close_min_lead_hours',
  'platform_fee_pct', 'cancel_fee_pct',
  'hourly_default_hours', 'hourly_min_hours', 'hourly_max_hours',
  'transfer_block_hours',
];

describe('B-807 — settlement fees are first-class on the board', () => {
  it('every server key has a label and belongs to exactly one group', () => {
    for (const k of SERVER_KEYS) {
      expect(PRICING_LABELS[k]).toBeTruthy();
      expect(PRICING_GROUPS.filter(g => g.keys.includes(k))).toHaveLength(1);
    }
    expect(ungroupedKeys(SERVER_KEYS)).toEqual([]);
  });

  it('the two fees sit in the settlement group, whose timing copy denies the quote', () => {
    expect(pricingGroupOf('platform_fee_pct')?.key).toBe('settlement');
    expect(pricingGroupOf('cancel_fee_pct')?.key).toBe('settlement');
    const g = PRICING_GROUPS.find(x => x.key === 'settlement')!;
    expect(g.appliesWhen).toMatch(/NOT a quote number/);
    expect(g.appliesWhen).toMatch(/RELEASED/);
    expect(g.appliesWhen).toMatch(/no-show/);
    expect(PRICING_HELP.platform_fee_pct).toMatch(/round\(gross × pct ÷ 100\)/);
    expect(PRICING_HELP.cancel_fee_pct).toMatch(/full refund/);
  });

  it('a server key the console has not grouped yet is still rendered (trailing group), never hidden', () => {
    expect(ungroupedKeys([...SERVER_KEYS, 'brand_new_key'])).toEqual(['brand_new_key']);
  });

  it('the confirm text for a fee names settlement, not the next quote', () => {
    const t = pricingSaveConfirmText('platform_fee_pct', 15, 12, 'GLOBAL');
    expect(t).toMatch(/15% to 12%/);
    expect(t).toMatch(/escrow RELEASE/);
    expect(t).not.toMatch(/next quote/);
    const c = pricingSaveConfirmText('cancel_fee_pct', 25, 30, 'AE');
    expect(c).toMatch(/region AE only/);
    expect(c).toMatch(/no-show/);
    expect(c).not.toMatch(/next quote/);
  });

  // B-877 — the Secure Transfer billing block. It is grouped under Secure
  // Transfer and NOT under "Hourly duration": that group's copy describes the
  // stepper the app shows for per-hour services, and a transfer has no stepper,
  // so filing it there would tell an operator they are editing a control the
  // client can still override.
  it('the transfer block sits under Secure Transfer, never the hourly-duration group', () => {
    expect(pricingGroupOf('transfer_block_hours')?.key).toBe('transfer');
    expect(PRICING_GROUPS.find(g => g.key === 'duration')!.keys).not.toContain('transfer_block_hours');
    expect(PRICING_LABELS.transfer_block_hours).toMatch(/per region/);
    expect(PRICING_LABELS.transfer_block_hours).toMatch(/no hours control/);
    expect(pricingSaveConfirmText('transfer_block_hours', 4, 6, 'AE'))
      .toMatch(/region AE only[\s\S]*next quote/);
  });

  it('the root and a rate key keep their quote-time copy', () => {
    expect(pricingSaveConfirmText('eur_per_bc', 1, 1.1, 'GLOBAL')).toMatch(/THE ROOT[\s\S]*next quote/);
    expect(pricingSaveConfirmText('exec_cpo_rate_bc', 86, 90, 'GLOBAL')).toMatch(/next quote/);
  });
});
