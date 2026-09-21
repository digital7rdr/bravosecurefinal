// Stub the API + native/expo chain so importing bookingStore doesn't pull in
// the expo env. Nothing here touches the API.
jest.mock('@services/api', () => ({
  walletApi: {},
  bookingApi: {},
}));
jest.mock('@utils/constants', () => ({AUTO_DISPATCH: false}));
jest.mock('@store/authStore', () => ({useAuthStore: {getState: () => ({user: null})}}));

import {useBookingStore} from '@store/bookingStore';
import {LAUNCHED_ZONES} from '@screens/booking/launchedZones';

/**
 * B-868 — nothing hand-picks the operating zone any more, so the DRAFT has to
 * carry one from the first frame. `ZoneMapScreen.handleContinue` was the only
 * writer of `zone_utc_offset_hours` outside `setPickupWithZone`, and four
 * screens read it (`CustomizeAddOns`, `BookingDateTime`, `ExecReview`,
 * `ExecTransport`) — a null offset silently drops the schedule pickers back to
 * the DEVICE clock, which books the wrong hour (B-789b).
 *
 * The seed is DERIVED from `LAUNCHED_ZONES`, never re-typed: the label becomes
 * `create()`'s `region_label` on the ops console, and the offset is a money/time
 * value. A confirmed pick-up overrides all four the moment one exists.
 */
describe('B-868 — a fresh draft is seeded with a real operating zone', () => {
  beforeEach(() => {
    useBookingStore.getState().resetDraft();
  });

  it('carries all four zone fields, from the first launched zone', () => {
    const seed = LAUNCHED_ZONES[0];
    const d = useBookingStore.getState().draft;
    expect(d.zone_code).toBe(seed.code);
    expect(d.zone_label).toBe(seed.name);
    expect(d.region).toBe(seed.code);
    expect(d.zone_utc_offset_hours).toBe(seed.utcOffsetHours);
  });

  it('the seeded clock is NON-NULL — no downstream picker falls back to the device', () => {
    expect(useBookingStore.getState().draft.zone_utc_offset_hours).not.toBeNull();
    expect(typeof useBookingStore.getState().draft.zone_utc_offset_hours).toBe('number');
  });

  it('a confirmed pin in the OTHER launched zone replaces all four', () => {
    const other = LAUNCHED_ZONES[1];
    const {zoneChanged} = useBookingStore.getState().setPickupWithZone({
      zone_code: other.code,
      zone_label: other.name,
      region: other.code,
      zone_utc_offset_hours: other.utcOffsetHours,
      pickup: {address: 'Sandton City, Johannesburg', latitude: -26.107, longitude: 28.056} as never,
    });
    expect(zoneChanged).toBe(true);
    const d = useBookingStore.getState().draft;
    expect(d.zone_code).toBe(other.code);
    expect(d.zone_label).toBe(other.name);
    expect(d.region).toBe(other.code);
    expect(d.zone_utc_offset_hours).toBe(other.utcOffsetHours);
    // The pin that CAUSED the change survives the store's zone-change clear.
    expect(d.pickup?.address).toBe('Sandton City, Johannesburg');
  });

  it('the executive seed inherits the zone rather than re-defaulting it', () => {
    const other = LAUNCHED_ZONES[1];
    useBookingStore.getState().updateDraft({
      zone_code: other.code, zone_label: other.name,
      region: other.code, zone_utc_offset_hours: other.utcOffsetHours,
    });
    useBookingStore.getState().startExecutiveDraft();
    const d = useBookingStore.getState().draft;
    expect(d.service).toBe('executive_protection');
    expect(d.zone_code).toBe(other.code);
    expect(d.zone_utc_offset_hours).toBe(other.utcOffsetHours);
  });
});
