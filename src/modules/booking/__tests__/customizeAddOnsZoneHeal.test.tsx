/**
 * B-861 follow-up — the two clock/zone races on "Build & confirm".
 *
 * Both are RENDER tests against the real `bookingStore`, because both are about
 * WHEN an effect runs relative to another piece of state, and the existing pins
 * for this screen are source scans that read the code and cannot see ordering.
 *
 *  · A8 self-heal #1 adopted `pricedRegion` without checking WHICH PIN the
 *    board belongs to. `pricedRegion` is store state read at render and is
 *    nulled only inside `load()`, so on the commit where the pin moves to
 *    Johannesburg the effect still sees the previous Dubai board, adopts 'AE',
 *    clears the drop-off, announces "Zone corrected to UAE" and LATCHES
 *    `healedForPinKey` — which then blocks the submit backstop too, so a pin
 *    that genuinely is in South Africa dead-ends on "Outside our operating
 *    zones".
 *
 *  · `booking_mode` is derived per render against `nowTick`, but the effect that
 *    writes `start_time`/`mode` into the draft was not, so a screen left open
 *    across the three-hour boundary drifted out of step with what the draft
 *    said (and the debounced estimate still priced the old lane). B-874 keeps
 *    that tick and re-points what it proves — see the last block.
 *
 * Placed under `src/modules/booking/__tests__` because the `app` Jest project
 * IGNORES `src/screens/booking/__tests__/` — see the header of
 * `locationPickerZoneGate.test.tsx`.
 */
import React from 'react';
import {act, render} from '@testing-library/react-native';

jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));
jest.mock('@hooks/useBottomInset', () => ({
  useBottomInset: () => ({bottomPad: () => 0, safeBottom: 0, base: 0, gap: () => 0}),
}));
jest.mock('@hooks/useKeyboardLayout', () => ({
  useKeyboardLayout: () => ({overlap: 0, safeBottom: 0, bottomPad: () => 0}),
  useKeyboardOverlap: () => 0,
}));
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({
    navigate: mockNavigate, goBack: jest.fn(), popToTop: jest.fn(),
    setParams: jest.fn(), addListener: () => () => undefined,
  }),
  useRoute: () => ({params: {}}),
  useFocusEffect: (cb: () => void | (() => void)) => {
    const R = require('react');
    R.useEffect(() => cb(), [cb]);
  },
}));
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('@components/booking/androidPicker', () => ({openAndroidDatePicker: jest.fn()}));

/** Captures the time picker props so a test can drive MISSION START. */
const mockTimeField: {onChange: ((h: number, m: number) => void) | null} = {onChange: null};
jest.mock('@components/booking/TimeDropdownField', () => {
  const R = require('react');
  const {View} = require('react-native');
  return {
    __esModule: true,
    default: (props: {onChange: (h: number, m: number) => void}) => {
      mockTimeField.onChange = props.onChange;
      return R.createElement(View, {testID: 'time-field'});
    },
  };
});
jest.mock('@services/api', () => ({
  bookingApi: {
    estimatePrice: jest.fn().mockResolvedValue({data: {}}),
    getAddOns: jest.fn().mockResolvedValue({data: []}),
    create: jest.fn(),
  },
}));
const mockAuthState = {user: {id: 'u1', auto_dispatch_enabled: true}};
jest.mock('@store/authStore', () => {
  const useAuthStore = (sel: (s: unknown) => unknown) => sel(mockAuthState);
  useAuthStore.getState = () => mockAuthState;
  return {useAuthStore};
});
const mockWalletState = {balance: {bravo_credits: 100_000}};
jest.mock('@store/walletStore', () => {
  const useWalletStore = (sel: (s: unknown) => unknown) => sel(mockWalletState);
  useWalletStore.getState = () => mockWalletState;
  return {useWalletStore};
});
const mockReferralState = {pendingCode: null, consume: () => undefined};
jest.mock('@store/referralStore', () => {
  const useReferralStore = (sel: (s: unknown) => unknown) => sel(mockReferralState);
  useReferralStore.getState = () => mockReferralState;
  return {useReferralStore};
});
jest.mock('@screens/booking/usePayerChoice', () => ({
  usePayerChoice: () => ({
    payerUserId: null, options: [], memberships: [], setPayer: jest.fn(),
    noteRefusal: () => null, bodyFields: {},
  }),
}));
jest.mock('@screens/booking/PayerSelector', () => ({PayerSelector: () => null}));
jest.mock('@navigation/tapGuard', () => ({goBackOnce: jest.fn(), navigateOnce: jest.fn()}));

/**
 * The price board, controllable. `pricingZoneKey` is the REAL one — the whole
 * point of the fix is that the screen keys the board the same way the store
 * does, so a hand-written copy here would pin nothing.
 */
