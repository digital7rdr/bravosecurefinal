/**
 * B-861 P1-3 — a screen whose meaning depends on "now" must be told that now
 * moved.
 *
 * The Secure Transfer review derives `booking_mode` from the chosen start
 * against the current clock. A user who picks +3 h 00 sees "Scheduled" and then
 * idles: nothing re-renders, so the pill keeps saying "Scheduled" while the
 * booking has drifted under the server's gate — and submit files `'now'`,
 * which is immediate dispatch and the accept-anchored cancel window instead of
 * the `lateCancelHours` one. That is a MONEY difference the user was never
 * shown.
 *
 * The tick is deliberately coarse (30 s): it exists to keep a derived LABEL
 * honest, not to animate a clock, and a 1-second timer on a money screen is
 * exactly the per-render cost B-632..B-634 spent a session removing.
 */
import {act, renderHook} from '@testing-library/react-native';
import {AppState} from 'react-native';

import {useNowTick, NOW_TICK_MS} from '../useNowTick';

describe('useNowTick', () => {
  const REAL = Date.now;
  let clock = 1_700_000_000_000;

  beforeEach(() => {
    jest.useFakeTimers();
    clock = 1_700_000_000_000;
    Date.now = () => clock;
  });
  afterEach(() => {
    jest.useRealTimers();
    Date.now = REAL;
    jest.restoreAllMocks();
  });

  it('ticks every 30 s, so a 60 s idle advances it twice', () => {
    const {result} = renderHook(() => useNowTick());
    const first = result.current;
    expect(first).toBe(clock);

    act(() => { clock += NOW_TICK_MS; jest.advanceTimersByTime(NOW_TICK_MS); });
    expect(result.current).toBe(first + NOW_TICK_MS);

    act(() => { clock += NOW_TICK_MS; jest.advanceTimersByTime(NOW_TICK_MS); });
    expect(result.current).toBe(first + 2 * NOW_TICK_MS);
    // 60 s of idling really did move the value the caller derives from.
    expect(result.current - first).toBe(60_000);
  });

  it('does not tick before the period elapses', () => {
    const {result} = renderHook(() => useNowTick());
    const first = result.current;
    act(() => { clock += NOW_TICK_MS - 1; jest.advanceTimersByTime(NOW_TICK_MS - 1); });
    expect(result.current).toBe(first);
  });

  it('refreshes IMMEDIATELY when the app returns to the foreground', () => {
    // Android suspends timers for a backgrounded process, so the interval alone
    // would leave a resumed screen showing a label minutes out of date (the
    // same confound the jsThreadWatchdog had to learn about).
    const handlers: Array<(s: string) => void> = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_e: string, h: (s: string) => void) => {
      handlers.push(h);
      return {remove: jest.fn()};
    }) as never);

    const {result} = renderHook(() => useNowTick());
    const first = result.current;
    act(() => { clock += 10 * 60_000; });          // ten minutes backgrounded, no timers
    expect(result.current).toBe(first);

    act(() => { handlers.forEach(h => h('active')); });
    expect(result.current).toBe(first + 10 * 60_000);
  });

  it('ignores a background/inactive transition', () => {
    const handlers: Array<(s: string) => void> = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_e: string, h: (s: string) => void) => {
      handlers.push(h);
      return {remove: jest.fn()};
    }) as never);

    const {result} = renderHook(() => useNowTick());
    const first = result.current;
    act(() => { clock += 5_000; handlers.forEach(h => h('background')); });
    expect(result.current).toBe(first);
  });

  it('clears the interval AND the AppState subscription on unmount', () => {
    const remove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((() => ({remove})) as never);
    const clearSpy = jest.spyOn(global, 'clearInterval');

    const {unmount} = renderHook(() => useNowTick());
    unmount();

    expect(remove).toHaveBeenCalled();
    expect(clearSpy).toHaveBeenCalled();
    // A leaked 30 s timer on a money screen is the N-rule this guards.
    expect(jest.getTimerCount()).toBe(0);
  });
});
