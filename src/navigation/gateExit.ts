/**
 * 2026-10-25 — a way back from every gate screen.
 *
 * Gate screens (account activation, permissions, product choice, provider
 * sign-up, approval waits…) are the first or only screen the app shows for a
 * signed-in account, so there is nothing behind them to go back to. Before,
 * they hid the back arrow and the Android back key closed the app, leaving
 * the user stuck. Their back now offers to sign out, which returns to the
 * sign-in screen; signing in again resumes where they left off.
 */
import {useCallback, useEffect, useRef} from 'react';
import {BackHandler} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {Alert} from '@utils/alert';
import {useAuthStore} from '@store/authStore';

export interface LeaveCopy {title?: string; message?: string}

export const DEFAULT_LEAVE_COPY: Required<LeaveCopy> = {
  title: 'Go back to sign in?',
  message: "You'll be signed out. Sign in again any time to continue from here.",
};

/** Ask, then sign out (back to the sign-in screen). */
export function confirmLeaveToSignIn(copy: LeaveCopy = {}): void {
  Alert.alert(copy.title ?? DEFAULT_LEAVE_COPY.title, copy.message ?? DEFAULT_LEAVE_COPY.message, [
    {text: 'Stay', style: 'cancel'},
    {text: 'Sign out', style: 'destructive', onPress: () => { void useAuthStore.getState().signOut(); }},
  ]);
}

/**
 * Android back key for a screen rendered OUTSIDE a navigator (no focus
 * events there). `handler` returns true when it handled the press. Reads the
 * latest handler through a ref, so callers can pass an inline function.
 */
export function useGateHardwareBack(handler: () => boolean, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) {return;}
    const sub = BackHandler.addEventListener('hardwareBackPress', () => ref.current());
    return () => sub.remove();
  }, [enabled]);
}

/**
 * Android back key for a screen INSIDE a navigator: active only while the
 * screen is focused, so a covered screen never intercepts the key.
 */
export function useScreenHardwareBack(handler: () => boolean): void {
  const ref = useRef(handler);
  ref.current = handler;
  useFocusEffect(useCallback(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => ref.current());
    return () => sub.remove();
  }, []));
}