jest.mock('@store/servicePricingStore', () => {
  const {create} = require('zustand');
  const actual = jest.requireActual('@store/servicePricingStore');
  const useServicePricingStore = create(() => ({
    overrides: {}, zone: 'GLOBAL', pricedRegion: null, loaded: true,
    load: async () => undefined,
  }));
  return {
    __esModule: true,
    useServicePricingStore,
    useServicePricing: () => ({}),
    pricingZoneKey: actual.pricingZoneKey,
  };
});

import CustomizeAddOnsScreen from '@screens/booking/CustomizeAddOnsScreen';
import {useBookingStore} from '@store/bookingStore';
import {useServicePricingStore} from '@store/servicePricingStore';

const JOBURG = {latitude: -26.2041, longitude: 28.0473, address: 'Sandton'};
/** The board fetched for the pin the user just REPLACED. */
const DUBAI_BOARD_KEY = 'pt:25.2048,55.2708';
/** The board for the pin actually on screen. */
const JOBURG_BOARD_KEY = 'pt:-26.2041,28.0473';

const AE = {
  zone_code: 'AE', zone_label: 'UAE — Dubai, Abu Dhabi, Sharjah',
  region: 'AE', zone_utc_offset_hours: 4,
};
const ZA = {
  zone_code: 'ZA', zone_label: 'South Africa — Johannesburg, Cape Town',
  region: 'ZA', zone_utc_offset_hours: 2,
};

function seedDraft(zone: typeof AE, extra: Record<string, unknown> = {}) {
  useBookingStore.getState().updateDraft({
    ...zone, pickup: JOBURG, dropoff: null, service: 'secure_transfer',
    type: 'transfer', ...extra,
  } as never);
}

function board(zone: string, pricedRegion: string | null) {
  act(() => { useServicePricingStore.setState({zone, pricedRegion}); });
}

beforeEach(() => {
  jest.clearAllMocks();
  useBookingStore.getState().resetDraft();
  useServicePricingStore.setState({zone: 'GLOBAL', pricedRegion: null});
});

describe('B-861 A8 — the self-heal adopts only the board that belongs to THIS pin', () => {
  it('ignores the PREVIOUS pin board — a Johannesburg pin is not corrected to UAE', () => {
    seedDraft(ZA);
    // Still on screen: the board fetched for the Dubai pin the user just
    // replaced. `load()` has not run for the new point yet.
    useServicePricingStore.setState({zone: DUBAI_BOARD_KEY, pricedRegion: 'AE'});

    const ui = render(<CustomizeAddOnsScreen />);

    expect(useBookingStore.getState().draft.zone_code).toBe('ZA');
    expect(useBookingStore.getState().draft.region).toBe('ZA');
    expect(useBookingStore.getState().draft.pickup).toMatchObject({latitude: JOBURG.latitude});
    expect(ui.queryByText(/Zone corrected to UAE/)).toBeNull();

    // …and this pin's own board, when it lands, finds the booking where it
    // left it. Adopting the stale one would also have LATCHED the pin, which
    // blocks the submit backstop — the actual dead-end.
    board(JOBURG_BOARD_KEY, 'ZA');
    expect(useBookingStore.getState().draft.zone_code).toBe('ZA');
    expect(useBookingStore.getState().draft.region).toBe('ZA');
  });

  it('refusing a foreign board does NOT spend the one-shot latch', () => {
    /**
     * The refusal above means "not yet", not "done". Latching on the way out
     * is the plausible half-fix, and it is just as broken: the pin never gets
     * a second chance, so the real board and the submit backstop are both
     * dead for the rest of the screen's life.
     *
     * Staged so the LATCH is the only thing that can decide the outcome: the
     * stale board agrees with the draft (nothing to heal), and this pin's own
     * board then disagrees (everything to heal).
     */
    seedDraft(AE);
    useServicePricingStore.setState({zone: DUBAI_BOARD_KEY, pricedRegion: 'AE'});
    const ui = render(<CustomizeAddOnsScreen />);
    expect(useBookingStore.getState().draft.zone_code).toBe('AE');

    board(JOBURG_BOARD_KEY, 'ZA');

    expect(useBookingStore.getState().draft.zone_code).toBe('ZA');
    expect(useBookingStore.getState().draft.region).toBe('ZA');
    // The pin the zone belongs to survives (the store zone hook would otherwise
    // null it).
    expect(useBookingStore.getState().draft.pickup).toMatchObject({latitude: JOBURG.latitude});
    expect(ui.getByText(/Zone corrected to South Africa/)).toBeTruthy();
  });

  it('still heals, once, when the board really is this pin and disagrees', () => {
    seedDraft(AE);
    useServicePricingStore.setState({zone: JOBURG_BOARD_KEY, pricedRegion: 'ZA'});
    const ui = render(<CustomizeAddOnsScreen />);
    expect(useBookingStore.getState().draft.zone_code).toBe('ZA');
    expect(useBookingStore.getState().draft.region).toBe('ZA');
    expect(ui.getByText(/Zone corrected to South Africa/)).toBeTruthy();

    // A server that keeps disagreeing must SURFACE, not loop: the pin is latched.
    act(() => { useBookingStore.getState().updateDraft({region: 'AE'} as never); });
    board(JOBURG_BOARD_KEY, 'ZA');
    expect(useBookingStore.getState().draft.region).toBe('AE');
  });
});

