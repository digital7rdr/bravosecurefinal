/**
 * Executive Protection — the price-summary lines the dashboard's CALCULATION
 * card renders, GROUPED so it can show a "Base Protection" and a "Secure
 * Transfer" subtotal above the Estimated Total (Secure Services Streamlined,
 * GAP 3). The lines are the ones ExecReviewScreen always built (same labels,
 * same EXEC_* rates); this file only tags each with its group and sums them.
 * No pricing logic lives here — the total stays execTotalBc(rate, hours), and
 * execPriceSummary.test pins that base + transfer === that total.
 *
 * Pure (no RN imports) so the node `booking` Jest project can import it.
 */
import {
  EXEC_CPO_RATE_BC, EXEC_DRIVER_ONLY_RATE_BC, EXEC_VEHICLE_RATE_BC,
  liveAddOnBcPerHour, type ExecAddOnDef,
} from './executivePricing';
import {priceValue} from '@screens/booking/servicePricingOverrides';

export type ExecPriceGroup = 'base' | 'transfer';

export interface ExecPriceLine {
  label: string;
  perHour: number;
  group: ExecPriceGroup;
}

export interface ExecPriceLinesInput {
  cpoCount: number;
  vehicleCount: number;
  driverOnly: boolean;
  selectedAddOns: ReadonlyArray<ExecAddOnDef>;
}

/**
 * CPO hours + add-ons → base; vehicles / Bravo driver → transfer.
 *
 * E2E-38 — every rate here reads the SAME live ops-editable board the total
 * does (`execRateBcPerHour` → `priceValue`). Using the compiled `EXEC_*`
 * constants and `a.bcPerHour` made the CALCULATION card render stale per-line
 * numbers beside a live total the moment ops moved a price; `splitConsistent`
 * only hid the two subtotals, so the per-line rows kept lying. The constants
 * stay as the fail-open fallbacks, exactly as everywhere else.
 */
export function execPriceLines(input: ExecPriceLinesInput): ExecPriceLine[] {
  const cpoRate = priceValue('exec_cpo_rate_bc', EXEC_CPO_RATE_BC);
  const vehicleRate = priceValue('exec_vehicle_rate_bc', EXEC_VEHICLE_RATE_BC);
  const out: ExecPriceLine[] = [
    {label: `${input.cpoCount} × Close Protection Officer`, perHour: input.cpoCount * cpoRate, group: 'base'},
  ];
  if (input.vehicleCount > 0) {
    out.push({label: `${input.vehicleCount} × Vehicle & Driver`, perHour: input.vehicleCount * vehicleRate, group: 'transfer'});
  }
  if (input.driverOnly) {
    out.push({
      label: 'Bravo driver (client vehicle)',
      perHour: priceValue('exec_driver_only_rate_bc', EXEC_DRIVER_ONLY_RATE_BC),
      group: 'transfer',
    });
  }
  for (const a of input.selectedAddOns) {
    out.push({label: a.label, perHour: liveAddOnBcPerHour(a), group: 'base'});
  }
  return out;
}

/** Subtotals over `hours` — each is exactly the sum of its own lines × hours. */
export function execPriceSummary(
  lines: ReadonlyArray<ExecPriceLine>,
  hours: number,
): {baseBc: number; transferBc: number} {
  const sum = (group: ExecPriceGroup) =>
    lines.filter(l => l.group === group).reduce((s, l) => s + l.perHour * hours, 0);
  return {baseBc: sum('base'), transferBc: sum('transfer')};
}
