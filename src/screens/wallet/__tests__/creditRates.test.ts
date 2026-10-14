/**
 * 2026-10-14 — "How Bravo Credits work": the client's country comes first,
 * numbers read naturally, and the offline table matches the server's
 * indicative seeds (AE/SA/BD/GB/ZA).
 */
import {
  FALLBACK_CREDIT_RATES, regionForUser, flagFor, formatLocal, countryName, sortRatesFor,
} from '../creditRates';

describe('credit rates', () => {
  it('finds the client country from the saved region, else the phone prefix', () => {
    expect(regionForUser('ae', null)).toBe('AE');
    expect(regionForUser('N/A', '+8801712345678')).toBe('BD');
    expect(regionForUser(null, '+971501234567')).toBe('AE');
    expect(regionForUser(null, '+447700900000')).toBe('GB');
    expect(regionForUser(null, '+15551234567')).toBeNull();
  });

  it('formats small and large amounts', () => {
    expect(formatLocal(4.1114)).toBe('4.11');
    expect(formatLocal(137.2)).toBe('137.20');
    expect(formatLocal(13720)).toBe('13,720');
    expect(formatLocal(0.8439)).toBe('0.84');
  });

  it('flags and names', () => {
    expect(flagFor('AE')).toBe('🇦🇪');
    expect(flagFor('??')).toBe('🌐');
    expect(countryName({region: 'AE', name: 'UAE — Dubai, Abu Dhabi, Sharjah', currency: 'AED', localPerBc: 4, launched: true})).toBe('United Arab Emirates');
    expect(countryName({region: 'ZA', name: 'South Africa — Johannesburg, Cape Town', currency: 'ZAR', localPerBc: 18, launched: true})).toBe('South Africa');
  });

  it('puts the client country first, then launched regions', () => {
    const order = sortRatesFor(FALLBACK_CREDIT_RATES.rates, 'GB').map(r => r.region);
    expect(order[0]).toBe('GB');
    expect(order.slice(1, 4).sort()).toEqual(['AE', 'BD', 'ZA']);
  });

  it('the offline table is pegged to €1 and covers every served currency', () => {
    expect(FALLBACK_CREDIT_RATES.eurPerBc).toBe(1);
    expect(FALLBACK_CREDIT_RATES.rates.map(r => r.currency).sort()).toEqual(['AED', 'BDT', 'GBP', 'SAR', 'ZAR']);
  });
});
