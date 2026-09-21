import type {PackageTier} from '@appTypes/index';

/** The messenger ladder, in display order — full matrix columns (M1A §2). */
export const PRICING_ORDER: PackageTier[] = ['lite', 'pro', 'enterprise'];

/**
 * B-781 — which tier cards the Pricing screen shows.
 *
 * The workspace door ("Department Channels are available on Enterprise")
 * used to land on all three cards; the founder wants ONLY the Enterprise card
 * there. `only` narrows the ladder to one tier; anything unknown falls back to
 * the whole ladder so a stale deep link can never render an empty screen.
 */
export function tiersToShow(only?: PackageTier | null): PackageTier[] {
  return only && PRICING_ORDER.includes(only) ? [only] : PRICING_ORDER;
}
