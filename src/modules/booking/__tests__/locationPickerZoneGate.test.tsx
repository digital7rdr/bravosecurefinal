/**
 * B-861 follow-up — CONFIRM must not be live while a searched pin has no
 * country yet.
 *
 * `pickResult` sets the pin from the Mapbox retrieve response with
 * `country: null`; the real country only arrives on the recentre's own
 * `moveend`, which reverse-geocodes the point. In that window the zone
 * derivation falls back to the BOUNDING BOXES — and the AE box
 * (22.5..26.5 N, 51.0..56.6 E) swallows a large piece of the Saudi Empty
 * Quarter. So a searched Saudi address could be confirmed as a UAE pick-up by
 * tapping Confirm before the map answered.
 *
 * A RENDER test, not a source scan: the defect is a race between two state
 * writes, and only driving the real search → retrieve → moveend sequence can
 * tell the two orders apart.
 *
 * It lives under `src/modules/booking/__tests__` because the `app` Jest project
 * IGNORES `src/screens/booking/__tests__/` (that path is the node `booking`
 * project, which matches `.ts` only and cannot mount RN), so a `.tsx` render
 * test placed beside the screen would never run at all.
 */
import React from 'react';
import {act, render, fireEvent, waitFor} from '@testing-library/react-native';

const mockWeb: {props: Record<string, (arg: unknown) => void> | null} = {props: null};
const mockInject = jest.fn();
jest.mock('react-native-webview', () => {
  const R = require('react');
  const {View} = require('react-native');
  return {
    __esModule: true,
    WebView: R.forwardRef((props: Record<string, (arg: unknown) => void>, ref: unknown) => {
      mockWeb.props = props;
      R.useImperativeHandle(ref, () => ({injectJavaScript: mockInject}));
      return R.createElement(View, {testID: 'map-webview'});
    }),
  };
});
jest.mock('react-native-geolocation-service', () => ({
  __esModule: true,
  default: {getCurrentPosition: jest.fn()},
  getCurrentPosition: jest.fn(),
}));
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
  useNavigation: () => ({navigate: mockNavigate, goBack: jest.fn()}),
  useRoute: () => ({params: {kind: 'pickup', countryCode: 'AE,ZA', anyZone: true}}),
}));
jest.mock('@/modules/maps/mapToken', () => ({
  MAPBOX_TOKEN: 'pk.test', MAPBOX_TOKEN_MISSING: false,
}));
jest.mock('@/modules/maps/mapWebViewSource', () => ({
  mapHtmlSource: () => ({html: '<html></html>'}),
}));
jest.mock('@navigation/tapGuard', () => ({
  goBackOnce: jest.fn(), navigateOnce: jest.fn(),
}));

import LocationPickerScreen from '@screens/booking/LocationPickerScreen';

/** Deep Empty Quarter: inside the AE bounding box, actually Saudi soil. */
const EMPTY_QUARTER = {lat: 22.6, lng: 54.0};
const DUBAI = {lat: 25.2048, lng: 55.2708};

const post = (msg: unknown) =>
  mockWeb.props?.onMessage?.({nativeEvent: {data: JSON.stringify(msg)}} as never);

const cta = (ui: ReturnType<typeof render>) => ui.getByText(
  /CONFIRM LOCATION|OUTSIDE ZONE|MAP LOADING…|CHECKING THE ZONE…/);

/** Mapbox suggest + retrieve, in the order the screen calls them. */
function mockSearch(coords: {lat: number; lng: number}) {
  const fetchMock = jest.fn()
    .mockResolvedValueOnce({json: async () => ({suggestions: [
      {mapbox_id: 'mb-1', name: 'Shaybah', place_formatted: 'Eastern Province'},
    ]})})
    .mockResolvedValueOnce({json: async () => ({features: [
      {geometry: {coordinates: [coords.lng, coords.lat]}},
    ]})});
  (global as {fetch?: unknown}).fetch = fetchMock;
  return fetchMock;
}

async function openAndPickSearchResult(ui: ReturnType<typeof render>) {
  fireEvent.press(ui.getByTestId('location-search-bar'));
  fireEvent.changeText(ui.getByPlaceholderText('Search pick-up address…'), 'Shaybah');
  await act(async () => { jest.advanceTimersByTime(250); });
  fireEvent.press(await ui.findByText('Shaybah'));
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWeb.props = null;
  jest.useFakeTimers();
});
afterEach(() => { jest.useRealTimers(); });

async function mountReadyOnDubai() {
  const ui = render(<LocationPickerScreen />);
  await act(async () => { post({type: 'ready'}); });
  await act(async () => {
    post({type: 'moveend', lat: DUBAI.lat, lng: DUBAI.lng, address: 'Trade Centre', country: 'AE'});
  });
  return ui;
}

describe('the picker is really mounted and the baseline works', () => {
  it('a geocoded Dubai pin confirms', async () => {
    const ui = await mountReadyOnDubai();
    expect(cta(ui).props.children).toBe('CONFIRM LOCATION');
  });
});

describe('B-861 — a searched pin awaiting its geocode cannot be confirmed', () => {
  it('Confirm goes down and says so until the country lands', async () => {
    const ui = await mountReadyOnDubai();
    mockSearch(EMPTY_QUARTER);
    await openAndPickSearchResult(ui);

    // The pin is now the Empty Quarter with NO country — the bbox arm alone
    // says "AE", which is exactly the wrong answer.
    await waitFor(() => expect(cta(ui).props.children).toBe('CHECKING THE ZONE…'));
    // Tapping it anyway is inert — the disabled prop needs a committed render,
    // so confirm() refuses SYNCHRONOUSLY as well (the N4 idiom).
    fireEvent.press(ui.getByText('CHECKING THE ZONE…'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('…and the SA country that then lands refuses it, rather than filing it as AE', async () => {
    const ui = await mountReadyOnDubai();
    mockSearch(EMPTY_QUARTER);
    await openAndPickSearchResult(ui);

    await act(async () => {
      post({type: 'moveend', lat: EMPTY_QUARTER.lat, lng: EMPTY_QUARTER.lng,
        address: 'Shaybah, Eastern Province', country: 'SA'});
    });
    await waitFor(() => expect(cta(ui).props.children).toBe('OUTSIDE ZONE'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('a searched pin that really is in the zone re-enables as soon as AE lands', async () => {
    const ui = await mountReadyOnDubai();
    mockSearch({lat: 25.11, lng: 55.14});
    await openAndPickSearchResult(ui);
    await waitFor(() => expect(cta(ui).props.children).toBe('CHECKING THE ZONE…'));

    await act(async () => {
      post({type: 'moveend', lat: 25.11, lng: 55.14, address: 'Marina', country: 'AE'});
    });
    await waitFor(() => expect(cta(ui).props.children).toBe('CONFIRM LOCATION'));
    fireEvent.press(ui.getByText('CONFIRM LOCATION'));
    expect(mockNavigate).toHaveBeenCalled();
  });

  it('a map that never answers releases the gate after 4 s — never a wedged CTA', async () => {
    const ui = await mountReadyOnDubai();
    mockSearch(EMPTY_QUARTER);
    await openAndPickSearchResult(ui);
    await waitFor(() => expect(cta(ui).props.children).toBe('CHECKING THE ZONE…'));

    await act(async () => { jest.advanceTimersByTime(4_000); });
    // Back to the documented bbox fallback — which for this point is the old,
    // wrong "AE". The timeout is a LIVENESS guarantee, not a correctness one.
    await waitFor(() => expect(cta(ui).props.children).toBe('CONFIRM LOCATION'));
  });
});
