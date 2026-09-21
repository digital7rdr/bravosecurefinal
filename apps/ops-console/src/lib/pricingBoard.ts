/**
 * B-807 — the pricing board's key groups and copy, as pure data so the node
 * test project can pin them.
 *
 * Why a grouping at all: the board renders every key the server emits, and
 * OP-10 added `platform_fee_pct` / `cancel_fee_pct` to that list with no label
 * and no timing copy. They sat at the bottom of a card that says "charged at
 * charge time — the next quote uses the new number", which is false for both:
 * neither is read by the quote. The platform fee is applied when escrow is
 * RELEASED to the provider; the cancel fee when a client cancels after crew is
 * committed (or inside the late-cancel window) and when a lead declares a
 * client no-show. An operator editing "the fee" under the quote copy expected
 * the next booking to show it, and it never did.
 */

export type PricingGroupKey = 'root' | 'transfer' | 'executive' | 'addons' | 'lead' | 'duration' | 'settlement';

export interface PricingGroup {
  key: PricingGroupKey;
  title: string;
  /** WHEN an edit lands — the sentence the operator reads before saving. */
  appliesWhen: string;
  keys: readonly string[];
}

export const PRICING_GROUPS: readonly PricingGroup[] = [
  {key: 'root', title: 'The root', appliesWhen: 'Applies from the next quote. Re-prices every booking charge platform-wide.', keys: ['eur_per_bc', 'base_rate_aed']},
  // B-877 — `transfer_block_hours` belongs HERE, not in the 'duration' group:
  // that group's copy is about the hourly stepper the app shows for per-hour
  // services, and a transfer has no stepper at all. It is a Secure Transfer
  // number and it moves the next transfer quote, which is exactly this group's
  // timing sentence.
  {key: 'transfer', title: 'Secure Transfer', appliesWhen: 'Applies from the next quote; existing bookings keep their stored totals.', keys: ['transfer_base_rate_bc', 'transfer_extra_unit_factor', 'transfer_driver_only_factor', 'peak_multiplier', 'transfer_block_hours']},
  {key: 'executive', title: 'Executive Protection', appliesWhen: 'Applies from the next quote; existing bookings keep their stored totals.', keys: ['exec_cpo_rate_bc', 'exec_vehicle_rate_bc', 'exec_driver_only_rate_bc']},
  {key: 'addons', title: 'Add-ons', appliesWhen: 'Applies from the next quote.', keys: ['addon_female_cpo_bc', 'addon_recon_bc', 'addon_medical_bc', 'addon_comms_bc']},
  {key: 'lead', title: 'Booking lead time', appliesWhen: 'Applies to the next booking attempt (validated at estimate and create).', keys: ['exec_min_lead_hours', 'close_min_lead_hours', 'transfer_min_lead_hours']},
  {key: 'duration', title: 'Hourly duration', appliesWhen: 'Applies to the next booking attempt.', keys: ['hourly_default_hours', 'hourly_min_hours', 'hourly_max_hours']},
  {
    key: 'settlement', title: 'Settlement fees — escrow',
    appliesWhen: 'NOT a quote number. Read at settlement time: the platform fee when a hold is RELEASED to the provider (auto-release, client confirm, or an operator release), the cancel fee when a client cancels after crew is committed / inside the late-cancel window, or when a lead declares a client no-show. A hold already settled keeps its recorded split.',
    keys: ['platform_fee_pct', 'cancel_fee_pct'],
  },
];

