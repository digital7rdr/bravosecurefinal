/**
 * B-795 — the client store is keyed by booking id.
 *
 * A customer may hold several bookings at once; the old singleton
 * `activeBooking` was written by four screens' polls and a second booking's
 * poll overwrote the first's card. Every snapshot now lands in
 * `bookingsById[id]`, an older snapshot of the SAME booking never wins
 * (`updated_at`), a list row merges field-wise so detail-only fields survive
 * the Home poll, and a detail read can never land in another booking's slot.
 */
jest.mock('@services/api', () => ({
  walletApi: {},
  bookingApi: {
    create: jest.fn(),
    requestAuto: jest.fn(),
    list: jest.fn(),
    getById: jest.fn(),
  },
}));
jest.mock('@utils/constants', () => ({AUTO_DISPATCH: false}));
jest.mock('@store/authStore', () => ({useAuthStore: {getState: () => ({user: null})}}));
jest.mock('@store/walletStore', () => ({useWalletStore: {getState: () => ({balance: null})}}));

import {bookingApi} from '@services/api';
import {useBookingStore, isStaleSnapshot} from '@store/bookingStore';

const T0 = '2026-09-04T09:00:00.000Z';
const T1 = '2026-09-04T10:00:00.000Z';
const T2 = '2026-09-04T11:00:00.000Z';

type Row = {id: string; status: string; updated_at?: string; hourly_checkins?: unknown[]};
const detail: Row = {id: 'b1', status: 'LIVE', updated_at: T1, hourly_checkins: [{hour_index: 1}]};
const held = (id: string): Row => useBookingStore.getState().bookingsById[id] as unknown as Row;

beforeEach(() => {
  useBookingStore.setState({bookingsById: {b1: detail}, bookings: [detail]} as never);
  (bookingApi.list as jest.Mock).mockReset();
  (bookingApi.getById as jest.Mock).mockReset();
});

describe('bookingStore per-id snapshots (B-795)', () => {
  it('a list row with the SAME updated_at merges field-wise — the Executive timeline survives the Home poll', async () => {
    (bookingApi.list as jest.Mock).mockResolvedValue({data: {bookings: [{id: 'b1', status: 'LIVE', updated_at: T1}]}});
    await useBookingStore.getState().loadBookings();
    expect(held('b1').status).toBe('LIVE');
    expect(held('b1').hourly_checkins).toEqual([{hour_index: 1}]);
  });

  it('an OLDER list row is dropped', async () => {
    (bookingApi.list as jest.Mock).mockResolvedValue({data: {bookings: [{id: 'b1', status: 'CONFIRMED', updated_at: T0}]}});
    await useBookingStore.getState().loadBookings();
    expect(held('b1').status).toBe('LIVE');
  });

  it('a NEWER list row REPLACES — a re-crewed mission must not inherit the old hours; the next detail poll refills them', async () => {
    (bookingApi.list as jest.Mock).mockResolvedValue({data: {bookings: [{id: 'b1', status: 'COMPLETED', updated_at: T2}]}});
    await useBookingStore.getState().loadBookings();
    expect(held('b1').status).toBe('COMPLETED');
    expect(held('b1').hourly_checkins).toBeUndefined();
  });

  it('a list row that itself carries the detail field keeps its OWN value (never the held one)', async () => {
    (bookingApi.list as jest.Mock).mockResolvedValue({data: {bookings: [{id: 'b1', status: 'LIVE', updated_at: T1, hourly_checkins: []}]}});
    await useBookingStore.getState().loadBookings();
    expect(held('b1').hourly_checkins).toEqual([]);
  });

  it('a second booking gets its OWN slot and never touches the first', async () => {
    (bookingApi.list as jest.Mock).mockResolvedValue({data: {bookings: [
      {id: 'b2', status: 'CONFIRMED', updated_at: T2},
      {id: 'b1', status: 'LIVE', updated_at: T1},
    ]}});
    await useBookingStore.getState().loadBookings();
    expect(held('b2').status).toBe('CONFIRMED');
    expect(held('b1').hourly_checkins).toEqual([{hour_index: 1}]);
    expect(useBookingStore.getState().bookings.map(b => b.id)).toEqual(['b2', 'b1']);
  });

  it('a detail read for booking A can never land in booking B\'s slot', async () => {
    (bookingApi.getById as jest.Mock).mockResolvedValue({data: {id: 'b2', status: 'CONFIRMED', updated_at: T2}});
    await useBookingStore.getState().loadActiveBooking('b1');
    expect(held('b1').status).toBe('LIVE');
    expect(useBookingStore.getState().bookingsById.b2).toBeUndefined();
  });

  it('isStaleSnapshot: strict — equal timestamps are not stale; missing timestamps fail open', () => {
    expect(isStaleSnapshot({updated_at: T1} as never, {updated_at: T1} as never)).toBe(false);
    expect(isStaleSnapshot({updated_at: T1} as never, {updated_at: T0} as never)).toBe(true);
    expect(isStaleSnapshot({updated_at: T0} as never, {updated_at: T1} as never)).toBe(false);
    expect(isStaleSnapshot(undefined, {updated_at: T0} as never)).toBe(false);
    expect(isStaleSnapshot({} as never, {updated_at: T0} as never)).toBe(false);
  });
});
