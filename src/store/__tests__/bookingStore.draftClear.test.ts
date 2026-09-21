/**
 * B-790 — the post-submit draft clear lands in its OWN commit.
 *
 * `confirmBooking` used to reset `draft` synchronously in the same `set` that
 * unshifts the new booking. That reset re-rendered the still-mounted review
 * screen (duration cell deselecting, consent check unmounting, transport
 * section tearing down) in the same React/Fabric batch as the post-submit
 * alert host — the Android "child already has a parent" fatal (B-647 class).
 * The booking row must still appear immediately (the home card reads it);
 * the draft clears DRAFT_CLEAR_AFTER_SUBMIT_MS later, keeping the zone AND its
 * clock (B-789b — the offset used to revert to the compiled +4 on every
 * successful booking).
 *
 * The critic's hazards on the deferral are pinned too: a wholesale replace
 * inside the window (Book Now seed, resetDraft, sign-out reset) SUPERSEDES the
 * pending clear, and the draft is not "unsaved work" while it is pending.
 */
jest.mock('@services/api', () => ({
  walletApi: {},
  bookingApi: {
    create: jest.fn(),
    requestAuto: jest.fn(),
  },
}));
jest.mock('@utils/constants', () => ({AUTO_DISPATCH: false}));
jest.mock('@store/authStore', () => ({useAuthStore: {getState: () => ({user: null})}}));
jest.mock('@store/walletStore', () => ({useWalletStore: {getState: () => ({balance: null})}}));

import {bookingApi} from '@services/api';
import {
  useBookingStore, DRAFT_CLEAR_AFTER_SUBMIT_MS, isBookingDraftDirty, isDraftClearPending,
} from '@store/bookingStore';

const pin = {address: 'V&A Waterfront, Cape Town', lat: -33.9, lng: 18.42} as never;

function seedZa(): void {
  useBookingStore.getState().updateDraft({
    zone_code: 'ZA', zone_label: 'South Africa', region: 'ZA', zone_utc_offset_hours: 2,
    pickup: pin, duration_hours: 12, location_consent: true,
  });
}

describe('bookingStore.confirmBooking — B-790 deferred draft clear', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    useBookingStore.getState().reset();
    (bookingApi.create as jest.Mock).mockResolvedValue({
      data: {booking: {id: 'bk-1', status: 'PENDING_OPS', booking_mode: 'later'}},
    });
  });
  afterEach(() => { jest.useRealTimers(); });

  it('unshifts the booking at once but leaves the draft untouched until the delay elapses', async () => {
    seedZa();
    const booking = await useBookingStore.getState().confirmBooking();
    expect(booking.id).toBe('bk-1');
    expect(useBookingStore.getState().bookings[0]?.id).toBe('bk-1');
    // The screen that submitted is still mounted at this instant: nothing on it may restructure.
    const d1 = useBookingStore.getState().draft;
    expect(d1.pickup).toEqual(pin);
    expect(d1.duration_hours).toBe(12);
    expect(d1.location_consent).toBe(true);
    expect(isDraftClearPending()).toBe(true);

    jest.advanceTimersByTime(DRAFT_CLEAR_AFTER_SUBMIT_MS - 1);
    expect(useBookingStore.getState().draft.pickup).toEqual(pin);

    jest.advanceTimersByTime(1);
    const d2 = useBookingStore.getState().draft;
    expect(d2.pickup).toBeNull();
    expect(d2.location_consent).not.toBe(true);
    expect(d2.duration_hours).not.toBe(12);
    expect(isDraftClearPending()).toBe(false);
  });

  it('the clear keeps the zone AND its clock (B-789b), never reverting the offset to the compiled default', async () => {
    seedZa();
    await useBookingStore.getState().confirmBooking();
    jest.advanceTimersByTime(DRAFT_CLEAR_AFTER_SUBMIT_MS);
    const d = useBookingStore.getState().draft;
    expect(d.zone_code).toBe('ZA');
    expect(d.zone_label).toBe('South Africa');
    expect(d.region).toBe('ZA');
    expect(d.zone_utc_offset_hours).toBe(2);
  });

  it('a Book Now seed inside the window supersedes the clear — the fresh Executive draft survives', async () => {
    seedZa();
    await useBookingStore.getState().confirmBooking();
    // The founder taps Book Now → Executive Protection 200 ms after the alert.
    jest.advanceTimersByTime(200);
    useBookingStore.getState().resetDraft();
    useBookingStore.getState().startExecutiveDraft();
    const seeded = useBookingStore.getState().draft;
    expect(seeded.service).toBe('executive_protection');
    expect(isDraftClearPending()).toBe(false);
    jest.advanceTimersByTime(DRAFT_CLEAR_AFTER_SUBMIT_MS);
    // A stale clear would have turned this into a Lite draft (service/duration/vehicle reset).
    const after = useBookingStore.getState().draft;
    expect(after.service).toBe('executive_protection');
    expect(after.duration_hours).toBe(seeded.duration_hours);
    expect(after.vehicle_count).toBe(seeded.vehicle_count);
  });

  it('a sign-out reset inside the window is never followed by the previous account\'s zone', async () => {
    seedZa();
    await useBookingStore.getState().confirmBooking();
    jest.advanceTimersByTime(100);
    useBookingStore.getState().reset();
    jest.advanceTimersByTime(DRAFT_CLEAR_AFTER_SUBMIT_MS);
    const d = useBookingStore.getState().draft;
    expect(d.zone_code).not.toBe('ZA');
    expect(d.zone_utc_offset_hours).not.toBe(2);
    expect(isDraftClearPending()).toBe(false);
  });

  it('the draft is not "unsaved work" while the clear is pending', async () => {
    seedZa();
    expect(isBookingDraftDirty()).toBe(true);
    await useBookingStore.getState().confirmBooking();
    expect(isBookingDraftDirty()).toBe(false);
    jest.advanceTimersByTime(DRAFT_CLEAR_AFTER_SUBMIT_MS);
    expect(isBookingDraftDirty()).toBe(false);
  });

  it('the delay is longer than a stack transition', () => {
    expect(DRAFT_CLEAR_AFTER_SUBMIT_MS).toBeGreaterThanOrEqual(400);
  });
});
