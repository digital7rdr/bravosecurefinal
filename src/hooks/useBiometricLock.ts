/**
 * Biometric Lock preference — the same behaviour as Profile → Sign-in &
 * Privacy on the client app (ProfileScreen): opt-in, persisted, and turning
 * it ON runs a real face / fingerprint scan (device PIN as the OS fallback).
 * Shared since 2026-10-31 so the agent app's Sign-in & Privacy screen offers
 * the identical switch (same storage keys, read by the app lock gate).
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';
import {Alert} from '@utils/alert';

export const BIOMETRIC_LOCK_KEY = 'settings:biometricLock';
/** FIX-12 — the fail-closed mirror the lock gate falls back to. */
export const BIOMETRIC_LOCK_MIRROR_KEY = 'settings:biometricLock:lastKnown';

export function useBiometricLock(): {on: boolean; toggle: (next: boolean) => Promise<void>} {
  const [on, setOn] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    void AsyncStorage.getItem(BIOMETRIC_LOCK_KEY).then(v => { if (v === '1') {setOn(true);} }).catch(() => {});
  }, []);

  const apply = useCallback(async (next: boolean) => {
    if (!next) {
      setOn(false);
      await AsyncStorage.setItem(BIOMETRIC_LOCK_KEY, '0');
      await AsyncStorage.setItem(BIOMETRIC_LOCK_MIRROR_KEY, '0').catch(() => {});
      return;
    }
    const [hasHw, enrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    if (!hasHw) {
      Alert.alert('Not supported', 'This device has no biometric hardware.');
      return;
    }
    if (!enrolled) {
      Alert.alert('No biometrics enrolled', 'Add a fingerprint or face unlock in your device settings first, then enable Biometric Lock.');
      return;
    }
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Confirm to enable Biometric Lock',
      disableDeviceFallback: false,
      cancelLabel: 'Cancel',
    });
    if (res.success) {
      setOn(true);
      await AsyncStorage.setItem(BIOMETRIC_LOCK_KEY, '1');
      await AsyncStorage.setItem(BIOMETRIC_LOCK_MIRROR_KEY, '1').catch(() => {});
    } else {
      setOn(false);
    }
  }, []);

  // A mash must not queue several keystore round-trips (NAV-17).
  const toggle = useCallback(async (next: boolean) => {
    if (busy.current) {return;}
    busy.current = true;
    try { await apply(next); } finally { busy.current = false; }
  }, [apply]);

  return {on, toggle};
}
