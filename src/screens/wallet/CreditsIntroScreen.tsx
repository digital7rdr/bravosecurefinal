/**
 * One-time "How Bravo Credits work" step after sign-up (2026-10-14). A root
 * gate like PermissionsScreen / IdentityDocumentScreen: rendered by
 * navigation/index.tsx until the client taps through, then never again on
 * this install (Wallet keeps the same page under "How credits work").
 * 2026-10-25 — a back arrow (and the Android back key) skips the intro: there
 * is nothing behind this gate to return to.
 */
import React from 'react';
import {View, StyleSheet, StatusBar, TouchableOpacity} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {CreditsExplainer} from './CreditsExplainer';
import {useGateHardwareBack} from '@navigation/gateExit';

export const CREDITS_INTRO_KEY = 'bravo_credits_intro_shown_v1';

export default function CreditsIntroScreen({onDone}: {onDone: () => void}): React.JSX.Element {
  const insets = useSafeAreaInsets();
  useGateHardwareBack(() => { onDone(); return true; });
  return (
    <View style={[styles.root, {paddingTop: insets.top, paddingBottom: insets.bottom}]}>
      <StatusBar barStyle="light-content" backgroundColor="#0A1F3F" />
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.backBtn} onPress={onDone} activeOpacity={0.7}
          accessibilityRole="button" accessibilityLabel="Skip — continue to the app"
          hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
          <Icon name="chevron-left" size={22} color="#FFFFFF" />
        </TouchableOpacity>
      </View>
      <CreditsExplainer onDone={onDone} doneLabel="Continue" />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#0A1F3F'},
  topBar: {paddingHorizontal: 20, paddingTop: 8},
  backBtn: {width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)'},
});
