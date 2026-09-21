/**
 * B-872/N1 (navigation audit 2026-09-12) — navigate YOUR OWN slot.
 *
 * `navigation.replace()` / `popToTop()` are stamped with `source` only, never
 * `target` (`@react-navigation/core` `useNavigationCache`), and StackRouter
 * only honours `source` when `action.target === state.key`. An untargeted
 * REPLACE therefore resolves against `state.index` — the FOCUSED route, not
 * the caller. Every screen in this app that keeps a status poll running while
 * it pushes another screen above itself (SOS, Invoice, CreditPaywall) was
 * swapping the screen the user was actually looking at, SOS included.
 *
 * `replaceOwnSlot` dispatches the same REPLACE with the target filled in, so
 * the tick replaces ITS OWN route underneath whatever the user pushed.
 *
 * `popToTop` cannot be fixed the same way — StackRouter re-dispatches
 * POP_TO_TOP as a plain POP and drops `source`/`target` on the way — so an
 * unwind that is meant to take the user somewhere waits for focus instead.
 * It must also RE-ARM, or the screen parks forever (NAV_RAPID_USE_LOOP §8).
 */
import {useCallback, useRef} from 'react';
import {StackActions, useFocusEffect} from '@react-navigation/native';

interface OwnSlotAction {
  type: string;
  payload?: object;
  source?: string;
  target?: string;
}

/**
 * The structural shape both helpers need. `replace` is only here so
 * `Parameters<N['replace']>` below can borrow the caller's own route-name and
 * param typing — the helper never calls it.
 */
export interface OwnSlotNavigator {
  dispatch: (action: OwnSlotAction) => void;
  getState: () => {key: string} | undefined;
  replace: (...args: never[]) => void;
}

/** Replace the route identified by `routeKey`, never the focused one. */
export function replaceOwnSlot<N extends OwnSlotNavigator>(
  navigation: N,
  routeKey: string | undefined,
  ...args: Parameters<N['replace']>
): void {
  const [name, params] = args as unknown as [string, object | undefined];
  const action = StackActions.replace(name, params) as OwnSlotAction;
  let stateKey: string | undefined;
  try {
    stateKey = navigation.getState()?.key;
  } catch {
    stateKey = undefined;
  }
  // Both halves are required: StackRouter ignores `source` unless the target
  // names this very navigator. Missing either, fall back to today's behaviour
  // rather than dropping the navigation on the floor.
  if (routeKey && stateKey) {
    navigation.dispatch({...action, source: routeKey, target: stateKey});
    return;
  }
  navigation.dispatch(action);
}

/**
 * Run a navigation now if this screen is focused, otherwise once it is focused
 * again. One-shot, latest-wins — the poll that deferred it has already stopped.
 */
export function useFocusDeferredNav(navigation: {isFocused: () => boolean}) {
  const navRef = useRef(navigation);
  navRef.current = navigation;
  const pendingRef = useRef<(() => void) | null>(null);

  useFocusEffect(
    useCallback(() => {
      const pending = pendingRef.current;
      if (pending) {
        pendingRef.current = null;
        pending();
      }
      return undefined;
    }, []),
  );

  return useCallback((run: () => void) => {
    if (navRef.current.isFocused()) {
      run();
      return;
    }
    pendingRef.current = run;
  }, []);
}
