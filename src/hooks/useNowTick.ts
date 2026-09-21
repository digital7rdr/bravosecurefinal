import {useEffect, useState} from 'react';
import {AppState} from 'react-native';

/**
 * B-861 P1-3 — how often a screen that DERIVES meaning from the clock is told
 * that the clock moved.
 *
 * 30 s, deliberately coarse. This exists to keep a derived LABEL honest (the
 * Secure Transfer review's "On demand / Scheduled" pill and the lane it files),
 * not to animate a clock — and a fast timer on a money screen is precisely the
 * per-render cost B-632..B-634 spent a session removing.
 */
export const NOW_TICK_MS = 30_000;

/**
 * The current instant, refreshed every `NOW_TICK_MS` AND whenever the app
 * returns to the foreground.
 *
 * The foreground refresh is not optional: Android suspends timers for a
 * backgrounded process (the same confound that made the first jsThreadWatchdog
 * report a phantom 4.7 s stall), so a resumed screen would otherwise render a
 * value minutes out of date until the next interval fired.
 *
 * Returns a number, not a Date, so a consumer's memo/dep array compares by
 * value — a fresh Date every 30 s would invalidate every downstream memo that
 * depended on it.
 */
export function useNowTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {setNow(Date.now());}
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, []);
  return now;
}
