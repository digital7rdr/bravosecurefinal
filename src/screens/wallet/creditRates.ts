/**
 * "How Bravo Credits work" — the pure parts (no React Native imports, so the
 * node test project can pin them): the offline rate table, which country is
 * the client's, and how numbers are shown.
 */
import type {CreditRatesDto} from '@services/api';

export type Rate = CreditRatesDto['rates'][number];

/** Offline fallback — same indicative numbers the server ships (2026-10-14). */
export const FALLBACK_CREDIT_RATES: CreditRatesDto = {
  eurPerBc: 1,
  rates: [
    {region: 'AE', name: 'United Arab Emirates', currency: 'AED', localPerBc: 4.1114, launched: true},
    {region: 'SA', name: 'Saudi Arabia',         currency: 'SAR', localPerBc: 4.1981, launched: false},
    {region: 'BD', name: 'Bangladesh',           currency: 'BDT', localPerBc: 137.2,  launched: true},
    {region: 'GB', name: 'United Kingdom',       currency: 'GBP', localPerBc: 0.8439, launched: false},
    {region: 'ZA', name: 'South Africa',         currency: 'ZAR', localPerBc: 18.4382, launched: true},
  ],
};

const DIAL_TO_REGION: ReadonlyArray<[string, string]> = [
  ['+971', 'AE'], ['+966', 'SA'], ['+880', 'BD'], ['+44', 'GB'], ['+27', 'ZA'],
];

/** The client's region: their saved home region, else their phone's country code. */
export function regionForUser(homeRegion: string | null | undefined, phoneE164: string | null | undefined): string | null {
  const h = (homeRegion ?? '').toUpperCase();
  if (/^[A-Z]{2}$/.test(h)) {return h;}
  const p = phoneE164 ?? '';
  return DIAL_TO_REGION.find(([dial]) => p.startsWith(dial))?.[1] ?? null;
}

export function flagFor(region: string): string {
  if (!/^[A-Z]{2}$/.test(region)) {return '🌐';}
  return String.fromCodePoint(...[...region].map(c => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** "4.11", "137.20", "13,720" — two decimals below 1000, whole numbers above. */
export function formatLocal(n: number): string {
  return n >= 1000
    ? Math.round(n).toLocaleString('en-US')
    : n.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

/** "United Arab Emirates" from "UAE — Dubai, Abu Dhabi, Sharjah". */
export function countryName(r: Rate): string {
  const head = r.name.split('—')[0].trim();
  return head === 'UAE' ? 'United Arab Emirates' : head;
}

/** The client's own country first; then launched regions; then the rest, by name. */
export function sortRatesFor(rates: readonly Rate[], region: string | null): Rate[] {
  return [...rates].sort((a, b) =>
    Number(b.region === region) - Number(a.region === region)
    || Number(b.launched) - Number(a.launched)
    || countryName(a).localeCompare(countryName(b)));
}
