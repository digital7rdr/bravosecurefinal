/**
 * One-time "How Bravo Credits work" step after sign-up (2026-10-14). A root
 * gate like PermissionsScreen / IdentityDocumentScreen: rendered by
 * navigation/index.tsx until the client taps through, then never again on
 * this install (Wallet keeps the same page under "How credits work").
 */
import React from 'react';
import {View, StyleSheet, StatusBar} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {CreditsExplainer} from './CreditsExplainer';

export const CREDITS_INTRO_KEY = 'bravo_credits_intro_shown_v1';

export default function CreditsIntroScreen({onDone}: {onDone: () => void}): React.JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, {paddingTop: insets.top, paddingBottom: insets.bottom}]}>
      <StatusBar barStyle="light-content" backgroundColor="#0A1F3F" />
      <CreditsExplainer onDone={onDone} doneLabel="Continue" />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#0A1F3F'},
});
