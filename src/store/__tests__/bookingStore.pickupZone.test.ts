// Stub the API + native/expo chain so importing bookingStore doesn't pull
// in the expo env. setPickupWithZone never touches the API.
jest.mock('@services/api', () => ({
  walletApi: {},
  bookingApi: {},
}));
jest.mock('@utils/constants', () => ({AUTO_DISPATCH: false}));
jest.mock('@store/authStore', () => ({useAuthStore: {getState: () => ({user: null})}}));

import {useBookingStore} from '@store/bookingStore';

/**
 * B-861 (plan `docs/planning/SECURE_TRANSFER_ZONE_SCHEDULE_PLAN_2026-09-11.md`
 * §10 A6) — the zone now follows the pick-up pin, which puts the store's OWN
 * zone-change hook directly in the way: `updateDraft` nulls `pickup` AND
 * `dropoff` whenever `zone_code` moves (bookingStore, the B-789a rule), so a
 * naive "write the zone, then write the pin" would throw the pin away the
 * instant a user picked up in the OTHER country — the one case the whole
 * feature exists for.
 *
 * `setPickupWithZone` is the single writer: ONE `updateDraft` whose patch
 * carries the zone fields AND the new pickup, so the hook's clear runs against
 * the OLD pin and the NEW one is applied after it. It returns
 * `{zoneChanged, dropoffCleared}` because the founder must never see a silent
 * "my drop-off disappeared" — the review screen renders a notice off it.
 */
const AE = {
  zone_code: 'AE',
  zone_label: 'UAE — Dubai, Abu Dhabi, Sharjah',
  region: 'AE',
  zone_utc_offset_hours: 4,
};
const ZA = {
  zone_code: 'ZA',
  zone_label: 'South Africa — Johannesburg, Cape Town',
  region: 'ZA',
  zone_utc_offset_hours: 2,
};
const dubai = {address: 'DIFC, Dubai', latitude: 25.2, longitude: 55.27, label: 'Pick-up'};
const joburg = {address: 'Sandton, Johannesburg', latitude: -26.1, longitude: 28.05, label: 'Pick-up'};
const dropoff = {address: 'Somewhere', latitude: 25.1, longitude: 55.2, label: 'Drop-off'};

describe('B-861 A6 — setPickupWithZone', () => {
  beforeEach(() => {
    useBookingStore.getState().resetDraft();
  });

  it('the PICK-UP survives the zone change it caused', () => {
    useBookingStore.getState().updateDraft({...AE, pickup: dubai as never, dropoff: dropoff as never});

    useBookingStore.getState().setPickupWithZone({...ZA, pickup: joburg as never});

    const d = useBookingStore.getState().draft;
    expect(d.zone_code).toBe('ZA');
    expect(d.region).toBe('ZA');
    expect(d.zone_label).toBe(ZA.zone_label);
    // The whole point: the pin the user just confirmed is still there.
    expect(d.pickup).toEqual(joburg);
  });

  it('stamps the zone CLOCK too — the four fields move together', () => {
    useBookingStore.getState().updateDraft({...AE, pickup: dubai as never});
    expect(useBookingStore.getState().draft.zone_utc_offset_hours).toBe(4);

    useBookingStore.getState().setPickupWithZone({...ZA, pickup: joburg as never});

    // B-789b — every schedule picker downstream reads in this clock. The old
    // OPERATING ZONE tiles wrote three of the four fields and left the offset
    // stale, so a Cape Town booking was picked in Gulf time.
    expect(useBookingStore.getState().draft.zone_utc_offset_hours).toBe(2);
  });

  it('clears the DROP-OFF when the zone actually changes, and says so', () => {
    useBookingStore.getState().updateDraft({...AE, pickup: dubai as never, dropoff: dropoff as never});

    const out = useBookingStore.getState().setPickupWithZone({...ZA, pickup: joburg as never});

    expect(out).toEqual({zoneChanged: true, dropoffCleared: true});
    expect(useBookingStore.getState().draft.dropoff).toBeNull();
  });

  it('a SAME-ZONE re-pick keeps the drop-off and reports no change', () => {
    useBookingStore.getState().updateDraft({...AE, pickup: dubai as never, dropoff: dropoff as never});

    const out = useBookingStore.getState().setPickupWithZone({
      ...AE,
      pickup: {...dubai, address: 'Marina, Dubai'} as never,
    });

    expect(out).toEqual({zoneChanged: false, dropoffCleared: false});
    expect(useBookingStore.getState().draft.dropoff).toEqual(dropoff);
    expect(useBookingStore.getState().draft.pickup).toEqual({...dubai, address: 'Marina, Dubai'});
  });

  it('a zone change with NO drop-off set reports zoneChanged without a clear', () => {
    useBookingStore.getState().updateDraft({...AE, pickup: dubai as never, dropoff: null});

    const out = useBookingStore.getState().setPickupWithZone({...ZA, pickup: joburg as never});

    // The notice must not fire for a drop-off the user never had.
    expect(out).toEqual({zoneChanged: true, dropoffCleared: false});
  });
});