/**
 * B-877 (founder 2026-09-14, on the SERVICE DURATION card of a 10-minute
 * transfer: "This card is not relative." → "Confirm we can set the 4 hours per
 * region" — "Yes") — a Secure Transfer is billed as a fixed block of hours ops
 * set per region, so the wizard has no hours control for it and files the block
 * on the draft instead. A RENDER test because the point is what is MOUNTED and
 * what the mount effect writes; the source scan in `secureTransferDashboard`
 * can see the guard but not either of those.
 */
describe('B-877 — a transfer has no hours control and carries the block', () => {
  it('mounts no SERVICE DURATION card and files the block on the draft', () => {
    // 9 h is a value only the retired stepper could have produced; the block
    // has to overwrite it, or the submit payload would carry the stale hours.
    seedDraft(ZA, {duration_hours: 9});
    useServicePricingStore.setState({zone: JOBURG_BOARD_KEY, pricedRegion: 'ZA'});

    const ui = render(<CustomizeAddOnsScreen />);

    expect(ui.queryByText('SERVICE DURATION')).toBeNull();
    // No board has hydrated, so the mirror fails open to the compiled 4 —
    // which is the shipped server default, so preview and charge still agree.
    expect(useBookingStore.getState().draft.duration_hours).toBe(4);
  });

  it('an HOURLY service keeps its stepper and its own hours', () => {
    seedDraft(ZA, {type: 'timeslot', service: 'recon_team', duration_hours: 6});
    useServicePricingStore.setState({zone: JOBURG_BOARD_KEY, pricedRegion: 'ZA'});

    const ui = render(<CustomizeAddOnsScreen />);

    expect(ui.getByText('SERVICE DURATION')).toBeTruthy();
    expect(useBookingStore.getState().draft.duration_hours).toBe(6);
  });
});

/**
 * B-874 — FLIPPED from B-861 P1-3's "the draft has to move with the pill".
 *
 * The pill is gone and the floor is MIN_LEAD_HOURS for every account, so the
 * 30 s tick no longer moves a LANE — it re-floors the START. A screen left open
 * until the picked time has drifted under the floor must file the earliest
 * bookable instant instead, and must keep filing `'later'`: with a 3 h floor
 * enforced at pick, at every tick and at submit, an under-floor `'now'` can no
 * longer be produced here. The tick and its dep list are what make that true —
 * without `nowTick` in the effect's deps the draft would keep a start the
 * server would refuse, and the debounced estimate would keep pricing it.
 */
describe('B-874 — the tick re-floors the start, and the lane stays scheduled', () => {
  const T0 = Date.parse('2026-09-12T06:00:00.000Z');
  const HOUR = 3_600_000;

  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(T0); });
  afterEach(() => { jest.useRealTimers(); });

  it('a start that drifts under the floor is moved UP, still filed as later', async () => {
    seedDraft(AE);
    const ui = render(<CustomizeAddOnsScreen />);

    // MISSION START at 13:10 in the booking zone (UTC+4) = 09:10 UTC = T0 + 3h10m,
    // which clears the 3 h floor, so it is filed exactly as picked.
    await act(async () => { mockTimeField.onChange?.(13, 10); });
    expect(useBookingStore.getState().draft.mode).toBe('later');
    const picked = useBookingStore.getState().draft.start_time;
    expect(picked).toBe(new Date(T0 + 3 * HOUR + 10 * 60_000).toISOString());

    // Twelve minutes pass with the screen open: that instant is now 2 h 58 m
    // away — under the floor.
    await act(async () => {
      jest.setSystemTime(T0 + 12 * 60_000);
      jest.advanceTimersByTime(60_000);
    });

    const after = useBookingStore.getState().draft.start_time;
    expect(after).not.toBe(picked);
    // Moved UP to the earliest bookable instant (now + 3 h, rounded up to 5 min)
    // — never rolled to tomorrow, and never left under the server's gate.
    expect(Date.parse(after as string) - (T0 + 12 * 60_000)).toBeGreaterThanOrEqual(3 * HOUR);
    expect(Date.parse(after as string) - (T0 + 12 * 60_000)).toBeLessThan(3 * HOUR + 5 * 60_000);
    expect(useBookingStore.getState().draft.mode).toBe('later');

    // …and there is no lane pill left to read: one floor means one word.
    expect(ui.queryByText('On demand')).toBeNull();
    expect(ui.queryByText('Scheduled')).toBeNull();
  });
});