export const PRICING_LABELS: Record<string, string> = {
  eur_per_bc: 'THE ROOT — 1 BC = X EUR',
  transfer_base_rate_bc: 'Secure Transfer base /hr (1 CPO + vehicle + driver)',
  transfer_extra_unit_factor: 'Extra CPO/vehicle (x base, per unit)',
  transfer_driver_only_factor: 'Driver-only multiplier',
  peak_multiplier: 'Peak multiplier (17:00-20:00 local)',
  transfer_block_hours: 'Secure Transfer: billed block per transfer (hours) — set per region; the app has no hours control for transfers',
  base_rate_aed: 'AED display anchor (per base rate)',
  exec_cpo_rate_bc: 'Executive: per CPO /hr',
  exec_vehicle_rate_bc: 'Executive: per vehicle + driver /hr',
  exec_driver_only_rate_bc: 'Executive: Bravo driver, client vehicle /hr',
  addon_female_cpo_bc: 'Add-on: Female CPO Team /hr',
  addon_recon_bc: 'Add-on: Advance Assessment Team /hr',
  addon_medical_bc: 'Add-on: Medical Support /hr',
  addon_comms_bc: 'Add-on: Secure Communications /hr',
  exec_min_lead_hours: 'Executive: minimum booking lead (hours)',
  close_min_lead_hours: 'Close Protection: minimum booking lead (hours)',
  transfer_min_lead_hours: 'Secure Transfer: minimum booking lead (hours)',
  hourly_default_hours: 'Hourly services: default duration (hours) the app pre-selects',
  hourly_min_hours: 'Hourly services: minimum duration (hours) — keep ≤ 4 until every installed app has the duration control; older apps always send 4',
  hourly_max_hours: 'Hourly services: maximum duration (hours)',
  platform_fee_pct: 'Platform fee at escrow RELEASE (% of gross kept by the platform; the provider receives the rest)',
  cancel_fee_pct: 'Cancellation / client no-show fee (% of gross paid to the provider; the rest is refunded)',
};

/** Longer help shown under the two settlement keys. */
export const PRICING_HELP: Record<string, string> = {
  platform_fee_pct:
    'Applied when a PENDING_RELEASE hold is paid out — by the release sweep after the dispute window, by the client confirming early, or by an operator releasing a review hold. Fee = round(gross × pct ÷ 100), capped at gross. Not applied to a refund, and not applied to a dispute split (there the remainder you leave unassigned is the platform share). The board cannot store 0 — clear the row to fall back to the environment base.',
  cancel_fee_pct:
    'Paid to the provider out of escrow when a client cancels after crew is committed (a live mission exists) or inside the late-cancel window of a scheduled booking, and when the lead declares a client no-show at pickup. The client is refunded gross minus the fee. A cancel before crew is committed is always a full refund regardless of this value. The board cannot store 0 — clear the row to fall back to the environment base.',
};

export function pricingGroupOf(key: string): PricingGroup | undefined {
  return PRICING_GROUPS.find(g => g.keys.includes(key));
}

/** Keys the server emits that no group claims — rendered in a trailing "Other" group so nothing is ever hidden. */
export function ungroupedKeys(keys: readonly string[]): string[] {
  const claimed = new Set(PRICING_GROUPS.flatMap(g => g.keys));
  return keys.filter(k => !claimed.has(k));
}

/**
 * The confirm text before a save. The scope sentence is the same for every
 * key; the TIMING sentence comes from the key's group, so a settlement fee is
 * never described as "the next quote".
 */
export function pricingSaveConfirmText(key: string, from: number, to: number, region: string): string {
  const scope = region === 'GLOBAL' ? 'every region that has not overridden it' : `region ${region} only`;
  const group = pricingGroupOf(key);
  if (key === 'eur_per_bc') {
    return `Change THE ROOT (eur_per_bc) from ${from} to ${to} for ${scope}? This re-prices every booking charge from the next quote.`;
  }
  if (group?.key === 'settlement') {
    const what = key === 'platform_fee_pct'
      ? 'the platform fee taken at every escrow RELEASE'
      : 'the fee a client pays on a post-crew cancellation or no-show';
    return `Change ${key} from ${from}% to ${to}% for ${scope}? This is ${what}. It applies to every settlement from now on — holds already settled keep their recorded split.`;
  }
  return `Change ${key} from ${from} to ${to} for ${scope}? ${group?.appliesWhen ?? 'Applies from the next quote/charge.'}`;
}
