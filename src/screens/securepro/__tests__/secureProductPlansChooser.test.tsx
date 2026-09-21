/**
 * PDF-2 A4 (D3) — the Secure plan chooser drops the LITE card.
 *
 * The chooser (`SecureServicesScreen`) is the RETAINER-plan picker and now
 * shows exactly two cards: Bravo Secure Pro and Bravo Secure Lux. On-demand
 * Lite booking is NOT a plan card here — it is reached from the Book-Now home
 * (ZoneMap, Wave 1/2). Removing the CARD must not remove that ENTRY, and must
 * not touch the Pro/Lux card behaviour.
 *
 * RED-first: against the 3-card list this file fails on `queryByText('Bravo
 * Secure Lite')` (a Lite card still renders).
 */
import React from 'react';
import {render, fireEvent} from '@testing-library/react-native';
import {useSecureProStore} from '@store/secureProStore';
import SecureServicesScreen from '@screens/securepro/SecureServicesScreen';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: (...a: unknown[]) => mockNavigate(...a)}),
  // Run the focus callback once, like a real focus, so loadApplication fires.
  useFocusEffect: (cb: () => void) => {
    const react = require('react');
    react.useEffect(() => cb(), []);
  },
  // Two routes beneath → backsToSecureHome renders the hint (exercised, harmless).
  useNavigationState: (sel: (s: unknown) => unknown) =>
    sel({routes: [{name: 'BookingHome'}, {name: 'SecureServices'}]}),
}));

jest.mock('@hooks/useBottomInset', () => ({
  useBottomInset: () => ({contentBottom: () => 24, bottomPad: () => 12}),
}));

function seed(app: {id: string; status: string} | null) {
  useSecureProStore.setState({
    application: app as never,
    hasLoaded: true,
    loadApplication: (jest.fn(async () => {})) as never,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  seed(null);
});

describe('SecureServicesScreen — plans = Pro + Lux, no Lite card', () => {
  it('renders exactly the Pro and Lux cards and NO Lite card', () => {
    const {getByText, queryByText} = render(<SecureServicesScreen />);
    expect(getByText('Bravo Secure Pro')).toBeTruthy();
    expect(getByText('Bravo Secure Lux')).toBeTruthy();
    // The dropped card — its presence is the 3-card regression this pins.
    expect(queryByText('Bravo Secure')).toBeNull(); // the free plan's title (was "Bravo Secure Lite")
  });

  it('the Pro card still routes (no active application → SecureProIntro)', () => {
    const {getByLabelText} = render(<SecureServicesScreen />);
    fireEvent.press(getByLabelText('Bravo Secure Pro'));
    expect(mockNavigate).toHaveBeenCalledWith('SecureProIntro');
  });

  it('an ACTIVE Pro client lands on the Pro dashboard INSIDE the shell', () => {
    /**
     * B-857 (founder 2026-09-11) — RE-POINTED, not relaxed.
     *
     * `ProDashboard` is a bare BookingNavigator route that renders the same
     * screen with NO `SecureShell` beneath it — and `secureFlowTabFor` refuses
     * to draw the Pro bar on a stack the shell is not in (a flow-bar press
     * there would PUSH a second shell). So a client who arrived this way got
     * the root two-item footer on every Pro screen, which is the founder's
     * "the footer is changed" report. `secureRootRoute()` is the single named
     * place the tier question is asked, and the shell's Home tab renders the
     * Pro dashboard for an ACTIVE client — same destination, with its bar.
     */
    seed({id: 'a1', status: 'ACTIVE'});
    const {getByLabelText} = render(<SecureServicesScreen />);
    fireEvent.press(getByLabelText('Bravo Secure Pro'));
    expect(mockNavigate).toHaveBeenCalledWith('SecureShell');
    expect(mockNavigate).not.toHaveBeenCalledWith('ProDashboard');
  });

  it('the Lux teaser card still opens the SecureLux showcase', () => {
    const {getByLabelText} = render(<SecureServicesScreen />);
    fireEvent.press(getByLabelText('Bravo Secure Lux — coming soon, view details'));
    expect(mockNavigate).toHaveBeenCalledWith('SecureLux');
  });

  it('never routes to ZoneMap from this screen — Book-Now home owns that entry', () => {
    const {getByLabelText} = render(<SecureServicesScreen />);
    fireEvent.press(getByLabelText('Bravo Secure Pro'));
    expect(mockNavigate).not.toHaveBeenCalledWith('ZoneMap');
  });
});
