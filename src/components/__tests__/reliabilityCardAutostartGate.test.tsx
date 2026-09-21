/**
 * B-777 — the Xiaomi "Auto-start" prompt is its own gap, not a rider on the
 * battery-optimisation one.
 *
 * On the Redmi in the 2026-09-02 device audit
 * (`docs/qa/BACKGROUND_DELIVERY_AUDIT_2026-09-02.md`) battery optimisation was
 * already exempt and MIUI Autostart (AppOps 10008) was DENIED — and the card
 * only ever offered "Auto-start" inside `needBatt && showAutostart`, so the one
 * prompt that could fix the swiped-away-app blackout was unreachable there.
 *
 * Was a DOCUMENTS pin (battery exempt + Xiaomi → card renders NOTHING); the fix
 * flipped it. Pins now:
 *  1. battery exempt + OEM autostart screen + not yet acknowledged → the card
 *     renders with an "Auto-start" action (and NO "Allow", which is the
 *     battery action);
 *  2. tapping "Auto-start" opens the OEM screen AND persists the acknowledgement
 *     for this owner, so the card retires;
 *  3. already acknowledged → nothing (no nag loop);
 *  4. a non-OEM brand never sees it;
 *  5. control: battery NOT exempt + OEM → both actions, battery copy leads.
 */
import React from 'react';
import {Platform, TouchableOpacity} from 'react-native';
import {render, act, fireEvent} from '@testing-library/react-native';

jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'Icon');
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    const ReactActual = jest.requireActual('react') as typeof React;
    ReactActual.useEffect(cb, [cb]);
  },
}));
jest.mock('@store/authStore', () => ({
  useAuthStore: (sel: (s: {user: {id: string}}) => unknown) => sel({user: {id: 'owner-1'}}),
}));
jest.mock('@/modules/messenger/push/batteryOptimization', () => ({
  isIgnoringBatteryOptimizations: jest.fn(async () => true),
  requestIgnoreBatteryOptimizations: jest.fn(async () => undefined),
  openAutostartSettings: jest.fn(async () => true),
  hasOemAutostartScreen: jest.fn(() => true),
  snoozeReliabilityPrompt: jest.fn(async () => undefined),
  isReliabilityPromptSnoozed: jest.fn(async () => false),
  markAutostartPromptDone: jest.fn(async () => undefined),
  isAutostartPromptDone: jest.fn(async () => false),
  canUseFullScreenIntent: jest.fn(async () => true),
  openFullScreenIntentSettings: jest.fn(async () => true),
  isDndEnabled: jest.fn(async () => false),
  openDndSettings: jest.fn(async () => true),
}));

import * as batt from '@/modules/messenger/push/batteryOptimization';
import NotificationReliabilityCard from '../NotificationReliabilityCard';

const mockBatt = batt as jest.Mocked<typeof batt>;

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('B-777 — Auto-start prompt independent of the battery-exemption state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The card's checks are Android-only; the RN Jest preset defaults to iOS.
    (Platform as {OS: string}).OS = 'android';
    // The Redmi's state: battery optimisation exempt, Xiaomi OEM screen, never asked.
    mockBatt.isIgnoringBatteryOptimizations.mockResolvedValue(true);
    mockBatt.hasOemAutostartScreen.mockReturnValue(true);
    mockBatt.isAutostartPromptDone.mockResolvedValue(false);
    mockBatt.isReliabilityPromptSnoozed.mockResolvedValue(false);
    mockBatt.canUseFullScreenIntent.mockResolvedValue(true);
    mockBatt.isDndEnabled.mockResolvedValue(false);
  });

  it('battery exempt + Xiaomi + not acknowledged: offers Auto-start (and not the battery Allow)', async () => {
    const {queryByText} = render(<NotificationReliabilityCard />);
    await flush();
    expect(queryByText('Auto-start')).not.toBeNull();
    expect(queryByText('Allow')).toBeNull();
    expect(queryByText(/swipe it away/)).not.toBeNull();
  });

  it('tapping Auto-start opens the OEM screen, persists the acknowledgement, and retires the card', async () => {
    const {getByText, toJSON} = render(<NotificationReliabilityCard />);
    await flush();
    fireEvent.press(getByText('Auto-start'));
    await flush();
    expect(mockBatt.openAutostartSettings).toHaveBeenCalledTimes(1);
    expect(mockBatt.markAutostartPromptDone).toHaveBeenCalledWith('owner-1');
    expect(toJSON()).toBeNull();
  });

  it('OEM screen could NOT be opened (app-details fallback): no permanent acknowledgement, a one-day snooze instead', async () => {
    mockBatt.openAutostartSettings.mockResolvedValue(false);
    const {getByText} = render(<NotificationReliabilityCard />);
    await flush();
    fireEvent.press(getByText('Auto-start'));
    await flush();
    expect(mockBatt.markAutostartPromptDone).not.toHaveBeenCalled();
    expect(mockBatt.snoozeReliabilityPrompt).toHaveBeenCalledWith('owner-1', 24 * 60 * 60 * 1000);
  });

  it('already acknowledged: renders nothing (no nag loop)', async () => {
    mockBatt.isAutostartPromptDone.mockResolvedValue(true);
    const {toJSON} = render(<NotificationReliabilityCard />);
    await flush();
    expect(toJSON()).toBeNull();
  });

  it('non-OEM brand: renders nothing and never reads the acknowledgement', async () => {
    mockBatt.hasOemAutostartScreen.mockReturnValue(false);
    const {toJSON} = render(<NotificationReliabilityCard />);
    await flush();
    expect(toJSON()).toBeNull();
    expect(mockBatt.isAutostartPromptDone).not.toHaveBeenCalled();
  });

  it('control — battery NOT exempt + Xiaomi: both actions, battery copy leads', async () => {
    mockBatt.isIgnoringBatteryOptimizations.mockResolvedValue(false);
    const {queryByText} = render(<NotificationReliabilityCard />);
    await flush();
    expect(queryByText('Allow')).not.toBeNull();
    expect(queryByText('Auto-start')).not.toBeNull();
    expect(queryByText(/when the app is closed/)).not.toBeNull();
  });

  it('dismiss snoozes the whole card including the Auto-start row', async () => {
    const {toJSON, UNSAFE_getAllByType} = render(<NotificationReliabilityCard />);
    await flush();
    const buttons = UNSAFE_getAllByType(TouchableOpacity);
    fireEvent.press(buttons[buttons.length - 1]); // the trailing close icon
    await flush();
    expect(mockBatt.snoozeReliabilityPrompt).toHaveBeenCalledWith('owner-1');
    expect(toJSON()).toBeNull();
  });
});
